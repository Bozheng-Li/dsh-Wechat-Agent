import { ChannelError } from './contracts.mjs';

export const MOMENTS_LIKE_ENDPOINTS = Object.freeze(['moments.likes.list', 'moments.likes.configure', 'moments.likes.run', 'moments.likes.cancel']);

export const MOMENTS_LIKE_DEFAULTS = Object.freeze({ enabled: false, respondToRequests: true, userIds: Object.freeze([]),
  intervalMinutes: 30, lookbackDays: 3, maxLikesPerRun: 5, maxLikesPerDay: 20, includeExisting: false });
export const momentsLikeUserId = value => typeof value === 'string' && /^[\w.:-]{1,256}$/.test(value);

export function momentsLikeSettings(input = {}) {
  const invalid = () => { throw new ChannelError('MOMENTS_LIKE_SETTINGS_INVALID', '请选择好友；间隔 5–1440 分钟、最近 1–30 天、每轮 1–20 次、每天 1–100 次，开启自动点赞前须选择至少一位好友'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(MOMENTS_LIKE_DEFAULTS, key))) invalid();
  const value = { ...MOMENTS_LIKE_DEFAULTS, ...input };
  if (typeof value.enabled !== 'boolean' || typeof value.respondToRequests !== 'boolean' || typeof value.includeExisting !== 'boolean' ||
      !Array.isArray(value.userIds) || value.userIds.length > 100 || value.userIds.some(id => !momentsLikeUserId(id)) ||
      !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 5 || value.intervalMinutes > 1440 ||
      !Number.isInteger(value.lookbackDays) || value.lookbackDays < 1 || value.lookbackDays > 30 ||
      !Number.isInteger(value.maxLikesPerRun) || value.maxLikesPerRun < 1 || value.maxLikesPerRun > 20 ||
      !Number.isInteger(value.maxLikesPerDay) || value.maxLikesPerDay < 1 || value.maxLikesPerDay > 100 ||
      value.enabled && !value.userIds.length) invalid();
  return { ...value, userIds: [...new Set(value.userIds)] };
}
