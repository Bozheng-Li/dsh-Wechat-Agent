import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel } from '../lib/testing.js';
import { fixtureWorkRouteDecision } from './fixtures/work-dialogue.mjs';

const scope = { accountId: 'router-bot', chatType: 'private', peerId: 'alice', senderId: 'alice' };
function fixture(t, { route = () => ({ action: 'chat' }), execute, chat, rawRoute = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-work-routing-')), store = new StateStore(root);
  const routes = [], chats = [], works = [], sent = [], gates = [];
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [], prompt: 'CHAT_PROMPT_SENTINEL' });
  store.setPersona({ name: '小胖', aliases: ['胖胖'], prompt: 'CHAT_PERSONA_SENTINEL' });
  const config = store.config.snapshot(store.data); config.remote = { globalAdminIds: ['alice', 'bob'] }; store.config.commit(config);
  for (const peer of ['alice', 'bob']) store.setConversationSettings(scope.accountId, 'private', peer,
    { ...store.conversationSettings(scope.accountId, 'private', peer), executionMode: 'work', remoteEnabled: true });
  const runner = { run: async input => {
    if (input.mode === 'work-routing') {
      routes.push(input); const data = JSON.parse(input.text), result = await route(data, input);
      return { text: typeof result === 'string' ? result : JSON.stringify(rawRoute ? result : fixtureWorkRouteDecision(data, result)) };
    }
    if (input.mode === 'work-result') return { text: JSON.parse(input.text).result };
    chats.push(input); return chat ? chat(input) : { text: '聊天回应' };
  } };
  const channel = new WechatChannel({ store, runner,
    workRunner: { run: async input => {
      works.push(input); await input.onSession(input.sessionId ?? 'route-session-' + works.length);
      if (execute) return execute(input, gates);
      return { text: '工作结果' };
    } }, transport: { status: () => ({ online: true, account: { id: scope.accountId } }), send: async payload => {
      sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['route-ack-' + sent.length] };
    } } });
  let serial = 0;
  const receive = (text, peer = 'alice') => channel.receive({ id: 'route-msg-' + ++serial, direction: 'incoming',
    chatType: 'private', peerId: peer, sender: { id: peer }, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }] }, scope.accountId);
  const replies = async () => { while (channel.workReplies.size) await Promise.allSettled([...channel.workReplies.values()].map(lane => lane.pending)); };
  t.after(async () => {
    gates.forEach(gate => gate.resolve()); await channel.close();
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-work-routing-/); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { store, channel, routes, chats, works, sent, receive, replies, gates };
}

test('enabled work mode returns greetings to persona chat and persists only chat messages', async t => {
  const f = fixture(t); f.receive('小胖，今天好累'); await f.channel.whenIdle();
  assert.equal(f.routes.length, 1); assert.equal(f.chats.length, 1); assert.equal(f.works.length, 0);
  assert.equal(f.chats[0].persona.name, '小胖');
  assert(!f.chats[0].tools.some(tool => tool.name.startsWith('wechat_work_')));
  assert(f.store.history(scope.accountId, 'private', 'alice').some(entry => entry.text === '小胖，今天好累'));
  assert(f.channel.memory.load(scope).entries.some(entry => entry.text === '小胖，今天好累'));
  assert.equal(f.store.conversationSettings(scope.accountId, 'private', 'alice').executionMode, 'work');
});

test('routing and native execution preload only owned work context and expose chat memory solely through a scoped tool', async t => {
  const f = fixture(t, { route: () => ({ action: 'new' }) });
  f.store.remember('chat-sentinel', Date.now() - 2000, { ...scope, key: 'chat-sentinel', mode: 'default',
    state: 'sent', question: 'CHAT_HISTORY_SENTINEL', reply: 'CHAT_REPLY_SENTINEL', createdAt: Date.now() - 2000 });
  f.store.remember('work-sentinel', Date.now() - 1000, { ...scope, key: 'work-sentinel', mode: 'work',
    state: 'sent', question: 'OWN_WORK_CONTEXT', reply: 'OWN_WORK_RESULT', createdAt: Date.now() - 1000 });
  f.store.remember('foreign-work', Date.now() - 500, { ...scope, senderId: 'bob', key: 'foreign-work', mode: 'work',
    state: 'sent', question: 'FOREIGN_WORK_SENTINEL', reply: 'FOREIGN_RESULT', createdAt: Date.now() - 500 });
  const forbidden = () => assert.fail('work read chat context');
  f.channel.context = forbidden; f.channel.longMemory.capture = forbidden;
  f.receive('创建报告文件'); await f.channel.whenIdle();
  assert.equal(f.works.length, 1); const input = f.routes[0];
  assert.deepEqual(input.tools, []); assert.deepEqual(JSON.parse(input.text).history,
    [{ user: 'OWN_WORK_CONTEXT', assistant: 'OWN_WORK_RESULT' }]);
  assert(!JSON.stringify(input).includes('CHAT_')); assert(!JSON.stringify(input).includes('FOREIGN_'));
  for (const key of ['persona', 'prompt', 'history', 'memory', 'speaker', 'account']) assert.equal(f.works[0][key], undefined);
  assert(f.works[0].memoryTools.some(tool => tool.name === 'wechat_memory'));
  assert(!JSON.stringify({ request: f.works[0].request, tools: f.works[0].memoryTools.map(({ name, description, parameters }) => ({ name, description, parameters })) }).includes('CHAT_HISTORY_SENTINEL'));
  assert(!f.store.history(scope.accountId, 'private', 'alice').some(entry => entry.text === '创建报告文件'));
});

test('active work neither absorbs small talk nor blocks the same sender chatting', async t => {
  const started = Promise.withResolvers();
  const f = fixture(t, { route: data => ({ action: data.message === '写报告' ? 'new' : 'chat' }),
    execute: async (_input, gates) => { const gate = Promise.withResolvers(); gates.push(gate); started.resolve(); await gate.promise; return { text: '报告完成' }; } });
  f.receive('写报告'); await started.promise; await f.replies();
  f.receive('谢谢，今天累了'); await f.replies();
  assert.equal(f.works.length, 1); assert.equal(f.chats.length, 1);
  assert.equal(f.channel.work.list(scope).jobs.length, 1); assert.equal(f.channel.work.list(scope).jobs[0].state, 'running');
  assert(f.sent.some(payload => JSON.stringify(payload).includes('聊天回应')));
  f.gates[0].resolve(); await f.channel.whenIdle();
});

test('explicit new work is independent and a targeted continuation reuses only its selected session', async t => {
  let target;
  const f = fixture(t, { route: data => ({ action: data.message === '修正第一份报告' ? 'continue' : 'new',
    taskId: data.message === '修正第一份报告' ? target : null }) });
  f.receive('生成第一份报告'); await f.channel.whenIdle(); target = f.channel.work.list(scope).jobs[0].id;
  f.receive('/work new 创建无关的新脚本'); await f.channel.whenIdle();
  assert.notEqual(f.works[0].cwd, f.works[1].cwd); assert.equal(f.works[1].sessionId, null);
  f.receive('修正第一份报告'); await f.channel.whenIdle();
  assert.equal(f.works[2].cwd, f.works[0].cwd); assert.equal(f.works[2].sessionId, 'route-session-1');
  assert.equal(f.works[2].request, '修正第一份报告');
});

for (const bad of ['not-json', { action: 'new', request: '替换用户原话' }, { action: 'continue', taskId: 'ffffffffffff' },
  { action: 'cancel' }, { action: 'new', taskId: 'ffffffffffff' }]) test(`invalid route does not create work: ${JSON.stringify(bad)}`, async t => {
  const f = fixture(t, { route: () => bad }); f.receive('帮我处理'); await f.channel.whenIdle();
  assert.equal(f.works.length, 0); assert.equal(f.channel.work.list(scope).jobs.length, 0);
  assert.equal(f.chats.length, 1); assert.equal(f.routes.length, 1);
  assert(f.sent.some(payload => JSON.stringify(payload).includes('聊天回应')));
  assert(!JSON.stringify(f.sent).includes('还没有启动或修改任务'));
});

test('classifier failure falls back truthfully and never executes the original message', async t => {
  const f = fixture(t, { route: () => { throw Error('provider-private-details'); } });
  f.receive('做点事情'); await f.channel.whenIdle(); assert.equal(f.works.length, 0);
  assert(!JSON.stringify(f.sent).includes('provider-private-details'));
  assert.equal(f.store.data.records.at(-1).workRoute.action, 'chat');
  assert.equal(f.chats.length, 1); assert.equal(f.routes.length, 1);
  assert(f.sent.some(payload => JSON.stringify(payload).includes('聊天回应')));
});

test('a decision missing its internal review falls back to ordinary chat without a repair request', async t => {
  const f = fixture(t, { route: () => ({ action: 'new', taskId: null }), rawRoute: true });
  f.receive('创建一份报告'); await f.channel.whenIdle();
  assert.equal(f.routes.length, 1); assert.equal(f.works.length, 0); assert.equal(f.chats.length, 1);
  assert.equal(f.store.data.records.at(-1).workRoute.fallback, 'WORK_ROUTE_INVALID');
  assert(!JSON.stringify(f.sent).includes('我暂时没能判断'));
});

for (const change of ['chat', 'revoke']) test(`changing ${change} during classification prevents execution and stale replies`, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { route: async () => { started.resolve(); await release.promise; return { action: 'new' }; } });
  t.after(() => release.resolve()); f.receive('创建文件'); await started.promise;
  const current = f.store.conversationSettings(scope.accountId, 'private', 'alice');
  f.store.setConversationSettings(scope.accountId, 'private', 'alice', { ...current,
    ...(change === 'chat' ? { executionMode: 'chat' } : { remoteEnabled: false }) });
  release.resolve(); await f.channel.whenIdle();
  assert.equal(f.works.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.store.data.records.at(-1).state, 'cancelled');
});

test('global chat mode never invokes classification or native work even for a work-like request', async t => {
  const f = fixture(t, { route: () => assert.fail('chat invoked work classification') });
  const current = f.store.conversationSettings(scope.accountId, 'private', 'alice');
  f.store.setConversationSettings(scope.accountId, 'private', 'alice', { ...current, executionMode: 'chat' });
  f.receive('帮我生成报告文件'); await f.channel.whenIdle();
  assert.equal(f.routes.length, 0); assert.equal(f.works.length, 0); assert.equal(f.chats.length, 1);
});

test('model-selected status reads the existing result without creating or continuing work', async t => {
  const f = fixture(t, { route: data => data.message === '写报告' ? { action: 'new' }
    : { action: 'status', taskId: data.currentTaskId } });
  f.receive('写报告'); await f.channel.whenIdle(); f.receive('现在完成了吗'); await f.channel.whenIdle();
  assert.equal(f.works.length, 1); assert.equal(f.channel.work.list(scope).jobs.length, 1);
  assert(f.sent.some(payload => JSON.stringify(payload).includes('工作结果')));
});

test('an all-task status decision returns both owned tasks without creating new work', async t => {
  const f = fixture(t, { route: () => ({ action: 'status', taskId: null }) });
  f.receive('/work new 第一份财务报告'); await f.channel.whenIdle();
  f.receive('/work new 第二份运营报告'); await f.channel.whenIdle();
  const jobs = f.channel.work.list(scope).jobs, sentBefore = f.sent.length;
  f.receive('看看我全部任务的状态'); await f.channel.whenIdle();
  assert.equal(f.works.length, 2); assert.equal(f.channel.work.list(scope).jobs.length, 2);
  const response = JSON.stringify(f.sent.slice(sentBefore));
  for (const job of jobs) assert(response.includes(job.request));
  assert.equal(jobs.filter(job => job.state === 'succeeded').length, 2);
  assert.equal((response.match(/本轮执行已结束/g) ?? []).length, 2);
  assert.equal(f.chats.length, 0);
});

test('an explicit empty all-task query returns the real empty list without chatting or executing', async t => {
  const f = fixture(t, { route: () => ({ action: 'status', taskId: null }) });
  f.receive('查看我的全部任务'); await f.channel.whenIdle();
  assert.equal(f.works.length, 0); assert.equal(f.chats.length, 0);
  assert.equal(f.channel.work.list(scope).jobs.length, 0);
  assert(JSON.stringify(f.sent).includes('没有工作任务'));
});

test('a real task belonging to another sender is rejected even when the model returns its correct ID', async t => {
  let foreignId;
  const f = fixture(t, { route: data => data.message === 'Bob 的报告' ? { action: 'new' }
    : { action: 'continue', taskId: foreignId } });
  f.receive('Bob 的报告', 'bob'); await f.channel.whenIdle();
  foreignId = f.channel.work.list({ ...scope, peerId: 'bob', senderId: 'bob' }).jobs[0].id;
  f.receive('修改他的报告'); await f.channel.whenIdle();
  assert.equal(f.works.length, 1); assert.equal(f.channel.work.list(scope).jobs.length, 0);
  assert.equal(f.store.data.records.at(-1).workRoute.fallback, 'WORK_ROUTE_INVALID');
});

test('a model-selected cancellation stops only the chosen owned task and creates no replacement work', async t => {
  const started = Promise.withResolvers(); let abortSignal;
  const f = fixture(t, { route: data => data.message === '写报告' ? { action: 'new' }
    : { action: 'cancel', taskId: data.currentTaskId },
    execute: async input => {
      abortSignal = input.signal; started.resolve();
      await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
      return { text: '不会到达' };
    } });
  f.receive('写报告'); await started.promise; await f.replies();
  f.receive('停止这份报告'); await f.channel.whenIdle();
  assert.equal(abortSignal.aborted, true); assert.equal(f.works.length, 1);
  assert.equal(f.channel.work.list(scope).jobs.length, 1); assert.equal(f.channel.work.list(scope).jobs[0].state, 'cancelled');
});

test('chat selected after a delayed judgment does not inherit messages received after its trigger', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { route: async () => { started.resolve(); await release.promise; return { action: 'chat' }; } });
  t.after(() => release.resolve());
  f.receive('先聊一下'); await started.promise;
  const record = f.store.data.records[0], later = record.createdAt + 100;
  const message = { id: 'later-message', direction: 'incoming', chatType: 'private', peerId: 'alice',
    sender: { id: 'alice' }, time: later / 1000, message: [{ type: 'text', data: { text: 'FUTURE_CHAT_SENTINEL' } }] };
  f.store.remember('later-message', later, { ...scope, key: 'later-message', createdAt: later, mode: 'default', state: 'observed' },
    { accountId: scope.accountId, message });
  release.resolve(); await f.channel.whenIdle();
  assert.equal(f.chats.length, 1); assert(!JSON.stringify(f.chats[0]).includes('FUTURE_CHAT_SENTINEL'));
  assert.deepEqual(f.store.history(scope.accountId, 'private', 'alice').filter(entry => entry.direction === 'incoming').map(entry => entry.text),
    ['先聊一下', 'FUTURE_CHAT_SENTINEL']);
});

test('ordinary image requests reuse the same native session even when the classifier returns new twice', async t => {
  const f = fixture(t, { route: () => ({ action: 'new' }) });
  const requests = ['小胖，生成一张奥特曼打怪兽的图片', '再生成一张多个奥特曼多个怪兽的'];
  f.receive(requests[0]); await f.channel.whenIdle(); const first = f.channel.work.list(scope).jobs[0];
  f.receive(requests[1]); await f.channel.whenIdle(); const second = f.channel.work.list(scope).jobs[0];
  assert.equal(f.routes.length, 2); assert.equal(f.chats.length, 0); assert.equal(f.works.length, 2);
  assert.equal(second.continues, first.id); assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.cwd, first.cwd); assert.equal(f.works[1].sessionId, first.sessionId);
  assert.equal(f.works[0].request, requests[0]); assert.equal(f.works[1].request, requests[1]);
  const bobScope = { ...scope, peerId: 'bob', senderId: 'bob' };
  f.receive('生成 Bob 的图片', 'bob'); await f.channel.whenIdle();
  assert.notEqual(f.channel.work.list(bobScope).jobs[0].sessionId, second.sessionId);
  assert.notEqual(f.works[2].cwd, second.cwd);
});

test('ordinary routed work queues on the same session while the previous request is still running', async t => {
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  const f = fixture(t, { route: () => ({ action: 'new' }), execute: async (input, gates) => {
    if (input.request === '先创建文件') { gates.push(released); started.resolve(); await released.promise; }
    return { text: '工作结果' };
  } });
  f.receive('先创建文件'); await started.promise; await f.replies();
  const first = f.channel.work.list(scope).jobs[0];
  f.receive('再修改这个文件'); await f.replies(); const second = f.channel.work.list(scope).jobs[0];
  assert.equal(second.continues, first.id); assert.equal(second.state, 'queued'); assert.equal(f.works.length, 1);
  released.resolve(); await f.channel.whenIdle();
  const finished = f.channel.work.get(second.id, scope);
  assert.equal(f.works.length, 2); assert.equal(finished.sessionId, first.sessionId); assert.equal(finished.cwd, first.cwd);
});

test('routing context bounds work dialogue and includes only owned acknowledged results before this message', async t => {
  const f = fixture(t, { execute: () => ({ text: '真实结果开头' + '完成内容'.repeat(300) + '需要确认的结果尾部' }) });
  const request = '生成报告，' + '任务背景'.repeat(300) + '最后要求导出 PDF';
  f.receive('/work ' + request); await f.channel.whenIdle();
  const job = f.channel.work.list(scope).jobs[0], at = Date.now() - 1000;
  f.channel.work.store.update(job.id, { result: { ...job.result, artifacts: Array.from({ length: 10 }, (_, index) => ({
    name: '成果' + '🧩'.repeat(200) + index + '.pdf',
  })) } });
  for (let i = 0; i < 6; i++) f.store.remember('bounded-work-' + i, at + i, { ...scope, key: 'bounded-work-' + i,
    mode: 'work', state: 'sent', question: '请求开头' + '🧩'.repeat(500) + '请求尾部' + i,
    reply: '答复开头' + '🧩'.repeat(500) + '答复尾部' + i, createdAt: at + i });
  for (const [key, patch] of [
    ['foreign-result', { senderId: 'bob', reply: 'FOREIGN_RESULT_SENTINEL' }],
    ['unacknowledged-result', { state: 'failed', reply: 'UNACKNOWLEDGED_RESULT_SENTINEL' }],
    ['progress-result', { workProgress: true, reply: 'PROGRESS_SENTINEL' }],
    ['future-result', { createdAt: Date.now() + 100000, reply: 'FUTURE_RESULT_SENTINEL' }],
    ['late-sent-result', { sentAt: Date.now() + 100000, reply: 'LATE_SENT_RESULT_SENTINEL' }],
  ]) f.store.remember(key, at, { ...scope, key, mode: 'scheduled', state: 'sent', workJobId: job.id, createdAt: at, ...patch });
  f.store.remember('late-sent-work', at, { ...scope, key: 'late-sent-work', mode: 'work', state: 'sent',
    question: 'LATE_SENT_WORK_SENTINEL', reply: '还没送到用户的工作确认', createdAt: at, sentAt: Date.now() + 100000 });
  f.receive('结果里说的那个是什么'); await f.channel.whenIdle();
  const input = JSON.parse(f.routes.at(-1).text);
  assert.equal(input.history.length, 4);
  for (const row of input.history) {
    assert(row.truncated); assert(Array.from(row.user).length <= 400); assert(Array.from(row.assistant).length <= 400);
    assert(row.user.includes('请求尾部')); assert(row.assistant.includes('答复尾部'));
    assert(!/\uFFFD/u.test(row.user + row.assistant));
  }
  const current = input.tasks.find(task => task.id === job.id);
  assert(current.requestTruncated); assert(Array.from(current.request).length <= 600);
  assert(current.request.endsWith('最后要求导出 PDF'));
  assert(current.filesTruncated); assert.equal(current.files.length, 3);
  assert(current.files.every(file => Array.from(file.name).length <= 120 && file.name.endsWith('.pdf')));
  assert.equal(input.workResults.length, 1); assert.equal(input.workResults[0].taskId, job.id);
  assert(input.workResults[0].truncated); assert(Array.from(input.workResults[0].result).length <= 800);
  assert(input.workResults[0].result.includes('需要确认的结果尾部'));
  assert(!/FOREIGN_RESULT_SENTINEL|UNACKNOWLEDGED_RESULT_SENTINEL|PROGRESS_SENTINEL|FUTURE_RESULT_SENTINEL|LATE_SENT_/.test(JSON.stringify(input)));
});

test('only the immediately preceding ambiguous routed chat bridges a work clarification', async t => {
  const f = fixture(t, {
    route: data => data.message === '改一下那个' ? { action: 'chat', review: { intent: 'unclear', evidence: '改一下那个', target: 'ambiguous' } }
      : { action: 'continue', taskId: data.currentTaskId },
    chat: () => ({ text: '你是指报告里的颜色吗？' }),
  });
  f.receive('/work 创建带颜色的报告'); await f.channel.whenIdle();
  f.receive('改一下那个'); await f.channel.whenIdle();
  f.receive('对，改成蓝色'); await f.channel.whenIdle();
  const input = JSON.parse(f.routes.at(-1).text);
  assert.deepEqual(input.clarification, { user: '改一下那个', assistant: '你是指报告里的颜色吗？' });
  assert.equal(f.works.length, 2); assert.equal(f.works[1].request, '对，改成蓝色');
});

test('clarification does not import ordinary chat or an old ambiguity without work context', async t => {
  const f = fixture(t, { route: () => ({ action: 'chat', review: { intent: 'unclear', evidence: '', target: 'ambiguous' } }) });
  f.receive('帮我弄一下'); await f.channel.whenIdle();
  f.receive('就那个'); await f.channel.whenIdle();
  assert.equal(JSON.parse(f.routes.at(-1).text).clarification, null);
  f.receive('/work 创建文件'); await f.channel.whenIdle();
  f.receive('改一下那个'); await f.channel.whenIdle();
  const at = Date.now() - 1;
  f.store.remember('ordinary-chat', at, { ...scope, key: 'ordinary-chat', mode: 'default', state: 'sent',
    question: 'ORDINARY_CHAT_SENTINEL', reply: 'ORDINARY_REPLY_SENTINEL', createdAt: at });
  f.receive('继续'); await f.channel.whenIdle();
  const data = JSON.parse(f.routes.at(-1).text);
  assert.equal(data.clarification, null); assert(!JSON.stringify(data).includes('ORDINARY_'));
});

test('a clarification acknowledged after the current message is not treated as user-visible context', async t => {
  const f = fixture(t);
  f.receive('/work 创建文件'); await f.channel.whenIdle();
  const at = Date.now() - 1000;
  f.store.remember('late-clarification', at, { ...scope, key: 'late-clarification', mode: 'default', state: 'sent',
    question: '你能改一下吗', reply: 'LATE_CLARIFICATION_SENTINEL', createdAt: at, sentAt: Date.now() + 100000,
    workRoute: { action: 'chat', review: { intent: 'unclear', evidence: '', target: 'ambiguous' } } });
  f.receive('可以'); await f.channel.whenIdle();
  const data = JSON.parse(f.routes.at(-1).text);
  assert.equal(data.clarification, null); assert(!JSON.stringify(data).includes('LATE_CLARIFICATION_SENTINEL'));
});
