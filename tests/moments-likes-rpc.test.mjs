import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StateStore, WechatChannel, createPluginService, rpcHandler, MOMENTS_LIKE_ENDPOINTS, ChannelError } from '../lib/testing.js';
import { call as clientCall } from '../frontend/shared/rpc.mjs';

function fixture(t, beforeRead) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-likes-rpc-'));
  const accountId = 'wxid_likes_rpc_owner', reads = [], writes = [];
  const status = { account: { id: accountId }, online: true, momentsReadReady: true, momentsWriteReady: true };
  const store = new StateStore(root);
  store.configure(accountId, { enabled: true, privatePeers: ['wxid_likes_friend'], groups: [], prompt: '' });
  const worker = { status: () => status,
    async readMoments(args, signal) {
      reads.push(args); await beforeRead?.(args, signal); signal.throwIfAborted();
      return { accountId, action: 'user', userId: args.query.userId, source: 'wechat-sns-live', nextCursor: null,
        items: [{ id: '9007199254741997', author: { userId: args.query.userId }, text: '合成好友动态',
          createdAt: Math.floor(Date.now() / 1000), deleted: false, contentAvailable: true, likedByCurrentAccount: false }] };
    },
    async writeMoments(args, signal) {
      signal.throwIfAborted(); writes.push(args);
      return { accountId, action: args.query.action, postId: args.query.postId, liked: true, delivery: 'server-ack' };
    },
    async send() { throw Error('RPC fixture must never send a message'); },
  };
  const runner = { async run() { throw Error('Likes must not run a model'); } };
  const channel = new WechatChannel({ store, transport: worker, runner });
  const invoke = rpcHandler(createPluginService({ root, store, worker, runner, channel }));
  const rpc = (endpoint, payload = {}, principal = 'owner', signal) => invoke(endpoint,
    { accountId, ...payload }, signal, { principal: { kind: principal } });
  t.after(async () => {
    await channel.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-likes-rpc-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { accountId, rpc, status, channel, reads, writes };
}

test('owner likes endpoints expose safe defaults and reject remote principals or another account', async t => {
  const f = fixture(t);
  const initial = await f.rpc('moments.likes.list');
  assert(initial.ok); assert.equal(initial.value.accountId, f.accountId);
  assert.equal(initial.value.settings.enabled, false); assert.equal(initial.value.settings.respondToRequests, true);
  assert.deepEqual(initial.value.settings.userIds, []);
  for (const endpoint of MOMENTS_LIKE_ENDPOINTS) {
    assert.equal((await f.rpc(endpoint, {}, 'agent')).error.code, 'OWNER_REQUIRED');
    assert.equal((await f.rpc(endpoint, {}, 'remote')).error.code, 'OWNER_REQUIRED');
    assert.equal((await f.rpc(endpoint, { accountId: 'wxid_other_account' })).error.code, 'ACCOUNT_CHANGED');
  }
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('owner explicit run uses saved friends and stable request ID without enabling recurring likes', async t => {
  const f = fixture(t);
  const configured = await f.rpc('moments.likes.configure', { settings: { userIds: ['wxid_likes_friend'], includeExisting: true } });
  assert(configured.ok); assert.equal(configured.value.settings.enabled, false);
  assert.equal((await f.rpc('moments.likes.run', { requestId: 'invalid' })).error.code, 'MOMENTS_LIKE_REQUEST_INVALID');
  assert.equal(f.reads.length, 0);
  const payload = { requestId: 'ui-moments-' + randomUUID() };
  const [first, same] = await Promise.all([f.rpc('moments.likes.run', payload), f.rpc('moments.likes.run', payload)]);
  assert(first.ok); assert(same.ok); assert.equal(first.value.lastRun.liked, 1);
  assert.equal(first.value.settings.enabled, false);
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].query.userId, 'wxid_likes_friend');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.action, 'like');
  assert((await f.rpc('moments.likes.run', payload)).ok); assert.equal(f.writes.length, 1);
});

test('cancelling an owner scan interrupts the pending read before any like is submitted', async t => {
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, (_args, signal) => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  assert((await f.rpc('moments.likes.configure', { settings: { userIds: ['wxid_likes_friend'], includeExisting: true } })).ok);
  const pending = f.rpc('moments.likes.run', { requestId: 'ui-moments-' + randomUUID() });
  await reading;
  assert.equal((await f.rpc('moments.likes.list')).value.running, true);
  assert((await f.rpc('moments.likes.cancel')).ok);
  const result = await pending;
  assert(result.ok); assert.equal(result.value.lastRun.state, 'cancelled');
  assert.equal(result.value.running, false); assert.equal(f.writes.length, 0);
});

test('invalid automatic scope and paused global reply cannot initiate likes', async t => {
  const f = fixture(t);
  assert.equal((await f.rpc('moments.likes.configure', { settings: { enabled: true, userIds: [] } })).error.code, 'MOMENTS_LIKE_SETTINGS_INVALID');
  assert.equal((await f.rpc('moments.likes.configure', { settings: { userIds: [f.accountId] } })).error.code, 'MOMENTS_LIKE_SETTINGS_INVALID');
  assert((await f.rpc('moments.likes.configure', { settings: { userIds: ['wxid_likes_friend'], includeExisting: true } })).ok);
  f.channel.store.configure(f.accountId, { ...f.channel.store.settings(f.accountId), enabled: false });
  const stopped = await f.rpc('moments.likes.run', { requestId: 'ui-moments-' + randomUUID() });
  assert.equal(stopped.ok, false); assert.equal(stopped.error.code, 'MOMENTS_LIKE_SETTINGS_CHANGED');
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('like rejection crosses the owner UI boundary as a safe delivery enum without provider details', async () => {
  const invoke = rpcHandler({ call: async () => { throw new ChannelError('ERR_MOMENTS_WRITE_REJECTED', '微信拒绝了本次点赞',
    { snsDelivery: 'rejected', providerCredential: 'must-not-cross-ui' }); } });
  const connection = { rpc: { call: (_channel, endpoint, payload, signal) => invoke(endpoint, payload, signal, { principal: { kind: 'owner' } }) } };
  const response = await invoke('moments.write', { action: 'like' }, undefined, { principal: { kind: 'owner' } });
  assert.equal(response.error.delivery, 'rejected'); assert.deepEqual(response.error.details, {});
  assert(!JSON.stringify(response).includes('must-not-cross-ui'));
  await assert.rejects(clientCall(connection, 'moments.write', { action: 'like' }), error =>
    error.delivery === 'rejected' && error.code === 'ERR_MOMENTS_WRITE_REJECTED' && !('details' in error));
  const unrelated = await invoke('moments.write', { action: 'publish' }, undefined, { principal: { kind: 'owner' } });
  assert(!('delivery' in unrelated.error));
});
