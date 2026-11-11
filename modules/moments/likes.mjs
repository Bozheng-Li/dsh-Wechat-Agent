import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson } from '../../backend/storage/atomic-json.ts';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { momentsLikeSettings, momentsLikeUserId } from '../../shared/moments-likes.mjs';
import { workPath } from '../work/policy.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 - 8 * 3600000;
const recordStates = new Set(['sending', 'liked', 'unknown', 'rejected', 'skipped']);
const runStates = new Set(['running', 'completed', 'cancelled', 'failed', 'interrupted']);
const dateInChina = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);

/** Selected friends only. Every attempted post is durably consumed before submission. */
export class MomentsLikes {
  constructor(channel) {
    this.channel = channel; this.now = channel.now; this.stopped = true; this.closed = false;
    this.data = { version: 1, ownerStoreId: channel.store.data.storeId, accounts: {}, records: {}, runs: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (data.version !== 1 || data.ownerStoreId !== channel.store.data.storeId || ![data.accounts, data.records, data.runs].every(object)) throw Error();
      for (const [id, rule] of Object.entries(data.accounts)) {
        if (!object(rule) || !momentsLikeUserId(rule.accountId) || id !== hash(rule.accountId) || !timestamp(rule.enabledAt) || !timestamp(rule.nextRunAt) || typeof rule.revision !== 'string') throw Error();
        rule.settings = momentsLikeSettings(rule.settings);
        if (rule.settings.userIds.includes(rule.accountId)) throw Error();
      }
      for (const [id, record] of Object.entries(data.records)) {
        if (!object(record) || !momentsLikeUserId(record.accountId) || !momentsLikeUserId(record.userId) || record.accountId === record.userId || !momentsId(record.postId) ||
            id !== hash([record.accountId, record.postId]) || !recordStates.has(record.state) || !timestamp(record.createdAt) || !timestamp(record.updatedAt) ||
            record.attemptedAt !== null && !timestamp(record.attemptedAt) || typeof record.requestId !== 'string' || record.requestId !== this.postRequestId(record.accountId, record.postId) ||
            typeof record.text !== 'string' || record.text.length > 300 || ['sending', 'liked', 'unknown', 'rejected'].includes(record.state) && record.attemptedAt === null ||
            record.state === 'liked' && !['server-ack', 'verified-existing'].includes(record.delivery)) throw Error();
        if (record.state === 'sending') { record.state = 'unknown'; record.error = '上次点赞提交中断，结果不明，未自动重试'; record.updatedAt = this.now(); }
      }
      for (const [id, run] of Object.entries(data.runs)) {
        if (!object(run) || id !== hash([run.accountId, run.requestId]) || run.id !== id || !momentsLikeUserId(run.accountId) || typeof run.requestId !== 'string' ||
            !run.requestId || run.requestId.length > 2000 || !runStates.has(run.state) || !['manual', 'schedule'].includes(run.source) || !timestamp(run.startedAt) ||
            run.finishedAt !== null && !timestamp(run.finishedAt) || !['scanned', 'attempted', 'liked', 'skipped'].every(key => timestamp(run[key]))) throw Error();
        if (run.state === 'running') { run.state = 'interrupted'; run.finishedAt = this.now(); run.error = '上次轮次中断，已保留提交结果，不重放该轮次'; }
      }
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') this.error = '自动点赞记录无法读取或归属无效；原文件保留，自动点赞已停止'; }
  }
  file() { return workPath(this.channel.store.root, 'storage/moments/likes.json'); }
  save() {
    if (this.error) throw new ChannelError('MOMENTS_LIKE_STATE_INVALID', this.error);
    try { atomicJson(this.file(), this.data); }
    catch { this.error = '自动点赞记录保存失败，已停止点赞，请检查磁盘和目录权限'; this.controller?.abort(); throw new ChannelError('STATE_WRITE_FAILED', this.error); }
  }
  check(accountId, signal) {
    signal?.throwIfAborted();
    if (this.error) throw new ChannelError('MOMENTS_LIKE_STATE_INVALID', this.error);
    const status = this.channel.transport.status();
    if (!momentsLikeUserId(accountId) || this.closed || this.channel.closed || this.channel.fault || !status.online || status.account?.id !== accountId)
      throw new ChannelError('ACCOUNT_CHANGED', '微信账号、连接或运行状态已变化，未继续自动点赞');
  }
  rule(accountId) { return (typeof accountId === 'string' ? this.data.accounts[hash(accountId)] : undefined) ?? { accountId, settings: momentsLikeSettings(), enabledAt: 0, nextRunAt: 0, revision: '' }; }
  today(accountId) {
    const date = dateInChina(this.now()), records = Object.values(this.data.records).filter(record => record.accountId === accountId && record.attemptedAt !== null && dateInChina(record.attemptedAt) === date);
    return { date, attempted: records.length, liked: records.filter(record => record.state === 'liked' && !record.alreadyLiked).length,
      remaining: Math.max(0, this.rule(accountId).settings.maxLikesPerDay - records.length) };
  }
  list(accountId) {
    const runs = Object.values(this.data.runs).reverse().filter(run => run.accountId === accountId && !run.historyDeleted).sort((a, b) => b.startedAt - a.startedAt);
    return structuredClone({ ...this.rule(accountId), running: this.activeAccount === accountId, schedulerStarted: !this.stopped, error: this.error ?? null,
      today: this.today(accountId), lastRun: runs[0] ?? null, runs: runs.slice(0, 100),
      records: Object.values(this.data.records).reverse().filter(record => record.accountId === accountId && !record.historyDeleted).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100) });
  }
  configure(accountId, input) {
    this.check(accountId);
    if (!object(input)) throw new ChannelError('MOMENTS_LIKE_SETTINGS_INVALID', '请填写自动点赞设置');
    const previous = this.rule(accountId), settings = momentsLikeSettings({ ...previous.settings, ...input });
    if (settings.userIds.includes(accountId)) throw new ChannelError('MOMENTS_LIKE_SETTINGS_INVALID', '自动点赞请选择好友，不能选择当前登录账号');
    const changedFriends = hash([...settings.userIds].sort()) !== hash([...previous.settings.userIds].sort());
    if (this.activeAccount === accountId) this.controller?.abort(new ChannelError('MOMENTS_LIKE_SETTINGS_CHANGED', '点赞设置已变更，旧轮次已停止'));
    this.data.accounts[hash(accountId)] = { accountId, settings, revision: randomUUID(),
      enabledAt: !previous.enabledAt || !previous.settings.enabled && settings.enabled || changedFriends ? this.now() : previous.enabledAt,
      nextRunAt: settings.enabled ? this.now() + settings.intervalMinutes * 60000 : 0 };
    this.save(); return this.list(accountId);
  }
  postRequestId(accountId, postId) { return 'moments-auto-like:' + hash([this.channel.store.data.storeId, accountId, postId]); }
  checkRun(accountId, rule, source, signal) {
    this.check(accountId, signal);
    const status = this.channel.transport.status();
    if (!status.momentsReadReady || !status.momentsWriteReady || typeof this.channel.transport.readMoments !== 'function' || typeof this.channel.moments?.writeOwner !== 'function')
      throw new ChannelError('MOMENTS_LIKE_UNAVAILABLE', '当前微信组件尚未就绪，未继续自动点赞');
    if (!this.channel.store.settings(accountId).enabled || this.rule(accountId).revision !== rule.revision || source === 'schedule' && (this.stopped || !rule.settings.enabled))
      throw new ChannelError('MOMENTS_LIKE_SETTINGS_CHANGED', '自动回复已暂停或点赞设置已变更，旧轮次未继续');
  }
  runNow(accountId, requestId, signal) {
    this.check(accountId, signal);
    if (typeof requestId !== 'string' || !requestId || requestId.length > 2000) throw new ChannelError('MOMENTS_LIKE_REQUEST_INVALID', '本次执行缺少稳定操作编号');
    const id = hash([accountId, requestId]);
    if (this.data.runs[id]) return this.activeRunId === id ? this.pending : Promise.resolve(this.list(accountId));
    const rule = structuredClone(this.rule(accountId));
    if (!rule.settings.userIds.length) throw new ChannelError('MOMENTS_LIKE_SETTINGS_INVALID', '请先选择允许自动点赞的好友');
    this.checkRun(accountId, rule, 'manual', signal);
    return this.launch(accountId, rule, requestId, 'manual', signal);
  }
  cancel(accountId) {
    this.check(accountId);
    if (this.activeAccount === accountId) this.controller?.abort(new ChannelError('MOMENTS_LIKE_CANCELLED', '本轮自动点赞已停止，已提交的点赞不会撤销'));
    return this.list(accountId);
  }
  start() {
    if (this.timer || this.closed || this.error) return;
    this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 10000); this.timer.unref?.();
  }
  async close() { this.closed = true; this.stopped = true; clearInterval(this.timer); this.timer = undefined; this.controller?.abort(); await this.whenIdle(); }
  async whenIdle() { await this.pending?.catch(() => {}); }
  tick() {
    if (this.pending) {
      try { this.checkRun(this.activeAccount, this.activeRule, this.activeSource, this.controller.signal); } catch (error) { this.controller.abort(error); }
      return this.pending;
    }
    const status = this.channel.transport.status(), accountId = status.account?.id, rule = this.rule(accountId);
    if (this.stopped || this.closed || this.error || !accountId || !status.online || !status.momentsReadReady || !status.momentsWriteReady ||
        !this.channel.store.settings(accountId).enabled || !rule.settings.enabled || !rule.settings.userIds.length || rule.nextRunAt > this.now()) return Promise.resolve();
    return this.launch(accountId, structuredClone(rule), 'moments-like-schedule:' + rule.revision + ':' + rule.nextRunAt, 'schedule');
  }
  launch(accountId, rule, requestId, source, signal) {
    if (this.pending) throw new ChannelError('MOMENTS_LIKE_BUSY', '已有一轮自动点赞正在执行，请等待完成或停止本轮');
    this.checkRun(accountId, rule, source, signal);
    const id = hash([accountId, requestId]);
    if (this.data.runs[id]) return Promise.resolve(this.list(accountId));
    const run = { id, accountId, requestId, source, state: 'running', startedAt: this.now(), finishedAt: null, scanned: 0, attempted: 0, liked: 0, skipped: 0, error: null };
    this.data.runs[id] = run;
    if (rule.settings.enabled) this.data.accounts[hash(accountId)].nextRunAt = this.now() + rule.settings.intervalMinutes * 60000;
    this.save();
    this.activeAccount = accountId; this.activeRunId = id; this.activeRule = rule; this.activeSource = source; this.controller = new AbortController();
    const combined = AbortSignal.any([this.controller.signal, AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
    this.pending = this.run(accountId, rule, run, combined).finally(() => {
      this.pending = undefined; this.controller = undefined; this.activeAccount = undefined; this.activeRunId = undefined; this.activeRule = undefined; this.activeSource = undefined;
    }).then(() => this.list(accountId));
    return this.pending;
  }
  async run(accountId, rule, run, signal) {
    const check = () => this.checkRun(accountId, rule, run.source, signal);
    const threshold = Math.max(run.startedAt - rule.settings.lookbackDays * 86400000, rule.settings.includeExisting ? 0 : rule.enabledAt || run.startedAt);
    const exhausted = () => run.attempted >= rule.settings.maxLikesPerRun || this.today(accountId).remaining === 0;
    try {
      outer: for (const userId of rule.settings.userIds) {
        let cursor; const cursors = new Set();
        for (let page = 0; page < 5; page++) {
          check(); if (exhausted()) break outer;
          const result = await this.channel.transport.readMoments({ accountId, scopeKey: 'moments-likes:' + accountId,
            query: { action: 'user', userId, limit: 20, ...(cursor ? { cursor } : {}) } }, signal); check();
          if (result?.accountId !== accountId || result.action !== 'user' || result.userId !== userId || result.source !== 'wechat-sns-live' || !Array.isArray(result.items) ||
              result.items.length > 20 || result.items.some(post => !momentsId(post.id) || post.author?.userId !== userId || !timestamp(post.createdAt) || post.createdAt === 0 ||
                typeof post.deleted !== 'boolean' || typeof post.likedByCurrentAccount !== 'boolean' || typeof post.contentAvailable !== 'boolean') ||
              new Set(result.items.map(post => post.id)).size !== result.items.length || result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor))
            throw new ChannelError('MOMENTS_LIKE_RESPONSE_INVALID', '好友主页结果与账号、好友或动态状态不符，未使用本页点赞');
          for (const post of result.items) {
            check(); if (exhausted()) break outer;
            run.scanned++;
            const id = hash([accountId, post.id]);
            if (post.createdAt * 1000 < threshold || post.createdAt * 1000 > this.now() + 60000 || post.deleted || !post.contentAvailable || this.data.records[id]) { run.skipped++; continue; }
            const record = { accountId, postId: post.id, userId, createdAt: post.createdAt, text: typeof post.text === 'string' ? post.text.slice(0, 300) : '',
              requestId: this.postRequestId(accountId, post.id), state: post.likedByCurrentAccount ? 'skipped' : 'sending', attemptedAt: post.likedByCurrentAccount ? null : this.now(),
              updatedAt: this.now(), alreadyLiked: post.likedByCurrentAccount, delivery: post.likedByCurrentAccount ? 'verified-existing' : null, error: null };
            this.data.records[id] = record;
            if (post.likedByCurrentAccount) { run.skipped++; this.save(); continue; }
            run.attempted++; this.save();
            try {
              check();
              const result = await this.channel.moments.writeOwner({ action: 'like', postId: post.id }, accountId, record.requestId, signal, check);
              if (result?.accountId !== accountId || result.action !== 'like' || result.postId !== post.id || result.liked !== true || !['server-ack', 'verified-existing'].includes(result.delivery))
                throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '点赞回执与目标不符，结果不明，未自动重试');
              Object.assign(record, { state: 'liked', delivery: result.delivery, alreadyLiked: result.alreadyLiked === true || result.delivery === 'verified-existing', updatedAt: this.now() });
              if (record.alreadyLiked) run.skipped++; else run.liked++;
              this.save(); check();
            } catch (error) {
              if (record.state !== 'liked' && !this.error) {
                Object.assign(record, { state: ['not-sent', 'rejected'].includes(error?.details?.snsDelivery) ? 'rejected' : 'unknown',
                  error: publicError(error, '点赞结果不明，未自动重试').message, updatedAt: this.now(), delivery: error?.details?.snsDelivery ?? 'unknown' }); this.save();
              }
              throw error;
            }
          }
          cursor = result.nextCursor;
          if (!cursor || result.items.length > 0 && result.items.every(post => post.createdAt * 1000 < threshold)) break;
          if (cursors.has(cursor)) throw new ChannelError('MOMENTS_LIKE_RESPONSE_INVALID', '好友主页分页未推进，已停止本轮');
          cursors.add(cursor);
        }
      }
      check(); run.state = 'completed';
    } catch (error) {
      run.state = signal.aborted || ['ACCOUNT_CHANGED', 'MOMENTS_LIKE_SETTINGS_CHANGED', 'MOMENTS_LIKE_CANCELLED'].includes(error?.code) ? 'cancelled' : 'failed';
      run.error = publicError(error, '本轮自动点赞未完成').message;
    } finally { run.finishedAt = this.now(); if (!this.error) this.save(); }
  }
}
