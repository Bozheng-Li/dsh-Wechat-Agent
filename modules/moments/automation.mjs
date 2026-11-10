import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicJson } from '../../backend/storage/atomic-json.ts';
import { workPath } from '../work/policy.mjs';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { momentsId, momentsSettings } from '../../shared/moments.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { personaInstructions } from '../../prompts/reply/compose.mjs';
import { MomentsPublishing } from './publishing.mjs';

const key = (accountId, postId, commentId) => identity([accountId, postId, commentId ?? '']);
const clone = value => structuredClone(value);

/** Owner-configured polling is independent of chat wake-up and work sessions. */
export class MomentsAutomation {
  constructor(channel) {
    this.channel = channel; this.now = channel.now; this.stopped = true;
    this.publishing = new MomentsPublishing(channel);
    this.data = { version: 1, ownerStoreId: channel.store.data.storeId, accounts: {}, posts: {}, replies: {} };
    try {
      const stored = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (stored.version !== 1 || stored.ownerStoreId !== channel.store.data.storeId ||
          ![stored.accounts, stored.posts, stored.replies].every(value => value && typeof value === 'object' && !Array.isArray(value))) throw Error();
      for (const rule of Object.values(stored.accounts)) {
        momentsSettings(rule.settings);
        if (!Number.isSafeInteger(rule.enabledAt) || !Number.isSafeInteger(rule.nextRunAt) || typeof rule.revision !== 'string') throw Error();
      }
      for (const post of Object.values(stored.posts)) if (!momentsId(post.id) || typeof post.accountId !== 'string' || !Number.isSafeInteger(post.createdAt)) throw Error();
      for (const reply of Object.values(stored.replies)) {
        if (!momentsId(reply.postId) || !momentsId(reply.commentId) || typeof reply.accountId !== 'string' ||
            !['generating', 'draft', 'sending', 'sent', 'unknown', 'failed', 'rejected', 'existing'].includes(reply.state)) throw Error();
        if (reply.state === 'sending') { reply.state = 'unknown'; reply.error = '上次提交中断，结果不明，未自动重试'; }
      }
      this.data = stored;
    } catch (error) { if (error.code !== 'ENOENT') this.error = '朋友圈记录无法读取或归属无效；原文件保留，定时操作已停止'; }
  }
  file() { return workPath(this.channel.store.root, 'storage/moments/automation.json'); }
  save() {
    if (this.error) throw new ChannelError('MOMENTS_STATE_INVALID', this.error);
    try { atomicJson(this.file(), this.data); }
    catch { this.error = '朋友圈记录保存失败，已停止定时操作，请检查目录权限'; this.controller?.abort();
      throw new ChannelError('STATE_WRITE_FAILED', this.error); }
  }
  check(accountId, signal) {
    signal?.throwIfAborted(); const status = this.channel.transport.status();
    if (this.error) throw new ChannelError('MOMENTS_STATE_INVALID', this.error);
    if (this.channel.closed || this.channel.fault || !status.online || status.account?.id !== accountId)
      throw new ChannelError('ACCOUNT_CHANGED', '微信连接、账号或运行状态已变化，未继续朋友圈操作');
  }
  rule(accountId) { return this.data.accounts[accountId] ?? { settings: momentsSettings(), enabledAt: 0, nextRunAt: 0, revision: '' }; }
  list(accountId) {
    return { ...clone(this.rule(accountId)), publishing: this.publishing.list(accountId), running: this.activeAccount === accountId, schedulerStarted: !this.stopped, error: this.error ?? null,
      posts: Object.values(this.data.posts).filter(post => post.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(clone),
      replies: Object.values(this.data.replies).filter(reply => reply.accountId === accountId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(clone) };
  }
  configure(accountId, input) {
    this.check(accountId); const settings = momentsSettings(input), previous = this.rule(accountId);
    if (settings.scope === 'selected') for (const id of settings.selectedPostIds) {
      const post = this.data.posts[key(accountId, id)];
      if (!post || post.deleted) throw new ChannelError('MOMENTS_TARGET_INVALID', '请先读取并选择当前账号自己发布且未删除的朋友圈');
    }
    if (this.activeAccount === accountId) this.controller?.abort(new ChannelError('MOMENTS_SETTINGS_CHANGED', '定时设置已变更，旧轮次已停止'));
    const enabledAt = !previous.settings.enabled && settings.enabled ? this.now() : previous.enabledAt;
    this.data.accounts[accountId] = { ...previous, settings, enabledAt, revision: randomUUID(), nextRunAt: settings.enabled ? this.now() + settings.intervalMinutes * 60000 : 0 };
    this.save(); return this.list(accountId);
  }
  remember(accountId, items = []) {
    if (this.error) return;
    let changed = false;
    for (const post of items) {
      if (post.author?.userId !== accountId || !momentsId(post.id) || !Number.isSafeInteger(post.createdAt)) continue;
      const id = key(accountId, post.id), value = { accountId, id: post.id, createdAt: post.createdAt, text: post.text ?? '', imageCount: post.imageCount ?? 0, deleted: !!post.deleted };
      if (JSON.stringify(this.data.posts[id]) !== JSON.stringify(value)) { this.data.posts[id] = value; changed = true; }
    }
    if (changed) this.save();
  }
  recordReceipt(result) {
    if (this.error) return;
    const { accountId, postId } = result;
    if (result.action === 'publish') this.remember(accountId, [{ id: postId, author: { userId: accountId }, createdAt: result.createdAt ?? Math.floor(this.now() / 1000), text: result.text, imageCount: result.imageCount }]);
    if (result.action === 'delete' && this.data.posts[key(accountId, postId)]) { this.data.posts[key(accountId, postId)].deleted = true; this.save(); }
    if (result.replyToCommentId) {
      const id = key(accountId, postId, result.replyToCommentId), previous = this.data.replies[id] ?? {};
      this.data.replies[id] = { ...previous, accountId, postId, commentId: result.replyToCommentId, replyId: result.commentId, text: result.text,
        replyToUserId: result.replyToUserId, state: 'sent', delivery: result.delivery, updatedAt: this.now(), error: null }; this.save();
    }
  }
  async read(accountId, query, signal) {
    this.check(accountId, signal);
    const result = await this.channel.transport.readMoments({ accountId, scopeKey: 'moments-owner:' + accountId, query }, signal);
    this.check(accountId, signal);
    if (result?.accountId !== accountId) throw new ChannelError('ACCOUNT_CHANGED', '朋友圈结果与当前账号不匹配');
    this.remember(accountId, result.items); return result;
  }
  async discover(accountId, signal, lookbackDays = 7) {
    let cursor; const threshold = this.now() - lookbackDays * 86400000;
    // Own user pages can lag behind new pure-text posts on PC; merge timeline
    // and locally confirmed posts. Only own posts enter persistent state.
    for (let page = 0; page < 5; page++) {
      const result = await this.read(accountId, { action: 'timeline', limit: 20, ...(cursor ? { cursor } : {}) }, signal);
      cursor = result.nextCursor;
      if (!cursor || !result.items.length || result.items.every(post => post.createdAt * 1000 < threshold)) break;
    }
    return this.list(accountId);
  }
  async write(accountId, query, requestId, signal) {
    this.check(accountId, signal);
    return this.channel.moments.writeOwner(query, accountId, requestId, signal, () => this.check(accountId, signal));
  }
  start() {
    this.publishing.start();
    if (this.timer || this.error) return; this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 10000); this.timer.unref?.();
  }
  async close() { this.stopped = true; clearInterval(this.timer); this.timer = undefined; this.controller?.abort(); await Promise.all([this.pending?.catch(() => {}), this.publishing.close()]); }
  async whenIdle() { await Promise.all([this.pending?.catch(() => {}), this.publishing.whenIdle()]); }
  tick() {
    if (this.pending) return this.pending;
    const status = this.channel.transport.status(), accountId = status.account?.id, rule = this.rule(accountId);
    if (this.stopped || this.error || !accountId || !status.online || !status.momentsReadReady || !status.momentsWriteReady ||
        !this.channel.store.settings(accountId).enabled || !rule.settings.enabled || rule.nextRunAt > this.now()) return Promise.resolve();
    this.activeAccount = accountId; this.controller = new AbortController();
    this.pending = this.run(accountId, clone(rule), AbortSignal.any([this.controller.signal, AbortSignal.timeout(300000)]))
      .finally(() => { this.pending = undefined; this.controller = undefined; this.activeAccount = undefined; });
    return this.pending;
  }
  async run(accountId, rule, signal) {
    const check = () => { this.check(accountId, signal);
      if (this.stopped || !this.channel.store.settings(accountId).enabled || this.rule(accountId).revision !== rule.revision)
        throw new ChannelError('MOMENTS_SETTINGS_CHANGED', '定时回复已暂停或设置变更，旧轮次未继续'); };
    let scanned = 0, replied = 0, skipped = 0, attempted = 0; const startedAt = this.now();
    try {
      check(); if (rule.settings.scope === 'own') await this.discover(accountId, signal, rule.settings.lookbackDays); check();
      const threshold = this.now() - rule.settings.lookbackDays * 86400000;
      const posts = Object.values(this.data.posts).filter(post => post.accountId === accountId && !post.deleted && post.createdAt * 1000 >= threshold &&
        (rule.settings.scope === 'own' || rule.settings.selectedPostIds.includes(post.id))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
      outer: for (const post of posts) {
        const comments = []; let cursor;
        do { check(); const result = await this.read(accountId, { action: 'comments', postId: post.id, limit: 50, ...(cursor ? { cursor } : {}) }, signal);
          comments.push(...result.items); cursor = result.nextCursor; check(); } while (cursor);
        const existing = new Set(comments.filter(comment => !comment.deleted && comment.userId === accountId && comment.replyToCommentId).map(comment => comment.replyToCommentId));
        for (const comment of comments) {
          scanned++; const id = key(accountId, post.id, comment.id), prior = this.data.replies[id];
          if (!momentsId(comment.id) || !comment.userId || comment.deleted || comment.userId === accountId ||
              existing.has(comment.id) || ['sent', 'existing', 'sending', 'unknown', 'rejected'].includes(prior?.state) ||
              !rule.settings.includeExisting && (!Number.isSafeInteger(comment.createdAt) || comment.createdAt * 1000 < rule.enabledAt)) { skipped++; continue; }
          if (attempted >= rule.settings.maxRepliesPerRun) break outer;
          attempted++;
          check(); const record = { accountId, postId: post.id, commentId: comment.id, author: comment.nickname ?? comment.userId,
            commentText: comment.text, state: 'generating', updatedAt: this.now() }; this.data.replies[id] = record; this.save();
          let submitting = false;
          try {
            const generated = await this.channel.runner.run({ mode: 'moments-reply', text: JSON.stringify({ post: { text: post.text, createdAt: post.createdAt },
              comment: { text: comment.text, nickname: comment.nickname, replyToCommentId: comment.replyToCommentId }, instruction: rule.settings.replyInstructions }),
              systemOverride: [readPrompt('moments/reply.md'), personaInstructions(this.channel.store.persona())].join('\n\n'), tools: [],
              signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
            check(); const text = generated?.text?.trim();
            if (!text || text.length > 2000) throw new ChannelError('MOMENTS_REPLY_EMPTY', '模型未返回有效评论回复，未提交微信');
            Object.assign(record, { text, state: 'sending', updatedAt: this.now() }); this.save(); submitting = true;
            await this.channel.moments.writeOwner({ action: 'comment', postId: post.id, replyToCommentId: comment.id, text }, accountId,
              'moments-auto:' + post.id + ':' + comment.id, signal, check);
            replied++; check();
          } catch (error) {
            if (this.data.replies[id]?.state !== 'sent') {
              const rejected = ['not-sent', 'rejected'].includes(error?.details?.snsDelivery);
              Object.assign(record, { state: submitting ? rejected ? 'rejected' : 'unknown' : 'failed', error: publicError(error, '本条评论未完成回复').message, updatedAt: this.now() });
              this.data.replies[id] = record; this.save();
            }
            check();
          }
        }
      }
      Object.assign(this.data.accounts[accountId], { lastRun: { startedAt, finishedAt: this.now(), scanned, attempted, replied, skipped, state: attempted > replied ? 'partial' : 'completed' }, lastError: null });
    } catch (error) {
      if (this.data.accounts[accountId]) Object.assign(this.data.accounts[accountId], { lastRun: { startedAt, finishedAt: this.now(), scanned, attempted, replied, skipped, state: 'failed' },
        lastError: publicError(error, '本轮朋友圈抓取未完成').message });
    } finally {
      if (!this.error && this.rule(accountId).revision === rule.revision) {
        this.data.accounts[accountId].nextRunAt = this.rule(accountId).settings.enabled ? this.now() + rule.settings.intervalMinutes * 60000 : 0; this.save();
      }
    }
  }
}
