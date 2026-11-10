import { ChannelError } from "../../shared/contracts.mjs";
import { validateImageMemorySettings } from "./images/store.mjs";

export const endpoints = [
  'memory.configure',
  'memory.global.edit',
  'memory.global.clear',
  'memory.global.extract',
  'memory.edit',
  'memory.images.configure',
  'memory.images.delete',
  'memory.images.clear',
  'memory.clear',
  'memory.retryImages',
  'memory.compress',
];

export async function memoryMutation(
  { store, worker, runner, channel, lifetime, currentAccount, conversation, paused, assertLive, status },
  endpoint,
  payload,
  signal
) {
  switch (endpoint) {
    case 'memory.configure':
      channel.memory.setWindowChars(payload.windowChars);
      break;
    case 'memory.global.edit': {
      const account = currentAccount(payload);
      channel.longMemory.edit(account.id, payload.markdown, payload.revision);
      break;
    }
    case 'memory.global.clear': {
      const account = currentAccount(payload);
      await paused(
        '正在清空长期记忆',
        () => {
          currentAccount(payload);
          channel.longMemory.clear(account.id);
        },
        { accountId: account.id }
      );
      break;
    }
    case 'memory.global.extract': {
      const account = currentAccount(payload),
        combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
      const selectors = payload.peerId
        ? [conversation(payload)]
        : store.conversations(account.id).filter((peer) => peer.authorized);
      for (const selector of selectors) {
        currentAccount(payload);
        combined.throwIfAborted();
        await channel.memory.enrich(selector, runner, worker, combined);
        channel.longMemory.capture(selector, channel.memory.load(selector));
        await channel.longMemory.extract(selector, runner, combined);
      }
      break;
    }
    case 'memory.edit': {
      const selector = conversation(payload);
      channel.memory.edit(selector, payload.summary, payload.revision);
      break;
    }
    case 'memory.images.configure':
    case 'memory.images.delete':
    case 'memory.images.clear': {
      const scope = conversation(payload);
      const state = channel.imageMemory.load(scope);
      const settings = endpoint === 'memory.images.configure' ? validateImageMemorySettings(payload.settings) : null;
      if (settings && JSON.stringify(state.settings) === JSON.stringify(settings))
        return channel.imageMemory.list(scope);
      if (
        endpoint === 'memory.images.delete' &&
        (typeof payload.imageId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(payload.imageId) ||
          (!state.items[payload.imageId] && !state.deleted[payload.imageId]))
      )
        throw new ChannelError('IMAGE_MEMORY_UNAVAILABLE', '图片记忆不存在或不属于当前会话');
      return paused(
        '正在修改此会话的图片记忆',
        () => {
          currentAccount(payload);
          let result;
          if (endpoint === 'memory.images.configure') result = channel.imageMemory.configure(scope, settings);
          else if (endpoint === 'memory.images.delete') result = channel.imageMemory.remove(scope, [payload.imageId]);
          else
            result = channel.imageMemory.clear(scope, [
              ...channel.memory.load(scope).entries,
              ...store.history(scope.accountId, scope.chatType, scope.peerId, 1000),
            ]);
          store.resetSessions(scope);
          return result;
        },
        scope,
        { resetProgress: false }
      );
    }
    case 'memory.compress': {
      const selector = conversation(payload);
      assertLive(signal);
      channel.maintainMemory(selector, { force: true });
      break;
    }
    case 'memory.clear':
    case 'memory.retryImages':
    {
      const selector = conversation(payload);
      await paused(
        endpoint === 'memory.clear'
          ? '正在清空此会话记忆'
          : '正在重新获取清晰图片并理解',
        async () => {
          currentAccount(payload);
          if (endpoint === 'memory.clear') {
            channel.memory.clear(selector);
            store.resetSessions(selector);
          } else {
            const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
            await channel.memory.enrich(selector, runner, worker, combined, {
              retryFailed: endpoint === 'memory.retryImages',
            });
          }
        },
        selector
      );
      break;
    }
  }
  assertLive(signal);
  return status();
}
