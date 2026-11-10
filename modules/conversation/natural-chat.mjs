import { createHash } from 'node:crypto';
import { ChannelError, MAX_TEXT, eligible, emptyNaturalState } from "../../shared/contracts.mjs";
import { publicText } from "../../backend/wechat/ai/public-output.ts";

export const NATURAL_REASONS = Object.freeze({
  no_topic: '最近没有适合接话的新内容，本轮保持安静',
  unrelated: '当前话题与这个角色无关，本轮保持安静',
  repeated: '相似话题已经说过，本轮避免重复',
  busy: '群友正在讨论其他人的话题，本轮不插话',
  closed: '当前话题已经结束，本轮保持安静',
  no_followup: '这条消息没有接续刚才的对话，未自动回应',
  rest: '当前不在主动参与的活跃时段，直接唤醒仍可回复',
  cooldown: '刚刚已经发言，本轮主动参与暂缓',
  manual: '当前微信账号正在人工接话，主动参与暂缓',
  unanswered: '连续主动发言无人接话，等待群内新互动',
  delivery: '此前发送结果尚未核实，主动参与已暂停，请先核对处理记录',
  waiting: '已有回复正在处理，主动参与等待或合并',
});

export function naturalConfigKey(config) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.mode,
        config.intervalMode,
        config.fixedMessages,
        config.minMessages,
        config.maxMessages,
        config.natural,
      ])
    )
    .digest('hex');
}

export function parseNaturalDecision(raw) {
  let value;
  try {
    value = JSON.parse(
      publicText(String(raw))
        .trim()
        .replace(/^```(?:json)?\s*|\s*```$/g, '')
    );
  } catch {}
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['reply', 'skip'].includes(value.action) ||
    typeof value.text !== 'string' ||
    (value.action === 'reply' && !value.text.trim()) ||
    (value.action === 'skip' &&
      (!['no_topic', 'unrelated', 'repeated', 'busy', 'closed', 'no_followup'].includes(value.reason) ||
        value.text.trim()))
  )
    throw new ChannelError('NATURAL_DECISION_INVALID', '模型没有返回有效的陪聊判断，本轮未发送，请在处理记录中核对');
  return { action: value.action, reason: value.action === 'skip' ? value.reason : null, text: value.text.trim() };
}

export { naturalDecisionInstructions } from "../../prompts/conversation/decision.mjs";

const sameRoom = (record, selector) =>
  ['accountId', 'chatType', 'peerId'].every((key) => record[key] === selector[key]);
const minuteOfDay = (now) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return (
    Number(parts.find((part) => part.type === 'hour').value) * 60 +
    Number(parts.find((part) => part.type === 'minute').value)
  );
};
const timeMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export function withinNaturalHours(config, now) {
  if (!config.activeHours) return true;
  const minute = minuteOfDay(now),
    start = timeMinutes(config.startTime),
    end = timeMinutes(config.endTime);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Provides opportunities; every actual message still uses WechatChannel. */
export class NaturalChat {
  constructor(channel) {
    this.channel = channel;
    this.store = channel.store;
    this.now = channel.now;
    this.random = channel.random;
    this.initialized = new Set();
    this.stopped = false;
  }
  start() {
    if (this.timer || this.channel.closed) return;
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
  disconnected() {
    this.initialized.clear();
  }
  delay(config, state) {
    const value = config.natural;
    const draw = Math.max(0, Math.min(0.999999999, this.random()));
    const minutes =
      value.intervalMode === 'fixed'
        ? value.fixedMinutes
        : value.minMinutes + Math.floor(draw * (value.maxMinutes - value.minMinutes + 1));
    return minutes * 60000 * Math.min(4, Math.max(1 + state.unanswered, 2 ** state.backoff));
  }
  state(selector, config) {
    let state = this.store.naturalState(selector.accountId, selector.chatType, selector.peerId);
    const key = naturalConfigKey(config);
    const interval = config.natural;
    const scheduleKey = createHash('sha256')
      .update(
        JSON.stringify([
          interval.intervalMode,
          interval.intervalMode === 'fixed' ? interval.fixedMinutes : [interval.minMinutes, interval.maxMinutes],
        ])
      )
      .digest('hex');
    if (state.configKey !== key) {
      // Character and topic preferences must not erase delivery uncertainty,
      // unanswered feedback, cooldowns, or an already scheduled timer.
      state = { ...state, configKey: key, followup: emptyNaturalState().followup };
      const pending = [this.channel.active, ...this.channel.queue].some(
        (item) => item?.record.key === state.pendingKey && sameRoom(item.record, selector)
      );
      if (state.pendingKey && !pending) {
        const record = this.store.data.records.find(
          (record) => record.key === state.pendingKey && sameRoom(record, selector)
        );
        if (['unknown', 'partial', 'sending'].includes(record?.state)) state.deliveryBlockedKey = record.key;
        state.pendingKey = null;
      }
    }
    if (!state.nextCheckAt || (state.scheduleKey && state.scheduleKey !== scheduleKey))
      state.nextCheckAt = this.now() + this.delay(config, state);
    state.scheduleKey = scheduleKey;
    const room = JSON.stringify([selector.accountId, selector.chatType, selector.peerId]);
    if (!this.initialized.has(room)) {
      this.initialized.add(room);
      if (state.pendingKey) {
        const record = this.store.data.records.find(
          (record) => record.key === state.pendingKey && sameRoom(record, selector)
        );
        if (['unknown', 'partial', 'sending'].includes(record?.state)) state.deliveryBlockedKey = record.key;
        state.pendingKey = null;
      }
      // A resumed instance starts a fresh opportunity, never replays downtime.
      if (state.nextCheckAt <= this.now()) state.nextCheckAt = this.now() + this.delay(config, state);
    }
    return state;
  }
  save(selector, state) {
    this.store.setNaturalState(selector.accountId, selector.chatType, selector.peerId, state);
  }
  onHuman(selector, config, parsed) {
    const state = this.state(selector, config);
    state.humanRevision++;
    state.lastIncomingAt = this.now();
    if (state.unanswered || state.backoff) {
      state.unanswered = 0;
      state.backoff = 0;
      state.nextCheckAt = Math.min(state.nextCheckAt, this.now() + this.delay(config, state));
    }
    state.lastReason = null;
    if (parsed.trigger || state.followup.until < this.now()) state.followup = emptyNaturalState().followup;
    return state;
  }
  followupCandidate(state, message, parsed) {
    const followup = state.followup;
    if (
      parsed.trigger ||
      parsed.reason ||
      !parsed.text ||
      !followup.remaining ||
      this.now() > followup.until ||
      (followup.senderId && message.sender.id !== followup.senderId) ||
      message.message.some((segment) => segment.type === 'at') ||
      /^\//.test(parsed.text)
    )
      return false;
    return true;
  }
  onManual(selector, config) {
    const state = this.state(selector, config);
    state.lastManualAt = this.now();
    state.followup = emptyNaturalState().followup;
    state.nextCheckAt = Math.max(state.nextCheckAt, this.now() + config.natural.minGapMinutes * 60000);
    state.lastReason = 'manual';
    return state;
  }
  gate(selector, config, state, ignoreKey) {
    if (state.deliveryBlockedKey) return 'delivery';
    if (!withinNaturalHours(config.natural, this.now())) return 'rest';
    if (state.lastManualAt && this.now() < state.lastManualAt + config.natural.minGapMinutes * 60000) return 'manual';
    if (state.lastSentAt && this.now() < state.lastSentAt + config.natural.minGapMinutes * 60000) return 'cooldown';
    if (state.unanswered >= config.natural.maxUnanswered) return 'unanswered';
    if (
      (this.channel.active &&
        this.channel.active.record.key !== ignoreKey &&
        sameRoom(this.channel.active.record, selector)) ||
      this.channel.queue.some((item) => item.record.key !== ignoreKey && sameRoom(item.record, selector))
    )
      return 'waiting';
    return null;
  }
  opportunityState(config, state, key, reason = null, trigger = 'timer') {
    return {
      ...state,
      pendingKey: reason ? state.pendingKey : key,
      lastCheckAt: this.now(),
      lastReason: reason,
      // A blocked count check or an unrelated followup must not keep pushing
      // the independent timer into the future.
      nextCheckAt:
        trigger === 'timer' || (trigger === 'count' && !reason)
          ? this.now() + this.delay(config, state)
          : state.nextCheckAt,
    };
  }
  after(item, outcome, reply = '', ids = []) {
    const selector = item.record,
      config = this.store.conversationSettings(selector.accountId, selector.chatType, selector.peerId);
    if (
      selector.chatType !== 'group' ||
      config.mode !== 'natural' ||
      (!item.scheduled && naturalConfigKey(config) !== naturalConfigKey(item.config))
    )
      return undefined;
    const state = this.state(selector, config);
    if (state.pendingKey === selector.key) state.pendingKey = null;
    if (outcome === 'sent') {
      if (state.deliveryBlockedKey === selector.key) state.deliveryBlockedKey = null;
      state.lastSentAt = this.now();
      state.backoff = 0;
      state.lastReason = null;
      if (item.ambient && item.naturalDecision)
        state.unanswered = state.humanRevision > item.naturalRevision ? 0 : state.unanswered + 1;
      else state.unanswered = 0;
      if (item.naturalDirect || (item.ambient && item.naturalDecision))
        state.followup = {
          senderId: item.naturalDirect ? selector.senderId : '',
          until: this.now() + config.natural.followupSeconds * 1000,
          remaining: config.natural.followupSeconds ? 3 : 0,
          replyId: ids[0] || '',
          question: item.naturalDirect ? selector.question : '',
          reply: reply.slice(0, MAX_TEXT),
        };
      else if (item.naturalDecision?.trigger === 'followup' && state.followup.until >= this.now())
        state.followup = {
          ...state.followup,
          senderId: selector.senderId,
          replyId: ids[0] || '',
          question: selector.question,
          reply: reply.slice(0, MAX_TEXT),
        };
      state.nextCheckAt = this.now() + this.delay(config, state);
    } else if (['unknown', 'partial'].includes(outcome)) {
      state.deliveryBlockedKey = selector.key;
      state.lastReason = 'delivery';
      state.followup = emptyNaturalState().followup;
    } else if (item.naturalDecision && ['skipped', 'failed'].includes(outcome)) {
      state.lastReason = selector.naturalReason || null;
      if (item.ambient) {
        state.backoff = Math.min(3, state.backoff + 1);
        state.nextCheckAt = this.now() + this.delay(config, state);
      }
    }
    return state;
  }
  tick() {
    if (this.stopped || this.channel.closed || this.channel.fault) return;
    const status = this.channel.transport.status(),
      accountId = status.account?.id;
    if (!status.online || !accountId) {
      this.disconnected();
      return;
    }
    const settings = this.store.settings(accountId);
    if (!settings.enabled) return;
    try {
      for (const peerId of settings.groups) {
        const selector = { accountId, chatType: 'group', peerId },
          config = this.store.conversationSettings(accountId, 'group', peerId);
        if (
          config.mode !== 'natural' || config.executionMode === 'work' ||
          [...this.channel.pauses.values()].some(
            (pause) =>
              !pause.selector ||
              ['accountId', 'chatType', 'peerId'].every(
                (key) => pause.selector[key] === undefined || pause.selector[key] === selector[key]
              )
          )
        )
          continue;
        const before = this.store.naturalState(accountId, 'group', peerId),
          state = this.state(selector, config);
        if (JSON.stringify(before) !== JSON.stringify(state)) this.save(selector, state);
        if (this.now() < state.nextCheckAt || ['delivery', 'unanswered'].includes(this.gate(selector, config, state)))
          continue;
        this.channel.enqueueNatural({ selector, config, state, trigger: 'timer' });
      }
    } catch (error) {
      this.channel.fail(error);
    }
  }
  resume(selector, input) {
    if (input.confirmReviewed !== true)
      throw new ChannelError('NATURAL_CONFIRM_REQUIRED', '请先在微信核对此前发送结果，再确认恢复主动参与');
    const config = this.store.conversationSettings(selector.accountId, selector.chatType, selector.peerId),
      state = this.state(selector, config);
    if (
      selector.chatType !== 'group' ||
      config.mode !== 'natural' ||
      !eligible(this.store.settings(selector.accountId), selector)
    )
      throw new ChannelError('AUTH_CHANGED', '本群当前未启用自然陪聊或自动回复，请重新读取设置');
    if (!state.deliveryBlockedKey || input.blockedKey !== state.deliveryBlockedKey)
      throw new ChannelError('NATURAL_CHANGED', '待核对的发送记录已变化，请重新读取后再恢复');
    if ([this.channel.active, ...this.channel.queue].some((item) => item && sameRoom(item.record, selector)))
      throw new ChannelError('NATURAL_BUSY', '本群仍有回复正在处理，结束后再核对并恢复');
    state.deliveryBlockedKey = null;
    state.pendingKey = null;
    state.lastReason = null;
    state.unanswered = 0;
    state.backoff = 0;
    state.followup = emptyNaturalState().followup;
    state.nextCheckAt = this.now() + this.delay(config, state);
    this.save(selector, state);
  }
  summary(selector) {
    const config = this.store.conversationSettings(selector.accountId, selector.chatType, selector.peerId);
    if (selector.chatType !== 'group' || config.mode !== 'natural') return null;
    const state = this.store.naturalState(selector.accountId, selector.chatType, selector.peerId),
      status = this.channel.transport.status();
    const reason = !eligible(this.store.settings(selector.accountId), selector)
      ? '自动回复已暂停或本群未授权'
      : !status.online || status.account?.id !== selector.accountId
        ? '微信离线，恢复后重新安排机会'
        : NATURAL_REASONS[this.gate(selector, config, state)] || NATURAL_REASONS[state.lastReason] || null;
    return {
      nextCheckAt: state.nextCheckAt || null,
      lastSentAt: state.lastSentAt || null,
      unanswered: state.unanswered,
      deliveryBlockedKey: state.deliveryBlockedKey,
      backoff: state.backoff,
      pending: !!state.pendingKey,
      paused:
        !eligible(this.store.settings(selector.accountId), selector) ||
        !status.online ||
        status.account?.id !== selector.accountId ||
        !!state.deliveryBlockedKey ||
        state.unanswered >= config.natural.maxUnanswered,
      reason,
      followupUntil: state.followup.remaining && state.followup.until > this.now() ? state.followup.until : null,
    };
  }
}
