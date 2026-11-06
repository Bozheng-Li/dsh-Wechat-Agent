import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { protectStorage } from './wechat/paths.ts';
import { CHANNEL, VERSION, ChannelError, emptySettings, publicError } from './contracts.mjs';
import { acquireLock, StateStore } from './state.mjs';
import { WorkerClient } from './worker-client.mjs';
import { DshAgentRunner } from './agent.mjs';
import { WechatChannel } from './channel.mjs';
import { selectModel } from './models.mjs';

export const inject = ['connection', 'webServer', 'agents', 'agentDefaultModel', 'llm', 'tools', 'systemPrompt'];

export function rpcHandler(service, isDisposed = () => false) {
  return async (endpoint, payload, signal, peer) => {
    try {
      if (peer?.principal?.kind !== 'owner') throw new ChannelError('OWNER_REQUIRED', '只有 DSH 本机所有者可以管理微信插件');
      if (isDisposed()) throw new ChannelError('PLUGIN_STOPPING', '微信插件正在停止，请稍后重试');
      signal?.throwIfAborted();
      if (!['status', 'settings', 'model.select', 'contacts', 'connect', 'disconnect', 'login.start', 'login.cancel', 'cancel'].includes(endpoint))
        throw new ChannelError('UNKNOWN_OPERATION', '不支持的微信插件操作');
      return { ok: true, value: await service.call(endpoint, payload ?? {}, signal) };
    } catch (error) { return { ok: false, error: publicError(error) }; }
  };
}

export async function apply(ctx) {
  const configuredHome = process.env.DSH_HOME?.trim();
  const dshHome = configuredHome?.startsWith('~/') || configuredHome?.startsWith('~\\') ? path.join(homedir(), configuredHome.slice(2)) : configuredHome || path.join(homedir(), '.dsh');
  const root = path.resolve(dshHome, 'wechat-agent');
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let lock, store, worker, runner, channel, startupError, disposed = false, closing;
  let mutations = Promise.resolve();
  const lifetime = new AbortController();
  const close = () => closing ??= (async () => {
    disposed = true;
    lifetime.abort();
    try { await channel?.close(); }
    finally { try { await mutations; await worker?.close(); } finally { lock?.release(); } }
  })();
  // Cordis runs sibling disposers concurrently. This one owns the complete
  // drain -> child exit -> exclusive-lock release sequence.
  ctx.effect(() => close, 'wechat-agent shutdown');
  try {
    lock = acquireLock(root);
    protectStorage(root);
    store = new StateStore(root);
    runner = new DshAgentRunner(ctx, () => store.modelChoice());
    worker = new WorkerClient(root, resources);
    lock.worker(worker.child.pid);
    channel = new WechatChannel({ store, runner, transport: worker });
    worker.on('message', (message, accountId) => channel.receive(message, accountId));
    worker.on('status', () => { if (!worker.status().online) { try { channel.cancel('微信连接已断开，未继续回复'); } catch (error) { channel.fail(error); } } });
    await worker.ready;
    if (disposed) return;
    if (store.data.connectionWanted) await worker.call('connect');
  } catch (error) {
    startupError = publicError(error, '微信插件启动失败，请检查安装包或重新启用插件');
    try { await worker?.close(); } finally { lock?.release(); lock = undefined; }
  }
  const status = () => {
    const state = worker?.status() ?? { online: false, state: 'error', account: null, login: { state: 'idle' }, runtimeReady: false };
    let model, defaultModel;
    try { const selected = runner.selection(); model = { provider: selected.provider, model: selected.model }; } catch { model = null; }
    try { const selected = runner.defaultSelection(); defaultModel = { provider: selected.provider, model: selected.model }; } catch { defaultModel = null; }
    return { version: VERSION, ...state, model, defaultModel, modelChoice: store?.modelChoice() ?? null, startupError,
      settings: state.account ? store.settings(state.account.id) : emptySettings(),
      records: state.account ? store.records(state.account.id) : [],
      processing: channel?.summary() ?? { queued: 0, active: null, fault: null } };
  };
  const mutate = async (endpoint, payload, signal) => {
    if (disposed) throw new ChannelError('PLUGIN_STOPPING', '微信插件正在停止');
    if (startupError) throw new ChannelError(startupError.code, startupError.message);
    switch (endpoint) {
      case 'model.select':
        await selectModel(ctx, store, payload.selection, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]));
        break;
      case 'settings': {
        const account = worker.status().account;
        if (!account || payload.accountId !== account.id) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，请刷新后重新保存该账号的授权');
        const previous = JSON.stringify(store.settings(account.id));
        const next = store.configure(account.id, payload.settings);
        if (JSON.stringify(next) !== previous) channel.cancel('授权或回复要求已变更，旧任务已取消');
        break;
      }
      case 'connect':
        store.data.connectionWanted = true; store.save(); await worker.call('connect'); break;
      case 'disconnect':
        store.data.connectionWanted = false; store.save(); channel.cancel('微信已断开，任务已取消');
        await channel.whenIdle(); await worker.call('disconnect'); break;
      case 'login.start':
        channel.cancel('正在重新登录，旧账号任务已取消'); await channel.whenIdle();
        await worker.call('login.start', { replace: payload.replace === true });
        store.data.connectionWanted = true; store.save(); break;
      case 'login.cancel': await worker.call('login.cancel'); break;
      case 'cancel': channel.cancel('已取消当前任务和排队消息'); await channel.whenIdle(); break;
    }
    return status();
  };
  const service = { call(endpoint, payload, signal) {
    if (endpoint === 'status') return status();
    if (startupError) throw new ChannelError(startupError.code, startupError.message);
    if (endpoint === 'contacts') return worker.call('contacts');
    const pending = mutations.then(() => mutate(endpoint, payload, signal));
    mutations = pending.catch(() => {}); return pending;
  } };
  // rc.5's rpc getter retains the Connection service's dependency shadow;
  // register with our explicit owner so webServer and teardown belong here.
  if (!disposed) ctx.connection.register(ctx, CHANNEL, rpcHandler(service, () => disposed));
}
