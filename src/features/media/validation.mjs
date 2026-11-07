import { ChannelError } from '../../shared/contracts.mjs';

export const error = (code, message) => new ChannelError(code, message);

export function accountId(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f]/u.test(value))
    throw error('ASSET_ACCOUNT_INVALID', '请先选择当前微信账号');
  return value;
}

export function decodeBase64(value, limit) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length % 4 ||
    value.length > Math.ceil(limit / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw error('ASSET_DATA_INVALID', '上传内容不是有效的图片数据');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > limit || data.toString('base64') !== value)
    throw error('ASSET_TOO_LARGE', '上传内容为空或超过大小限制');
  return data;
}

export function plain(value, label, max, allowEmpty = true) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    (!allowEmpty && !value.trim())
  )
    throw error('ASSET_METADATA_INVALID', `${label}${allowEmpty ? '' : '不能为空，且'}最多 ${max} 字`);
  return value.trim();
}

export function normalizeKind(kind) {
  if (!['sticker', 'image'].includes(kind)) throw error('ASSET_KIND_INVALID', '请选择表情包或图片素材');
  return kind;
}
