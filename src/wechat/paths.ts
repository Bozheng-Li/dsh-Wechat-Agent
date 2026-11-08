import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { BridgeError } from "@napcat-wechat/protocol";

/** The launcher supplies its own location, never process.cwd(). */
export function projectPaths(root: string) {
  const storage = path.resolve(root, "storage");
  const names = [
    "state",
    "private",
    "media",
    "logs",
    "cache",
    "tmp",
    "exports",
    "backups",
  ] as const;
  const dirs = Object.fromEntries(
    names.map((n) => [n, path.join(storage, n)]),
  ) as Record<(typeof names)[number], string>;
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return { root: path.resolve(root), storage, ...dirs };
}
export function workerEnvironment(root: string) {
  const p = projectPaths(root);
  return {
    ...process.env,
    TEMP: p.tmp,
    TMP: p.tmp,
    TMPDIR: p.tmp,
    PYTHONPYCACHEPREFIX: path.join(p.cache, "python"),
    PIP_CACHE_DIR: path.join(p.cache, "pip"),
    PYTHONIOENCODING: "utf-8",
  };
}
export function pythonExecutable(root: string) {
  return (
    process.env.NAPCAT_PYTHON ||
    (existsSync(path.join(root, ".venv/Scripts/python.exe"))
      ? path.join(root, ".venv/Scripts/python.exe")
      : "python")
  );
}
export function resourcePath(root: string, file: string) { return path.join(process.env.NAPCAT_RESOURCE_ROOT || root, file); }

/** Windows ignores POSIX mode 0600. Protect only this product's sensitive data. */
export function protectStorage(root: string) {
  if (process.platform !== "win32") return;
  const p = projectPaths(root),
    marker = path.join(p.state, "private-acl-v1.json");
  const names = ["storage", ".cache", "config/ai.json"];
  if (existsSync(marker)) {
    const applied = JSON.parse(readFileSync(marker, "utf8")).protectedPaths;
    if (
      Array.isArray(applied) &&
      names
        .filter((n) => existsSync(path.join(root, n)))
        .every((n) => applied.includes(n))
    )
      return;
  }
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const identity = execFileSync(path.join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const sid = identity.match(/S-\d-(?:\d+-)+\d+/)?.[0];
  if (!sid)
    throw new BridgeError(
      "ERR_STORAGE_ACL",
      "不能确定当前 Windows 用户，未扩大私密目录权限",
    );
  const protectedPaths: string[] = [];
  for (const name of names) {
    const target = path.resolve(root, name);
    if (!existsSync(target)) continue;
    const rel = path.relative(p.root, realpathSync(target));
    if (
      !rel ||
      rel.startsWith("..") ||
      path.isAbsolute(rel) ||
      lstatSync(target).isSymbolicLink()
    )
      throw new BridgeError(
        "ERR_STORAGE_ACL_PATH",
        "敏感目录不是项目内的普通路径，未更改权限",
      );
    const flags = lstatSync(target).isDirectory() ? "(OI)(CI)F" : "F";
    execFileSync(
      path.join(system32, "icacls.exe"),
      [
        target,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:${flags}`,
        `*S-1-5-18:${flags}`,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    protectedPaths.push(name);
  }
  writeFileSync(
    marker,
    JSON.stringify({
      at: Date.now(),
      policy:
        "current Windows user and SYSTEM; no client or system directories modified",
      protectedPaths,
    }),
    { mode: 0o600 },
  );
}
