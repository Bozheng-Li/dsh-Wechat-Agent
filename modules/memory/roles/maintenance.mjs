import { createHash, randomUUID } from 'node:crypto';
import { ChannelError, eligible } from '../../../shared/contracts.mjs';
import { ROLE_CARD_UPDATE_PROMPT, roleCardUpdateInput } from '../../../prompts/memory/role-card.mjs';
import { validateRoleCardProposal } from './profile-extraction.mjs';
import { roleCardSettingsRevision } from '../../../shared/role-card-settings.mjs';
import { sourceFingerprint } from '../../../backend/storage/role-card-schedule.mjs';
import { momentPersonSources, validMomentPersonSource } from './moments.mjs';
import { readMomentsWithMemory } from '../../moments/read.mjs';
import { personAuthorized, authorizationEpoch, assertAuthorizationEpoch } from '../../../shared/authorization.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const urgentUpdate = text => /叫我|别(?:再|这样)?叫|不要(?:再|这样)?叫|更正|纠正|改叫|我.{0,8}(?:改喝|不再|现在.{0,12}(?:喜欢|讨厌|习惯|住在))|记住|记一下/u.test(text);
const matches = (source, scope) => !scope || (!scope.accountId || source.accountId === scope.accountId) &&
  (!scope.chatType || source.chatType === scope.chatType) && (!scope.peerId || source.peerId === scope.peerId) &&
  (!scope.personId || source.senderId === scope.personId);

/** Background agents have their own queue, cancellation and retry lifecycle.
 * No model call here enters or waits on the conversation reply queue. */
export class PersonMemoryMaintenance {
  constructor(channel, { scanIntervalMs = 3600000, maxConcurrent = 2 } = {}) {
    this.channel = channel; this.cards = channel.store.roleCards; this.now = channel.now;
    this.active = new Map(); this.jobs = new Map(); this.closed = false; this.maxConcurrent = maxConcurrent;
    this.scanIntervalMs = scanIntervalMs;
    this.nextScanAt = 0;
    this.nextMomentsScanAt = 0;
    this.wake(0);
  }
  available(accountId) {
    const status = this.channel.transport.status();
    return !this.closed && !this.channel.closed && !this.channel.fault && status.online &&
      status.account?.id === accountId && this.channel.store.settings(accountId).enabled &&
      !this.channel.authorization?.isCleaning(accountId);
  }
  rememberError(input, error) {
    try { this.cards.errors.set(this.cards.identity(input), error.message); } catch {}
  }
  capture(scope, entries, { generation } = {}) {
    if (!this.available(scope.accountId)) return;
    let observed = false;
    for (const entry of entries) {
      if (entry.direction !== 'incoming' || !entry.senderId || entry.senderId === scope.accountId ||
          !personAuthorized(this.channel.store, scope.accountId, entry.senderId) ||
          scope.chatType === 'private' && entry.senderId !== scope.peerId ||
          !entry.key || typeof entry.text !== 'string' || !entry.text.trim() || entry.mediaOnly ||
          !Number.isFinite(entry.time) || entry.time > this.now()) continue;
      const person = { accountId: scope.accountId, personId: entry.senderId };
      try {
        if (!eligible(this.channel.store.settings(scope.accountId), scope)) continue;
        const source = { id: digest([scope.accountId, scope.chatType, scope.peerId, entry.key]),
          accountId: scope.accountId, chatType: scope.chatType, peerId: scope.peerId,
          conversationName: scope.name || scope.peerId, messageKey: entry.key, messageId: entry.messageId || entry.key,
          senderId: entry.senderId, senderName: String(entry.senderName || entry.sender || entry.senderId).slice(0, 80),
          time: entry.time, text: entry.text.slice(0, 12000),
          generation: generation ?? this.channel.memory.load(scope).generation };
        if (entry.text.length > source.text.length) source.truncated = true;
        if (this.cards.observe(person, source, this.now(), { urgent: urgentUpdate(source.text) })) {
          observed = true;
          this.jobs.set(this.cards.identity(person), person);
        }
      } catch (error) { this.rememberError(person, error); }
    }
    if (observed) this.wake(0);
  }
  captureMoments(accountId, result, query) {
    if (!this.available(accountId)) return;
    let observed = 0;
    for (const source of momentPersonSources(accountId, result, query, this.now())) {
      if (!personAuthorized(this.channel.store, accountId, source.senderId)) continue;
      const person = { accountId, personId: source.senderId };
      try {
        if (this.cards.observe(person, source, this.now(), { urgent: urgentUpdate(source.text) })) {
          observed++;
          this.jobs.set(this.cards.identity(person), person);
        }
      } catch (error) { this.rememberError(person, error); }
    }
    if (observed) this.wake(0);
    return observed;
  }
  scanMoments(accountId) {
    if (this.momentsScan || typeof this.channel.runner.extractRoleCard !== 'function' || !this.available(accountId) || !this.cards.settings().enabled ||
        this.channel.transport.status().momentsReadReady !== true || typeof this.channel.transport.readMoments !== 'function') return;
    const controller = new AbortController(); this.momentsController = controller;
    const check = () => {
      controller.signal.throwIfAborted();
      if (!this.available(accountId) || !this.cards.settings().enabled)
        throw new ChannelError('ROLE_CARD_SOURCE_CHANGED', '朋友圈采集已停止，未写入其他账号的资料');
    };
    const interval = this.cards.settings().trigger === 'time' ? this.cards.settings().intervalMinutes * 60000 : this.scanIntervalMs;
    this.nextMomentsScanAt = this.now() + interval;
    this.momentsScan = (async () => {
      let cursor; const seen = new Set(), threshold = this.now() - 7 * 86400000;
      for (let page = 0; page < 3; page++) {
        check();
        const result = await readMomentsWithMemory(this.channel, { accountId, scopeKey: 'person-memory:' + accountId,
          query: { action: 'timeline', limit: 20, ...(cursor ? { cursor } : {}) } }, controller.signal, check);
        if (result?.accountId !== accountId || result.source !== 'wechat-sns-live' || result.action !== 'timeline' || !Array.isArray(result.items))
          throw new ChannelError('ROLE_CARD_SOURCE_CHANGED', '朋友圈采集结果不完整，未继续读取');
        cursor = result.nextCursor;
        if (!cursor || !result.items.length && !result.authorizationFilteredCount ||
            result.items.length && result.items.every(post => post.createdAt * 1000 < threshold)) break;
        if (typeof cursor !== 'string' || seen.has(cursor)) throw new ChannelError('ERR_MOMENTS_CURSOR', '朋友圈采集分页没有推进');
        seen.add(cursor);
      }
      this.cards.errors.delete('scan:moments');
    })().catch(error => {
      if (!controller.signal.aborted && this.available(accountId)) {
        this.cards.errors.set('scan:moments', error.message);
        this.nextMomentsScanAt = this.now() + Math.min(interval, 5 * 60000);
      }
    }).finally(() => {
      this.momentsScan = null; this.momentsController = null; this.wake(0);
    });
    return this.momentsScan;
  }
  configure(settings, revision) {
    const before = this.channel.store.roleCardSettingsView();
    const result = this.channel.store.setRoleCardSettings(settings, revision);
    if (before.revision === result.revision) return result;
    // Frequency changes only cancel the independent memory agents.
    for (const active of this.active.values()) if (!active.manual)
      active.controller.abort(new ChannelError('ROLE_CARD_SETTINGS_CHANGED', '自动整理设置已变更，原话保留并重新累计'));
    this.momentsController?.abort(new ChannelError('ROLE_CARD_SETTINGS_CHANGED', '自动整理设置已变更，朋友圈采集已停止'));
    this.nextMomentsScanAt = 0;
    clearTimeout(this.wakeTimer); this.wakeTimer = null;
    const accounts = new Set([...Object.keys(this.channel.store.data.accounts), ...[...this.jobs.values()].map(scope => scope.accountId)]);
    for (const accountId of accounts) for (const view of this.cards.list(accountId, { includePending: true })) {
      try {
        this.cards.schedule(view.scope, this.now());
        if (view.pendingCount || view.manualPending) this.jobs.set(view.roleId, view.scope);
      } catch (error) { this.rememberError(view.scope, error); }
    }
    this.wake(0);
    return result;
  }
  state(view) {
    if (!this.cards.settings().enabled && !view.manualPending) return 'disabled';
    if (this.active.has(view.roleId)) return 'updating';
    if (view.nextAt == null) return view.pendingCount ? 'collecting' : 'ready';
    return view.error ? 'retrying' : view.nextAt > this.now() ? 'scheduled' : 'queued';
  }
  request(input, { manual = false } = {}) {
    const scope = this.cards.scope(input);
    if (!this.available(scope.accountId)) throw new ChannelError('ROLE_CARD_UNAVAILABLE', '人物记忆后台暂不可用，请检查微信连接');
    if (!manual && !this.cards.settings().enabled)
      throw new ChannelError('ROLE_CARD_AUTO_DISABLED', '角色卡自动整理已关闭；仍可读取已有卡片，需要更新时请在角色卡页面手动操作');
    const view = this.cards.request(scope, this.now(), { manual, token: randomUUID() });
    this.scan(scope.accountId);
    this.jobs.set(view.roleId, scope); this.wake(0);
    return { queued: true, roleId: view.roleId, personId: scope.personId, message: '已安排后台根据聊天与已读取的朋友圈更新；当前聊天可以继续。' };
  }
  requestAll(accountId) {
    if (!this.available(accountId)) throw new ChannelError('ROLE_CARD_UNAVAILABLE', '人物记忆后台暂不可用，请检查微信连接');
    this.scan(accountId, { manual: true });
    return { queued: true, message: '已安排后台从已有聊天补充人物资料' };
  }
  wake(delay = 1000) {
    if (this.closed || this.wakeTimer && this.wakeAt <= Date.now() + delay) return;
    clearTimeout(this.wakeTimer); this.wakeAt = Date.now() + delay;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.tick(); }, delay);
    this.wakeTimer.unref?.();
  }
  scan(accountId, { manual = false } = {}) {
    if (!this.available(accountId)) return;
    if (this.scanning) { if (manual) this.scanManual = true; return; }
    this.scanning = true; this.scanManual = manual; this.nextScanAt = this.now() + this.scanIntervalMs;
    let peers;
    try {
      peers = this.channel.store.conversations(accountId).filter(scope => eligible(this.channel.store.settings(accountId), scope));
      for (const view of this.cards.list(accountId, { includePending: true })) if (view.pendingCount || view.nextAt != null) this.jobs.set(view.roleId, view.scope);
    } catch (error) { this.cards.errors.set('scan', error.message); this.scanning = false; return; }
    let current, entries = [], generation;
    const advance = () => {
      if (!this.available(accountId)) { this.scanning = false; return; }
      // Yield between small batches, including within a large group archive.
      if (!entries.length) {
        current = peers.shift();
        if (!current) {
          if (this.scanManual) for (const [key, scope] of this.jobs) if (scope.accountId === accountId) {
            try {
              if (this.cards.document(scope).pending.length) this.cards.request(scope, this.now(), { manual: true, token: randomUUID() });
            } catch (error) { this.rememberError(scope, error); }
          }
          this.scanning = false; this.scanManual = false; this.wake(0); return;
        }
        try {
          const doc = this.channel.memory.load(current);
          entries = [...doc.entries]; generation = doc.generation;
        } catch (error) { this.cards.errors.set('scan:' + current.peerId, error.message); }
      }
      if (entries.length) this.capture(current, entries.splice(0, 8), { generation });
      this.scanTimer = setTimeout(advance, 20); this.scanTimer.unref?.();
    };
    this.scanTimer = setTimeout(advance, 0); this.scanTimer.unref?.();
  }
  tick() {
    if (this.closed) return;
    const accountId = this.channel.transport.status().account?.id;
    if (!accountId || !this.available(accountId)) return;
    if (this.lastAccountId !== accountId) {
      this.momentsController?.abort(new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，旧朋友圈采集已停止'));
      this.nextScanAt = 0; this.nextMomentsScanAt = 0; this.lastAccountId = accountId;
    }
    if (this.now() >= this.nextScanAt) this.scan(accountId);
    if (this.now() >= this.nextMomentsScanAt) this.scanMoments(accountId);
    if (typeof this.channel.runner.extractRoleCard !== 'function') return;
    let nextAt = Math.min(this.nextScanAt, this.cards.settings().enabled && this.channel.transport.status().momentsReadReady === true
      ? this.nextMomentsScanAt : Infinity);
    for (const [key, scope] of this.jobs) {
      if (!personAuthorized(this.channel.store, scope.accountId, scope.personId)) { this.jobs.delete(key); continue; }
      if (scope.accountId !== accountId || this.active.has(key)) continue;
      try {
        const doc = this.cards.schedule(scope, this.now());
        if (!doc.pending.length && !doc.refreshRequested) { this.jobs.delete(key); continue; }
        if (doc.nextAt == null) continue;
        if (doc.nextAt > this.now()) { nextAt = Math.min(nextAt, doc.nextAt); continue; }
        if (this.active.size >= this.maxConcurrent) break;
        const review = this.cards.beginReview(scope, this.now());
        if (!review) continue;
        const controller = new AbortController(), active = { scope, controller, manual: review.reviewBatch.manual, sources: [...review.pending, ...review.sources] };
        this.active.set(key, active);
        active.promise = this.update(scope, controller.signal, review).catch(error => {
          if (!this.closed && !controller.signal.aborted) {
            try { this.cards.retry(scope, error, this.now()); } catch (failure) { this.rememberError(scope, failure); }
          }
        }).finally(() => {
          this.active.delete(key);
          // Rotate after each batch so one large history cannot monopolize the queue.
          this.jobs.delete(key); this.jobs.set(key, scope); this.wake(1000);
        });
      } catch (error) { this.rememberError(scope, error); }
    }
    if (Number.isFinite(nextAt)) this.wake(Math.max(20, nextAt - this.now()));
  }
  sourceAvailable(source) {
    if (!this.available(source.accountId) || !personAuthorized(this.channel.store, source.accountId, source.senderId)) return false;
    if ([...this.channel.pauses.values()].some(pause => matches(source, pause.selector))) return false;
    if (source.kind === 'moments') return validMomentPersonSource(source) && source.time <= this.now();
    if (!eligible(this.channel.store.settings(source.accountId), source)) return false;
    return this.channel.memory.load(source).generation === source.generation;
  }
  async update(input, signal = new AbortController().signal, review) {
    const scope = this.cards.scope(input), view = this.cards.view(scope), doc = review ?? this.cards.beginReview(scope, this.now()),
      epoch = authorizationEpoch(this.channel.store, scope.accountId);
    if (!doc) return;
    signal.throwIfAborted();
    const valid = [], discarded = new Set();
    for (const source of doc.pending) {
      if (doc.reviewBatch.sources[source.id] !== sourceFingerprint(source)) continue;
      if (this.sourceAvailable(source)) valid.push(source);
      else if (source.kind !== 'moments' && this.available(source.accountId) && eligible(this.channel.store.settings(source.accountId), source) &&
          this.channel.memory.load(source).generation !== source.generation) discarded.add(source.id);
    }
    if (discarded.size) this.cards.mutate(scope, current => {
      current.pending = current.pending.filter(source => !discarded.has(source.id));
    });
    if (!valid.length && Object.keys(doc.reviewBatch.sources).length > discarded.size)
      throw new ChannelError('ROLE_CARD_SOURCE_UNAVAILABLE', '人物整理来源暂不可用，保留消息等待恢复');
    const batch = []; let chars = 0;
    for (const source of valid.sort((a, b) => a.time - b.time)) {
      if (batch.length >= 24 || batch.length && chars + source.text.length > 16000) break;
      batch.push(source); chars += source.text.length;
    }
    const previous = doc.reviewBatch.refresh ? doc.sources.filter(source => this.sourceAvailable(source)).slice(-12) : [];
    const sources = [...new Map([...previous, ...batch].map(source => [source.id, source])).values()];
    if (!sources.length) {
      this.cards.commit(scope, { updates: [], conflicts: [] }, [], view.revision, this.now(), doc.reviewBatch.refreshToken);
      return;
    }
    const timeoutMinutes = this.cards.settings().timeoutMinutes, timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new ChannelError('ROLE_CARD_TIMEOUT',
      `人物整理超过 ${timeoutMinutes} 分钟，原有资料和聊天来源已保留；可重试或调整整理超时。`)), timeoutMinutes * 60000);
    timer.unref?.();
    const combined = AbortSignal.any([signal, timeout.signal]);
    const check = () => {
      combined.throwIfAborted();
      assertAuthorizationEpoch(this.channel.store, scope.accountId, epoch);
      if (!doc.reviewBatch.manual && (!this.cards.settings().enabled || doc.scheduleRevision !== roleCardSettingsRevision(this.cards.settings())))
        throw new ChannelError('ROLE_CARD_SETTINGS_CHANGED', '自动整理设置已变更，原话保留等待下次整理');
      if (!this.available(scope.accountId) || sources.some(source => !this.sourceAvailable(source)))
        throw new ChannelError('ROLE_CARD_SOURCE_CHANGED', '聊天来源或授权已变化，旧人物整理未写入');
    };
    let listener;
    try {
      check();
      const conversationContext = [];
      let contextChars = 0;
      for (const origin of new Map(sources.map(source => [source.chatType + ':' + source.peerId, source])).values()) {
        if (origin.kind === 'moments') continue;
        const entries = this.channel.memory.load(origin).entries.filter(entry => entry.time <= origin.time).slice(-10);
        for (const entry of entries) {
          const text = String(entry.text || '').slice(0, 1500);
          if (contextChars + text.length > 8000) break;
          conversationContext.push({ chatType: origin.chatType, peerId: origin.peerId, senderId: entry.senderId,
            senderName: entry.senderName || entry.sender, direction: entry.direction, time: entry.time, text });
          contextChars += text.length;
        }
      }
      const aborted = new Promise((_, reject) => {
        listener = () => reject(combined.reason);
        combined.addEventListener('abort', listener, { once: true });
      });
      const response = await Promise.race([this.channel.runner.extractRoleCard({
        mode: 'role-memory', tools: [], signal: combined, assertAllowed: check, systemOverride: ROLE_CARD_UPDATE_PROMPT,
        text: roleCardUpdateInput({ person: scope, now: new Date(this.now()).toISOString(), timezone: 'Asia/Shanghai',
          currentCard: view.card, currentEvidence: view.evidence, conflicts: view.conflicts, sources, conversationContext }),
      }), aborted]);
      check();
      const proposal = validateRoleCardProposal(response?.text, { scope, sources, now: this.now() });
      this.cards.commit(scope, proposal, batch, view.revision, this.now(), doc.reviewBatch.refreshToken);
    } finally { clearTimeout(timer); if (listener) combined.removeEventListener('abort', listener); }
  }
  cancel(selector) {
    if (this.scanning && (!selector || !selector.accountId || selector.accountId === this.lastAccountId)) {
      clearTimeout(this.scanTimer); this.scanning = false; this.scanManual = false;
    }
    if (!selector || !selector.accountId || selector.accountId === this.lastAccountId)
      this.momentsController?.abort(new ChannelError('CANCELLED', '后台朋友圈采集已取消'));
    for (const active of this.active.values()) if (!selector || selector.chatType === 'private' &&
        selector.accountId === active.scope.accountId && selector.peerId === active.scope.personId ||
        matches({ accountId: active.scope.accountId, senderId: active.scope.personId }, selector) ||
        active.sources.some(source => matches(source, selector))) active.controller.abort(new ChannelError('CANCELLED', '后台人物整理已取消'));
  }
  async whenIdle() {
    while (this.scanning) await new Promise(resolve => setTimeout(resolve, 20));
    while (this.active.size) await Promise.allSettled([...this.active.values()].map(active => active.promise));
    await this.momentsScan;
  }
  async close() {
    this.closed = true; clearTimeout(this.wakeTimer); clearTimeout(this.scanTimer);
    this.cancel(); await this.whenIdle();
    await this.momentsScan;
  }
}
