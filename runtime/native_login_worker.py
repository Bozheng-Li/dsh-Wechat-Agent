"""Managed native QR authentication, followed by an exclusive Node handoff.

This worker never makes a protocol request or sends a message. Only the bundled
client it creates performs authentication. Structured stdout contains no keys.
"""
import argparse
import io
import json
import queue
import sys
import threading
import time
import hashlib
import struct
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "wechat39"))
from proto import longlink as wire
from proto import qrcode_auth as qr
from native_engine import OwnedEngine


def scan_image(challenge, directory):
    from PIL import Image, ImageOps
    source = Image.open(io.BytesIO(challenge.image)).convert("RGBA")
    white = Image.new("RGBA", source.size, "white")
    white.alpha_composite(source)
    image = ImageOps.expand(white.convert("RGB"), border=max(20, source.width * 4 // 37), fill="white")
    file = directory / "qrcode.png"
    image.resize((image.width * 3, image.height * 3), Image.Resampling.NEAREST).save(file)
    return file


def edge_list(network, primary):
    long_nodes = (network or {}).get("long", [])
    result = []
    for node in long_nodes:
        for host in (node.get("ip"), node.get("domain")):
            if not host:
                continue
            edge = {"host": host, "port": int(node["port"])}
            if edge != primary and edge not in result:
                result.append(edge)
    return result


def captured_sync(frame, endpoint, body_key, s08, network=None):
    if len(frame) < 16:
        raise wire.ProtocolError("Short native longlink frame")
    total, magic, command, _ = struct.unpack_from(">IIII", frame)
    if total != len(frame) or magic != wire.FRAME_MAGIC:
        raise wire.ProtocolError("Invalid native longlink frame")
    # Authentication/NewInit packets use their own keys. Only NewSync carries
    # the session boundary we can decode with the native longlink body key.
    if command != wire.WIRE_CMD[wire.CMD_NEW_SYNC]:
        return None
    if len(body_key) != 16:
        raise ValueError("Native NewSync body key must be 16 bytes")
    if not s08 or len(s08) > 256:
        raise ValueError("Native NewSync checksum material is invalid")
    info, plain = wire.parse_frame(frame, body_key, s08)
    if info["rcmd"] != wire.CMD_NEW_SYNC:
        raise wire.ProtocolError("Native NewSync command mismatch")
    if (not info.get("a_ok") or info["raw_len"] != info["pt_len"]
            or info["ct_len"] < info["comp_len"]
            or info["ct_len"] - info["comp_len"] > 15
            or len(info["token"]) != 30 or info["uin"] == 0):
        raise ValueError("Invalid native longlink session")
    cursor = wire.pb_get(wire.parse_pb(plain), 3)
    if not cursor:
        raise ValueError("Native NewSync has no cursor")
    wire.parse_pb(cursor)
    primary = {"host": endpoint.get("host") or wire.DEFAULT_HOST,
               "port": int(endpoint.get("port") or wire.DEFAULT_PORT)}
    return {"uin": info["uin"], "token": info["token"], "sync_key": cursor.hex(),
            "host": primary["host"], "port": primary["port"],
            "edges": edge_list(network, primary),
            "body_key": bytes(body_key).hex(), "s08": bytes(s08).hex()}


def request_kind(data):
    top = wire.parse_pb(data)
    first, second = wire.pb_get(top, 1), wire.pb_get(top, 2)
    if not isinstance(first, bytes):
        return "Other"
    rsa = wire.parse_pb(first)
    if isinstance(second, bytes) and isinstance(wire.pb_get(rsa, 4), bytes) and wire.pb_get(rsa, 4).startswith(b"extdevnewpwd_"):
        return "ManualAuth"
    if isinstance(second, bytes) and isinstance(wire.pb_get(top, 3), bytes):
        return "CheckLoginQRCode"
    if isinstance(wire.pb_get(top, 3), int) and isinstance(second, bytes):
        return "GetLoginQRCode"
    if isinstance(second, bytes) and isinstance(wire.pb_get(rsa, 3), bytes):
        return "SecAutoAuth"
    return "Other"


def request_metadata(data, kind):
    top = wire.parse_pb(data)
    device = wire.parse_pb(wire.pb_get(top, 2)) if kind in ("ManualAuth", "SecAutoAuth") else top
    base = wire.parse_pb(wire.pb_get(device, 1))
    version = wire.pb_get(base, 4)
    wrapper = wire.pb_get(device, 24 if kind == "ManualAuth" else 15 if kind == "SecAutoAuth" else 11)
    result = {"version": hex(version & 0xffffffff) if isinstance(version, int) else None}
    if wrapper:
        ext = wire.pb_get(wire.parse_pb(wrapper), 2)
        buf = wire.pb_get(wire.parse_pb(ext), 3)
        cc = wire.pb_get(wire.parse_pb(buf), 2)
        result.update(ccdataBytes=len(cc), ccdataPayloadBytes=len(wire.pb_get(wire.parse_pb(cc), 3, b"")))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    cancelled = threading.Event()
    events = queue.Queue()
    engine = None
    stage = "EngineStart"
    challenge = None
    notice = None
    session = None
    previous = None
    core_ready = False
    channel_ready = False
    network = None
    crypto_candidates = []
    qr_requests = 0
    qr_requested_after_ready = False
    worker_refreshes = 0
    requests, trace = {}, []
    start = time.monotonic()
    last_qr_activity = start
    rc = 0

    def emit(state, **data):
        print(json.dumps({"state": state, **data}, ensure_ascii=True), flush=True)

    def controls():
        try:
            for line in sys.stdin:
                if json.loads(line).get("command") == "cancel":
                    break
        finally:
            cancelled.set()  # The owning application closed its pipe or exited.

    def on_message(message, data):
        events.put((message, data))

    def add_crypto(event, data):
        key_length = int(event.get("keyLength") or 0)
        s08_length = int(event.get("s08Length") or 0)
        if not data or key_length < 1 or s08_length < 1 or len(data) != 2 + key_length + s08_length:
            raise ValueError("Native crypto capture is malformed")
        key, s08 = bytes(data[2:2 + key_length]), bytes(data[2 + key_length:])
        # encType=5 consumes at most 16 bytes of the selected material.
        if len(key) > 16:
            key = key[:16]
        if len(key) != 16 or len(s08) > 256:
            return
        pair = (key, s08)
        if pair not in crypto_candidates:
            crypto_candidates.append(pair)
            del crypto_candidates[:-16]
        trace.append({"direction": "crypto", "keyBytes": len(key),
                      "s08Bytes": len(s08), "encType": event.get("encType"),
                      "thread": event.get("thread")})
        qr._atomic_json(directory / "native-trace.json", trace)

    threading.Thread(target=controls, daemon=True).start()
    try:
        # A new per-task directory, used for logs only; it does not fake a system user
        # environment, so the engine inherits the normal HKCU/APPDATA.
        engine = OwnedEngine(args.engine, Path(args.profile) / directory.name)
        if not cancelled.is_set():
            engine.launch((HERE / "native_login_agent.js").read_text("utf-8"), on_message)
        while not cancelled.is_set():
            if challenge and not notice and stage not in ("ManualAuth", "SecAutoAuth") and time.monotonic() >= challenge.expires_at:
                emit("expired")
                break
            if time.monotonic() - start > (600 if challenge else 75):
                raise TimeoutError("Native QR authentication timed out")
            if not engine.alive():
                raise RuntimeError("Native authentication process exited")
            try:
                message, data = events.get(timeout=0.1)
            except queue.Empty:
                if stage == "GetLoginQRCode" and challenge is None and worker_refreshes < 3 and time.monotonic() - last_qr_activity >= 4.5:
                    worker_refreshes += 1
                    last_qr_activity = time.monotonic()
                    engine.script.exports_sync.refresh_qr()
                continue
            if message.get("type") == "error":
                qr._atomic_json(directory / "native-error.json", message)
                raise RuntimeError("Native instrumentation failed")
            event = message.get("payload", {})
            kind = event.get("kind")
            if kind in ("login-page", "qr-page", "qr-refresh"):
                if kind == "qr-refresh":
                    last_qr_activity = time.monotonic()
                trace.append({"direction": "lifecycle", "stage": kind, **({"page": event["page"]} if "page" in event else {})})
                qr._atomic_json(directory / "native-trace.json", trace)
            elif kind == "core-ready":
                core_ready = True
                last_qr_activity = time.monotonic()
                trace.append({"direction": "lifecycle", "stage": "core-ready", "path": event.get("path")})
                qr._atomic_json(directory / "native-trace.json", trace)
                engine.script.exports_sync.watch_requests()
                stage = "GetLoginQRCode"
            elif kind == "hook-error":
                raise RuntimeError("Native authentication capture failed")
            elif kind == "crypto" and data:
                add_crypto(event, data)
            elif kind in ("pack-observed", "pack-miss") and stage in (
                    "ManualAuth", "NativeAuth", "NewSyncCapture", "EngineStop"):
                trace.append({"direction": "pack", "stage": kind,
                              **{name: event.get(name) for name in (
                                  "descriptor0", "descriptor4", "keyBytes", "s08Bytes",
                                  "encType", "thread") if event.get(name) is not None}})
                qr._atomic_json(directory / "native-trace.json", trace)
            elif kind == "request" and data:
                name, details = "Other", {}
                # This diagnostic boundary also receives non-auth binary traffic.
                try:
                    name = request_kind(data)
                    details = request_metadata(data, name) if name != "Other" else {}
                except (wire.ProtocolError, struct.error, IndexError, TypeError, ValueError):
                    pass
                requests[event.get("context")] = name
                if name == "GetLoginQRCode":
                    qr_requests += 1
                    last_qr_activity = time.monotonic()
                    if channel_ready:
                        qr_requested_after_ready = True
                trace.append({"direction": "request", "stage": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), **details})
                if name in ("ManualAuth", "SecAutoAuth"):
                    (directory / ("native_" + name + "_request.bin")).write_bytes(data)
                    stage = name
                qr._atomic_json(directory / "native-trace.json", trace)
            elif kind == "plaintext" and data:
                name = requests.get(event.get("context"), "Other")
                try:
                    ret, _ = qr.base_response(data)
                except qr.AuthError:
                    ret = None
                if name == "Other" and ret is not None and stage in ("ManualAuth", "SecAutoAuth", "NativeAuth"):
                    response_fields = wire.parse_pb(data)
                    if isinstance(wire.pb_get(response_fields, 2), int) and all(isinstance(wire.pb_get(response_fields, number), bytes) for number in (3, 4, 5, 6, 7, 8, 9)):
                        name = stage if stage in ("ManualAuth", "SecAutoAuth") else "ManualAuth"
                trace.append({"direction": "response", "stage": name, "ret": ret, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                qr._atomic_json(directory / "native-trace.json", trace)
                if name == "Other" and len(data) == 4918:
                    channel_ready = True
                elif name == "Other" and len(data) == 2641 and challenge is None and qr_requests > 0 and not qr_requested_after_ready and worker_refreshes < 3:
                    channel_ready = True
                    qr_requested_after_ready = True
                    worker_refreshes += 1
                    last_qr_activity = time.monotonic()
                    engine.script.exports_sync.refresh_qr()
                if name in ("ManualAuth", "SecAutoAuth"):
                    (directory / ("native_" + name + "_response.bin")).write_bytes(data)
                    if ret is not None and ret not in (0, -301):
                        raise qr.AuthError("Native authentication rejected", ret=ret)
                    if name == "ManualAuth" and ret == 0:
                        # Authentication has succeeded. Any later failure belongs
                        # to NewSync capture/decryption, not ManualAuth.
                        stage = "NewSyncCapture"
                        network = qr.parse_network(data)
                # The native hybrid boundary carries several message types.
                # Only a complete image challenge or its matching notice qualifies.
                try:
                    candidate = qr.QRChallenge.parse(data)
                except (qr.AuthError, ValueError, IndexError, UnicodeError):
                    candidate = None
                if candidate and candidate.image.startswith((b"\x89PNG", b"\xff\xd8\xff")):
                    challenge, notice = candidate, None
                    image = scan_image(challenge, directory)
                    expires = int((time.time() + challenge.expires_at - time.monotonic()) * 1000)
                    emit("waiting", imageFile=str(image), expiresAt=expires, scanBefore=expires, pollInterval=challenge.poll_interval)
                    previous = "waiting"
                    stage = "CheckLoginQRCode"
                elif challenge:
                    try:
                        current = qr.decrypt_notification(data, challenge)
                    except (qr.AuthError, ValueError, IndexError, UnicodeError):
                        current = None
                    if current:
                        if current["state"] != previous:
                            emit(current["state"])
                            previous = current["state"]
                        if current["state"] == "confirmed":
                            notice = current
                            stage = "NativeAuth"
                            emit("authenticating")
                        elif current["state"] in ("expired", "cancelled"):
                            break
            elif kind == "longlink" and data and core_ready:
                trace.append({"direction": "longlink", "command": int.from_bytes(data[8:12], "big"), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                qr._atomic_json(directory / "native-trace.json", trace)
                if len(data) < 16 or int.from_bytes(data[8:12], "big") != wire.WIRE_CMD[wire.CMD_NEW_SYNC]:
                    continue
                try:
                    candidate = None
                    for body_key, s08 in reversed(crypto_candidates):
                        try:
                            candidate = captured_sync(data, event, body_key, s08, network)
                        except (wire.ProtocolError, ValueError, IndexError):
                            continue
                        if candidate:
                            break
                    if not candidate:
                        raise wire.ProtocolError("Native NewSync did not match any captured session material")
                except Exception:
                    (directory / "native-failed-frame.bin").write_bytes(data)
                    raise
                # Real order is challenge, confirmed, then NewSync: a frame without this round's confirmation is ignored.
                if candidate and notice:
                    account = engine.script.exports_sync.account()
                    if not account or not account.get("wxid"):
                        continue
                    if notice["wxid"] != account["wxid"]:
                        raise ValueError("Native account does not match the scanned account")
                    session = {**candidate, **account, "contacts": engine.script.exports_sync.contacts()}
                    stage = "EngineStop"
                    break
        # No session is advertised until the job and its native process are gone.
        engine.close()
        engine = None
        if cancelled.is_set():
            emit("cancelled")
        elif session:
            file = directory / "session.json"
            qr._atomic_json(file, session)
            qr._atomic_json(directory / "handoff.json", {"nativeExited": True, "synchronizer": "node", "at": int(time.time() * 1000)})
            emit("session-ready", sessionFile=str(file))
    except Exception as exc:
        (directory / "native-exception.txt").write_text(traceback.format_exc(), "utf-8")
        labels = {
            "Handoff": "原生会话交接",
            "NewSyncCapture": "原生会话捕获/解密",
            "EngineStop": "原生进程清理",
        }
        reason = str(exc)
        if len(reason) > 200:
            reason = reason[:200]
        diagnostic = {"stage": stage, "error_type": type(exc).__name__,
                      "error_module": type(exc).__module__,
                      "ret": getattr(exc, "ret", None),
                      **({"reason": reason} if reason else {})}
        qr._atomic_json(directory / "diagnostic.json", diagnostic)
        code = "，ret=%s" % diagnostic["ret"] if diagnostic["ret"] is not None else ""
        emit("failed", error="内置微信登录失败（%s，%s%s）" % (
            labels.get(stage, stage), type(exc).__name__, code))
        rc = 1
    finally:
        if engine:
            engine.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
