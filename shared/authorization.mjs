import { ChannelError, authorizedConversation, authorizedPerson } from './contracts.mjs';

export function revokedObjects(accountId, before, next) {
  return [['privatePeers', 'private'], ['groups', 'group']].flatMap(([field, chatType]) =>
    (before?.[field] || []).filter(peerId => !next[field].includes(peerId)).map(peerId => ({ accountId, chatType, peerId })));
}

export function authorizationMatches(value, scope) {
  if (!value || value.accountId !== scope.accountId) return false;
  if (value.chatType === scope.chatType && value.peerId === scope.peerId) return true;
  if (scope.chatType === 'private' && !value.chatType && value.peerId === scope.peerId) return true;
  return scope.chatType === 'private' && [value.personId, value.senderId, value.userId, value.authorId,
    value.targetUserId, value.requesterId, value.actorId, value.actor, value.replyToUserId,
    value.incomingReply?.userId, value.createdBy, value.sender?.id].includes(scope.peerId);
}

export function authorizationContains(value, scopes, accountId = value?.accountId) {
  if (!value || typeof value !== 'object') return false;
  const account = value.accountId ?? accountId;
  if (!Array.isArray(value) && scopes.some(scope => authorizationMatches({ ...value, accountId: account }, scope))) return true;
  return Object.values(value).some(child => authorizationContains(child, scopes, account));
}

const pending = (store, scope) => store.data.authorizationRevocations?.some(row =>
  row.accountId === scope.accountId && row.chatType === scope.chatType && row.peerId === scope.peerId);

export function personAuthorized(store, accountId, personId) {
  return authorizedPerson(store.settings(accountId), personId) && !pending(store, { accountId, chatType: 'private', peerId: personId });
}

export function assertPersonAuthorized(store, accountId, personId) {
  if (!personAuthorized(store, accountId, personId))
    throw new ChannelError('OBJECT_NOT_AUTHORIZED', '这位人物尚未授权或正在清理撤销的数据，未读取资料或执行操作。', { snsDelivery: 'not-sent' });
}

export function conversationAuthorized(store, scope) {
  return authorizedConversation(store.settings(scope?.accountId), scope) && !pending(store, scope);
}

export function assertConversationAuthorized(store, scope) {
  if (!conversationAuthorized(store, scope))
    throw new ChannelError('OBJECT_NOT_AUTHORIZED', '该会话尚未授权或正在清理撤销的数据，未读取资料或执行操作。');
}

export const authorizationEpoch = (store, accountId) => store.data.authorizationEpochs?.[accountId] || 0;
export function assertAuthorizationEpoch(store, accountId, epoch) {
  if (authorizationEpoch(store, accountId) !== epoch)
    throw new ChannelError('AUTHORIZATION_CHANGED', '对象授权已变更，旧操作已停止，未继续执行。', { snsDelivery: 'not-sent' });
}
