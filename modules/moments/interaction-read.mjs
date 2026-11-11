import { ChannelError } from '../../shared/contracts.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { resolveMomentsQuery } from './service.mjs';

export { interactionContentHash } from './post-content.mjs';
// Older WeChat emoji are returned as bracketed names or slash codes. Those
// labels do not tell us what is depicted in the attached photos.
export const readableInteractionText = text => typeof text === 'string' && /[\p{L}\p{N}]/u.test(text
  .replace(/https?:\/\/\S+/gi, '').replace(/\[[^\]\r\n]{1,24}\]/g, '').replace(/\/[a-zA-Z:;()~*<>@#&!^\\-]{1,12}/g, ''));
export const newestInteractionFirst = (a, b) => b.createdAt - a.createdAt || (a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1);
function validatePage(result, accountId, action, userId) {
  if (result?.accountId !== accountId || result.source !== 'wechat-sns-live' || result.action !== action || !Array.isArray(result.items) ||
      result.items.some(post => !momentsId(post.id) || typeof post.author?.userId !== 'string' || !post.author.userId ||
        !Number.isSafeInteger(post.createdAt) || post.createdAt <= 0 || typeof post.text !== 'string' ||
        typeof post.deleted !== 'boolean' || typeof post.contentAvailable !== 'boolean' || typeof post.likedByCurrentAccount !== 'boolean' ||
        userId && post.author.userId !== userId))
    throw new ChannelError('MOMENTS_INTERACTION_READ', '动态的账号、作者或内容状态不完整，未选择互动目标');
}
export async function readInteractionDetail(channel, context, postId, signal, check) {
  check();
  const page = await channel.transport.readMoments({ accountId: context.accountId, scopeKey: context.scopeKey, query: { action: 'detail', postId } }, signal);
  check(); validatePage(page, context.accountId, 'detail');
  if (page.items.length !== 1 || page.items[0].id !== postId) throw new ChannelError('MOMENTS_INTERACTION_READ', '返回的动态与本次选择不一致');
  return page.items[0];
}
export async function readInteractionPool(channel, options, context, signal, check) {
  const { accountId, scopeKey } = context, posts = [], seen = new Set(), cursors = new Set();
  let pageCount = 0, scanned = 0, cursor, targetUserId, complete = true;
  const threshold = options.lookbackDays ? channel.now() - options.lookbackDays * 86400000 : 0;
  const eligible = post => !post.deleted && post.contentAvailable && post.author.userId !== accountId &&
    post.createdAt * 1000 <= channel.now() + 60000 && (options.source === 'selected' || post.createdAt * 1000 >= threshold);
  if (options.source === 'selected') {
    for (const id of options.postIds) {
      const post = await readInteractionDetail(channel, context, id, signal, check); pageCount++; scanned++;
      if (!eligible(post)) throw new ChannelError('MOMENTS_INTERACTION_TARGET', '选中的动态已删除、不可见或属于当前账号，请重新选择好友动态');
      posts.push(post);
    }
  } else {
    const query = options.source === 'user'
      ? await resolveMomentsQuery(channel.transport, { action: 'user', subject: 'contact', user: options.user }, context.scope, signal, check)
      : { action: 'timeline' };
    targetUserId = query.userId; check();
    if (targetUserId === accountId) throw new ChannelError('MOMENTS_INTERACTION_TARGET', '好友互动请选择其他联系人；当前账号自己的动态可在“我的动态”管理');
    const targetCount = options.mode === 'latest' ? options.count : options.poolSize;
    for (let index = 0; index < 10; index++) {
      check();
      const page = await channel.transport.readMoments({ accountId, scopeKey,
        query: { ...query, limit: Math.min(20, targetCount - posts.length), ...(cursor ? { cursor } : {}) } }, signal);
      check(); pageCount++; validatePage(page, accountId, query.action, targetUserId); scanned += page.items.length;
      for (const post of page.items) if (!seen.has(post.id)) { seen.add(post.id); if (eligible(post)) posts.push(post); }
      cursor = page.nextCursor;
      if (posts.length >= targetCount || !cursor || page.items.length > 0 && page.items.every(post => post.createdAt * 1000 < threshold)) break;
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new ChannelError('MOMENTS_INTERACTION_READ', '朋友圈分页没有推进，未继续挑选');
      cursors.add(cursor);
      if (index === 9) complete = false;
    }
    posts.sort(newestInteractionFirst); posts.splice(targetCount);
  }
  return { posts, targetUserId, scan: { pageCount, scanned, poolCount: posts.length, complete, fetchedAt: channel.now(),
    message: complete ? '仅包含本次实际读取且当前可见的好友动态' : '已达到本轮读取上限，仅使用已核实的动态，未扩大范围或用未核实旧帖补位' } };
}

export async function interactionOwnComment(channel, context, post, signal, check) {
  if ((post.comments ?? []).some(row => row.userId === context.accountId && !row.deleted)) return true;
  if (Number.isInteger(post.visibleCommentEntries) && post.visibleCommentEntries >= 0 && post.visibleCommentEntries <= (post.comments?.length ?? 0)) return false;
  if (!post.interactionsTruncated && post.commentCount === 0) return false;
  let cursor; const cursors = new Set();
  for (let page = 0; page < 10; page++) {
    check(); const result = await channel.transport.readMoments({ accountId: context.accountId, scopeKey: context.scopeKey,
      query: { action: 'comments', postId: post.id, limit: 50, ...(cursor ? { cursor } : {}) } }, signal); check();
    if (result?.accountId !== context.accountId || result.source !== 'wechat-sns-live' || result.action !== 'comments' || result.postId !== post.id || !Array.isArray(result.items) ||
        result.items.some(row => typeof row.userId !== 'string' || !row.userId))
      throw new ChannelError('MOMENTS_INTERACTION_READ', '评论区未完整返回，未判断为尚未评论');
    if (result.items.some(row => row.userId === context.accountId && !row.deleted)) return true;
    if (!result.nextCursor) return false;
    cursor = result.nextCursor;
    if (typeof cursor !== 'string' || cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  throw new ChannelError('MOMENTS_INTERACTION_READ', '未能核实已有评论，未重复评论');
}
