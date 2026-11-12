import { ChannelError } from './contracts.mjs';
import { visibleMomentsText } from './moments-publishing.mjs';
import { TIME_DEFAULTS } from './time-settings.mjs';

export const MATERIAL_ENDPOINTS = ['moments.materials.list', 'moments.materials.save', 'moments.materials.delete',
  'moments.materials.image', 'moments.materials.describe', 'moments.materials.configure', 'moments.materials.organize', 'moments.materials.cancel', 'moments.materials.search', 'moments.materials.download', 'moments.materials.generate'];
export const MATERIAL_DEFAULTS = Object.freeze({ enabled: false, intervalMinutes: 180, sources: [], webImagesEnabled: false, generatedImagesEnabled: false });
export const MATERIAL_ORGANIZE_TIMEOUT_MS = TIME_DEFAULTS.momentsMaterialTimeoutMinutes * 60000;
export const materialId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const materialSourceKey = source => source.chatType + ':' + source.peerId;
const invalid = message => { throw new ChannelError('MOMENTS_MATERIAL_INVALID', message); };
export const materialObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function materialSettings(input = {}) {
  if (!materialObject(input) || Object.keys(input).some(key => !Object.hasOwn(MATERIAL_DEFAULTS, key))) invalid('素材整理设置包含无效字段');
  const value = { ...structuredClone(MATERIAL_DEFAULTS), ...input };
  if (typeof value.enabled !== 'boolean' || typeof value.webImagesEnabled !== 'boolean' || typeof value.generatedImagesEnabled !== 'boolean' || !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 15 || value.intervalMinutes > 1440 ||
    !Array.isArray(value.sources) || value.sources.length > 20 || value.sources.some(source => !materialObject(source) || Object.keys(source).some(key => !['chatType', 'peerId'].includes(key)) ||
      !['private', 'group'].includes(source.chatType) || typeof source.peerId !== 'string' || !source.peerId || source.peerId.length > 256 || /\s/.test(source.peerId) || source.peerId.endsWith('@chatroom') !== (source.chatType === 'group')))
    invalid('请选择最多 20 个取材会话，整理间隔为 15–1440 分钟');
  value.sources = [...new Map(value.sources.map(source => [materialSourceKey(source), source])).values()];
  if (value.enabled && !value.sources.length) invalid('开启自动整理前，请先选择允许取材的聊天');
  return value;
}
export function materialFields(input = {}) {
  if (!materialObject(input) || Object.keys(input).some(key => !['title', 'text', 'url', 'enabled', 'expiresAt', 'imageUse', 'imageOrigin'].includes(key))) invalid('素材内容包含无效字段');
  const value = { title: '', text: '', url: '', enabled: true, expiresAt: null, imageUse: 'publish', imageOrigin: 'unknown', ...input };
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80 || typeof value.text !== 'string' || value.text.length > 2000 ||
    value.text && !visibleMomentsText(value.text) || typeof value.enabled !== 'boolean' || typeof value.url !== 'string' || value.url.length > 2048 ||
    value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) ||
    !['publish', 'reference'].includes(value.imageUse) || !['unknown', 'photo', 'artwork', 'ai'].includes(value.imageOrigin)) invalid('请填写素材标题和有效内容，标题最多 80 字，内容最多 2000 字');
  if (value.url) { try { const url = new URL(value.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error(); } catch { invalid('来源链接须为不含账号密码的 HTTP/HTTPS 地址'); } }
  return { ...value, title: value.title.trim(), text: value.text.trim(), url: value.url.trim() };
}
