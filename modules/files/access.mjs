/** Fixed account, conversation and receive-time cutoff; the model cannot replace them. */
export function receivedFileAccess(transport, scope) {
  if (typeof transport?.files !== 'function') return null;
  const owner = { accountId: scope.accountId, peerId: scope.peerId, before: scope.requestedAt };
  return (action, query, signal) => transport.files({ ...owner, action,
    ...(query.messageId ? { messageId: query.messageId } : {}), ...(query.name ? { name: query.name } : {}) }, signal);
}
