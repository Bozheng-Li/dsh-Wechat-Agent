import { createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { BridgeError } from '@napcat-wechat/protocol';
import type { Credential } from "./session.js";
import { decodeFrame, encodeFrame, MAGIC, MAX_FRAME, RESPONSE, WIRE } from "./wire.js";

interface Pending { cmd: number; resolve: (body: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; at: number }
export class LonglinkTransport {
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private sequence = randomBytes(4).readUInt32BE() & 0x7fffffff;
  tx = 0; rx = 0; latencyMs: number | null = null; connectedAt?: number; lastRxAt?: number;
  get connected() { return !!this.socket && !this.socket.destroyed && !this.socket.connecting; }
  constructor(private credential: Credential, private timeoutMs: number, private notify: () => void) {}
  private frameMaterial(): { key?: Buffer; s08?: Buffer } {
    if (!this.credential.body_key && !this.credential.s08) return {};
    if (!this.credential.body_key || !this.credential.s08)
      throw new BridgeError('ERR_CREDENTIAL', 'QR session requires both body_key and s08');
    return {
      key: Buffer.from(this.credential.body_key, 'hex'),
      s08: Buffer.from(this.credential.s08, 'hex'),
    };
  }
  async connect(host: string, port = this.credential.port) {
    this.close(); this.buffer = Buffer.alloc(0);
    const socket = createConnection({ host, port }); this.socket = socket;
    socket.setNoDelay(true); socket.setKeepAlive(true, 30000);
    socket.on('error', () => {});
    socket.on('close', () => { if (this.socket === socket) this.failPending(new BridgeError('ERR_CONNECTION_CLOSED', 'Longlink closed; unacknowledged sends have unknown delivery and are not retried')); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new BridgeError('ERR_CONNECT_TIMEOUT', 'Protocol edge connection timed out')); }, this.timeoutMs);
      const error = () => { clearTimeout(timer); reject(new BridgeError('ERR_CONNECT', 'Protocol edge connection failed')); };
      socket.once('error', error);
      socket.once('close', error);
      socket.once('connect', () => { clearTimeout(timer); socket.off('error', error); socket.off('close', error); resolve(); });
    });
    this.connectedAt = Date.now();
    socket.on('data', chunk => {
      try { this.receive(chunk); }
      catch (error) { this.failPending(error instanceof Error ? error : new Error('Invalid longlink data')); socket.destroy(); }
    });
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE();
      if (length < 16 || length > MAX_FRAME) throw new BridgeError('ERR_PROTOCOL', 'Invalid TCP frame length');
      if (this.buffer.length < length) return;
      const frame = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length);
      if (frame.readUInt32BE(4) !== MAGIC) throw new BridgeError('ERR_PROTOCOL', 'Invalid TCP frame magic');
      this.rx++; this.lastRxAt = Date.now();
      const seq = frame.readUInt32BE(12), pending = this.pending.get(seq);
      if (!pending || frame.readUInt32BE(8) !== (RESPONSE | WIRE[pending.cmd])) { this.notify(); continue; }
      clearTimeout(pending.timer); this.pending.delete(seq);
      try {
        const material = this.frameMaterial();
        const decoded = decodeFrame(frame, material.key, material.s08);
        if (decoded.uin !== this.credential.uin || decoded.innerCmd !== pending.cmd) throw new BridgeError('ERR_PROTOCOL', 'Longlink response account/command mismatch');
        this.latencyMs = Date.now() - pending.at; pending.resolve(decoded.body);
      } catch (error) { pending.reject(error instanceof Error ? error : new Error('Invalid response')); throw error; }
    }
  }
  request(cmd: number, body: Buffer): Promise<Buffer> {
    if (!this.connected) return Promise.reject(new BridgeError('ERR_BACKEND_OFFLINE', 'Longlink is not connected'));
    const seq = this.sequence = (this.sequence + 1) >>> 0;
    const material = this.frameMaterial();
    const frame = encodeFrame(cmd, body, this.credential.uin, this.credential.token, seq, material.key, material.s08);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new BridgeError('ERR_ACK_TIMEOUT', 'No protocol ACK; delivery is unknown. This request is not retried.', { delivery: 'unknown', cmd }));
        this.close();
      }, this.timeoutMs);
      this.pending.set(seq, { cmd, resolve, reject, timer, at: Date.now() }); this.tx++;
      this.socket!.write(frame, error => { if (error) this.close(); });
    });
  }
  private failPending(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  close() {
    this.socket?.destroy(); this.socket = undefined;
    this.failPending(new BridgeError('ERR_CONNECTION_CLOSED', 'Protocol connection closed; no automatic send replay', { delivery: 'unknown' }));
  }
}
