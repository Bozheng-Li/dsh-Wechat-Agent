import { matches } from './helpers.mjs';
import { receiveMessage } from './incoming.mjs';
import { observeManualReply } from './incoming.mjs';
import { enqueueNaturalReply } from './incoming.mjs';
import { processReply } from './reply.mjs';
import { scheduleMemoryMaintenance } from './memory-maintenance.mjs';
import { checkMemoryPressure } from './memory-maintenance.mjs';
import { maintainConversationMemory } from './memory-maintenance.mjs';
import { ChannelError, eligible, publicError } from '../../shared/contracts.mjs';
import { identity } from '../../storage/keys.mjs';
import { ConversationMemory } from '../memory/conversation-memory.mjs';

import { LongTermMemory } from '../memory/long-term-memory.mjs';
import { MediaLibrary } from '../media/library.mjs';

import { AgentWorkbench } from '../workbench/service.mjs';

import { NaturalChat, NATURAL_REASONS, naturalConfigKey } from './natural-chat.mjs';

import { ImageMemory } from '../memory/image-memory.mjs';

export class WechatChannel {
  constructor({
    store,
    runner,
    transport,
    memory,
    longMemory,
    library,
    now = Date.now,
    random = Math.random,
    timeoutMs = 180000,
  }) {
    Object.assign(this, { store, runner, transport, now, random, timeoutMs });
    this.queue = [];
    this.closed = false;
    this.fault = null;
    this.pauses = new Map();
    this.memoryPending = new Map();
    this.memory = memory ?? new ConversationMemory(store, { now });
    store.memory = this.memory;
    this.longMemory = longMemory ?? new LongTermMemory(store, { now });
    this.imageMemory = this.memory.images ?? new ImageMemory(store, { now });
    this.library = library ?? new MediaLibrary(store, { now });
    this.workbench = new AgentWorkbench(this);
    this.memory.seed();
    this.longMemory.onPending = (selector) => this.maintainMemory(selector);
    this.memory.onAppend = (selector, entry) => this.longMemory.capture(selector, [entry]);
    this.memory.onPressure = (selector) => this.maintainMemory(selector);
    this.memoryRetries = new Map();
    this.memory.retryState = this.memoryRetries;
    this.natural = new NaturalChat(this);
    this.imageMemory.start();
    this.memoryTimer = setInterval(() => this.checkMemoryPressure(), 15000);
    this.memoryTimer.unref?.();
    queueMicrotask(() => this.checkMemoryPressure());
  }
  nextThreshold(config) {
    return config.intervalMode === 'fixed'
      ? config.fixedMessages
      : config.minMessages +
          Math.floor(Math.max(0, Math.min(0.999999999, this.random())) * (config.maxMessages - config.minMessages + 1));
  }
  maintainMemory(selector) {
    return scheduleMemoryMaintenance(this, selector);
  }
  checkMemoryPressure() {
    return checkMemoryPressure(this);
  }
  pause(reason, selector) {
    const token = {};
    this.pauses.set(token, { selector, reason });
    return () => {
      this.pauses.delete(token);
    };
  }
  receive(message, accountId) {
    return receiveMessage(this, message, accountId);
  }
  pushDirect(item) {
    const ambient = this.queue.findIndex((waiting) => waiting.ambient && waiting.naturalDecision);
    if (ambient < 0) this.queue.push(item);
    else this.queue.splice(ambient, 0, item);
  }
  cancelNaturalAmbient(selector, reason, { followups = false } = {}) {
    const cancelled = this.queue.filter(
      (item) => (item.ambient || followups) && item.naturalDecision && matches(item.record, selector)
    );
    this.queue = this.queue.filter((item) => !cancelled.includes(item));
    for (const item of cancelled) this.store.update(item.record, { state: 'cancelled', reason });
    if (
      this.active &&
      (this.active.ambient || followups) &&
      this.active.naturalDecision &&
      !this.active.record.sendAttempted &&
      matches(this.active.record, selector)
    )
      this.active.controller.abort(new ChannelError('NATURAL_YIELD', reason));
  }
  receiveManual(message, accountId) {
    return observeManualReply(this, message, accountId);
  }
  enqueueNatural(input) {
    return enqueueNaturalReply(this, input);
  }
  fail(error) {
    this.fault = publicError(error, '消息状态保存失败，自动回复已停止');
    this.active?.controller.abort();
    this.maintenanceActive?.controller.abort();
    for (const item of this.queue) item.complete?.reject(error);
    this.queue.length = 0;
  }
  drain() {
    if (this.running || this.closed || this.fault) return;
    this.running = (async () => {
      while ((this.queue.length || this.memoryPending.size) && !this.closed && !this.fault) {
        if (this.queue.length) await this.process(this.queue.shift());
        else {
          const [key, selector] = this.memoryPending.entries().next().value;
          this.memoryPending.delete(key);
          await this.processMemory(selector);
        }
      }
    })()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.running = undefined;
        if ((this.queue.length || this.memoryPending.size) && !this.closed && !this.fault) this.drain();
      });
  }
  assertAllowed(item) {
    const status = this.transport.status();
    if (
      this.closed ||
      this.fault ||
      !status.online ||
      status.account?.id !== item.record.accountId ||
      !eligible(this.store.settings(item.record.accountId), item.message)
    )
      throw new ChannelError('AUTH_CHANGED', '微信连接或会话授权已变更，未继续回复');
    if ([...this.pauses.values()].some((pause) => matches(item.record, pause.selector)))
      throw new ChannelError('AUTH_CHANGED', '当前会话正在应用设置，未继续发送');
    const current = this.store.conversationSettings(item.record.accountId, item.message.chatType, item.message.peerId);
    if (item.scheduled && item.scheduled.source === 'chat' && current.allowChatTasks === false)
      throw new ChannelError('AUTH_CHANGED', '这个会话已关闭聊天定时任务，未发送');
    if (
      !item.scheduled &&
      ['mode', 'intervalMode', 'fixedMessages', 'minMessages', 'maxMessages'].some(
        (key) => current[key] !== item.config[key]
      )
    )
      throw new ChannelError('AUTH_CHANGED', '该会话的回复模式已变更，旧任务未继续回复');
    if (
      item.config.mode === 'natural' &&
      !item.scheduled &&
      naturalConfigKey(current) !== naturalConfigKey(item.config)
    )
      throw new ChannelError('AUTH_CHANGED', '自然陪聊设置已变更，旧任务未继续回复');
    if (item.naturalDecision) {
      const state = this.store.naturalState(item.record.accountId, item.record.chatType, item.record.peerId);
      if (item.ambient) {
        const reason = this.natural.gate(item.record, current, state, item.record.key);
        if (reason && reason !== 'waiting') {
          item.record.naturalReason = reason;
          throw new ChannelError('NATURAL_PAUSE', NATURAL_REASONS[reason]);
        }
        if (item.naturalRevision !== undefined && state.humanRevision !== item.naturalRevision)
          throw new ChannelError('NATURAL_CONTEXT_CHANGED', '生成期间群聊已有新消息，本轮主动发言已让位，稍后重新判断');
      } else {
        if (
          this.now() > item.naturalDecision.followupUntil ||
          state.followup.until !== item.naturalDecision.followupUntil
        )
          throw new ChannelError('NATURAL_PAUSE', '连续对话窗口已结束或新的呼叫已接管，本轮未自动接话');
        if (state.deliveryBlockedKey || state.lastManualAt > item.record.createdAt)
          throw new ChannelError(
            'NATURAL_PAUSE',
            state.deliveryBlockedKey ? NATURAL_REASONS.delivery : NATURAL_REASONS.manual
          );
      }
    }
    if (!item.scheduled && this.now() - item.record.createdAt > 600000)
      throw new ChannelError('AUTH_CHANGED', '消息等待时间过长，未补发旧话题');
  }
  context(item) {
    const ambient = item.mode === 'participate' || (item.ambient && item.naturalDecision);
    let history = this.store.history(
      item.record.accountId,
      item.message.chatType,
      item.message.peerId,
      ambient ? 40 : 1000
    );
    if (!ambient) {
      const current = history.findIndex(
        (entry) => entry.key === item.record.key || entry.messageId === item.message.id
      );
      // If the trigger has aged out of the retained window, protocol timestamps
      // cannot prove ordering. Never substitute newer messages for its history.
      history = current >= 0 ? history.slice(0, current) : [];
    }
    return history;
  }
  async processMemory(selector) {
    return maintainConversationMemory(this, selector);
  }
  submitScheduled(task, signal) {
    if (this.closed || this.fault || this.queue.length >= 100)
      return Promise.reject(new ChannelError('TASK_QUEUE_FULL', '回复队列暂不可用，定时任务未进入发送阶段'));
    const complete = Promise.withResolvers(),
      record = {
        key: task.recordKey,
        contextKey: identity([task.accountId, task.chatType, task.peerId, 'scheduled']),
        accountId: task.accountId,
        chatType: task.chatType,
        peerId: task.peerId,
        senderId: task.senderId,
        sender: task.senderName,
        messageId: task.recordKey,
        question: (task.recovery ? '管理员恢复：' : '定时任务：') + task.content,
        state: 'queued',
        mode: 'scheduled',
        taskId: task.recovery ? undefined : task.id,
        ...(task.recovery ? { recoveryOf: task.recovery.sourceKey, recoveryKinds: task.recovery.kinds } : {}),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    const message = {
      id: task.recordKey,
      chatType: task.chatType,
      peerId: task.peerId,
      sender: { id: task.senderId },
      message: [],
    };
    this.store.add(record);
    const cancel = () => {
      if (this.active?.record.key === record.key) this.active.controller.abort(signal.reason);
      const index = this.queue.findIndex((item) => item.record.key === record.key);
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.store.update(record, { state: 'cancelled', reason: '定时任务已取消，未发送' });
        complete.resolve(record);
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.queue.push({
      record,
      message,
      mode: 'scheduled',
      config: this.store.conversationSettings(task.accountId, task.chatType, task.peerId),
      scheduled: task,
      text: task.content,
      prompt: this.store.settings(task.accountId).prompt,
      externalSignal: signal,
      complete,
    });
    if (signal.aborted) cancel();
    this.drain();
    return complete.promise.finally(() => signal.removeEventListener('abort', cancel));
  }
  async process(item) {
    return processReply(this, item);
  }
  cancel(reason = '自动回复已暂停，任务已取消', selector, { resetProgress = true, resetNatural = false } = {}) {
    if (this.maintenanceActive && matches(this.maintenanceActive.selector, selector))
      this.maintenanceActive.controller.abort(new ChannelError('CANCELLED', reason));
    if (this.active && matches(this.active.record, selector))
      this.active.controller.abort(new ChannelError('CANCELLED', reason));
    const cancelled = this.queue.filter((item) => matches(item.record, selector));
    this.queue = this.queue.filter((item) => !matches(item.record, selector));
    for (const item of cancelled) {
      this.store.update(item.record, { state: 'cancelled', reason });
      item.complete?.resolve(item.record);
    }
    if (resetProgress)
      this.store.resetProgress(selector?.accountId, selector?.chatType, selector?.peerId, { resetNatural });
  }
  async whenIdle(selector) {
    if (selector) {
      while (this.active && matches(this.active.record, selector)) await this.active.finished;
      while (this.maintenanceActive && matches(this.maintenanceActive.selector, selector))
        await this.maintenanceActive.finished;
    } else {
      this.drain();
      while (this.running) await this.running;
    }
  }
  async close() {
    clearInterval(this.memoryTimer);
    this.natural.stop();
    this.imageMemory.close();
    this.closed = true;
    this.cancel('插件已停止，未自动重放未完成任务', undefined, { resetProgress: false });
    await this.whenIdle();
  }
  summary(selector) {
    return {
      queued: this.queue.filter((item) => matches(item.record, selector)).length,
      active: this.active && matches(this.active.record, selector) ? this.active.record.key : null,
      fault: this.fault,
    };
  }
}
