import { ChannelError, eligible, messageText, publicError } from './contracts.mjs';
import { identity } from './state.mjs';

export class WechatChannel {
  constructor({ store, runner, transport, now = Date.now, timeoutMs = 180000 }) {
    Object.assign(this, { store, runner, transport, now, timeoutMs });
    this.queue = []; this.closed = false; this.fault = null;
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
      const contextKey = identity([account.id, message.chatType, message.peerId, message.sender.id]);
      const record = { key, contextKey, accountId: account.id, messageId: message.id, peerId: message.peerId,
        sender: message.sender.nickname || message.sender.id, chatType: message.chatType,
        state: 'queued', createdAt: this.now(), updatedAt: this.now() };
      const parsed = messageText(message, account);
      const age = this.now() - message.time * 1000;
      const reason = !Number.isFinite(age) || age < -60000 || age > 600000 ? '消息时间不在最近十分钟内，未补发历史回复'
        : !status.online ? '微信尚未连接，未处理同步期间的历史消息'
        : parsed.reason ?? (this.queue.length >= 100 ? '等待回复的消息过多，当前消息未进入队列' : null);
      if (reason) { this.store.remember(key, this.now(), { ...record, state: 'skipped', reason }); return; }
      record.question = parsed.text;
      this.store.remember(key, this.now(), record);
      this.queue.push({ record, message, text: parsed.text, prompt: settings.prompt });
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
  }
  async process(item) {
    const { record } = item;
    const controller = new AbortController();
    this.active = { ...item, controller };
    const timeout = setTimeout(() => controller.abort(new ChannelError('MODEL_TIMEOUT', '模型处理超时，未继续发送')), this.timeoutMs);
    timeout.unref?.();
    try {
      this.assertAllowed(item);
      this.store.update(record, { state: 'generating' });
      const result = await this.runner.run({ text: item.text, group: item.message.chatType === 'group', prompt: item.prompt,
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
    } finally { clearTimeout(timeout); this.active = undefined; }
  }
  cancel(reason = '自动回复已暂停，任务已取消') {
    this.active?.controller.abort(new ChannelError('CANCELLED', reason));
    for (const item of this.queue.splice(0)) this.store.update(item.record, { state: 'cancelled', reason });
  }
  async whenIdle() { while (this.running) await this.running; }
  async close() { this.closed = true; this.cancel('插件已停止，未自动重放未完成任务'); await this.whenIdle(); }
  summary() { return { queued: this.queue.length, active: this.active?.record.key ?? null, fault: this.fault }; }
}
