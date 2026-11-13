import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, MomentsService, MomentsPublishing, createPluginService, rpcHandler,
  validateSettings, emptySettings, momentsPlanSettings, momentsPublishingSettings } from '../lib/testing.js';

const accountId = 'default-audience-owner';
const signal = () => new AbortController().signal;

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-default-audience-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-moments-default-audience-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

/** A real channel so the endpoint round-trips through the same account settings store. */
function endpointFixture(t) {
  const root = temporary(t), store = new StateStore(root);
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [], prompt: '' });
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const transport = { status: () => status, call: async () => ({ accountId, privatePeers: [] }) };
  const channel = new WechatChannel({ store, runner: { run: async () => ({ text: 'ok' }) }, transport });
  clearTimeout(channel.personMemory.wakeTimer); channel.personMemory.wake = () => {};
  channel.personMemory.nextScanAt = Infinity; channel.personMemory.nextMomentsScanAt = Infinity; channel.personMemory.lastAccountId = accountId;
  const service = createPluginService({ root, store, worker: transport, channel });
  t.after(() => channel.close());
  return { root, store, service };
}

/** Publishing manager with a live contact snapshot the default list is pruned against. */
function publishingFixture(t) {
  const root = temporary(t), store = new StateStore(root), writes = [];
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [], prompt: '' });
  let serial = 0, drafts = 0;
  const clock = Date.parse('2026-11-10T00:59:00Z');
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true, momentsAudienceReady: true };
  const audience = { accountId, membershipComplete: true, source: 'wechat-contacts-live', fetchedAt: new Date(clock).toISOString(), unavailableCount: 0,
    contacts: [{ id: 'alice', name: 'Alice', labelIds: ['1'] }, { id: 'bob', name: 'Bob', labelIds: [] }],
    labels: [{ id: '1', name: '同事', userIds: ['alice'], memberCount: 1 }] };
  const channel = { now: () => clock, store,
    transport: { status: () => status,
      readMomentsAudience: async () => structuredClone(audience),
      writeMoments: async args => {
        writes.push(args);
        const query = args.query, labels = new Map(audience.labels.map(row => [row.id, row])), blocked = new Set(query.blockedUserIds ?? []);
        for (const id of query.blockedLabelIds ?? []) for (const userId of labels.get(id)?.userIds ?? []) blocked.add(userId);
        return { accountId, action: 'publish', postId: String(++serial), text: query.text, imageCount: query.images?.length ?? 0,
          delivery: 'server-ack', audienceConfirmed: true, audienceSource: audience.source, audienceFetchedAt: audience.fetchedAt,
          audienceSelection: { blockedLabelIds: query.blockedLabelIds ?? [], blockedUserIds: query.blockedUserIds ?? [] },
          blockedLabelIds: query.blockedLabelIds ?? [], blockedUserIds: [...blocked].sort() };
      } },
    runner: { run: async input => {
      if (input.mode === 'moments-content-review') return { text: '{"ok":true,"reason":""}' };
      const data = JSON.parse(input.text);
      return { text: JSON.stringify({ theme: data.themes[0] || '日常小观察', imagePrompt: '',
        text: `名单校验第${++drafts}条` }) };
    } } };
  channel.moments = new MomentsService(channel);
  const manager = new MomentsPublishing(channel);
  const defaults = (blockedUserIds, blockedLabelIds) => store.configure(accountId,
    { ...store.settings(accountId), defaultBlockedUserIds: blockedUserIds, defaultBlockedLabelIds: blockedLabelIds });
  t.after(async () => { await manager.close(); });
  return { store, channel, manager, writes, defaults };
}

test('账号设置默认没有屏蔽名单，编号校验并去重后保存', () => {
  const legacy = { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' };
  assert.deepEqual(emptySettings().defaultBlockedUserIds, []);
  assert.deepEqual(emptySettings().defaultBlockedLabelIds, []);
  const settings = validateSettings(legacy);
  assert.deepEqual(settings.defaultBlockedUserIds, []);
  assert.deepEqual(settings.defaultBlockedLabelIds, []);
  assert.equal(settings.publishScope, 'blocked-list');
  const withDefaults = validateSettings({ ...legacy, defaultBlockedUserIds: ['bob', 'alice', 'bob'], defaultBlockedLabelIds: ['12', '3', '12'] });
  assert.deepEqual(withDefaults.defaultBlockedUserIds, ['bob', 'alice']);
  assert.deepEqual(withDefaults.defaultBlockedLabelIds, ['12', '3']);
  for (const value of ['alice', {}, [1], ['alice bob'], [null], 42])
    assert.throws(() => validateSettings({ ...legacy, defaultBlockedUserIds: value }), error => error.code === 'INVALID_MOMENTS_AUDIENCE');
  for (const value of ['1', [0], ['1a'], [4294967296]])
    assert.throws(() => validateSettings({ ...legacy, defaultBlockedLabelIds: value }), error => error.code === 'INVALID_MOMENTS_AUDIENCE');
  assert.throws(() => validateSettings({ ...legacy, defaultBlockedUserIds: Array.from({ length: 50001 }, (_, index) => 'user-' + index) }),
    error => error.code === 'INVALID_MOMENTS_AUDIENCE');
  assert.throws(() => validateSettings({ ...legacy, defaultBlockedLabelIds: Array.from({ length: 1001 }, (_, index) => String(index + 1)) }),
    error => error.code === 'INVALID_MOMENTS_AUDIENCE');
});

test('自动安排与发布计划的“使用默认屏蔽名单”默认为关闭，且只接受布尔值', () => {
  assert.equal(momentsPlanSettings({}).useDefaultAudience, false);
  assert.equal(momentsPublishingSettings({}).automatic.content.useDefaultAudience, false);
  assert.equal(momentsPublishingSettings({ automatic: { content: { useDefaultAudience: true } } }).automatic.content.useDefaultAudience, true);
  assert.equal(momentsPlanSettings({ useDefaultAudience: true }).useDefaultAudience, true);
  for (const value of ['yes', 1, null, {}])
    assert.throws(() => momentsPlanSettings({ useDefaultAudience: value }), error => error.code === 'MOMENTS_PLAN_INVALID');
});

test('moments.audienceDefault 读取、保存并持久化当前账号的默认屏蔽名单', async t => {
  const f = endpointFixture(t), invoke = rpcHandler(f.service), peer = { principal: { kind: 'owner' } }, abort = new AbortController().signal;
  assert.deepEqual(await invoke('moments.audienceDefault', { accountId }, abort, peer),
    { ok: true, value: { blockedUserIds: [], blockedLabelIds: [] } });
  assert.deepEqual(await invoke('moments.audienceDefault', { accountId, blockedUserIds: ['alice', 'alice', 'bob'], blockedLabelIds: ['12'] }, abort, peer),
    { ok: true, value: { blockedUserIds: ['alice', 'bob'], blockedLabelIds: ['12'] } });
  assert.deepEqual(f.store.settings(accountId).defaultBlockedUserIds, ['alice', 'bob']);
  const reopened = new StateStore(f.root).settings(accountId);
  assert.deepEqual(reopened.defaultBlockedUserIds, ['alice', 'bob']);
  assert.deepEqual(reopened.defaultBlockedLabelIds, ['12']);
  // Only the submitted field changes; the other list is preserved.
  assert.deepEqual(await invoke('moments.audienceDefault', { accountId, blockedLabelIds: ['5', '12'] }, abort, peer),
    { ok: true, value: { blockedUserIds: ['alice', 'bob'], blockedLabelIds: ['5', '12'] } });
  const illegal = await invoke('moments.audienceDefault', { accountId, blockedUserIds: ['alice bob'] }, abort, peer);
  assert.equal(illegal.ok, false); assert.equal(illegal.error.code, 'INVALID_MOMENTS_AUDIENCE');
  assert.deepEqual(f.store.settings(accountId).defaultBlockedUserIds, ['alice', 'bob']);
  assert.deepEqual(await invoke('moments.audienceDefault', { accountId, blockedUserIds: [], blockedLabelIds: [] }, abort, peer),
    { ok: true, value: { blockedUserIds: [], blockedLabelIds: [] } });
  assert.deepEqual(new StateStore(f.root).settings(accountId).defaultBlockedLabelIds, []);
  assert.equal((await invoke('moments.audienceDefault', { accountId: 'other-account' }, abort, peer)).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await invoke('moments.audienceDefault', { accountId }, abort, { principal: { kind: 'remote' } })).ok, false);
});

test('自动发布默认沿用计划自己的名单，勾选后才换成账号默认名单', async t => {
  const f = publishingFixture(t);
  f.defaults(['alice'], ['1']);
  const planned = await f.manager.preview(accountId, { blockedUserIds: ['bob'] }, 'plan-list', signal());
  assert.equal(planned.settings.useDefaultAudience, false);
  await f.manager.publishDraft(accountId, planned.id, signal());
  assert.deepEqual(f.writes[0].query.blockedUserIds, ['bob']);
  assert.deepEqual(f.writes[0].query.blockedLabelIds, []);
  const opted = await f.manager.preview(accountId, { useDefaultAudience: true, blockedUserIds: ['bob'] }, 'default-list', signal());
  assert.equal(opted.settings.useDefaultAudience, true);
  await f.manager.publishDraft(accountId, opted.id, signal());
  // 账号默认名单覆盖计划里的内联名单。
  assert.deepEqual(f.writes[1].query.blockedUserIds, ['alice']);
  assert.deepEqual(f.writes[1].query.blockedLabelIds, ['1']);
  assert.equal(f.manager.list(accountId).runs.find(row => row.id === opted.id).state, 'published');
});

test('提交时按实时通讯录裁剪默认名单，失效编号不再阻断发布', async t => {
  const f = publishingFixture(t);
  f.defaults(['ghost', 'alice'], ['9', '1']);
  const partial = await f.manager.preview(accountId, { useDefaultAudience: true }, 'prune', signal());
  await f.manager.publishDraft(accountId, partial.id, signal());
  assert.deepEqual(f.writes[0].query.blockedUserIds, ['alice']);
  assert.deepEqual(f.writes[0].query.blockedLabelIds, ['1']);
  assert.equal(f.manager.list(accountId).runs.find(row => row.id === partial.id).state, 'published');
  f.defaults(['ghost'], ['9']);
  const stale = await f.manager.preview(accountId, { useDefaultAudience: true }, 'stale', signal());
  await f.manager.publishDraft(accountId, stale.id, signal());
  assert.deepEqual(f.writes[1].query.blockedUserIds, []);
  assert.deepEqual(f.writes[1].query.blockedLabelIds, []);
  assert.equal(f.manager.list(accountId).runs.find(row => row.id === stale.id).state, 'published');
});
