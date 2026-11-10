import { ChannelError, remoteSettings, administratorIds } from '../../../shared/contracts.mjs';
export const endpoints = ['administrators.configure'];
export async function administratorMutation({ store, currentAccount, assertLive, status }, _endpoint, payload, signal) {
  currentAccount(payload); assertLive(signal);
  const next = store.config.snapshot(store.data);
  next.remote = remoteSettings(payload.remote);
  store.config.commit(next);
  assertLive(signal);
  return status();
}

/** Only names and ids from the current protocol account become search candidates. */
export async function administratorCandidates({ store, worker, currentAccount, conversation, assertLive }, payload, signal) {
  const account = currentAccount(payload);
  let users = [], groups = [];
  if (payload.peerId && payload.chatType === 'group') {
    const scope = conversation(payload);
    if (!store.settings(account.id).groups.includes(scope.peerId)) throw new ChannelError('ADMIN_SCOPE_INVALID', '请先授权这个群聊，再读取管理员候选名单');
    const result = await worker.call('members', { accountId: account.id, peerId: scope.peerId }, { signal });
    if (result?.accountId !== account.id || result?.peerId !== scope.peerId || !Array.isArray(result.members))
      throw new ChannelError('ADMIN_SCOPE_INVALID', '管理员候选名单与当前账号或会话不匹配，请重新读取');
    users = result.members.filter(row => !row.groupId || row.groupId === scope.peerId);
  } else {
    if (payload.peerId) conversation(payload);
    const result = await worker.call('contacts', {}, { signal });
    users = (result?.privatePeers ?? []).filter(row => !payload.peerId || row.id === payload.peerId);
    const authorized = store.settings(account.id).groups;
    groups = (result?.groups ?? []).filter(row => authorized.includes(row.id)).map(row => ({ id: row.id, name: row.name || row.id }));
  }
  assertLive(signal); currentAccount(payload);
  const candidates = new Map();
  for (const row of users) {
    try { administratorIds([row.id]); } catch { continue; }
    if (row.id === account.id) continue;
    candidates.set(row.id, { id: row.id, name: String(row.name || row.nickname || row.card || row.id).slice(0, 150),
      remark: String(row.remark || row.card || '').slice(0, 150), nickname: String(row.nickname || '').slice(0, 150) });
  }
  return { accountId: account.id, peerId: payload.peerId ?? null, users: [...candidates.values()], groups };
}
