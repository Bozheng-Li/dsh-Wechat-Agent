import { ChannelError } from './contracts.mjs';

export const DEFAULT_ROLE_CARD_SETTINGS = Object.freeze({
  enabled: true,
  trigger: 'messages',
  messageThreshold: 20,
  intervalMinutes: 60,
  timeoutMinutes: 60,
});

export function roleCardSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(DEFAULT_ROLE_CARD_SETTINGS, key)))
    throw new ChannelError('ROLE_CARD_SETTINGS_INVALID', '角色卡自动整理设置格式不正确');
  const value = { ...DEFAULT_ROLE_CARD_SETTINGS, ...input };
  if (typeof value.enabled !== 'boolean' || !['messages', 'time'].includes(value.trigger) ||
      !Number.isSafeInteger(value.messageThreshold) || value.messageThreshold < 1 || value.messageThreshold > 512 ||
      !Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 10080 ||
      !Number.isSafeInteger(value.timeoutMinutes) || value.timeoutMinutes < 1 || value.timeoutMinutes > 1440)
    throw new ChannelError('ROLE_CARD_SETTINGS_INVALID', '请选择按条数或按时间整理；条数为 1–512，间隔为 1 分钟至 7 天，整理超时为 1–1440 分钟');
  return value;
}

export const roleCardSettingsRevision = input => JSON.stringify(roleCardSettings(input));
