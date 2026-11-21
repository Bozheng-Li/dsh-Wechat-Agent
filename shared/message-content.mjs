export const UNAVAILABLE_MESSAGE_TITLE = '微信消息正文未读到（当前连接不支持）';
export const UNAVAILABLE_MESSAGE_REASON = '微信同步接口返回了“当前版本不支持此类型的信息”，没有提供可读正文；这不是人设或模型主动忽略。';
export const UNAVAILABLE_MESSAGE_REPLY = '这条消息我这边读不到。若是引用回复，请把要说的话直接发成文字。';

export function unavailableMessage(message) {
  const segments = message?.message ?? [];
  if (segments.some(segment => ['reply', 'image', 'face', 'file'].includes(segment.type))) return false;
  const text = segments.filter(segment => segment.type === 'text').map(segment => segment.data?.text ?? '').join('').trim();
  return /^无法显示此消息[，,]你目前使用的微信版本暂时不支持此类型的信息[。.]?$/.test(text);
}

export function referencedMessageId(id, peerId) {
  if (typeof id !== 'string' || !id || id.length > 512) return '';
  if (id.startsWith('wx:')) return id.startsWith(`wx:${peerId}:`) ? id.slice(peerId.length + 4) : '';
  return id;
}

/** Refresh only an image attached to this original message. */
export function describeMessageImage(entry, scope, image) {
  let changed = false;
  const attachments = entry.attachments?.map(attachment => {
    if ((scope.collection ?? 'conversation') !== 'conversation' || attachment.resourceId !== image.resourceId ||
      referencedMessageId(entry.messageId, scope.peerId) !== referencedMessageId(image.messageId, scope.peerId) ||
      attachment.description === image.description && attachment.quality === image.quality) return attachment;
    changed = true;
    return { ...attachment, imageMemoryId: image.id, description: image.description, quality: image.quality };
  });
  return changed ? { ...entry, attachments } : entry;
}
