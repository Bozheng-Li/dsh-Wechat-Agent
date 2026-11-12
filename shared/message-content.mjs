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
