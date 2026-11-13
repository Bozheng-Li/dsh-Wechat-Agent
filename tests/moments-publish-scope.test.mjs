import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, createPluginService, rpcHandler, validateSettings, publishScopeOf, emptySettings } from '../lib/testing.js';

const postId = '9007199254740999';
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-publish-scope-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-moments-publish-scope-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}
/** A real channel so the object-authorization guard is part of the test:
 * 发布时它也会决定是否把授权名单交给传输层。 */
function fixture(t) {
  const root = temporary(t), store = new StateStore(root), accountId = 'scope-owner';
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [], prompt: '' });
  const writes = [], status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const transport = {
    status: () => status,
    writeMoments: async (input, signal) => {
      writes.push(input); signal?.throwIfAborted();
      const query = input.query, blockedUserIds = query.blockedUserIds ?? [];
      return { accountId, action: query.action, postId, clientId: input.clientId, text: query.text,
        imageCount: query.images?.length ?? 0, delivery: 'server-ack', audienceConfirmed: true, blockedUserIds,
        ...(input.authorizedUserIds ? { authorizationConfirmed: true, authorizedAudienceUserIds: [...input.authorizedUserIds],
          authorizationExcludedCount: 0, audienceSource: 'wechat-contacts-live', audienceFetchedAt: new Date().toISOString() } : {}) };
    },
    call: async () => ({ accountId, privatePeers: [] }),
  };
  const channel = new WechatChannel({ store, runner: { run: async () => ({ text: 'ok' }) }, transport });
  clearTimeout(channel.personMemory.wakeTimer); channel.personMemory.wake = () => {};
  channel.personMemory.nextScanAt = Infinity; channel.personMemory.nextMomentsScanAt = Infinity; channel.personMemory.lastAccountId = accountId;
  const service = createPluginService({ root, store, worker: transport, channel });
  t.after(() => channel.close());
  return { root, store, channel, service, writes, status, accountId };
}
const scopeSettings = (store, accountId, publishScope) => store.configure(accountId, { ...store.settings(accountId), publishScope });

test('账号设置的可见范围默认自定义屏蔽名单，接受仅授权好友可见，拒绝其他取值', () => {
  const legacy = { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' };
  assert.equal(publishScopeOf(emptySettings()), 'blocked-list');
  assert.equal(validateSettings(legacy).publishScope, 'blocked-list');
  assert.equal(validateSettings({ ...legacy, publishScope: 'blocked-list' }).publishScope, 'blocked-list');
  assert.equal(validateSettings({ ...legacy, publishScope: 'authorized' }).publishScope, 'authorized');
  for (const value of ['everyone', 'Authorized', '', null, true, 1, []])
    assert.throws(() => validateSettings({ ...legacy, publishScope: value }), error => error.code === 'INVALID_PUBLISH_SCOPE');
});

test('moments.publishScope 读取、保存并持久化当前账号的可见范围', async t => {
  const f = fixture(t), invoke = rpcHandler(f.service), signal = new AbortController().signal, peer = { principal: { kind: 'owner' } };
  assert.deepEqual(await invoke('moments.publishScope', { accountId: f.accountId }, signal, peer),
    { ok: true, value: { scope: 'blocked-list' } });
  assert.deepEqual(await invoke('moments.publishScope', { accountId: f.accountId, scope: 'authorized' }, signal, peer),
    { ok: true, value: { scope: 'authorized' } });
  assert.equal(f.store.settings(f.accountId).publishScope, 'authorized');
  assert.equal(new StateStore(f.root).settings(f.accountId).publishScope, 'authorized');
  assert.deepEqual(await invoke('moments.publishScope', { accountId: f.accountId }, signal, peer),
    { ok: true, value: { scope: 'authorized' } });
  const invalid = await invoke('moments.publishScope', { accountId: f.accountId, scope: 'everyone' }, signal, peer);
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_PUBLISH_SCOPE');
  assert.equal(f.store.settings(f.accountId).publishScope, 'authorized');
  assert.equal((await invoke('moments.publishScope', { accountId: 'other-account' }, signal, peer)).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await invoke('moments.publishScope', { accountId: f.accountId }, signal, { principal: { kind: 'remote' } })).ok, false);
});

test('发布只在仅授权好友可见时把授权名单交给微信组件', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  const blockedList = await f.channel.moments.writeOwner({ action: 'publish', text: '默认可见范围' }, f.accountId, 'scope-default-publish', signal);
  assert.equal(blockedList.action, 'publish');
  assert.equal(f.writes.length, 1);
  assert.equal(Object.hasOwn(f.writes[0], 'authorizedUserIds'), false);
  assert.equal(f.writes[0].authorizedUserIds, undefined);

  scopeSettings(f.store, f.accountId, 'authorized');
  const authorized = await f.channel.moments.writeOwner({ action: 'publish', text: '仅授权好友可见' }, f.accountId, 'scope-authorized-publish', signal);
  assert.equal(authorized.authorizationConfirmed, true);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[1].authorizedUserIds, ['alice', 'bob']);
});

test('validateReceipt 按可见范围核对回执：自定义名单容忍缺少授权字段，授权模式仍要求完整证明', async t => {
  const f = fixture(t), query = { action: 'publish', text: '正文' };
  const receipt = (extra = {}) => ({ accountId: f.accountId, action: 'publish', postId, text: query.text, imageCount: 0,
    delivery: 'server-ack', audienceConfirmed: true, blockedUserIds: [], ...extra });
  assert.doesNotThrow(() => f.channel.moments.validateReceipt(receipt(), query, f.accountId));

  // 自定义名单模式仍要求真正选过的屏蔽对象得到确认。
  const selection = { ...query, blockedUserIds: ['alice'] };
  assert.throws(() => f.channel.moments.validateReceipt(receipt(), selection, f.accountId), error => error.code === 'MOMENTS_RESULT_UNKNOWN');
  assert.throws(() => f.channel.moments.validateReceipt(receipt({ blockedUserIds: [] }), selection, f.accountId),
    error => error.code === 'MOMENTS_RESULT_UNKNOWN');
  assert.doesNotThrow(() => f.channel.moments.validateReceipt(receipt({ blockedUserIds: ['alice'], blockedLabelIds: [],
    audienceSelection: { blockedLabelIds: [], blockedUserIds: ['alice'] }, audienceSource: 'wechat-contacts-live',
    audienceFetchedAt: new Date().toISOString() }), selection, f.accountId));

  scopeSettings(f.store, f.accountId, 'authorized');
  assert.throws(() => f.channel.moments.validateReceipt(receipt(), query, f.accountId), error => error.code === 'MOMENTS_RESULT_UNKNOWN');
  assert.doesNotThrow(() => f.channel.moments.validateReceipt(receipt({ authorizationConfirmed: true,
    authorizedAudienceUserIds: ['alice', 'bob'], authorizationExcludedCount: 0, audienceSource: 'wechat-contacts-live',
    audienceFetchedAt: new Date().toISOString() }), query, f.accountId));
});
