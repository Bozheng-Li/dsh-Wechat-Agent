import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import { StateStore, WechatChannel, createPluginService, rpcHandler } from '../lib/testing.js';
import { TIME_DEFAULTS, preserveTimeValues, timeOperationTimeoutMs } from '../shared/time-settings.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-time-settings-'));
  const store = new StateStore(root), account = { id: 'time-owner' }, room = 'timing@chatroom';
  store.configure(account.id, { enabled: true, privatePeers: ['alice'], groups: [room], prompt: '' });
  store.setConversationSettings(account.id, 'group', room, { mode: 'natural', minMessages: 5, maxMessages: 20, recordsPath: '', natural: { minMinutes: 12, maxMinutes: 24, followupSeconds: 88 } });
  const worker = { status: () => ({ account, online: false }), call: async () => ({}) };
  const runner = { selection: () => ({}), defaultSelection: () => ({}) };
  const channel = new WechatChannel({ store, runner, transport: worker });
  const service = createPluginService({ ctx: {}, root, store, worker, runner, channel });
  const rpc = rpcHandler(service);
  t.after(async () => { await service.drain(); await channel.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const scope = { accountId: account.id, chatType: 'group', peerId: room };
  const list = (payload = scope) => service.call('time.list', payload);
  const save = async (id, values, payload = scope) => {
    const group = list(payload).groups.find(row => row.id === id);
    return service.call('time.configure', { ...payload, id, values, revision: group.revision });
  };
  return { root, store, account, room, worker, channel, service, rpc, scope, list, save };
}

test('time settings expose saved schedule deadlines without changing configuration revisions', t => {
  const f = fixture(t), automation = f.channel.momentsAutomation;
  const replies = { ...automation.rule(f.account.id), nextRunAt: Date.now() + 60000,
    settings: { ...automation.rule(f.account.id).settings, enabled: false, friendRepliesEnabled: true } };
  t.mock.method(automation, 'rule', () => replies);
  automation.stopped = false;
  const first = f.list().groups.find(group => group.id === 'replies');
  assert.equal(first.schedule.at, replies.nextRunAt);
  assert.equal(first.schedule.enabled, true);
  assert.equal(first.schedule.running, false);
  replies.nextRunAt += 60000;
  const next = f.list().groups.find(group => group.id === 'replies');
  assert.equal(next.schedule.at, replies.nextRunAt);
  assert.equal(next.revision, first.revision);
  assert.deepEqual(next.values, first.values);
});

test('schedule status reads keep natural chat timing unchanged and omit nonscheduled settings', t => {
  const f = fixture(t), before = structuredClone(f.store.naturalState(f.account.id, 'group', f.room));
  const rows = f.list().groups;
  assert.equal(rows.find(group => group.id === 'natural').schedule.at, before.nextCheckAt || null);
  assert.equal(rows.find(group => group.id === 'natural').schedule.paused, true);
  assert.deepEqual(f.store.naturalState(f.account.id, 'group', f.room), before);
  assert.equal(rows.find(group => group.id === 'runtime').schedule, undefined);
  assert.equal(rows.find(group => group.id === 'role').schedule, undefined);
});

test('one owner page reads existing global, account, provider and conversation timings without resetting them', t => {
  const f = fixture(t), next = f.store.config.snapshot(f.store.data);
  next.imageGeneration = { enabled: false, defaultProviderId: 'first', providers: [{ id: 'first', name: 'Existing API', timeoutSeconds: 270 }] };
  f.store.config.commit(f.store.config.validate(next));
  const groups = f.list().groups, byId = id => groups.find(row => row.id === id);
  assert.equal(byId('natural').values.minMinutes, 12);
  assert.equal(byId('natural').values.followupSeconds, 88);
  assert.equal(byId('provider:first').values.timeoutSeconds, 270);
  assert.equal(byId('role').values.intervalMinutes, 60);
  assert.equal(byId('role').values.timeoutMinutes, 60);
  assert.equal(byId('images:conversation').values.retentionDays, 30);
  assert.equal(byId('images:generated').values.retentionDays, 30);
  for (const id of ['runtime', 'work', 'memory', 'image-defaults', 'natural-defaults', 'replies', 'likes', 'interactions', 'materials', 'publishing']) assert(byId(id), id);
  assert(!JSON.stringify(groups).includes('https://'), 'the page receives time fields only');
});

test('time saves persist across reloads and only change the selected fields and scopes', async t => {
  const f = fixture(t);
  await f.save('runtime', { conversationTimeoutSeconds: 420, momentsPublishTimeoutMinutes: 90 });
  await f.save('natural', { minMinutes: 14, maxMinutes: 29 });
  await f.save('role', { intervalMinutes: 75, timeoutMinutes: 20 });
  await f.save('work', { commandTimeoutSeconds: 120 });
  await f.save('images:generated', { retentionDays: null });
  const reloaded = new StateStore(f.root);
  assert.equal(reloaded.config.data.timeSettings.momentsPublishTimeoutMinutes, 90);
  assert.equal(reloaded.roleCardSettings().intervalMinutes, 75);
  assert.equal(reloaded.roleCardSettings().messageThreshold, 20);
  assert.equal(reloaded.conversationSettings(f.account.id, 'group', f.room).natural.minMinutes, 14);
  assert.equal(reloaded.conversationSettings(f.account.id, 'group', f.room).natural.followupSeconds, 88);
  assert.equal(reloaded.config.data.work.commandTimeoutSeconds, 120);
  assert.equal(f.channel.timeoutMs, 420000);
  assert.equal(f.channel.imageMemory.load({ ...f.scope, collection: 'generated' }).settings.retentionDays, null);
  assert.equal(f.channel.imageMemory.load({ ...f.scope, collection: 'conversation' }).settings.retentionDays, 30);
  assert.equal(reloaded.settings(f.account.id).enabled, true);
});

test('account automation time changes keep content, switches and quotas intact', async t => {
  const f = fixture(t);
  await f.save('replies', { intervalMinutes: 8, lookbackDays: 14 });
  await f.save('likes', { intervalMinutes: 45, lookbackDays: 5 });
  await f.save('interactions', { intervalMinutes: 120, lookbackDays: 9, intervalSeconds: 12 });
  await f.save('materials', { intervalMinutes: 240 });
  await f.save('publishing', { minGapMinutes: 180, 'automatic.startTime': '10:00', 'automatic.endTime': '20:00', 'automatic.content.graceMinutes': 40 });
  const automation = f.channel.momentsAutomation;
  assert.equal(automation.rule(f.account.id).settings.intervalMinutes, 8);
  assert.equal(automation.rule(f.account.id).settings.enabled, false);
  assert.equal(automation.likes.rule(f.account.id).settings.maxLikesPerRun, 5);
  assert.equal(automation.interactions.automation.rule(f.account.id).settings.intervalSeconds, 12);
  assert.equal(automation.materials.account(f.account.id).settings.intervalMinutes, 240);
  assert.equal(automation.publishing.account(f.account.id).settings.automatic.content.graceMinutes, 40);
  assert.equal(automation.publishing.account(f.account.id).settings.maxPostsPer24Hours, 3);
});

test('invalid values, stale revisions and changed accounts cannot overwrite current settings', async t => {
  const f = fixture(t), group = f.list().groups.find(row => row.id === 'role');
  await f.save('role', { timeoutMinutes: 12 });
  await assert.rejects(f.service.call('time.configure', { ...f.scope, id: 'role', values: { intervalMinutes: 99 }, revision: group.revision }), { code: 'TIME_SETTINGS_CHANGED' });
  for (const values of [{ timeoutMinutes: 0 }, { timeoutMinutes: 1.5 }, { enabled: false }, { timeoutMinutes: '' }]) await assert.rejects(f.save('role', values), { code: 'INVALID_TIME_SETTINGS' });
  await assert.rejects(f.save('natural', { minMinutes: 100, maxMinutes: 2 }));
  assert.throws(() => f.list({ ...f.scope, accountId: 'other' }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.store.roleCardSettings().timeoutMinutes, 12);
  assert.equal(f.store.roleCardSettings().intervalMinutes, 60);
  const denied = await f.rpc('time.list', {}, undefined, { principal: { kind: 'guest' } });
  assert.equal(denied.error.code, 'OWNER_REQUIRED');
  const allowed = await f.rpc('time.list', {}, undefined, { principal: { kind: 'owner' } });
  assert.equal(allowed.ok, true);
});

test('old YAML gains timeout defaults while keeping the original configurable intervals', t => {
  const f = fixture(t), file = path.join(f.root, 'config.yaml'), data = parse(fs.readFileSync(file, 'utf8'));
  delete data.timeSettings; data.roleCardSettings.intervalMinutes = 135;
  fs.writeFileSync(file, stringify(data));
  const reloaded = new StateStore(f.root);
  assert.deepEqual(reloaded.config.data.timeSettings, TIME_DEFAULTS);
  assert.equal(reloaded.roleCardSettings().intervalMinutes, 135);
  assert.equal(reloaded.conversationSettings(f.account.id, 'group', f.room).natural.followupSeconds, 88);
});

test('other editors keep current timings and client waits follow configured server limits', () => {
  const draft = { enabled: true, minGapMinutes: 10, automatic: { startTime: '09:00', endTime: '20:00', timezone: 'Asia/Shanghai', content: { graceMinutes: 60, style: 'new style' } } };
  const latest = { minGapMinutes: 120, automatic: { startTime: '12:00', endTime: '23:00', timezone: 'Asia/Shanghai', content: { graceMinutes: 15 } } };
  const merged = preserveTimeValues('publishing', draft, latest);
  assert.equal(merged.automatic.content.style, 'new style');
  assert.equal(merged.minGapMinutes, 120); assert.equal(merged.automatic.startTime, '12:00');
  assert.equal(merged.automatic.content.graceMinutes, 15); assert.equal(draft.minGapMinutes, 10);
  assert.equal(timeOperationTimeoutMs({ momentsPublishTimeoutMinutes: 90 }, 'moments.plans.preview'), 5415000);
  assert.equal(timeOperationTimeoutMs({ momentsCommentTimeoutMinutes: 12 }, 'moments.interactions.generate'), 735000);
});

test('a stale functional editor cannot restore older timings when saving non-time preferences', async t => {
  const f = fixture(t), original = f.store.conversationSettings(f.account.id, 'group', f.room);
  t.mock.method(f.worker, 'status', () => ({ account: f.account, online: true }));
  await f.save('natural', { fixedMinutes: 33, minGapMinutes: 8 });
  await f.service.call('conversation.configure', { ...f.scope, config: { ...original, natural: { ...original.natural, temperament: 'lively' } }, preserveTimeSettings: true });
  const current = f.store.conversationSettings(f.account.id, 'group', f.room);
  assert.equal(current.natural.temperament, 'lively'); assert.equal(current.natural.fixedMinutes, 33); assert.equal(current.natural.minGapMinutes, 8);
  const stale = structuredClone(f.channel.momentsAutomation.rule(f.account.id).settings);
  await f.save('replies', { intervalMinutes: 99 });
  await f.service.call('moments.configure', { accountId: f.account.id, settings: { ...stale, replyInstructions: 'new instructions' }, preserveTimeSettings: true });
  assert.equal(f.channel.momentsAutomation.rule(f.account.id).settings.intervalMinutes, 99);
  assert.equal(f.channel.momentsAutomation.rule(f.account.id).settings.replyInstructions, 'new instructions');
});

test('publishing and materials use configured deadlines and keep the active deadline when settings change', async t => {
  const f = fixture(t);
  await f.save('runtime', { momentsPublishTimeoutMinutes: 17, momentsMaterialTimeoutMinutes: 8, momentsImageTimeoutMinutes: 3 });
  t.mock.method(f.worker, 'status', () => ({ account: f.account, online: true }));
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => { const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal; });
  const manager = f.channel.momentsAutomation.publishing, started = Promise.withResolvers(), finish = Promise.withResolvers();
  const pending = manager.operation(f.account.id, null, undefined, async signal => { started.resolve(); await finish.promise; signal.throwIfAborted(); });
  await started.promise; assert.equal(deadlines[0].ms, 17 * 60000);
  await f.save('runtime', { momentsPublishTimeoutMinutes: 25 });
  assert.equal(manager.operationTimeoutMs, 17 * 60000);
  deadlines[0].controller.abort(new DOMException('Expired', 'TimeoutError')); finish.resolve();
  await assert.rejects(pending, { name: 'TimeoutError' });
  await manager.operation(f.account.id, null, undefined, async () => {});
  assert.equal(deadlines.at(-1).ms, 25 * 60000);
  const materials = f.channel.momentsAutomation.materials;
  await materials.operation(f.account.id, undefined, async () => {}, 'organize'); assert.equal(deadlines.at(-1).ms, 8 * 60000);
  await materials.operation(f.account.id, undefined, async () => {}, 'describe'); assert.equal(deadlines.at(-1).ms, 3 * 60000);
});
