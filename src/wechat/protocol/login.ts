import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BridgeError, object } from "@napcat-wechat/protocol";
import { ProtocolBackend } from "./backend.js";
import { workerEnvironment, resourcePath } from '../paths.js';

export class QrLoginManager {
  private child?: ChildProcess;
  private data: Record<string, unknown> = { state: "idle" };
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private accepting?: Promise<void>;
  constructor(
    readonly root: string,
    readonly backend: ProtocolBackend,
    private changed: () => void,
  ) {}
  status() {
    const status = this.backend.status(), online = status.online;
    const protocolState = (status.diagnostics as { state?: string })?.state;
    return {
      ...this.data,
      state:
        this.data.state === "session-ready"
          ? online ? "online" : protocolState === "reconnecting" || protocolState === "error" || protocolState === "stopped" ? "offline" : "connecting"
          : this.data.state === "idle" && online ? "online" : this.data.state,
      supported: true,
      running: !!this.child || !!this.starting || !!this.stopping || !!this.accepting,
      online,
      authentication: "managed-native-qrcode",
      restoreVerified: false,
    };
  }
  async start(replace = false) {
    if (this.child || this.starting || this.stopping || this.accepting)
      throw new BridgeError("ERR_LOGIN_BUSY", "已有扫码登录任务，请先取消");
    if (this.backend.session.value && !replace)
      throw new BridgeError(
        "ERR_SESSION_EXISTS",
        "已有会话，重新扫码替换需要明确确认",
      );
    this.data = { state: "requesting" };
    // The native login engine must never share a sync consumer with Node.
    this.starting = this.backend.disconnect();
    this.changed();
    try {
      await this.starting;
    } catch (error) {
      this.data = { state: "failed", error: "无法停止原会话同步，未启动登录组件" };
      this.changed();
      throw error;
    } finally {
      this.starting = undefined;
    }
    if (this.data.state === "cancelled") return this.status();
    const directory = path.join(this.root, "storage/private/qrcode", randomUUID());
    mkdirSync(directory, { recursive: true });
    const child = spawn(
      process.env.NAPCAT_PYTHON ||
        (existsSync(path.join(this.root, ".venv/Scripts/python.exe"))
          ? path.join(this.root, ".venv/Scripts/python.exe")
          : "python"),
      [
        resourcePath(this.root, "runtime/native_login_worker.py"),
        "--directory",
        directory,
        "--engine",
        resourcePath(this.root, "runtime/wechat39-engine"),
        "--profile",
        path.join(this.root, "storage/private/wechat39-engine"),
      ],
      {
        cwd: this.root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...workerEnvironment(this.root),
          PYTHONIOENCODING: "utf-8",
        },
      },
    );
    this.child = child;
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (this.child !== child || this.stopping) return;
      try {
        const event = object(JSON.parse(line));
        const state = String(event.state);
        if (
          ![
            "waiting",
            "scanned",
            "confirmed",
            "authenticating",
            "expired",
            "cancelled",
            "failed",
            "session-ready",
          ].includes(state)
        )
          return;
        this.data = {
          ...this.data,
          state,
          ...(event.error ? { error: event.error } : {}),
        };
        if (event.imageFile) {
          const image = path.resolve(String(event.imageFile));
          if (path.dirname(image) !== directory) throw new Error("Invalid QR image path");
          this.data = {
            ...this.data,
            image:
              "data:image/png;base64," + readFileSync(image).toString("base64"),
            expiresAt: event.expiresAt,
            scanBefore: event.scanBefore,
            pollInterval: event.pollInterval,
            refresh: event.refresh,
          };
        }
        if (state === "session-ready") {
          const file = path.resolve(String(event.sessionFile));
          if (path.dirname(file) !== directory) throw new Error("Invalid session path");
          if (this.accepting) return;
          // The worker exits only after its native client and job are closed.
          this.accepting = closed.then(code => {
            if (code !== 0) throw new Error("Native login cleanup failed");
            return this.accept(file);
          })
            .catch((error) => {
              this.data = {
                state: "failed",
                error:
                  "原生会话已捕获，但 Node 交接失败（" +
                  (error instanceof BridgeError ? error.code : "本地会话校验") +
                  "）。未自动重试登录。",
              };
            })
            .finally(() => {
              this.accepting = undefined;
              this.changed();
            });
        }
        this.changed();
      } catch {
        this.data = {
          state: "failed",
          error: "登录进程状态或本地文件无效，已中止登录任务",
        };
        void this.stopChild(child);
        this.changed();
      }
    });
    // Never forward arbitrary Python output to the browser or console.
    child.stderr!.resume();
    child.on("error", () => {
      if (this.child === child) {
        this.data = {
          state: "failed",
          error: "无法启动微信登录组件，请检查应用安装是否完整",
        };
        this.changed();
      }
    });
    child.stdin!.on("error", () => { /* The worker may already be exiting after cleanup. */ });
    child.on("close", (code) => {
      if (this.child === child) {
        this.child = undefined;
        if (!this.stopping && !this.accepting && !["expired", "cancelled", "failed"].includes(String(this.data.state)))
          this.data = {
            state: "failed",
            error: this.data.error || (code ? "登录组件退出，未继续认证" : "登录组件未返回有效会话"),
          };
        this.changed();
      }
    });
    this.changed();
    return this.status();
  }
  private async accept(file: string) {
    const c = object(JSON.parse(readFileSync(file, "utf8")));
    const session = this.backend.session;
    if (existsSync(session.file))
      copyFileSync(
        session.file,
        session.file + `.before-qr-${Date.now()}.json`,
      );
    await this.backend.importSession({
      uin: c.uin,
      token: c.token,
      wxid: c.wxid,
      nickname: c.nickname,
      host: c.host,
      port: c.port,
      ...(c.body_key === undefined && c.session_key === undefined ? {} : { body_key: c.body_key ?? c.session_key }),
      ...(c.s08 === undefined ? {} : { s08: c.s08 }),
      sync_key: c.sync_key,
      edges: c.edges ?? [],
      ...(c.contacts === undefined ? {} : { contacts: c.contacts }),
      ...(c.heartbeat_base_request === undefined ? {} : { heartbeat_base_request: c.heartbeat_base_request }),
    });
  }
  private stopChild(child: ChildProcess) {
    if (this.stopping) return this.stopping;
    this.stopping = new Promise<void>(resolve => {
      child.once("close", resolve);
      if (child.stdin?.writable) child.stdin.end(JSON.stringify({ command: "cancel" }) + "\n");
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  async cancel() {
    if (this.accepting)
      throw new BridgeError(
        "ERR_LOGIN_HANDOFF",
        "正在交接会话，请等待连接结果",
      );
    const child = this.child;
    this.data = { state: "cancelled" };
    this.changed();
    await this.starting;
    if (child) await this.stopChild(child);
  }
  async close() {
    if (this.accepting) await this.accepting;
    else await this.cancel();
  }
}
