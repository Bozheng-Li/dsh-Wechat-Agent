import { ChannelError } from './errors.mjs';

/** Existing trace history stays indefinitely until its owner opts into retention. */
export function traceSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['retentionDays', 'cacheDays'].includes(key)))
    throw new ChannelError('INVALID_TRACE_SETTINGS', '请提供有效的执行轨迹保存设置');
  const retentionDays = input.retentionDays === undefined ? null : input.retentionDays;
  const cacheDays = input.cacheDays === undefined ? 14 : input.cacheDays;
  if (!(retentionDays === null || Number.isSafeInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 36500) ||
      !Number.isSafeInteger(cacheDays) || cacheDays < 1 || cacheDays > 365)
    throw new ChannelError('INVALID_TRACE_SETTINGS', '轨迹保存天数应为 1–36500 天或留空长期保存，缓存天数应为 1–365 天');
  return { retentionDays, cacheDays };
}
