import { mutationHandlers } from './mutations/index.mjs';
import { resourcePath } from '../platform/resources.mjs';
import fs from 'node:fs';

import { VERSION, ChannelError, emptySettings, emptyPersona, publicError } from '../shared/contracts.mjs';

import { AgentIdentity } from '../features/agent/identity.mjs';
import { describeWorkspace } from '../storage/workspace.mjs';
import { WORKBENCH_ENDPOINTS } from '../features/workbench/service.mjs';

export function createPluginService({
  ctx,
  root,
  store,
  worker,
  runner,
  channel,
  scheduler = channel?.scheduler,
  identity,
  relocateWorkspace,
  startupError,
  isDisposed = () => false,
  lifetime = new AbortController().signal,
  dshSessionPath = null,
}) {
  let mutations = Promise.resolve();
  const featureOperations = new Set();
  let discovered;
  let relocating = false;
  const state = {
    get discovered() {
      return discovered;
    },
    set discovered(value) {
      discovered = value;
    },
    get relocating() {
      return relocating;
    },
    set relocating(value) {
      relocating = value;
    },
  };
  identity ??= store ? new AgentIdentity(root) : undefined;
  const assertLive = (signal) => {
    if (isDisposed() || lifetime.aborted) throw new ChannelError('PLUGIN_STOPPING', '微信插件正在停止');
    signal?.throwIfAborted();
  };
  const currentAccount = (payload) => {
    const account = worker?.status().account;
    if (!account || payload.accountId !== account.id)
      throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，请刷新后再查看或保存该账号的会话');
    return account;
  };
  const conversation = (payload) => {
    currentAccount(payload);
    if (
      !['private', 'group'].includes(payload.chatType) ||
      typeof payload.peerId !== 'string' ||
      !payload.peerId ||
      payload.peerId.length > 150 ||
      /\s/.test(payload.peerId) ||
      payload.peerId.endsWith('@chatroom') !== (payload.chatType === 'group')
    )
      throw new ChannelError('INVALID_PEERS', '会话类型或 ID 不正确，请重新选择会话');
    return { accountId: payload.accountId, chatType: payload.chatType, peerId: payload.peerId };
  };
  const status = () => {
    const state = worker?.status() ?? {
      online: false,
      state: 'error',
      account: null,
      login: { state: 'idle' },
      runtimeReady: false,
    };
    let model = null,
      defaultModel = null;
    try {
      const selected = runner.selection();
      model = { provider: selected.provider, model: selected.model };
    } catch {}
    try {
      const selected = runner.defaultSelection();
      defaultModel = { provider: selected.provider, model: selected.model };
    } catch {}
    return {
      version: VERSION,
      ...state,
      model,
      defaultModel,
      modelChoice: store?.modelChoice() ?? null,
      startupError,
      persona: store?.persona() ?? emptyPersona(),
      modelConfig: store?.modelConfig() ?? { maxTokens: null, temperature: null },
      capabilities: { vision: !!ctx?.attachments?.admitPromptContent, webSearch: !!ctx?.web?.search },
      localPreview: false,
      lastSearch: runner?.searchStatus?.() ?? null,
      search: runner?.search?.status?.() ?? { credentialStore: false, credentials: { dsh: false, tavily: false } },
      memory: { windowChars: channel?.memory?.index.windowChars ?? 100000, path: channel?.memory?.root || null },
      scheduler: { enabled: !!scheduler && !scheduler.stopped, error: scheduler?.error || null },
      storage: {
        ...describeWorkspace(root, store),
        identityPath: identity?.file || null,
        dshSessionPath,
        observedMessageLimit: 1000,
        relocating,
      },
      settings: state.account && store ? store.settings(state.account.id) : emptySettings(),
      conversations:
        state.account && store
          ? store
              .conversations(state.account.id)
              .map((peer) => ({
                ...peer,
                naturalStatus: channel?.natural?.summary(peer) ?? null,
                processing: channel?.summary(peer) ?? { queued: 0, active: null, fault: null },
              }))
          : [],
      records: [],
      processing: channel?.summary() ?? { queued: 0, active: null, fault: null },
    };
  };
  const paused = async (reason, action, selector, { resetProgress = true } = {}) => {
    const selectors = Array.isArray(selector) ? selector : [selector];
    const resumes = selectors.map((target) => channel.pause(reason, target));
    try {
      for (const target of selectors) channel.cancel(reason, target, { resetProgress });
      for (const target of selectors) await channel.whenIdle(target);
      assertLive();
      return await action();
    } finally {
      for (const resume of resumes.reverse()) resume();
    }
  };
  const mutate = async (endpoint, payload, signal) => {
    assertLive(signal);
    if (startupError) throw new ChannelError(startupError.code, startupError.message);
    if (WORKBENCH_ENDPOINTS.includes(endpoint))
      return channel.workbench.call(endpoint, payload, AbortSignal.any([lifetime, ...(signal ? [signal] : [])]));
    const handler = mutationHandlers.get(endpoint);
    if (!handler) throw new ChannelError('UNKNOWN_OPERATION', '不支持的微信插件操作');
    return handler(
      {
        ctx,
        root,
        store,
        worker,
        runner,
        channel,
        scheduler,
        identity,
        relocateWorkspace,
        lifetime,
        assertLive,
        currentAccount,
        conversation,
        paused,
        status,
        state,
      },
      endpoint,
      payload,
      signal
    );
  };
  return {
    drain: () => Promise.allSettled([mutations, ...featureOperations]),
    replaceRuntime(next) {
      ({ root, store, worker, runner, channel, scheduler, identity } = next);
      startupError = next.startupError;
      discovered = undefined;
    },
    setStartupError(error) {
      startupError = publicError(error, '目录切换后未能重新启动，请保留数据并重新启用插件');
    },
    call(endpoint, payload = {}, signal) {
      assertLive(signal);
      if (endpoint === 'status') return status();
      if (relocating) throw new ChannelError('WORKSPACE_MOVING', '正在切换全局工作目录，请等待完成后重试');
      if (endpoint === 'changelog') return { markdown: fs.readFileSync(resourcePath('CHANGELOG.md'), 'utf8') };
      if (startupError) throw new ChannelError(startupError.code, startupError.message);
      if (endpoint === 'identity.get') return identity.view();
      if (WORKBENCH_ENDPOINTS.includes(endpoint)) {
        const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        // Knowledge mutations validate and commit before cancelling only their own
        // in-flight queries. Ordinary replies keep running; failed edits cancel none.
        const operation = channel.workbench.call(endpoint, payload, combined);
        const pending = Promise.resolve(operation);
        featureOperations.add(pending);
        void pending.finally(() => featureOperations.delete(pending)).catch(() => {});
        return pending;
      }
      if (endpoint === 'members') {
        const scope = conversation(payload);
        if (scope.chatType !== 'group' || !store.settings(scope.accountId).groups.includes(scope.peerId))
          throw new ChannelError('TASK_NOT_AUTHORIZED', '请从已授权群聊中选择提醒对象');
        return worker
          .call('members', { accountId: scope.accountId, peerId: scope.peerId }, { signal })
          .then((result) => {
            assertLive(signal);
            currentAccount(payload);
            return result;
          });
      }
      if (endpoint === 'memory.list') {
        const account = currentAccount(payload);
        return {
          conversations: channel.memory.list(account.id),
          windowChars: channel.memory.index.windowChars,
          path: channel.memory.root,
        };
      }
      if (endpoint === 'memory.get') return channel.memory.view(conversation(payload));
      if (endpoint === 'memory.images.list') return channel.imageMemory.list(conversation(payload), payload);
      if (endpoint === 'memory.images.content')
        return channel.imageMemory.content(conversation(payload), payload.imageId, {
          preview: payload.preview === true,
        });
      if (endpoint === 'memory.images.import') {
        const scope = conversation(payload),
          combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        const assertAllowed = () => {
          assertLive(combined);
          currentAccount(payload);
          const settings = store.settings(scope.accountId),
            allowed = scope.chatType === 'group' ? settings.groups : settings.privatePeers;
          if (!allowed.includes(scope.peerId))
            throw new ChannelError('AUTH_CHANGED', '会话授权已撤销，未继续读取和保存图片');
        };
        assertAllowed();
        const entries = [
          ...channel.memory.load(scope).entries,
          ...store.history(scope.accountId, scope.chatType, scope.peerId, 1000),
        ];
        const pending = channel.imageMemory.importExisting(scope, entries, worker, combined, assertAllowed);
        featureOperations.add(pending);
        void pending.finally(() => featureOperations.delete(pending)).catch(() => {});
        return pending;
      }
      if (endpoint === 'memory.global.get') return channel.longMemory.view(currentAccount(payload).id);
      if (endpoint === 'assets.list') return channel.library.list(currentAccount(payload).id, payload);
      if (endpoint === 'assets.content')
        return channel.library.getContent(currentAccount(payload).id, payload.assetId, { enabledOnly: false });
      if (endpoint === 'assets.packs.content') {
        currentAccount(payload);
        return channel.library.builtins.preview(payload.packId, payload.assetId);
      }
      if (endpoint === 'tasks.list') {
        const account = currentAccount(payload),
          selector = payload.peerId ? conversation(payload) : undefined;
        return scheduler?.list(account.id, selector) ?? { tasks: [], runs: [], error: '定时任务组件尚未启动' };
      }
      if (endpoint === 'records.list') {
        conversation(payload);
        return store.recordsPage(payload.accountId, payload);
      }
      if (endpoint === 'contacts') {
        const accountId = worker.status().account?.id;
        return worker.call('contacts', {}, { signal }).then((result) => {
          assertLive(signal);
          if (!accountId || worker.status().account?.id !== accountId)
            throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，请重新读取会话');
          discovered = { accountId, contacts: result };
          store.rememberConversationNames(accountId, result);
          return result;
        });
      }
      const pending = mutations.then(() => mutate(endpoint, payload, signal));
      mutations = pending.catch(() => {});
      return pending;
    },
  };
}
