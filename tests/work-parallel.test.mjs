import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, WorkStore, ChannelError, createPluginService, rpcHandler, workModelTools } from '../lib/testing.js';
import { fixtureWorkRoute } from './fixtures/work-dialogue.mjs';

const scope = { accountId: 'parallel-owner', chatType: 'private', peerId: 'alice', senderId: 'alice' };
const waitFor = async predicate => {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Expected work state did not arrive'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
function fixture(t, { model, send, sessionReady } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-parallel-')), store = new StateStore(root);
  const state = { online: true, account: { id: scope.accountId } }, sent = [], executions = [], apiCalls = [];
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [], prompt: 'PRIVATE_CHAT_PROMPT' });
  const admins = store.config.snapshot(store.data); admins.remote = { globalAdminIds: ['alice', 'bob'] }; store.config.commit(admins);
  for (const peer of ['alice', 'bob']) store.setConversationSettings(scope.accountId, 'private', peer,
    { ...store.conversationSettings(scope.accountId, 'private', peer), executionMode: 'work', remoteEnabled: true });
  const runner = { run: async input => {
    if (input.mode === 'work-routing') return fixtureWorkRoute(input);
    assert.equal(input.mode, 'work-result'); apiCalls.push(input);
    return model ? model(input) : { text: JSON.parse(input.text).result };
  } };
  const transport = { status: () => state, send: async payload => {
    sent.push(payload); return send ? send(payload, sent.length) : { delivery: 'server-ack', serverMessageIds: [`parallel-ack-${sent.length}`] };
  } };
  const workRunner = { run: async input => {
    const gate = Promise.withResolvers(), cancelled = Promise.withResolvers(), entry = { input, gate };
    executions.push(entry);
    const abort = () => cancelled.reject(input.signal.reason);
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      input.signal.throwIfAborted();
      if (sessionReady) await Promise.race([sessionReady(input, executions.length), cancelled.promise]);
      await input.onSession('isolated-session-' + path.basename(input.cwd), { native: true });
      await input.onOperation({ tool: 'wechat_work_exec', command: 'RAW_COMMAND', result: { ok: true, exitCode: 0, stdout: 'RAW_OUTPUT' } });
      await Promise.race([gate.promise, cancelled.promise]);
      input.signal.throwIfAborted();
      return { text: `完成：${input.request}`, native: true };
    } finally { input.signal.removeEventListener('abort', abort); }
  } };
  const channel = new WechatChannel({ store, runner, workRunner, transport });
  let id = 0;
  const receive = (text, peer = 'alice') => channel.receive({ id: `parallel-msg-${++id}`, direction: 'incoming',
    chatType: 'private', peerId: peer, sender: { id: peer }, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }] }, scope.accountId);
  const replies = async () => { while (channel.workReplies.size) await Promise.allSettled([...channel.workReplies.values()].map(lane => lane.pending)); };
  t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-parallel-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, state, channel, runner, sent, executions, apiCalls, receive, replies };
}

test('explicit independent work messages enter separate sessions, a third queues, and status responds while both run', async t => {
  const f = fixture(t);
  f.receive('查远端实验指标'); await f.replies(); await waitFor(() => f.executions.length === 1);
  f.receive('/work new 找昨天的新闻摘要 Word'); await f.replies(); await waitFor(() => f.executions.length === 2);
  const [a, b] = f.channel.work.list(scope).jobs;
  assert.equal(a.state, 'running'); assert.equal(b.state, 'running'); assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.sessionId, b.sessionId);
  f.receive(`/work status ${a.id}`); await f.replies();
  assert.equal(f.channel.work.list(scope).jobs.length, 2); assert.equal(f.executions.length, 2);
  assert.match(f.sent.at(-1).message[0].data.text, /正在执行/);
  assert.equal(f.apiCalls.length, 0, 'the chat API cannot select or gate work submissions');
  f.receive('/work new 能不能并行启动'); await f.replies();
  assert.equal(f.executions.length, 2); assert.equal(f.channel.work.list(scope).jobs[0].state, 'queued');
  f.executions[0].gate.resolve(); await waitFor(() => f.executions.length === 3);
  assert.equal(f.executions[2].input.request, '能不能并行启动');
  assert.equal(f.executions[2].input.workContext, undefined);
  assert.equal(f.executions[1].input.signal.aborted, false);
  f.executions[1].gate.resolve(); f.executions[2].gate.resolve(); await f.channel.whenIdle();
  assert(f.channel.work.list(scope).jobs.every(job => job.state === 'succeeded' && job.delivery.state === 'sent'));
  assert.equal(f.store.history(scope.accountId, scope.chatType, scope.peerId).length, 0);
  assert.equal(f.channel.memory.load(scope).entries.length, 0);
  assert.equal(new WorkStore(f.store).list(scope).length, 3);
  assert.equal(f.apiCalls.length, 3);
  assert(f.apiCalls.every(input => input.tools.length === 0 && input.history === undefined));
  assert(!JSON.stringify(f.sent).includes('RAW_OUTPUT'));
});

test('owner capacity changes take effect without interrupting current tasks; unauthorized changes do not apply', async t => {
  const f = fixture(t), service = createPluginService({ root: f.root, store: f.store, channel: f.channel, runner: f.runner, worker: f.channel.transport });
  const rpc = rpcHandler(service), owner = { principal: { kind: 'owner' } };
  const a = f.channel.work.create(scope, '任务 A'), b = f.channel.work.create(scope, '任务 B'), c = f.channel.work.create(scope, '任务 C');
  assert.equal(f.executions.length, 2); assert.equal(f.channel.work.get(c.id, scope).state, 'queued');
  assert.equal((await rpc('work.configure', { accountId: scope.accountId, maxConcurrent: 8 }, undefined, { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.equal(f.channel.work.capacity().maxConcurrent, 2);
  assert.equal((await rpc('work.configure', { accountId: 'foreign', maxConcurrent: 8 }, undefined, owner)).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await rpc('work.configure', { accountId: scope.accountId, maxConcurrent: 0 }, undefined, owner)).error.code, 'INVALID_WORK_SETTINGS');
  assert.equal((await rpc('work.configure', { accountId: scope.accountId, maxConcurrent: 1 }, undefined, owner)).value.running, 2);
  assert(f.executions.every(entry => !entry.input.signal.aborted));
  f.executions[0].gate.resolve(); await waitFor(() => f.channel.work.get(a.id, scope).state === 'succeeded');
  await waitFor(() => f.channel.work.active.size === 1); assert.equal(f.executions.length, 2);
  await rpc('work.configure', { accountId: scope.accountId, maxConcurrent: 3 }, undefined, owner);
  await waitFor(() => f.executions.length === 3); assert.equal(f.channel.work.get(b.id, scope).state, 'running');
  f.executions[1].gate.resolve(); f.executions[2].gate.resolve(); await f.channel.whenIdle();
  assert.equal(new StateStore(f.root).config.section('work').maxConcurrent, 3);
});

test('cancel only the selected parallel task and retain same-folder continuation ownership and locks', async t => {
  const f = fixture(t), a = f.channel.work.create(scope, '任务 A'), b = f.channel.work.create(scope, '任务 B');
  const next = f.channel.work.create(scope, '继续 A', a.id);
  assert.equal(next.state, 'queued'); assert.equal(next.cwd, a.cwd); assert.equal(f.executions.length, 2);
  assert.throws(() => f.channel.work.cancel(a.id, { ...scope, senderId: 'bob', peerId: 'bob' }), { code: 'WORK_NOT_FOUND' });
  f.channel.work.cancel(a.id, scope);
  await waitFor(() => f.channel.work.get(a.id, scope).state === 'cancelled');
  assert.equal(f.executions[0].input.signal.aborted, true); assert.equal(f.executions[1].input.signal.aborted, false);
  await waitFor(() => f.executions.length === 3);
  assert.equal(next.cwd, a.cwd); assert.equal(f.executions[2].input.sessionId, f.channel.work.get(a.id, scope).sessionId);
  assert.equal(f.channel.work.get(b.id, scope).state, 'running');
  f.executions[1].gate.resolve(); f.executions[2].gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.channel.work.get(a.id, scope).delivery.state, 'suppressed');
});

test('natural followups queue on the same session even before its ID is known, while an explicit new task runs independently', async t => {
  const ready = Promise.withResolvers(), f = fixture(t, { sessionReady: (_input, count) => count === 1 ? ready.promise : Promise.resolve() });
  try {
    f.receive('创建一个文件'); await f.replies(); await waitFor(() => f.executions.length === 1);
    const first = f.channel.work.list(scope).jobs[0]; assert.equal(first.sessionId, null);
    f.receive('删除这个文件'); await f.replies();
    const second = f.channel.work.list(scope).jobs[0];
    f.receive('再检查一次'); await f.replies();
    const third = f.channel.work.list(scope).jobs[0];
    assert.equal(second.continues, first.id); assert.equal(third.continues, second.id);
    assert.equal(second.cwd, first.cwd); assert.equal(third.cwd, first.cwd);
    assert.equal(second.state, 'queued'); assert.equal(third.state, 'queued'); assert.equal(f.executions.length, 1);
    f.receive('/work new 独立任务'); await f.replies(); await waitFor(() => f.executions.length === 2);
    const independent = f.channel.work.list(scope).jobs[0]; assert.notEqual(independent.cwd, first.cwd); assert.equal(independent.continues, undefined);
    ready.resolve(); await waitFor(() => f.channel.work.get(first.id, scope).sessionId);
    f.executions[0].gate.resolve(); await waitFor(() => f.executions.length === 3);
    assert.equal(f.executions[2].input.request, '删除这个文件'); assert.equal(f.executions[2].input.sessionId, f.channel.work.get(first.id, scope).sessionId);
    assert.equal(f.channel.work.get(third.id, scope).state, 'queued'); assert.equal(f.executions[1].input.signal.aborted, false);
    f.executions[2].gate.resolve(); await waitFor(() => f.executions.length === 4);
    assert.equal(f.executions[3].input.request, '再检查一次'); assert.equal(f.executions[3].input.sessionId, f.executions[2].input.sessionId);
    f.executions[1].gate.resolve(); f.executions[3].gate.resolve(); await f.channel.whenIdle();
    assert(f.channel.work.list(scope).jobs.every(job => job.state === 'succeeded' && job.delivery.state === 'sent'));
    const restored = new WorkStore(f.store);
    assert.equal(restored.get(third.id).conversationTurn, true); assert.equal(restored.get(third.id).sessionId, restored.get(first.id).sessionId);
  } finally { ready.resolve(); }
});

test('a queued followup waits for the preceding result receipt before it can change the same folder', async t => {
  const deliveryStarted = Promise.withResolvers(), received = Promise.withResolvers();
  const f = fixture(t, { send: async (payload, count) => {
    if (payload.message.some(part => part.type === 'text' && part.data.text.includes('完成：创建文件'))) {
      deliveryStarted.resolve(); await received.promise;
    }
    return { delivery: 'server-ack', serverMessageIds: [`receipt-${count}`] };
  } });
  try {
    f.receive('创建文件'); await f.replies(); await waitFor(() => f.executions.length === 1);
    f.executions[0].gate.resolve(); await deliveryStarted.promise;
    f.receive('删除这个文件'); await f.replies();
    const next = f.channel.work.list(scope).jobs[0]; assert.equal(next.state, 'queued'); assert.equal(f.executions.length, 1);
    received.resolve(); await waitFor(() => f.executions.length === 2);
    assert.equal(f.executions[1].input.cwd, f.executions[0].input.cwd); assert.equal(f.executions[1].input.sessionId, f.channel.work.get(next.continues, scope).sessionId);
    f.executions[1].gate.resolve(); await f.channel.whenIdle(); assert.equal(f.channel.work.get(next.id, scope).delivery.state, 'sent');
  } finally { received.resolve(); }
});

test('slow result polishing does not prevent another sender from submitting and receiving native work', async t => {
  const held = Promise.withResolvers(), started = Promise.withResolvers();
  const f = fixture(t, { model: async input => {
    const data = JSON.parse(input.text);
    if (data.request === '慢任务') { started.resolve(); await held.promise; input.signal.throwIfAborted(); }
    return { text: data.result };
  } });
  f.receive('慢任务'); await f.replies(); await waitFor(() => f.executions.length === 1);
  f.executions[0].gate.resolve(); await started.promise;
  f.receive('另一个任务', 'bob'); await f.replies(); await waitFor(() => f.executions.length === 2);
  f.executions[1].gate.resolve();
  const bob = { ...scope, peerId: 'bob', senderId: 'bob' };
  await f.channel.work.whenIdle(bob);
  assert.equal(f.channel.active, undefined);
  assert(f.sent.some(payload => payload.peerId === 'bob' && JSON.stringify(payload).includes('完成：另一个任务')));
  const alice = f.channel.work.list(scope).jobs[0];
  assert.equal(alice.state, 'running'); assert.equal(alice.nativeExecution, true);
  f.channel.work.cancel(alice.id, scope); held.resolve(); await f.channel.whenIdle();
  const cancelled = f.channel.work.get(alice.id, scope);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.delivery.state, 'suppressed');
  assert.equal(cancelled.result.originalText, '完成：慢任务');
  assert(!f.sent.some(payload => payload.peerId === 'alice' && JSON.stringify(payload).includes('完成：慢任务')));
});

test('task dispatch confirms once and an unknown final receipt is not replayed', async t => {
  const ack = Promise.withResolvers(), attempting = Promise.withResolvers();
  const f = fixture(t, { send: async (_payload, count) => {
    if (count === 2) { attempting.resolve(); await ack.promise; return {}; }
    return { delivery: 'server-ack', serverMessageIds: ['opening-ack'] };
  } });
  f.receive('独立任务'); await f.replies(); await waitFor(() => f.executions.length === 1);
  assert.equal(f.channel.work.list(scope).jobs.length, 1); assert.equal(f.sent.length, 1);
  f.executions[0].gate.resolve(); await attempting.promise;
  ack.resolve(); await f.channel.whenIdle();
  assert.equal(f.channel.work.list(scope).jobs[0].delivery.state, 'unknown');
  const count = f.sent.length; new WorkStore(f.store); assert.equal(f.sent.length, count); assert.equal(count, 2);
});

test('chat API failure cannot block original-message submission and falls back to the finished DSH text', async t => {
  const f = fixture(t, { model: async input => {
    assert.equal(input.tools.length, 0);
    throw new ChannelError('DSH_AGENT_FAILED', '合成润色 API 故障');
  } });
  f.receive('现在进展怎么样'); await f.replies(); await waitFor(() => f.executions.length === 1);
  assert.equal(f.apiCalls.length, 0); assert.equal(f.executions[0].input.request, '现在进展怎么样');
  f.executions[0].gate.resolve(); await f.channel.whenIdle();
  const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.state, 'succeeded'); assert.equal(job.result.polish.state, 'fallback');
  assert.equal(job.result.text, job.result.originalText); assert.equal(job.delivery.state, 'sent');
  assert(!JSON.stringify(f.sent).includes('没有新开任务'));
});

test('an unknown opening receipt does not repeat confirmation or block authorized execution', async t => {
  const f = fixture(t, { send: (_payload, count) => count === 1 ? {} : { delivery: 'server-ack', serverMessageIds: ['final-ack'] } });
  f.receive('独立任务'); await f.replies(); await waitFor(() => f.executions.length === 1);
  assert.equal(f.store.data.records[0].state, 'unknown'); assert.equal(f.sent.length, 1);
  f.executions[0].gate.resolve(); await f.channel.whenIdle();
  const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'sent'); assert.equal(f.sent.length, 2);
  new WorkStore(f.store); assert.equal(f.sent.length, 2);
});

test('native session management tools expose only owned state and cannot continue or cancel another sender task', async t => {
  const f = fixture(t);
  const job = f.channel.work.create({ ...scope, peerId: 'bob', senderId: 'bob' }, 'Bob 的任务');
  f.receive('看下任务状态'); await f.replies();
  await waitFor(() => f.executions.length === 2);
  const input = f.executions[1].input, tools = workModelTools({ surface: 'native', ...input });
  const invoke = async (name, args = {}) => JSON.parse(await tools.find(tool => tool.name === name).execute(args, { signal: input.signal }));
  const data = await invoke('wechat_work_tasks');
  assert(!data.tasks.some(task => task.id === job.id));
  assert.equal((await invoke('wechat_work_cancel', { id: job.id })).code, 'WORK_NOT_FOUND');
  assert.equal((await invoke('wechat_work_continue', { id: job.id, request: '修改别人任务' })).code, 'WORK_NOT_FOUND');
  assert.equal(f.channel.work.get(job.id, { ...scope, peerId: 'bob', senderId: 'bob' }).state, 'running');
  assert.equal(f.executions[0].input.signal.aborted, false);
  f.executions[0].gate.resolve(); f.executions[1].gate.resolve(); await f.channel.whenIdle();
});
