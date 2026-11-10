import { ChannelError } from './contracts.mjs';

const fields = ['prompt', 'path', 'providerId', 'model', 'size'];
/** A model-selected image call stays typed while waiting in the work queue. */
export function workImageRequest(input) {
  const fail = () => { throw new ChannelError('WORK_IMAGE_REQUEST_INVALID', '已选生图调用的参数不完整或无效，请重新选择生图工具'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail();
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000 ||
      typeof input.path !== 'string' || input.path.length > 2000 || /[\u0000-\u001f\u007f:]/.test(input.path) ||
      /^[\\/]/.test(input.path) || input.path.replaceAll('\\', '/').split('/').includes('..') || !/\.(?:png|jpe?g)$/i.test(input.path) ||
      typeof input.providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.providerId) ||
      typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || /[\u0000-\u001f\u007f]/.test(input.model) ||
      typeof input.size !== 'string' || !/^(?:auto|\d{2,4}x\d{2,4})?$/.test(input.size)) fail();
  return { prompt: input.prompt.trim(), path: input.path, providerId: input.providerId, model: input.model, size: input.size };
}

export function validWorkImageRequest(input) {
  try { workImageRequest(input); return true; } catch { return false; }
}
