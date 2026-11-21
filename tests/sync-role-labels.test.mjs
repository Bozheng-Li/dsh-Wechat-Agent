import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPluginService } from '../backend/app/service.mjs';
import { rpcHandler } from '../backend/rpc/handler.mjs';
import { ChannelError } from '../shared/contracts.mjs';
import { call, memoryRpcTimeoutMs, withTimeout } from '../frontend/shared/rpc.mjs';
import { resolveMomentsAudience } from '../shared/moments-audience.mjs';

const accountId = 'synthetic-owner', owner = { principal: { kind: 'owner' } };
function fixture() {
  const status = { online: true, account: { id: accountId }, momentsAudienceReady: true };
  const settings = { privatePeers: ['person-a', 'person-b'] }, reads = [];
  const snapshot = { accountId, source: 'wechat-role-labels-live', membershipComplete: true,
    contacts: [{ id: 'person-a', labelIds: ['1'] }, { id: 'person-b', labelIds: [] }],
    labels: [{ id: '1', name: '测试标签', userIds: ['person-a'], memberCount: 1 }] };
  const worker = { status: () => status, readMomentsAudience: async (args, signal) => {
    reads.push(args); signal.throwIfAborted(); return structuredClone(snapshot);
  } };
  const store = { data: { authorizationRevocations: [], groupMemberExclusions: {} }, roleCards: { list: () => settings.privatePeers.map(personId => ({ personId })) }, settings: () => settings };
  const service = createPluginService({ worker, store, channel: {}, identity: {} });
  return { status, settings, reads, snapshot, worker, store, service, invoke: rpcHandler(service) };
}

test('role label RPC derives existing authorized IDs, not a full directory or caller-provided scope', async () => {
  const f = fixture();
  f.store.roleCards.storedScopes = () => { assert.fail('empty stored subjects are outside the gallery tag scope'); };
  const result = await f.invoke('memory.role.labels', { accountId, contactIds: ['unrelated'] }, undefined, owner);
  assert.equal(result.ok, true);
  assert.deepEqual(f.reads, [{ accountId, contactIds: ['person-a', 'person-b'] }]);
  assert.equal(result.value.source, 'wechat-role-labels-live');
  assert.throws(() => resolveMomentsAudience(result.value, { action: 'publish', blockedLabelIds: ['1'] }),
    error => error.code === 'MOMENTS_AUDIENCE_INCOMPLETE', 'a scoped label result is not a complete publishing audience');
  assert.equal((await f.invoke('memory.role.labels', { accountId }, undefined, { principal: { kind: 'remote' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await f.invoke('memory.role.labels', { accountId: 'other' }, undefined, owner)).error.code, 'ACCOUNT_CHANGED');
  assert.equal(f.reads.length, 1);
});

test('group-authorized role-card people keep their live tags without a private-peer grant', async () => {
  const f = fixture(); f.settings.privatePeers = [];
  f.store.roleCards.list = () => [{ personId: 'person-a' }];
  f.store.roleCards.storedScopes = () => [{ personId: 'person-a' }];
  f.store.isGroupMember = (_account, personId) => personId === 'person-a';
  const result = await f.invoke('memory.role.labels', { accountId }, undefined, owner);
  assert.equal(result.ok, true);
  assert.deepEqual(f.reads, [{ accountId, contactIds: ['person-a'] }]);
  assert.deepEqual(result.value.contacts.map(row => row.id), ['person-a']);
  assert.deepEqual(result.value.labels[0].userIds, ['person-a']);
  assert.equal(result.value.labels[0].memberCount, 1);
});

test('role label RPC removes revoked or unexpected people and retains underlying failure codes', async () => {
  const f = fixture();
  f.worker.readMomentsAudience = async () => {
    f.settings.privatePeers = ['person-b'];
    return { ...f.snapshot, contacts: [...f.snapshot.contacts, { id: 'unexpected', labelIds: ['1'] }] };
  };
  const value = (await f.invoke('memory.role.labels', { accountId }, undefined, owner)).value;
  assert.deepEqual(value.contacts.map(row => row.id), ['person-b']);
  assert.deepEqual(value.labels[0].userIds, []); assert.equal(value.labels[0].memberCount, 0);
  f.worker.readMomentsAudience = async () => { throw new ChannelError('ERR_MOMENTS_AUDIENCE', '微信拒绝读取联系人或标签（ret=-2）'); };
  await assert.rejects(call({ rpc: { call: (_channel, endpoint, payload, signal) => f.invoke(endpoint, payload, signal, owner) } },
    'memory.role.labels', { accountId }), error => error.code === 'ERR_MOMENTS_AUDIENCE' && error.message.includes('ret=-2'));
});

test('unavailable or switched accounts fail without claiming successful labels', async () => {
  const f = fixture(); f.status.momentsAudienceReady = false;
  assert.equal((await f.invoke('memory.role.labels', { accountId }, undefined, owner)).error.code, 'MOMENTS_AUDIENCE_UNAVAILABLE');
  assert.equal(f.reads.length, 0); f.status.momentsAudienceReady = true;
  f.worker.readMomentsAudience = async () => { f.status.account = { id: 'other' }; return f.snapshot; };
  assert.equal((await f.invoke('memory.role.labels', { accountId }, undefined, owner)).error.code, 'ACCOUNT_CHANGED');
});

test('label page deadline exceeds worker deadline and ordinary reads stay short', () => {
  assert.equal(memoryRpcTimeoutMs('memory.role.labels'), 310000);
  assert.equal(memoryRpcTimeoutMs('moments.audience'), 310000);
  assert.equal(memoryRpcTimeoutMs('memory.role.list'), 30000);
  assert.equal(memoryRpcTimeoutMs('memory.compress'), 300000);
  assert(withTimeout(undefined, 30000) instanceof AbortSignal);
  const page = fs.readFileSync(new URL('../frontend/page-content.jsx', import.meta.url), 'utf8');
  assert.match(page, /memoryRpcTimeoutMs\(endpoint\)/);
  const rolePage = fs.readFileSync(new URL('../frontend/pages/memory/role-cards-page.jsx', import.meta.url), 'utf8');
  assert.match(rolePage, /rpc\('memory\.role\.labels'/); assert.doesNotMatch(rolePage, /rpc\('moments\.audience'/);
  assert.match(rolePage, /\[accountId, canReadTags\]/, 'automatic first load is tied to connection changes, not polling');
});

test('reproduces page cancellation and distinguishes timeout, cancellation and IPC failure without leaking raw errors', async () => {
  for (const [name, code] of [['TimeoutError', 'RPC_TIMEOUT'], ['AbortError', 'RPC_ABORTED']]) {
    const reason = new DOMException('synthetic-private-content', name), controller = new AbortController(); controller.abort(reason);
    await assert.rejects(call({ rpc: { call: async () => { throw reason; } } }, 'memory.role.labels', {}, controller.signal), error => {
      assert.equal(error.code, code); assert.equal(error.cause, reason);
      assert.doesNotMatch(error.message, /检查应用连接|synthetic-private-content/); return true;
    });
  }
  await assert.rejects(call({ rpc: { call: async () => { throw new Error('synthetic-secret-path'); } } }, 'memory.role.labels'), error => {
    assert.equal(error.code, 'RPC_UNAVAILABLE'); assert.match(error.message, /页面与后台通信/);
    assert.doesNotMatch(error.message, /synthetic-secret-path/); return true;
  });
});
