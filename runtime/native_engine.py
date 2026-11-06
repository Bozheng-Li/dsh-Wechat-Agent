"""Windows lifecycle for the application's own native authentication engine."""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import struct
import time
import uuid


def verify_engine(engine):
    engine = Path(engine).resolve()
    manifest = json.loads((engine / "manifest.json").read_text("utf-8"))
    for item in manifest["files"]:
        file = engine / item["name"]
        if file.parent != engine or not file.is_file():
            raise ValueError("Native engine file missing")
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if file.stat().st_size != item["bytes"] or digest != item["sha256"]:
            raise ValueError("Native engine file differs from its bundled manifest")
    return engine


def create_hive_template(file):
    """Build an empty REGF hive; RegLoadAppKey validates it without elevation."""
    adv = C.WinDLL("advapi32", use_last_error=True)
    kernel = C.WinDLL("kernel32", use_last_error=True)
    sd, sd_size = C.c_void_p(), W.DWORD()
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW("O:SYG:SYD:P(A;;KA;;;WD)", 1, C.byref(sd), C.byref(sd_size)):
        raise C.WinError(C.get_last_error())
    kernel.LocalFree.argtypes = [C.c_void_p]
    try:
        security = C.string_at(sd, sd_size.value)
    finally:
        kernel.LocalFree(sd)
    data = bytearray(8192)
    stamp = int((time.time() + 11644473600) * 10000000)
    data[:4] = b"regf"
    struct.pack_into("<IIQIIIIIII", data, 4, 1, 1, stamp, 1, 5, 0, 1, 32, 4096, 1)
    data[4096:4100] = b"hbin"
    struct.pack_into("<II", data, 4100, 0, 4096)
    struct.pack_into("<Q", data, 4116, stamp)
    root_size = 88
    sec_offset = 32 + root_size
    nk = bytearray(80)
    struct.pack_into("<2sHQ", nk, 0, b"nk", 0x2c, stamp)
    struct.pack_into("<I", nk, 16, 0xffffffff)
    for offset in (28, 32, 40, 48):
        struct.pack_into("<I", nk, offset, 0xffffffff)
    struct.pack_into("<I", nk, 44, sec_offset)
    struct.pack_into("<H", nk, 72, 4)
    nk[76:80] = b"ROOT"
    struct.pack_into("<i", data, 4128, -root_size)
    data[4132:4212] = nk
    sk = struct.pack("<2sHIIII", b"sk", 0, sec_offset, sec_offset, 1, len(security)) + security
    sk_size = (4 + len(sk) + 7) & ~7
    struct.pack_into("<i", data, 4096 + sec_offset, -sk_size)
    data[4100 + sec_offset:4100 + sec_offset + len(sk)] = sk
    free_offset = 4096 + sec_offset + sk_size
    struct.pack_into("<i", data, free_offset, 8192 - free_offset)
    checksum = 0
    for offset in range(0, 508, 4):
        checksum ^= struct.unpack_from("<I", data, offset)[0]
    struct.pack_into("<I", data, 508, checksum if checksum not in (0, 0xffffffff) else (1 if checksum == 0 else 0xfffffffe))
    Path(file).write_bytes(data)
    handle = W.HANDLE()
    result = adv.RegLoadAppKeyW(str(Path(file).resolve()), C.byref(handle), 0xF003F, 1, 0)
    if result:
        raise C.WinError(result)
    adv.RegCloseKey.argtypes = [W.HANDLE]
    adv.RegCloseKey(handle)


class StartupInfo(C.Structure):
    _fields_ = [("cb", W.DWORD), ("reserved", W.LPWSTR), ("desktop", W.LPWSTR),
                ("title", W.LPWSTR), ("x", W.DWORD), ("y", W.DWORD),
                ("width", W.DWORD), ("height", W.DWORD), ("charsX", W.DWORD),
                ("charsY", W.DWORD), ("fill", W.DWORD), ("flags", W.DWORD),
                ("show", W.WORD), ("reserved2Size", W.WORD), ("reserved2", C.c_void_p),
                ("stdin", W.HANDLE), ("stdout", W.HANDLE), ("stderr", W.HANDLE)]


class ProcessInfo(C.Structure):
    _fields_ = [("process", W.HANDLE), ("thread", W.HANDLE), ("pid", W.DWORD), ("tid", W.DWORD)]


class JobLimits(C.Structure):
    _fields_ = [("processTime", C.c_longlong), ("jobTime", C.c_longlong), ("flags", W.DWORD),
                ("minWorkingSet", C.c_size_t), ("maxWorkingSet", C.c_size_t),
                ("activeProcesses", W.DWORD), ("affinity", C.c_size_t),
                ("priority", W.DWORD), ("scheduling", W.DWORD),
                ("io", C.c_ulonglong * 6), ("processMemory", C.c_size_t),
                ("jobMemory", C.c_size_t), ("peakProcessMemory", C.c_size_t), ("peakJobMemory", C.c_size_t)]


class OwnedEngine:
    HOST_CACHE_FILES = {
        "effect_time.ini", "errcode_list.ini", "getdns.ini",
        "ipportrecords2.xml", "networkid_mapped.xml", "nextprotocol.ini", "query_interval.ini",
    }

    def __init__(self, engine, profile):
        self.engine = verify_engine(engine)
        self.profile = Path(profile).resolve()
        self.profile.mkdir(parents=True, exist_ok=True)
        # Keep the real Windows user environment used by the local 3.9 client.
        # This directory holds only this launch's working files, not a new user.
        self.paths = {"Temp": str(self.profile / "Temp")}
        Path(self.paths["Temp"]).mkdir(parents=True, exist_ok=True)
        self.kernel = C.WinDLL("kernel32", use_last_error=True)
        self.user = C.WinDLL("user32", use_last_error=True)
        self.kernel.CreateJobObjectW.restype = W.HANDLE
        self.kernel.CreateJobObjectW.argtypes = [C.c_void_p, W.LPCWSTR]
        self.kernel.CloseHandle.argtypes = [W.HANDLE]
        self.kernel.SetInformationJobObject.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [W.HANDLE, W.HANDLE]
        self.kernel.QueryInformationJobObject.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.c_void_p]
        self.kernel.TerminateJobObject.argtypes = [W.HANDLE, W.UINT]
        self.kernel.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
        self.kernel.ResumeThread.argtypes = [W.HANDLE]
        self.kernel.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, C.c_void_p, C.c_void_p, W.BOOL, W.DWORD, C.c_void_p, W.LPCWSTR, C.POINTER(StartupInfo), C.POINTER(ProcessInfo)]
        self.user.CreateDesktopW.restype = W.HANDLE
        self.user.CreateDesktopW.argtypes = [W.LPCWSTR, C.c_void_p, C.c_void_p, W.DWORD, W.DWORD, C.c_void_p]
        self.user.CloseDesktop.argtypes = [W.HANDLE]
        self.job = self.desktop = None
        self.info = ProcessInfo()
        self.session = self.script = None

    def clean_host_cache(self):
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return
        host = Path(appdata) / "Tencent/WeChat/1/host"
        if not host.is_dir() or not host.resolve().is_relative_to(Path(appdata).resolve()):
            return
        # The old client still needs its normal Windows environment. Preserve
        # the dynamic DNS files before clearing them instead of deleting the
        # user's only copy. Static mappings and redirected paths are untouched.
        backup = self.profile / "host-cache-backups" / uuid.uuid4().hex
        report = {"source": str(host), "files": [], "errors": []}
        for entry in host.iterdir():
            if entry.is_file() and not entry.is_symlink() and entry.resolve().parent == host.resolve() and (entry.suffix == ".getdns2" or entry.name in self.HOST_CACHE_FILES):
                try:
                    backup.mkdir(parents=True, exist_ok=True)
                    before = entry.stat()
                    shutil.copy2(entry, backup / entry.name)
                    after = entry.stat()
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        report["errors"].append({"name": entry.name, "reason": "changed-during-backup"})
                        continue
                    entry.unlink()
                    report["files"].append(entry.name)
                except OSError as error:
                    report["errors"].append({"name": entry.name, "reason": type(error).__name__})
        if backup.is_dir():
            try:
                (backup / "cleanup.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            except OSError:
                pass  # Backups already exist; a report error must not break login.

    def launch(self, source, on_message):
        import frida
        self.clean_host_cache()
        self.job = self.kernel.CreateJobObjectW(None, None)
        limits = JobLimits()
        limits.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.job or not self.kernel.SetInformationJobObject(self.job, 9, C.byref(limits), C.sizeof(limits)):
            raise C.WinError(C.get_last_error())
        desktop_name = "WechatAgent-" + uuid.uuid4().hex
        self.desktop = self.user.CreateDesktopW(desktop_name, None, None, 0, 0x10000000, None)
        if not self.desktop:
            raise C.WinError(C.get_last_error())
        env = {**os.environ, "TEMP": self.paths["Temp"], "TMP": self.paths["Temp"]}
        environment = C.create_unicode_buffer("\0".join(f"{k}={v}" for k, v in sorted(env.items(), key=lambda kv: kv[0].upper())) + "\0\0")
        startup = StartupInfo()
        startup.cb, startup.desktop, startup.flags, startup.show = C.sizeof(startup), desktop_name, 1, 0
        exe = self.engine / "WeChat.exe"
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(exe)]))
        if not self.kernel.CreateProcessW(str(exe), command, None, None, False, 0x404, environment,
                                          str(self.profile), C.byref(startup), C.byref(self.info)):
            raise C.WinError(C.get_last_error())
        if not self.kernel.AssignProcessToJobObject(self.job, self.info.process):
            self.kernel.TerminateProcess(W.HANDLE(self.info.process), 1)
            raise C.WinError(C.get_last_error())
        self.session = frida.attach(self.info.pid)
        self.script = self.session.create_script(source)
        self.script.on("message", on_message)
        self.script.load()
        self.isolation = self.script.exports_sync.isolate(str(self.profile))
        self.kernel.ResumeThread(self.info.thread)

    def alive(self):
        return bool(self.info.process) and self.kernel.WaitForSingleObject(self.info.process, 0) == 0x102

    def close(self):
        # This job owns only the process created above and its descendants.
        # Closing it also works when the parent worker is killed by its owner.
        if self.job:
            if not self.kernel.TerminateJobObject(self.job, 0):
                raise C.WinError(C.get_last_error())
            if self.info.process and self.kernel.WaitForSingleObject(self.info.process, 10000) != 0:
                raise RuntimeError("Native engine did not exit; session handoff refused")
            accounting = C.create_string_buffer(48)
            deadline = time.monotonic() + 10
            while True:
                if not self.kernel.QueryInformationJobObject(self.job, 1, accounting, 48, None):
                    raise C.WinError(C.get_last_error())
                if struct.unpack_from("<I", accounting.raw, 40)[0] == 0:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Native descendants did not exit; session handoff refused")
                time.sleep(0.02)
            self.kernel.CloseHandle(self.job)
            self.job = None
        if self.session:
            try:
                self.session.detach()
            except Exception:
                pass  # TerminateJobObject already disposed of the injected process.
            self.session = self.script = None
        for handle in (self.info.thread, self.info.process):
            if handle:
                self.kernel.CloseHandle(handle)
        self.info = ProcessInfo()
        if self.desktop:
            self.user.CloseDesktop(self.desktop)
            self.desktop = None
