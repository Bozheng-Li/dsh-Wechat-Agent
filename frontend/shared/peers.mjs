import { conversationKey, peerId, peerType } from "./conversations.mjs";

export const samePeer = (left, right) => left && right && conversationKey(left) === conversationKey(right);

export const selector = (status, peer) => ({
  accountId: status.account.id,
  chatType: peerType(peer),
  peerId: peerId(peer),
});

export const date = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
