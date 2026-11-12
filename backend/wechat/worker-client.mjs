import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { ChannelError } from "../../shared/contracts.mjs";
import { MOMENTS_PUBLISH_RPC_TIMEOUT_MS } from '../../shared/moments-publishing.mjs';

export class WorkerClient extends EventEmitter {
  constructor(root, resources, options = {}) {
    super();
    this.getPublishTimeoutMs = options.getPublishTimeoutMs ?? (() => MOMENTS_PUBLISH_RPC_TIMEOUT_MS);
    this.snapshot = { online: false, state: 'starting', account: null, login: { state: 'idle' }, runtimeReady: false };
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.child = spawn(options.executable || process.execPath, [path.join(resources, 'lib/worker.cjs'), root], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NAPCAT_RESOURCE_ROOT: resources,
        NAPCAT_PYTHON: path.join(resources, 'runtime/python/python.exe') }
    });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ChannelError('WORKER_START_FAILED', '微信组件启动超时，请重新启用插件')), 20000);
      this.child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready') { clearTimeout(timer); this.snapshot = message.status; resolve(); }
        else if (message.type === 'status') { this.snapshot = message.status; this.emit('status'); }
        else if (message.type === 'message') this.emit('message', message.message, message.accountId);
        else if (message.type === 'result') {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id); item.cleanup();
          if (message.ok) item.resolve(message.value);
          else item.reject(new ChannelError(message.error?.code || 'WORKER_FAILED', message.error?.message || '微信组件操作失败', message.error?.details || {}));
        }
      });
      const failed = () => {
        clearTimeout(timer);
        const error = new ChannelError('WORKER_OFFLINE', '微信组件已停止，请重新启用插件');
        this.snapshot = { ...this.snapshot, online: false, state: this.closed ? 'stopped' : 'error', login: { state: 'idle' }, error: this.closed ? undefined : error.message };
        reject(error);
        for (const item of this.pending.values()) { item.cleanup(); item.reject(new ChannelError(error.code, error.message, item.op === 'send' ? { delivery: 'unknown' } : {})); }
        this.pending.clear(); this.emit('status');
      };
      this.child.once('error', failed); this.child.once('close', failed);
    });
  }
  status() { return structuredClone(this.snapshot); }
  call(op, args = {}, { signal, timeoutMs = op === 'send' ? 0 : 20000 } = {}) {
    if (!this.child.connected || this.closed && op !== 'close') return Promise.reject(new ChannelError('WORKER_OFFLINE', '微信组件未运行'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => { if (this.child.connected) this.child.send({ type: 'cancel', id }, () => {}); };
      // Each protocol request still has a deadline. A complete multi-chunk
      // transfer waits for its result rather than imposing a fixed size budget.
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id); cleanup(); cancel();
        reject(new ChannelError('WORKER_TIMEOUT', op === 'send' ? '发送等待超时，结果不明，未自动重发' : '微信组件操作超时，请检查当前状态', op === 'send' ? { delivery: 'unknown' } : {}));
      }, timeoutMs) : undefined;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.pending.set(id, { resolve, reject, cleanup, op });
      signal?.addEventListener('abort', cancel, { once: true });
      this.child.send({ type: 'call', id, op, args }, error => {
        if (!error || !this.pending.delete(id)) return;
        cleanup(); reject(new ChannelError('WORKER_OFFLINE', '微信组件通信中断', op === 'send' ? { delivery: 'unknown' } : {}));
      });
    });
  }
  send(params, signal) { return this.call('send', params, { signal }); }
  media(params, signal) { return this.call('media', params, { signal, timeoutMs: 30000 }); }
  readStickers(params, signal) { return this.call('stickers.list', params, { signal, timeoutMs: 180000 }); }
  readStickerContent(params, signal) { return this.call('stickers.content', params, { signal, timeoutMs: 30000 }); }
  recentStickers(params, signal) { return this.call('stickers.recent', params, { signal, timeoutMs: 30000 }); }
  favoriteSticker(params, signal) { return this.call('stickers.favorite', params, { signal, timeoutMs: 180000 }); }
  files(params, signal) { return this.call('files', params, { signal, timeoutMs: 300000 }); }
  readMoments(params, signal) { return this.call('moments.read', params, { signal, timeoutMs: 20000 }); }
  readMomentsPublication(params, signal) { return this.call('moments.publication', params, { signal, timeoutMs: 20000 }); }
  readMomentsImages(params, signal) { return this.call('moments.images', params, { signal, timeoutMs: 190000 }); }
  readMomentsAudience(params, signal) { return this.call('moments.audience', params, { signal, timeoutMs: 300000 }); }
  writeMoments(params, signal) { return this.call('moments.write', params, { signal, timeoutMs: params?.query?.action === 'publish' ? this.getPublishTimeoutMs() : 600000 }); }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      if (this.child.connected) {
        try { await this.call('close', {}, { timeoutMs: 45000 }); }
        catch { /* A dead worker cannot acknowledge close; reap only our child. */ }
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        // Give a successfully closed child its normal IPC exit first.
        let timer;
        await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
        clearTimeout(timer);
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
      }
      await this.exited;
    })();
    return this.closing;
  }
}
