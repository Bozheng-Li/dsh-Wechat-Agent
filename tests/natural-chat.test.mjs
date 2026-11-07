import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelError, StateStore, WechatChannel, emptyNaturalSettings, validateNaturalSettings,
  parseNaturalDecision, withinNaturalHours, emptyNaturalState, validateNaturalState, createPluginService, rpcHandler } from '../lib/testing.js';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const owner = { id: 'wxid_natural_fixture', nickname: '微信本名' }, room = 'natural-a@chatroom', otherRoom = 'natural-b@chatroom';

function fixture(t, options = {}) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'natural-chat-'));
  const clock = { value: Date.parse('2026-11-07T04:00:00Z') };
  t.mock.method(Date, 'now', () => clock.value);
  const store = new StateStore(root), calls = [], sent = [], outputs = [], gates = [];
  const status = { online: true, account: { ...owner } };
  store.configure(owner.id, { enabled: true, privatePeers: ['alice'], groups: [room, otherRoom], prompt: '' });
  store.setPersona({ name: '小胖', aliases: ['胖胖'], prompt: '喜欢露营和音乐，友善，有分寸。' });
  const transport = { status: () => structuredClone(status), send: async params => {
    sent.push(params); return { delivery: 'server-ack', serverMessageIds: [`natural-ack-${sent.length}`] };
  } };
  const runner = { run: async input => {
    calls.push(input);
    await runner.before?.(input);
    input.signal.throwIfAborted();
    await input.onSession?.(`natural-session-${calls.length}`);
    const raw = input.naturalDecision ? outputs.shift() ?? JSON.stringify({ action: 'reply', text: '周末露营，可以试试湖边那种安静的地方。' }) : '先看看营地是否允许过夜。';
    return { text: input.selectReplyText ? input.selectReplyText(raw) : raw, sessionId: `natural-session-${calls.length}` };
  } };
  const channel = new WechatChannel({ store, transport, runner, now: () => clock.value, random: () => 0, ...options });
  const config = (peer = room, overrides = {}) => {
    const value = { mode: 'natural', intervalMode: 'fixed', fixedMessages: 3, minMessages: 3, maxMessages: 3, recordsPath: '',
      ...overrides, natural: { ...emptyNaturalSettings(), intervalMode: 'fixed', fixedMinutes: 5, minGapMinutes: 1,
        activeHours: false, followupSeconds: 0, ...overrides.natural } };
    return store.setConversationSettings(owner.id, 'group', peer, value);
  };
  config();
  let sequence = 0;
  const message = (text, extra = {}) => {
    const id = 'natural-in-' + ++sequence;
    return { id, serverMessageId: id, time: Math.floor(clock.value / 1000), direction: 'incoming', chatType: 'group',
      peerId: room, sender: { id: 'alice', nickname: '阿禾' }, message: [{ type: 'text', data: { text } }], ...extra };
  };
  const receive = value => channel.receive(value, owner.id);
  const records = () => store.recordsPage(owner.id, { chatType: 'group', peerId: room }).records;
  const state = () => store.naturalState(owner.id, 'group', room);
  const advance = async milliseconds => { clock.value += milliseconds; channel.natural.tick(); await channel.whenIdle(); };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await channel.close();
    const relative = path.relative(base, fs.realpathSync(root));
    assert(relative.startsWith('natural-chat-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, channel, transport, runner, status, calls, sent, outputs, clock, config, message, receive, records, state, advance, gates };
}

test('natural settings validate defaults, all numeric boundaries and overnight hours without changing legacy modes', () => {
  assert.deepEqual(validateNaturalSettings(), emptyNaturalSettings());
  for (const value of [{ minMinutes: 0 }, { maxMinutes: 1441 }, { minMinutes: 60, maxMinutes: 30 }, { fixedMinutes: 1.5 },
    { temperament: 'unrestricted' }, { intervalMode: 'seconds' }, { smartSkip: 'true' }, { activeHours: null },
    { followupSeconds: 601 }, { maxUnanswered: 0 }, { minGapMinutes: 0 }, { startTime: '9:00' }, { startTime: '09:00', endTime: '09:00' }])
    assert.throws(() => validateNaturalSettings(value), { code: 'INVALID_NATURAL_SETTINGS' });
  assert.equal(validateNaturalSettings({ activeHours: false, startTime: '09:00', endTime: '09:00', followupSeconds: 0 }).followupSeconds, 0);
  assert(withinNaturalHours(validateNaturalSettings({ startTime: '22:00', endTime: '06:00' }), Date.parse('2026-11-07T15:00:00Z')));
  assert(!withinNaturalHours(emptyNaturalSettings(), Date.parse('2026-11-07T15:00:00Z')));
  assert(withinNaturalHours(emptyNaturalSettings(), Date.parse('2026-11-07T01:00:00Z')));
  assert(!withinNaturalHours(emptyNaturalSettings(), Date.parse('2026-11-07T00:59:59Z')));
});

test('decision output rejects malformed, ambiguous or nonempty skip results before any sending', () => {
  assert.deepEqual(parseNaturalDecision('{"action":"skip","reason":"repeated","text":""}'), { action: 'skip', reason: 'repeated', text: '' });
  assert.equal(parseNaturalDecision('```json\n{"action":"reply","text":" 接上话题。 "}\n```').text, '接上话题。');
  assert.equal(parseNaturalDecision('<think>PRIVATE_REASONING</think>{"action":"reply","text":"自然接话。"}').text, '自然接话。');
  assert.throws(() => validateNaturalState({ ...emptyNaturalState(), nextCheckAt: Number.MAX_SAFE_INTEGER }), { code: 'INVALID_NATURAL_STATE' });
  for (const value of ['普通正文', '{}', '[]', '{"action":"skip","reason":"unknown","text":""}',
    '{"action":"skip","reason":"repeated","text":"偷偷发言"}', '{"action":"reply","text":""}']) assert.throws(() => parseNaturalDecision(value), { code: 'NATURAL_DECISION_INVALID' });
});

test('a complete long natural reply is delivered intact and its followup state remains valid across reload', async t => {
  const f = fixture(t); f.config(room, { natural: { followupSeconds: 120 } });
  const reply = '完整公式：x² + y² = 1。\n'.repeat(1000) + '结尾保留。';
  assert(reply.length > 12000);
  assert.equal(parseNaturalDecision(JSON.stringify({ action: 'reply', text: reply })).text, reply);
  f.channel.natural.tick();
  f.outputs.push(JSON.stringify({ action: 'reply', text: reply }));
  await f.advance(300000);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message.map(s => s.data.text || '').join(''), reply);
  assert.equal(f.records()[0].state, 'sent'); assert.equal(f.records()[0].reply, reply);
  assert(f.state().followup.reply.length <= 12000);
  assert.deepEqual(new StateStore(f.root).naturalState(owner.id, 'group', room), f.state());
});

test('fixed message count evaluates once, can stay quiet, and sends only the selected reply text', async t => {
  const f = fixture(t);
  f.outputs.push('{"action":"skip","reason":"repeated","text":""}');
  f.receive(f.message('今晚还是上次那个营地')); f.receive(f.message('讨论过了')); f.receive(f.message('已经定好了'));
  await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.records()[0].state, 'skipped'); assert.match(f.records()[0].reason, /相似话题/);
  assert.equal(f.state().unanswered, 0); assert.equal(f.state().lastSentAt, 0);
  for (const text of ['这次想换个营地', '想找湖边的', '大家有经验吗']) f.receive(f.message(text));
  await f.channel.whenIdle();
  assert.equal(f.calls.length, 2); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message[0].data.text, '周末露营，可以试试湖边那种安静的地方。');
  assert.equal(f.records()[0].state, 'sent'); assert.equal(f.state().unanswered, 1);
  assert.deepEqual(f.store.progress(owner.id, 'group', room), { count: 0, target: 3 });
});

test('timer works without new messages, backs off after no response and stops after two confirmed openings', async t => {
  const f = fixture(t); f.channel.natural.tick();
  const first = f.state().nextCheckAt;
  await f.advance(first - f.clock.value - 1); assert.equal(f.sent.length, 0);
  await f.advance(1); assert.equal(f.sent.length, 1); assert.equal(f.state().unanswered, 1);
  assert.equal(f.state().nextCheckAt - f.clock.value, 10 * 60000);
  await f.advance(10 * 60000); assert.equal(f.sent.length, 2); assert.equal(f.state().unanswered, 2);
  await f.advance(2 * 60 * 60000); assert.equal(f.calls.length, 2); assert.equal(f.sent.length, 2);
  assert.equal(f.channel.natural.summary({ accountId: owner.id, chatType: 'group', peerId: room }).paused, true);
  f.receive(f.message('湖边风大吗')); assert.equal(f.state().unanswered, 0);
  assert(f.state().nextCheckAt <= f.clock.value + 5 * 60000);
});

test('native mentions, nickname and commands bypass rest hours and cold opening cooldown', async t => {
  const f = fixture(t); f.clock.value = Date.parse('2026-11-07T15:00:00Z');
  f.config(room, { natural: { activeHours: true } });
  for (const text of ['普通消息一', '普通消息二', '普通消息三']) f.receive(f.message(text));
  await f.channel.whenIdle(); assert.equal(f.calls.length, 0); assert.match(f.records()[0].reason, /活跃时段/);
  f.receive(f.message('@微信本名\u2005 怎么选营地', { message: [{ type: 'at', data: { qq: owner.id } }, { type: 'text', data: { text: '@微信本名\u2005 怎么选营地' } }] }));
  f.receive(f.message('胖胖，看看路线')); f.receive(f.message('/agent 下雨怎么办'));
  await f.channel.whenIdle();
  assert.equal(f.sent.length, 3); assert.deepEqual(f.calls.map(call => call.mode), ['default', 'nickname', 'default']);
  assert.equal(f.state().unanswered, 0); assert.deepEqual(f.store.progress(owner.id, 'group', room), { count: 0, target: 3 });
});

test('system messages cannot wake the model or count as human feedback after unanswered openings', async t => {
  const f = fixture(t); f.channel.natural.tick(); await f.advance(5 * 60000); await f.advance(10 * 60000);
  assert.equal(f.state().unanswered, 2);
  f.receive(f.message('小胖加入群聊', { messageType: 10000 })); await f.channel.whenIdle();
  assert.equal(f.calls.length, 2); assert.equal(f.state().unanswered, 2); assert.match(f.records()[0].reason, /群系统消息/);
  assert.deepEqual(f.store.progress(owner.id, 'group', room), { count: 0, target: null });
});

test('followup evaluates only the current speaker, rejects a topic switch and has a fixed three-message window', async t => {
  const f = fixture(t); f.config(room, { fixedMessages: 100, minMessages: 100, maxMessages: 100, natural: { followupSeconds: 120 } });
  f.receive(f.message('小胖，过夜需要注意什么')); await f.channel.whenIdle();
  const until = f.state().followup.until;
  f.receive(f.message('其他人的新话题', { sender: { id: 'bob', nickname: '小林' } })); await f.channel.whenIdle(); assert.equal(f.calls.length, 1);
  f.outputs.push('{"action":"skip","reason":"no_followup","text":""}');
  f.receive(f.message('换个话题，今晚工作安排好了')); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.records()[0].naturalReason, 'no_followup');
  f.receive(f.message('那如果营地不允许过夜呢')); await f.channel.whenIdle();
  assert.equal(f.sent.length, 2); assert.equal(f.calls[2].naturalDecision.trigger, 'followup');
  assert(f.calls[2].text.includes('过夜需要注意什么')); assert.equal(f.state().followup.until, until);
  f.receive(f.message('还有什么要带')); await f.channel.whenIdle();
  assert.equal(f.state().followup.remaining, 0);
  f.receive(f.message('然后呢')); await f.channel.whenIdle(); assert.equal(f.calls.length, 4);
  await f.advance(121000); f.receive(f.message('又过了一会儿')); await f.channel.whenIdle(); assert.equal(f.calls.length, 4);
});

test('an opening can receive a related answer from the group without a new mention', async t => {
  const f = fixture(t); f.config(room, { fixedMessages: 100, minMessages: 100, maxMessages: 100, natural: { followupSeconds: 120 } });
  f.channel.natural.tick(); await f.advance(5 * 60000);
  f.receive(f.message('湖边那个我去过，挺安静', { sender: { id: 'bob', nickname: '小林' } })); await f.channel.whenIdle();
  assert.equal(f.sent.length, 2); assert.equal(f.calls[1].naturalDecision.trigger, 'followup');
  assert.equal(f.state().followup.senderId, 'bob');
});

test('time and count opportunities merge while queued and direct questions take priority', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.text === '占用模型') { reached.resolve(); await gate.promise; } };
  f.receive(f.message('占用模型', { chatType: 'private', peerId: 'alice' })); await reached.promise;
  for (const text of ['湖边露营', '想看日落', '大家有推荐吗']) f.receive(f.message(text));
  f.clock.value = f.state().nextCheckAt; f.channel.natural.tick();
  assert.equal(f.channel.summary().queued, 1); assert.equal(f.records()[0].batches, 2);
  assert.deepEqual(f.records()[0].naturalTriggers, ['count', 'timer']);
  f.receive(f.message('/agent 先回答这条', { peerId: otherRoom }));
  gate.resolve(); await f.channel.whenIdle();
  assert.deepEqual(f.sent.map(value => value.peerId), ['alice', otherRoom, room]);
  assert.equal(f.calls.filter(call => call.naturalDecision).length, 1);
});

test('a direct wake cancels generating ambient output before sending even if the model ignores abort', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.naturalDecision) { reached.resolve(); await gate.promise; } };
  for (const text of ['露营', '路线', '大家怎么选']) f.receive(f.message(text)); await reached.promise;
  f.receive(f.message('小胖，先看这个问题')); gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message[0].data.text, '先看看营地是否允许过夜。');
  assert.equal(f.records().find(record => record.naturalTrigger === 'count').state, 'cancelled');
  assert.equal(f.state().pendingKey, null);
});

test('new chat activity during ambient generation makes the old decision expire', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.naturalDecision) { reached.resolve(); await gate.promise; } };
  for (const text of ['露营', '路线', '大家怎么选']) f.receive(f.message(text)); await reached.promise;
  f.receive(f.message('刚才的计划取消了')); gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.records()[0].state, 'cancelled'); assert.match(f.records()[0].reason, /新消息/);
});

test('actual manual outgoing messages pause ambient talk while acknowledged agent echoes do not', async t => {
  const f = fixture(t); f.channel.natural.tick(); await f.advance(5 * 60000);
  const echoed = f.message('机器人自己发出的内容', { id: 'echo', serverMessageId: 'natural-ack-1', direction: 'outgoing', sender: owner, source: 'longlink:NewSync' });
  f.receive(echoed); assert.equal(f.state().lastManualAt, 0);
  const manual = f.message('这段我来接', { direction: 'outgoing', sender: owner, source: 'longlink:NewSync' });
  f.receive(manual); assert.equal(f.state().lastManualAt, f.clock.value); assert.equal(f.state().followup.remaining, 0);
  for (const text of ['新话题一', '新话题二', '新话题三']) f.receive(f.message(text));
  await f.channel.whenIdle(); assert.equal(f.sent.length, 1); assert.match(f.records()[0].reason, /人工接话/);
  f.receive(f.message('/agent 直接问你')); await f.channel.whenIdle(); assert.equal(f.sent.length, 2);
  assert(f.store.history(owner.id, 'group', room).some(entry => entry.direction === 'outgoing' && entry.text === '这段我来接'));
  f.receive(manual); assert.equal(f.store.history(owner.id, 'group', room).filter(entry => entry.text === '这段我来接').length, 1);
});

test('uncertain delivery pauses automatic talk and never increments confirmed speech counters', async t => {
  const f = fixture(t); f.transport.send = async () => ({ delivery: 'requested', serverMessageIds: [] });
  f.channel.natural.tick(); await f.advance(5 * 60000);
  assert.equal(f.records()[0].state, 'unknown'); assert.equal(f.state().unanswered, 0); assert.equal(f.state().lastSentAt, 0);
  assert.equal(f.state().deliveryBlockedKey, f.records()[0].key);
  await f.advance(60 * 60000); assert.equal(f.calls.length, 1);
  f.receive(f.message('有人重新发言')); await f.channel.whenIdle(); await f.advance(60 * 60000); assert.equal(f.calls.length, 1);
  assert.equal(f.channel.natural.summary({ accountId: owner.id, chatType: 'group', peerId: room }).paused, true);
});

test('malformed model output is recorded as failure with no group message', async t => {
  const f = fixture(t); f.outputs.push('这是没有经过判断的正文');
  for (const text of ['营地', '路线', '怎么选']) f.receive(f.message(text)); await f.channel.whenIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.records()[0].state, 'failed'); assert.equal(f.records()[0].errorCode, 'NATURAL_DECISION_INVALID');
});

test('partial acknowledgements block ambient retries and survive reload with their real receipt', async t => {
  const f = fixture(t); f.transport.send = async () => { throw new ChannelError('SEND_PARTIAL', '部分已发送', {
    delivery: 'partially-acknowledged', acknowledgedMessageIds: ['partial-natural-ack']
  }); };
  f.channel.natural.tick(); await f.advance(5 * 60000);
  assert.equal(f.records()[0].state, 'partial'); assert.deepEqual(f.records()[0].acknowledgedMessageIds, ['partial-natural-ack']);
  assert.equal(f.state().lastSentAt, 0); assert.equal(f.state().unanswered, 0);
  const reloaded = new StateStore(f.root); assert.equal(reloaded.naturalState(owner.id, 'group', room).deliveryBlockedKey, f.records()[0].key);
  await f.advance(60 * 60000); assert.equal(f.calls.length, 1);
});

test('a queued followup expires after its window without generating a delayed answer', async t => {
  const f = fixture(t); f.config(room, { fixedMessages: 100, minMessages: 100, maxMessages: 100, natural: { followupSeconds: 120 } });
  f.receive(f.message('小胖，怎么过夜')); await f.channel.whenIdle();
  const gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.text === '占用模型') { reached.resolve(); await gate.promise; } };
  f.receive(f.message('占用模型', { chatType: 'private', peerId: 'alice' })); await reached.promise;
  f.receive(f.message('那营地关门怎么办')); f.clock.value += 121000; gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.calls.filter(call => call.naturalDecision).length, 0);
  assert.match(f.records().find(record => record.naturalTrigger === 'followup').reason, /窗口已结束/);
});

test('disconnect keeps no-response feedback and recovery schedules a fresh opportunity', async t => {
  const f = fixture(t); f.channel.natural.tick(); await f.advance(5 * 60000);
  const sentAt = f.state().lastSentAt;
  f.channel.natural.disconnected(); f.channel.cancel('连接断开', undefined, { resetNatural: false });
  assert.equal(f.state().unanswered, 1); assert.equal(f.state().lastSentAt, sentAt);
  f.clock.value += 60 * 60000; f.channel.natural.tick(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.state().unanswered, 1); assert(f.state().nextCheckAt > f.clock.value);
});

test('offline, disabled, removed and other-account groups cannot generate or receive timer messages', async t => {
  const f = fixture(t); f.channel.natural.tick(); f.clock.value = f.state().nextCheckAt;
  f.status.online = false; f.channel.natural.tick(); await f.channel.whenIdle(); assert.equal(f.calls.length, 0);
  f.status.online = true; f.store.configure(owner.id, { ...f.store.settings(owner.id), enabled: false }); f.channel.natural.tick(); assert.equal(f.calls.length, 0);
  f.store.configure(owner.id, { ...f.store.settings(owner.id), enabled: true, groups: [otherRoom] }); f.channel.natural.tick(); assert.equal(f.calls.length, 0);
  f.status.account = { id: 'wxid_unconfigured', nickname: '其他账号' }; f.channel.natural.tick(); assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test('per-room timing, messages, persona and skip feedback stay isolated', async t => {
  const f = fixture(t); f.config(otherRoom, { natural: { fixedMinutes: 10, temperament: 'quiet' }, persona: { name: '小圆', aliases: [], prompt: '仅在 B 群讨论棋类。' } });
  f.channel.natural.tick();
  f.receive(f.message('A_ROOM_ONLY')); f.receive(f.message('B_ROOM_ONLY', { peerId: otherRoom }));
  f.receive(f.message('PRIVATE_ONLY', { chatType: 'private', peerId: 'alice' })); await f.channel.whenIdle();
  await f.advance(5 * 60000);
  const first = f.calls.find(call => call.naturalDecision);
  assert(first.memory.includes('A_ROOM_ONLY')); assert(!first.memory.includes('B_ROOM_ONLY')); assert(!first.memory.includes('PRIVATE_ONLY'));
  assert.equal(first.persona.name, '小胖');
  assert.equal(f.store.naturalState(owner.id, 'group', otherRoom).unanswered, 0);
  await f.advance(5 * 60000);
  const second = f.calls.filter(call => call.naturalDecision)[1]; assert.equal(second.persona.name, '小圆');
  assert.equal(second.naturalDecision.temperament, 'quiet'); assert(!second.memory.includes('A_ROOM_ONLY'));
});

test('normal restart retains counts and feedback while an overdue timer starts fresh without catch-up', async t => {
  const f = fixture(t); f.channel.natural.tick(); f.receive(f.message('第一条')); f.receive(f.message('第二条'));
  const savedNext = f.state().nextCheckAt; await f.channel.close(); f.clock.value = savedNext + 60 * 60000;
  const reloaded = new StateStore(f.root), next = new WechatChannel({ store: reloaded, runner: f.runner, transport: f.transport, now: () => f.clock.value, random: () => 0 });
  t.after(() => next.close()); next.natural.tick(); await next.whenIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(reloaded.naturalState(owner.id, 'group', room).nextCheckAt, f.clock.value + 5 * 60000);
  assert.deepEqual(reloaded.progress(owner.id, 'group', room), { count: 2, target: 3 });
  next.receive(f.message('重启后的第三条'), owner.id); await next.whenIdle(); assert.equal(f.sent.length, 1);
});

test('configuration changes during generation stop stale output and preserve authorization', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers(); f.gates.push(gate);
  f.runner.before = async input => { if (input.naturalDecision) { reached.resolve(); await gate.promise; } };
  for (const text of ['营地', '路线', '怎么选']) f.receive(f.message(text)); await reached.promise;
  f.config(room, { natural: { temperament: 'quiet' } }); gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.records()[0].state, 'cancelled'); assert.match(f.records()[0].reason, /设置已变更/);
  assert.equal(f.store.settings(owner.id).enabled, true);
});

test('changing participation character preserves the existing timer and message count; changing minutes schedules a fresh opportunity', async t => {
  const f = fixture(t), scope = { accountId: owner.id, chatType: 'group', peerId: room };
  const service = createPluginService({ root: f.root, store: f.store, channel: f.channel, runner: f.runner, worker: f.transport, ctx: {} });
  f.channel.natural.tick(); f.receive(f.message('第一条新消息'));
  const before = f.state(), progress = f.store.progress(owner.id, 'group', room); f.clock.value += 60000;
  let config = f.store.conversationSettings(owner.id, 'group', room);
  await service.call('conversation.configure', { ...scope, config: { ...config, natural: { ...config.natural, temperament: 'quiet' } } }, new AbortController().signal);
  assert.equal(f.state().nextCheckAt, before.nextCheckAt); assert.equal(f.state().humanRevision, before.humanRevision);
  assert.deepEqual(f.store.progress(owner.id, 'group', room), progress);
  config = f.store.conversationSettings(owner.id, 'group', room);
  await service.call('conversation.configure', { ...scope, config: { ...config, natural: { ...config.natural, fixedMinutes: 8 } } }, new AbortController().signal);
  assert.equal(f.state().nextCheckAt, f.clock.value + 8 * 60000); assert.deepEqual(f.store.progress(owner.id, 'group', room), progress);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('character changes, task cancellation and reply toggles preserve uncertain delivery until an explicit owner review', async t => {
  const f = fixture(t), scope = { accountId: owner.id, chatType: 'group', peerId: room };
  const service = createPluginService({ root: f.root, store: f.store, channel: f.channel, runner: f.runner, worker: f.transport, ctx: {} });
  f.transport.send = async () => ({ delivery: 'requested', serverMessageIds: [] });
  f.channel.natural.tick(); await f.advance(5 * 60000);
  const blockedKey = f.state().deliveryBlockedKey, before = f.state();
  const config = f.store.conversationSettings(owner.id, 'group', room);
  await service.call('conversation.configure', { ...scope, config: { ...config, natural: { ...config.natural, temperament: 'lively' } } }, new AbortController().signal);
  assert.equal(f.state().deliveryBlockedKey, blockedKey); assert.equal(f.state().nextCheckAt, before.nextCheckAt);
  await service.call('cancel', scope, new AbortController().signal); assert.equal(f.state().deliveryBlockedKey, blockedKey);
  const settings = f.store.settings(owner.id);
  await service.call('settings', { accountId: owner.id, settings: { ...settings, enabled: false } }, new AbortController().signal);
  await service.call('settings', { accountId: owner.id, settings }, new AbortController().signal);
  assert.equal(f.state().deliveryBlockedKey, blockedKey); await f.advance(60 * 60000); assert.equal(f.calls.length, 1);
  const rpc = rpcHandler(service), invoke = (input, kind = 'owner') => rpc('natural.resume', { ...scope, blockedKey, ...input }, new AbortController().signal, { principal: { kind } });
  assert.equal((await invoke({ confirmReviewed: true }, 'peer')).error.code, 'OWNER_REQUIRED');
  assert.equal((await invoke({})).error.code, 'NATURAL_CONFIRM_REQUIRED');
  assert.equal((await invoke({ confirmReviewed: true, blockedKey: 'stale' })).error.code, 'NATURAL_CHANGED');
  const save = t.mock.method(f.store, 'save', () => { throw new ChannelError('STATE_WRITE_FAILED', '合成保存失败'); });
  assert.equal((await invoke({ confirmReviewed: true })).error.code, 'STATE_WRITE_FAILED'); save.mock.restore();
  assert.equal(f.state().deliveryBlockedKey, blockedKey, 'a failed resume must remain blocked in memory and on disk');
  assert.equal(new StateStore(f.root).naturalState(owner.id, 'group', room).deliveryBlockedKey, blockedKey);
  assert.equal((await invoke({ confirmReviewed: true })).ok, true);
  assert.equal(f.state().deliveryBlockedKey, null); assert.equal(f.state().nextCheckAt, f.clock.value + 5 * 60000);
  assert.equal(f.calls.length, 1); assert.equal(f.records().find(record => record.key === blockedKey).state, 'unknown');
});

test('count checks blocked by the shared cooldown do not repeatedly postpone the timer', async t => {
  const f = fixture(t); f.config(room, { fixedMessages: 1, minMessages: 1, maxMessages: 1, natural: { minGapMinutes: 10 } });
  f.receive(f.message('小胖，先看看营地')); await f.channel.whenIdle();
  const due = f.state().nextCheckAt;
  f.clock.value += 60000; f.receive(f.message('普通新话题一')); await f.channel.whenIdle();
  assert.equal(f.state().nextCheckAt, due);
  f.clock.value += 60000; f.receive(f.message('普通新话题二')); await f.channel.whenIdle();
  assert.equal(f.state().nextCheckAt, due); assert.equal(f.calls.length, 1);
  assert.match(f.records()[0].reason, /刚刚已经发言/);
});

test('an unrelated followup skip neither increases cold-opening backoff nor shifts the independent timer', async t => {
  const f = fixture(t); f.config(room, { fixedMessages: 100, minMessages: 100, maxMessages: 100, natural: { followupSeconds: 120 } });
  f.receive(f.message('小胖，怎么选营地')); await f.channel.whenIdle();
  const due = f.state().nextCheckAt; f.clock.value += 10000;
  f.outputs.push('{"action":"skip","reason":"no_followup","text":""}');
  f.receive(f.message('接下来跟小林聊电影')); await f.channel.whenIdle();
  assert.equal(f.calls[1].naturalDecision.trigger, 'followup'); assert.equal(f.state().nextCheckAt, due);
  assert.equal(f.state().backoff, 0); assert.equal(f.sent.length, 1);
});
