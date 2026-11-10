import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { rolldown } from 'rolldown';

// Compile an isolated source bundle. These fixtures never use the installed worker,
// real account storage, or a network transport, and do not rebuild lib/.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = ['modules/tasks/scheduler.mjs', 'modules/tasks/conversation-tools.mjs', 'shared/contracts.mjs', 'backend/wechat/protocol/backend.ts', 'backend/wechat/protocol/wire.ts', 'backend/wechat/types.ts']
  .map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n');
const bundle = await rolldown({ input: 'virtual:task-mentions', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') } }, plugins: [{ name: 'task-mentions', resolveId: id => id === 'virtual:task-mentions' ? id : null, load: id => id === 'virtual:task-mentions' ? entry : null }] });
let api;
const bundleParent = path.join(root, 'storage/tmp');
fs.mkdirSync(bundleParent, { recursive: true });
const bundleDirectory = fs.mkdtempSync(path.join(bundleParent, 'task-mentions-'));
after(() => {
  assert.equal(path.dirname(fs.realpathSync(bundleDirectory)), fs.realpathSync(bundleParent));
  assert.match(path.basename(bundleDirectory), /^task-mentions-/);
  fs.rmSync(bundleDirectory, { recursive: true, force: true });
});
try {
  const { output } = await bundle.generate({ format: 'esm' });
  assert.equal(output.length, 1);
  const file = path.join(bundleDirectory, 'api.mjs');
  fs.writeFileSync(file, output[0].code);
  api = await import(pathToFileURL(file).href);
}
finally { await bundle.close(); }
const { TaskScheduler, simpleReminder, conversationTaskTool, ChannelError, ProtocolBackend, sendRequest, fields, bytes, num, unstring, fv, ld, segments } = api;
const owner = 'wxid_task_owner', room = 'task-members@chatroom', other = 'task-other@chatroom';
const at = (id, name) => ({ type: 'at', data: { qq: id, ...(name ? { name } : {}) } });
const text = value => ({ type: 'text', data: { text: value } });
const message = (...parts) => ({ chatType: 'group', peerId: room, message: parts });
const member = (id, name, groupId = room, extras = {}) => ({ id, groupId, name, nickname: name, role: 'member', ...extras });
function temporary() {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'wechat-task-mentions-'));
  return { dir, remove() { assert.equal(path.dirname(fs.realpathSync(dir)), parent); assert.match(path.basename(dir), /^wechat-task-mentions-/); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function schedulerFixture(t) {
  const temp = temporary(), current = { online: true, account: { id: owner } }, calls = [], sent = [];
  let now = Date.parse('2026-11-06T06:00:00Z');
  const groups = new Map([[room, [member('alice', '阿禾', room, { card: '产品·阿禾', remark: 'Alice' }), member('bob', '小林')]], [other, [member('other-alice', '阿禾', other)]]]);
  const settings = { enabled: true, groups: [room, other], privatePeers: ['alice'] };
  const store = { root: temp.dir, data: { storeId: 'isolated-mention-store', records: [] }, settings: () => settings,
    conversationSettings: () => ({ allowChatTasks: true }), conversations: () => [{ chatType: 'group', peerId: room, name: '产品组' }, { chatType: 'group', peerId: other, name: '另一群' }] };
  const transport = { status: () => structuredClone(current), call: async (op, args, options) => {
    calls.push({ op, args, options }); assert.equal(op, 'members'); assert.equal(args.accountId, current.account.id);
    return { accountId: args.accountId, peerId: args.peerId, members: structuredClone(groups.get(args.peerId) || []), scope: 'protocol-observed-only' };
  } };
  const channel = { transport, pauses: new Map(), submitScheduled: async (task, signal) => {
    const targets = await scheduler.resolveTargets(task.targets, task, signal); sent.push({ task, targets });
    return { state: 'sent', acknowledgedMessageIds: ['fixture-task-ack'] };
  } };
  const scheduler = new TaskScheduler({ store, channel, now: () => now });
  const scope = { accountId: owner, chatType: 'group', peerId: room, source: 'chat', senderId: 'alice', senderName: '过时的发言者昵称' };
  const input = targets => ({ kind: 'message', content: '喝水', schedule: { kind: 'once', at: now + 60000 }, ...(targets === undefined ? {} : { targets }) });
  t.after(async () => { await scheduler.close(); temp.remove(); });
  return { ...temp, store, scheduler, channel, transport, scope, current, calls, sent, groups, settings, input, now: () => now, advance: ms => { now += ms; } };
}

test('names resolve uniquely within the selected group and persist stable member IDs with verified display names', async t => {
  const f = schedulerFixture(t), signal = new AbortController().signal;
  const targets = await f.scheduler.resolveTargets(['阿禾', '林', 'ALICE'], f.scope, signal);
  assert.deepEqual(targets, [{ id: 'alice', name: '产品·阿禾' }, { id: 'bob', name: '小林' }]);
  assert.equal(f.calls[0].options.signal, signal);
  assert.deepEqual(f.calls[0].args, { accountId: owner, peerId: room });
  const task = f.scheduler.create(f.input(targets), f.scope);
  const restored = new TaskScheduler({ store: f.store, channel: f.channel, now: f.now });
  assert.deepEqual(restored.list(owner).tasks[0].targets, targets);
  f.groups.get(room)[0].card = '阿禾的新群昵称';
  assert.deepEqual(await restored.resolveTargets(task.targets, f.scope), [{ id: 'alice', name: '阿禾的新群昵称' }, { id: 'bob', name: '小林' }]);
  assert.deepEqual(await restored.resolveTargets(['阿禾'], { ...f.scope, peerId: other }), [{ id: 'other-alice', name: '阿禾' }]);
});

test('an exact name wins over substrings, but duplicate exact names and ambiguous nicknames never guess', async t => {
  const f = schedulerFixture(t);
  f.groups.set(room, [member('one', '小林'), member('two', '小林同学'), member('three', '阿禾'), member('four', '阿禾')]);
  assert.deepEqual(await f.scheduler.resolveTargets(['小林'], f.scope), [{ id: 'one', name: '小林' }]);
  await assert.rejects(f.scheduler.resolveTargets(['林'], f.scope), error => error.code === 'TASK_TARGET_AMBIGUOUS' && error.details.candidates.length === 2);
  await assert.rejects(f.scheduler.resolveTargets(['阿禾'], f.scope), { code: 'TASK_TARGET_AMBIGUOUS' });
  assert.deepEqual(await f.scheduler.resolveTargets([{ id: 'four', name: '不可信的名称' }], f.scope), [{ id: 'four', name: '阿禾' }]);
  assert.equal(f.scheduler.list(owner).tasks.length, 0);
});

test('member resolution rejects account, conversation and authorization mismatches without borrowing names', async t => {
  const f = schedulerFixture(t);
  await assert.rejects(f.scheduler.resolveTargets([{ id: 'other-alice' }], f.scope), { code: 'TASK_TARGET_NOT_FOUND' });
  f.transport.call = async () => ({ accountId: 'another-account', peerId: room, members: [member('foreign', '阿禾')] });
  await assert.rejects(f.scheduler.resolveTargets(['阿禾'], f.scope), { code: 'TASK_MEMBERS_UNAVAILABLE' });
  f.transport.call = async () => ({ accountId: owner, peerId: other, members: [member('foreign', '阿禾', other)] });
  await assert.rejects(f.scheduler.resolveTargets(['阿禾'], f.scope), { code: 'TASK_MEMBERS_UNAVAILABLE' });
  f.transport.call = async () => ({ accountId: owner, peerId: room, members: [member('foreign', '阿禾', other)] });
  await assert.rejects(f.scheduler.resolveTargets(['阿禾'], f.scope), { code: 'TASK_TARGET_NOT_FOUND' });
  f.current.account.id = 'another-account';
  await assert.rejects(f.scheduler.resolveTargets(['阿禾'], f.scope), { code: 'ACCOUNT_CHANGED' });
  f.current.account.id = owner; f.settings.groups = [other];
  await assert.rejects(f.scheduler.resolveTargets(['阿禾'], f.scope), { code: 'TASK_NOT_AUTHORIZED' });
});

test('an account switch or cancellation during member lookup cannot create a stale target', async t => {
  const f = schedulerFixture(t), gate = Promise.withResolvers(), cancel = new AbortController();
  f.transport.call = async () => gate.promise;
  const pending = f.scheduler.resolveTargets(['阿禾'], f.scope);
  f.current.account.id = 'changed-account';
  gate.resolve({ accountId: owner, peerId: room, members: [member('alice', '阿禾')] });
  await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
  f.current.account.id = owner;
  const cancelled = f.scheduler.resolveTargets(['阿禾'], f.scope, cancel.signal);
  cancel.abort(new ChannelError('CANCELLED', 'fixture cancellation'));
  await assert.rejects(cancelled, { code: 'CANCELLED' });
});

test('legacy tasks need no member lookup, while malformed, private and all-member targets are rejected', async t => {
  const f = schedulerFixture(t), plain = f.scheduler.create(f.input(), f.scope);
  assert.deepEqual(plain.targets, []); assert.deepEqual(await f.scheduler.resolveTargets([], f.scope), []); assert.equal(f.calls.length, 0);
  const file = path.join(f.dir, 'storage/tasks/schedules.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.tasks[0].targets; fs.writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(new TaskScheduler({ store: f.store, channel: f.channel, now: f.now }).list(owner).tasks[0].targets, []);
  for (const targets of [null, ['all'], ['@所有人'], [{ id: 'notify@all' }], [{ id: other }], Array.from({ length: 21 }, () => '阿禾')])
    await assert.rejects(f.scheduler.resolveTargets(targets, f.scope), { code: 'INVALID_TASK_TARGET' });
  await assert.rejects(f.scheduler.resolveTargets(['阿禾'], { ...f.scope, chatType: 'private', peerId: 'alice' }), { code: 'TASK_TARGET_GROUP_ONLY' });
  assert.throws(() => f.scheduler.create(f.input([{ id: 'alice' }]), f.scope), { code: 'INVALID_TASK_TARGET' });
  saved.tasks[0].targets = [{ id: 'notify@all', name: '全体成员' }]; fs.writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => new TaskScheduler({ store: f.store, channel: f.channel, now: f.now }), { code: 'TASKS_INVALID' });
});

test('task idempotency includes target IDs, survives renaming and remains account and conversation bound', t => {
  const f = schedulerFixture(t), scope = { ...f.scope, requestKey: 'same-request' };
  const first = f.scheduler.create(f.input([{ id: 'alice', name: '阿禾' }]), scope);
  assert.equal(f.scheduler.create(f.input([{ id: 'alice', name: '新的群昵称' }]), scope).id, first.id);
  assert.notEqual(f.scheduler.create(f.input([{ id: 'bob', name: '小林' }]), scope).id, first.id);
  assert.notEqual(f.scheduler.create(f.input([{ id: 'alice', name: '阿禾' }]), { ...scope, accountId: 'other-account' }).id, first.id);
  assert.notEqual(f.scheduler.create(f.input([{ id: 'alice', name: '阿禾' }]), { ...scope, peerId: other }).id, first.id);
  f.advance(120000);
  const original = { kind: first.kind, content: first.content, schedule: first.schedule, targets: first.targets };
  assert.equal(f.scheduler.create(original, scope).id, first.id);
});

test('a missing member retains the reminder for delayed retry with a clear failed result and no plain-message fallback', async t => {
  const f = schedulerFixture(t), targets = await f.scheduler.resolveTargets(['阿禾'], f.scope);
  f.scheduler.create(f.input(targets), f.scope); f.groups.set(room, []); f.advance(60000);
  await f.scheduler.tick();
  const { tasks, runs } = f.scheduler.list(owner);
  assert.equal(tasks[0].state, 'pending'); assert.equal(tasks[0].lastState, 'failed'); assert.match(tasks[0].lastError, /提醒对象.*名单/);
  assert.equal(runs[0].state, 'failed'); assert.deepEqual(runs[0].acknowledgedMessageIds, []); assert.equal(f.sent.length, 0);
  await f.scheduler.tick(); assert.equal(f.scheduler.list(owner).runs.length, 1);
  f.groups.set(room, [member('alice', '阿禾')]); f.advance(60000); await f.scheduler.tick(); assert.equal(f.sent.length, 1);
});

const execute = async (tool, args, signal = new AbortController().signal) => JSON.parse(await tool.execute(args, { signal }));
test('chat remind-me defaults to the true sender, explicit names support multiple recipients, and tool results report them', async t => {
  const f = schedulerFixture(t), args = { action: 'create', content: '喝水', delaySeconds: 60 };
  const result = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, '一分钟后提醒我喝水'), args);
  assert.equal(result.ok, true); assert.deepEqual(result.task.targets, [{ id: 'alice', name: '产品·阿禾' }]);
  const multiple = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, '一分钟后提醒阿禾和小林喝水'), { ...args, targetNames: ['阿禾', '小林'] });
  assert.equal(multiple.ok, true); assert.deepEqual(multiple.task.targets.map(target => target.id), ['alice', 'bob']);
  const privateResult = await execute(conversationTaskTool(f.scheduler, { ...f.scope, chatType: 'private', peerId: 'alice' }, () => {}, '一分钟后提醒我喝水'), args);
  assert.equal(privateResult.ok, true); assert.deepEqual(privateResult.task.targets, []);
});

test('chat name ambiguity requires a real incoming mention, and mentioning the assistant never selects it', async t => {
  const f = schedulerFixture(t), args = { action: 'create', content: '喝水', delaySeconds: 60, targetNames: ['阿禾'] };
  f.groups.set(room, [member('alice', '阿禾'), member('duplicate', '阿禾')]);
  const scope = { ...f.scope, incomingMentions: [{ id: owner, name: '助手' }] };
  const ambiguous = await execute(conversationTaskTool(f.scheduler, scope, () => {}, '一分钟后提醒阿禾喝水'), args);
  assert.equal(ambiguous.ok, false); assert.equal(ambiguous.code, 'TASK_TARGET_AMBIGUOUS'); assert.equal(f.scheduler.list(owner).tasks.length, 0);
  const result = await execute(conversationTaskTool(f.scheduler, { ...scope, incomingMentions: [owner, 'duplicate'] }, () => {}, '一分钟后提醒 @阿禾 喝水'), args);
  assert.equal(result.ok, true); assert.deepEqual(result.task.targets, [{ id: 'duplicate', name: '阿禾' }]);
});

test('chat cannot silently omit a named target, borrow a name from history, or create from translation and quotes', async t => {
  const f = schedulerFixture(t), args = { action: 'create', content: '喝水', delaySeconds: 60 };
  const missing = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, '一分钟后提醒小林喝水'), args);
  assert.equal(missing.ok, false); assert.equal(missing.code, 'TASK_TARGET_REQUIRED');
  const invented = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, '一分钟后发一条喝水消息'), { ...args, targetNames: ['小林'] });
  assert.equal(invented.ok, false); assert.equal(invented.code, 'TASK_TARGET_REQUEST_REQUIRED');
  for (const request of ['请翻译“一分钟后提醒我喝水”', '请翻译一分钟后提醒阿禾喝水', '> 一分钟后提醒阿禾喝水', '如果我说一分钟后提醒阿禾喝水会怎样', '不要帮我设置一分钟后的提醒']) {
    const result = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, request), { ...args, targetNames: ['阿禾'] });
    assert.equal(result.ok, false, request); assert.equal(result.code, 'TASK_REQUEST_REQUIRED');
  }
  assert.equal(f.scheduler.list(owner).tasks.length, 0);
});

test('quick reminders preserve plural audience and route combined recipients to explicit name selection', async t => {
  const f = schedulerFixture(t), args = { action: 'create', content: '喝水', delaySeconds: 60 };
  assert.equal(simpleReminder('一分钟后提醒我们喝水', [], f.now()).audience, 'everyone');
  assert.equal(simpleReminder('一分钟后提醒我和小林喝水', [], f.now()), null);
  assert.equal(simpleReminder('一分钟后提醒我 和小林喝水', [], f.now()), null);
  assert.equal(simpleReminder('一分钟后提醒我跟进客户', [], f.now()).audience, 'sender');
  const missing = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, '一分钟后提醒我和小林喝水'), args);
  assert.equal(missing.code, 'TASK_TARGET_REQUIRED');
  const onlySelf = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, '一分钟后提醒我和小林喝水'), { ...args, targetNames: ['我'] });
  assert.equal(onlySelf.code, 'TASK_TARGET_REQUIRED');
  const combined = await execute(conversationTaskTool(f.scheduler, f.scope, () => {}, '一分钟后提醒我和小林喝水'), { ...args, targetNames: ['小林'] });
  assert.equal(combined.ok, true); assert.deepEqual(combined.task.targets.map(target => target.id), ['alice', 'bob']);
  const everyone = await execute(conversationTaskTool(f.scheduler, { ...f.scope, incomingMentions: ['unrelated'] }, () => {}, '一分钟后提醒大家喝水'), args);
  assert.equal(everyone.ok, true); assert.deepEqual(everyone.task.targets, []);
  const justMe = await execute(conversationTaskTool(f.scheduler, { ...f.scope, incomingMentions: ['unrelated'] }, () => {}, '一分钟后提醒我喝水'), { ...args, targetNames: ['我'] });
  assert.equal(justMe.ok, true); assert.deepEqual(justMe.task.targets.map(target => target.id), ['alice']);
});

function textAck(body, id = '9007199254740901', overrides = {}) {
  const f = fields(bytes(fields(body), 2));
  const reply = { ret: 0, f4: num(f, 5), f5: num(f, 4), id, ...overrides };
  return Buffer.concat([ld(1, fv(1, reply.ret)), fv(2, 1), ld(3, Buffer.concat([fv(4, reply.f4), fv(5, reply.f5), fv(6, 1700000000), ...(reply.id ? [fv(8, BigInt(reply.id))] : [])]))]);
}
function imageAck(body, id = '9007199254740999') {
  const f = fields(body), start = Number(num(f, 6)), length = Number(num(f, 7));
  return Buffer.concat([ld(1, fv(1, 0)), ld(3, bytes(f, 2)), ld(4, bytes(f, 3)), ld(5, bytes(f, 4)), fv(6, num(f, 5)), fv(7, start + length), fv(8, length), fv(9, 1700000000), fv(10, BigInt(id))]);
}
function protocolFixture(t, respond = (cmd, body, index) => cmd === 110 ? imageAck(body) : textAck(body, String(9007199254740900n + BigInt(index)))) {
  const temp = temporary(), sessionFile = path.join(temp.dir, 'session.json'), cacheDir = path.join(temp.dir, 'cache');
  fs.writeFileSync(sessionFile, JSON.stringify({ uin: 123, token: 'aa'.repeat(15), wxid: owner, nickname: '测试账号', sync_key: fv(1, 0).toString('hex'), heartbeat_base_request: Buffer.concat([ld(1, 'fixture-session'), fv(2, 123)]).toString('hex') }));
  const backend = new ProtocolBackend({ sessionFile, cacheDir, syncIntervalMs: 60000, heartbeatIntervalMs: 60000, requestTimeoutMs: 1000, reconnectMs: 1000, sendIntervalMs: 0, sendJitterMs: 0, segmentBytes: 64 });
  const calls = [], events = []; backend.controller = new AbortController(); backend.online = true;
  backend.cache.members = [member('alice', '阿禾', room, { card: '群中阿禾' }), member('bob', '小林'), member('foreign', '另一群成员', other)];
  backend.transport = { connected: true, tx: 0, rx: 0, request: async (cmd, body) => { calls.push({ cmd, body }); return respond(cmd, body, calls.length, backend); }, close() { this.connected = false; } };
  backend.subscribe(event => { if (event.type === 'event.message') events.push(event.payload); });
  t.after(async () => { await backend.close(); temp.remove(); });
  return { backend, calls, events };
}
const sentText = call => bytes(fields(bytes(fields(call.body), 2)), 2).toString();
const sentSource = call => bytes(fields(bytes(fields(call.body), 2)), 6).toString();

test('SendMsg msgsource carries an exact, deduplicated native atuserlist and never accepts private or all-member mentions', () => {
  const request = sendRequest(room, '@阿禾\u2005喝水', ['alice', 'bob', 'alice']);
  const body = fields(bytes(fields(request.body), 2));
  assert.equal(unstring(bytes(body, 1)), room);
  assert.match(bytes(body, 6).toString(), /<atuserlist><!\[CDATA\[alice,bob\]\]><\/atuserlist>/);
  assert(!bytes(fields(bytes(fields(sendRequest(room, '普通消息').body), 2)), 6).toString().includes('atuserlist'));
  for (const targets of [['all'], ['notify@all'], ['a,b'], ['evil]]>'], [other]]) assert.throws(() => sendRequest(room, 'test', targets), { code: 'ERR_INVALID_PARAMS' });
  assert.throws(() => sendRequest('alice', 'test', ['alice']), { code: 'ERR_INVALID_PARAMS' });
  assert.deepEqual(segments([at('alice', '阿禾')]), [at('alice', '阿禾')]);
});

test('only the first text segment carries native mentions and verified display names, with unchanged server ACK evidence', async t => {
  const f = protocolFixture(t), content = '现在该喝水了。'.repeat(24);
  const sent = await f.backend.sendMessage(message(at('alice', '伪造昵称'), text(content), at('bob'), at('alice')));
  assert(f.calls.length > 2); assert(f.calls.every(call => call.cmd === 522));
  assert.match(sentSource(f.calls[0]), /CDATA\[alice,bob\]/);
  assert(f.calls.slice(1).every(call => !sentSource(call).includes('atuserlist')));
  const full = f.calls.map(sentText).join('');
  assert.equal(full, '@群中阿禾\u2005@小林\u2005' + content); assert(!full.includes('伪造昵称'));
  assert(f.calls.every(call => Buffer.byteLength(sentText(call)) <= 64));
  assert.deepEqual(sent.message.filter(part => part.type === 'at'), [at('alice', '群中阿禾'), at('bob', '小林')]);
  assert(f.events.slice(1).every(event => !event.message.some(part => part.type === 'at')));
  assert.equal(sent.delivery, 'server-ack'); assert.equal(sent.serverMessageIds.length, f.calls.length);
});

test('unknown, other-room, private, invalid and all-member mentions reject the whole reply before dispatch', async t => {
  const f = protocolFixture(t);
  for (const id of ['missing', 'foreign', 'all', 'notify@all', 'other@chatroom', 'bad<id'])
    await assert.rejects(async () => f.backend.sendMessage(message(text('must not send'), at(id))), error => error.code === 'ERR_MENTION_TARGET' && error.details.delivery === 'rejected');
  await assert.rejects(async () => f.backend.sendMessage({ chatType: 'private', peerId: 'alice', message: [text('must not send'), at('alice')] }), { code: 'ERR_MENTION_TARGET' });
  assert.equal(f.calls.length, 0);
});

test('queued mentions recheck membership and current display names before any native mention is dispatched', async t => {
  const gate = Promise.withResolvers(), reached = Promise.withResolvers();
  const f = protocolFixture(t, async (_cmd, body, index) => { if (index === 1) { reached.resolve(); await gate.promise; } return textAck(body, String(9007199254740900n + BigInt(index))); });
  const first = f.backend.sendMessage(message(text('前一条消息')));
  const missing = f.backend.sendMessage(message(at('bob'), text('不能降级发送')));
  const changedName = f.backend.sendMessage(message(at('alice'), text('姓名应更新')));
  const rejected = assert.rejects(missing, error => error.code === 'ERR_MENTION_TARGET' && error.details.delivery === 'rejected' && error.details.acknowledgedMessageIds.length === 0);
  await reached.promise;
  f.backend.cache.members = f.backend.cache.members.filter(member => member.id !== 'bob'); f.backend.cache.members[0].card = '现在的阿禾';
  gate.resolve(); await first; await rejected; await changedName;
  assert.equal(f.calls.length, 2); assert.match(sentText(f.calls[1]), /^@现在的阿禾\u2005/); assert(!f.calls.map(sentText).join('').includes('不能降级发送'));
});

test('an account change in the send queue is rejected even if the new account has identically named members', async t => {
  const gate = Promise.withResolvers(), reached = Promise.withResolvers();
  const f = protocolFixture(t, async (_cmd, body, index) => { if (index === 1) { reached.resolve(); await gate.promise; } return textAck(body); });
  const first = f.backend.sendMessage(message(text('first'))), second = f.backend.sendMessage(message(at('alice'), text('not for another account')));
  const rejected = assert.rejects(second, error => error.code === 'ERR_MENTION_TARGET' && error.details.delivery === 'rejected');
  await reached.promise; gate.resolve(); await first;
  f.backend.session.value.wxid = 'new-account'; f.backend.cache.account = '123-new-account';
  await rejected; assert.equal(f.calls.length, 1);
});

test('an image-only reminder sends a real mention text message first and keeps image ACK semantics intact', async t => {
  const f = protocolFixture(t), png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1cAAAAASUVORK5CYII=';
  const sent = await f.backend.sendMessage(message(at('alice'), { type: 'image', data: { base64: png, mediaType: 'image/png' } }));
  assert.deepEqual(f.calls.map(call => call.cmd), [522, 110]); assert.equal(sentText(f.calls[0]), '@群中阿禾\u2005');
  assert.match(sentSource(f.calls[0]), /atuserlist/); assert(!bytes(fields(f.calls[1].body), 10).toString().includes('atuserlist'));
  assert.equal(sent.serverMessageIds.length, 2); assert.equal(f.events[1].messageType, 3); assert.equal(f.events[1].delivery, 'server-ack');
});

test('a mismatched mention ACK stays unknown and a later failure preserves the first genuine ACK without repeating mentions', async t => {
  const invalid = protocolFixture(t, (_cmd, body) => textAck(body, undefined, { id: undefined }));
  await assert.rejects(async () => invalid.backend.sendMessage(message(at('alice'), text('喝水'))), error => error.code === 'ERR_PROTOCOL' && error.details.delivery === 'unknown' && error.details.acknowledgedMessageIds.length === 0);
  assert.equal(invalid.calls.length, 1); assert.equal(invalid.events.length, 0);
  const partial = protocolFixture(t, (_cmd, body, index) => index === 1 ? textAck(body) : textAck(body, undefined, { f4: 1n }));
  await assert.rejects(async () => partial.backend.sendMessage(message(at('alice'), text('后续文字'.repeat(80)))), error => error.details.delivery === 'partially-acknowledged' && error.details.acknowledgedMessageIds[0] === '9007199254740901');
  assert.equal(partial.calls.length, 2); assert.equal(partial.events.length, 1); assert(!sentSource(partial.calls[1]).includes('atuserlist'));
});

test('cancellation while a native mention request is in flight preserves its actual server ACK', async t => {
  const cancel = new AbortController();
  const f = protocolFixture(t, (_cmd, body) => { cancel.abort(); return textAck(body); });
  const sent = await f.backend.sendMessage(message(at('alice'), text('喝水')), cancel.signal);
  assert.equal(sent.delivery, 'server-ack'); assert.deepEqual(sent.serverMessageIds, ['9007199254740901']); assert.equal(f.calls.length, 1);
});

const workerMocks = {
  './protocol/backend.ts': `export class ProtocolBackend {
    constructor() { this.session = { value: { wxid: '${owner}', uin: 123 } }; this.reads = 0; }
    status() { return { online: true, diagnostics: { account: { id: this.session.value.wxid }, received: this.reads } }; }
    subscribe() {}
    async call(action, params) { if (action !== 'action.get_group_member_list') throw new Error('unexpected action'); this.reads++;
      if (params.groupId === 'switch@chatroom') { await Promise.resolve(); this.session.value = { wxid: 'another-account', uin: 456 }; }
      if (params.groupId === 'renew@chatroom') this.session.value = { ...this.session.value };
      return [{ id: 'alice', groupId: params.groupId, nickname: '阿禾', card: '群中阿禾', remark: 'Alice' }, { id: 'foreign', groupId: 'foreign@chatroom', nickname: '其他群成员' }]; }
    async close() {}
  }`,
  './protocol/login.ts': `export class QrLoginManager { status() { return { state: 'idle' }; } async close() {} }`,
  './paths.ts': `export const protectStorage = () => {}; export const projectPaths = root => ({ private: root, cache: root });`,
  './protocol/media-loader.mjs': `export const loadObservedMedia = () => { throw new Error('No media in member fixture'); };`,
};
const workerBundle = await rolldown({ input: path.join(root, 'backend/worker.mjs'), platform: 'node', plugins: [{ name: 'offline-member-worker', resolveId: source => Object.hasOwn(workerMocks, source) ? '\0member-worker:' + source : null, load: id => id.startsWith('\0member-worker:') ? workerMocks[id.slice('\0member-worker:'.length)] : null }] });
let workerCode;
try { const { output } = await workerBundle.generate({ format: 'cjs' }); assert.equal(output.length, 1); workerCode = output[0].code; }
finally { await workerBundle.close(); }
async function workerFixture(t) {
  const temp = temporary(), entry = path.join(temp.dir, 'offline-member-worker.cjs'); fs.writeFileSync(entry, workerCode);
  const child = fork(entry, [temp.dir], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, NAPCAT_RESOURCE_ROOT: temp.dir } });
  const pending = new Map(), ready = Promise.withResolvers(), exited = Promise.withResolvers(); let serial = 0;
  child.on('message', message => { if (message.type === 'ready') ready.resolve(); if (message.type === 'result') { const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); } } });
  child.on('error', error => ready.reject(error)); child.on('exit', () => { ready.reject(new Error('Fixture worker exited')); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Fixture worker exited')); } pending.clear(); exited.resolve(); });
  const call = (op, args) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture IPC timed out')); }, 5000); pending.set(id, { resolve, reject, timer }); child.send({ type: 'call', id, op, args }); });
  t.after(async () => { if (child.connected) { try { await call('close'); } catch { child.kill(); } } else if (child.exitCode === null && child.signalCode === null) child.kill(); await exited.promise; temp.remove(); });
  await ready.promise; return { call };
}

test('worker member RPC requires the matching account and only returns the selected group with observed scope', async t => {
  const f = await workerFixture(t);
  for (const args of [{ peerId: room }, { accountId: 'old-account', peerId: room }]) { const response = await f.call('members', args); assert.equal(response.ok, false); assert.equal(response.error.code, 'ACCOUNT_CHANGED'); }
  assert.equal((await f.call('status')).value.received, 0);
  assert.equal((await f.call('members', { accountId: owner, peerId: 'alice' })).error.code, 'INVALID_GROUP');
  const response = await f.call('members', { accountId: owner, peerId: room });
  assert.equal(response.ok, true); assert.equal(response.value.accountId, owner); assert.equal(response.value.peerId, room); assert.equal(response.value.scope, 'protocol-observed-only');
  assert.deepEqual(response.value.members.map(member => [member.id, member.name]), [['alice', '群中阿禾']]);
  assert.equal((await f.call('members', { accountId: owner, peerId: 'renew@chatroom' })).ok, true, 'normal session saves may replace the credential object without switching accounts');
});

test('worker member RPC checks the account again after awaiting the member list', async t => {
  const f = await workerFixture(t), response = await f.call('members', { accountId: owner, peerId: 'switch@chatroom' });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'ACCOUNT_CHANGED'); assert.equal(response.value, undefined);
});
