import { ChannelError, eligible, messageText, publicError } from './contracts.mjs';
import { identity } from './state.mjs';

const matches = (record, selector) => !selector || ['accountId', 'chatType', 'peerId'].every(field => selector[field] === undefined || record[field] === selector[field]);

export class WechatChannel {
  constructor({ store, runner, transport, now = Date.now, random = Math.random, timeoutMs = 180000 }) {
    Object.assign(this, { store, runner, transport, now, random, timeoutMs });
    this.queue = []; this.closed = false; this.fault = null; this.pauses = new Map();
  }
  nextThreshold(config) { return config.minMessages + Math.floor(Math.max(0, Math.min(0.999999999, this.random())) * (config.maxMessages - config.minMessages + 1)); }
  pause(reason, selector) {
    const token = {};
    this.pauses.set(token, { selector, reason });
    return () => { this.pauses.delete(token); };
  }
  receive(message, accountId) {
    if (this.closed || this.fault || message?.direction !== 'incoming' || !message.id || !message.peerId || !message.sender?.id || !['private', 'group'].includes(message.chatType)) return;
    const status = this.transport.status();
    const account = status.account;
    if (!account || account.id !== accountId || message.sender.id === account.id) return;
    try {
      const key = identity([account.id, message.chatType, message.peerId, message.serverMessageId || message.id]);
      if (Object.hasOwn(this.store.data.seen, key)) return;
      const settings = this.store.settings(account.id);
      if (!eligible(settings, message)) { this.store.remember(key, this.now()); return; }
      const config = this.store.conversationSettings(account.id, message.chatType, message.peerId);
      const mode = message.chatType === 'group' ? config.mode : 'default';
      const persona = this.store.persona();
      const contextKey = identity([account.id, message.chatType, message.peerId, mode === 'participate' ? '__group_participation__' : message.sender.id]);
      const record = { key, contextKey, accountId: account.id, messageId: message.id, peerId: message.peerId,
        senderId: message.sender.id, sender: message.sender.nickname || message.sender.id, chatType: message.chatType, mode, agentName: persona.name,
        state: 'queued', createdAt: this.now(), updatedAt: this.now() };
      const age = this.now() - message.time * 1000;
      const boundaryReason = !Number.isFinite(age) || age < -60000 || age > 600000 ? '消息时间不在最近十分钟内，未补发历史回复'
        : !status.online ? '微信尚未连接，未处理同步期间的历史消息'
        : [...this.pauses.values()].find(pause => matches(record, pause.selector))?.reason;
      if (boundaryReason) { this.store.remember(key, this.now(), { ...record, state: 'skipped', reason: boundaryReason }); return; }
      const observation = { accountId: account.id, message };
      if (mode === 'participate') {
        const current = this.store.progress(account.id, message.chatType, message.peerId);
        const valid = Number.isInteger(current.target) && current.target >= config.minMessages && current.target <= config.maxMessages;
        const target = valid ? current.target : this.nextThreshold(config);
        const count = (valid ? current.count : 0) + 1;
        if (count < target) {
          this.store.remember(key, this.now(), undefined, { ...observation, progress: { count, target } }); return;
        }
        const progress = { count: 0, target: this.nextThreshold(config) };
        const waiting = this.queue.find(item => item.mode === 'participate' && matches(item.record, record));
        if (waiting) {
          // One queued turn per group absorbs new batches while another group
          // or the current model is busy. It will read the latest room window.
          this.store.remember(key, this.now(), undefined, { ...observation, progress });
          this.store.update(waiting.record, { batches: (waiting.record.batches || 1) + 1, reason: '等待期间的新一轮群聊已合并，将根据最新话题回复一次' });
          return;
        }
        record.question = `主动参与群聊：本轮收到 ${target} 条新消息`;
        record.batches = 1;
        if (this.queue.length >= 100) {
          this.store.remember(key, this.now(), { ...record, state: 'skipped', reason: '等待回复的消息过多，本轮群聊未进入队列' }, { ...observation, progress }); return;
        }
        this.store.remember(key, this.now(), record, { ...observation, progress });
        this.queue.push({ record, message, mode, config, text: '请根据当前群聊内容，自然接上正在讨论的话题，给出一次简短回应。', prompt: settings.prompt });
        this.drain(); return;
      }
      const parsed = messageText(message, account, { mode, persona });
      const reason = parsed.reason ?? (this.queue.length >= 100 ? '等待回复的消息过多，当前消息未进入队列' : null);
      if (reason) {
        const question = message.message?.filter(segment => segment.type === 'text').map(segment => segment.data?.text || '').join('').slice(0, 12000);
        this.store.remember(key, this.now(), { ...record, question, state: 'skipped', reason }, observation); return;
      }
      record.question = parsed.text;
      this.store.remember(key, this.now(), record, observation);
      this.queue.push({ record, message, mode, config, text: parsed.text, prompt: settings.prompt });
      this.drain();
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    this.fault = publicError(error, '消息状态保存失败，自动回复已停止');
    this.active?.controller.abort();
    this.queue.length = 0;
  }
  drain() {
    if (this.running || this.closed || this.fault) return;
    this.running = (async () => {
      while (this.queue.length && !this.closed && !this.fault) {
        const item = this.queue.shift();
        await this.process(item);
      }
    })().catch(error => this.fail(error)).finally(() => {
      this.running = undefined;
      if (this.queue.length && !this.closed && !this.fault) this.drain();
    });
  }
  assertAllowed(item) {
    const status = this.transport.status();
    if (this.closed || this.fault || !status.online || status.account?.id !== item.record.accountId || !eligible(this.store.settings(item.record.accountId), item.message))
      throw new ChannelError('AUTH_CHANGED', '微信连接或会话授权已变更，未继续回复');
    const current = this.store.conversationSettings(item.record.accountId, item.message.chatType, item.message.peerId);
    if (current.mode !== item.config.mode || current.minMessages !== item.config.minMessages || current.maxMessages !== item.config.maxMessages)
      throw new ChannelError('AUTH_CHANGED', '该会话的回复模式已变更，旧任务未继续回复');
    if (this.now() - item.record.createdAt > 600000) throw new ChannelError('AUTH_CHANGED', '消息等待时间过长，未补发旧话题');
  }
  context(item) {
    let history = this.store.history(item.record.accountId, item.message.chatType, item.message.peerId, item.mode === 'participate' ? 40 : 1000);
    if (item.mode !== 'participate') {
      const current = history.findIndex(entry => entry.key === item.record.key || entry.messageId === item.message.id);
      // If the trigger has aged out of the retained window, protocol timestamps
      // cannot prove ordering. Never substitute newer messages for its history.
      history = current >= 0 ? history.slice(0, current) : [];
      if (item.message.chatType === 'group') history = history.filter(entry => entry.direction === 'outgoing' ? entry.replyTo === item.record.senderId : entry.senderId === item.record.senderId);
    }
    return history.slice(-40);
  }
  async process(item) {
    const { record } = item;
    const controller = new AbortController();
    const finished = Promise.withResolvers();
    this.active = { ...item, controller, finished: finished.promise };
    const timeout = setTimeout(() => controller.abort(new ChannelError('MODEL_TIMEOUT', '模型处理超时，未继续发送')), this.timeoutMs);
    timeout.unref?.();
    try {
      this.assertAllowed(item);
      const history = this.context(item);
      if (item.mode === 'participate' && !history.some(entry => entry.direction === 'incoming' && !entry.mediaOnly && entry.text?.trim())) {
        this.store.update(record, { state: 'skipped', reason: '最近群聊没有可理解的文字，本轮未生成回复' }); return;
      }
      this.store.update(record, { state: 'generating' });
      const result = await this.runner.run({ text: item.text, group: item.message.chatType === 'group', mode: item.mode, prompt: item.prompt, history,
        sessionId: this.store.session(record.contextKey), signal: controller.signal,
        onSession: id => this.store.update(record, { sessionId: id }) });
      clearTimeout(timeout);
      controller.signal.throwIfAborted();
      this.assertAllowed(item);
      // Commit intent before crossing the side-effect boundary.
      this.store.update(record, { state: 'sending', reply: result.text });
      const sent = await this.transport.send({ chatType: item.message.chatType, peerId: item.message.peerId,
        message: [{ type: 'text', data: { text: result.text } }] }, controller.signal);
      const ids = sent?.serverMessageIds;
      if (sent?.delivery !== 'server-ack' || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id || id === '0'))
        throw new ChannelError('SEND_UNKNOWN', '没有收到可核对的微信服务端回执，结果不明，未自动重发', { delivery: 'unknown' });
      // Even cancellation after a network write must preserve a real ACK.
      this.store.update(record, { state: 'sent', acknowledgedMessageIds: ids, reason: undefined });
      this.store.saveSession(record.contextKey, result.sessionId);
    } catch (error) {
      if (error?.code === 'STATE_WRITE_FAILED') throw error;
      this.store.forgetSession(record.contextKey);
      const details = error?.details ?? {};
      const ids = Array.isArray(details.acknowledgedMessageIds) ? details.acknowledgedMessageIds : [];
      const uncertain = details.delivery === 'unknown';
      const cancelled = controller.signal.aborted || error?.code === 'AUTH_CHANGED';
      this.store.update(record, {
        state: ids.length ? 'partial' : uncertain ? 'unknown' : cancelled ? 'cancelled' : 'failed',
        ...(ids.length ? { acknowledgedMessageIds: ids } : {}),
        reason: ids.length ? '部分消息已获得服务端回执，其余未确认，未自动重发'
          : uncertain ? '发送结果不明，未自动重发，请先在微信核对'
          : cancelled ? (controller.signal.reason instanceof ChannelError ? controller.signal.reason.message : '任务已取消，未继续回复')
          : publicError(error, '处理失败，未发送微信回复').message
      });
    } finally { clearTimeout(timeout); this.active = undefined; finished.resolve(); }
  }
  cancel(reason = '自动回复已暂停，任务已取消', selector, { resetProgress = true } = {}) {
    if (this.active && matches(this.active.record, selector)) this.active.controller.abort(new ChannelError('CANCELLED', reason));
    const cancelled = this.queue.filter(item => matches(item.record, selector));
    this.queue = this.queue.filter(item => !matches(item.record, selector));
    for (const item of cancelled) this.store.update(item.record, { state: 'cancelled', reason });
    if (resetProgress) this.store.resetProgress(selector?.accountId, selector?.chatType, selector?.peerId);
  }
  async whenIdle(selector) {
    if (selector) { while (this.active && matches(this.active.record, selector)) await this.active.finished; }
    else while (this.running) await this.running;
  }
  async close() { this.closed = true; this.cancel('插件已停止，未自动重放未完成任务', undefined, { resetProgress: false }); await this.whenIdle(); }
  summary(selector) {
    return { queued: this.queue.filter(item => matches(item.record, selector)).length,
      active: this.active && matches(this.active.record, selector) ? this.active.record.key : null, fault: this.fault };
  }
}
