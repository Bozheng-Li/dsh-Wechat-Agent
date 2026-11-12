export const RECEIVED_FILE_LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, pageChars: 6000, list: 100 });
export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function receivedFileName(value) {
  if (typeof value !== 'string' || !value.trim()) return '微信附件';
  const name = value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
  const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
  // Preserve the extension when shortening a long title, including surrogate pairs.
  const parts = Array.from(safe || '微信附件');
  if (parts.length <= 120) return parts.join('');
  const extension = /\.[a-z\d]{1,12}$/i.exec(safe)?.[0] || '';
  return parts.slice(0, 120 - extension.length).join('') + extension;
}

/** Public metadata only. Download credentials never enter history or prompts. */
export function receivedFileMetadata(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim()) return null;
  return { name: receivedFileName(value.name),
    ...(Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? { bytes: value.bytes } : {}),
    ...(/^[a-f0-9]{64}$/.test(value.resourceId ?? '') ? { resourceId: value.resourceId } : {}) };
}
