import { searchText } from "../../shared/text.mjs";
export { searchText } from "../../shared/text.mjs";

export function matchesSearch(item, query) {
  const words = searchText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const haystack = searchText(
    [
      item.id,
      item.peerId,
      item.name,
      item.nickname,
      item.remark,
      item.alias,
      ...(Array.isArray(item.aliases) ? item.aliases : []),
    ]
      .filter(Boolean)
      .join(' ')
  );
  return words.every((word) => haystack.includes(word));
}

export function peerType(item) {
  return item.chatType || (String(item.peerId || item.id || '').endsWith('@chatroom') ? 'group' : 'private');
}

export function peerName(item) {
  return item.name || item.remark || item.nickname || item.peerId || item.id || '未命名会话';
}

export function peerId(item) {
  return item.peerId || item.id || '';
}

export function conversationKey(item) {
  return `${peerType(item)}:${peerId(item)}`;
}

export function mergeConversations(status, contacts) {
  const peers = new Map();
  const put = (item, archived = false) => {
    if (!peerId(item)) return;
    const key = conversationKey(item),
      previous = peers.get(key);
    peers.set(key, {
      ...previous,
      ...item,
      peerId: peerId(item),
      chatType: peerType(item),
      hasArchive: archived || previous?.hasArchive || false,
    });
  };
  for (const item of status?.conversations || []) put(item, true);
  for (const item of contacts?.privatePeers || []) put({ ...item, chatType: 'private' });
  for (const item of contacts?.groups || []) put({ ...item, chatType: 'group' });
  for (const [field, chatType] of [
    ['privatePeers', 'private'],
    ['groups', 'group'],
  ]) {
    for (const id of status?.settings?.[field] || []) {
      const key = conversationKey({ peerId: id, chatType });
      if (!peers.has(key)) put({ peerId: id, chatType });
    }
  }
  for (const item of peers.values()) {
    const allowed = item.chatType === 'group' ? status?.settings?.groups : status?.settings?.privatePeers;
    item.authorized = allowed?.includes(item.peerId) || false;
  }
  return [...peers.values()].sort((a, b) => peerName(a).localeCompare(peerName(b), 'zh-CN'));
}

export function initials(value) {
  return Array.from(String(value || '微').trim())
    .slice(0, 2)
    .join('');
}

export function formatTime(value, detail = false) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return date.toLocaleString(
    'zh-CN',
    detail
      ? {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }
      : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
  );
}

export function splitLines(value) {
  return [
    ...new Set(
      String(value || '')
        .split(/[\n,，;；]+/u)
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ];
}
