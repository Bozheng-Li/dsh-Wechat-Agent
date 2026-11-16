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

const validPerson = personId => typeof personId === 'string' && !!personId && !personId.endsWith('@chatroom');

/** Members of an authorized group are authorized people, and their private
 * conversations are authorized with them: once the owner authorizes a group
 * they do not repeat the authorization for every member who writes to them
 * directly. The group grant covers person cards, moments, mentions and private
 * replies alike; an explicit denial still wins over the membership. */
const groupMember = (store, accountId, personId) =>
  typeof store?.isGroupMember === 'function' && store.isGroupMember(accountId, personId) === true;

export function personAuthorized(store, accountId, personId) {
  if (!validPerson(personId)) return false;
  if (pending(store, { accountId, chatType: 'private', peerId: personId })) return false;
  return authorizedPerson(store.settings(accountId), personId) || groupMember(store, accountId, personId);
}

/** The audience the transport may see: authorized private peers plus members of
 * authorized groups, minus objects whose cleanup is still running. */
export function authorizedPeople(store, accountId) {
  const ids = new Set(store.settings(accountId).privatePeers.filter(validPerson));
  const members = typeof store?.authorizedGroupMemberIds === 'function' ? store.authorizedGroupMemberIds(accountId) : [];
  for (const personId of members) if (validPerson(personId)) ids.add(personId);
  for (const personId of ids) if (pending(store, { accountId, chatType: 'private', peerId: personId })) ids.delete(personId);
  return [...ids].sort();
}

export function assertPersonAuthorized(store, accountId, personId) {
  if (!personAuthorized(store, accountId, personId))
    throw new ChannelError('OBJECT_NOT_AUTHORIZED', '这位人物尚未授权或正在清理撤销的数据，未读取资料或执行操作。', { snsDelivery: 'not-sent' });
}

export function conversationAuthorized(store, scope) {
  // A private conversation follows the person: an explicit private grant or a
  // membership in an authorized group, which is what the owner expects after
  // authorizing the whole group.
  if (scope?.chatType === 'private') return personAuthorized(store, scope.accountId, scope.peerId);
  return authorizedConversation(store.settings(scope?.accountId), scope) && !pending(store, scope);
}

/** Whether an enabled account may handle this conversation at all: the master
 * switch plus the same object authorization the transport enforces. */
export function conversationEligible(store, scope) {
  return store.settings(scope?.accountId)?.enabled === true && conversationAuthorized(store, scope);
}

/** Cleanup only reclaims what the owner explicitly revoked or what an authorized
 * group no longer covers at all. Losing membership keeps the existing data: the
 * member list is protocol-derived, may be incomplete, and a member leaving is not
 * the owner cancelling an authorization. */
export function conversationScopeAuthorized(store, scope) {
  if (scope?.chatType === 'group') return authorizedConversation(store.settings(scope.accountId), scope);
  if (personAuthorized(store, scope?.accountId, scope?.peerId)) return true;
  return typeof store?.seenGroupMember === 'function' && store.seenGroupMember(scope.accountId, scope?.peerId) === true;
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
