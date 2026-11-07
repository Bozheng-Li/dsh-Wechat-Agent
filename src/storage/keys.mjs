import { createHash } from 'node:crypto';
import { ChannelError } from '../shared/contracts.mjs';

export function identity(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function conversationKey(accountId, chatType, peerId) {
  return identity([accountId, chatType, peerId]);
}

export function conversationFolder(conversation, name) {
  const cleaned = String(name || (conversation.chatType === 'group' ? '群聊' : '私聊'))
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[ .]+$/g, '')
    .trim()
    .slice(0, 60)
    .replace(/[ .]+$/g, '');
  const safe = !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? '会话_' + cleaned : cleaned;
  return safe + '--' + conversation.key.slice(0, 10);
}

export function info(accountId, chatType, peerId) {
  if (
    typeof accountId !== 'string' ||
    !accountId ||
    accountId.length > 200 ||
    /[\s\u0000-\u001f]/.test(accountId) ||
    !['private', 'group'].includes(chatType) ||
    typeof peerId !== 'string' ||
    !peerId ||
    peerId.length > 200 ||
    /[\s\u0000-\u001f]/.test(peerId) ||
    peerId.endsWith('@chatroom') !== (chatType === 'group')
  )
    throw new ChannelError('INVALID_CONVERSATION', '会话标识不正确，请刷新会话列表后重试');
  return { key: conversationKey(accountId, chatType, peerId), accountId, chatType, peerId };
}

export function recordInfo(record) {
  if (!record?.accountId || !record?.peerId || !record?.chatType) return null;
  return info(record.accountId, record.chatType, record.peerId);
}
