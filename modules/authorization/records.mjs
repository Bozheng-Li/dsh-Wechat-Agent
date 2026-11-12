import { authorizationContains, authorizationMatches } from '../../shared/authorization.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { archiveCopies, archiveDirectories } from './archives.mjs';

const savedCopies = (channel, scopes) => Object.values(channel.store.data.conversations)
  .filter(metadata => scopes.some(scope => scope.accountId === metadata.accountId)).flatMap(metadata => archiveCopies(channel.store, metadata));

export function revokedMessageKeys(channel, scopes, copies = savedCopies(channel, scopes)) {
  const keys = new Map();
  for (const scope of scopes) {
    if (!keys.has(scope.accountId)) keys.set(scope.accountId, new Set());
    for (const key of scope.messageKeys || []) keys.get(scope.accountId).add(key);
    for (const id of scope.workIds || []) keys.get(scope.accountId).add('work:' + id);
  }
  for (const view of channel.store.views.values()) for (const row of [...view.messages, ...view.records]) {
    if (scopes.some(scope => authorizationMatches({ ...row, accountId: view.accountId, chatType: view.chatType, peerId: view.peerId }, scope)) && row.key)
      keys.get(view.accountId)?.add(row.key);
  }
  for (const { view } of copies)
    for (const row of [...view.messages, ...view.records]) if (scopes.some(scope =>
      authorizationMatches({ ...row, accountId: view.accountId, chatType: view.chatType, peerId: view.peerId }, scope)) && row.key)
      keys.get(view.accountId)?.add(row.key);
  return keys;
}

export function relatedRecord(value, scopes, keys, accountId = value?.accountId) {
  if (!value || typeof value !== 'object') return false;
  const account = value.accountId ?? accountId, messages = keys.get(account);
  if (authorizationContains(value, scopes, account)) return true;
  if (messages && [value.key, value.messageKey, value.recordKey, value.sourceKey?.replace(/^record:/, '')].some(key => messages.has(key))) return true;
  if (messages && value.chatType && value.peerId && value.messageId &&
      messages.has(identity([account, value.chatType, value.peerId, value.messageId]))) return true;
  return Object.values(value).some(child => relatedRecord(child, scopes, keys, account));
}

/** Keep provenance until every cleanup stage succeeds, including after a restart. */
export function rememberCleanupSources(channel, scopes) {
  const { store } = channel, previous = store.data.authorizationRevocations;
  const copies = savedCopies(channel, scopes);
  const same = (a, b) => a.accountId === b.accountId && a.chatType === b.chatType && a.peerId === b.peerId;
  const next = previous.map(row => {
    if (!scopes.some(scope => same(row, scope))) return row;
    const keys = revokedMessageKeys(channel, [row], copies), workIds = new Set(row.workIds || []), materialIds = new Set(row.materialIds || []);
    for (const job of channel.work.store.data.jobs) if (relatedRecord(job, [row], keys)) {
      workIds.add(job.id); keys.get(row.accountId).add('work:' + job.id);
    }
    const account = Object.values(channel.momentsAutomation.materials.data.accounts).find(value => value.accountId === row.accountId);
    for (const item of Object.values(account?.items || {})) if (relatedRecord(item, [row], keys, row.accountId)) materialIds.add(item.id);
    return { ...row, archiveDirectories: archiveDirectories(store, row), messageKeys: [...keys.get(row.accountId)].sort(),
      workIds: [...workIds].sort(), materialIds: [...materialIds].sort() };
  });
  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    store.data.authorizationRevocations = next;
    try { store.save(); } catch (error) { store.data.authorizationRevocations = previous; throw error; }
  }
  return store.data.authorizationRevocations.filter(row => scopes.some(scope => same(row, scope)));
}
