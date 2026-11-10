import { ChannelError } from './contracts.mjs';

export const WORK_ARTIFACT_LIMITS = Object.freeze({ count: 8, imageBytes: 10 * 1024 * 1024 });
export function artifactName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\\/:\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..')
    throw new ChannelError('WORK_ARTIFACT_NAME', '成果文件名无效，请使用不包含路径或控制字符的普通文件名');
  return value;
}
export function artifactMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.path === 'string' &&
    value.path.length > 0 && value.path.length <= 2000 && !/[\u0000-\u001f\u007f:]/.test(value.path) &&
    !/^[\\/]/.test(value.path) && !value.path.replaceAll('\\', '/').split('/').some(part => part === '..' || part.toLowerCase() === '.wechat-work') &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 240 && !/[\\/:\u0000-\u001f\u007f]/.test(value.name) &&
    ['file', 'image'].includes(value.kind) && Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
    (value.kind !== 'image' || value.bytes <= WORK_ARTIFACT_LIMITS.imageBytes) && /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.mediaType === 'string' && value.mediaType.length < 200;
}
export function imageArchiveMetadata(value, jobId) {
  return artifactMetadata(value) && ['saved', 'failed'].includes(value.state) &&
    typeof value.sourcePath === 'string' && artifactMetadata({ ...value, path: value.sourcePath }) &&
    value.path.startsWith(`微信agent/generated-images/${jobId}/`) &&
    ['image/png', 'image/jpeg'].includes(value.mediaType) &&
    (value.state !== 'failed' || value.error && typeof value.error.code === 'string' && typeof value.error.message === 'string');
}
