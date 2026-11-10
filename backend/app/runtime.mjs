import { StateStore } from "../storage/state-store.mjs";
import { acquireLock } from "../storage/locks.mjs";
import { WorkerClient } from "../wechat/worker-client.mjs";
import { DshAgentRunner } from "../../modules/agent/runner.mjs";
import { WechatChannel } from "../../modules/conversation/channel.mjs";
import { TaskScheduler } from "../../modules/tasks/scheduler.mjs";
import { AgentIdentity } from "../../modules/agent/identity.mjs";
import { protectStorage } from "../wechat/paths.ts";
import { sameDirectory } from "../storage/paths.mjs";
import { prepareAgentWorkspace, registerAgentWorkspace } from '../../modules/agent/workspace.mjs';

/** A complete set of root-bound services; no object is retargeted in place. */
export class WechatRuntime {
  constructor({ ctx, root, bootstrap, resources, ownerLock, signal }) {
    Object.assign(this, { ctx, root, ownerLock, signal });
    try {
      if (!sameDirectory(root, bootstrap)) this.lock = acquireLock(root);
      protectStorage(root);
      this.store = new StateStore(root);
      this.store.ensureWorkspace();
      this.identity = new AgentIdentity(root, { config: this.store.config });
      this.runner = new DshAgentRunner(
        ctx,
        () => this.store.modelChoice(),
        () => ({
          persona: this.store.persona(),
          modelConfig: this.store.modelConfig(),
          workspacePath: prepareAgentWorkspace(this.store.ensureWorkspace()),
          identityMarkdown: this.identity.view().markdown,
        })
      );
      this.worker = new WorkerClient(root, resources);
      ownerLock.worker(this.worker.child.pid);
      this.lock?.worker(this.worker.child.pid);
      this.channel = new WechatChannel({ store: this.store, runner: this.runner, transport: this.worker });
      this.scheduler = new TaskScheduler({ store: this.store, channel: this.channel });
      this.channel.scheduler = this.scheduler;
      this.scheduler.stopped = true;
      this.worker.on('message', (message, accountId) => this.channel.receive(message, accountId));
      let wasOnline = false;
      this.worker.on('status', () => {
        const online = this.worker.status().online;
        if (!signal.aborted && !this.channel.closed && wasOnline && !online) {
          try {
            this.channel.natural.disconnected();
            this.channel.cancel('微信连接已断开，未继续回复', undefined, { resetNatural: false });
          } catch (error) {
            this.channel.fail(error);
          }
        }
        wasOnline = online;
        if (online && !signal.aborted) this.channel.checkMemoryPressure();
      });
    } catch (error) {
      this.initializationError = error;
      this.worker?.ready.catch(() => {});
    }
  }
  async ready() {
    if (this.initializationError) throw this.initializationError;
    await this.worker.ready;
    this.signal.throwIfAborted();
    await registerAgentWorkspace(this.ctx, prepareAgentWorkspace(this.store.ensureWorkspace()));
    await registerAgentWorkspace(this.ctx, this.store.ensureWorkspace(), 'work');
    await this.channel.work.prepareProjects(this.signal);
    this.signal.throwIfAborted();
    await this.runner.search.refreshCredentials();
    await this.channel.work.imageGeneration.refreshCredential();
    this.signal.throwIfAborted();
    return this;
  }
  async activate() {
    this.signal.throwIfAborted();
    try {
      if (this.store.data.connectionWanted) await this.worker.call('connect');
      this.signal.throwIfAborted();
      this.scheduler.start();
      this.channel.momentsAutomation.start();
      this.channel.natural.start();
    } catch (error) {
      this.scheduler.stopped = true;
      this.scheduler.error = '目录已载入，但连接尚未恢复，请检查微信连接或重新启用插件';
      throw error;
    }
  }
  stop() {
    return (this.closing ??= (async () => {
      try {
        const scheduler = this.scheduler?.close();
        await this.channel?.close();
        await scheduler;
      } finally {
        try {
          this.channel?.library?.close();
        } finally {
          await this.worker?.close();
        }
      }
    })());
  }
  releaseLock() {
    this.lock?.release();
    this.lock = undefined;
  }
  close() {
    return this.stop().finally(() => this.releaseLock());
  }
}
