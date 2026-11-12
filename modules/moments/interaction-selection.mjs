import { readInteractionPool, interactionOwnComment, readableInteractionText, interactionContentHash } from './interaction-read.mjs';
import { readMomentsImageContext, momentsCommentBasis, momentsImageFailure, recoverableMomentsImageError } from './image-context.mjs';

/** Automatic quotas apply after eligibility checks. Manual latest-N semantics
 * remain positional; an automatic round scans its entire bounded candidate pool. */
export async function selectAutomaticInteractions(manager, record, context, signal, check) {
  const settings = record.automatic.settings;
  const { posts, scan, targetUserId } = await readInteractionPool(manager.channel, { ...record.options, mode: 'manual' }, context, signal, check);
  check();
  const ordered = [...posts], chosen = [], friends = new Map(), prior = manager.priorInteractions(context.accountId, record.id);
  const selection = { plannedLikes: 0, plannedComments: 0, skippedLiked: 0, skippedCommented: 0, skippedUnknown: 0, unreadable: 0, imageFailures: 0, friendLimit: 0 };
  if (settings.mode === 'random') for (let i = ordered.length - 1; i > 0; i--) {
    const target = manager.random(i + 1); [ordered[i], ordered[target]] = [ordered[target], ordered[i]];
  }
  for (const post of ordered) {
    check();
    if (chosen.length === 20 || selection.plannedLikes >= settings.likeCount && selection.plannedComments >= settings.commentCount) break;
    if (settings.source === 'timeline' && (friends.get(post.author.userId) ?? 0) >= settings.perFriendLimit) { selection.friendLimit++; continue; }
    let like = selection.plannedLikes < settings.likeCount, comment = selection.plannedComments < settings.commentCount;
    const history = prior.get(post.id) ?? {};
    for (const action of ['like', 'comment']) if (history[action]?.unknown && (action === 'like' ? like : comment)) {
      selection.skippedUnknown++; if (action === 'like') like = false; else comment = false;
    }
    if (like && settings.skipLiked && (post.likedByCurrentAccount || history.like?.confirmed)) { like = false; selection.skippedLiked++; }
    if (comment && settings.skipCommented && (history.comment?.confirmed || await interactionOwnComment(manager.channel, context, post, signal, check))) {
      comment = false; selection.skippedCommented++;
    }
    if (comment && settings.commentMode === 'generated' && !readableInteractionText(post.text) && !post.imageCount) { comment = false; selection.unreadable++; }
    let imageContext, imageReadError, commentSkipReason = '';
    if (comment && settings.commentMode === 'generated' && post.imageCount > 0) {
      record.phase = 'reading-images'; manager.save();
      try {
        imageContext = await readMomentsImageContext(manager.channel, { accountId: context.accountId, scopeKey: context.scopeKey,
          postId: post.id, expectedHash: interactionContentHash(post) }, signal, check);
      } catch (error) {
        check(); imageReadError = momentsImageFailure(error);
        if (!recoverableMomentsImageError(error)) commentSkipReason = imageReadError.message;
      }
      if (!imageContext?.complete) selection.imageFailures++;
      if (!commentSkipReason && !momentsCommentBasis(post.text, imageContext))
        commentSkipReason = '配图未读到可用内容，且没有可回复的正文，已跳过自动评论';
      if (commentSkipReason) { comment = false; selection.unreadable++; }
    }
    check();
    if (!like && !comment) continue;
    chosen.push({ post, like, comment, imageContext, imageReadError, commentSkipReason });
    if (like) selection.plannedLikes++; if (comment) selection.plannedComments++;
    friends.set(post.author.userId, (friends.get(post.author.userId) ?? 0) + 1);
  }
  return { chosen, targetUserId, scan: { ...scan, selection, message: scan.message + '；按动作分别跳过不符合条件的条目，每轮最多互动 20 条动态，数量不足按实际处理' } };
}
