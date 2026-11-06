"""Offline checks for native login boundaries; never launch WeChat."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))
import native_engine
import native_login_worker as worker


class NativeLogin(unittest.TestCase):
    key = b"K" * 16
    s08 = b"S" * 16

    def frame(self, cmd=138, *, key=None, s08=None):
        cursor = worker.wire.encode_sync_key([(1, 123)])
        plain = worker.wire.ld(3, cursor)
        frame, _ = worker.wire.build_frame(cmd, plain, 42, b"T" * 15, 1,
                                           key=key or self.key, s08=s08 or self.s08)
        return frame, cursor

    def crypto_event(self, key=None, s08=None):
        key, s08 = key or self.key, s08 or self.s08
        return ({"payload": {"kind": "crypto", "keyLength": len(key), "s08Length": len(s08),
                             "encType": 5, "thread": 7}}, bytes([len(key), len(s08)]) + key + s08)

    def auth_request(self, kind="ManualAuth", device=None):
        wire = worker.wire
        base = wire.ld(1, b"\0") + wire.fv(4, 0xfffffffff2542033)
        report = wire.ld(3, b"PRIVATE_FIXTURE_REPORT")
        buffer = wire.fv(1, len(report)) + wire.ld(2, report)
        ext = wire.ld(3, buffer)
        wrapper = wire.fv(1, len(ext)) + wire.ld(2, ext)
        if device is None:
            device = wire.ld(1, base) + wire.ld(24 if kind == "ManualAuth" else 15, wrapper)
        rsa = wire.ld(4, b"extdevnewpwd_PRIVATE_FIXTURE") if kind == "ManualAuth" else wire.ld(3, b"fixture-public-key")
        return wire.ld(1, rsa) + wire.ld(2, device), report

    def auth_response(self, ret=0):
        # Only the field/wire-type envelope is retained from historical accepted
        # and -100 UnifyAuthResponse evidence; every payload below is synthetic.
        wire = worker.wire
        base = wire.fv(1, ret & 0xffffffff) + wire.ld(2, wire.ld(1, b"PRIVATE_FIXTURE_RESPONSE"))
        node = wire.fv(2, 8080) + wire.ld(3, b"127.0.0.1") + wire.ld(4, b"long.fixture")
        network = wire.ld(3, wire.ld(3, node) + wire.ld(4, node))
        fields = {n: wire.ld(n, b"\x08\x00") for n in range(3, 10)}
        fields[5] = wire.ld(5, network)
        return wire.ld(1, base) + wire.fv(2, 1) + b"".join(fields[n] for n in range(3, 10))

    def qr_response(self):
        wire = worker.wire
        image = b"\x89PNG\r\n\x1a\nfixture"
        image_buffer = wire.fv(1, len(image)) + wire.ld(2, image)
        key_buffer = wire.fv(1, 16) + wire.ld(2, b"N" * 16)
        return (wire.ld(1, wire.fv(1, 0)) + wire.ld(2, image_buffer) + wire.ld(3, b"fixture-qr")
                + wire.fv(4, 5) + wire.ld(5, key_buffer) + wire.fv(6, 300))

    def notice(self):
        return worker.wire.ld(1, worker.wire.fv(1, 0))

    def qr_event(self):
        return {"kind": "plaintext", "context": "qr"}, self.qr_response()

    def notice_event(self):
        return {"kind": "plaintext", "context": "notice"}, self.notice()

    def run_events(self, messages, *, notice_wxid="wxid_fixture", account_wxid="wxid_fixture", friends=(), decrypt=None, sync=True, core_path=None, raw=(), frame_key=None, frame_s08=None, crypto_key=None, crypto_s08=None):
        # Nothing is confirmed implicitly: a test sends qr_event() and notice_event() when its round is confirmed.
        # The fake native process polls alive() once per queued event and exits after the last one.
        operations, ready = [], []
        frame = self.frame(key=frame_key, s08=frame_s08)[0]
        crypto = self.crypto_event(crypto_key, crypto_s08)
        total = len(messages) + len(raw) + 1 + 2 * int(sync)
        class Exports:
            def account(self): return {"wxid": account_wxid, "nickname": "Fixture"}
            def contacts(self): return list(friends)
            def watch_requests(self): operations.append("watch-requests")
            def refresh_qr(self): operations.append("refresh-qr"); return True
        class Engine:
            def __init__(self, *args):
                self.script = type("Script", (), {"exports_sync": Exports()})()
                self.polls = 0
            def launch(self, source, callback):
                operations.append("launch")
                callback({"payload": {"kind": "core-ready", "path": core_path}}, None)
                for payload, data in messages:
                    callback({"payload": payload}, data)
                for message in raw:
                    callback(message, None)
                if sync:
                    callback(*crypto)
                    callback({"payload": {"kind": "longlink", "host": "127.0.0.1", "port": 8080}}, frame)
            def alive(self):
                self.polls += 1
                return self.polls <= total
            def close(self): operations.append("native-exited")
        def image(challenge, directory):
            operations.append("qr-image")
            return directory / "fixture-qr.png"
        def notification(data, challenge):
            if decrypt:
                return decrypt(data, challenge)
            return {"state": "confirmed", "wxid": notice_wxid} if data == self.notice() else None
        class Output(io.StringIO):
            def write(self, text):
                if '"session-ready"' in text:
                    ready.append(list(operations))
                return super().write(text)
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker, "OwnedEngine", Engine), \
                patch.object(worker.threading.Thread, "start"), patch.object(worker, "scan_image", image), \
                patch.object(worker.qr, "decrypt_notification", notification), \
                patch.object(sys, "argv", ["worker", "--directory", tmp, "--engine", tmp, "--profile", tmp]):
            output = Output()
            with contextlib.redirect_stdout(output):
                code = worker.main()
            directory = Path(tmp)
            def read(name):
                file = directory / name
                return json.loads(file.read_text()) if file.exists() else None
            exception_file = directory / "native-exception.txt"
            return {
                "code": code,
                "events": [json.loads(line) for line in output.getvalue().splitlines()],
                "stdout": output.getvalue(),
                "operations": operations,
                "ready_operations": ready[0] if ready else None,
                "session": (directory / "session.json").exists(),
                "session_data": read("session.json"),
                "handoff": read("handoff.json"),
                "trace": read("native-trace.json") or [],
                "diagnostic": read("diagnostic.json"),
                "native_error": read("native-error.json"),
                "exception": exception_file.read_text("utf-8") if exception_file.exists() else None,
            }

    def test_auth_request_kind_and_report_metadata_without_disclosing_native_material(self):
        for kind in ("ManualAuth", "SecAutoAuth"):
            with self.subTest(kind=kind):
                request, report = self.auth_request(kind)
                self.assertEqual(worker.request_kind(request), kind)
                details = worker.request_metadata(request, kind)
                self.assertEqual(details, {"version": "0xf2542033", "ccdataBytes": len(report), "ccdataPayloadBytes": len(b"PRIVATE_FIXTURE_REPORT")})
                self.assertNotIn("PRIVATE_", json.dumps(details))

    def test_unify_auth_acceptance_and_rejection_are_correlated_and_cleanup_precedes_handoff(self):
        for ret in (0, -100):
            for response_context in ("auth", "native-response-only"):
                with self.subTest(ret=ret, context=response_context):
                    result = self.run_events([
                        self.qr_event(),
                        self.notice_event(),
                        ({"kind": "request", "context": "auth"}, self.auth_request()[0]),
                        ({"kind": "plaintext", "context": response_context}, self.auth_response(ret)),
                    ])
                    response = [entry for entry in result["trace"] if entry["direction"] == "response"][-1]
                    self.assertEqual((response["stage"], response["ret"]), ("ManualAuth", ret))
                    self.assertEqual(result["operations"][-1], "native-exited")
                    self.assertNotIn("PRIVATE_", json.dumps(result["trace"]))
                    if ret == 0:
                        self.assertEqual(result["code"], 0)
                        self.assertTrue(result["session"])
                        self.assertEqual(result["events"][-1]["state"], "session-ready")
                    else:
                        # A rejected auth is a failure even though the round was confirmed and NewSync was queued.
                        self.assertEqual(result["code"], 1)
                        self.assertFalse(result["session"])
                        self.assertIsNone(result["handoff"])
                        self.assertIsNone(result["ready_operations"])
                        self.assertEqual(result["diagnostic"]["ret"], -100)
                        self.assertEqual(result["events"][-1]["state"], "failed")

    def test_unbound_auth_shaped_response_cannot_fail_a_non_auth_login_stage(self):
        # The response arrives while the QR is still waiting, so no auth stage can claim it.
        result = self.run_events([
            self.qr_event(),
            ({"kind": "plaintext", "context": "unrelated"}, self.auth_response(-100)),
            self.notice_event(),
        ])
        self.assertEqual(result["code"], 0)
        self.assertTrue(result["session"])
        # The trace starts with the core-ready lifecycle entry, so select responses instead of indexing the whole trace.
        responses = [item for item in result["trace"] if item["direction"] == "response"]
        self.assertEqual((responses[1]["stage"], responses[1]["ret"]), ("Other", -100))

    def test_known_qr_context_wins_over_pending_auth_for_a_same_shaped_response(self):
        wire = worker.wire
        qr_request = wire.ld(1, wire.fv(4, 0xf2542033)) + wire.ld(2, b"fixture-key") + wire.ld(3, b"fixture-qr")
        result = self.run_events([
            self.qr_event(),
            self.notice_event(),
            ({"kind": "request", "context": "qr"}, qr_request),
            ({"kind": "request", "context": "auth"}, self.auth_request()[0]),
            ({"kind": "plaintext", "context": "qr"}, self.auth_response(-100)),
        ])
        self.assertEqual(result["code"], 0)
        self.assertTrue(result["session"])
        self.assertEqual([entry for entry in result["trace"] if entry["direction"] == "response"][-1]["stage"], "CheckLoginQRCode")

    def test_unrelated_nonzero_response_during_auth_does_not_kill_native_login(self):
        wire = worker.wire
        unrelated = wire.ld(1, wire.fv(1, (-2007) & 0xffffffff)) + wire.ld(3, b"fixture-unrelated")
        result = self.run_events([
            self.qr_event(),
            self.notice_event(),
            ({"kind": "request", "context": "auth"}, self.auth_request()[0]),
            ({"kind": "plaintext", "context": "other"}, unrelated),
        ])
        self.assertEqual(result["code"], 0)
        self.assertTrue(result["session"])
        self.assertEqual([entry for entry in result["trace"] if entry["direction"] == "response"][-1]["stage"], "Other")

    def test_request_diagnostics_never_block_the_next_valid_qr_on_native_binary_data(self):
        for request in (b"\xff", worker.wire.ld(1, b"\x80"), self.auth_request(device=b"\x80")[0]):
            with self.subTest(bytes=len(request)):
                result = self.run_events([
                    ({"kind": "request", "context": "diagnostic"}, request),
                    self.qr_event(),
                    self.notice_event(),
                ])
                self.assertEqual(result["code"], 0)
                self.assertEqual([e["state"] for e in result["events"]], ["waiting", "confirmed", "authenticating", "session-ready"])
                self.assertEqual(result["operations"], ["launch", "watch-requests", "qr-image", "native-exited"])
                self.assertIsNone(result["diagnostic"])

    def test_native_cursor_is_taken_from_a_checked_newsync_frame(self):
        frame, cursor = self.frame()
        session = worker.captured_sync(frame, {"host": "127.0.0.1", "port": 8080}, self.key, self.s08)
        self.assertEqual(session["sync_key"], cursor.hex())
        self.assertEqual(session["token"], (b"T" * 15).hex())
        self.assertEqual(session["uin"], 42)
        self.assertEqual(session["body_key"], self.key.hex())
        self.assertEqual(session["s08"], self.s08.hex())
        self.assertIsNone(worker.captured_sync(self.frame(522)[0], {}, self.key, self.s08))

    def test_newsync_rejects_wrong_key_and_wrong_s08(self):
        frame, _ = self.frame()
        with self.assertRaises(Exception):
            worker.captured_sync(frame, {"host": "127.0.0.1", "port": 8080},
                                 b"W" * 16, self.s08)
        with self.assertRaisesRegex(worker.wire.ProtocolError, "checksum"):
            worker.captured_sync(frame, {"host": "127.0.0.1", "port": 8080},
                                 self.key, b"W" * 16)

    def test_non_sync_packets_with_auth_keys_do_not_abort_a_confirmed_login(self):
        frame, _ = worker.wire.build_frame(139, worker.wire.ld(1, b"PRIVATE_INIT"), 42, b"T" * 15, 1,
                                           key=self.key, s08=self.s08)
        with patch.object(worker.wire, "parse_frame", side_effect=AssertionError("Non-sync body must not be decrypted")):
            self.assertIsNone(worker.captured_sync(frame, {}, self.key, self.s08))
        result = self.run_events([
            self.qr_event(), self.notice_event(),
            ({"kind": "request", "context": "auth"}, self.auth_request()[0]),
            ({"kind": "plaintext", "context": "auth"}, self.auth_response()),
            self.crypto_event(),
            ({"kind": "longlink"}, frame),
        ])
        self.assertEqual(result["code"], 0)
        self.assertTrue(result["session"])
        self.assertEqual(result["events"][-1]["state"], "session-ready")
        self.assertEqual(result["operations"][-1], "native-exited")

    def test_outer_sync_envelope_must_match_the_inner_command_and_frame_length(self):
        frame = bytearray(self.frame(522)[0])
        frame[8:12] = worker.struct.pack(">I", worker.wire.WIRE_CMD[138])
        with self.assertRaisesRegex(worker.wire.ProtocolError, "command mismatch"):
            worker.captured_sync(bytes(frame), {}, self.key, self.s08)
        frame = self.frame()[0]
        with self.assertRaisesRegex(worker.wire.ProtocolError, "Invalid native longlink frame"):
            worker.captured_sync(frame[:-1], {}, self.key, self.s08)
        with self.assertRaisesRegex(worker.wire.ProtocolError, "Short native longlink frame"):
            worker.captured_sync(b"short", {}, self.key, self.s08)

    def test_corrupt_native_frame_does_not_become_a_session(self):
        frame = bytearray(self.frame()[0])
        frame[-1] ^= 0x80
        with self.assertRaises(Exception):
            worker.captured_sync(bytes(frame), {}, self.key, self.s08)

    def test_manifest_rejects_missing_changed_or_escaping_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "WeChat.exe").write_bytes(b"fixture")
            manifest = {"files": [{"name": "WeChat.exe", "bytes": 7, "sha256": hashlib.sha256(b"fixture").hexdigest()}]}
            (root / "manifest.json").write_text(json.dumps(manifest))
            # Windows runners may expose TEMP through an 8.3 path alias.
            self.assertEqual(native_engine.verify_engine(root), root.resolve())
            (root / "WeChat.exe").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                native_engine.verify_engine(root)
            manifest["files"][0]["name"] = "../outside.exe"
            (root / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                native_engine.verify_engine(root)

    @unittest.skipUnless(os.name == "nt", "Windows private registry hive")
    def test_empty_app_hive_loads_and_writes_without_global_registry_changes(self):
        import ctypes as C
        from ctypes import wintypes as W
        import winreg
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "private.dat"
            native_engine.create_hive_template(file)
            adv = C.WinDLL("advapi32")
            h = W.HANDLE()
            self.assertEqual(adv.RegLoadAppKeyW(str(file), C.byref(h), 0xf003f, 1, 0), 0)
            try:
                with winreg.CreateKey(h.value, "Software\\Tencent\\WeChat") as key:
                    winreg.SetValueEx(key, "FileSavePath", 0, winreg.REG_SZ, tmp)
                    self.assertEqual(winreg.QueryValueEx(key, "FileSavePath")[0], tmp)
            finally:
                adv.RegCloseKey.argtypes = [W.HANDLE]
                adv.RegCloseKey(h)

    def test_engine_launch_keeps_real_user_environment_and_isolates_before_resume(self):
        real = {"USERPROFILE": "U:/real/user", "APPDATA": "U:/real/user/AppData/Roaming", "LOCALAPPDATA": "U:/real/user/AppData/Local",
                "TEMP": "U:/real/Temp", "TMP": "U:/real/Temp", "PATH": "U:/bin"}
        ops, created = [], {}
        kernel, user, script = MagicMock(), MagicMock(), MagicMock()
        kernel.CreateJobObjectW.return_value = 1
        kernel.SetInformationJobObject.return_value = 1
        kernel.AssignProcessToJobObject.return_value = 1
        kernel.WaitForSingleObject.return_value = 0
        kernel.QueryInformationJobObject.return_value = 1
        user.CreateDesktopW.return_value = 5
        def create_process(exe, command, process_attrs, thread_attrs, inherit, flags, environment, cwd, startup, info):
            # The environment block is copied now; byref(...)._obj is the ProcessInfo the engine will read back.
            created.update(flags=flags, cwd=cwd, environment=environment[:])
            ops.append("create-process")
            info._obj.process, info._obj.thread, info._obj.pid = 11, 12, 4242
            return 1
        kernel.CreateProcessW.side_effect = create_process
        kernel.ResumeThread.side_effect = lambda handle: ops.append("resume") or 1
        kernel.TerminateJobObject.side_effect = lambda *args: ops.append("terminate-job") or 1
        script.load.side_effect = lambda: ops.append("script-load")
        script.exports_sync.isolate.side_effect = lambda path: ops.append(("isolate", path))
        frida = MagicMock()
        frida.attach.return_value.create_script.return_value = script
        def dll(name, **kwargs):
            return {"kernel32": kernel, "user32": user}[name]
        with tempfile.TemporaryDirectory() as tmp:
            profile = str((Path(tmp) / "job").resolve())
            temp = str(Path(profile) / "Temp")
            with patch.object(native_engine, "verify_engine", side_effect=lambda path: Path(path)), \
                    patch.object(native_engine.C, "WinDLL", dll, create=True), \
                    patch.dict(sys.modules, {"frida": frida}), patch.dict(os.environ, real, clear=True):
                engine = native_engine.OwnedEngine(tmp, Path(tmp) / "job")
                engine.launch("source", lambda message, data: None)
                engine.close()
            entries = [item for item in created["environment"].split("\0") if item]
            environment = dict(item.split("=", 1) for item in entries)
            for name in ("USERPROFILE", "APPDATA", "LOCALAPPDATA"):
                self.assertEqual(environment[name], real[name])
            # Only TEMP and TMP are private to this launch; every other variable is the caller's.
            self.assertEqual(environment, {**real, "TEMP": temp, "TMP": temp})
            self.assertEqual(created["cwd"], profile)
            self.assertTrue(created["flags"] & 0x4)  # CREATE_SUSPENDED, so isolation can run first.
            self.assertTrue(Path(temp).is_dir())
            self.assertFalse(hasattr(engine, "hive"))
            self.assertEqual(list(Path(profile).rglob("hkcu.dat")), [])
        self.assertEqual(ops, ["create-process", "script-load", ("isolate", profile), "resume", "terminate-job"])

    def test_handoff_needs_the_fixture_qr_and_this_rounds_confirmation_and_follows_native_exit(self):
        friends = [{"id": "friend", "nickname": "Friend", "remark": ""}]
        result = self.run_events([self.qr_event(), self.notice_event()], friends=friends)
        self.assertEqual(result["code"], 0)
        self.assertEqual([e["state"] for e in result["events"]], ["waiting", "confirmed", "authenticating", "session-ready"])
        self.assertEqual(result["ready_operations"], ["launch", "watch-requests", "qr-image", "native-exited"])
        self.assertEqual(result["session_data"]["wxid"], "wxid_fixture")
        self.assertEqual(result["session_data"]["contacts"][0]["id"], "friend")
        self.assertNotIn("token", result["stdout"])
        self.assertTrue(result["handoff"]["nativeExited"])

    def test_dynamic_session_material_is_kept_out_of_stdout_trace_and_diagnostics(self):
        key, s08 = b"Q" * 16, b"R" * 16
        result = self.run_events(
            [self.qr_event(), self.notice_event(),
             ({"kind": "request", "context": "auth"}, self.auth_request()[0]),
             ({"kind": "plaintext", "context": "auth"}, self.auth_response())],
            frame_key=key, frame_s08=s08, crypto_key=key, crypto_s08=s08)
        session = result["session_data"]
        self.assertEqual(session["body_key"], key.hex())
        self.assertEqual(session["s08"], s08.hex())
        for material in (key.hex(), s08.hex()):
            self.assertNotIn(material, result["stdout"])
            self.assertNotIn(material, json.dumps(result["trace"]))
            self.assertNotIn(material, json.dumps(result["diagnostic"]))
            self.assertNotIn(material, result["exception"] or "")
        self.assertIsNone(result["exception"])

    def test_successful_manual_auth_then_missing_newsync_material_is_a_handoff_failure(self):
        result = self.run_events(
            [self.qr_event(), self.notice_event(),
             ({"kind": "request", "context": "auth"}, self.auth_request()[0]),
             ({"kind": "plaintext", "context": "auth"}, self.auth_response())],
            frame_key=b"X" * 16)
        self.assertEqual(result["code"], 1)
        self.assertEqual(result["diagnostic"]["stage"], "NewSyncCapture")
        self.assertIn("原生会话捕获/解密", result["events"][-1]["error"])
        self.assertNotIn("ManualAuth", result["events"][-1]["error"])
        self.assertFalse(result["session"])

    def test_newsync_without_a_confirmed_round_never_hands_off(self):
        scanned = lambda data, challenge: {"state": "scanned", "wxid": "wxid_fixture"}
        cases = {
            "no-qr": ([], None, ["failed"]),
            "waiting": ([self.qr_event()], None, ["waiting", "failed"]),
            "scanned": ([self.qr_event(), self.notice_event()], scanned, ["waiting", "scanned", "failed"]),
            # A new challenge discards the previous round's confirmation.
            "stale-confirmation": ([self.qr_event(), self.notice_event(), self.qr_event()], None,
                                  ["waiting", "confirmed", "authenticating", "waiting", "failed"]),
        }
        for name, (messages, decrypt, states) in cases.items():
            with self.subTest(case=name):
                # The account and a valid NewSync are both present; only this round's confirmation is missing.
                result = self.run_events(messages, decrypt=decrypt)
                self.assertEqual(result["code"], 1)
                self.assertEqual([e["state"] for e in result["events"]], states)
                self.assertFalse(result["session"])
                self.assertIsNone(result["handoff"])
                self.assertIsNone(result["ready_operations"])
                self.assertEqual(result["operations"][-1], "native-exited")
                self.assertEqual(result["diagnostic"]["error_type"], "RuntimeError")

    def test_confirmed_account_mismatch_is_rejected_without_a_session(self):
        result = self.run_events([self.qr_event(), self.notice_event()], notice_wxid="wxid_scanned", account_wxid="wxid_native")
        self.assertEqual(result["code"], 1)
        self.assertEqual([e["state"] for e in result["events"]], ["waiting", "confirmed", "authenticating", "failed"])
        self.assertEqual(result["operations"], ["launch", "watch-requests", "qr-image", "native-exited"])
        self.assertFalse(result["session"])
        self.assertIsNone(result["handoff"])
        self.assertIsNone(result["ready_operations"])
        self.assertEqual(result["diagnostic"]["error_type"], "ValueError")

    def test_core_ready_starts_request_watch_once_and_is_traced_with_page_lifecycle(self):
        result = self.run_events([
            ({"kind": "login-page", "page": "fixture-login"}, None),
            ({"kind": "qr-page"}, None),
            self.qr_event(),
            self.notice_event(),
        ], core_path="fixture-core.dll")
        self.assertEqual(result["code"], 0)
        # Request watching starts at core-ready, before any QR image; the challenge does not start it again.
        self.assertEqual(result["ready_operations"], ["launch", "watch-requests", "qr-image", "native-exited"])
        self.assertEqual(result["operations"].count("watch-requests"), 1)
        self.assertEqual(result["trace"][:3], [
            {"direction": "lifecycle", "stage": "core-ready", "path": "fixture-core.dll"},
            {"direction": "lifecycle", "stage": "login-page", "page": "fixture-login"},
            {"direction": "lifecycle", "stage": "qr-page"},
        ])

    def test_instrumentation_error_message_stays_in_a_private_file_not_stdout_or_diagnostic(self):
        message = {"type": "error", "description": "PRIVATE_NATIVE_ERROR", "stack": "PRIVATE_STACK"}
        result = self.run_events([], raw=[message], sync=False)
        self.assertEqual(result["code"], 1)
        self.assertEqual(result["native_error"], message)
        self.assertNotIn("PRIVATE_", result["stdout"])
        self.assertNotIn("PRIVATE_", json.dumps(result["diagnostic"]))
        self.assertEqual(result["diagnostic"]["error_type"], "RuntimeError")
        self.assertEqual([e["state"] for e in result["events"]], ["failed"])
        self.assertFalse(result["session"])
        self.assertIsNone(result["handoff"])
        self.assertEqual(result["operations"][-1], "native-exited")

    def test_rejected_pre_qr_get_login_qrcode_keeps_its_ret_and_stage_in_the_diagnostics(self):
        wire = worker.wire
        get_qr = wire.ld(1, wire.fv(4, 0xf2542033)) + wire.ld(2, b"fixture-key") + wire.fv(3, 1)
        rejected = wire.ld(1, wire.fv(1, (-2007) & 0xffffffff)) + wire.ld(3, b"fixture-rejected")
        result = self.run_events([
            ({"kind": "request", "context": "qr"}, get_qr),
            ({"kind": "plaintext", "context": "qr"}, rejected),
        ], sync=False)
        # No QR ever arrives, so the native exit is the failure; the rejection must survive in the trace.
        self.assertEqual(result["code"], 1)
        self.assertEqual([e["state"] for e in result["events"]], ["failed"])
        self.assertEqual(result["operations"], ["launch", "watch-requests", "native-exited"])
        self.assertEqual((result["trace"][1]["direction"], result["trace"][1]["stage"]), ("request", "GetLoginQRCode"))
        self.assertEqual((result["trace"][2]["direction"], result["trace"][2]["stage"], result["trace"][2]["ret"]), ("response", "GetLoginQRCode", -2007))
        self.assertEqual(result["diagnostic"]["stage"], "GetLoginQRCode")
        self.assertEqual(result["diagnostic"]["error_type"], "RuntimeError")
        self.assertIn("GetLoginQRCode", result["events"][-1]["error"])
        self.assertFalse(result["session"])
        self.assertIsNone(result["handoff"])

    def test_native_exit_before_newsync_after_confirmation_is_a_failure(self):
        result = self.run_events([self.qr_event(), self.notice_event()], sync=False)
        self.assertEqual(result["code"], 1)
        self.assertEqual([e["state"] for e in result["events"]], ["waiting", "confirmed", "authenticating", "failed"])
        self.assertEqual(result["operations"][-1], "native-exited")
        self.assertFalse(result["session"])
        self.assertIsNone(result["handoff"])
        self.assertEqual(result["diagnostic"]["error_type"], "RuntimeError")

    def test_expired_qr_stops_the_native_client_without_a_session(self):
        operations = []
        class Engine:
            def __init__(self, *args):
                self.script = type("Script", (), {"exports_sync": type("Exports", (), {"watch_requests": lambda self: None})()})()
            def launch(self, source, callback):
                callback({"payload": {"kind": "core-ready"}}, None)
                callback({"payload": {"kind": "plaintext"}}, b"fixture")
            def alive(self): return True
            def close(self): operations.append("closed")
        challenge = worker.qr.QRChallenge("fixture", b"\x89PNGfixture", b"N" * 16, 5, 0)
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker, "OwnedEngine", Engine), patch.object(worker.threading.Thread, "start"), \
                patch.object(worker.qr.QRChallenge, "parse", return_value=challenge), \
                patch.object(worker, "scan_image", return_value=Path(tmp) / "qrcode.png"), \
                patch.object(sys, "argv", ["worker", "--directory", tmp, "--engine", tmp, "--profile", tmp]):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(worker.main(), 0)
            self.assertEqual([json.loads(line)["state"] for line in output.getvalue().splitlines()], ["waiting", "expired"])
            self.assertEqual(operations, ["closed"])
            self.assertFalse((Path(tmp) / "session.json").exists())

    def test_pre_channel_get_login_qrcode_retriggers_refresh_once_channel_responses_arrive(self):
        wire = worker.wire
        get_qr = wire.ld(1, wire.fv(4, 0xf2542009)) + wire.ld(2, b"fixture-key") + wire.fv(3, 1)
        result = self.run_events([
            ({"kind": "request", "context": "qr-1"}, get_qr),
            ({"kind": "request", "context": "qr-2"}, get_qr),
            ({"kind": "plaintext", "context": "init-4918"}, b"\x00" * 4918),
            ({"kind": "plaintext", "context": "init-2641"}, b"\x00" * 2641),
            ({"kind": "qr-refresh"}, None),
            ({"kind": "request", "context": "qr-3"}, get_qr),
            self.qr_event(),
            self.notice_event(),
        ])
        self.assertEqual(result["code"], 0)
        self.assertEqual([e["state"] for e in result["events"]], ["waiting", "confirmed", "authenticating", "session-ready"])
        self.assertEqual(result["ready_operations"], ["launch", "watch-requests", "refresh-qr", "qr-image", "native-exited"])
        self.assertTrue(any(e.get("direction") == "lifecycle" and e.get("stage") == "qr-refresh" for e in result["trace"]))

    def test_clean_host_cache_removes_polluted_dynamic_dns_files_while_keeping_static_host_mappings(self):
        with tempfile.TemporaryDirectory() as tmp:
            appdata = Path(tmp) / "Roaming"
            host = appdata / "Tencent/WeChat/1/host"
            host.mkdir(parents=True)
            for name in ("wifi__f2542009.getdns2", "getdns.ini", "effect_time.ini", "query_interval.ini", "ipportrecords2.xml", "networkid_mapped.xml"):
                (host / name).write_text("polluted")
            for name in ("ip.ini", "host-redirect.xml", "cgi-mapping_1728184371.xml"):
                (host / name).write_text("keep")
            with patch.object(native_engine, "verify_engine", side_effect=lambda path: Path(path)), \
                    patch.object(native_engine.C, "WinDLL", return_value=MagicMock(), create=True), \
                    patch.dict(os.environ, {"APPDATA": str(appdata)}, clear=False):
                engine = native_engine.OwnedEngine(tmp, Path(tmp) / "job")
                engine.clean_host_cache()
            self.assertEqual(sorted(p.name for p in host.iterdir()), ["cgi-mapping_1728184371.xml", "host-redirect.xml", "ip.ini"])
            backups = list((Path(tmp) / "job/host-cache-backups").glob("*/cleanup.json"))
            self.assertEqual(len(backups), 1)
            report = json.loads(backups[0].read_text("utf-8"))
            self.assertEqual(len(report["files"]), 6)
            self.assertEqual(report["errors"], [])
            for name in report["files"]:
                self.assertEqual((backups[0].parent / name).read_text(), "polluted")

    def test_host_cache_is_kept_when_backup_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            appdata = Path(tmp) / "Roaming"
            host = appdata / "Tencent/WeChat/1/host"
            host.mkdir(parents=True)
            file = host / "getdns.ini"
            file.write_text("keep-until-backed-up")
            with patch.object(native_engine, "verify_engine", side_effect=lambda path: Path(path)), \
                    patch.object(native_engine.C, "WinDLL", return_value=MagicMock(), create=True), \
                    patch.dict(os.environ, {"APPDATA": str(appdata)}, clear=False), \
                    patch.object(native_engine.shutil, "copy2", side_effect=PermissionError("test")):
                native_engine.OwnedEngine(tmp, Path(tmp) / "job").clean_host_cache()
            self.assertEqual(file.read_text(), "keep-until-backed-up")

    def test_qr_deadline_applies_before_confirmation_but_not_to_native_auth_in_progress(self):
        for progress in ("scanned", "confirmed", "ManualAuth"):
            with self.subTest(progress=progress):
                clock = [100.0]
                metadata = worker.request_metadata
                def request_metadata(data, kind):
                    details = metadata(data, kind)
                    clock[0] = 401.0  # The 300-second QR deadline elapsed after auth started.
                    return details
                def notification(data, challenge):
                    clock[0] = 401.0
                    return {"state": progress, "wxid": "wxid_fixture"}
                event = ({"kind": "request", "context": "auth"}, self.auth_request()[0]) if progress == "ManualAuth" else self.notice_event()
                with patch.object(worker.time, "monotonic", side_effect=lambda: clock[0]), \
                        patch.object(worker, "request_metadata", side_effect=request_metadata):
                    result = self.run_events([self.qr_event(), event], decrypt=notification)
                states = [e["state"] for e in result["events"]]
                self.assertEqual(result["operations"][-1], "native-exited")
                if progress == "scanned":
                    self.assertEqual(result["code"], 0)
                    self.assertEqual(states, ["waiting", "scanned", "expired"])
                    self.assertFalse(result["session"])
                elif progress == "confirmed":
                    self.assertEqual(result["code"], 0)
                    self.assertEqual(states[:3], ["waiting", "confirmed", "authenticating"])
                    self.assertEqual(states[-1], "session-ready")
                    self.assertNotIn("expired", states)
                    self.assertTrue(result["session"])
                else:
                    # Auth in progress is not expired by the QR deadline, but without a confirmation it still cannot hand off.
                    self.assertEqual(result["code"], 1)
                    self.assertEqual(states, ["waiting", "failed"])
                    self.assertEqual([entry for entry in result["trace"] if entry["direction"] == "request"][-1]["stage"], "ManualAuth")
                    self.assertEqual(result["diagnostic"]["stage"], "ManualAuth")
                    self.assertFalse(result["session"])


if __name__ == "__main__":
    unittest.main()
