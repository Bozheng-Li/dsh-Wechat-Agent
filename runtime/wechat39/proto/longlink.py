# -*- coding: utf-8 -*-
"""WeChat 3.9.12.51 PC longlink protocol (plain TCP + AES-128-CBC).

Wire format (verified against captured frames and accepted by the live server):

  frame  = u32 BE total_len | u32 BE 0x00100001 | u32 BE cmd | u32 BE seq | body
  body   = 3-byte prefix | BE version | BE uin | 15-byte token |
           varint cmd | varint raw_len | varint comp_len | varint 0 |
           varint 0x0F | varint checksum_a | byte 0 | varint checksum_b |
           byte 0 | byte 0 | varint 0 | u16 BE checksum_c | ciphertext

  checksum_a = adler32(pt, adler32(md5(be32(raw_len) || s08 ||
                                     md5(be32(uin) || s08)), 1))
  ciphertext = AES-128-CBC(key = iv = <body key>, pkcs7(zlib(pt)))  (prefix bit 1)

Attached-token sessions use the fixed S50/S08 pair observed from an already
logged-in client. A fresh QR login instead carries a per-session 16-byte body
key (key = IV) and its own checksum material. Those values are captured at the
native encryption boundary and passed explicitly; QR sessions never silently
fall back to the attached-token constants.

The server answers with cmd 0x3B9ACA00 + request cmd and the request seq.
Server header checksums are zero; client checksum_b may be zero (accepted by
the server for SendMsg) or the wcprobe hash of md5(ciphertext).

Session material (uin, token) comes from the logged-in client:
  wechat39/proto/session.json  {"uin": 3830976986, "token": "<30 hex>"}
"""
import hashlib
import json
import os
import random
import socket
import struct
import time
import zlib

from . import aes

# Attached-token sessions use the fixed material observed in a client that was
# already logged in. A fresh QR login carries per-session material instead.
DEFAULT_S08 = bytes.fromhex("f9e4a2cf206681961c1a35aa4b24cf53")
DEFAULT_KEY = b"qmjzZcR^=mN2a(ed"
VER = 0xF2542033
FRAME_MAGIC = 0x00100001

CMD_SEND_TEXT = 522
CMD_NEW_SYNC = 138
CMD_HEARTBEAT = 518
RESP_FLAG = 0x3B9ACA00

# The frame header carries a short "wire command"; the inner longlink header
# carries the business command.  Both were observed in captured frames:
#   inner 522 (SendMsg)  -> wire 0xED
#   inner 138 (NewSync)  -> wire 0x79
#   inner 518 (HeartBeat)-> wire 0xEE
WIRE_CMD = {522: 0xED, 138: 0x79, 518: 0xEE}
WIRE_CMD_REV = {v: k for k, v in WIRE_CMD.items()}

MSGSRC = (b"<msgsource>\n    <sec_msg_node>\n        <alnode>\n"
          b"            <fr>1</fr>\n        </alnode>\n"
          b"    </sec_msg_node>\n    <pua>1</pua>\n</msgsource>\n")

DEFAULT_HOST = "long.weixin.qq.com"
DEFAULT_PORT = 8080
_HERE = os.path.dirname(os.path.abspath(__file__))
SESSION_PATH = os.path.join(_HERE, "session.json")
SYNC_STATE_PATH = os.path.join(_HERE, "sync_state.json")


class ProtocolError(RuntimeError):
    pass


# ---------------------------------------------------------------- protobuf

def vi(v):
    out = bytearray()
    if v < 0:
        v &= 0xFFFFFFFFFFFFFFFF
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def rvi(b, i):
    v = 0
    shift = 0
    while True:
        if i >= len(b):
            raise ProtocolError("truncated varint")
        x = b[i]
        i += 1
        v |= (x & 0x7F) << shift
        if not x & 0x80:
            return v, i
        shift += 7
        if shift > 70:
            raise ProtocolError("varint too long")


def ld(field, data):
    return vi((field << 3) | 2) + vi(len(data)) + data


def fv(field, value):
    return vi(field << 3) + vi(value)


def parse_pb(b):
    """Return [(field, wire_type, value)]; wt=2 value is bytes, wt=0 int."""
    out = []
    i = 0
    while i < len(b):
        key, i = rvi(b, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = rvi(b, i)
            out.append((fn, wt, v))
        elif wt == 2:
            n, i = rvi(b, i)
            if i + n > len(b):
                raise ProtocolError("truncated field %d" % fn)
            out.append((fn, wt, b[i:i + n]))
            i += n
        elif wt == 5:
            out.append((fn, wt, struct.unpack("<I", b[i:i + 4])[0]))
            i += 4
        elif wt == 1:
            out.append((fn, wt, struct.unpack("<Q", b[i:i + 8])[0]))
            i += 8
        else:
            raise ProtocolError("unsupported wire type %d" % wt)
    return out


def pb_get(fields, fn, default=None):
    for f, wt, v in fields:
        if f == fn:
            return v
    return default


# ------------------------------------------------------------------ crypto

def checksum_a(raw_len, pt, uin, s08=DEFAULT_S08):
    if not isinstance(s08, (bytes, bytearray)) or not s08:
        raise ValueError("s08 must be non-empty bytes")
    s08 = bytes(s08)
    d1 = hashlib.md5(struct.pack(">I", uin) + s08).digest()
    d2 = hashlib.md5(struct.pack(">I", raw_len) + s08 + d1).digest()
    return zlib.adler32(pt, zlib.adler32(d2, 1)) & 0xFFFFFFFF


def encode_body(pt, uin, key=DEFAULT_KEY):
    if len(key) != 16:
        raise ValueError("body key must be 16 bytes")
    comp = zlib.compress(pt, 9)
    ct = aes.cbc_encrypt(key, key, comp)
    return comp, ct


def decode_body(ct, compressed, key=DEFAULT_KEY):
    if len(key) != 16:
        raise ValueError("body key must be 16 bytes")
    raw = aes.cbc_decrypt(key, key, ct)
    if compressed:
        raw = zlib.decompress(raw)
    return raw


# --------------------------------------------------------------- longlink

def build_header(cmd, raw_len, comp_len, a, uin, token, b=0, c=0, ver=VER):
    h = bytearray(b"\xbf\x00\x00")
    h += struct.pack(">I", ver)
    h += struct.pack(">I", uin)
    h += token
    h += vi(cmd) + vi(raw_len) + vi(comp_len) + vi(0) + vi(0x0F) + vi(a)
    h += b"\x00" + vi(b) + b"\x00\x00" + vi(0) + struct.pack(">H", c)
    hlen = len(h)
    h[1] = ((hlen << 2) & 0xFC) | 1
    h[2] = (5 << 4) | 15
    return bytes(h)


def build_frame(cmd, pt, uin, token, seq, b=0, c=0, ver=VER,
                key=DEFAULT_KEY, s08=DEFAULT_S08):
    comp, ct = encode_body(pt, uin, key)
    a = checksum_a(len(pt), pt, uin, s08)
    body = build_header(cmd, len(pt), len(comp), a, uin, token, b, c, ver) + ct
    wire = WIRE_CMD.get(cmd, cmd)
    frame = struct.pack(">IIII", 16 + len(body), FRAME_MAGIC, wire, seq) + body
    return frame, dict(a=a, raw=len(pt), comp=len(comp), ct=len(ct),
                       seq=seq, wire_cmd=wire, inner_cmd=cmd,
                       md5=hashlib.md5(ct).hexdigest())


def parse_frame(frame, key=DEFAULT_KEY, s08=DEFAULT_S08):
    if len(frame) < 20:
        raise ProtocolError("short frame")
    if len(key) != 16:
        raise ValueError("body key must be 16 bytes")
    if not isinstance(s08, (bytes, bytearray)) or not s08:
        raise ValueError("s08 must be non-empty bytes")
    s08 = bytes(s08)
    total, magic, cmd, seq = struct.unpack(">IIII", frame[:16])
    if magic != FRAME_MAGIC:
        raise ProtocolError("bad frame magic %#x" % magic)
    b = frame[16:]
    pref = b[0]
    hlen = b[1] >> 2
    b1 = b[1] & 3
    i = 3
    ver = struct.unpack(">I", b[i:i + 4])[0]; i += 4
    uin = struct.unpack(">I", b[i:i + 4])[0]; i += 4
    token = b[i:i + 15]; i += 15
    rcmd, i = rvi(b, i)
    raw_len, i = rvi(b, i)
    comp_len, i = rvi(b, i)
    v25, i = rvi(b, i)
    v27, i = rvi(b, i)
    a = None
    if pref == 0xBF:
        a, i = rvi(b, i)
    b2e = b[i]; i += 1
    bb, i = rvi(b, i)
    b33, b34 = b[i], b[i + 1]; i += 2
    v35, i = rvi(b, i)
    c = struct.unpack(">H", b[i:i + 2])[0]; i += 2
    info = dict(total=total, cmd=cmd, seq=seq, rcmd=rcmd, ver=ver, uin=uin,
                token=token.hex(), pref=pref, hlen=hlen, compressed=(b1 == 1),
                raw_len=raw_len, comp_len=comp_len, a=a, b=bb, c=c,
                b2e=b2e, b33=b33, b34=b34, v35=v35)
    info["header"] = b[:hlen].hex()
    ct = b[i:]
    info["ct_len"] = len(ct)
    # comp_len is the compressed plaintext length; the ciphertext also carries
    # the final PKCS#7 block, so it is the next 16-byte multiple.
    if info["ct_len"] % 16 or info["ct_len"] < comp_len or info["ct_len"] - comp_len > 15:
        raise ProtocolError("ciphertext length mismatch")
    if b1 == 1:
        pt = decode_body(ct, True, key)
    else:
        pt = decode_body(ct, False, key)
    info["pt_len"] = len(pt)
    if info["pt_len"] != raw_len:
        raise ProtocolError("plaintext length mismatch")
    if a:
        expect = checksum_a(len(pt), pt, uin, s08)
        info["a_ok"] = expect == a
        if not info["a_ok"]:
            raise ProtocolError("checksum mismatch")
    else:
        info["a_ok"] = False
    return info, pt


class Session(object):
    def __init__(self, uin, token, host=DEFAULT_HOST, port=DEFAULT_PORT,
                 body_key=None, s08=None):
        if isinstance(token, str):
            token = bytes.fromhex(token)
        if len(token) != 15:
            raise ValueError("token must be 15 bytes")
        if body_key is not None and len(body_key) != 16:
            raise ValueError("body_key must be 16 bytes")
        if s08 is not None and (not isinstance(s08, (bytes, bytearray)) or not s08):
            raise ValueError("s08 must be non-empty bytes")
        if (body_key is None) != (s08 is None):
            raise ValueError("body_key and s08 must be provided together")
        self.uin = int(uin)
        self.token = token
        self.host = host
        self.port = int(port)
        self.body_key = bytes(body_key) if body_key is not None else None
        self.s08 = bytes(s08) if s08 is not None else None

    def key(self):
        return self.body_key or DEFAULT_KEY

    def checksum_material(self):
        return self.s08 or DEFAULT_S08

    @classmethod
    def load(cls, path=SESSION_PATH):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        body_key = bytes.fromhex(d["body_key"]) if d.get("body_key") else None
        s08 = bytes.fromhex(d["s08"]) if d.get("s08") else None
        return cls(d["uin"], d["token"], d.get("host", DEFAULT_HOST),
                   d.get("port", DEFAULT_PORT), body_key, s08)

    def save(self, path=SESSION_PATH):
        d = {"uin": self.uin, "token": self.token.hex(),
             "host": self.host, "port": self.port}
        if self.body_key is not None:
            d["body_key"] = self.body_key.hex()
            d["s08"] = self.s08.hex()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1)


class Longlink(object):
    """One connection to the longlink server; one request/response at a time."""

    def __init__(self, session, timeout=10.0, b_oracle=None):
        self.session = session
        self.timeout = timeout
        self.b_oracle = b_oracle
        self.sock = None

    def connect(self):
        self.close()
        self.sock = socket.create_connection(
            (self.session.host, self.session.port), timeout=self.timeout)
        self.sock.settimeout(self.timeout)
        return self

    def close(self):
        s = self.sock
        self.sock = None
        if s is not None:
            try:
                s.close()
            except Exception:
                pass

    def __enter__(self):
        return self.connect()

    def __exit__(self, *exc):
        self.close()

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            part = self.sock.recv(n - len(buf))
            if not part:
                raise ProtocolError("connection closed after %d/%d bytes"
                                    % (len(buf), n))
            buf += part
        return buf

    def recv_frame(self):
        head = self._recv_exact(4)
        total = struct.unpack(">I", head)[0]
        if total < 20 or total > 64 * 1024 * 1024:
            raise ProtocolError("bad frame length %d" % total)
        return head + self._recv_exact(total - 4)

    def request(self, cmd, pt, seq=None, b=None, c=0, tries=3):
        if self.sock is None:
            self.connect()
        key = self.session.key()
        if b is None:
            if self.b_oracle:
                comp = zlib.compress(pt, 9)
                ct = aes.cbc_encrypt(key, key, comp)
                b = self.b_oracle(hashlib.md5(ct).hexdigest())
            else:
                b = 0
        if seq is None:
            seq = random.getrandbits(31)
        frame, meta = build_frame(cmd, pt, self.session.uin,
                                  self.session.token, seq, b, c, key=key,
                                  s08=self.session.checksum_material())
        self.sock.sendall(frame)
        want = RESP_FLAG | WIRE_CMD.get(cmd, cmd)
        skipped = []
        for _ in range(tries):
            try:
                wire = self.recv_frame()
            except (socket.timeout, ProtocolError) as exc:
                skipped.append({"recv_error": str(exc)})
                break
            if len(wire) >= 16:
                _, _, hcmd, hseq = struct.unpack(">IIII", wire[:16])
            else:
                hcmd, hseq = None, None
            if hcmd != want or hseq != seq:
                skipped.append({"len": len(wire), "cmd": hcmd, "seq": hseq})
                continue
            try:
                info, rpt = parse_frame(wire, key, self.session.checksum_material())
            except Exception as exc:
                skipped.append({"len": len(wire), "cmd": hcmd, "seq": hseq,
                                "parse_error": str(exc),
                                "hex": wire[:512].hex()})
                continue
            return dict(info=info, pt=rpt, meta=meta, skipped=skipped)
        raise ProtocolError("no response for cmd %d seq %d skipped=%r"
                            % (cmd, seq, skipped))

    # -- business requests -------------------------------------------------
    def send_text(self, to, text, f4=None, f5=None):
        pt, f4, f5 = build_text_request(to, text, f4, f5)
        res = self.request(CMD_SEND_TEXT, pt)
        return parse_send_response(res["pt"], f4, f5, res["info"])

    def new_sync(self, sync_key):
        pt = build_sync_request(sync_key)
        res = self.request(CMD_NEW_SYNC, pt)
        return parse_sync_response(res["pt"], res["info"])


# -------------------------------------------------------------- SendMsg

def build_text_request(to, text, f4=None, f5=None):
    tenc = text.encode("utf-8")
    if f4 is None:
        f4 = int(time.time() * 1000) & 0xFFFFFFFF
    if f5 is None:
        f5 = random.getrandbits(32)
    inner = ld(1, ld(1, to.encode("utf-8")))
    inner += ld(2, tenc)
    inner += fv(3, 1)
    inner += fv(4, f4)
    inner += fv(5, f5)
    inner += ld(6, MSGSRC)
    pt = fv(1, 1) + ld(2, inner)
    return pt, f4, f5


def parse_send_response(pt, f4, f5, info=None):
    fields = parse_pb(pt)
    br = parse_pb(pb_get(fields, 1, b"")) if pb_get(fields, 1) else []
    msginfo = parse_pb(pb_get(fields, 3, b"")) if pb_get(fields, 3) else []
    ret = pb_get(br, 1)
    errmsg = pb_get(br, 2, b"")
    out = {
        "ok": ret == 0,
        "ret": ret,
        "errmsg": errmsg.decode("utf-8", "replace") if isinstance(errmsg, bytes) else errmsg,
        "new_msg_id": pb_get(msginfo, 8),
        "server_time": pb_get(msginfo, 6),
        "echo_f4": pb_get(msginfo, 4),
        "echo_f5": pb_get(msginfo, 5),
        "client_f4": f4,
        "client_f5": f5,
        "raw_len": len(pt),
    }
    if info is not None:
        out["seq"] = info.get("seq")
    return out


# -------------------------------------------------------------- SyncKey

SYNC_SELECTOR = 262151


def decode_sync_key(raw):
    """Decode the SyncKey message; returns (head, [(id, value)])."""
    fields = parse_pb(raw)
    head = pb_get(fields, 1, 0)
    buf = pb_get(fields, 2, b"")
    entries = []
    if buf:
        inner = parse_pb(buf)
        for fn, wt, v in inner:
            if fn == 2 and wt == 2:
                kv = parse_pb(v)
                entries.append((pb_get(kv, 1), pb_get(kv, 2)))
    return head, entries


def encode_sync_key(entries, head=None):
    inner = fv(1, len(entries))
    for kid, val in entries:
        kv = fv(1, kid) + fv(2, val)
        inner += ld(2, kv)
    if head is None:
        head = len(inner)
    return fv(1, head) + ld(2, inner)


def build_sync_request(sync_key, selector=SYNC_SELECTOR,
                       device="Windows 11 x64"):
    pt = ld(1, fv(1, 0))
    pt += fv(2, selector)
    pt += ld(3, sync_key)
    pt += fv(4, 1)
    pt += ld(5, device.encode("utf-8"))
    pt += fv(6, 3)
    pt += fv(7, 1)
    return pt


def parse_sync_response(pt, info=None):
    fields = parse_pb(pt)
    cmdlist_raw = pb_get(fields, 2, b"")
    cmds = []
    count = 0
    if cmdlist_raw:
        cl = parse_pb(cmdlist_raw)
        count = pb_get(cl, 1, 0)
        for fn, wt, v in cl:
            if fn == 2 and wt == 2:
                cmds.append(v)
    key_raw = pb_get(fields, 4, b"")
    head, entries = decode_sync_key(key_raw) if key_raw else (None, [])
    out = {
        "ret": pb_get(fields, 1),
        "cmd_count": count,
        "cmd_list_raw": cmdlist_raw,
        "cmds": cmds,
        "continue_flag": pb_get(fields, 3),
        "sync_key_raw": key_raw,
        "sync_key_head": head,
        "sync_key": entries,
        "status": pb_get(fields, 5),
        "field6": pb_get(fields, 6),
        "server_time": pb_get(fields, 7),
        "keybuf": pb_get(fields, 8),
        "raw": pt,
    }
    if info is not None:
        out["seq"] = info.get("seq")
    return out


ADD_MSG_FIELDS = {
    1: "msg_id", 2: "from", 3: "to", 4: "type", 5: "content", 6: "status",
    7: "img_status", 9: "create_time", 10: "msg_source",
    11: "push_content", 12: "new_msg_id", 13: "msg_seq",
}
_STR_FIELDS = ("from", "to", "content", "push_content", "msg_source")


def _unwrap_string(v):
    """WeChat wraps strings in SKBuiltinString_t {1: bytes}."""
    for _ in range(2):
        if not isinstance(v, bytes):
            break
        try:
            fs = parse_pb(v)
        except ProtocolError:
            break
        if len(fs) == 1 and fs[0][0] == 1 and fs[0][1] == 2:
            v = fs[0][2]
        else:
            break
    return v


def _field_map(fields):
    """Decode one AddMsg message (already unwrapped from any sync wrapper)."""
    out = {}
    for fn, wt, v in fields:
        name = ADD_MSG_FIELDS.get(fn)
        if wt == 2:
            if name in _STR_FIELDS:
                out[name] = _unwrap_string(v).decode("utf-8", "replace")
            else:
                out[name or ("f%d" % fn)] = v.hex()
        else:
            out[name or ("f%d" % fn)] = v
    return out


def _is_add_msg(fields):
    has_type = any(f == 4 and w == 0 for f, w, _ in fields)
    has_text = any(f in (2, 3, 5) and w == 2 for f, w, _ in fields)
    return has_type and has_text


def parse_add_msg(payload):
    """Decode a NewSync AddMsg command payload.

    Captured AddMsg commands carry a small wrapper ({1: sequence,
    2: AddMsg}); plain AddMsg payloads are accepted as well.  Binary
    fields are returned as hex so the result is JSON-safe.
    """
    fields = parse_pb(payload)
    if not _is_add_msg(fields):
        inner = pb_get(fields, 2)
        if isinstance(inner, bytes):
            try:
                inner_fields = parse_pb(inner)
            except ProtocolError:
                inner_fields = []
            if _is_add_msg(inner_fields):
                out = _field_map(inner_fields)
                seq = pb_get(fields, 1)
                if isinstance(seq, int):
                    out["sync_seq"] = seq
                return out
    return _field_map(fields)


def load_sync_state(path=SYNC_STATE_PATH):
    """Return the encoded SyncKey message from the local cursor file."""
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    return encode_sync_key([(int(k), int(v)) for k, v in d["entries"]],
                           d.get("head"))


def save_sync_state(entries, head=None, path=SYNC_STATE_PATH):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"head": head, "entries": [[int(k), int(v)]
                                             for k, v in entries],
                   "updated": int(time.time())}, f, indent=1)
    os.replace(tmp, path)


def parse_cmd_list(cmd_list_raw):
    """Return [(cmd_id, payload_bytes)] for a CmdList message."""
    out = []
    for fn, wt, v in parse_pb(cmd_list_raw):
        if fn == 2 and wt == 2:
            cf = parse_pb(v)
            out.append((pb_get(cf, 1), pb_get(cf, 2, b"")))
    return out
