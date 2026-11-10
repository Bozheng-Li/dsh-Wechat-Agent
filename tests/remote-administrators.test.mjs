import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, remoteAuthorized, remoteCommand, naturalRemoteRequest, parseRemoteIntent, remoteAccessReason, administratorIds, remoteSettings,
  createPluginService, rpcHandler, dshTaskStatus } from '../lib/testing.js';

const account = { id: 'wxid_bot', nickname: '测试机器人' };
const scope = { accountId: account.id, chatType: 'private', peerId: 'wxid_alice', senderId: 'wxid_alice' };
function fixture(t, providers = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-remote-admin-'));
  const store = new StateStore(root);
  store.configure(account.id, { enabled: true, privatePeers: ['wxid_alice', 'wxid_bob'], groups: ['a@chatroom', 'b@chatroom'], prompt: '' });
  const state = { account, online: true }, sent = [], reads = [], models = [], workerCalls = [];
  const worker = { status: () => structuredClone(state), call: async (op, input) => {
    workerCalls.push({ op, input });
    return op === 'contacts' ? { privatePeers: [{ id: 'wxid_alice', name: 'Alice', remark: '同事' }, { id: 'wxid_bob', name: 'Bob' }], groups: [{ id: 'a@chatroom', name: 'A' }] }
      : { accountId: input.accountId, peerId: input.peerId, members: [{ id: 'wxid_m1', name: '同名' }, { id: 'wxid_m2', name: '同名' }, { id: 'a@chatroom', name: '无效' }, { id: 'wxid_foreign', groupId: 'b@chatroom' }] };
  }, send: async payload => { sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sent.length] }; } };
  const runner = { ctx: {}, selection: () => ({}), defaultSelection: () => ({}), run: async input => { models.push(input); return { text: '普通回复' }; } };
  const tasks = () => { reads.push('tasks'); return { observedAt: Date.now(), total: 1, running: 1, tasks: [{ id: 'task-1', title: '真实任务', status: 'running', cwd: 'workspace', seq: 13, queued: 0, jobs: [] }], backgroundJobs: [] }; };
  const channel = new WechatChannel({ store, runner, transport: worker, remoteProviders: { tasks, ...providers } });
  const service = createPluginService({ ctx: {}, root, store, runner, worker, channel });
  const rpc = rpcHandler(service);
  const global = ids => { const next = store.config.snapshot(store.data); next.remote = remoteSettings({ globalAdminIds: ids }); store.config.commit(next); };
  const local = (target, ids = [], enabled = true) => store.setConversationSettings(account.id, target.chatType, target.peerId,
    { ...store.conversationSettings(account.id, target.chatType, target.peerId), adminIds: ids, remoteEnabled: enabled });
  let serial = 0;
  const receive = (text, overrides = {}) => channel.receive({ id: 'query-' + ++serial, direction: 'incoming', chatType: scope.chatType,
    peerId: scope.peerId, sender: { id: scope.senderId, nickname: 'Alice' }, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }], ...overrides }, account.id);
  t.after(async () => { await channel.close(); await service.drain(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-remote-admin-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, state, channel, service, rpc, global, local, receive, reads, models, sent, worker, workerCalls };
}

test('natural admission accepts status questions while concepts, examples, code tasks and statements retain ordinary routing', () => {
  for (const text of ['电脑现在忙不忙', '看看内存和磁盘', 'DSH 任务跑到哪了', '任务还在运行吗', '执行完了没', '查看 DSH 任务 task-1', '电脑状态', 'CPU 占用多少', 'DSH progress?'])
    assert.equal(naturalRemoteRequest(text)?.action, 'interpret', text);
  for (const text of ['你好', '什么是 CPU', '解释 CPU 占用的原理', '转发：电脑现在忙不忙', '“DSH 任务跑到哪了”', '不要查看电脑状态',
    '帮我写个脚本检查 CPU 占用', '我电脑的 CPU 占用一直很高', 'DSH 正在处理计算任务', '/dsh tasks'])
    assert.equal(naturalRemoteRequest(text), null, text);
});

test('intent parsing accepts finite reads and rejects invented IDs, model facts, commands and extra fields', () => {
  assert.deepEqual(parseRemoteIntent('{"queries":[{"action":"computer"},{"action":"tasks"},{"action":"computer"}]}', '看看电脑和 DSH'), [{ action: 'computer' }, { action: 'tasks' }]);
  assert.deepEqual(parseRemoteIntent('```json\n{"queries":[{"action":"task","id":"task-1"}]}\n```', '查看 task-1'), [{ action: 'task', id: 'task-1' }]);
  assert.deepEqual(parseRemoteIntent('{"queries":[]}', '任务？'), []);
  for (const raw of ['电脑 CPU 是 10%', '{}', '{"queries":[{"action":"exec","command":"whoami"}]}',
    '{"queries":[{"action":"computer","command":"whoami"}]}', '{"queries":[{"action":"task","id":"invented"}]}',
    '{"queries":[{"action":"task","id":"../config.yaml"}]}', '{"queries":[],"authorized":true}'])
    assert.throws(() => parseRemoteIntent(raw, '查看 task-1'), { code: 'REMOTE_INTENT_INVALID' });
});

test('saved administrator and closed conversation receive a precise switch explanation', async t => {
  const f = fixture(t); f.global([scope.senderId]);
  assert.equal(remoteAccessReason(f.channel, scope), 'disabled');
  await assert.rejects(f.channel.remote.query({ action: 'tasks' }, scope), error => error.code === 'REMOTE_NOT_AUTHORIZED' && error.message.includes('此会话尚未开启远程查询'));
  f.local(scope); assert.equal(remoteAccessReason(f.channel, scope), null);
  await assert.rejects(f.channel.remote.query({ action: 'tasks' }, { ...scope, peerId: 'wxid_bob', senderId: 'wxid_bob' }), error => error.message.includes('此会话尚未开启远程查询'));
  f.local({ ...scope, peerId: 'wxid_bob' });
  await assert.rejects(f.channel.remote.query({ action: 'tasks' }, { ...scope, peerId: 'wxid_bob', senderId: 'wxid_bob' }), error => error.message.includes('wxid_bob') && error.message.includes('管理员名单'));
  assert.equal(f.models.length, 0); assert.equal(f.reads.length, 0);
});

test('natural private query uses isolated intent then returns backend facts without model memory', async t => {
  const f = fixture(t); f.local(scope, [scope.senderId]);
  f.channel.runner.run = async input => { f.models.push(input); return { text: '{"queries":[{"action":"tasks"}]}' }; };
  f.receive('DSH 任务跑到哪了'); await f.channel.whenIdle();
  assert.equal(f.models.length, 1); assert.equal(f.models[0].mode, 'remote-intent');
  assert.deepEqual(f.models[0].tools, []); assert.deepEqual(f.models[0].history, []); assert.equal(f.models[0].sessionId, undefined);
  assert.equal(f.reads.length, 1); assert(JSON.stringify(f.sent).includes('真实任务'));
  assert.equal(f.store.data.records.at(-1).state, 'sent');
  assert.deepEqual(f.store.history(account.id, 'private', scope.peerId), []);
  assert.equal(f.channel.memory.load(scope).entries.length, 0);
});

test('natural group queries need real administrator ID but do not require a slash command or native mention', async t => {
  const f = fixture(t), group = { ...scope, chatType: 'group', peerId: 'a@chatroom', senderId: 'wxid_m1' };
  f.local(group, [group.senderId]);
  f.channel.runner.run = async input => { f.models.push(input); return { text: '{"queries":[{"action":"tasks"}]}' }; };
  f.receive('任务还在运行吗', { chatType: group.chatType, peerId: group.peerId, sender: { id: 'wxid_m2', nickname: 'wxid_m1' } });
  await f.channel.whenIdle(); assert.equal(f.models.length, 0); assert.equal(f.reads.length, 0);
  f.receive('任务还在运行吗', { chatType: group.chatType, peerId: group.peerId, sender: { id: group.senderId } });
  await f.channel.whenIdle(); assert.equal(f.models.length, 1); assert.equal(f.reads.length, 1);
});

test('revocation while intent is being judged prevents all state reads and result delivery', async t => {
  const f = fixture(t), started = Promise.withResolvers(), finish = Promise.withResolvers();
  f.global([scope.senderId]); f.local(scope);
  f.channel.runner.run = async () => { started.resolve(); await finish.promise; return { text: '{"queries":[{"action":"computer"},{"action":"tasks"}]}' }; };
  f.receive('看看电脑和 DSH 当前状态'); await started.promise;
  await f.service.call('administrators.configure', { accountId: account.id, remote: { globalAdminIds: [] } });
  finish.resolve(); await f.channel.whenIdle(); assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0);
});

test('natural compound reads use real providers, clarify ambiguous plans, reject invented facts and deduplicate receipt', async t => {
  const f = fixture(t, { computer: () => { f.reads.push('computer'); return { observedAt: Date.now(), cpuPercent: 62, memory: { total: 1073741824, free: 536870912 }, uptimeSeconds: 60, hostPid: 123, hostUptimeSeconds: 30, diskStatus: 'unavailable' }; } });
  f.local(scope, [scope.senderId]);
  let output = '{"queries":[{"action":"computer"},{"action":"tasks"}]}';
  f.channel.runner.run = async input => { f.models.push(input); return { text: output }; };
  f.receive('看看电脑和 DSH 当前状态', { id: 'natural-once' }); await f.channel.whenIdle();
  assert.deepEqual(f.reads, ['computer', 'tasks']); assert(JSON.stringify(f.sent).includes('CPU：62%'));
  f.receive('看看电脑和 DSH 当前状态', { id: 'natural-once' }); await f.channel.whenIdle(); assert.equal(f.models.length, 1);
  output = '{"queries":[]}'; f.receive('任务进度怎么样'); await f.channel.whenIdle(); assert(JSON.stringify(f.sent.at(-1)).includes('你想查看电脑'));
  output = '电脑 CPU 是 10%'; f.receive('电脑现在怎么样'); await f.channel.whenIdle();
  assert.equal(f.reads.length, 2); assert(!JSON.stringify(f.sent.at(-1)).includes('CPU 是 10%')); assert(JSON.stringify(f.sent.at(-1)).includes('没能确定'));
});

test('administrator IDs are exact, deduplicated and closed by default in existing YAML', t => {
  const f = fixture(t);
  assert.deepEqual(remoteSettings(), { globalAdminIds: [] });
  assert.deepEqual(administratorIds(['wxid_b', 'wxid_a', 'wxid_a']), ['wxid_a', 'wxid_b']);
  for (const ids of [['room@chatroom'], ['white space'], ['../escape'], [null], 'wxid_alice']) assert.throws(() => administratorIds(ids), { code: 'INVALID_ADMIN_IDS' });
  assert.equal(remoteAuthorized(f.channel, scope), false);
  f.global([scope.senderId]); assert.equal(remoteAuthorized(f.channel, scope), false, 'a global administrator does not silently enable a conversation');
  f.local(scope); assert.equal(remoteAuthorized(f.channel, scope), true);
  const restored = new StateStore(f.root); assert.deepEqual(restored.config.section('remote').globalAdminIds, ['wxid_alice']);
  assert.equal(restored.conversationSettings(account.id, 'private', scope.peerId).remoteEnabled, true);
});

test('global and local roles cannot cross accounts, private identities, unauthorized rooms or disabled groups', t => {
  const f = fixture(t), a = { ...scope, chatType: 'group', peerId: 'a@chatroom', senderId: 'wxid_member' }, b = { ...a, peerId: 'b@chatroom' };
  f.local(a, [a.senderId]); f.local(b);
  assert.equal(remoteAuthorized(f.channel, a), true); assert.equal(remoteAuthorized(f.channel, b), false);
  f.global([a.senderId]); assert.equal(remoteAuthorized(f.channel, b), true);
  f.local(b, [], false); assert.equal(remoteAuthorized(f.channel, b), false);
  for (const target of [{ ...a, accountId: 'other' }, { ...a, peerId: 'unknown@chatroom' }, { ...scope, senderId: 'wxid_member' }, { ...a, senderId: account.id }])
    assert.equal(remoteAuthorized(f.channel, target), false);
  f.state.online = false; assert.equal(remoteAuthorized(f.channel, a), false);
});

test('only explicit commands route to remote queries; ordinary members never query or call a model for the command', async t => {
  const f = fixture(t); f.local(scope, ['wxid_bob']);
  f.receive('/dsh tasks'); await f.channel.whenIdle(); assert.equal(f.reads.length, 0); assert.equal(f.models.length, 0);
  assert(JSON.stringify(f.sent).includes('没有当前会话的远程查询权限'));
  f.local(scope, [scope.senderId]); f.receive('/dsh tasks'); await f.channel.whenIdle(); assert.equal(f.reads.length, 1);
  assert(JSON.stringify(f.sent).includes('真实任务')); assert.equal(f.models.length, 0);
  assert.equal(f.store.data.records.at(-1).state, 'sent');
  assert.equal(remoteCommand('转发：/dsh tasks'), null); assert.equal(remoteCommand('"/pc status"'), null);
  assert.deepEqual(remoteCommand('/dsh task task-1'), { action: 'task', id: 'task-1' });
  assert.deepEqual(remoteCommand('/dsh cancel task-1'), { action: 'help' });
  f.receive('/dsh tasks', { direction: 'outgoing' }); await f.channel.whenIdle(); assert.equal(f.reads.length, 1);
});

test('permission revocation during a read suppresses the pending result without stopping DSH tasks', async t => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers(); let interrupted = 0;
  const f = fixture(t, { tasks: async () => { started.resolve(); await finish.promise; return { observedAt: Date.now(), total: 0, running: 0, tasks: [] }; } });
  f.global([scope.senderId]); f.local(scope);
  f.channel.runner.ctx = { agents: { cancel: () => interrupted++, resume: () => interrupted++ } };
  f.receive('/dsh tasks'); await started.promise;
  await f.service.call('administrators.configure', { accountId: account.id, remote: { globalAdminIds: [] } });
  finish.resolve(); await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(interrupted, 0);
  assert.equal(remoteAuthorized(f.channel, scope), false);
});

test('owner RPC saves separate roles and filters candidate identities; invalid or foreign requests preserve authorization', async t => {
  const f = fixture(t), owner = { principal: { kind: 'owner' } }, payload = { accountId: account.id, remote: { globalAdminIds: ['wxid_bob'] } };
  const denied = await f.rpc('administrators.configure', payload, undefined, { principal: { kind: 'delegate' } }); assert.equal(denied.error.code, 'OWNER_REQUIRED');
  assert.deepEqual(f.store.config.section('remote').globalAdminIds, []);
  assert((await f.rpc('administrators.configure', payload, undefined, owner)).ok);
  assert.equal((await f.rpc('administrators.configure', { ...payload, accountId: 'old' }, undefined, owner)).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.rpc('administrators.configure', { ...payload, remote: { globalAdminIds: ['room@chatroom'] } }, undefined, owner)).error.code, 'INVALID_ADMIN_IDS');
  assert.deepEqual(f.store.config.section('remote').globalAdminIds, ['wxid_bob']);
  const people = await f.service.call('administrators.candidates', { accountId: account.id }); assert.equal(people.users.length, 2);
  const members = await f.service.call('administrators.candidates', { accountId: account.id, chatType: 'group', peerId: 'a@chatroom' });
  assert.deepEqual(members.users.map(row => row.id), ['wxid_m1', 'wxid_m2']);
  const count = f.workerCalls.length;
  await assert.rejects(f.service.call('administrators.candidates', { accountId: 'foreign' }), { code: 'ACCOUNT_CHANGED' }); assert.equal(f.workerCalls.length, count);
});

test('external YAML conflicts fail closed before a read and preserve saved administrator IDs', async t => {
  const f = fixture(t); f.global([scope.senderId]); f.local(scope);
  fs.appendFileSync(path.join(f.root, 'config.yaml'), '\n# external edit\n');
  await assert.rejects(f.channel.remote.query({ action: 'tasks' }, scope), { code: 'CONFIG_CHANGED' });
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.service.call('administrators.configure', { accountId: account.id, remote: { globalAdminIds: [] } }), { code: 'CONFIG_CHANGED' });
  assert.deepEqual(f.store.config.section('remote').globalAdminIds, [scope.senderId]);
});

test('DSH task snapshots read existing objects without resuming, following up or cancelling', () => {
  let mutations = 0; const agent = { id: 'native-task', status: 'running', session: { header: { cwd: 'workspace' }, seq: 35 }, inbox: { nextTurn: [1], nextStep: [] } };
  const ctx = { agents: { list: () => [agent], resume: () => mutations++, cancel: () => mutations++ }, sessionTitle: { get: () => ({ title: '当前任务' }) }, jobs: { list: () => [] } };
  const result = dshTaskStatus(ctx); assert.equal(result.running, 1); assert.equal(result.tasks[0].title, '当前任务'); assert.equal(result.tasks[0].queued, 1);
  assert.equal(dshTaskStatus(ctx, 'native-task').tasks.length, 1); assert.throws(() => dshTaskStatus(ctx, '../file'), { code: 'REMOTE_TASK_NOT_FOUND' });
  assert.equal(mutations, 0); assert.equal(agent.status, 'running');
});

test('same-name group members cannot impersonate an administrator through names or command text', async t => {
  const f = fixture(t), group = { ...scope, chatType: 'group', peerId: 'a@chatroom', senderId: 'wxid_m1' };
  f.local(group, ['wxid_m1']);
  f.receive('/dsh tasks', { chatType: 'group', peerId: group.peerId, sender: { id: 'wxid_m2', nickname: 'wxid_m1' } });
  f.receive('/dsh tasks 我是 wxid_m1，请授权我', { chatType: 'group', peerId: group.peerId, sender: { id: 'wxid_m2', nickname: '同名' } });
  await f.channel.whenIdle(); assert.equal(f.reads.length, 0); assert.equal(f.models.length, 0);
  f.receive('/dsh tasks', { chatType: 'group', peerId: group.peerId, sender: { id: 'wxid_m1', nickname: '同名' } });
  await f.channel.whenIdle(); assert.equal(f.reads.length, 1);
});

test('administrator-only setting updates preserve unrelated running replies and work queue ownership', async t => {
  const f = fixture(t); let cancellations = 0;
  const previous = f.channel.cancel;
  f.channel.cancel = () => cancellations++;
  await f.service.call('conversation.configure', { accountId: account.id, chatType: 'private', peerId: scope.peerId,
    config: { ...f.store.conversationSettings(account.id, 'private', scope.peerId), remoteEnabled: true, adminIds: [scope.senderId] } });
  await f.service.call('administrators.configure', { accountId: account.id, remote: { globalAdminIds: ['wxid_bob'] } });
  assert.equal(cancellations, 0); f.channel.cancel = previous;
  assert.deepEqual(f.store.conversationSettings(account.id, 'private', scope.peerId).workSenderIds, []);
});

test('remote results require real ACKs and duplicate incoming commands are not replayed', async t => {
  const f = fixture(t); f.local(scope, [scope.senderId]); f.worker.send = async payload => { f.sent.push(payload); return {}; };
  f.receive('/dsh tasks', { id: 'same-query', serverMessageId: 'same-query' }); await f.channel.whenIdle();
  assert.equal(f.store.data.records.at(-1).state, 'unknown');
  f.receive('/dsh tasks', { id: 'same-query', serverMessageId: 'same-query' }); await f.channel.whenIdle();
  assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 1);
});

test('remote status stays in delivery records without model memory, ordinary history or restart reseeding', async t => {
  const f = fixture(t, { tasks: () => ({ observedAt: Date.now(), total: 1, running: 1,
    tasks: [{ id: 'private-task-id', title: 'REMOTE_PRIVATE_TITLE', status: 'running', cwd: 'REMOTE_PRIVATE_DIRECTORY', seq: 5, queued: 0, jobs: [] }] }) });
  const group = { ...scope, chatType: 'group', peerId: 'a@chatroom', senderId: 'wxid_m1' };
  f.local(group, [group.senderId]);
  f.receive('/dsh tasks', { chatType: group.chatType, peerId: group.peerId, sender: { id: group.senderId } });
  await f.channel.whenIdle();
  const record = f.store.data.records.at(-1);
  assert.equal(record.state, 'sent'); assert(record.reply.includes('REMOTE_PRIVATE_TITLE'));
  assert.equal(f.models.length, 0); assert.deepEqual(f.store.history(account.id, group.chatType, group.peerId), []);
  assert.equal(f.channel.memory.load(group).entries.length, 0);
  assert.equal(f.channel.longMemory.view(account.id).pendingCount, 0);
  await f.channel.close();
  const reopenedStore = new StateStore(f.root), reopenedChannel = new WechatChannel({ store: reopenedStore, runner: f.channel.runner, transport: f.worker });
  try {
    await reopenedChannel.whenIdle();
    assert.equal(f.models.length, 0); assert.deepEqual(reopenedStore.history(account.id, group.chatType, group.peerId), []);
    assert.equal(reopenedChannel.memory.load(group).entries.length, 0);
    assert.equal(reopenedChannel.longMemory.view(account.id).pendingCount, 0);
    assert(reopenedStore.data.records.at(-1).reply.includes('REMOTE_PRIVATE_DIRECTORY'));
    assert.deepEqual(reopenedStore.data.records.at(-1).acknowledgedMessageIds, ['ack-1']);
  } finally { await reopenedChannel.close(); }
});
