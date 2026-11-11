import { ChannelError } from './contracts.mjs';
import { momentsId } from './moments.mjs';

export const MOMENTS_INTERACTION_ENDPOINTS = Object.freeze(['moments.interactions.list', 'moments.interactions.preview',
  'moments.interactions.edit', 'moments.interactions.generate', 'moments.interactions.run', 'moments.interactions.cancel',
  'moments.interactions.configure', 'moments.interactions.stop']);
export const MOMENTS_INTERACTION_DEFAULTS = Object.freeze({ source: 'timeline', user: '', postIds: Object.freeze([]), mode: 'latest',
  action: 'both', count: 3, poolSize: 20, lookbackDays: 7, perFriendLimit: 1, intervalSeconds: 3,
  commentMode: 'generated', commentText: '', instructions: '像朋友一样自然接话，简短、具体，不套话，不追问。', skipCommented: true });
export const interactionId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const interactionHasLike = action => ['like', 'both'].includes(action);
export const interactionHasComment = action => ['comment', 'both'].includes(action);
export const interactionRunStates = Object.freeze(['draft', 'generating', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted', 'discarded']);
export const interactionStepStates = Object.freeze(['pending', 'sending', 'succeeded', 'existing', 'skipped', 'rejected', 'unknown']);
export function interactionOptions(input = {}) {
  const fail = () => { throw new ChannelError('MOMENTS_INTERACTION_INVALID', '请选择动态范围、互动模式和动作；每轮 1–20 条，随机或手动候选最多 100 条，间隔 0–60 秒'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(MOMENTS_INTERACTION_DEFAULTS, key))) fail();
  const value = { ...MOMENTS_INTERACTION_DEFAULTS, ...input };
  if (!['timeline', 'user', 'selected'].includes(value.source) || !['latest', 'random', 'manual'].includes(value.mode) ||
      !['like', 'comment', 'both'].includes(value.action) || !['generated', 'fixed', 'manual'].includes(value.commentMode) ||
      typeof value.user !== 'string' || value.user.length > 150 || value.source === 'user' && !value.user.trim() ||
      !Array.isArray(value.postIds) || value.postIds.length > 20 || value.postIds.some(id => !momentsId(id)) ||
      value.source === 'selected' && !value.postIds.length || value.source !== 'selected' && value.postIds.length ||
      !Number.isInteger(value.count) || value.count < 1 || value.count > 20 ||
      !Number.isInteger(value.poolSize) || value.poolSize < value.count || value.poolSize > 100 ||
      !Number.isInteger(value.lookbackDays) || value.lookbackDays < 0 || value.lookbackDays > 30 ||
      !Number.isInteger(value.perFriendLimit) || value.perFriendLimit < 1 || value.perFriendLimit > 20 ||
      !Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 0 || value.intervalSeconds > 60 ||
      typeof value.skipCommented !== 'boolean' || typeof value.commentText !== 'string' || value.commentText.length > 2000 ||
      typeof value.instructions !== 'string' || value.instructions.length > 1000 ||
      interactionHasComment(value.action) && value.commentMode === 'fixed' && !value.commentText.trim()) fail();
  const postIds = [...new Set(value.postIds)];
  return { ...value, user: value.user.trim(), postIds, ...(value.source === 'selected' ? { count: postIds.length } : {}), commentText: value.commentText.trim() };
}

export function interactionEdits(input, rows) {
  if (!Array.isArray(input) || input.length > 100 || input.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some(key => !['postId', 'selected', 'commentText'].includes(key)) || !momentsId(item.postId) ||
      !rows.some(row => row.postId === item.postId) || typeof item.selected !== 'boolean' ||
      typeof item.commentText !== 'string' || item.commentText.length > 2000) || new Set(input.map(item => item.postId)).size !== input.length)
    throw new ChannelError('MOMENTS_INTERACTION_INVALID', '只能编辑本次已读取的动态与评论内容');
  const edits = new Map(input.map(item => [item.postId, item]));
  const selected = rows.filter(row => edits.get(row.postId)?.selected ?? row.selected);
  if (selected.length > 20) throw new ChannelError('MOMENTS_INTERACTION_INVALID', '每轮最多选择 20 条动态');
  return edits;
}
