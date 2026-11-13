import { ChannelError, validateSettings, validateConversationSettings, validatePublishScope, publishScopeOf } from "../../shared/contracts.mjs";
import { absoluteDirectory, sameDirectory } from "../../backend/storage/paths.mjs";
import { preserveTimeValues } from '../../shared/time-settings.mjs';

export const endpoints = ['storage.save', 'natural.resume', 'conversation.configure', 'moments.publishScope', 'moments.audienceDefault', 'settings'];

export async function settingsMutation(
  { store, channel, relocateWorkspace, currentAccount, conversation, paused, assertLive, status, state },
  endpoint,
  payload,
  signal
) {
  switch (endpoint) {
    case 'storage.save': {
      if (payload.storage && Object.hasOwn(payload.storage, 'basePath')) {
        if (Object.keys(payload.storage).some((key) => key !== 'basePath'))
          throw new ChannelError('INVALID_STORAGE_PATH', '只需指定全局工作目录，其他路径由它自动生成');
        const target = absoluteDirectory(payload.storage.basePath, '全局工作目录');
        if (!relocateWorkspace)
          throw new ChannelError('WORKSPACE_UNAVAILABLE', '当前实例暂不支持完整目录迁移，请重新启用插件');
        state.relocating = true;
        try {
          await relocateWorkspace(target, signal);
          state.discovered = undefined;
        } finally {
          state.relocating = false;
        }
        break;
      }
      if (!payload.storage || typeof payload.storage !== 'object' || Array.isArray(payload.storage))
        throw new ChannelError('INVALID_STORAGE_PATH', '请填写工作空间和会话记录目录');
      const input = {
        workspacePath: absoluteDirectory(payload.storage.workspacePath, '工作空间路径'),
        recordsPath: absoluteDirectory(payload.storage.recordsPath, '会话记录路径'),
      };
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
    case 'natural.resume': {
      channel.natural.resume(conversation(payload), payload);
      break;
    }
    case 'conversation.configure': {
      const selector = conversation(payload),
        config = validateConversationSettings(payload.config);
      if (config.persona)
        throw new ChannelError('PERSONA_GLOBAL_ONLY', '所有会话共用默认助手，请在“默认助手”的全局自定义入口编辑');
      if (selector.chatType === 'private' && config.mode !== 'default')
        throw new ChannelError('INVALID_CONVERSATION', '昵称唤醒、主动参与和自然陪聊仅适用于群聊');
      const before = store.conversationSettings(selector.accountId, selector.chatType, selector.peerId);
      if (payload.preserveTimeSettings) config.natural = preserveTimeValues('natural', config.natural, before.natural);
      if (JSON.stringify(before) === JSON.stringify(config)) break;
      const withoutRemote = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['remoteEnabled', 'adminIds'].includes(key)));
      if (JSON.stringify(withoutRemote(before)) === JSON.stringify(withoutRemote(config))) {
        signal?.throwIfAborted(); currentAccount(payload);
        store.setConversationSettings(selector.accountId, selector.chatType, selector.peerId, config);
        break;
      }
      await paused(
        '正在应用该会话的设置，旧任务已取消',
        () => {
          signal?.throwIfAborted();
          currentAccount(payload);
          if (before.mode !== config.mode) store.resetSessions(selector);
          store.setConversationSettings(selector.accountId, selector.chatType, selector.peerId, config);
          if (
            ['mode', 'intervalMode', 'fixedMessages', 'minMessages', 'maxMessages'].some(
              (key) => before[key] !== config[key]
            )
          )
            store.resetProgress(selector.accountId, selector.chatType, selector.peerId, { resetNatural: false });
          if (config.mode === 'natural') {
            const natural = channel.natural.state(selector, config);
            if (before.mode !== 'natural') natural.nextCheckAt = channel.now() + channel.natural.delay(config, natural);
            channel.natural.save(selector, natural);
          }
        },
        selector,
        { resetProgress: false }
      );
      if (before.memoryWindowChars !== config.memoryWindowChars) channel.maintainMemory(selector);
      break;
    }
    case 'moments.publishScope': {
      const account = currentAccount(payload), before = store.settings(account.id),
        scope = payload.scope === undefined ? undefined : validatePublishScope(payload.scope);
      if (scope !== undefined && scope !== publishScopeOf(before)) {
        signal?.throwIfAborted(); currentAccount(payload);
        // 可见范围属于账号回复设置，沿用同一份账号设置存储与校验。
        store.configure(account.id, { ...before, publishScope: scope });
      }
      assertLive(signal);
      return { scope: publishScopeOf(store.settings(account.id)) };
    }
    case 'moments.audienceDefault': {
      const account = currentAccount(payload), before = store.settings(account.id);
      if (payload.blockedUserIds !== undefined || payload.blockedLabelIds !== undefined) {
        // 默认屏蔽名单属于账号回复设置；只改这两个字段，其余设置原样保留。
        const next = validateSettings({
          ...before,
          defaultBlockedUserIds: payload.blockedUserIds === undefined ? before.defaultBlockedUserIds : payload.blockedUserIds,
          defaultBlockedLabelIds: payload.blockedLabelIds === undefined ? before.defaultBlockedLabelIds : payload.blockedLabelIds,
        });
        if (JSON.stringify(next) !== JSON.stringify(before)) {
          signal?.throwIfAborted(); currentAccount(payload);
          store.configure(account.id, next);
        }
      }
      const settings = store.settings(account.id);
      assertLive(signal);
      return { blockedUserIds: settings.defaultBlockedUserIds, blockedLabelIds: settings.defaultBlockedLabelIds };
    }
    case 'settings': {
      const account = currentAccount(payload),
        next = validateSettings(payload.settings),
        before = store.settings(account.id);
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        // A revocation also cancels account background operations which may
        // contain this object's sources. Their unrelated data is retained.
        const selectors =
          next.enabled !== before.enabled || next.prompt !== before.prompt
            ? [{ accountId: account.id }]
            : [
                ['privatePeers', 'private'],
                ['groups', 'group'],
              ].flatMap(([field, chatType]) =>
                before[field]
                  .filter((peerId) => !next[field].includes(peerId))
                  .map((peerId) => ({ accountId: account.id, chatType, peerId }))
              );
        await paused(
          '授权或回复要求已变更，相关任务已取消',
          () => {
            signal?.throwIfAborted();
            currentAccount(payload);
            if (next.prompt !== before.prompt) store.resetSessions({ accountId: account.id });
            store.configure(account.id, next);
            channel.personMemory.nextScanAt = 0;
            channel.personMemory.wake(0);
            if (state.discovered?.accountId === account.id)
              store.rememberConversationNames(account.id, state.discovered.contacts);
          },
          selectors
        );
      }
      await channel.authorization?.whenIdle();
      break;
    }
  }
  assertLive(signal);
  return status();
}
