import { createHash } from 'node:crypto';
import { ChannelError, MAX_TEXT, eligible, emptyNaturalState } from '../../shared/contracts.mjs';
import { publicText } from '../../wechat/ai/public-output.ts';

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

export function naturalDecisionInstructions(decision = {}) {
  const preferences = {
    quiet: '安静：只接明显相关、有实际内容或明确接续你的话，较少主动开题。',
    balanced: '自然：有可接的内容就参与，冷场时可偶尔提一个符合角色兴趣的小话题。',
    lively: '活跃：可以更积极接话和开题，也尊重无人回应、严肃讨论及已结束的话题。',
  };
  return `本轮是自然陪聊判断。后台已经处理时间、条数、冷却与授权；你只判断这次是否值得说话，不另算间隔，也不因为获得机会就必须发言。
参与偏好为${preferences[decision.temperament] || preferences.balanced}这只影响开口意愿，不替换当前会话人设的名字、性格和说话方式。
${decision.trigger === 'followup' ? '当前成员可能在接续刚才与你的对话。相关追问、回应或继续玩梗可以接上；换话题、转向别人或没有接续关系时选择 skip，reason 为 no_followup。' : `这是由${decision.trigger === 'timer' ? '时间' : '新消息条数'}提供的一次参与机会。${decision.smartSkip ? '没有新内容、话题已结束或重复、别人正在对其他成员说话时保持安静。' : '有可靠话题就简短参与，没有可说的内容仍可保持安静。'}接最近的新话题；适合开题时使用当前角色的兴趣，不重答已解决的问题或追问没人回应的话。`}
用自己的角色口吻接话，不做群聊报告，不解释本轮判断。内容只依据本群提供的资料，不编造群内事件、最新新闻或未读图片。
只输出一个 JSON 对象，不附加说明或代码围栏：
发言：{"action":"reply","text":"完整的可发送正文"}
安静：{"action":"skip","reason":"no_topic","text":""}
skip 的 reason 只可取 no_topic、unrelated、repeated、busy、closed、no_followup 中的一个值。
text 是合法 JSON 字符串：换行写成 \\n，双引号写成 \\"，每个反斜杠写成 \\\\，不使用未转义的数学反斜杠；公式可以用 Unicode 或纯文本表达，保留完整答案。
管理员的语言、固定开头、结尾和署名只应用于 reply 的 text 字段，并保留指定的独立首末行；skip 不生成正文或署名。
最外层必须是 JSON 对象，从 { 开始、以 } 结束。前面的正文呈现规则仅约束 text，本轮最外层协议优先，不能用固定开头或正文代替 JSON。`;
}

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
          config.mode !== 'natural' ||
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
