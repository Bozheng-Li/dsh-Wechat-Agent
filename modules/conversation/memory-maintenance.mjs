import { ChannelError, eligible, publicError } from "../../shared/contracts.mjs";
import { identity } from "../../backend/storage/keys.mjs";
import { memoryText } from "../memory/conversation/store.mjs";
import { matches } from "./helpers.mjs";
import { randomUUID } from 'node:crypto';

export function scheduleMemoryMaintenance(channel, selector, { force = false } = {}) {
  if (channel.closed || channel.fault) {
    if (force) throw new ChannelError('MEMORY_UNAVAILABLE', '记忆整理暂不可用，请检查微信插件状态');
    return;
  }
  const key = identity([selector.accountId, selector.chatType, selector.peerId]);
  if (force) {
    if (!eligible(channel.store.settings(selector.accountId), selector))
      throw new ChannelError('AUTH_CHANGED', '此会话未授权，不能安排记忆压缩');
    channel.memory.load(selector);
    channel.memoryRetries.delete(key);
    channel.memory.errors.delete(key);
    if (channel.memory.compacting.has(key)) return;
    channel.memoryForced.set(key, randomUUID());
    if (channel.maintenanceActive?.stage === 'extraction' && matches(channel.maintenanceActive.selector, selector))
      channel.maintenanceActive.controller.abort(new ChannelError('YIELD_TO_COMPRESSION', '已优先安排手动压缩，长期记忆稍后继续提取'));
  }
  if (channel.memoryRetries?.get(key)?.nextAt > channel.now()) return;
  channel.memoryPending.set(key, selector);
  queueMicrotask(() => channel.drain());
}

export function checkMemoryPressure(channel) {
  if (channel.closed || channel.fault) return;
  const status = channel.transport.status(),
    accountId = status.account?.id;
  if (!status.online || !accountId) return;
  if (channel.memoryScan) {
    const scan = channel.memoryScan;
    if (scan.accountId !== accountId || scan.cancelled) {
      scan.cancelled = true;
      scan.nextAccountId = accountId;
    }
    return scan.promise;
  }
  const scan = { accountId, cancelled: false, nextAccountId: null };
  channel.memoryScan = scan;
  scan.promise = (async () => {
    for (;;) {
      // Status IPC stays cheap, and incoming replies get a turn before disk work.
      await new Promise(resolve => setImmediate(resolve));
      if (memoryScanAllowed(channel, scan)) await scanConversationMemory(channel, scan);
      const nextAccountId = scan.nextAccountId;
      scan.nextAccountId = null;
      const current = channel.transport.status();
      if (!nextAccountId || channel.closed || channel.fault || !current.online || current.account?.id !== nextAccountId) break;
      scan.accountId = nextAccountId;
      scan.cancelled = false;
    }
  })().catch(error => channel.fail(error)).finally(() => {
    if (channel.memoryScan === scan) channel.memoryScan = undefined;
  });
  return scan.promise;
}

function memoryScanAllowed(channel, scan) {
  const status = channel.transport.status();
  return !scan.cancelled && !channel.closed && !channel.fault && status.online && status.account?.id === scan.accountId;
}

async function scanConversationMemory(channel, scan) {
  const accountId = scan.accountId, peers = channel.store.conversationSelectors(accountId).filter(peer => peer.authorized);
  if (!peers.length || !channel.store.settings(accountId).enabled) return;
  let pending, pendingError;
  if (typeof channel.runner.extractLongTermMemory === 'function') {
    try { pending = channel.longMemory.state(accountId).pending; }
    catch (error) { pendingError = error; }
  }
  let index = 0;
  while (index < peers.length && memoryScanAllowed(channel, scan)) {
    // Recheck authorization and pauses after every yield, without rebuilding UI rows.
    const settings = channel.store.settings(accountId), pauses = [...channel.pauses.values()], started = performance.now();
    let batch = 0;
    while (index < peers.length && batch++ < 8) {
      const peer = peers[index++];
      if (eligible(settings, peer) && !pauses.some(pause => matches(peer, pause.selector)) &&
          !(channel.memoryRetries.get(peer.key)?.nextAt > channel.now())) {
        try {
          const doc = channel.memory.load(peer);
          if (pendingError) throw pendingError;
          const pendingFacts = !!pending?.[peer.key]?.entries.length;
          if (channel.memoryForced.has(peer.key) || memoryText(doc).length >= channel.memory.windowChars(peer) || pendingFacts)
            channel.memory.onPressure?.(peer);
          else {
            channel.memoryRetries.delete(peer.key);
            channel.memory.errors.delete(peer.key);
          }
        } catch (error) {
          channel.memory.errors.set(peer.key, publicError(error, '记忆暂时无法读取，原文已保留').message);
        }
      }
      if (performance.now() - started >= 8) break;
    }
    if (index < peers.length) await new Promise(resolve => setImmediate(resolve));
  }
}

export async function maintainConversationMemory(channel, selector) {
  const status = channel.transport.status();
  const key = identity([selector.accountId, selector.chatType, selector.peerId]);
  const previousRetry = channel.memoryRetries.get(key);
  const forceRequest = channel.memoryForced.get(key), force = !!forceRequest;
  if (
    channel.memoryRetries.get(identity([selector.accountId, selector.chatType, selector.peerId]))?.nextAt > channel.now() ||
    (!status.online && !force) ||
    status.account?.id !== selector.accountId ||
    !eligible(channel.store.settings(selector.accountId), selector) ||
    [...channel.pauses.values()].some((pause) => matches(selector, pause.selector))
  )
    return;
  const controller = new AbortController(),
    finished = Promise.withResolvers();
  channel.maintenanceActive = { selector, controller, stage: 'compression', finished: finished.promise };
  channel.memoryRetries.delete(key);
  let stage = 'compression';
  const timeout = setTimeout(() => controller.abort(new ChannelError('MEMORY_TIMEOUT',
    stage === 'compression' ? '记忆压缩等待模型超时，原文已保留，将自动重试' : '长期记忆提取等待模型超时，未丢弃待整理原文')),
    force ? Math.max(channel.timeoutMs, 300000) : channel.timeoutMs);
  timeout.unref?.();
  try {
    let extractionFailure;
    try {
      await channel.memory.enrich(selector, channel.runner, channel.transport, controller.signal);
    } catch (error) {
      if (error.code === 'STATE_WRITE_FAILED' || controller.signal.aborted) throw error;
    }
    // Capture original evidence before compaction, but perform window work
    // before a slow durable-fact model call can consume the shared timeout.
    try {
      channel.longMemory.capture(selector, channel.memory.load(selector));
    } catch (error) {
      if (error.code === 'STATE_WRITE_FAILED' || controller.signal.aborted) throw error;
      extractionFailure = error;
    }
    await channel.memory.compact(selector, channel.runner, controller.signal, { force });
    if (forceRequest && channel.memoryForced.get(key) === forceRequest) channel.memoryForced.delete(key);
    stage = 'extraction';
    channel.maintenanceActive.stage = stage;
    if (!extractionFailure && typeof channel.runner.extractLongTermMemory === 'function') {
      try { await channel.longMemory.extract(selector, channel.runner, controller.signal); }
      catch (error) {
        if (error.code === 'STATE_WRITE_FAILED' || controller.signal.aborted) throw error;
        extractionFailure = error;
      }
    }
    // Window compaction can succeed while durable facts remain pending. Keep
    // the failure visible and retry it even if the window is now below limit.
    if (extractionFailure) throw extractionFailure;
    channel.memoryRetries.delete(key);
  } catch (error) {
    if (error.code === 'STATE_WRITE_FAILED') throw error;
    const yielded = ['YIELD_TO_REPLY', 'YIELD_TO_COMPRESSION'].includes(error.code);
    const attempts = (previousRetry?.attempts || 0) + (yielded ? 0 : 1);
    channel.memoryRetries.set(key, {
      attempts,
      kind: yielded ? 'yield' : stage,
      nextAt: channel.now() + (error.code === 'YIELD_TO_COMPRESSION' ? 0 : yielded ? 1000 :
        Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4))),
    });
  } finally {
    clearTimeout(timeout);
    channel.maintenanceActive = null;
    finished.resolve();
  }
}
