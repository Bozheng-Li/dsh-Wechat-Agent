"""Offline QR-auth components; the 3.9 business-packet codec is NOT implemented.

Field semantics come from tmp/refs/wechat7016/WeChat.Core/Protocol/Protos2.cs
and WXQrcode.cs, not a verified 3.9 login exchange. Callers must supply already
unwrapped protobuf responses. This module never opens a socket, attaches to a
client, loads the attached-token session, or substitutes a SessionKey for the
15-byte longlink cookie.
"""
import hashlib
import json
import os
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import aes
from .longlink import ProtocolError, fv, ld, parse_pb


class AuthError(RuntimeError):
    def __init__(self, message, *, ret=None):
        super().__init__(message)
        self.ret = ret


WIRE_GAPS = (
    "3.9 GetLoginQRCode/CheckLoginQRCode business-envelope encoding and decoding",
    "3.9 login ECDH certificate selection and request/response key derivation",
    "3.9 secmanualauth device fingerprint and exact RsaReqData/AesReqData layout",
    "3.9 auth-response cookie and initial SyncKey/NewInit handoff",
)


def _atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=True, indent=2)
        stream.write("\n")
    os.replace(tmp, path)


class AuthTrace:
    """Store status/return codes, never request bodies, keys or credentials."""

    def __init__(self, path):
        self.path = Path(path)
        self.events = []
        self.verified = False

    def _write(self):
        _atomic_json(self.path, {
            "auth_mode": "qrcode", "live_login_verified": self.verified,
            "events": self.events,
        })

    def rebind(self, path):
        """Give this run its own file so a concurrent run cannot clobber it."""
        self.path = Path(path)
        self._write()

    def add(self, stage, state, ret=None, response=None, detail=None):
        row = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "stage": stage, "state": state, "ret": ret}
        if response is not None:
            row.update(response_len=len(response),
                       response_sha256=hashlib.sha256(response).hexdigest())
        if detail is not None:
            row["detail"] = detail
        self.events.append(row)
        self._write()

    def finish(self, verified):
        self.verified = bool(verified)
        self._write()


def _fields(raw):
    try:
        fields = parse_pb(raw)
    except (ProtocolError, struct.error, IndexError, TypeError) as exc:
        raise AuthError("malformed protobuf response") from exc
    if any(number < 1 for number, _, _ in fields):
        raise AuthError("invalid protobuf field number")
    return fields


def _one(fields, number, wire, default=None):
    matches = [(kind, value) for key, kind, value in fields if key == number]
    if not matches:
        if default is not None:
            return default
        raise AuthError("required protobuf field %d is absent" % number)
    if len(matches) != 1 or matches[0][0] != wire:
        raise AuthError("unexpected/duplicate protobuf field %d" % number)
    return matches[0][1]


def _buffer(raw):
    fields = _fields(raw)
    size = _one(fields, 1, 0)
    data = _one(fields, 2, 2)
    if size != len(data):
        raise AuthError("SKBuiltinBuffer length mismatch")
    return data


def base_response(raw):
    fields = _fields(raw)
    base = _fields(_one(fields, 1, 2))
    ret = _one(base, 1, 0) & 0xFFFFFFFF
    if ret >= 0x80000000:
        ret -= 0x100000000
    message = _one(base, 2, 2, b"")
    if message:
        message = _one(_fields(message), 1, 2, b"")
    return ret, message.decode("utf-8", "replace")


def _cbc_decrypt(key, ciphertext):
    if len(key) != 16 or not ciphertext or len(ciphertext) % 16:
        raise AuthError("invalid AES-128-CBC key/ciphertext length")
    plaintext = aes.cbc_decrypt(key, key, ciphertext)
    # The existing CBC primitive tolerates bad padding; auth must reject it.
    if aes.cbc_encrypt(key, key, plaintext) != ciphertext:
        raise AuthError("invalid PKCS#7 padding")
    return plaintext


def check_request(base_request, random_key, uuid, timestamp=None):
    """Reference layout: f2 is a buffer wrapper; f4 is the client's uptime.

    The 3.9 client's f4 advances exactly +1 per second and read 2,082,837 at
    14:57 (this machine's uptime then, ~24 days), so it is GetTickCount()
    seconds since boot, not a unix timestamp (time.monotonic() on Windows is
    the same clock).
    """
    if len(random_key) != 16 or not uuid:
        raise AuthError("random key and QR uuid required")
    key = fv(1, len(random_key)) + ld(2, random_key)
    stamp = int(time.monotonic()) if timestamp is None else int(timestamp)
    return (ld(1, base_request) + ld(2, key) + ld(3, uuid.encode("utf-8"))
            + fv(4, stamp) + fv(5, 0))


@dataclass
class QRChallenge:
    uuid: str
    image: bytes = field(repr=False)
    notify_key: bytes = field(repr=False)
    poll_interval: float
    expires_at: float

    @classmethod
    def parse(cls, plaintext):
        ret, message = base_response(plaintext)
        if ret != 0:
            raise AuthError("GetLoginQRCode ret=%d: %s" % (ret, message), ret=ret)
        fields = _fields(plaintext)
        uuid = _one(fields, 3, 2).decode("utf-8")
        image = _buffer(_one(fields, 2, 2))
        notify_key = _buffer(_one(fields, 5, 2))
        lifetime = _one(fields, 6, 0)
        if not uuid or len(notify_key) != 16 or not image or lifetime <= 0:
            raise AuthError("incomplete QR challenge")
        return cls(uuid, image, notify_key,
                   max(2.0, float(_one(fields, 4, 0, 2))),
                   time.monotonic() + lifetime)

    def save_image(self, directory):
        if self.image.startswith(b"\x89PNG\r\n\x1a\n"):
            suffix = ".png"
        elif self.image.startswith(b"\xff\xd8\xff"):
            suffix = ".jpg"
        else:
            raise AuthError("QR response is not a supported PNG/JPEG image")
        path = Path(directory).resolve() / ("qrcode_login" + suffix)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.image)
        return path


QR_STATES = {0: "waiting", 1: "scanned", 2: "confirmed",
             3: "expired", 4: "cancelled"}


def decrypt_notification(plaintext, challenge):
    ret, message = base_response(plaintext)
    if ret != 0:
        if ret == -2007:
            raise AuthError(
                "QR code expired on server (ret=-2007); no automatic refresh", ret=ret)
        raise AuthError("CheckLoginQRCode ret=%d: %s" % (ret, message), ret=ret)
    pkg = _fields(_one(_fields(plaintext), 3, 2))
    encrypted = _buffer(_one(pkg, 1, 2))
    fields = _fields(_cbc_decrypt(challenge.notify_key, encrypted))
    uuid = _one(fields, 1, 2).decode("utf-8")
    if uuid != challenge.uuid:
        raise AuthError("QR notification belongs to another challenge")
    state = _one(fields, 2, 0)
    if state not in QR_STATES:
        raise AuthError("unknown QR state %d" % state)
    return {
        "state": QR_STATES[state], "uuid": uuid,
        "wxid": _one(fields, 3, 2, b"").decode("utf-8"),
        "temporary_password": _one(fields, 4, 2, b"").decode("utf-8"),
        "avatar_url": _one(fields, 5, 2, b"").decode("utf-8"),
        "nickname": _one(fields, 7, 2, b"").decode("utf-8"),
    }


def parse_network(plaintext):
    """NetworkSectResp: both BuiltinIPList nodes and DNS replacements."""
    network = _fields(_one(_fields(plaintext), 5, 2))
    addresses = {"long": [], "short": [], "dns": []}
    builtin = _one(network, 3, 2, b"")
    if builtin:
        for number, wire, raw in _fields(builtin):
            if number not in (3, 4):
                continue
            if wire != 2:
                raise AuthError("invalid BuiltinIPList wire type")
            fields = _fields(raw)
            port = _one(fields, 2, 0)
            ip = _one(fields, 3, 2, b"").decode("ascii").rstrip("\0")
            domain = _one(fields, 4, 2, b"").decode("ascii").rstrip("\0")
            if not (ip or domain) or not 0 < port <= 65535:
                raise AuthError("invalid IDC node")
            addresses["long" if number == 3 else "short"].append({
                "ip": ip, "domain": domain, "port": port,
            })
    hosts = _one(network, 1, 2, b"")
    if hosts:
        for number, wire, raw in _fields(hosts):
            if number != 2:
                continue
            if wire != 2:
                raise AuthError("invalid DNS list wire type")
            fields = _fields(raw)
            addresses["dns"].append({
                "origin": _one(fields, 1, 2).decode("ascii"),
                "substitute": _one(fields, 2, 2).decode("ascii"),
            })
    if not (addresses["long"] and addresses["short"]) and not addresses["dns"]:
        raise AuthError("IDC response lacks usable long/short nodes or DNS mappings")
    return addresses


def parse_idc_redirect(plaintext):
    ret, _ = base_response(plaintext)
    if ret != -301:
        raise AuthError("not an IDC redirect response")
    return parse_network(plaintext)


def poll_qrcode(check, challenge, trace, directory, emit=print):
    """check(uuid) returns the unwrapped protobuf, or (protobuf, pack_meta).

    This is an offline/reference-level component until a verified 3.9 packet
    codec supplies check. It does not automatically obtain another QR code.
    """
    path = challenge.save_image(directory)
    emit("QR image: %s; remaining %.0fs" % (
        path, max(0, challenge.expires_at - time.monotonic())))
    previous = "waiting"
    trace.add("CheckLoginQRCode", previous)
    emit("QR state: waiting")
    while True:
        remaining = challenge.expires_at - time.monotonic()
        if remaining <= 0:
            trace.add("CheckLoginQRCode", "expired")
            raise AuthError("QR code expired; no automatic refresh")
        time.sleep(min(challenge.poll_interval, remaining))
        if time.monotonic() >= challenge.expires_at:
            continue
        raw = None
        meta = {}
        try:
            result = check(challenge.uuid)
            if isinstance(result, tuple):
                raw, meta = result
            else:
                raw = result
            notice = decrypt_notification(raw, challenge)
        except Exception as exc:
            detail = {"error_type": type(exc).__name__}
            if getattr(exc, "ret", None) is not None:
                detail["ret"] = exc.ret
                detail["scene"] = getattr(exc, "scene", None)
                detail["raw_hex"] = getattr(exc, "raw", b"").hex()
            elif raw:
                try:
                    detail["ret"] = base_response(raw)[0]
                except Exception:
                    pass
            trace.add("CheckLoginQRCode", "halted", response=raw, detail=detail)
            raise
        state = notice["state"]
        if time.monotonic() >= challenge.expires_at:
            trace.add("CheckLoginQRCode", "expired", response=raw)
            raise AuthError("QR response arrived after local expiry")
        if previous == "scanned" and state == "waiting":
            trace.add("CheckLoginQRCode", "halted", response=raw,
                      detail="state regressed from scanned to waiting")
            raise AuthError("QR state regression")
        if state != previous:
            trace.add("CheckLoginQRCode", state, ret=0, response=raw)
            emit("QR state: %s; nickname=%s; avatar=%s" % (
                state, notice["nickname"], notice["avatar_url"]))
            previous = state
        if state in ("expired", "cancelled"):
            raise AuthError("QR code %s; no automatic refresh" % state)
        if state == "confirmed":
            if not notice["wxid"] or not notice["temporary_password"]:
                trace.add("CheckLoginQRCode", "halted",
                          detail="confirmed notification lacks credentials")
                raise AuthError("confirmed QR notification lacks credentials")
            # The confirmed Pack header is the only place the edge could bind a
            # pre-login uin/cookie to this session; keep it with the response.
            notice["pack_uin"] = int(meta.get("uin") or 0)
            notice["pack_cookie_hex"] = (meta.get("cookie") or b"").hex()
            evidence = Path(directory) / "evidence"
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / "checkloginqrcode_confirmed.bin").write_bytes(raw)
            _atomic_json(evidence / "checkloginqrcode_confirmed.json", {
                "cgi": meta.get("cgi"), "uin": notice["pack_uin"],
                "cookie": notice["pack_cookie_hex"],
                "encoder": meta.get("encoder"), "bytes": len(raw),
            })
            # Credential bytes remain local, separate from the shareable trace.
            _atomic_json(Path(directory) / "qrcode_credentials.local.json", notice)
            return notice


class ManualAuthGuard:
    """One attempt, with at most one server-directed IDC resend, no retries.

    send() must itself send exactly once with HTTP redirects/retries disabled.
    switch_idc(nodes) must apply BOTH short/long node lists or DNS mappings; a
    missing or unchanged target is an error, not a reason to resend blindly.
    This gate deliberately does not use ProtoTransport._run().
    """

    def __init__(self, trace, emit=print):
        self.trace = trace
        self.emit = emit
        self.used = False

    def _send(self, send, attempt):
        self.trace.add("ManualAuth", "sending", detail={"attempt": attempt})
        try:
            response = send()
            ret, message = base_response(response)
        except Exception as exc:
            detail = {"attempt": attempt, "error_type": type(exc).__name__}
            if getattr(exc, "ret", None) is not None:
                detail["ret"] = exc.ret
                detail["scene"] = getattr(exc, "scene", None)
                detail["raw_hex"] = getattr(exc, "raw", b"").hex()
            self.trace.add("ManualAuth", "halted", detail=detail)
            self.emit("ManualAuth halted: attempt=%d error=%s ret=%s scene=%s "
                      "raw=%s; no retry" % (
                          attempt, type(exc).__name__, detail.get("ret"),
                          detail.get("scene"), detail.get("raw_hex")))
            raise
        self.trace.add("ManualAuth", "response", ret=ret, response=response,
                       detail={"attempt": attempt})
        self.emit("ManualAuth attempt=%d ret=%d bytes=%d sha256=%s message=%s" % (
            attempt, ret, len(response), hashlib.sha256(response).hexdigest(), message))
        return ret, message, response

    def execute(self, send, switch_idc):
        if self.used:
            raise AuthError("ManualAuth gate already used; no automatic retry")
        self.used = True
        ret, message, response = self._send(send, 1)
        if ret == -301:
            try:
                nodes = parse_idc_redirect(response)
                changed = switch_idc(nodes)
                if changed is not True:
                    raise AuthError("IDC redirect did not change both node targets")
            except Exception as exc:
                self.trace.add("ManualAuth", "halted", ret=ret,
                               detail={"error_type": type(exc).__name__})
                raise
            self.trace.add("ManualAuth", "idc_redirect_applied", ret=ret)
            ret, message, response = self._send(send, 2)
        if ret != 0:
            self.trace.add("ManualAuth", "halted", ret=ret)
            raise AuthError("ManualAuth ret=%d: %s; no retry" % (ret, message), ret=ret)
        self.trace.add("ManualAuth", "accepted", ret=0)
        return response


def require_qrcode_wire(trace_path):
    """Fail before constructing an Agent or reading an attached session."""
    trace = AuthTrace(trace_path)
    trace.add("preflight", "blocked", detail={"missing_evidence": list(WIRE_GAPS)})
    for stage in ("GetLoginQRCode", "CheckLoginQRCode", "ManualAuth", "SessionHandoff"):
        trace.add(stage, "not_sent")
    raise AuthError("qrcode auth unavailable: %s; trace=%s" % (
        "; ".join(WIRE_GAPS), Path(trace_path).resolve()))
