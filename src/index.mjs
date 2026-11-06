import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { protectStorage } from './wechat/paths.ts';
import { CHANNEL, VERSION, ChannelError, emptySettings, emptyPersona, publicError, validateSettings, validatePersona, validateModelConfig, validateConversationSettings } from './contracts.mjs';
import { acquireLock, StateStore } from './state.mjs';
import { WorkerClient } from './worker-client.mjs';
import { DshAgentRunner } from './agent.mjs';
import { WechatChannel } from './channel.mjs';
import { selectModel, availableModel } from './models.mjs';
import { absoluteDirectory, sameDirectory } from './storage-paths.mjs';
import { TaskScheduler } from './scheduler.mjs';
import { AgentIdentity } from './agent-identity.mjs';
import { WechatRuntime } from './runtime.mjs';
import { readWorkspaceLocation, describeWorkspace, migrateWorkspaceRoot } from './workspace-root.mjs';

export const inject = ['connection', 'webServer', 'agents', 'agentDefaultModel', 'llm', 'tools', 'systemPrompt', 'sessionPersistence', 'attachments', 'web', 'credentials'];

export function rpcHandler(service, isDisposed = () => false) {
  return async (endpoint, payload, signal, peer) => {
    try {
      if (peer?.principal?.kind !== 'owner') throw new ChannelError('OWNER_REQUIRED', '只有 DSH 本机所有者可以管理微信插件');
      if (isDisposed()) throw new ChannelError('PLUGIN_STOPPING', '微信插件正在停止，请稍后重试');
      signal?.throwIfAborted();
      if (!['status', 'changelog', 'identity.get', 'identity.save', 'settings', 'model.select', 'model.configure', 'search.credentials', 'persona.save', 'storage.save', 'conversation.configure', 'records.list', 'contacts', 'members', 'connect', 'disconnect', 'login.start', 'login.cancel', 'cancel',
        'memory.list', 'memory.get', 'memory.configure', 'memory.edit', 'memory.clear', 'memory.compress', 'memory.retryImages',
        'memory.global.get', 'memory.global.edit', 'memory.global.clear', 'memory.global.extract',
        'assets.list', 'assets.content', 'assets.import', 'assets.edit', 'assets.delete', 'assets.configure', 'assets.describe',
        'assets.upload.start', 'assets.upload.chunk', 'assets.upload.finish', 'assets.upload.abort',
        'assets.packs.configure', 'assets.packs.content',
        'tasks.list', 'tasks.create', 'tasks.cancel', 'tasks.pause', 'tasks.resume'].includes(endpoint))
        throw new ChannelError('UNKNOWN_OPERATION', '不支持的微信插件操作');
      return { ok: true, value: await service.call(endpoint, payload ?? {}, signal) };
    } catch (error) { return { ok: false, error: publicError(error) }; }
  };
}

export function createPluginService({ ctx, root, store, worker, runner, channel, scheduler = channel?.scheduler, identity, relocateWorkspace, startupError, isDisposed = () => false, lifetime = new AbortController().signal, dshSessionPath = null }) {
  let mutations = Promise.resolve();
  let discovered;
  let relocating = false;
  identity ??= store ? new AgentIdentity(root) : undefined;
  const assertLive = signal => {
    if (isDisposed() || lifetime.aborted) throw new ChannelError('PLUGIN_STOPPING', '微信插件正在停止');
    signal?.throwIfAborted();
  };
  const currentAccount = payload => {
    const account = worker?.status().account;
    if (!account || payload.accountId !== account.id) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，请刷新后再查看或保存该账号的会话');
    return account;
  };
  const conversation = payload => {
    currentAccount(payload);
    if (!['private', 'group'].includes(payload.chatType) || typeof payload.peerId !== 'string' || !payload.peerId || payload.peerId.length > 150 || /\s/.test(payload.peerId) || payload.peerId.endsWith('@chatroom') !== (payload.chatType === 'group'))
      throw new ChannelError('INVALID_PEERS', '会话类型或 ID 不正确，请重新选择会话');
    return { accountId: payload.accountId, chatType: payload.chatType, peerId: payload.peerId };
  };
  const status = () => {
    const state = worker?.status() ?? { online: false, state: 'error', account: null, login: { state: 'idle' }, runtimeReady: false };
    let model = null, defaultModel = null;
    try { const selected = runner.selection(); model = { provider: selected.provider, model: selected.model }; } catch {}
    try { const selected = runner.defaultSelection(); defaultModel = { provider: selected.provider, model: selected.model }; } catch {}
    return { version: VERSION, ...state, model, defaultModel, modelChoice: store?.modelChoice() ?? null, startupError,
      persona: store?.persona() ?? emptyPersona(), modelConfig: store?.modelConfig() ?? { maxTokens: 4096, temperature: null },
      capabilities: { vision: !!ctx?.attachments?.admitPromptContent, webSearch: !!ctx?.web?.search },
      lastSearch: runner?.searchStatus?.() ?? null,
      search: runner?.search?.status?.() ?? { credentialStore: false, credentials: { dsh: false, tavily: false } },
      memory: { windowChars: channel?.memory?.index.windowChars ?? 32000, path: channel?.memory?.root || null },
      scheduler: { enabled: !!scheduler && !scheduler.stopped, error: scheduler?.error || null },
      storage: { ...describeWorkspace(root, store), identityPath: identity?.file || null, dshSessionPath, observedMessageLimit: 1000, relocating },
      settings: state.account && store ? store.settings(state.account.id) : emptySettings(),
      conversations: state.account && store ? store.conversations(state.account.id).map(peer => ({ ...peer,
        processing: channel?.summary(peer) ?? { queued: 0, active: null, fault: null } })) : [], records: [],
      processing: channel?.summary() ?? { queued: 0, active: null, fault: null } };
  };
  const paused = async (reason, action, selector, { resetProgress = true } = {}) => {
    const selectors = Array.isArray(selector) ? selector : [selector];
    const resumes = selectors.map(target => channel.pause(reason, target));
    try {
      for (const target of selectors) channel.cancel(reason, target, { resetProgress });
      for (const target of selectors) await channel.whenIdle(target);
      assertLive(); return await action();
    } finally { for (const resume of resumes.reverse()) resume(); }
  };
  const mutate = async (endpoint, payload, signal) => {
    assertLive(signal);
    if (startupError) throw new ChannelError(startupError.code, startupError.message);
    switch (endpoint) {
      case 'search.credentials': {
        if (!runner?.search) throw new ChannelError('WEB_SEARCH_CREDENTIAL_STORE_MISSING', '搜索组件尚未就绪，密钥未保存。');
        await runner.search.configureCredential(payload.provider, payload.apiKey, AbortSignal.any([lifetime, ...(signal ? [signal] : [])]));
        break;
      }
      case 'identity.save': {
        const current = identity.validateEdit(payload.markdown, payload.revision);
        if (current.markdown !== payload.markdown) await paused('正在应用全局身份，旧任务已取消', () => { signal?.throwIfAborted(); identity.edit(payload.markdown, payload.revision); });
        break;
      }
      case 'model.select':
        await selectModel(ctx, store, payload.selection, AbortSignal.any([lifetime, ...(signal ? [signal] : [])])); break;
      case 'model.configure': {
        const config = validateModelConfig(payload.modelConfig);
        if (config.vision && config.visionModel) await availableModel(ctx, config.visionModel, AbortSignal.any([lifetime, ...(signal ? [signal] : [])]));
        assertLive(signal); store.setModelConfig(config); break;
      }
      case 'memory.configure': channel.memory.setWindowChars(payload.windowChars); break;
      case 'memory.global.edit': {
        const account = currentAccount(payload); channel.longMemory.edit(account.id, payload.markdown, payload.revision); break;
      }
      case 'memory.global.clear': {
        const account = currentAccount(payload);
        await paused('正在清空长期记忆', () => { currentAccount(payload); channel.longMemory.clear(account.id); }, { accountId: account.id }); break;
      }
      case 'memory.global.extract': {
        const account = currentAccount(payload), combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        const selectors = payload.peerId ? [conversation(payload)] : store.conversations(account.id).filter(peer => peer.authorized);
        for (const selector of selectors) {
          currentAccount(payload); combined.throwIfAborted();
          await channel.memory.enrich(selector, runner, worker, combined);
          channel.longMemory.capture(selector, channel.memory.load(selector));
          await channel.longMemory.extract(selector, runner, combined);
        }
        break;
      }
      case 'assets.import': {
        const account = currentAccount(payload); return channel.library.import(account.id, payload);
      }
      case 'assets.configure': {
        const account = currentAccount(payload);
        if (payload.settings?.enabled === false) return paused('正在停用图片回复', () => { currentAccount(payload); return channel.library.configure(account.id, payload.settings); }, { accountId: account.id, mediaOnly: true }, { resetProgress: false });
        return channel.library.configure(account.id, payload.settings);
      }
      case 'assets.packs.configure': {
        const account = currentAccount(payload), pack = channel.library.validatePackSetting(account.id, payload.packId, payload.enabled);
        const apply = () => { currentAccount(payload); assertLive(signal); return channel.library.configurePack(account.id, pack.id, payload.enabled); };
        if (!payload.enabled) return paused('正在停用素材分组', apply, { accountId: account.id, assetIds: pack.assetIds }, { resetProgress: false });
        return apply();
      }
      case 'assets.edit': {
        const account = currentAccount(payload);
        if (payload.patch?.enabled === false) {
          channel.library.resolveAsset(account.id, payload.assetId, { enabledOnly: false });
          return paused('正在停用这张素材', () => { currentAccount(payload); return channel.library.edit(account.id, payload.assetId, payload.patch); }, { accountId: account.id, assetIds: [payload.assetId] }, { resetProgress: false });
        }
        return channel.library.edit(account.id, payload.assetId, payload.patch);
      }
      case 'assets.delete': {
        const account = currentAccount(payload);
        if (!Array.isArray(payload.assetIds) || !payload.assetIds.length) throw new ChannelError('INVALID_ASSETS', '请选择要删除的素材');
        for (const id of payload.assetIds) channel.library.resolveAsset(account.id, id, { enabledOnly: false });
        return paused('正在删除这张素材', () => { currentAccount(payload); return channel.library.remove(account.id, payload.assetIds); }, { accountId: account.id, assetIds: payload.assetIds }, { resetProgress: false });
      }
      case 'assets.describe': {
        const account = currentAccount(payload);
        if (!store.modelConfig().vision) throw new ChannelError('VISION_DISABLED', '请先在模型高级设置中开启图像理解');
        return channel.library.describe(account.id, payload.assetIds, runner, AbortSignal.any([lifetime, ...(signal ? [signal] : [])]));
      }
      case 'assets.upload.start': { const account = currentAccount(payload); return channel.library.beginUpload(account.id, payload); }
      case 'assets.upload.chunk': { const account = currentAccount(payload); return channel.library.appendUpload(account.id, payload.uploadId, payload); }
      case 'assets.upload.finish': { const account = currentAccount(payload); return channel.library.finishUpload(account.id, payload.uploadId); }
      case 'assets.upload.abort': { const account = currentAccount(payload); return channel.library.abortUpload(account.id, payload.uploadId); }
      case 'memory.edit': {
        const selector = conversation(payload);
        channel.memory.edit(selector, payload.summary, payload.revision); break;
      }
      case 'memory.clear':
      case 'memory.retryImages':
      case 'memory.compress': {
        const selector = conversation(payload);
        await paused(endpoint === 'memory.clear' ? '正在清空此会话记忆' : endpoint === 'memory.retryImages' ? '正在重新获取清晰图片并理解' : '正在压缩此会话记忆', async () => {
          currentAccount(payload);
          if (endpoint === 'memory.clear') { channel.memory.clear(selector); store.resetSessions(selector); }
          else {
            const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
            await channel.memory.enrich(selector, runner, worker, combined, { retryFailed: endpoint === 'memory.retryImages' });
            if (endpoint === 'memory.compress') {
              channel.longMemory.capture(selector, channel.memory.load(selector));
              await channel.memory.compact(selector, runner, combined);
            }
          }
        }, selector);
        break;
      }
      case 'tasks.create': {
        const selector = conversation(payload);
        if (!scheduler) throw new ChannelError('TASKS_UNAVAILABLE', '定时任务组件尚未启动');
        if (payload.requestId !== undefined && (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.requestId))) throw new ChannelError('INVALID_TASK', '任务请求标识无效，请重新打开任务表单');
        const scope = { ...selector, source: 'owner', senderId: selector.accountId, senderName: '管理员', requestKey: payload.requestId ? 'owner:' + selector.accountId + ':' + payload.requestId : undefined };
        const targets = await scheduler.resolveTargets(payload.task?.targets || [], scope, signal);
        assertLive(signal); currentAccount(payload);
        scheduler.create({ ...payload.task, targets }, scope); break;
      }
      case 'tasks.cancel':
      case 'tasks.pause':
      case 'tasks.resume': {
        const account = currentAccount(payload);
        if (!scheduler) throw new ChannelError('TASKS_UNAVAILABLE', '定时任务组件尚未启动');
        const scope = { accountId: account.id };
        if (endpoint === 'tasks.cancel') scheduler.cancel(payload.taskId, scope, true);
        else if (endpoint === 'tasks.pause') scheduler.pause(payload.taskId, scope);
        else scheduler.resume(payload.taskId, scope);
        break;
      }
      case 'persona.save': {
        const persona = validatePersona(payload.persona);
        if (JSON.stringify(persona) !== JSON.stringify(store.persona())) await paused('正在应用人设，旧任务已取消', () => {
          signal?.throwIfAborted(); store.resetSessions(); store.setPersona(persona);
        });
        break;
      }
      case 'storage.save': {
        if (payload.storage && Object.hasOwn(payload.storage, 'basePath')) {
          if (Object.keys(payload.storage).some(key => key !== 'basePath')) throw new ChannelError('INVALID_STORAGE_PATH', '只需指定全局工作目录，其他路径由它自动生成');
          const target = absoluteDirectory(payload.storage.basePath, '全局工作目录');
          if (!relocateWorkspace) throw new ChannelError('WORKSPACE_UNAVAILABLE', '当前实例暂不支持完整目录迁移，请重新启用插件');
          relocating = true;
          try { await relocateWorkspace(target, signal); discovered = undefined; } finally { relocating = false; }
          break;
        }
        if (!payload.storage || typeof payload.storage !== 'object' || Array.isArray(payload.storage)) throw new ChannelError('INVALID_STORAGE_PATH', '请填写工作空间和会话记录目录');
        const input = { workspacePath: absoluteDirectory(payload.storage.workspacePath, '工作空间路径'), recordsPath: absoluteDirectory(payload.storage.recordsPath, '会话记录路径') };
        const before = store.storageSettings();
        await paused('正在迁移会话存储，自动回复暂时暂停', () => {
          signal?.throwIfAborted();
          // Clear old cwd associations before committing a new workspace. A
          // later disk failure must never resume an old cwd under new settings.
          if (!sameDirectory(input.workspacePath, before.workspacePath)) store.resetSessions();
          store.setStorageSettings(input);
        });
        break;
      }
      case 'conversation.configure': {
        const selector = conversation(payload), config = validateConversationSettings(payload.config);
        if (selector.chatType === 'private' && config.mode !== 'default') throw new ChannelError('INVALID_CONVERSATION', '昵称唤醒和主动参与仅适用于群聊');
        const before = store.conversationSettings(selector.accountId, selector.chatType, selector.peerId);
        await paused('正在应用该会话的设置，旧任务已取消', () => {
          signal?.throwIfAborted(); currentAccount(payload);
          if (before.mode !== config.mode) store.resetSessions(selector);
          store.setConversationSettings(selector.accountId, selector.chatType, selector.peerId, config);
        }, selector);
        break;
      }
      case 'settings': {
        const account = currentAccount(payload), next = validateSettings(payload.settings), before = store.settings(account.id);
        if (JSON.stringify(next) !== JSON.stringify(before)) {
          // Adding a peer changes no existing reply. Revocation affects only
          // removed peers; account-wide settings affect only this account.
          const selectors = next.enabled !== before.enabled || next.prompt !== before.prompt
            ? [{ accountId: account.id }]
            : [['privatePeers', 'private'], ['groups', 'group']].flatMap(([field, chatType]) =>
              before[field].filter(peerId => !next[field].includes(peerId)).map(peerId => ({ accountId: account.id, chatType, peerId })));
          await paused('授权或回复要求已变更，相关任务已取消', () => {
            signal?.throwIfAborted(); currentAccount(payload);
            if (next.prompt !== before.prompt) store.resetSessions({ accountId: account.id });
            store.configure(account.id, next);
            if (discovered?.accountId === account.id) store.rememberConversationNames(account.id, discovered.contacts);
          }, selectors);
        }
        break;
      }
      case 'connect': store.data.connectionWanted = true; store.save(); await worker.call('connect'); if (scheduler?.stopped) { scheduler.error = null; scheduler.start(); } break;
      case 'disconnect':
        store.data.connectionWanted = false; store.save();
        await paused('微信已断开，任务已取消', () => { assertLive(signal); return worker.call('disconnect'); }); break;
      case 'login.start':
        await paused('正在重新登录，旧账号任务已取消', () => { assertLive(signal); return worker.call('login.start', { replace: payload.replace === true }); });
        assertLive(signal);
        store.data.connectionWanted = true; store.save(); break;
      case 'login.cancel': await worker.call('login.cancel'); break;
      case 'cancel': {
        const scoped = ['accountId', 'chatType', 'peerId'].some(field => Object.hasOwn(payload, field));
        const selector = scoped ? conversation(payload) : undefined;
        await paused('已取消当前任务和排队消息', () => {}, selector); break;
      }
      default: throw new ChannelError('UNKNOWN_OPERATION', '不支持的微信插件操作');
    }
    assertLive(signal);
    return status();
  };
  return { drain: () => mutations,
    replaceRuntime(next) {
      ({ root, store, worker, runner, channel, scheduler, identity } = next); startupError = next.startupError; discovered = undefined;
    },
    setStartupError(error) { startupError = publicError(error, '目录切换后未能重新启动，请保留数据并重新启用插件'); },
    call(endpoint, payload = {}, signal) {
    assertLive(signal);
    if (endpoint === 'status') return status();
    if (relocating) throw new ChannelError('WORKSPACE_MOVING', '正在切换全局工作目录，请等待完成后重试');
    if (endpoint === 'changelog') return { markdown: fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8') };
    if (startupError) throw new ChannelError(startupError.code, startupError.message);
    if (endpoint === 'identity.get') return identity.view();
    if (endpoint === 'members') {
      const scope = conversation(payload);
      if (scope.chatType !== 'group' || !store.settings(scope.accountId).groups.includes(scope.peerId)) throw new ChannelError('TASK_NOT_AUTHORIZED', '请从已授权群聊中选择提醒对象');
      return worker.call('members', { accountId: scope.accountId, peerId: scope.peerId }, { signal }).then(result => { assertLive(signal); currentAccount(payload); return result; });
    }
    if (endpoint === 'memory.list') {
      const account = currentAccount(payload);
      return { conversations: channel.memory.list(account.id), windowChars: channel.memory.index.windowChars, path: channel.memory.root };
    }
    if (endpoint === 'memory.get') return channel.memory.view(conversation(payload));
    if (endpoint === 'memory.global.get') return channel.longMemory.view(currentAccount(payload).id);
    if (endpoint === 'assets.list') return channel.library.list(currentAccount(payload).id, payload);
    if (endpoint === 'assets.content') return channel.library.getContent(currentAccount(payload).id, payload.assetId, { enabledOnly: false });
    if (endpoint === 'assets.packs.content') { currentAccount(payload); return channel.library.builtins.preview(payload.packId, payload.assetId); }
    if (endpoint === 'tasks.list') {
      const account = currentAccount(payload), selector = payload.peerId ? conversation(payload) : undefined;
      return scheduler?.list(account.id, selector) ?? { tasks: [], runs: [], error: '定时任务组件尚未启动' };
    }
    if (endpoint === 'records.list') {
      conversation(payload);
      return store.recordsPage(payload.accountId, payload);
    }
    if (endpoint === 'contacts') {
      const accountId = worker.status().account?.id;
      return worker.call('contacts', {}, { signal }).then(result => {
        assertLive(signal);
        if (!accountId || worker.status().account?.id !== accountId) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，请重新读取会话');
        discovered = { accountId, contacts: result };
        store.rememberConversationNames(accountId, result);
        return result;
      });
    }
    const pending = mutations.then(() => mutate(endpoint, payload, signal));
    mutations = pending.catch(() => {}); return pending;
  } };
}

export async function apply(ctx) {
  const configuredHome = process.env.DSH_HOME?.trim();
  const dshHome = configuredHome?.startsWith('~/') || configuredHome?.startsWith('~\\') ? path.join(homedir(), configuredHome.slice(2)) : configuredHome || path.join(homedir(), '.dsh');
  const bootstrap = path.resolve(dshHome, 'wechat-agent');
  let resolvedRoot = bootstrap;
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let lock, current, service, startupError, disposed = false, closing;
  const runtimes = new Set();
  const lifetime = new AbortController();
  const close = () => closing ??= (async () => {
    disposed = true;
    lifetime.abort();
    try {
      await Promise.allSettled([...runtimes].map(runtime => runtime.close()));
      await service?.drain();
      await Promise.allSettled([...runtimes].map(runtime => runtime.close()));
    } finally { lock?.release(); }
  })();
  // Cordis runs sibling disposers concurrently. This one owns the complete
  // drain -> child exit -> exclusive-lock release sequence.
  ctx.effect(() => close, 'wechat-agent shutdown');
  const open = async root => {
    lifetime.signal.throwIfAborted();
    const runtime = new WechatRuntime({ ctx, root, bootstrap, resources, ownerLock: lock, signal: lifetime.signal });
    runtimes.add(runtime);
    try { await runtime.ready(); return runtime; }
    catch (error) { try { await runtime.close(); } finally { runtimes.delete(runtime); } throw error; }
  };
  const relocateWorkspace = async (target, signal) => {
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    const previous = current;
    if (sameDirectory(previous.root, target) && !describeWorkspace(previous.root, previous.store).legacyPaths.length) return;
    let transfer, next;
    try {
      await previous.stop();
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      transfer = migrateWorkspaceRoot({ bootstrap, store: previous.store, targetRoot: target });
      next = await open(transfer.root);
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      transfer.commit(); transfer = undefined;
    } catch (error) {
      try { await next?.close(); } catch { /* Worker close is still awaited in its finally. */ }
      if (next) runtimes.delete(next);
      try {
        transfer?.rollback();
        previous.releaseLock(); runtimes.delete(previous);
        if (!disposed) {
          current = await open(previous.root); service.replaceRuntime(current); await current.activate();
        }
      } catch (recoveryError) {
        service.setStartupError(recoveryError);
        throw new ChannelError('WORKSPACE_RECOVERY_FAILED', '目录切换未完成，原数据和已复制的数据均保留；恢复连接失败，请检查目录后重新启用插件');
      }
      throw error;
    }
    current = next; service.replaceRuntime(next);
    try { previous.releaseLock(); runtimes.delete(previous); }
    catch { next.scheduler.error = '新目录已生效，旧目录锁暂未能清理；请保留旧目录并检查文件占用'; }
    // No new message is admitted to the network until the pointer and all
    // root-bound services agree on the committed destination.
    await current.activate();
  };
  try {
    lock = acquireLock(bootstrap);
    resolvedRoot = readWorkspaceLocation(bootstrap);
    current = await open(resolvedRoot);
    await current.activate();
  } catch (error) {
    startupError = publicError(error, '微信插件启动失败，请检查安装包或重新启用插件');
    try { await current?.close(); } finally { lock?.release(); lock = undefined; }
  }
  let dshSessionPath = null;
  try {
    const persistence = ctx.sessionPersistence;
    if (persistence?.name === 'session-persistence-jsonl' && typeof persistence.root === 'string' && path.isAbsolute(persistence.root)) dshSessionPath = persistence.root;
  } catch {}
  service = createPluginService({ ctx, root: current?.root || resolvedRoot, ...current, relocateWorkspace, startupError, isDisposed: () => disposed, lifetime: lifetime.signal, dshSessionPath });
  // rc.5's rpc getter retains the Connection service's dependency shadow;
  // register with our explicit owner so webServer and teardown belong here.
  if (!disposed) ctx.connection.register(ctx, CHANNEL, rpcHandler(service, () => disposed));
}
