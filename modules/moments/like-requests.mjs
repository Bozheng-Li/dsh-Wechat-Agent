import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ChannelError, eligible, publicError } from '../../shared/contracts.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { isMomentsLikeRequest, isSelfMomentsLikeRequest, momentsLikeRequestArgs } from '../../shared/moments-like-request.mjs';
import { remoteAuthorized } from '../remote/authorization/policy.mjs';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { workPath } from '../work/policy.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { readMomentsWithMemory } from './read.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selfNames = new Set(['我', '我的', '自己', '本人', '发起人', 'sender', 'self', 'me']);
const rowStates = new Set(['liked', 'existing', 'unknown', 'rejected', 'not-sent']);

/** Narrow permission: ordinary participants can request likes on their own
 * posts. The generic social reader/writer still requires administrator access. */
export class MomentsLikeRequests {
  constructor(channel, operations) { this.channel = channel; this.operations = operations; this.active = new Map(); }
  check(scope, text, signal, assertAllowed = () => {}, targetUserId) {
    signal?.throwIfAborted(); assertAllowed();
    const channel = this.channel, status = channel.transport.status();
    if (channel.closed || channel.fault || !status.online || status.account?.id !== scope?.accountId)
      throw new ChannelError('ACCOUNT_CHANGED', '微信账号或连接已变化，未继续点赞');
    if (!scope || !['private', 'group'].includes(scope.chatType) || typeof scope.peerId !== 'string' || typeof scope.senderId !== 'string' ||
        !scope.senderId || scope.senderId === scope.accountId || scope.senderId.endsWith('@chatroom') ||
        scope.peerId.endsWith('@chatroom') !== (scope.chatType === 'group') || scope.chatType === 'private' && scope.senderId !== scope.peerId ||
        !eligible(channel.store.settings(scope.accountId), scope))
      throw new ChannelError('MOMENTS_LIKE_NOT_AUTHORIZED', '只能响应当前已授权会话中真实发起人的点赞请求');
    if (!isMomentsLikeRequest(text)) throw new ChannelError('MOMENTS_LIKE_REQUEST_REQUIRED', '当前消息没有明确请求朋友圈点赞，未读取或提交');
    const manager = channel.momentsAutomation?.likes;
    if (!manager || manager.error || manager.rule(scope.accountId).settings.respondToRequests !== true)
      throw new ChannelError('MOMENTS_LIKE_REQUEST_DISABLED', '响应聊天点赞请求已关闭或设置不可用');
    if (!remoteAuthorized(channel, scope) && targetUserId && targetUserId !== scope.senderId)
      throw new ChannelError('MOMENTS_LIKE_NOT_AUTHORIZED', '普通会话只能请求给自己发布的朋友圈点赞，其他好友须由管理员指定');
    if (status.momentsReadReady !== true || status.momentsWriteReady !== true || typeof channel.transport.readMoments !== 'function' || typeof channel.transport.writeMoments !== 'function')
      throw new ChannelError('MOMENTS_WRITE_UNAVAILABLE', '当前微信组件尚未支持读取与点赞朋友圈');
    channel.store.config.assertCurrent();
  }
  available(scope, text) { try { this.check(scope, text); return true; } catch { return false; } }
  result(record, reusedRequest = false) {
    const results = record.results ?? [], failed = results.find(row => ['unknown', 'rejected', 'not-sent'].includes(row.state));
    return { ok: record.state === 'completed' && !failed && !record.error, action: 'like-recent', accountId: record.accountId,
      target: { userId: record.targetUserId, nickname: record.posts?.[0]?.nickname ?? '' }, requestedCount: record.args.count,
      selectedCount: record.posts?.length ?? 0, liked: results.filter(row => row.state === 'liked').length,
      alreadyLiked: results.filter(row => row.state === 'existing').length, remaining: Math.max(0, (record.posts?.length ?? 0) - results.length),
      results: structuredClone(results), ...(record.error ? { error: record.error } : {}), reusedRequest,
      selection: '最新 N 条，已赞动态占原位置，不顺延补点旧动态',
      ...(!record.posts?.length && record.state === 'completed' ? { message: '微信没有返回可见且未删除的目标动态，未点赞' } : {}) };
  }
  async like(input, scope, requestId, text, signal, assertAllowed = () => {}) {
    this.check(scope, text, signal, assertAllowed);
    const args = momentsLikeRequestArgs(input, text);
    if (typeof requestId !== 'string' || !requestId || requestId.length > 1800)
      throw new ChannelError('MOMENTS_LIKE_REQUEST_INVALID', '点赞请求缺少实际消息或任务编号');
    const ownTarget = args.subject === 'speaker' || args.subject === undefined && (selfNames.has(args.user.toLocaleLowerCase()) || args.user === scope.senderId);
    if (!ownTarget && !remoteAuthorized(this.channel, scope))
      throw new ChannelError('MOMENTS_LIKE_NOT_AUTHORIZED', '普通会话只能请求给自己的朋友圈点赞');
    const selfRequested = isSelfMomentsLikeRequest(text);
    if (args.subject === undefined && (selfRequested && !ownTarget || !selfRequested && ownTarget))
      throw new ChannelError('MOMENTS_LIKE_REQUEST_TARGET', '旧式目标参数与本条请求不一致；请根据原话和上下文明确选择 subject，不猜测动态作者');
    const scopeKey = identity([scope.accountId, scope.chatType, scope.peerId, scope.senderId]);
    const id = hash([this.channel.store.data.storeId, scopeKey, requestId]), inputHash = hash(args);
    const pending = this.active.get(id);
    if (pending) {
      if (pending.inputHash !== inputHash) throw new ChannelError('MOMENTS_LIKE_REQUEST_CHANGED', '同一请求的目标或数量发生变化，未扩大点赞范围');
      const result = await pending.promise; this.check(scope, text, signal, assertAllowed, result.target.userId); return { ...result, reusedRequest: true };
    }
    const file = workPath(this.channel.store.root, 'storage/moments/like-requests/' + id + '.json');
    const save = record => {
      workPath(this.channel.store.root, 'storage/moments/like-requests/' + id + '.json');
      try { atomicBytes(file, Buffer.from(JSON.stringify(record, null, 2) + '\n')); }
      catch { throw new ChannelError('STATE_WRITE_FAILED', '本次点赞进度无法保存，未继续；已提交的结果请核对微信'); }
    };
    const run = async () => {
      let record, loaded = false;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); loaded = true; }
      catch (error) { if (error.code !== 'ENOENT') throw new ChannelError('MOMENTS_STATE_INVALID', '本次点赞记录无法读取，未重复执行'); }
      if (loaded) {
        if (!record || typeof record !== 'object' || Array.isArray(record))
          throw new ChannelError('MOMENTS_STATE_INVALID', '本次点赞记录不是有效对象，未重复执行');
        const validPost = row => row && typeof row === 'object' && !Array.isArray(row) && momentsId(row.postId) && row.userId === record.targetUserId &&
          Number.isSafeInteger(row.createdAt) && row.createdAt > 0 && typeof row.nickname === 'string' && row.nickname.length <= 150 &&
          typeof row.text === 'string' && row.text.length <= 240 && typeof row.alreadyLiked === 'boolean';
        const validResult = row => validPost(row) && rowStates.has(row.state) && record.posts.some(post => post.postId === row.postId && post.createdAt === row.createdAt) &&
          (!['liked', 'existing'].includes(row.state) || row.liked === true && ['server-ack', 'verified-existing'].includes(row.delivery));
        if (record.version !== 1 || record.ownerStoreId !== this.channel.store.data.storeId || record.id !== id || record.scopeKey !== scopeKey || record.inputHash !== inputHash ||
            !['selected', 'completed'].includes(record.state) || record.accountId !== scope.accountId || typeof record.targetUserId !== 'string' || hash(record.args ?? null) !== inputHash ||
            ownTarget && record.targetUserId !== scope.senderId || !Array.isArray(record.posts) || record.posts.length > args.count || record.posts.some(row => !validPost(row)) ||
            new Set(record.posts.map(row => row.postId)).size !== record.posts.length || !Array.isArray(record.results) || record.results.length > record.posts.length ||
            record.results.some(row => !validResult(row)) || new Set(record.results.map(row => row.postId)).size !== record.results.length ||
            record.state === 'selected' && (record.error || record.results.some(row => !['liked', 'existing'].includes(row.state))) ||
            record.state === 'completed' && !record.error && !record.results.some(row => !['liked', 'existing'].includes(row.state)) && record.results.length !== record.posts.length)
          throw new ChannelError('MOMENTS_STATE_INVALID', '本次点赞记录与账号、发起人或操作内容不符，未重复执行');
        this.check(scope, text, signal, assertAllowed, record.targetUserId);
        if (record.state === 'completed') return this.result(record, true);
      } else {
        const check = () => this.check(scope, text, signal, assertAllowed);
        const query = ownTarget ? { action: 'user', userId: scope.senderId } : await this.operations.resolve({ action: 'user',
          ...(args.subject === 'account' ? { subject: 'account' } : { ...(args.subject ? { subject: args.subject } : {}), user: args.user }) }, scope, signal, check);
        const targetUserId = query.userId; this.check(scope, text, signal, assertAllowed, targetUserId);
        const items = [], seen = new Set(), cursors = new Set(); let cursor;
        for (let page = 0; page < 5; page++) {
          const result = await readMomentsWithMemory(this.channel, { accountId: scope.accountId, scopeKey,
            query: { ...query, limit: args.count - items.length, ...(cursor ? { cursor } : {}) } }, signal,
            () => this.check(scope, text, signal, assertAllowed, targetUserId));
          this.check(scope, text, signal, assertAllowed, targetUserId);
          if (result?.selection?.recencyVerified === false)
            throw new ChannelError('MOMENTS_LIKE_READ_INCOMPLETE', '已读到部分可见动态，但微信未返回完整范围，无法核实最新位置；请恢复读取后重试或明确选择动态');
          if (result?.accountId !== scope.accountId || result.action !== 'user' || !Array.isArray(result.items) ||
              result.items.some(post => !momentsId(post.id) || post.author?.userId !== targetUserId || !Number.isSafeInteger(post.createdAt) || post.createdAt <= 0 || typeof post.likedByCurrentAccount !== 'boolean'))
            throw new ChannelError('MOMENTS_LIKE_READ_INVALID', '微信返回的动态账号、作者或状态不完整，未进行点赞');
          for (const post of result.items) if (!post.deleted && !seen.has(post.id)) { seen.add(post.id); items.push(post); }
          if (items.length >= args.count || !result.nextCursor) break;
          if (page === 4) throw new ChannelError('MOMENTS_LIKE_READ_LIMIT', '本次分页读取仍未覆盖要求的最新动态范围，未猜测或点赞，请缩小数量后重新请求');
          if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor))
            throw new ChannelError('MOMENTS_LIKE_READ_INVALID', '微信动态分页没有前进，未进行点赞');
          cursor = result.nextCursor; cursors.add(cursor);
        }
        const posts = items
          .sort((a, b) => b.createdAt - a.createdAt || (BigInt(a.id) > BigInt(b.id) ? -1 : 1)).slice(0, args.count)
          .map(post => ({ postId: post.id, userId: targetUserId, nickname: post.author.nickname ?? '', createdAt: post.createdAt,
            text: String(post.text ?? '').slice(0, 240), alreadyLiked: post.likedByCurrentAccount }));
        record = { version: 1, ownerStoreId: this.channel.store.data.storeId, id, scopeKey, inputHash, args,
          accountId: scope.accountId, targetUserId, posts, results: [], state: 'selected', createdAt: this.channel.now() };
        save(record);
      }
      for (const post of record.posts) {
        if (record.results.some(row => row.postId === post.postId)) continue;
        const check = () => this.check(scope, text, signal, assertAllowed, record.targetUserId);
        check();
        if (post.alreadyLiked) record.results.push({ ...post, state: 'existing', delivery: 'verified-existing', liked: true });
        else {
          try {
            const receipt = await this.operations.write(post.postId, scope, 'like-request:' + id, signal, check);
            record.results.push({ ...post, state: receipt.alreadyLiked ? 'existing' : 'liked', delivery: receipt.delivery, liked: true,
              ...(receipt.reusedReceipt ? { reusedReceipt: true } : {}) });
          } catch (error) {
            const failure = publicError(error, '本条朋友圈点赞未取得确认');
            const state = error?.details?.snsDelivery === 'rejected' ? 'rejected' : error?.details?.snsDelivery === 'not-sent' ? 'not-sent' : 'unknown';
            record.results.push({ ...post, state, error: failure }); record.error = failure; record.state = 'completed';
            record.finishedAt = this.channel.now(); save(record);
            check(); return this.result(record);
          }
        }
        record.updatedAt = this.channel.now(); save(record); check();
      }
      record.state = 'completed'; record.finishedAt = this.channel.now(); save(record);
      this.check(scope, text, signal, assertAllowed, record.targetUserId); return this.result(record);
    };
    const promise = run(); this.active.set(id, { inputHash, promise });
    try { return await promise; } finally { this.active.delete(id); }
  }
}
