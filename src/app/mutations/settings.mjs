import { ChannelError, validateSettings, validateConversationSettings } from '../../shared/contracts.mjs';
import { absoluteDirectory, sameDirectory } from '../../storage/paths.mjs';

export const endpoints = ['storage.save', 'natural.resume', 'conversation.configure', 'settings'];

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
      if (selector.chatType === 'private' && config.mode !== 'default')
        throw new ChannelError('INVALID_CONVERSATION', '昵称唤醒、主动参与和自然陪聊仅适用于群聊');
      const before = store.conversationSettings(selector.accountId, selector.chatType, selector.peerId);
      if (JSON.stringify(before) === JSON.stringify(config)) break;
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
    case 'settings': {
      const account = currentAccount(payload),
        next = validateSettings(payload.settings),
        before = store.settings(account.id);
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        // Adding a peer changes no existing reply. Revocation affects only
        // removed peers; account-wide settings affect only this account.
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
            if (state.discovered?.accountId === account.id)
              store.rememberConversationNames(account.id, state.discovered.contacts);
          },
          selectors
        );
      }
      break;
    }
  }
  assertLive(signal);
  return status();
}
