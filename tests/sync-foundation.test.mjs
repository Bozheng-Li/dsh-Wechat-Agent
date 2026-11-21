import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { StateStore } from '../backend/storage/state-store.mjs';
import { archiveLock, acquireLock } from '../backend/storage/locks.mjs';
import { ConversationMemory } from '../modules/memory/conversation/store.mjs';
import { LongTermMemory } from '../modules/memory/long-term/store.mjs';
import { TaskScheduler } from '../modules/tasks/scheduler.mjs';
import { validateConversationSettings, emptyNaturalSettings, participationTriggers, validateSettings,
  schedulesEnabled, momentsEnabled, validateModelConfig, messageText, ChannelError } from '../shared/contracts.mjs';
import { traceSettings } from '../shared/trace-settings.mjs';
import { emptyRoleCard } from '../shared/role-card.mjs';

const accountId = 'foundation-owner';
const scope = { accountId, chatType: 'private', peerId: 'alice', senderId: 'alice', source: 'owner' };
const settings = { enabled: true, privatePeers: ['alice'], groups: ['foundation@chatroom'], prompt: '' };
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-sync-foundation-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.match(path.basename(root), /^wechat-sync-foundation-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new StateStore(root); store.configure(accountId, settings);
  return { root, store };
}
const config = (extra = {}) => validateConversationSettings({ mode: 'default', minMessages: 5, maxMessages: 20, recordsPath: '', ...extra });
const model = (extra = {}) => validateModelConfig({ maxTokens: null, temperature: null, ...extra });
const persona = { name: '同步助手', aliases: ['小同'], prompt: '自然地说话。', personaMode: 'high-precision' };

 test('foundation contracts preserve native work and legacy participation permissions', () => {
  assert.deepEqual(participationTriggers(config({ mode: 'participate', natural: { timerEnabled: true, followupEnabled: true } })),
    { message: true, timer: false, followup: false });
  assert.deepEqual(participationTriggers(config({ mode: 'natural' })), { message: true, timer: true, followup: true });
  assert.deepEqual(participationTriggers(config({ mode: 'natural', natural: emptyNaturalSettings() })),
    { message: true, timer: false, followup: false });
  const work = config({ executionMode: 'work', workSenderIds: ['alice'], remoteEnabled: true, adminIds: ['alice'] });
  assert.equal(work.executionMode, 'work'); assert.deepEqual(work.workSenderIds, ['alice']);
  assert.equal(messageText({ chatType: 'group', message: [{ type: 'text', data: { text: '/work 保留原生任务' } }] }, { id: accountId }).trigger, 'command');
});

test('foundation independent automation flags preserve legacy enabled fallback and explicit choices', () => {
  assert.equal(schedulesEnabled(validateSettings(settings)), true);
  assert.equal(momentsEnabled(validateSettings({ ...settings, enabled: false })), false);
  const independent = validateSettings({ ...settings, enabled: false, schedules: true, moments: true });
  assert.equal(schedulesEnabled(independent), true); assert.equal(momentsEnabled(independent), true);
  assert.equal(schedulesEnabled(validateSettings({ ...settings, schedules: false })), false);
  assert.throws(() => validateSettings({ ...settings, moments: 'true' }), { code: 'INVALID_SETTINGS' });
});

test('foundation search config accepts App fields without converting the DSH native selection', () => {
  assert.equal(model({ searchProvider: 'dsh' }).searchProvider, 'dsh');
  const value = model({ searchProvider: 'deepseek', deepseekBaseURL: 'https://search.example/anthropic/v1', deepseekModel: 'search-test' });
  assert.equal(value.searchProvider, 'deepseek'); assert.equal(value.deepseekModel, 'search-test');
  assert.throws(() => model({ deepseekBaseURL: 'http://external.example' }), { code: 'INVALID_SEARCH_CONFIG' });
});

test('foundation persona library survives restart with work settings and App automation fields', t => {
  const { root, store } = fixture(t);
  assert.equal(store.personasView().items.length, 1);
  store.setPersona(persona);
  assert.equal(Object.hasOwn(parse(fs.readFileSync(store.config.file, 'utf8')), 'personas'), false, 'editing legacy persona does not silently create a library');
  const created = store.createPersona({ persona, name: '语言档案', source: 'distilled', provenance: { accountId, personId: 'alice', sourceScopes: [] } });
  const id = created.activeId;
  store.configure(accountId, { ...settings, enabled: false, schedules: true, moments: true });
  const next = store.config.snapshot(store.data);
  next.work = { timeoutSeconds: 0, commandTimeoutSeconds: 91, maxConcurrent: 3 };
  next.modelConfig = model({ searchProvider: 'deepseek', deepseekModel: 'fixture-search' });
  store.config.commit(store.config.validate(next));
  const reopened = new StateStore(root);
  assert.equal(reopened.personasView().activeId, id); assert.deepEqual(reopened.persona(), persona);
  assert.equal(reopened.personaEntries().find(row => row.id === id).provenance.personId, 'alice');
  assert.equal(reopened.settings(accountId).schedules, true);
  assert.equal(reopened.config.section('work').commandTimeoutSeconds, 91);
  assert.equal(reopened.modelConfig().deepseekModel, 'fixture-search');
  reopened.selectPersona('default'); assert.equal(reopened.activePersonaId(), 'default');
  reopened.deletePersona(id); assert.equal(reopened.personasView().items.length, 1);
  assert.throws(() => reopened.deletePersona('default'), { code: 'PERSONA_REQUIRED' });
});

test('foundation trace retention is opt-in and does not add incompatible YAML fields', t => {
  const { store } = fixture(t);
  assert.deepEqual(traceSettings(), { retentionDays: null, cacheDays: 14 });
  assert.deepEqual(traceSettings({ retentionDays: 90, cacheDays: 4 }), { retentionDays: 90, cacheDays: 4 });
  assert.equal(Object.hasOwn(store.config.data, 'traceSettings'), false);
  assert.equal(Object.hasOwn(parse(fs.readFileSync(store.config.file, 'utf8')), 'traceSettings'), false);
  for (const value of [{ retentionDays: 0 }, { cacheDays: 366 }, { retentionDays: '30' }, { extra: true }])
    assert.throws(() => traceSettings(value), { code: 'INVALID_TRACE_SETTINGS' });
});

test('foundation external YAML changes do not freeze message state, and cannot be overwritten by settings', t => {
  const { root, store } = fixture(t);
  const data = parse(fs.readFileSync(store.config.file, 'utf8')); data.modelConfig.temperature = 0.6;
  const changed = stringify(data); fs.writeFileSync(store.config.file, changed);
  store.remember('manual-foundation', Date.now(), undefined, { accountId, message: {
    id: 'manual-foundation', peerId: 'alice', chatType: 'private', direction: 'incoming',
    sender: { id: 'alice', nickname: '甲' }, time: Date.now() / 1000,
    message: [{ type: 'text', data: { text: '保留这条消息' } }],
  } });
  assert.equal(fs.readFileSync(store.config.file, 'utf8'), changed);
  assert.throws(() => store.setPersona({ ...persona, prompt: '另一个正文' }), { code: 'CONFIG_CHANGED' });
  assert.equal(new StateStore(root).history(accountId, 'private', 'alice', 10)[0].text, '保留这条消息');
});

test('foundation partial ACK history stores only acknowledged bubbles and retains generation metadata', t => {
  const { root, store } = fixture(t);
  const record = { ...scope, key: 'partial-foundation', contextKey: 'context-foundation', state: 'sending', createdAt: Date.now() };
  store.add(record);
  const generation = { jobId: '012345abcdef', prompt: '测试画面', deliveryState: 'sent', serverMessageIds: ['image-ack'] };
  store.update(record, { state: 'partial', reply: '第一段\n第二段', acknowledgedMessageIds: ['text-ack', 'image-ack'],
    replyPlan: [{ index: 0, type: 'text', text: '第一段' }, { index: 1, type: 'text', text: '第二段' },
      { index: 2, type: 'image', media: { id: 'asset', kind: 'image', name: '生成图', generation } }],
    deliveryParts: [{ planIndex: 0, type: 'text', state: 'acknowledged', serverMessageId: 'text-ack', text: '第一段', observedAt: 1234567890000 },
      { planIndex: 1, type: 'text', state: 'unknown' }, { planIndex: 2, type: 'image', state: 'acknowledged', serverMessageId: 'image-ack' }] });
  let history = store.history(accountId, 'private', 'alice', 20);
  assert.deepEqual(history.map(row => row.messageId), ['text-ack', 'image-ack']);
  assert.equal(history[0].text, '第一段'); assert.deepEqual(history[1].attachments[0].generation, generation);
  store.update(record, { reason: '保持回执' });
  history = new StateStore(root).history(accountId, 'private', 'alice', 20);
  assert.equal(history.length, 2, 'receipt reconciliation is idempotent');
  const work = { ...scope, key: 'work-foundation', workJobId: '012345abcdef', state: 'sending', createdAt: Date.now() };
  store.add(work); store.update(work, { state: 'sent', reply: '原生工作结果', acknowledgedMessageIds: ['work-ack'] });
  assert.equal(store.history(accountId, 'private', 'alice', 20).some(row => row.messageId === 'work-ack'), false);
});

test('foundation unchanged conversations skip writes and dirty records persist after restart', t => {
  const { root, store } = fixture(t), record = { ...scope, key: 'dirty-foundation', state: 'queued', createdAt: Date.now() };
  store.add(record);
  const writeAt = store._writeAt.bind(store); let writes = 0;
  store._writeAt = (...args) => { writes++; return writeAt(...args); };
  store.save(); store.save(); assert.equal(writes, 0);
  store.update(record, { state: 'failed', reason: '测试状态' }); assert.equal(writes, 1);
  assert.equal(new StateStore(root).records(accountId)[0].reason, '测试状态');
});

test('foundation own stale archive temporaries do not block new conversation creation', t => {
  const { store } = fixture(t);
  const { name, ...selector } = store.conversationSelector(accountId, 'private', 'alice'), directory = store._directory(selector);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'conversation.json.123.00000000-0000-0000-0000-000000000000.tmp'), 'interrupted');
  store.add({ ...scope, key: 'temporary-foundation', state: 'failed', createdAt: Date.now() });
  assert.equal(fs.existsSync(path.join(directory, 'conversation.json')), true);
});

test('foundation archive locks recover stale truncation and do not let failed release poison later writes', t => {
  const { root } = fixture(t), directory = path.join(root, 'lock-fixture'); fs.mkdirSync(directory);
  const file = path.join(directory, '.wechat-agent-write.lock');
  fs.writeFileSync(file, ''); fs.utimesSync(file, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  const release = archiveLock(directory, 'store', 'conversation');
  const unlink = fs.unlinkSync;
  fs.unlinkSync = target => { if (target === file) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return unlink(target); };
  try { assert.doesNotThrow(release); } finally { fs.unlinkSync = unlink; }
  const next = archiveLock(directory, 'store', 'conversation'); next(); assert.equal(fs.existsSync(file), false);
  const owner = path.join(root, 'owner.lock'); fs.writeFileSync(owner, '');
  fs.utimesSync(owner, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  acquireLock(root).release(); assert.equal(fs.existsSync(owner), false);
});

test('foundation conversation cache isolates caller mutations and refreshes external changes', t => {
  const { store } = fixture(t), memory = new ConversationMemory(store);
  const initial = memory.load(scope); initial.summary = '未保存的污染';
  assert.equal(memory.load(scope).summary, '');
  memory.append(scope, { key: 'memory-foundation', messageId: 'm1', direction: 'incoming', senderId: 'alice', text: '喜欢红茶', time: Date.now() });
  const snapshot = memory.snapshot(scope, 'memory-foundation'); assert.equal(snapshot.entries.length, 0);
  assert.equal(memory.load(scope).entries.length, 1);
  const doc = JSON.parse(fs.readFileSync(memory.file(memory.selector(scope)), 'utf8')); doc.summary = '外部正文'; doc.revision++;
  fs.writeFileSync(memory.file(memory.selector(scope)), JSON.stringify(doc));
  assert.equal(memory.load(scope).summary, '外部正文');
});

test('foundation long-term cached state respects clear generation and expired pending sources', t => {
  const { store } = fixture(t); let now = Date.now(); const memory = new LongTermMemory(store, { now: () => now });
  const state = memory.state(accountId), previous = state.generation;
  state.pending.fixture = { selector: scope, entries: [{ key: 'old', digest: 'digest', rememberedAt: now - 400 * 86400000 }] };
  memory.saveState(state);
  assert.equal(memory.state(accountId).pending.fixture, undefined);
  const file = memory.paths(accountId).file; fs.unlinkSync(file);
  assert.notEqual(memory.state(accountId).generation, previous);
  assert.deepEqual(memory.state(accountId).pending, {});
});

test('foundation role-card snapshots retain prior evidence and deletion clears recoverable private values', t => {
  const { store } = fixture(t), person = { accountId, personId: 'alice' };
  const first = store.roleCards.save(person, { ...emptyRoleCard(), preferences: '喜欢红茶' }, 'empty', 1000);
  const second = store.roleCards.save(person, { ...first.card, preferences: '喜欢绿茶' }, first.revision, 2000);
  const change = second.changes.at(-1); assert.equal(change.before, '喜欢红茶'); assert.equal(change.beforeEvidence.updatedAt, 1000);
  const cleared = store.roleCards.save(person, { ...second.card, preferences: '' }, second.revision, 3000);
  assert.equal(cleared.changes.filter(row => row.field === 'preferences').length, 1);
  assert.equal(cleared.changes.at(-1).before, ''); assert.equal(cleared.changes.at(-1).beforeEvidence, null);
});

function scheduledFixture(t) {
  const f = fixture(t); let now = Date.now();
  f.store.configure(accountId, { ...settings, enabled: false, schedules: true });
  const channel = { pauses: new Map(), transport: { status: () => ({ online: true, account: { id: accountId } }) },
    submitScheduled: async task => ({ state: 'sent', acknowledgedMessageIds: ['ack-' + task.id] }) };
  const scheduler = new TaskScheduler({ store: f.store, channel, now: () => now });
  t.after(() => { clearInterval(scheduler.timer); });
  return { ...f, channel, scheduler, now: () => now, advance: ms => { now += ms; } };
}

test('foundation scheduler runs independent of replies and keeps recurring scheduled anchors', async t => {
  const f = scheduledFixture(t), task = f.scheduler.create({ kind: 'message', content: '定时提醒', schedule: { kind: 'interval', minutes: 5 } }, scope);
  f.advance(5 * 60000); const anchor = f.now();
  f.channel.submitScheduled = async () => { f.advance(40000); return { state: 'sent', acknowledgedMessageIds: ['ack'] }; };
  await f.scheduler.tick();
  assert.equal(f.scheduler.get(task.id, scope, true).nextRunAt, anchor + 5 * 60000);
});

test('foundation scheduler retains plugin late-reminder cutoff and uncertain sends never retry', async t => {
  const f = scheduledFixture(t);
  const missed = f.scheduler.create({ kind: 'message', content: '过期提醒', schedule: { kind: 'once', at: f.now() + 60000 } }, scope);
  f.advance(17 * 60000); await f.scheduler.tick(); assert.equal(f.scheduler.get(missed.id, scope, true).state, 'expired');
  const task = f.scheduler.create({ kind: 'message', content: '未知提醒', schedule: { kind: 'once', at: f.now() + 60000 } }, scope);
  f.channel.submitScheduled = async value => { f.store.data.records.push({ key: value.recordKey, sendAttempted: true }); throw new ChannelError('SEND_UNKNOWN', '未确认'); };
  f.advance(60000); await f.scheduler.tick();
  const current = f.scheduler.get(task.id, scope, true); assert.equal(current.state, 'paused'); assert.equal(current.lastState, 'unknown');
});

test('foundation scheduler tolerates one transient tick failure and stops after five consecutive failures', async t => {
  const f = scheduledFixture(t), interval = globalThis.setInterval, clear = globalThis.clearInterval;
  let callback;
  globalThis.setInterval = fn => { callback = fn; return { unref() {} }; }; globalThis.clearInterval = () => {};
  try {
    f.scheduler.start(); f.scheduler.drain = async () => { throw new Error('temporary disk failure'); };
    callback(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.scheduler.stopped, false);
    f.scheduler.drain = async () => {}; callback(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.scheduler.failures, 0);
    f.scheduler.drain = async () => { throw new Error('persistent disk failure'); };
    for (let i = 0; i < 5; i++) { callback(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(f.scheduler.failed, true); assert.equal(f.scheduler.stopped, true);
    assert.throws(() => f.scheduler.create({ kind: 'message', content: '不会假创建', schedule: { kind: 'once', at: f.now() + 60000 } }, scope), { code: 'TASKS_STOPPED' });
    f.scheduler.timer = null;
  } finally { globalThis.setInterval = interval; globalThis.clearInterval = clear; }
});
