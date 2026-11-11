import { ChannelError } from './contracts.mjs';

export const MOMENTS_DEFAULTS = Object.freeze({ enabled: false, intervalMinutes: 10, scope: 'own', selectedPostIds: [],
  lookbackDays: 7, maxRepliesPerRun: 10, includeExisting: false, replyInstructions: '简短自然地接住评论，适当幽默，不介绍功能。',
  friendRepliesEnabled: false, maxFriendRepliesPerRun: 5 });
export const momentsReplyEnabled = settings => settings.enabled || settings.friendRepliesEnabled;
export const momentsId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
export function momentsSettings(input = {}, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(MOMENTS_DEFAULTS, key)))
    throw new ChannelError('MOMENTS_SETTINGS_INVALID', '朋友圈定时设置包含不支持的字段');
  const value = { ...MOMENTS_DEFAULTS, ...input };
  if (typeof value.enabled !== 'boolean' || typeof value.friendRepliesEnabled !== 'boolean' || typeof value.includeExisting !== 'boolean' || !['own', 'selected'].includes(value.scope) ||
      !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 1440 ||
      !Number.isInteger(value.lookbackDays) || value.lookbackDays < 1 || value.lookbackDays > 365 ||
      !Number.isInteger(value.maxRepliesPerRun) || value.maxRepliesPerRun < 1 || value.maxRepliesPerRun > 50 ||
      !Number.isInteger(value.maxFriendRepliesPerRun) || value.maxFriendRepliesPerRun < 1 || value.maxFriendRepliesPerRun > 50 ||
      !Array.isArray(value.selectedPostIds) || value.selectedPostIds.length > 100 || value.selectedPostIds.some(id => !momentsId(id)) ||
      typeof value.replyInstructions !== 'string' || value.replyInstructions.length > 2000 ||
      !partial && value.enabled && value.scope === 'selected' && !value.selectedPostIds.length)
    throw new ChannelError('MOMENTS_SETTINGS_INVALID', '抓取间隔 1–1440 分钟，动态范围 1–365 天，每轮 1–50 条；指定动态模式须选择至少一条自己的朋友圈');
  return { ...value, selectedPostIds: [...new Set(value.selectedPostIds)] };
}
