import { ChannelError } from '../../shared/contracts.mjs';
import { personAuthorized, assertPersonAuthorized, authorizationEpoch, assertAuthorizationEpoch } from '../../shared/authorization.mjs';

const allowed = (channel, accountId, userId) => userId === accountId || personAuthorized(channel.store, accountId, userId);
const ownerKey = (accountId, postId) => accountId + ':' + postId;

/** All successful live reads feed the independent person-memory queue, after
 * the caller's account/authorization/cancellation check. Capture failures are
 * recorded by that queue and never prevent returning a valid WeChat read. */
export async function readMomentsWithMemory(channel, params, signal, check = () => {}) {
  check();
  const epoch = authorizationEpoch(channel.store, params.accountId);
  if (params.query?.userId && params.query.userId !== params.accountId)
    assertPersonAuthorized(channel.store, params.accountId, params.query.userId);
  const combined = channel.authorization?.combine(params.accountId, signal) ?? signal;
  const raw = await channel.transport.readMoments({ ...params, authorizedUserIds: [...channel.store.settings(params.accountId).privatePeers] }, combined);
  check();
  assertAuthorizationEpoch(channel.store, params.accountId, epoch);
  if (raw?.accountId !== params.accountId || raw.source !== 'wechat-sns-live' || !Array.isArray(raw.items))
    throw new ChannelError('MOMENTS_AUTHORIZATION_UNVERIFIED', '朋友圈账号或来源无法核实，未使用未授权对象的资料。');
  return finishAuthorizedRead(channel, params, raw);
}

export function filterAuthorizedMoments(channel, params, raw) {
  if (raw?.accountId !== params.accountId || raw.source !== 'wechat-sns-live' || !Array.isArray(raw.items))
    throw new ChannelError('MOMENTS_AUTHORIZATION_UNVERIFIED', '朋友圈账号或来源无法核实，未使用未授权对象的资料。');
  if (params.query?.action === 'user' && (raw.action !== 'user' || raw.userId !== params.query.userId ||
      raw.items.some(post => post.author?.userId !== params.query.userId)))
    throw new ChannelError('MOMENTS_AUTHORIZATION_UNVERIFIED', '好友主页返回的目标或作者不一致，未使用本页资料或执行互动。');
  const owners = channel.momentOwners ??= new Map(), comments = channel.momentCommentOwners ??= new Map();
  const rememberComments = (postId, rows) => { for (const row of rows || []) if (row.id && row.userId)
    comments.set(ownerKey(params.accountId, postId) + ':' + row.id, row.userId); };
  let result;
  if (raw.action === 'comments') {
    rememberComments(raw.postId, raw.items);
    const userId = owners.get(ownerKey(params.accountId, raw.postId));
    if (userId && !allowed(channel, params.accountId, userId))
      throw new ChannelError('OBJECT_NOT_AUTHORIZED', '这条动态的作者未授权，未读取评论。', { snsDelivery: 'not-sent' });
    const items = raw.items.filter(row => allowed(channel, params.accountId, row.userId));
    result = { ...raw, items, authorizationFilteredCount: (raw.authorizationFilteredCount || 0) + raw.items.length - items.length };
  } else {
    for (const post of raw.items) if (typeof post.author?.userId === 'string') {
      owners.set(ownerKey(params.accountId, post.id), post.author.userId); rememberComments(post.id, post.comments);
    }
    const items = raw.items.filter(post => allowed(channel, params.accountId, post.author?.userId)).map(post => ({ ...post,
      ...(Array.isArray(post.comments) ? { comments: post.comments.filter(row => allowed(channel, params.accountId, row.userId)) } : {}),
      ...(Array.isArray(post.likes) ? { likes: post.likes.filter(row => allowed(channel, params.accountId, row.userId)) } : {}),
    }));
    result = { ...raw, items, authorizationFilteredCount: (raw.authorizationFilteredCount || 0) + raw.items.length - items.length,
      oldestScannedAt: raw.oldestScannedAt ?? Math.min(...raw.items.map(post => post.createdAt).filter(Number.isFinite)) };
  }
  while (owners.size > 2000) owners.delete(owners.keys().next().value);
  while (comments.size > 5000) comments.delete(comments.keys().next().value);
  return result;
}

/** Image reads carry a live post too; keep the same object boundary as text reads. */
export function filterAuthorizedMomentsImages(channel, params, raw) {
  const postId = params.query?.postId;
  if (raw?.accountId !== params.accountId || raw.source !== 'wechat-sns-images-live' || raw.postId !== postId ||
      !postId || raw.post?.id !== postId || typeof raw.post.author?.userId !== 'string' || !raw.post.author.userId)
    throw new ChannelError('MOMENTS_AUTHORIZATION_UNVERIFIED', '朋友圈图片的账号、动态或作者无法核实，未使用图片资料。');
  if (!allowed(channel, params.accountId, raw.post.author.userId))
    throw new ChannelError('OBJECT_NOT_AUTHORIZED', '这条图片动态的作者未授权，未使用画面或人物资料。', { snsDelivery: 'not-sent' });
  const page = filterAuthorizedMoments(channel, params, { accountId: raw.accountId, source: 'wechat-sns-live', action: 'detail', items: [raw.post] });
  return { ...raw, post: page.items[0] };
}

function finishAuthorizedRead(channel, params, raw) {
  const result = filterAuthorizedMoments(channel, params, raw);
  channel.personMemory?.captureMoments(params.accountId, result, params.query); return result;
}

export async function assertMomentTargetAuthorized(channel, accountId, postId, signal, check = () => {}) {
  let userId = channel.momentOwners?.get(ownerKey(accountId, postId));
  if (!userId) {
    const page = await readMomentsWithMemory(channel, { accountId, scopeKey: 'authorization:' + accountId,
      query: { action: 'detail', postId } }, signal, check);
    userId = page.items.find(post => post.id === postId)?.author?.userId;
  }
  if (!userId || !allowed(channel, accountId, userId))
    throw new ChannelError('OBJECT_NOT_AUTHORIZED', '这条动态的作者未授权，未执行朋友圈操作。', { snsDelivery: 'not-sent' });
  check(); return userId;
}

export async function assertMomentReplyAuthorized(channel, accountId, postId, commentId, signal, check = () => {}) {
  const key = ownerKey(accountId, postId) + ':' + commentId;
  let userId = channel.momentCommentOwners?.get(key);
  if (!userId) {
    const page = await readMomentsWithMemory(channel, { accountId, scopeKey: 'authorization:' + accountId,
      query: { action: 'comments', postId, limit: 100 } }, signal, check);
    userId = page.items.find(comment => comment.id === commentId)?.userId || channel.momentCommentOwners?.get(key);
  }
  if (!userId || !allowed(channel, accountId, userId))
    throw new ChannelError('OBJECT_NOT_AUTHORIZED', '这条评论的作者未授权，未向其回复。', { snsDelivery: 'not-sent' });
  check(); return userId;
}
