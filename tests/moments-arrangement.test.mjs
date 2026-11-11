import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, MomentsAutomation, MomentsPublishing, momentsPublishingSettings, momentsPlanSettings, momentsLocalInstant, arrangeMoments, momentsDate } from '../lib/testing.js';

const accountId = 'arrangement-test';
const initial = Date.parse('2026-11-10T00:59:00Z');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-arrangement-')), store = new StateStore(root);
  store.configure(accountId, { enabled: true, privatePeers: [], groups: [], prompt: '' });
  let now = initial; const calls = [], writes = [];
  const channel = { now: () => now, store, transport: { status: () => ({ online: true, momentsWriteReady: true, account: { id: accountId } }) },
    moments: { audienceOwner: async () => ({ contacts: [{ id: 'alice' }], labels: [{ id: '1' }] }), writeOwner: async query => {
      writes.push(query); return { postId: String(100 + writes.length), delivery: 'server-ack' };
    } }, runner: { run: async input => {
      if (input.mode === 'moments-content-review') return { text: '{"ok":true,"reason":""}' };
      calls.push(input); return { text: JSON.stringify({ theme: JSON.parse(input.text).themes[0] || '日常', text: '把桌面整理干净以后，连空气都像多了一点。', imagePrompt: '' }) }; } } };
  channel.momentsAutomation = new MomentsAutomation(channel); const manager = channel.momentsAutomation.publishing;
  manager.stopped = false;
  const configure = settings => manager.configure(accountId, { enabled: true, maxPostsPer24Hours: 24, minGapMinutes: 120, automatic: { enabled: true }, ...settings });
  const state = () => manager.list(accountId);
  const manual = (settings, id) => manager.savePlan(accountId, { enabled: true, ...settings }, id, 'manual-' + Math.random());
  t.after(async () => { await manager.close(); assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, channel, manager, calls, writes, state, configure, manual, now: () => now, setTime: value => { now = value; } };
}
const automatic = state => state.plans.filter(plan => plan.automatic);

test('automatic rules validate counts, windows, timezone and content without broadening defaults', () => {
  assert.equal(momentsPublishingSettings({ enabled: true }).automatic.enabled, false);
  for (const automatic of [{ dailyCount: 0 }, { dailyCount: 9 }, { startTime: '22:00', endTime: '08:00' }, { startTime: '9:00' }, { timezone: 'invalid' }, { content: { schedule: {} } }, { content: { image: null } }, { content: { themes: [''] } }])
    assert.throws(() => momentsPublishingSettings({ automatic }));
  const value = momentsPublishingSettings({ automatic: { content: { maxChars: 80 } } });
  assert.equal(value.automatic.content.maxChars, 80); assert.equal(value.automatic.content.useMaterials, true); assert.deepEqual(value.automatic.content.themes, []);
});
test('saving rules immediately creates three days of editable single plans with no model or post', t => {
  const f = fixture(t); f.configure(); const plans = automatic(f.state());
  assert.equal(plans.length, 9); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
  for (const plan of plans) { assert(plan.nextRunAt >= f.now() + 600000); assert.equal(plan.settings.schedule.type, 'once'); assert.deepEqual(plan.settings.themes, []); assert.equal(plan.settings.image.mode, 'library'); }
  for (const date of ['2026-11-10', '2026-11-11', '2026-11-12']) {
    const rows = plans.filter(plan => plan.automatic.date === date).sort((a, b) => a.nextRunAt - b.nextRunAt); assert.equal(rows.length, 3);
    rows.forEach((row, index) => { const time = row.settings.schedule.onceAt.slice(11); assert(time >= '09:00' && time <= '22:00'); if (index) assert(row.nextRunAt - rows[index - 1].nextRunAt >= 7200000); });
  }
});
test('ticks, identical saves and restart preserve plan IDs and scheduled times', async t => {
  const f = fixture(t); f.configure(); const before = automatic(f.state());
  await f.manager.tick(); f.configure(); assert.deepEqual(automatic(f.state()), before);
  const restarted = new MomentsPublishing(f.channel); restarted.stopped = false; await restarted.tick();
  assert.deepEqual(automatic(restarted.list(accountId)), before); assert.equal(restarted.error, undefined);
});
test('manual recurring plans count toward each day and take spacing priority', async t => {
  const f = fixture(t); f.configure(); await f.manual({ name: '午间手动计划', schedule: { times: ['12:00'] } });
  const plans = automatic(f.state()); assert.equal(plans.length, 6);
  for (const plan of plans) { const noon = momentsLocalInstant(plan.automatic.date + 'T12:00', 'Asia/Shanghai'); assert(Math.abs(plan.nextRunAt - noon) >= 7200000); }
  assert.equal(f.state().plans.filter(plan => !plan.automatic).length, 1);
});
test('manual edits, pause and deletion of automatic slots survive reconfiguration and restart', async t => {
  const f = fixture(t); f.configure(); const [edit, pause, remove] = automatic(f.state()).filter(plan => plan.automatic.date === '2026-11-10');
  await f.manual({ name: '我改过的计划', themes: ['个人指定主题'], schedule: { type: 'once', onceAt: '2026-11-10T22:30' } }, edit.id);
  f.manager.setEnabled(accountId, pause.id, false); f.manager.removePlan(accountId, remove.id);
  f.configure({ automatic: { enabled: true, content: { instructions: '后续内容要求' } } });
  const restarted = new MomentsPublishing(f.channel); restarted.stopped = false; await restarted.tick(); const state = restarted.list(accountId);
  assert.equal(state.plans.find(row => row.id === edit.id).settings.name, '我改过的计划');
  assert.deepEqual(state.plans.find(row => row.id === edit.id).settings.themes, ['个人指定主题']);
  assert.equal(state.plans.find(row => row.id === pause.id).settings.enabled, false);
  assert(!state.plans.some(row => row.id === remove.id));
  assert.equal(automatic(state).filter(row => row.automatic.date === '2026-11-10').length, 2);
  assert(automatic(state).filter(row => row.automatic.date === '2026-11-11').every(row => row.settings.instructions === '后续内容要求'));
});
test('automatic disable stops its plans while manual schedules still execute', async t => {
  const f = fixture(t); f.configure(); const first = automatic(f.state())[0];
  f.manager.configure(accountId, { automatic: { enabled: false } }); f.setTime(first.nextRunAt); await f.manager.tick(); assert.equal(f.calls.length, 0);
  await f.manual({ reviewRequired: true, schedule: { type: 'once', onceAt: '2026-11-13T12:00' } });
  f.setTime(momentsLocalInstant('2026-11-13T12:00', 'Asia/Shanghai')); await f.manager.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.state().runs[0].state, 'draft');
});
test('rollover adds the next day without rescheduling the existing horizon or catching up', async t => {
  const f = fixture(t); f.configure(); const tomorrow = automatic(f.state()).filter(row => row.automatic.date === '2026-11-11');
  f.setTime(initial + 86400000); await f.manager.tick();
  assert.deepEqual(automatic(f.state()).filter(row => row.automatic.date === '2026-11-11'), tomorrow);
  assert.equal(automatic(f.state()).filter(row => row.automatic.date === '2026-11-13').length, 3);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test('late enabling reports a shortfall today and only schedules future slots', t => {
  const f = fixture(t); f.setTime(momentsLocalInstant('2026-11-10T21:55', 'Asia/Shanghai')); f.configure();
  assert.equal(automatic(f.state()).filter(row => row.automatic.date === '2026-11-10').length, 0);
  assert.equal(f.state().arrangement[0].shortfall, 3); assert.equal(automatic(f.state()).length, 6);
});
test('automatic plans obey rolling 24-hour capacity across midnight', () => {
  const settings = momentsPublishingSettings({ maxPostsPer24Hours: 2, minGapMinutes: 120, automatic: { enabled: true, dailyCount: 3 } });
  const result = arrangeMoments(accountId, settings, [], [], initial); const times = result.updates.map(row => row.nextRunAt).sort((a, b) => a - b);
  for (const at of times) assert(times.filter(value => value >= at && value < at + 86400000).length <= 2);
  assert(result.summary.some(row => row.shortfall)); assert(times.length >= 4);
});
test('DST missing hour is skipped and rules use the selected local calendar', () => {
  const settings = momentsPublishingSettings({ maxPostsPer24Hours: 24, minGapMinutes: 0, automatic: { enabled: true, dailyCount: 2, startTime: '01:30', endTime: '03:30', timezone: 'America/New_York' } });
  const result = arrangeMoments(accountId, settings, [], [], Date.parse('2026-03-08T05:00:00Z'));
  assert.equal(result.updates.length, 6);
  for (const plan of result.updates) { assert.equal(momentsDate(plan.nextRunAt, settings.automatic.timezone), plan.automatic.date); assert.equal(momentsLocalInstant(plan.settings.schedule.onceAt, settings.automatic.timezone), plan.nextRunAt); }
  assert(!result.updates.some(plan => plan.settings.schedule.onceAt.startsWith('2026-03-08T02:')));
});
test('old installation settings migrate with arranging off and no unexpected plan creation', async t => {
  const f = fixture(t); f.manager.configure(accountId, { enabled: true });
  const file = f.manager.file(), raw = JSON.parse(fs.readFileSync(file, 'utf8')); delete Object.values(raw.accounts)[0].settings.automatic; fs.writeFileSync(file, JSON.stringify(raw));
  const restarted = new MomentsPublishing(f.channel); restarted.stopped = false; await restarted.tick();
  assert.equal(restarted.list(accountId).settings.enabled, true); assert.equal(restarted.list(accountId).settings.automatic.enabled, false); assert.equal(restarted.list(accountId).plans.length, 0);
});
test('default audience is verified and partial settings preserve content and image fields', async t => {
  const f = fixture(t); await f.configure({ automatic: { enabled: true, content: { blockedLabelIds: ['1'], blockedUserIds: ['alice'], image: { mode: 'ai', model: 'custom' } } } });
  await f.manager.configure(accountId, { automatic: { dailyCount: 2, content: { maxChars: 100 } } });
  assert.equal(automatic(f.state()).length, 6);
  for (const plan of automatic(f.state())) { assert.deepEqual(plan.settings.blockedLabelIds, ['1']); assert.deepEqual(plan.settings.blockedUserIds, ['alice']); assert.equal(plan.settings.image.model, 'custom'); assert.equal(plan.settings.maxChars, 100); }
  await assert.rejects(f.manager.configure(accountId, { automatic: { content: { blockedUserIds: ['missing'] } } }), /屏蔽对象已失效/);
  assert.equal(f.state().settings.automatic.content.blockedUserIds[0], 'alice');
});
test('auto plans do not consume the twenty manually created plans allowance', async t => {
  const f = fixture(t); f.configure();
  for (let index = 0; index < 20; index++) await f.manual({ name: '手动 ' + index, enabled: false });
  assert.equal(automatic(f.state()).length, 9); assert.equal(f.state().plans.filter(row => !row.automatic).length, 20);
  await assert.rejects(f.manual({ name: '超出上限', enabled: false }), /20 个手动/);
});
test('unknown automatic publication pauses the entire automatic rule and stays paused after restart', async t => {
  const f = fixture(t); f.configure(); const first = automatic(f.state())[0];
  f.channel.moments.writeOwner = async () => { throw Error('missing receipt'); };
  f.setTime(first.nextRunAt); await f.manager.tick();
  assert.equal(f.state().runs[0].state, 'unknown'); assert.equal(f.state().settings.automatic.enabled, false);
  const restarted = new MomentsPublishing(f.channel); restarted.stopped = false; f.setTime(initial + 86400000); await restarted.tick();
  assert.equal(f.calls.length, 1); assert.equal(restarted.list(accountId).settings.automatic.enabled, false);
});
test('changing automatic settings during generation cancels the old operation before publication', async t => {
  const f = fixture(t); f.configure(); const entered = Promise.withResolvers();
  f.channel.runner.run = input => { entered.resolve(); return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); };
  f.setTime(automatic(f.state())[0].nextRunAt); const running = f.manager.tick(); await entered.promise;
  f.manager.configure(accountId, { automatic: { enabled: false } }); await running;
  assert.equal(f.writes.length, 0); assert.equal(f.state().runs[0].state, 'failed');
});
test('rules edited while automatic mode is off apply when enabled again', t => {
  const f = fixture(t); f.configure();
  f.manager.configure(accountId, { automatic: { enabled: false, startTime: '18:00', endTime: '23:00', dailyCount: 2 } });
  f.manager.configure(accountId, { automatic: { enabled: true } });
  assert.equal(automatic(f.state()).length, 6);
  assert(automatic(f.state()).every(plan => plan.settings.schedule.onceAt.slice(11) >= '18:00'));
});
