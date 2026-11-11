import { ChannelError } from './contracts.mjs';
import { MOMENTS_INTERACTION_DEFAULTS } from './moments-interactions.mjs';

export const MOMENTS_INTERACTION_AUTOMATION_DEFAULTS = Object.freeze({ enabled: false, intervalMinutes: 60, lookbackDays: 3,
  likeCount: 5, commentCount: 2, source: 'timeline', user: '', mode: 'latest', poolSize: 50, perFriendLimit: 2,
  intervalSeconds: 5, skipLiked: true, skipCommented: true, commentMode: 'generated', commentText: '',
  instructions: MOMENTS_INTERACTION_DEFAULTS.instructions });

export function interactionAutomationSettings(input = {}) {
  const invalid = () => { throw new ChannelError('MOMENTS_INTERACTION_SETTINGS_INVALID',
    '检查间隔为 5–1440 分钟，读取最近 1–30 天，每轮点赞、评论各 0–20 条（0 表示不做），候选最多 100 条；开启时至少选择一种互动'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(MOMENTS_INTERACTION_AUTOMATION_DEFAULTS, key))) invalid();
  const value = { ...MOMENTS_INTERACTION_AUTOMATION_DEFAULTS, ...input };
  const integer = (key, min, max) => Number.isInteger(value[key]) && value[key] >= min && value[key] <= max;
  if (!['enabled', 'skipLiked', 'skipCommented'].every(key => typeof value[key] === 'boolean') ||
      !integer('intervalMinutes', 5, 1440) || !integer('lookbackDays', 1, 30) || !integer('likeCount', 0, 20) || !integer('commentCount', 0, 20) ||
      !integer('poolSize', Math.max(1, Math.min(20, value.likeCount + value.commentCount)), 100) || !integer('perFriendLimit', 1, 20) || !integer('intervalSeconds', 0, 60) ||
      !['timeline', 'user'].includes(value.source) || !['latest', 'random'].includes(value.mode) || !['generated', 'fixed'].includes(value.commentMode) ||
      typeof value.user !== 'string' || value.user.length > 150 || value.source === 'user' && !value.user.trim() ||
      typeof value.commentText !== 'string' || value.commentText.length > 2000 || typeof value.instructions !== 'string' || value.instructions.length > 1000 ||
      value.enabled && value.likeCount + value.commentCount === 0 || value.commentCount > 0 && value.commentMode === 'fixed' && !value.commentText.trim()) invalid();
  return { ...value, user: value.source === 'user' ? value.user.trim() : '', commentText: value.commentText.trim() };
}

export function automaticInteractionOptions(settings) {
  return { source: settings.source, user: settings.user, postIds: [], mode: settings.mode,
    action: settings.likeCount && settings.commentCount ? 'both' : settings.commentCount ? 'comment' : 'like',
    count: Math.max(1, Math.min(20, settings.likeCount + settings.commentCount)), poolSize: settings.poolSize,
    lookbackDays: settings.lookbackDays, perFriendLimit: settings.perFriendLimit, intervalSeconds: settings.intervalSeconds,
    commentMode: settings.commentMode, commentText: settings.commentText, instructions: settings.instructions, skipCommented: settings.skipCommented };
}
