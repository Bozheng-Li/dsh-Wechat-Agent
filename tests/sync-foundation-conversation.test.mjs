import test from 'node:test';
import assert from 'node:assert/strict';
import { WechatChannel } from '../modules/conversation/channel.mjs';
import { receiveMessage, observeManualReply, enqueueNaturalReply } from '../modules/conversation/incoming.mjs';
import { NaturalChat, parseNaturalDecision } from '../modules/conversation/natural-chat.mjs';
import { settingsMutation } from '../modules/conversation/actions.mjs';
import { recordInput, recordOutput, recordSpec, recordState, recordType, historicalTraces, workSpec, workState } from '../modules/traces/records.mjs';
import { emptyNaturalState, emptyNaturalSettings, validateConversationSettings } from '../shared/contracts.mjs';
import { UNAVAILABLE_MESSAGE_TITLE, UNAVAILABLE_MESSAGE_REPLY } from '../shared/message-content.mjs';

const accountId = 'conversation-foundation-owner', room = 'foundation@chatroom';
const clone = value => structuredClone(value);
function fixture(extra = {}) {
  let now = Date.UTC(2026, 10, 21, 6, 0), serial = 0;
  const state = { settings: { enabled: true, schedules: true, moments: true, privatePeers: ['alice'], groups: [room], prompt: '' },
    config: validateConversationSettings({ mode: 'natural', minMessages: 1, maxMessages: 1, fixedMessages: 1, intervalMode: 'fixed', recordsPath: '',
      natural: { ...emptyNaturalSettings(), activeHours: false }, ...extra }), natural: emptyNaturalState(), progress: { count: 0, target: 1 } };
  const history = [], writes = [], seen = {}, records = [], work = [], workCancelled = [];
  const store = { data: { seen, records, authorizationRevocations: [] },
    settings: () => clone(state.settings), conversationSettings: () => clone(state.config),
    conversationPersona: () => ({ name: '同步助手', aliases: ['小同'] }), isGroupMember: () => false,
    config: { section: key => key === 'remote' ? { globalAdminIds: [] } : {}, assertCurrent() {} },
    progress: () => clone(state.progress), naturalState: () => clone(state.natural),
    setNaturalState: (_a, _c, _p, value) => { state.natural = clone(value); },
    remember(key, at, record, observation = {}) {
      if (seen[key]) return false; seen[key] = at;
      if (record) records.push(record);
      if (observation.message) history.push({ key, ...observation.message });
      if (observation.progress) state.progress = clone(observation.progress);
      if (observation.natural) state.natural = clone(observation.natural);
      return true;
    },
    add(record, observation = {}) { records.push(record); if (observation.natural) state.natural = clone(observation.natural); },
    update(record, fields, observation = {}) { Object.assign(record, fields); writes.push({ key: record.key, fields }); if (observation.natural) state.natural = clone(observation.natural); },
    configure(_id, value) { state.settings = clone(value); }, resetSessions() {}, rememberConversationNames() {}, resetProgress() {},
  };
  const channel = { store, queue: [], workReplies: new Map(), workActive: new Map(), memoryPending: new Map(), memoryForced: new Map(), memoryRetries: new Map(),
    pauses: new Map(), closed: false, fault: null, now: () => now, random: () => 0,
    transport: { status: () => ({ online: true, account: { id: accountId, nickname: '测试账号' } }) },
    stickers: { capture: async () => {} }, authorization: { isCleaning: () => false, whenIdle: async () => {} },
    memory: { snapshot: () => ({ entries: clone(history) }), index: { conversations: {} } },
    personMemory: { cancel() {}, wake() {}, nextScanAt: 0 },
    work: { cancelAll: (...args) => workCancelled.push(args), owned: () => ({ state: 'running' }), assertAllowed() {} },
    remote: { assertAllowed() {} }, modes: { assertAllowed() {}, handle: () => '模式已切换' },
    maintainMemory() {}, drain() {}, pushWork: item => work.push(item), pushDirect: item => channel.queue.push(item),
    fail: error => { channel.fault = error; },
  };
  channel.natural = new NaturalChat(channel);
  channel.nextThreshold = config => WechatChannel.prototype.nextThreshold.call(channel, config);
  channel.cancelNaturalAmbient = (...args) => WechatChannel.prototype.cancelNaturalAmbient.call(channel, ...args);
  channel.cancelWorkReplies = (...args) => WechatChannel.prototype.cancelWorkReplies.call(channel, ...args);
  channel.receiveManual = (...args) => observeManualReply(channel, ...args);
  channel.enqueueNatural = input => enqueueNaturalReply(channel, input);
  const message = (text, { chatType = 'group', peerId = chatType === 'group' ? room : 'alice', senderId = 'alice', nativeAt = false, ...rest } = {}) => ({
    id: 'message-' + ++serial, peerId, chatType, sender: { id: senderId, nickname: '甲' }, direction: 'incoming',
    source: 'longlink:NewSync', time: now / 1000, message: [...(nativeAt ? [{ type: 'at', data: { qq: accountId } }] : []), { type: 'text', data: { text } }], ...rest,
  });
  const receive = (text, options) => { const value = message(text, options); receiveMessage(channel, value, accountId); assert.equal(channel.fault, null); return value; };
  return { channel, store, state, history, records, work, workCancelled, message, receive, advance: ms => { now += ms; }, now: () => now };
}
const unreadable = '无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。';

test('foundation conversation unavailable feedback stays within private or native-at boundaries', () => {
  for (const options of [{ chatType: 'private' }, { nativeAt: true }]) {
    const f = fixture(); f.receive(unreadable, options);
    assert.equal(f.channel.queue.length, 1); assert.equal(f.channel.queue[0].unavailableNotice, UNAVAILABLE_MESSAGE_REPLY);
    assert.equal(f.records[0].contentUnavailable, true); assert.equal(f.records[0].unavailableNotice, true);
  }
  const quiet = fixture(); quiet.receive(unreadable);
  assert.equal(quiet.channel.queue.length, 0); assert.equal(quiet.records[0].state, 'skipped');
  assert.equal(recordState(quiet.records[0]), 'failed'); assert.equal(recordSpec(quiet.records[0]).title, UNAVAILABLE_MESSAGE_TITLE);
});

test('foundation conversation unavailable placeholders do not bypass paused or historical-message boundaries', () => {
  const paused = fixture(); paused.state.settings.enabled = false; paused.receive(unreadable, { chatType: 'private' });
  assert.equal(paused.channel.queue.length, 0);
  const old = fixture(); old.receive(unreadable, { chatType: 'private', time: (old.now() - 11 * 60000) / 1000 });
  assert.equal(old.channel.queue.length, 0); assert.match(old.records[0].reason, /最近十分钟/);
});

test('foundation conversation legacy count mode now gets a reply-or-skip decision without timer or followup grants', () => {
  const f = fixture({ mode: 'participate' }); f.receive('大家在讨论明天的安排');
  assert.equal(f.channel.queue.length, 1);
  const item = f.channel.queue[0]; assert.equal(item.mode, 'participate'); assert.equal(item.naturalDecision.trigger, 'count');
  assert.equal(item.naturalDecision.allowColdOpening, false); assert.equal(f.state.natural.nextCheckAt, 0);
  const next = f.channel.natural.after(item, 'sent', '有道理', ['ack']); assert.equal(next.followup.remaining, 0);
  assert.deepEqual(parseNaturalDecision('{"action":"skip","reason":"busy","text":""}'), { action: 'skip', reason: 'busy', text: '' });
  assert.equal(parseNaturalDecision('{"action":"reply","text":""}', { allowEmptyReply: true }).action, 'reply');
});

test('foundation conversation cold openings retract on fresh human activity and preserve the new message', () => {
  const f = fixture({ minMessages: 5, maxMessages: 5, fixedMessages: 5, natural: { ...emptyNaturalSettings(), timerEnabled: true, activeHours: false } });
  const selector = { accountId, chatType: 'group', peerId: room }, state = f.channel.natural.state(selector, f.state.config);
  enqueueNaturalReply(f.channel, { selector, config: f.state.config, state, trigger: 'timer' });
  assert.equal(f.channel.queue.length, 1);
  const value = f.receive('刚才有新消息了');
  assert.equal(f.channel.queue.length, 0); assert.equal(f.records[0].state, 'cancelled');
  assert.equal(f.history.at(-1).id, value.id); assert.equal(f.state.progress.count, 1);
});

test('foundation conversation cooldown diagnostics coalesce without dropping real message history', () => {
  const f = fixture();
  const selector = { accountId, chatType: 'group', peerId: room };
  f.state.natural = f.channel.natural.state(selector, f.state.config); f.state.natural.lastSentAt = f.now();
  f.receive('第一条真实消息'); f.receive('第二条真实消息');
  assert.equal(f.channel.queue.length, 0); assert.equal(f.history.length, 2);
  assert.equal(f.records.filter(row => row.key.startsWith('natural-skip:')).length, 1);
});

test('foundation conversation manual private and ordinary-group turns enter history but ACK echoes do not', () => {
  const f = fixture({ mode: 'default' });
  for (const chatType of ['private', 'group']) f.receive('人工接话', { chatType, senderId: accountId, direction: 'outgoing' });
  assert.equal(f.history.length, 2);
  f.receive('本机回声', { chatType: 'private', senderId: accountId, direction: 'outgoing', delivery: 'server-ack' });
  assert.equal(f.history.length, 2);
});

test('foundation conversation native work routing remains intact and ambient work replies are blocked', () => {
  const f = fixture({ executionMode: 'work', mode: 'natural', remoteEnabled: true, adminIds: ['alice'] });
  f.receive('/work 写一个脚本'); assert.equal(f.work.length, 1); assert.equal(f.work[0].workCommand.action, 'create');
  f.receive('继续处理这项工作'); assert.equal(f.work.length, 2); assert.equal(f.work[1].workRouting, true);
  assert.equal(f.channel.queue.length, 0);
  const selector = { accountId, chatType: 'group', peerId: room };
  enqueueNaturalReply(f.channel, { selector, config: f.state.config, state: emptyNaturalState(), trigger: 'timer' });
  assert.equal(f.channel.queue.length, 0); assert.equal(f.channel.natural.summary(selector), null);
  f.receive('/mode chat'); assert.equal(f.channel.queue[0].mode, 'mode-control');
});

test('foundation conversation scheduled authorization is independent while work results still use reply permissions', () => {
  const f = fixture({ mode: 'default' }); f.state.settings.enabled = false;
  const message = f.message('', { chatType: 'private' });
  const item = { record: { accountId, chatType: 'private', peerId: 'alice', createdAt: f.now() }, message, config: f.state.config, scheduled: { source: 'owner', kind: 'message' } };
  assert.doesNotThrow(() => WechatChannel.prototype.assertAllowed.call(f.channel, item));
  assert.throws(() => WechatChannel.prototype.assertAllowed.call(f.channel, { ...item, scheduled: { ...item.scheduled, workJobId: 'work-id' } }), { code: 'AUTH_CHANGED' });
  f.state.settings.schedules = false;
  assert.throws(() => WechatChannel.prototype.assertAllowed.call(f.channel, item), { code: 'AUTH_CHANGED' });
});

test('foundation conversation recovery queue persists a detached copy of original part indexes', async () => {
  const f = fixture({ mode: 'default' }), controller = new AbortController();
  const task = { id: 'recovery-task', accountId, chatType: 'private', peerId: 'alice', senderId: 'alice', senderName: '甲',
    recordKey: 'recovery-record', kind: 'message', content: '恢复第二段',
    recovery: { sourceKey: 'original-record', kinds: ['text'], partIndexes: [1, 3], plan: [{ index: 1, type: 'text', text: '恢复第二段' }] } };
  const pending = WechatChannel.prototype.submitScheduled.call(f.channel, task, controller.signal);
  const queued = f.channel.queue[0];
  assert.deepEqual(queued.record.recoveryPartIndexes, [1, 3]);
  assert.notEqual(queued.record.recoveryPartIndexes, task.recovery.partIndexes);
  assert.equal(queued.scheduled, task); assert.equal(queued.scheduled.recovery.plan, task.recovery.plan);
  queued.complete.resolve(queued.record); await pending;
});

test('foundation conversation reply pause keeps normal scheduled work but cancels work-result delivery', () => {
  const f = fixture({ mode: 'default' });
  const make = (key, scheduled) => ({ record: { key, accountId, chatType: 'private', peerId: 'alice' }, scheduled });
  const reminder = make('reminder', { kind: 'message' }), result = make('result', { workJobId: 'work-id' }), ordinary = make('ordinary');
  f.channel.queue = [reminder, result, ordinary]; f.channel.active = { ...reminder, controller: new AbortController() };
  WechatChannel.prototype.cancel.call(f.channel, '暂停回复', { accountId }, { resetProgress: false, keepScheduled: true });
  assert.deepEqual(f.channel.queue, [reminder]); assert.equal(f.channel.active.controller.signal.aborted, false);
  assert.equal(result.record.state, 'cancelled'); assert.equal(ordinary.record.state, 'cancelled');
});

test('foundation conversation switch-only settings skip global pause and retain explicit feature settings', async () => {
  const f = fixture(), pausedScopes = [];
  const context = { store: f.store, channel: f.channel, state: {}, currentAccount: () => ({ id: accountId }),
    assertLive() {}, status: () => f.state.settings, paused: async (_reason, action, scopes) => { pausedScopes.push(scopes); return action(); } };
  await settingsMutation(context, 'settings', { settings: { enabled: false } }, new AbortController().signal);
  assert.deepEqual(pausedScopes, [[]]); assert.equal(f.state.settings.schedules, true); assert.equal(f.state.settings.moments, true);
});

test('foundation conversation older settings clients retain work fields and do not acquire new timer permissions', async () => {
  for (const extra of [{ executionMode: 'work', workSenderIds: ['alice'], mode: 'default' }, { mode: 'participate' }]) {
    const f = fixture(extra);
    f.store.setConversationSettings = (_a, _c, _p, value) => { f.state.config = clone(value); };
    const context = { store: f.store, channel: f.channel, state: {}, currentAccount: () => ({ id: accountId }),
      conversation: () => ({ accountId, chatType: 'group', peerId: room }), assertLive() {}, status: () => f.state.config,
      paused: async (_reason, action) => action() };
    const requested = extra.mode === 'participate' ? { mode: 'natural', natural: { temperament: 'quiet' } } : { memoryMode: 'on-demand' };
    await settingsMutation(context, 'conversation.configure', { config: requested }, new AbortController().signal);
    assert.equal(f.state.config.executionMode, extra.executionMode || 'chat');
    if (extra.executionMode === 'work') assert.deepEqual(f.state.config.workSenderIds, ['alice']);
    assert.equal(f.state.config.natural.timerEnabled, false); assert.equal(f.state.config.natural.followupEnabled, false);
  }
});

test('foundation trace adapter adds unavailable/persona/split details without dropping native work history', () => {
  const record = { key: 'trace', accountId, state: 'partial', personaMode: 'high-precision', personaPasses: 2,
    workJobId: 'native-work', replyPlan: [{ index: 0, type: 'text', text: '正文' }] };
  assert.equal(recordType(record), 'work'); assert.equal(recordInput(record).workJobId, 'native-work');
  assert.equal(recordOutput(record).personaPasses, 2); assert.deepEqual(recordOutput(record).replyPlan, record.replyPlan);
  const job = { id: 'native-work', accountId, request: '原生工作', createdAt: 10, state: 'completed', delivery: { state: 'sent' }, operations: [{ tool: 'native-tool', result: { ok: true } }] };
  assert.equal(workSpec(job).type, 'work'); assert.equal(workState(job), 'completed');
  const history = historicalTraces({ store: { data: { records: [] } }, work: { store: { data: { jobs: [job] } } } });
  const rows = history.list(accountId, { startAt: 0, endAt: 100 }); assert.equal(rows[0].toolCalls, 1);
  assert.equal(history.get(accountId, rows[0].id).steps.length, 1);
});
