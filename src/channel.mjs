import { ChannelError, eligible, messageText, publicError } from './contracts.mjs';
import { identity } from './state.mjs';
import { ConversationMemory, memoryText } from './memory.mjs';
import { simpleReminder } from './scheduler.mjs';
import { conversationTaskTool, mediaReplyTool } from './conversation-tools.mjs';
import { LongTermMemory } from './long-term-memory.mjs';
import { MediaLibrary } from './media-library.mjs';
import { conversationMemoryTool } from './memory-tool.mjs';

const matches = (record, selector) => !selector || ['accountId', 'chatType', 'peerId'].every(field => selector[field] === undefined || record[field] === selector[field]) &&
  (!selector.mediaOnly || !!record.replyMedia) && (!selector.assetIds || selector.assetIds.includes(record.replyMedia?.id));

export class WechatChannel {
  constructor({ store, runner, transport, memory, longMemory, library, now = Date.now, random = Math.random, timeoutMs = 180000 }) {
    Object.assign(this, { store, runner, transport, now, random, timeoutMs });
    this.queue = []; this.closed = false; this.fault = null; this.pauses = new Map();
    this.memoryPending = new Map(); this.memory = memory ?? new ConversationMemory(store, { now }); store.memory = this.memory;
    this.longMemory = longMemory ?? new LongTermMemory(store, { now });
    this.library = library ?? new MediaLibrary(store, { now });
    this.memory.seed();
    this.longMemory.onPending = selector => this.maintainMemory(selector);
    this.memory.onAppend = (selector, entry) => this.longMemory.capture(selector, [entry]);
    this.memory.onPressure = selector => this.maintainMemory(selector);
  }
  nextThreshold(config) { return config.intervalMode === 'fixed' ? config.fixedMessages : config.minMessages + Math.floor(Math.max(0, Math.min(0.999999999, this.random())) * (config.maxMessages - config.minMessages + 1)); }
  maintainMemory(selector) {
    if (this.closed || this.fault) return;
    this.memoryPending.set(identity([selector.accountId, selector.chatType, selector.peerId]), selector);
    queueMicrotask(() => this.drain());
  }
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
      const persona = this.store.conversationPersona(account.id, message.chatType, message.peerId);
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
      const parsed = messageText(message, account, { mode, persona });
      if (message.message?.some(segment => segment.data?.resourceId)) this.maintainMemory(record);
      if (mode === 'participate' && !parsed.trigger) {
        const current = this.store.progress(account.id, message.chatType, message.peerId);
        const valid = Number.isInteger(current.target) && (config.intervalMode === 'fixed' ? current.target === config.fixedMessages : current.target >= config.minMessages && current.target <= config.maxMessages);
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
        this.queue.push({ record, message, mode, config, ambient: true, text: '请根据当前群聊内容，自然接上正在讨论的话题，给出一次简短回应。', prompt: settings.prompt });
        this.drain(); return;
      }
      const reason = parsed.reason ?? (this.queue.length >= 100 ? '等待回复的消息过多，当前消息未进入队列' : null);
      if (reason) {
        const question = message.message?.filter(segment => segment.type === 'text').map(segment => segment.data?.text || '').join('').slice(0, 12000);
        this.store.remember(key, this.now(), { ...record, question, state: 'skipped', reason }, observation); return;
      }
      record.question = parsed.text;
      record.trigger = parsed.trigger;
      const directMode = mode === 'participate' ? parsed.trigger === 'nickname' ? 'nickname' : 'default' : mode;
      record.mode = directMode;
      if (mode === 'participate') {
        // A direct request answers the room now; an already queued ambient
        // reply is redundant. Keep other direct requests and other rooms.
        const redundant = this.queue.filter(item => item.ambient && matches(item.record, record));
        this.queue = this.queue.filter(item => !redundant.includes(item));
        for (const item of redundant) this.store.update(item.record, { state: 'cancelled', reason: '群成员已直接呼叫 Agent，本轮主动参与并入直接回复' });
        observation.progress = { count: 0, target: this.nextThreshold(config) };
      }
      this.store.remember(key, this.now(), record, observation);
      this.queue.push({ record, message, mode: directMode, config, text: parsed.text, prompt: settings.prompt, memorySnapshot: this.memory.snapshot(record, key) });
      this.maintenanceActive?.controller.abort(new ChannelError('YIELD_TO_REPLY', '正在优先处理直接呼叫，记忆稍后继续整理'));
      this.drain();
    } catch (error) { this.fail(error); }
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
          const [key, selector] = this.memoryPending.entries().next().value; this.memoryPending.delete(key);
          await this.processMemory(selector);
        }
      }
    })().catch(error => this.fail(error)).finally(() => {
      this.running = undefined;
      if ((this.queue.length || this.memoryPending.size) && !this.closed && !this.fault) this.drain();
    });
  }
  assertAllowed(item) {
    const status = this.transport.status();
    if (this.closed || this.fault || !status.online || status.account?.id !== item.record.accountId || !eligible(this.store.settings(item.record.accountId), item.message))
      throw new ChannelError('AUTH_CHANGED', '微信连接或会话授权已变更，未继续回复');
    if ([...this.pauses.values()].some(pause => matches(item.record, pause.selector))) throw new ChannelError('AUTH_CHANGED', '当前会话正在应用设置，未继续发送');
    const current = this.store.conversationSettings(item.record.accountId, item.message.chatType, item.message.peerId);
    if (item.scheduled && item.scheduled.source === 'chat' && current.allowChatTasks === false)
      throw new ChannelError('AUTH_CHANGED', '这个会话已关闭聊天定时任务，未发送');
    if (!item.scheduled && ['mode', 'intervalMode', 'fixedMessages', 'minMessages', 'maxMessages'].some(key => current[key] !== item.config[key]))
      throw new ChannelError('AUTH_CHANGED', '该会话的回复模式已变更，旧任务未继续回复');
    if (this.now() - item.record.createdAt > 600000) throw new ChannelError('AUTH_CHANGED', '消息等待时间过长，未补发旧话题');
    if (item.scheduled && this.now() - item.scheduled.nextRunAt > 600000) throw new ChannelError('AUTH_CHANGED', '定时任务等待超过十分钟，未补发过期提醒');
  }
  context(item) {
    let history = this.store.history(item.record.accountId, item.message.chatType, item.message.peerId, item.mode === 'participate' ? 40 : 1000);
    if (item.mode !== 'participate') {
      const current = history.findIndex(entry => entry.key === item.record.key || entry.messageId === item.message.id);
      // If the trigger has aged out of the retained window, protocol timestamps
      // cannot prove ordering. Never substitute newer messages for its history.
      history = current >= 0 ? history.slice(0, current) : [];
    }
    return history;
  }
  async processMemory(selector) {
    const status = this.transport.status();
    if (!status.online || status.account?.id !== selector.accountId || !eligible(this.store.settings(selector.accountId), selector) || [...this.pauses.values()].some(pause => matches(selector, pause.selector))) return;
    const controller = new AbortController(), finished = Promise.withResolvers();
    this.maintenanceActive = { selector, controller, finished: finished.promise };
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs); timeout.unref?.();
    try {
      await this.memory.enrich(selector, this.runner, this.transport, controller.signal);
      this.longMemory.capture(selector, this.memory.load(selector));
      if (typeof this.runner.extractLongTermMemory === 'function') await this.longMemory.extract(selector, this.runner, controller.signal);
      await this.memory.compact(selector, this.runner, controller.signal);
    }
    catch (error) { if (error.code === 'STATE_WRITE_FAILED') throw error; }
    finally { clearTimeout(timeout); this.maintenanceActive = null; finished.resolve(); }
  }
  submitScheduled(task, signal) {
    if (this.closed || this.fault || this.queue.length >= 100) return Promise.reject(new ChannelError('TASK_QUEUE_FULL', '回复队列暂不可用，定时任务未进入发送阶段'));
    const complete = Promise.withResolvers(), record = { key: task.recordKey, contextKey: identity([task.accountId, task.chatType, task.peerId, 'scheduled']),
      accountId: task.accountId, chatType: task.chatType, peerId: task.peerId, senderId: task.senderId, sender: task.senderName,
      messageId: task.recordKey, question: '定时任务：' + task.content, state: 'queued', mode: 'scheduled', taskId: task.id, createdAt: this.now(), updatedAt: this.now() };
    const message = { id: task.recordKey, chatType: task.chatType, peerId: task.peerId, sender: { id: task.senderId }, message: [] };
    this.store.add(record);
    const cancel = () => {
      if (this.active?.record.key === record.key) this.active.controller.abort(signal.reason);
      const index = this.queue.findIndex(item => item.record.key === record.key);
      if (index >= 0) { this.queue.splice(index, 1); this.store.update(record, { state: 'cancelled', reason: '定时任务已取消，未发送' }); complete.resolve(record); }
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.queue.push({ record, message, mode: 'scheduled', config: this.store.conversationSettings(task.accountId, task.chatType, task.peerId),
      scheduled: task, text: task.content, prompt: this.store.settings(task.accountId).prompt, externalSignal: signal, complete });
    if (signal.aborted) cancel();
    this.drain(); return complete.promise.finally(() => signal.removeEventListener('abort', cancel));
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
      item.externalSignal?.throwIfAborted();
      this.store.update(record, { state: 'generating' });
      let result;
      let selectedMedia;
      const persona = this.store.conversationPersona(record.accountId, record.chatType, record.peerId);
      const scope = { accountId: record.accountId, chatType: record.chatType, peerId: record.peerId, senderId: record.senderId,
        senderName: record.sender, source: 'chat', requestKey: record.key, requestedAt: record.createdAt,
        incomingMentions: (item.message.message || []).filter(segment => segment.type === 'at' && segment.data.qq !== record.accountId).map(segment => ({ id: segment.data.qq, name: segment.data.name || '' })) };
      const reminder = !item.ambient && !item.scheduled && item.config.allowChatTasks !== false && this.scheduler
        ? simpleReminder(item.text, [persona.name, ...persona.aliases], record.createdAt) : null;
      if (item.scheduled?.kind === 'message') result = { text: item.scheduled.content };
      else if (reminder) {
        this.assertAllowed(item); controller.signal.throwIfAborted();
        if (record.chatType === 'group' && reminder.audience === 'sender') reminder.targets = await this.scheduler.resolveTargets([{ id: record.senderId, name: record.sender }], scope, controller.signal);
        const task = this.scheduler.create(reminder, scope);
        this.store.update(record, { createdTaskIds: [task.id] });
        const when = this.now() - record.createdAt < 5000 ? reminder.delayLabel + '后' : new Date(task.nextRunAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        result = { text: `好，${when}提醒${reminder.audience === 'everyone' ? '大家' : '你'}。` };
      } else {
        const history = this.context(item);
        await this.memory.enrich(record, this.runner, this.transport, controller.signal);
        const currentMemory = this.memory.load(record);
        this.longMemory.capture(record, currentMemory);
        if (item.mode === 'participate' && !history.some(entry => entry.direction === 'incoming' && !entry.mediaOnly && entry.text?.trim()) && !currentMemory.entries.some(entry => entry.attachments?.some(image => image.description))) {
          this.store.update(record, { state: 'skipped', reason: '最近群聊没有可理解的文字，本轮未生成回复' }); return;
        }
        await this.memory.compact(record, this.runner, controller.signal);
        let doc = item.memorySnapshot || this.memory.snapshot(record);
        // Preserve the receive-time boundary while attaching descriptions that
        // were just learned from the exact same images.
        const latest = this.memory.load(record);
        if (doc.generation !== latest.generation) throw new ChannelError('MEMORY_CHANGED', '记忆已清空，已取消旧上下文回复');
        doc.entries = doc.entries.map(entry => ({ ...entry, attachments: currentMemory.entries.find(value => value.key === entry.key)?.attachments || entry.attachments }));
        if (item.memorySnapshot) {
          const keys = new Set(doc.entries.map(entry => entry.key));
          const preceding = this.store.history(record.accountId, record.chatType, record.peerId, 1000).filter(entry => entry.direction === 'outgoing' && keys.has(entry.sourceKey) && !keys.has(entry.key));
          doc.entries.push(...preceding);
        }
        const lookupSnapshot = doc;
        doc = await this.memory.fitSnapshot(doc, this.runner, controller.signal);
        const currentImage = currentMemory.entries.find(entry => entry.key === record.key);
        const imageContext = currentImage?.attachments?.map(image => image.description || image.error || '图像理解已关闭或尚未完成，不能猜测画面').join('\n');
        const tools = !item.ambient && !item.scheduled && this.scheduler && item.config.allowChatTasks !== false
          ? [conversationTaskTool(this.scheduler, scope, () => { controller.signal.throwIfAborted(); this.assertAllowed(item); }, item.text)] : [];
        const library = this.library.list(record.accountId, { limit: 1 });
        const lastMedia = this.store.data.records.findLast(value => matches(value, record) && value.state === 'sent' && value.replyMedia);
        const sinceMedia = lastMedia ? history.filter(entry => entry.direction === 'incoming' && entry.observedAt > lastMedia.updatedAt).length + 1 : Infinity;
        const requestedImage = /表情包|发(?:一)?(?:张|个).{0,12}(?:图|表情)|配图|图片回复/u.test(item.text);
        if (library.settings.enabled && library.counts.enabled && (requestedImage || sinceMedia >= library.settings.minGapMessages && this.random() * 100 < library.settings.probability))
          tools.push(mediaReplyTool(this.library, scope, () => { controller.signal.throwIfAborted(); this.assertAllowed(item); }, value => {
            selectedMedia = value; this.store.update(record, { replyMedia: { id: value.asset.id, name: value.asset.name, kind: value.asset.kind, description: value.asset.description } });
          }));
        const onDemand = item.config.memoryMode === 'on-demand';
        if (onDemand) tools.push(conversationMemoryTool(this.memory, this.longMemory, scope, () => { controller.signal.throwIfAborted(); this.assertAllowed(item); }, { snapshot: lookupSnapshot }));
        const longMemory = onDemand ? '' : this.longMemory.prompt(record);
        result = await this.runner.run({ text: item.text + (imageContext ? `\n\n当前消息的图像理解：\n${imageContext}` : ''),
          group: item.message.chatType === 'group', mode: item.mode, prompt: item.prompt, persona, history, memory: [longMemory, memoryText(doc)].filter(Boolean).join('\n\n'), tools,
          speaker: { id: record.senderId, name: record.sender }, account: this.transport.status().account,
          allowEmptyReply: () => !!selectedMedia,
          signal: controller.signal, onSession: id => this.store.update(record, { sessionId: id }) });
        if (selectedMedia) result.text = typeof this.runner.polishReply === 'function' ? await this.runner.polishReply(selectedMedia.caption, item.text, controller.signal, persona, { prompt: item.prompt }) : selectedMedia.caption;
      }
      clearTimeout(timeout);
      controller.signal.throwIfAborted();
      this.assertAllowed(item);
      const message = result.text ? [{ type: 'text', data: { text: result.text } }] : [];
      let replyMedia;
      if (selectedMedia) {
        const asset = await this.library.prepareSendContent(record.accountId, selectedMedia.asset.id, controller.signal);
        replyMedia = { id: asset.id, name: asset.name, kind: asset.kind, description: asset.description };
        message.push({ type: asset.kind === 'sticker' ? 'face' : 'image', data: { base64: asset.data, mediaType: asset.mediaType } });
      }
      if (!message.length) throw new ChannelError('MODEL_EMPTY', '本轮没有可发送的文字或图片');
      controller.signal.throwIfAborted();
      this.assertAllowed(item);
      const targets = item.scheduled?.targets?.length ? await this.scheduler.resolveTargets(item.scheduled.targets, scope, controller.signal) : [];
      if (targets.length) message.unshift(...targets.map(target => ({ type: 'at', data: { qq: target.id, name: target.name } })));
      controller.signal.throwIfAborted(); this.assertAllowed(item);
      if (replyMedia) this.library.resolveAsset(record.accountId, replyMedia.id);
      // Commit intent before crossing the side-effect boundary.
      this.store.update(record, { state: 'sending', reply: result.text, ...(targets.length ? { replyMentions: targets } : {}), ...(replyMedia ? { replyMedia } : {}) });
      const sent = await this.transport.send({ accountId: record.accountId, chatType: item.message.chatType, peerId: item.message.peerId,
        message }, controller.signal);
      const ids = sent?.serverMessageIds;
      if (sent?.delivery !== 'server-ack' || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id || id === '0'))
        throw new ChannelError('SEND_UNKNOWN', '没有收到可核对的微信服务端回执，结果不明，未自动重发', { delivery: 'unknown' });
      // Even cancellation after a network write must preserve a real ACK.
      this.store.update(record, { state: 'sent', acknowledgedMessageIds: ids, reason: undefined });
      if (result.sessionId) this.store.saveSession(record.contextKey, result.sessionId);
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
          : cancelled ? (controller.signal.reason instanceof ChannelError ? controller.signal.reason.message : error instanceof ChannelError ? error.message : '任务已取消，未继续回复')
          : publicError(error, '处理失败，未发送微信回复').message
      });
    } finally { clearTimeout(timeout); this.active = undefined; item.complete?.resolve(record); finished.resolve(); }
  }
  cancel(reason = '自动回复已暂停，任务已取消', selector, { resetProgress = true } = {}) {
    if (this.maintenanceActive && matches(this.maintenanceActive.selector, selector)) this.maintenanceActive.controller.abort(new ChannelError('CANCELLED', reason));
    if (this.active && matches(this.active.record, selector)) this.active.controller.abort(new ChannelError('CANCELLED', reason));
    const cancelled = this.queue.filter(item => matches(item.record, selector));
    this.queue = this.queue.filter(item => !matches(item.record, selector));
    for (const item of cancelled) { this.store.update(item.record, { state: 'cancelled', reason }); item.complete?.resolve(item.record); }
    if (resetProgress) this.store.resetProgress(selector?.accountId, selector?.chatType, selector?.peerId);
  }
  async whenIdle(selector) {
    if (selector) {
      while (this.active && matches(this.active.record, selector)) await this.active.finished;
      while (this.maintenanceActive && matches(this.maintenanceActive.selector, selector)) await this.maintenanceActive.finished;
    }
    else { this.drain(); while (this.running) await this.running; }
  }
  async close() { this.closed = true; this.cancel('插件已停止，未自动重放未完成任务', undefined, { resetProgress: false }); await this.whenIdle(); }
  summary(selector) {
    return { queued: this.queue.filter(item => matches(item.record, selector)).length,
      active: this.active && matches(this.active.record, selector) ? this.active.record.key : null, fault: this.fault };
  }
}
