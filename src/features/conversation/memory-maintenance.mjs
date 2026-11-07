import { eligible, publicError } from '../../shared/contracts.mjs';
import { identity } from '../../storage/keys.mjs';
import { memoryText } from '../memory/conversation-memory.mjs';
import { matches } from './helpers.mjs';

export function scheduleMemoryMaintenance(channel, selector) {
  if (channel.closed || channel.fault) return;
  channel.memoryPending.set(identity([selector.accountId, selector.chatType, selector.peerId]), selector);
  queueMicrotask(() => channel.drain());
}

export function checkMemoryPressure(channel) {
  if (channel.closed || channel.fault) return;
  const status = channel.transport.status(),
    accountId = status.account?.id;
  if (!status.online || !accountId) return;
  for (const peer of channel.store.conversations(accountId)) {
    if (
      !eligible(channel.store.settings(accountId), peer) ||
      [...channel.pauses.values()].some((pause) => matches(peer, pause.selector))
    )
      continue;
    if (channel.memoryRetries.get(peer.key)?.nextAt > channel.now()) continue;
    try {
      const doc = channel.memory.load(peer);
      if (memoryText(doc).length >= channel.memory.windowChars(peer)) channel.memory.onPressure?.(peer);
      else {
        channel.memoryRetries.delete(peer.key);
        channel.memory.errors.delete(peer.key);
      }
    } catch (error) {
      channel.memory.errors.set(peer.key, publicError(error, '记忆暂时无法读取，原文已保留').message);
    }
  }
}

export async function maintainConversationMemory(channel, selector) {
  const status = channel.transport.status();
  if (
    !status.online ||
    status.account?.id !== selector.accountId ||
    !eligible(channel.store.settings(selector.accountId), selector) ||
    [...channel.pauses.values()].some((pause) => matches(selector, pause.selector))
  )
    return;
  const controller = new AbortController(),
    finished = Promise.withResolvers();
  channel.maintenanceActive = { selector, controller, finished: finished.promise };
  const timeout = setTimeout(() => controller.abort(), channel.timeoutMs);
  timeout.unref?.();
  try {
    try {
      await channel.memory.enrich(selector, channel.runner, channel.transport, controller.signal);
    } catch (error) {
      if (error.code === 'STATE_WRITE_FAILED' || controller.signal.aborted) throw error;
    }
    // A failed durable-fact extraction must not prevent window compaction.
    try {
      channel.longMemory.capture(selector, channel.memory.load(selector));
      if (typeof channel.runner.extractLongTermMemory === 'function')
        await channel.longMemory.extract(selector, channel.runner, controller.signal);
    } catch (error) {
      if (error.code === 'STATE_WRITE_FAILED' || controller.signal.aborted) throw error;
    }
    await channel.memory.compact(selector, channel.runner, controller.signal);
    channel.memoryRetries.delete(identity([selector.accountId, selector.chatType, selector.peerId]));
  } catch (error) {
    if (error.code === 'STATE_WRITE_FAILED') throw error;
    const key = identity([selector.accountId, selector.chatType, selector.peerId]),
      attempts = (channel.memoryRetries.get(key)?.attempts || 0) + 1;
    channel.memoryRetries.set(key, {
      attempts,
      nextAt: channel.now() + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4)),
    });
  } finally {
    clearTimeout(timeout);
    channel.maintenanceActive = null;
    finished.resolve();
  }
}
