import { createHash } from 'node:crypto';
import { momentsId } from '../../../shared/moments.mjs';

const momentPersonId = value => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value) && !value.endsWith('@chatroom');
const momentSourceTime = (value, now) => Number.isSafeInteger(value) && value > 0 && value * 1000 <= now;
const momentPersonSourceId = (accountId, postId, commentId) => createHash('sha256')
  .update(JSON.stringify([accountId, 'moments', postId, commentId ?? 'post'])).digest('hex');

/** Only the author's literal text is evidence. Photos, link previews, likes and
 * another person's words never become this person's facts. */
export function momentPersonSources(accountId, result, query, now) {
  if (result?.accountId !== accountId || result.source !== 'wechat-sns-live' ||
      !['timeline', 'user', 'detail', 'comments'].includes(result.action) || result.action !== (query?.action ?? 'timeline') ||
      !Array.isArray(result.items) || query?.postId && (result.action === 'comments' ? result.postId !== query.postId
        : result.items.length !== 1 || result.items[0]?.id !== query.postId) ||
      query?.userId && (result.userId !== query.userId || result.items.some(post => post.author?.userId !== query.userId))) return [];
  const sources = [];
  const add = (postId, commentId, author, text, createdAt, truncated = false) => {
    if (!momentsId(postId) || commentId !== undefined && !momentsId(commentId) || !momentPersonId(author?.userId) ||
        author.userId === accountId || !momentSourceTime(createdAt, now) || typeof text !== 'string' ||
        !text.trim() || text.length > 12000 || truncated) return;
    sources.push({ id: momentPersonSourceId(accountId, postId, commentId), kind: 'moments', accountId, chatType: 'moments',
      peerId: author.userId, conversationName: '朋友圈', postId, ...(commentId ? { commentId } : {}),
      messageKey: 'moments:' + postId + (commentId ? ':' + commentId : ''), messageId: commentId ?? postId,
      senderId: author.userId, senderName: String(author.nickname || author.userId).slice(0, 80),
      time: createdAt * 1000, text });
  };
  const comments = (postId, rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (row && row.deleted === false && momentsId(row.id))
      add(postId, row.id, { userId: row.userId, nickname: row.nickname }, row.text, row.createdAt);
  };
  if (result.action === 'comments') comments(result.postId, result.items);
  else for (const post of result.items) {
    if (!post || !momentsId(post.id) || !momentPersonId(post.author?.userId) ||
        !momentSourceTime(post.createdAt, now) || post.deleted !== false || post.contentAvailable !== true) continue;
    add(post.id, undefined, post.author, post.text, post.createdAt, post.textTruncated);
    comments(post.id, post.comments);
  }
  return sources;
}

export function validMomentPersonSource(source) {
  return source?.kind === 'moments' && source.chatType === 'moments' && momentPersonId(source.senderId) &&
    source.peerId === source.senderId && momentsId(source.postId) &&
    (source.commentId === undefined || momentsId(source.commentId)) &&
    source.id === momentPersonSourceId(source.accountId, source.postId, source.commentId) &&
    Number.isSafeInteger(source.time) && source.time > 0 && typeof source.text === 'string' &&
    !!source.text.trim() && source.text.length <= 12000;
}
