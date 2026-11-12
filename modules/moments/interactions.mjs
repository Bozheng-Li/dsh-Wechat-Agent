import fs from 'node:fs';
import { timeLimitMs, TIME_DEFAULTS } from '../../shared/time-settings.mjs';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { workPath } from '../work/policy.mjs';
import { assertRemoteAuthorized } from '../remote/authorization/policy.mjs';
import { interactionOptions, interactionEdits, interactionId, interactionHasLike, interactionHasComment,
  interactionRunStates, interactionStepStates } from '../../shared/moments-interactions.mjs';
import { readInteractionPool, readInteractionDetail, interactionContentHash, interactionOwnComment, readableInteractionText } from './interaction-read.mjs';
import { generateInteractionComments } from './interaction-content.mjs';
import { automaticInteractionOptions, interactionAutomationSettings } from '../../shared/moments-interaction-settings.mjs';
import { selectAutomaticInteractions } from './interaction-selection.mjs';
import { MomentsInteractionSchedule } from './interaction-schedule.mjs';
import { readMomentsImageContext, momentsImageContextVersion, readableMomentsImages, momentsCommentBasis,
  momentsImageFailure, recoverableMomentsImageError } from './image-context.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => { throw new ChannelError(code, message); };
const hasUnknown = record => record.rows.some(row => [row.like, row.comment].some(step => step.state === 'unknown'));
const interactionRow = (post, options) => ({ postId: post.id, userId: post.author.userId, nickname: post.author.nickname ?? '', createdAt: post.createdAt,
  text: post.text, imageCount: post.imageCount, contentHash: interactionContentHash(post), selected: options.mode !== 'manual' || options.source === 'selected',
  likeCount: post.likeCount, commentCount: post.commentCount, likedByCurrentAccount: post.likedByCurrentAccount,
  commentText: options.commentMode === 'fixed' ? options.commentText : '', commentSource: options.commentMode,
  commentSkipReason: options.commentMode === 'generated' && !readableInteractionText(post.text) && !post.imageCount ? '只有表情或链接，未读到足够内容，跳过自动评论' : '',
  like: { state: interactionHasLike(options.action) ? 'pending' : 'skipped', message: '' },
  comment: { state: interactionHasComment(options.action) ? 'pending' : 'skipped', message: '' } });
const summary = record => {
  const rows = record.rows.filter(row => row.selected), steps = rows.flatMap(row => [row.like, row.comment]);
  return { selected: rows.length, liked: rows.filter(row => row.like.state === 'succeeded').length,
    commented: rows.filter(row => row.comment.state === 'succeeded').length, alreadyLiked: rows.filter(row => row.like.state === 'existing').length,
    skippedComments: rows.filter(row => ['skipped', 'existing'].includes(row.comment.state) && interactionHasComment(record.options.action)).length,
    failed: steps.filter(step => step.state === 'rejected').length, unknown: steps.filter(step => step.state === 'unknown').length,
    remaining: rows.filter(row => [row.like, row.comment].some(step => step.state === 'pending')).length };
};

/** Explicit and owner-configured automatic rounds share selection records,
 * concurrency control and the existing durable receipt boundary. */
export class MomentsInteractions {
  constructor(channel, { random = randomInt, sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    this.channel = channel; this.random = random; this.sleep = sleep; this.pending = new Set(); this.previews = new Map();
    this.lifetime = new AbortController(); this.data = { version: 1, ownerStoreId: channel.store.data.storeId, runs: {} };
    try {
      const stored = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (stored.version !== 1 || stored.ownerStoreId !== this.data.ownerStoreId || !object(stored.runs)) throw Error();
      for (const [id, record] of Object.entries(stored.runs)) {
        if (!object(record) || record.id !== id || !interactionId(id) || typeof record.accountId !== 'string' || !record.accountId ||
            !interactionId(record.scopeKey) || !interactionId(record.requestHash) || typeof record.revision !== 'string' || !record.revision ||
            !interactionRunStates.includes(record.state) || !Number.isSafeInteger(record.createdAt) || !Array.isArray(record.rows) || record.rows.length > 100 ||
            new Set(record.rows.map(row => row.postId)).size !== record.rows.length) throw Error();
        interactionOptions(record.options);
        if (record.automatic) {
          if (!object(record.automatic) || typeof record.automatic.cycleId !== 'string' || !/^[a-f0-9-]{36}$/.test(record.automatic.cycleId) ||
              typeof record.automatic.revision !== 'string' || !record.automatic.revision) throw Error();
          interactionAutomationSettings(record.automatic.settings);
        }
        for (const row of record.rows) {
          if (!object(row) || !momentsId(row.postId) || typeof row.userId !== 'string' || !row.userId || row.userId === record.accountId ||
              typeof row.text !== 'string' || typeof row.nickname !== 'string' || !Number.isSafeInteger(row.createdAt) ||
              typeof row.selected !== 'boolean' || typeof row.commentText !== 'string' || row.commentText.length > 2000 ||
              typeof row.commentSkipReason !== 'string' || !['generated', 'fixed', 'manual'].includes(row.commentSource) || !/^[a-f0-9]{64}$/.test(row.contentHash)) throw Error();
          for (const [action, step] of [['like', row.like], ['comment', row.comment]]) {
            if (!object(step) || !interactionStepStates.includes(step.state)) throw Error();
            if ((step.state === 'succeeded' || step.state === 'existing' && step.result) && (step.result?.accountId !== record.accountId || step.result.postId !== row.postId ||
                step.result.action !== action || !['server-ack', 'verified-existing'].includes(step.result.delivery) ||
                action === 'like' && step.result.liked !== true || action === 'comment' && (!momentsId(step.result.commentId) || step.result.text !== row.commentText))) throw Error();
            if (step.state === 'sending') { step.state = 'unknown'; step.message = '上次提交中断，结果不明，未重发'; }
          }
        }
        if (record.rows.filter(row => row.selected).length > 20) throw Error();
        if (record.state === 'running' || record.state === 'draft' && hasUnknown(record)) { record.state = 'interrupted'; record.error = { code: 'MOMENTS_INTERACTION_INTERRUPTED', message: '上轮执行已中断，保留确认回执与未知结果，不自动重跑' }; }
        if (record.state === 'generating') { record.state = 'draft'; record.generationError = '上次生成中断，尚未提交微信'; }
      }
      this.data = stored;
    } catch (error) { if (error.code !== 'ENOENT') this.error = '互动记录无法读取或归属无效；原文件保留，未执行任何互动'; }
    this.automation = new MomentsInteractionSchedule(channel, this);
  }
  file() { return workPath(this.channel.store.root, 'storage/moments/interactions.json'); }
  save() {
    if (this.error) failure('MOMENTS_INTERACTION_STATE', this.error);
    try { atomicBytes(this.file(), Buffer.from(JSON.stringify(this.data, null, 2) + '\n')); }
    catch { this.error = '互动进度无法保存，已停止后续操作；已提交内容请核对微信'; this.active?.controller.abort(); failure('STATE_WRITE_FAILED', this.error); }
  }
  context(accountId, scope) {
    const actor = scope ?? { accountId, chatType: 'owner', peerId: accountId, senderId: accountId };
    return { accountId, scope: actor, scopeKey: identity([accountId, actor.chatType, actor.peerId, actor.senderId]) };
  }
  check(context, signal, assertAllowed = () => {}) {
    signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted(); assertAllowed();
    if (this.error) failure('MOMENTS_INTERACTION_STATE', this.error);
    const status = this.channel.transport.status();
    if (this.channel.closed || this.channel.fault || !status.online || status.account?.id !== context.accountId)
      failure('ACCOUNT_CHANGED', '微信连接或账号已变化，未继续互动');
    if (context.scope.accountId !== context.accountId) failure('ACCOUNT_CHANGED', '互动请求的账号不一致');
    if (context.scope.chatType !== 'owner') assertRemoteAuthorized(this.channel, context.scope, signal);
    if (status.momentsReadReady !== true || typeof this.channel.transport.readMoments !== 'function')
      failure('MOMENTS_UNAVAILABLE', '朋友圈读取组件尚未就绪');
    this.channel.store.config?.assertCurrent();
  }
  record(context, id) {
    const record = interactionId(id) && this.data.runs[id];
    if (!record || record.accountId !== context.accountId || record.historyDeleted ||
        context.scope.chatType !== 'owner' && record.scopeKey !== context.scopeKey)
      failure('MOMENTS_INTERACTION_NOT_FOUND', '本次互动不存在或不属于当前账号与发起人');
    return record;
  }
  view(record, detail = true) {
    return structuredClone({ id: record.id, accountId: record.accountId, state: record.state, revision: record.revision,
      createdAt: record.createdAt, updatedAt: record.updatedAt, startedAt: record.startedAt, finishedAt: record.finishedAt,
      options: record.options, scan: record.scan, targetUserId: record.targetUserId, counts: summary(record), error: record.error,
      generationError: record.generationError, automatic: record.automatic, phase: record.phase, ...(detail ? { rows: record.rows } : {}) });
  }
  list(accountId, id, scope) {
    const context = this.context(accountId, scope);
    if (scope) this.check(context);
    return { accountId, error: this.error ?? null, running: this.active?.accountId === accountId,
      automation: this.automation.list(accountId),
      activeId: this.active?.accountId === accountId ? this.active.id : null,
      runs: Object.values(this.data.runs).filter(row => row.accountId === accountId && !row.historyDeleted &&
        (!scope || row.scopeKey === context.scopeKey)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(row => this.view(row, false)),
      ...(id ? { current: this.view(this.record(context, id)) } : {}) };
  }
  track(promise) { this.pending.add(promise); void promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise; }
  preview(accountId, input, requestId, signal, assertAllowed = () => {}, scope) {
    const context = this.context(accountId, scope); this.check(context, signal, assertAllowed);
    const timing = this.channel.store.config?.data?.timeSettings ?? TIME_DEFAULTS;
    const options = interactionOptions(object(input) ? { intervalSeconds: timing.manualInteractionIntervalSeconds, lookbackDays: timing.manualInteractionLookbackDays, ...input } : input);
    if (typeof requestId !== 'string' || !requestId || requestId.length > 1800) failure('MOMENTS_INTERACTION_INVALID', '缺少本轮互动请求编号');
    const id = digest([this.data.ownerStoreId, context.scopeKey, requestId]), requestHash = digest(options), existing = this.data.runs[id];
    if (existing) {
      if (existing.requestHash !== requestHash) failure('MOMENTS_INTERACTION_CHANGED', '同一请求的范围或动作已改变，请重新预览');
      return Promise.resolve(this.view(this.record(context, id)));
    }
    const active = this.previews.get(id);
    if (active) {
      if (active.requestHash !== requestHash) failure('MOMENTS_INTERACTION_CHANGED', '同一请求不能同时挑选不同动态');
      return active.promise.then(result => { this.check(context, signal, assertAllowed); return result; });
    }
    const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeLimitMs(this.channel.store, 'momentsInteractionReadTimeoutSeconds')), ...(signal ? [signal] : [])]);
    const check = () => this.check(context, combined, assertAllowed);
    const promise = this.track((async () => {
      const { posts, scan, targetUserId } = await readInteractionPool(this.channel, options, context, combined, check); check();
      let selected = posts;
      if (options.mode === 'random') {
        selected = [...posts];
        for (let index = selected.length - 1; index > 0; index--) { const target = this.random(index + 1); [selected[index], selected[target]] = [selected[target], selected[index]]; }
        const counts = new Map(); selected = selected.filter(post => {
          if (options.source === 'timeline' && (counts.get(post.author.userId) ?? 0) >= options.perFriendLimit) return false;
          counts.set(post.author.userId, (counts.get(post.author.userId) ?? 0) + 1); return true;
        }).slice(0, options.count);
      } else if (options.mode !== 'manual' && options.source !== 'selected') selected = posts.slice(0, options.count);
      const rows = selected.map(post => interactionRow(post, options));
      const record = { id, accountId, scopeKey: context.scopeKey, requestHash, options, rows, scan, targetUserId,
        state: 'draft', revision: randomUUID(), createdAt: this.channel.now(), updatedAt: this.channel.now() };
      this.data.runs[id] = record; this.save(); check(); return this.view(record);
    })());
    this.previews.set(id, { promise, requestHash }); void promise.finally(() => this.previews.delete(id)).catch(() => {}); return promise;
  }
  priorInteractions(accountId, exceptId) {
    const result = new Map();
    for (const record of Object.values(this.data.runs)) if (record.accountId === accountId && record.id !== exceptId) for (const row of record.rows) {
      const history = result.get(row.postId) ?? {};
      for (const action of ['like', 'comment']) {
        const step = history[action] ?? { confirmed: false, unknown: false };
        step.confirmed ||= ['succeeded', 'existing'].includes(row[action].state);
        step.unknown ||= ['sending', 'unknown'].includes(row[action].state); history[action] = step;
      }
      result.set(row.postId, history);
    }
    return result;
  }
  runAutomatic(accountId, input, cycleId, revision, signal, assertAllowed, scope) {
    const context = this.context(accountId, scope); this.check(context, signal, assertAllowed);
    const settings = interactionAutomationSettings(input), options = interactionOptions(automaticInteractionOptions(settings));
    const id = digest([this.data.ownerStoreId, context.scopeKey, 'automatic-interaction:' + cycleId]), requestHash = digest([settings, revision]), existing = this.data.runs[id];
    if (existing) {
      if (existing.requestHash !== requestHash) failure('MOMENTS_INTERACTION_CHANGED', '同一自动轮次的设置已变化，未重新执行');
      return Promise.resolve(this.view(existing));
    }
    if (this.active) failure('MOMENTS_INTERACTION_BUSY', '已有一轮互动正在生成或执行，自动轮次未并发执行');
    const record = { id, accountId, scopeKey: context.scopeKey, requestHash, options, rows: [], automatic: { settings, cycleId, revision },
      state: 'draft', phase: 'reading', scan: { scanned: 0, poolCount: 0, pageCount: 0, complete: false, fetchedAt: this.channel.now(), message: '正在读取本轮真实动态' },
      revision: randomUUID(), createdAt: this.channel.now(), updatedAt: this.channel.now() };
    this.data.runs[id] = record;
    return this.launch(record, 'running', context, signal, assertAllowed, async (combined, check) => {
      try {
        const { chosen, scan, targetUserId } = await selectAutomaticInteractions(this, record, context, combined, check); check();
        record.rows = chosen.map(({ post, like, comment, imageContext, imageReadError, commentSkipReason }) => ({ ...interactionRow(post, options), selected: true,
          ...(imageContext ? { imageContext } : {}), ...(imageReadError ? { imageReadError } : {}), ...(commentSkipReason ? { commentSkipReason } : {}),
          like: { state: like ? 'pending' : 'skipped', message: like ? '' : '本轮未安排点赞' },
          comment: { state: comment ? 'pending' : 'skipped', message: comment ? '' : commentSkipReason || '本轮未安排评论' } }));
        record.scan = scan; record.targetUserId = targetUserId; this.save();
        const comments = record.rows.filter(row => row.comment.state === 'pending');
        if (settings.commentMode === 'generated' && comments.length) {
          record.phase = 'generating'; this.save(); await this.generateRows(record, comments, context, combined, check);
        }
        check(); record.phase = 'executing'; this.save();
        return await this.execute(record, record.rows, context, combined, check);
      } catch (error) {
        record.error = publicError(error, '自动互动未完成，未重复提交'); record.state = combined.aborted ? 'cancelled' : 'failed';
        record.finishedAt = this.channel.now(); record.updatedAt = this.channel.now(); record.revision = randomUUID(); delete record.phase; this.save();
        return this.view(record);
      }
    });
  }
  draft(context, id, revision) {
    const record = this.record(context, id);
    if (record.state !== 'draft' || record.revision !== revision || this.active?.id === id)
      failure('MOMENTS_INTERACTION_CHANGED', '本轮内容或执行状态已变化，请刷新后再操作；不会重复提交');
    return record;
  }
  edit(accountId, id, revision, input, signal, assertAllowed = () => {}, scope) {
    const context = this.context(accountId, scope); this.check(context, signal, assertAllowed);
    const record = this.draft(context, id, revision), edits = interactionEdits(input, record.rows);
    for (const row of record.rows) if (edits.has(row.postId)) {
      const value = edits.get(row.postId); row.selected = value.selected;
      if (value.commentText.trim() !== row.commentText) { row.commentText = value.commentText.trim(); row.commentSource = 'manual'; row.commentSkipReason = ''; }
    }
    record.updatedAt = this.channel.now(); record.revision = randomUUID(); this.save(); return this.view(record);
  }
  launch(record, kind, context, signal, assertAllowed, operation) {
    if (this.active) failure('MOMENTS_INTERACTION_BUSY', '已有一轮互动正在生成或执行，请等待完成或停止当前轮次');
    const controller = new AbortController(), combined = AbortSignal.any([controller.signal, this.lifetime.signal,
      AbortSignal.timeout(timeLimitMs(this.channel.store, kind === 'generating' ? 'momentsCommentTimeoutMinutes' : 'momentsInteractionTimeoutMinutes')), ...(signal ? [signal] : [])]);
    const check = () => this.check(context, combined, assertAllowed);
    const active = { id: record.id, accountId: record.accountId, kind, controller }; this.active = active;
    record.state = kind; record.revision = randomUUID(); record.updatedAt = this.channel.now();
    try { this.save(); } catch (error) { if (this.active === active) this.active = undefined; throw error; }
    active.promise = this.track(Promise.resolve().then(() => operation(combined, check)).finally(() => { if (this.active === active) this.active = undefined; }));
    return active.promise;
  }
  generate(accountId, id, revision, signal, assertAllowed = () => {}, scope) {
    const context = this.context(accountId, scope); this.check(context, signal, assertAllowed);
    const record = this.draft(context, id, revision);
    if (!interactionHasComment(record.options.action) || record.options.commentMode !== 'generated')
      failure('MOMENTS_INTERACTION_INVALID', '本轮没有选择按图文生成评论');
    const rows = record.rows.filter(row => row.selected && row.comment.state === 'pending' && (!row.commentSkipReason || row.imageCount > 0) && (row.commentSource !== 'manual' || !row.commentText));
    if (!rows.length) return Promise.resolve(this.view(record));
    return this.launch(record, 'generating', context, signal, assertAllowed, async (combined, check) => {
      try {
        await this.generateRows(record, rows, context, combined, check);
      } catch (error) { record.generationError = publicError(error, '评论生成未完成，尚未提交微信').message; throw error; }
      finally { record.state = 'draft'; delete record.phase; record.revision = randomUUID(); record.updatedAt = this.channel.now(); this.save(); }
      check(); return this.view(record);
    });
  }
  async generateRows(record, rows, context, signal, check) {
    const ready = [];
    for (const row of rows) {
      check();
      if (record.options.skipCommented) {
        const post = await readInteractionDetail(this.channel, context, row.postId, signal, check);
        if (interactionContentHash(post) !== row.contentHash || post.deleted || !post.contentAvailable) {
          row.commentText = ''; row.commentSkipReason = '动态内容或可见状态已变化，请重新读取'; continue;
        }
        if (await interactionOwnComment(this.channel, context, post, signal, check)) {
          row.commentText = ''; row.commentSkipReason = '已有当前账号的评论，按本轮设置跳过'; continue;
        }
      }
      if (row.imageCount > 0) {
        record.phase = 'reading-images'; this.save();
        try {
          if (!record.automatic || row.imageContext?.contentHash !== row.contentHash && !row.imageReadError) {
            delete row.imageReadError;
            row.imageContext = await readMomentsImageContext(this.channel, { accountId: record.accountId, scopeKey: context.scopeKey,
              postId: row.postId, expectedHash: row.contentHash }, signal, check);
          }
        } catch (error) {
          check(); row.commentText = ''; delete row.imageContext;
          row.imageReadError = momentsImageFailure(error);
          if (!recoverableMomentsImageError(error)) { row.commentSkipReason = row.imageReadError.message; continue; }
        }
        if (!momentsCommentBasis(row.text, row.imageContext)) {
          row.commentText = ''; row.commentSkipReason = '配图未读到可用内容，且没有可回复的正文，已跳过自动评论'; continue;
        }
      }
      ready.push(row);
    }
    check(); record.phase = 'generating'; this.save();
    if (ready.length) {
      const generated = await generateInteractionComments(this.channel, ready, record.options.instructions, signal, check, record.accountId); check();
      for (const row of ready) { const value = generated.get(row.postId); row.commentText = value.text; row.commentSkipReason = value.skipReason;
        row.commentSource = 'generated'; row.commentBasis = momentsCommentBasis(row.text, row.imageContext); }
    }
    delete record.generationError; this.save();
  }
  start(accountId, id, revision, signal, assertAllowed = () => {}, scope) {
    const context = this.context(accountId, scope); this.check(context, signal, assertAllowed);
    const existing = this.record(context, id);
    if (existing.state !== 'draft' && existing.state !== 'generating') return this.view(existing);
    const record = this.draft(context, id, revision), rows = record.rows.filter(row => row.selected);
    if (!rows.length || rows.length > 20) failure('MOMENTS_INTERACTION_INVALID', '请先选择本轮要互动的 1–20 条动态');
    if (interactionHasComment(record.options.action) && rows.some(row => row.comment.state === 'pending' && !row.commentText && !row.commentSkipReason))
      failure('MOMENTS_INTERACTION_CONTENT', '部分评论还没有内容，请先生成或填写，或取消选择对应动态');
    if (this.channel.transport.status().momentsWriteReady !== true || typeof this.channel.transport.writeMoments !== 'function')
      failure('MOMENTS_WRITE_UNAVAILABLE', '朋友圈写入组件尚未就绪');
    this.launch(record, 'running', context, signal, assertAllowed, (combined, check) => this.execute(record, rows, context, combined, check));
    return this.view(record);
  }
  async execute(record, rows, context, signal, check) {
    record.startedAt = this.channel.now(); delete record.error; this.save();
    const skip = (row, message) => {
      for (const step of [row.like, row.comment]) if (step.state === 'pending') { step.state = 'skipped'; step.message = message; }
      this.save();
    };
    try {
      for (const [index, row] of rows.entries()) {
        check();
        let post;
        try { post = await readInteractionDetail(this.channel, context, row.postId, signal, check); }
        catch (error) { check(); if (error.code !== 'OBJECT_NOT_AUTHORIZED') throw error; skip(row, error.message); continue; }
        if (post.deleted || !post.contentAvailable || post.author.userId !== row.userId || interactionContentHash(post) !== row.contentHash) {
          skip(row, '动态内容、作者或可见状态已变化，请重新读取'); continue;
        }
        const prior = record.automatic ? this.priorInteractions(context.accountId, record.id).get(row.postId) : null;
        if (row.like.state === 'pending') {
          if (post.likedByCurrentAccount || record.automatic?.settings.skipLiked && prior?.like?.confirmed) {
            row.like = { state: 'existing', message: '已确认当前账号点赞，跳过本次提交' }; this.save(); }
          else await this.submit(record, row, 'like', context, signal, check);
        }
        check();
        if (row.comment.state === 'pending') {
          if (row.commentSkipReason) row.comment = { state: 'skipped', message: row.commentSkipReason };
          else if (row.commentSource === 'generated' && row.imageCount > 0 && !(
              row.commentBasis === 'text' && readableInteractionText(row.text) && !readableMomentsImages(row.imageContext).length ||
              row.imageContext?.version === momentsImageContextVersion && readableMomentsImages(row.imageContext).length > 0 &&
              row.imageContext.contentHash === row.contentHash && row.imageContext.accountId === record.accountId && row.imageContext.postId === row.postId))
            row.comment = { state: 'skipped', message: '这条评论缺少真实图片或正文依据，请重新生成后再执行' };
          else if (record.options.skipCommented && (prior?.comment?.confirmed || await interactionOwnComment(this.channel, context, post, signal, check)))
            row.comment = { state: 'existing', message: '已有当前账号的评论，按本轮设置跳过' };
          else await this.submit(record, row, 'comment', context, signal, check);
          this.save();
        }
        record.updatedAt = this.channel.now(); this.save(); check();
        if (index + 1 < rows.length && record.options.intervalSeconds) await this.sleep(record.options.intervalSeconds * 1000, signal);
      }
      record.state = 'completed';
    } catch (error) {
      record.error = publicError(error, '本轮互动未全部完成，未重复提交');
      record.state = signal.aborted ? 'cancelled' : summary(record).liked + summary(record).commented > 0 || hasUnknown(record) ? 'partial' : 'failed';
    } finally { record.finishedAt = this.channel.now(); record.updatedAt = this.channel.now(); record.revision = randomUUID(); delete record.phase; this.save(); }
    return this.view(record);
  }
  async submit(record, row, action, context, signal, check) {
    check(); const query = { action, postId: row.postId, ...(action === 'comment' ? { text: row.commentText } : {}) };
    const uncertain = Object.values(this.data.runs).some(previous => previous.id !== record.id && previous.accountId === record.accountId &&
      previous.rows.some(item => item.postId === row.postId && ['sending', 'unknown'].includes(item[action].state)));
    if (uncertain) {
      row[action] = { state: 'skipped', message: '此动态已有结果不明的提交，请先在微信核对；本轮没有重发' }; this.save(); return;
    }
    row[action] = { state: 'sending', message: '等待微信确认' }; this.save();
    try {
      const result = context.scope.chatType === 'owner'
        ? await this.channel.moments.writeOwner(query, context.accountId, 'interaction:' + record.id, signal, check)
        : await this.channel.moments.write(query, context.scope, 'interaction:' + record.id, signal, check);
      row[action] = { state: result.alreadyLiked ? 'existing' : 'succeeded', message: '微信已确认', result }; this.save(); check();
    } catch (error) {
      if (row[action].state === 'sending') {
        row[action] = { state: ['not-sent', 'rejected'].includes(error?.details?.snsDelivery) ? 'rejected' : 'unknown',
          message: publicError(error, '未取得最终回执，未重发').message }; this.save();
      }
      throw error;
    }
  }
  async wait(accountId, id, scope) {
    const context = this.context(accountId, scope); this.check(context); this.record(context, id);
    if (this.active?.id === id) await this.active.promise;
    this.check(context); return this.view(this.record(context, id));
  }
  cancel(accountId, id, scope) {
    const context = this.context(accountId, scope); this.check(context); const record = this.record(context, id);
    if (this.active?.id === id) this.active.controller.abort(new ChannelError('MOMENTS_INTERACTION_CANCELLED', '已请求停止本轮，保留已确认的操作与未知结果'));
    else if (record.state === 'draft') { record.state = 'discarded'; record.revision = randomUUID(); record.updatedAt = this.channel.now(); this.save(); }
    return this.view(record);
  }
  async close() { this.lifetime.abort(new ChannelError('PLUGIN_STOPPING', '插件停止，本轮未继续执行')); await Promise.allSettled([this.automation.close(), ...this.pending]); }
  async whenIdle() { await Promise.allSettled([this.automation.whenIdle(), ...this.pending]); }
}
