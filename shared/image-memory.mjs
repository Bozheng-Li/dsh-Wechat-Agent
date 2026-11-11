import { ChannelError } from './contracts.mjs';

export const IMAGE_MEMORY_COLLECTIONS = Object.freeze(['conversation', 'generated']);
export function imageMemoryCollection(value = 'conversation') {
  if (!IMAGE_MEMORY_COLLECTIONS.includes(value))
    throw new ChannelError('INVALID_IMAGE_MEMORY_COLLECTION', '请选择会话图片记忆或生成图片记忆');
  return value;
}
export const imageMemoryByteLimit = collection => (collection === 'generated' ? 100 : 10) * 1024 * 1024;

// Generation and delivery are separate events. A queued reply may inspect an
// earlier output, but cannot see a receipt which arrived after its input.
export function imageGenerationAt(generation, before = Infinity) {
  return generation?.deliveryState === 'sent' && generation.sentAt > before
    ? { ...generation, deliveryState: 'not-confirmed', serverMessageIds: [], sentAt: undefined }
    : generation;
}

export function generatedImageMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    /^[a-f0-9]{12}$/.test(value.jobId) &&
    typeof value.fileName === 'string' && value.fileName.length > 0 && value.fileName.length <= 240 &&
    typeof value.requesterId === 'string' && value.requesterId.length > 0 &&
    ['sent', 'not-confirmed'].includes(value.deliveryState) &&
    (value.sentAt === undefined || Number.isSafeInteger(value.sentAt) && value.sentAt > 0) &&
    (value.serverMessageIds === undefined || Array.isArray(value.serverMessageIds) && value.serverMessageIds.length <= 8 &&
      value.serverMessageIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512 && id !== '0')) &&
    ['providerName', 'model', 'prompt'].every(key => value[key] === undefined || typeof value[key] === 'string' && value[key].length <= 4000);
}
