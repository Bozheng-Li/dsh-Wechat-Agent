import { mutationHandlers } from "../rpc/actions.mjs";
import { resourcePath } from "../platform/resources.mjs";
import fs from 'node:fs';

import { VERSION, ChannelError, emptySettings, emptyPersona, publicError, workSettings } from "../../shared/contracts.mjs";

import { AgentIdentity } from "../../modules/agent/identity.mjs";
import { readModelInfo } from "../../modules/agent/models.mjs";
import { describeWorkspace } from "../storage/workspace.mjs";
import { WORKBENCH_ENDPOINTS } from "../../modules/workbench/service.mjs";
import { administratorCandidates } from '../../modules/remote/authorization/actions.mjs';
import { imageGenerationSettings } from '../../shared/image-generation.mjs';
import { resolveMomentsQuery } from '../../modules/moments/service.mjs';
import { momentsImage } from '../../modules/moments/media.mjs';

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
  identity ??= store ? new AgentIdentity(root, { config: store.config }) : undefined;
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
      model = {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      };
    } catch {}
    try {
      const selected = runner.defaultSelection();
      defaultModel = {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      };
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
      capabilities: { vision: !!ctx?.attachments?.admitPromptContent, webSearch: !!ctx?.web?.search, momentsRead: state.momentsReadReady === true,
        momentsWrite: state.momentsWriteReady === true, momentsAudience: state.momentsAudienceReady === true,
        momentsPublish: { text: state.momentsWriteReady === true, images: state.momentsWriteReady === true, video: false } },
      localPreview: false,
      lastSearch: runner?.searchStatus?.() ?? null,
      search: runner?.search?.status?.() ?? { credentialStore: false, credentials: { dsh: false, tavily: false } },
      imageGeneration: channel?.work?.imageGeneration?.status() ?? { ...imageGenerationSettings(), credentialStore: false, credentialConfigured: false },
      memory: { windowChars: channel?.memory?.index.windowChars ?? 100000, path: channel?.memory?.root || null },
      scheduler: { enabled: !!scheduler && !scheduler.stopped, error: scheduler?.error || null },
      moments: state.account && channel?.momentsAutomation ? channel.momentsAutomation.list(state.account.id) : null,
      storage: {
        ...describeWorkspace(root, store),
        identityPath: identity?.file || null,
        dshSessionPath,
        observedMessageLimit: 1000,
        relocating,
      },
      settings: state.account && store ? store.settings(state.account.id) : emptySettings(),
      remote: store?.config.section('remote') ?? { globalAdminIds: [] },
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
      if (endpoint === 'administrators.candidates') {
        if (startupError) throw new ChannelError(startupError.code, startupError.message);
        const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        const pending = administratorCandidates({ store, worker, currentAccount, conversation, assertLive }, payload, combined);
        featureOperations.add(pending);
        void pending.finally(() => featureOperations.delete(pending)).catch(() => {});
        return pending;
      }
      if (endpoint === 'model.info') {
        const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        const pending = readModelInfo(ctx, payload.selection, combined);
        featureOperations.add(pending);
        void pending.finally(() => featureOperations.delete(pending)).catch(() => {});
        return pending;
      }
      if (relocating) throw new ChannelError('WORKSPACE_MOVING', '正在切换全局工作目录，请等待完成后重试');
      if (endpoint === 'changelog') return { markdown: fs.readFileSync(resourcePath('CHANGELOG.md'), 'utf8') };
      if (startupError) throw new ChannelError(startupError.code, startupError.message);
      if (endpoint === 'identity.get') return identity.view();
      if (WORKBENCH_ENDPOINTS.includes(endpoint)) {
        const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        // Workbench operations share the instance lifetime and caller cancellation.
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
      if (endpoint === 'moments.audience') {
        const account = currentAccount(payload), combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        const pending = channel.moments.audienceOwner(account.id, combined, () => { assertLive(combined); currentAccount(payload); });
        featureOperations.add(pending); void pending.finally(() => featureOperations.delete(pending)).catch(() => {}); return pending;
      }
      if (endpoint === 'moments.read') {
        const account = currentAccount(payload), { accountId, ...query } = payload;
        const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        const pending = (async () => {
          assertLive(combined);
          const check = () => { assertLive(combined); currentAccount(payload); };
          const resolved = await resolveMomentsQuery(worker, query, { accountId: account.id, senderId: account.id }, combined, check); check();
          const result = await worker.readMoments({ accountId: account.id, scopeKey: 'owner:' + account.id, query: resolved }, combined);
          assertLive(combined); currentAccount(payload);
          if (result?.accountId !== account.id) throw new ChannelError('ACCOUNT_CHANGED', '朋友圈结果与当前微信账号不匹配');
          channel.momentsAutomation?.remember(account.id, result.items);
          return result;
        })();
        featureOperations.add(pending); void pending.finally(() => featureOperations.delete(pending)).catch(() => {});
        return pending;
      }
      if (endpoint.startsWith('moments.publishing.') || endpoint.startsWith('moments.plans.') || endpoint.startsWith('moments.drafts.')) {
        const account = currentAccount(payload), manager = channel.momentsAutomation?.publishing;
        if (!manager) throw new ChannelError('MOMENTS_UNAVAILABLE', '自动发布组件尚未加载');
        const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]), check = () => { assertLive(combined); currentAccount(payload); }; check();
        const requestId = () => { if (typeof payload.requestId !== 'string' || !/^ui-moments-[a-f0-9-]{36}$/.test(payload.requestId)) throw new ChannelError('MOMENTS_PLAN_INVALID', '操作编号缺失，请重新打开计划面板'); return payload.requestId; };
        const pending = (async () => {
          switch (endpoint) {
            case 'moments.publishing.configure': return manager.configure(account.id, payload.settings);
            case 'moments.plans.save': return manager.savePlan(account.id, payload.settings, payload.id, requestId(), combined, check);
            case 'moments.plans.enable': return manager.setEnabled(account.id, payload.id, payload.enabled);
            case 'moments.plans.delete': return manager.removePlan(account.id, payload.id);
            case 'moments.plans.preview': return manager.preview(account.id, payload.settings, requestId(), combined, check);
            case 'moments.drafts.edit': return manager.editDraft(account.id, payload.id, payload.text);
            case 'moments.drafts.publish': return manager.publishDraft(account.id, payload.id, combined, check);
            case 'moments.drafts.discard': return manager.discard(account.id, payload.id);
            case 'moments.drafts.reconcile': return manager.reconcile(account.id, payload.id);
            case 'moments.drafts.image': return manager.contentImage(account.id, payload.id);
            default: throw new ChannelError('UNKNOWN_OPERATION', '不支持的自动发布操作');
          }
        })();
        featureOperations.add(pending); void pending.finally(() => featureOperations.delete(pending)).catch(() => {}); return pending;
      }
      if (['moments.list', 'moments.discover', 'moments.configure', 'moments.write'].includes(endpoint)) {
        const account = currentAccount(payload), manager = channel.momentsAutomation;
        if (!manager) throw new ChannelError('MOMENTS_UNAVAILABLE', '朋友圈组件尚未加载');
        if (endpoint === 'moments.list') return manager.list(account.id);
        if (endpoint === 'moments.configure') return manager.configure(account.id, payload.settings);
        const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
        const pending = (async () => {
          if (endpoint === 'moments.discover') return manager.discover(account.id, combined, manager.rule(account.id).settings.lookbackDays);
          const { accountId, requestId, ...query } = payload;
          if (typeof requestId !== 'string' || !/^ui-moments-[a-f0-9-]{36}$/.test(requestId)) throw new ChannelError('MOMENTS_WRITE_INVALID', '操作编号缺失，请重新打开操作面板');
          if (query.images !== undefined) {
            if (!Array.isArray(query.images) || query.images.length > 9 || query.images.some(data => typeof data !== 'string' || !data || data.length > 13981016 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))) throw new ChannelError('MOMENTS_IMAGE_FORMAT', '请选择有效 PNG/JPEG，每张最多 10 MiB，最多 9 张');
            query.images = query.images.map(data => momentsImage(Buffer.from(data, 'base64')));
          }
          return manager.write(account.id, query, requestId, combined);
        })();
        featureOperations.add(pending); void pending.finally(() => featureOperations.delete(pending)).catch(() => {}); return pending;
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
      if (['work.list', 'work.get', 'work.cancel', 'work.configure'].includes(endpoint)) {
        const account = currentAccount(payload);
        if (endpoint === 'work.configure') {
          assertLive(signal);
          if (!Number.isInteger(payload.maxConcurrent)) throw new ChannelError('INVALID_WORK_SETTINGS', '请选择 1–8 个同时执行任务');
          const next = store.config.snapshot(store.data);
          next.work = workSettings({ ...next.work, maxConcurrent: payload.maxConcurrent });
          store.config.commit(next);
          channel.work.drain();
          return channel.work.capacity();
        }
        const scope = payload.peerId ? conversation(payload) : { accountId: account.id };
        if (endpoint === 'work.list') return channel.work.list(scope);
        if (endpoint === 'work.get') return channel.work.get(payload.id, scope);
        return channel.work.cancel(payload.id, scope);
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
