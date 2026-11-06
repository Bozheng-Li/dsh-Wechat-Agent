import { StateStore, acquireLock } from './state.mjs';
import { WorkerClient } from './worker-client.mjs';
import { DshAgentRunner } from './agent.mjs';
import { WechatChannel } from './channel.mjs';
import { TaskScheduler } from './scheduler.mjs';
import { AgentIdentity } from './agent-identity.mjs';
import { protectStorage } from './wechat/paths.ts';
import { sameDirectory } from './storage-paths.mjs';

/** A complete set of root-bound services; no object is retargeted in place. */
export class WechatRuntime {
  constructor({ ctx, root, bootstrap, resources, ownerLock, signal }) {
    Object.assign(this, { root, ownerLock, signal });
    try {
      if (!sameDirectory(root, bootstrap)) this.lock = acquireLock(root);
      protectStorage(root);
      this.store = new StateStore(root); this.store.ensureWorkspace();
      this.identity = new AgentIdentity(root);
      this.runner = new DshAgentRunner(ctx, () => this.store.modelChoice(), () => ({ persona: this.store.persona(),
        modelConfig: this.store.modelConfig(), workspacePath: this.store.storageSettings().workspacePath, identityMarkdown: this.identity.view().markdown }));
      this.worker = new WorkerClient(root, resources);
      ownerLock.worker(this.worker.child.pid); this.lock?.worker(this.worker.child.pid);
      this.channel = new WechatChannel({ store: this.store, runner: this.runner, transport: this.worker });
      this.scheduler = new TaskScheduler({ store: this.store, channel: this.channel }); this.channel.scheduler = this.scheduler;
      this.scheduler.stopped = true;
      this.worker.on('message', (message, accountId) => this.channel.receive(message, accountId));
      let wasOnline = false;
      this.worker.on('status', () => {
        const online = this.worker.status().online;
        if (!signal.aborted && !this.channel.closed && wasOnline && !online) {
          try { this.channel.cancel('微信连接已断开，未继续回复'); } catch (error) { this.channel.fail(error); }
        }
        wasOnline = online;
      });
    } catch (error) { this.initializationError = error; this.worker?.ready.catch(() => {}); }
  }
  async ready() {
    if (this.initializationError) throw this.initializationError;
    await this.worker.ready; this.signal.throwIfAborted();
    await this.runner.search.refreshCredentials(); this.signal.throwIfAborted(); return this;
  }
  async activate() {
    this.signal.throwIfAborted();
    try {
      if (this.store.data.connectionWanted) await this.worker.call('connect');
      this.signal.throwIfAborted(); this.scheduler.start();
    } catch (error) { this.scheduler.stopped = true; this.scheduler.error = '目录已载入，但连接尚未恢复，请检查微信连接或重新启用插件'; throw error; }
  }
  stop() {
    return this.closing ??= (async () => {
      try {
        const scheduler = this.scheduler?.close();
        await this.channel?.close(); await scheduler;
      } finally {
        try { this.channel?.library?.close(); } finally { await this.worker?.close(); }
      }
    })();
  }
  releaseLock() { this.lock?.release(); this.lock = undefined; }
  close() { return this.stop().finally(() => this.releaseLock()); }
}
