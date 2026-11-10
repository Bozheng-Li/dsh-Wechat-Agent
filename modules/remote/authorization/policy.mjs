import { ChannelError, eligible } from '../../../shared/contracts.mjs';
import { promptText } from '../../../prompts/loader.mjs';

/** Sender identity always comes from the current protocol message, never from its text. */
export function remoteAccessReason(channel, scope) {
  if (!scope || typeof scope.peerId !== 'string' || typeof scope.senderId !== 'string' || typeof scope.accountId !== 'string') return 'scope';
  const status = channel.transport.status();
  if (channel.closed || channel.fault || !status.online) return 'unavailable';
  if (status.account?.id !== scope.accountId) return 'account';
  if (!scope.senderId || !['private', 'group'].includes(scope.chatType) ||
      scope.peerId.endsWith('@chatroom') !== (scope.chatType === 'group') ||
      scope.senderId === scope.accountId || scope.senderId.endsWith('@chatroom') ||
      (scope.chatType === 'private' && scope.senderId !== scope.peerId)) return 'scope';
  if (!eligible(channel.store.settings(scope.accountId), scope)) return 'conversation';
  const config = channel.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId);
  const global = channel.store.config.section('remote')?.globalAdminIds ?? [];
  if (config.remoteEnabled !== true) return 'disabled';
  return global.includes(scope.senderId) || config.adminIds.includes(scope.senderId) ? null : 'administrator';
}

export const remoteAuthorized = (channel, scope) => remoteAccessReason(channel, scope) === null;

export function assertRemoteAuthorized(channel, scope, signal) {
  signal?.throwIfAborted();
  const reason = remoteAccessReason(channel, scope);
  if (reason) throw new ChannelError('REMOTE_NOT_AUTHORIZED', promptText('remote/messages.json', 'denied-' + reason, [scope?.senderId ?? '']), { reason });
  channel.store.config.assertCurrent();
}
