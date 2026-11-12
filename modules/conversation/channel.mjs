import { promptText } from "../../prompts/loader.mjs";
import { timeLimitMs } from '../../shared/time-settings.mjs';
import { matches } from "./helpers.mjs";
import { receiveMessage } from "./incoming.mjs";
import { observeManualReply } from "./incoming.mjs";
import { enqueueNaturalReply } from "./incoming.mjs";
import { processReply } from "./reply.mjs";
import { scheduleMemoryMaintenance } from "./memory-maintenance.mjs";
import { checkMemoryPressure } from "./memory-maintenance.mjs";
import { maintainConversationMemory } from "./memory-maintenance.mjs";
import { ChannelError, eligible, messageText, nicknameMentioned, publicError } from "../../shared/contracts.mjs";
import { identity } from "../../backend/storage/keys.mjs";
import { ConversationMemory } from "../memory/conversation/store.mjs";

import { LongTermMemory } from "../memory/long-term/store.mjs";
import { MediaLibrary } from "../media/library.mjs";
import { WechatStickerService } from '../media/sticker-service.mjs';

import { AgentWorkbench } from "../workbench/service.mjs";

import { NaturalChat, NATURAL_REASONS, naturalConfigKey } from "./natural-chat.mjs";

import { ImageMemory } from "../memory/images/store.mjs";
import { WorkService } from '../work/service.mjs';
import { RemoteService } from '../remote/service.mjs';
import { ExecutionModeService } from '../work/modes/service.mjs';
import { workAdministrator } from '../work/policy.mjs';
import { MomentsService } from '../moments/service.mjs';
import { MomentsAutomation } from '../moments/automation.mjs';
import { PersonMemoryMaintenance } from '../memory/roles/maintenance.mjs';
import { attachExecutionTraces } from '../traces/instrument.mjs';
import { ObjectAuthorization } from '../authorization/service.mjs';

export class WechatChannel {
  get timeoutMs() { return this.timeoutOverride ?? timeLimitMs(this.store, 'conversationTimeoutSeconds'); }
  set timeoutMs(value) { this.timeoutOverride = value; }
  constructor({
    store,
    runner,
    transport,
    memory,
    longMemory,
    library,
    workRunner,
    remoteProviders,
    now = Date.now,
    random = Math.random,
    timeoutMs,
  }) {
    Object.assign(this, { store, runner, transport, now, random, timeoutMs });
    this.queue = [];
    this.workReplies = new Map();
    this.workActive = new Map();
    this.closed = false;
    this.fault = null;
    this.pauses = new Map();
    this.memoryPending = new Map();
    this.memoryForced = new Map();
    this.memory = memory ?? new ConversationMemory(store, { now });
    store.memory = this.memory;
    this.longMemory = longMemory ?? new LongTermMemory(store, { now });
    this.imageMemory = this.memory.images ?? new ImageMemory(store, { now });
    this.library = library ?? new MediaLibrary(store, { now });
    this.stickers = new WechatStickerService(this);
    this.workbench = new AgentWorkbench(this);
    this.work = new WorkService(this, workRunner);
    this.remote = new RemoteService(this, remoteProviders);
    this.moments = new MomentsService(this);
    this.momentsAutomation = new MomentsAutomation(this);
    this.modes = new ExecutionModeService(this);
    this.personMemory = new PersonMemoryMaintenance(this);
    this.memory.seed();
    this.longMemory.onPending = (selector) => this.maintainMemory(selector);
    this.memory.onAppend = (selector, entry) => {
      this.longMemory.capture(selector, [entry]);
      this.personMemory.capture(selector, [entry]);
    };
    this.memory.onPressure = (selector) => this.maintainMemory(selector);
    this.memoryRetries = new Map();
    this.memory.retryState = this.memoryRetries;
    this.memory.pendingState = this.memoryPending;
    this.memory.forcedState = this.memoryForced;
    this.natural = new NaturalChat(this);
    this.authorization = new ObjectAuthorization(this);
    attachExecutionTraces(this);
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
  maintainMemory(selector, options) {
    return scheduleMemoryMaintenance(this, selector, options);
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
  pushWork(item) {
    if (this.closed || this.fault) return;
    const queued = [...this.workReplies.values()].reduce((sum, lane) => sum + lane.queue.length, 0);
    if (queued + this.workActive.size >= 100) {
      this.store.update(item.record, { state: 'failed', reason: '工作回复暂时繁忙，这条消息未新开任务，请稍后再发' });
      return;
    }
    const key = item.record.contextKey;
    let lane = this.workReplies.get(key);
    if (lane) { lane.queue.push({ ...item, workLane: true }); return; }
    lane = { record: item.record, queue: [{ ...item, workLane: true }] };
    this.workReplies.set(key, lane);
    lane.pending = (async () => {
      while (lane.queue.length && !this.closed && !this.fault) await this.process(lane.queue.shift());
    })().catch(error => this.fail(error)).finally(() => this.workReplies.delete(key));
  }
  cancelWorkReplies(reason, selector) {
    for (const active of this.workActive.values()) if (matches(active.record, selector))
      active.controller.abort(new ChannelError('CANCELLED', reason));
    for (const lane of this.workReplies.values()) {
      const cancelled = lane.queue.filter(item => matches(item.record, selector));
      lane.queue = lane.queue.filter(item => !cancelled.includes(item));
      for (const item of cancelled) {
        this.store.update(item.record, { state: 'cancelled', reason }); item.complete?.resolve(item.record);
      }
    }
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
    for (const active of this.workActive.values()) active.controller.abort(error);
    for (const lane of this.workReplies.values()) { for (const item of lane.queue) item.complete?.reject(error); lane.queue.length = 0; }
    this.maintenanceActive?.controller.abort();
    this.personMemory?.cancel();
    for (const item of this.queue) item.complete?.reject(error);
    this.queue.length = 0;
    try { this.work?.cancelAll('消息或工作状态保存失败，已停止执行'); }
    catch { for (const active of this.work?.active?.values() ?? []) active.controller.abort(error); }
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
    if (!item.scheduled && !item.chatInWorkMode && current.executionMode === 'work' &&
        item.message.chatType === 'group' && current.mode === 'nickname') {
      const persona = this.store.conversationPersona(item.record.accountId, item.message.chatType, item.message.peerId);
      const parsed = messageText(item.message, status.account, { mode: 'nickname', persona });
      if (parsed.reason && !(item.modeControl && /^\/mode(?:\s|$)/i.test(item.text)))
        throw new ChannelError('AUTH_CHANGED', '群聊唤醒昵称或呼叫方式已变化，旧工作回复已取消');
    }
    if (item.chatInWorkMode) {
      const persona = this.store.conversationPersona(item.record.accountId, item.message.chatType, item.message.peerId);
      if (workAdministrator(this.store, item.record) ||
          !nicknameMentioned(item.text, [persona.name, ...persona.aliases, status.account.nickname]))
        throw new ChannelError('AUTH_CHANGED', '发起人的工作权限或唤醒昵称已变化，旧聊天回复已取消');
    }
    if (item.workForAdministrator && !workAdministrator(this.store, item.record))
      throw new ChannelError('AUTH_CHANGED', '发起人的管理员工作权限已撤销，未继续工作回复');
    if (current.executionMode === 'work' && !item.workRouting && !item.chatInWorkMode && !item.modeControl && !item.workCommand && !item.remoteCommand &&
        !item.scheduled?.workJobId && item.scheduled?.kind !== 'message' && !item.scheduled?.retryText)
      throw new ChannelError('AUTH_CHANGED', '当前是工作模式，未继续生成聊天回复');
    if (item.remoteQueryAuthorized) this.remote.assertAllowed(item.record, item.externalSignal);
    if (item.modeControlAuthorized) this.modes.assertAllowed(item.record, item.externalSignal);
    if (item.workRequestAuthorized) this.work.assertAllowed(item.record, item.externalSignal);
    if (item.scheduled?.workJobId) {
      const job = this.work.owned(item.scheduled.workJobId, item.record);
      this.work.assertAllowed(job, item.externalSignal, { retryId: item.scheduled.workRetryId });
      if (item.scheduled.workProgress && job.state !== 'running')
        throw new ChannelError('WORK_PROGRESS_ENDED', '工作已结束，未发送旧进度');
    }
    if (item.scheduled && item.scheduled.source === 'chat' && current.allowChatTasks === false)
      throw new ChannelError('AUTH_CHANGED', '这个会话已关闭聊天定时任务，未发送');
    if (
      !item.scheduled &&
      ['mode', 'intervalMode', 'fixedMessages', 'minMessages', 'maxMessages', 'executionMode'].some(
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
        contextKey: identity([task.accountId, task.chatType, task.peerId, task.workProgress ? 'work-progress' : task.workJobId ? 'work-result' : 'scheduled', ...(task.workJobId ? [task.senderId] : [])]),
        accountId: task.accountId,
        chatType: task.chatType,
        peerId: task.peerId,
        senderId: task.senderId,
        sender: task.senderName,
        messageId: task.recordKey,
        question: task.workRetryId ? `补发工作文件：${task.workJobId}` : (task.workProgress ? '工作进度：' : task.workJobId ? '工作结果：' : task.recovery ? promptText("conversation/templates.json", "channel-question-1") : promptText("conversation/templates.json", "channel-question-2")) + task.content,
        state: 'queued',
        mode: 'scheduled',
        taskId: task.recovery ? undefined : task.id,
        ...(task.workJobId ? { workJobId: task.workJobId } : {}),
        ...(task.workProgress ? { workProgress: true } : {}),
        ...(task.workRetryId ? { workDeliveryRetryId: task.workRetryId } : {}),
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
  cancelExecutionMode(selector, reason) {
    this.work.cancelAll(reason, selector);
    this.cancelWorkReplies(reason, selector);
    const outdated = item => (!item.scheduled || item.scheduled.workJobId) && matches(item.record, selector);
    if (this.active && outdated(this.active)) this.active.controller.abort(new ChannelError('CANCELLED', reason));
    const cancelled = this.queue.filter(outdated);
    this.queue = this.queue.filter(item => !outdated(item));
    for (const item of cancelled) {
      this.store.update(item.record, { state: 'cancelled', reason });
      item.complete?.resolve(item.record);
    }
  }
  cancel(reason = '自动回复已暂停，任务已取消', selector, { resetProgress = true, resetNatural = false } = {}) {
    if (this.memoryScan) {
      this.memoryScan.cancelled = true;
      this.memoryScan.nextAccountId = null;
    }
    this.personMemory?.cancel(selector);
    this.work?.cancelAll(reason, selector);
    this.cancelWorkReplies(reason, selector);
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
    for (const [key, pending] of this.memoryPending) if (matches(pending, selector)) {
      this.memoryPending.delete(key);
      this.memoryForced.delete(key);
    }
    if (this.maintenanceActive && matches(this.maintenanceActive.selector, selector))
      this.memoryForced.delete(identity([this.maintenanceActive.selector.accountId,
        this.maintenanceActive.selector.chatType, this.maintenanceActive.selector.peerId]));
    for (const scope of Object.values(this.memory.index?.conversations ?? {})) if (matches(scope, selector)) {
      this.memoryForced.delete(scope.key);
      this.memoryRetries.delete(scope.key);
    }
    if (resetProgress)
      this.store.resetProgress(selector?.accountId, selector?.chatType, selector?.peerId, { resetNatural });
  }
  async whenIdle(selector) {
    if (selector) {
      while (this.memoryScan) await this.memoryScan.promise;
      while (this.active && matches(this.active.record, selector)) await this.active.finished;
      while (this.maintenanceActive && matches(this.maintenanceActive.selector, selector))
        await this.maintenanceActive.finished;
    } else {
      do {
        if (this.memoryScan) await this.memoryScan.promise;
        this.drain();
        while (this.running) await this.running;
      } while (this.memoryScan);
    }
    for (;;) {
      const pending = [...this.workReplies.values()].filter(lane => matches(lane.record, selector)).map(lane => lane.pending);
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    await this.work?.whenIdle(selector);
    if (!selector) await this.momentsAutomation?.whenIdle();
  }
  async close() {
    clearInterval(this.memoryTimer);
    this.natural.stop();
    this.imageMemory.close();
    this.closed = true;
    this.authorization?.close();
    const stickersClosing = this.stickers.close();
    const peopleClosing = this.personMemory?.close();
    const momentsClosing = this.momentsAutomation?.close();
    this.cancel('插件已停止，未自动重放未完成任务', undefined, { resetProgress: false });
    await this.work.close();
    await this.whenIdle();
    await momentsClosing;
    await peopleClosing;
    await stickersClosing;
    await this.authorization?.whenIdle().catch(() => {});
    await this.traces?.close();
    this.authorization?.restore();
  }
  summary(selector) {
    return {
      queued: this.queue.filter((item) => matches(item.record, selector)).length +
        [...this.workReplies.values()].reduce((sum, lane) => sum + lane.queue.filter(item => matches(item.record, selector)).length, 0),
      active: this.active && matches(this.active.record, selector) ? this.active.record.key : null,
      workReplies: [...this.workActive.values()].filter(value => matches(value.record, selector)).map(value => value.record.key),
      fault: this.fault,
    };
  }
}
