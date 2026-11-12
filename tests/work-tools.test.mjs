import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore, WechatChannel, ChannelError, ImageGenerationService, workModelTools, modelToolList, registerModelTools, workDialogueState } from '../lib/testing.js';
import { fixtureWorkRoute } from './fixtures/work-dialogue.mjs';
import { stickerPng } from './fixtures/stickers.mjs';

const scope = { accountId: 'tools-owner', chatType: 'private', peerId: 'alice', senderId: 'alice' };
const signal = () => new AbortController().signal;
const invoke = async (input, name, args = {}) => JSON.parse(await input.tools.find(tool => tool.name === name).execute(args, { signal: input.signal }));
const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, 'native work did not reach the expected state'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const imageBytes = stickerPng();

function fixture(t, model = input => ({ text: '原生任务结果：' + input.request })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-work-tools-')), store = new StateStore(root);
  const sent = [], apiCalls = [], workCalls = [], state = { online: true, account: { id: scope.accountId } };
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [], prompt: 'CHAT_SENTINEL' });
  const admins = store.config.snapshot(store.data); admins.remote = { globalAdminIds: ['alice', 'bob'] }; store.config.commit(admins);
  for (const peer of ['alice', 'bob']) store.setConversationSettings(scope.accountId, 'private', peer,
    { ...store.conversationSettings(scope.accountId, 'private', peer), executionMode: 'work', remoteEnabled: true });
  const runner = { run: async input => {
    if (input.mode === 'work-routing') return fixtureWorkRoute(input);
    if (input.mode === 'default') return { text: '普通聊天回复' };
    apiCalls.push(input); assert.equal(input.mode, 'work-result'); assert.deepEqual(input.tools, []);
    return { text: JSON.parse(input.text).result };
  } };
  const workRunner = { run: async input => {
    await input.onSession('tools-session-' + path.basename(input.cwd), { native: true });
    const call = { ...input, tools: workModelTools({ surface: 'native', ...input }) };
    workCalls.push(call);
    return { ...await model(call), native: true };
  } };
  const transport = { status: () => state, send: async payload => {
    sent.push(payload);
    const deliveryParts = payload.message.map((part, index) => ({ index, type: part.type, state: 'acknowledged', serverMessageId: `tools-ack-${sent.length}-${index}`,
      ...(part.type === 'text' ? {} : { name: part.data.name, bytes: Buffer.from(part.data.base64, 'base64').length,
        sha256: createHash('sha256').update(Buffer.from(part.data.base64, 'base64')).digest('hex') }) }));
    return { delivery: 'server-ack', serverMessageIds: deliveryParts.map(part => part.serverMessageId), deliveryParts };
  } };
  const channel = new WechatChannel({ store, runner, workRunner, transport });
  let serial = 0;
  const receive = (text, peerId = 'alice') => channel.receive({ id: 'tools-message-' + ++serial, direction: 'incoming', chatType: 'private', peerId,
    sender: { id: peerId }, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] }, scope.accountId);
  t.after(async () => {
    await channel.close(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-work-tools-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, channel, sent, apiCalls, workCalls, state, receive };
}

test('work registry publishes execution and session capabilities independently of the request wording', () => {
  const context = { cwd: os.tmpdir(), request: '只是一个问题', limits: { commandTimeoutSeconds: 1 },
    assertAllowed() {}, onOperation() {}, connections: {}, queryStatus() {},
    imageGeneration: { catalog: () => ({ enabled: true, defaultProviderId: 'images', providers: [{ providerId: 'images', models: ['image-one', 'image-two'] }] }) } };
  const execution = workModelTools({ surface: 'task', ...context });
  assert.deepEqual(execution.map(tool => tool.name).sort(), [
    'wechat_work_exec', 'wechat_work_generate_image', 'wechat_work_list', 'wechat_work_output', 'wechat_work_read',
    'wechat_work_ssh_connect', 'wechat_work_ssh_exec', 'wechat_work_status', 'wechat_work_vscode_connect', 'wechat_work_write',
  ]);
  assert.deepEqual(execution.find(tool => tool.name === 'wechat_work_generate_image').parameters.properties.model.enum, ['image-one', 'image-two']);
  const member = workModelTools({ surface: 'task', ...context, connections: undefined, queryStatus: undefined });
  assert(!member.some(tool => /ssh|vscode|status/.test(tool.name)));
  const native = workModelTools({ surface: 'native', ...context, sessionManagement: {
    channel: { store: { settings: () => ({ enabled: false }) }, work: { imageGeneration: context.imageGeneration } }, scope, signal: signal(), taskState() {}, createTask() {},
  } });
  assert.equal(native.length, 17); assert.equal(new Set(native.map(tool => tool.name)).size, 17);
  assert.equal(native.find(tool => tool.name === 'wechat_work_generate_image').description, execution.find(tool => tool.name === 'wechat_work_generate_image').description);
  assert.throws(() => workModelTools({ surface: 'unknown' }), TypeError);
});

test('registry validates duplicate dispatch and preserves native tools while enforcing session authorization', () => {
  const tool = { name: 'wechat_work_example', execute() {} }, modes = [], registered = [], restrictions = [];
  let allowed = true, guard;
  const ctx = { tools: { presentAs: mode => modes.push(mode), restrict: rule => restrictions.push(rule), register: definition => registered.push(definition), guard: value => { guard = value; } } };
  assert.throws(() => modelToolList([tool, tool]), { code: 'MODEL_TOOLS_INVALID' });
  assert.throws(() => registerModelTools(ctx, [tool, tool], { native: true, inherit: true }), { code: 'MODEL_TOOLS_INVALID' });
  assert.equal(registered.length, 0); assert.equal(modes.length, 0);
  const assertAllowed = () => { if (!allowed) throw new ChannelError('WORK_NOT_AUTHORIZED', '权限已撤销'); };
  registerModelTools(ctx, [tool], { native: true, inherit: true, assertAllowed });
  assert.deepEqual(modes, ['native']); assert.deepEqual(restrictions, []);
  assert.equal(guard({ name: tool.name }), undefined); assert.equal(guard({ name: 'native_dsh_exec' }), undefined);
  allowed = false; assert.equal(guard({ name: 'native_dsh_exec' }), '权限已撤销');
  allowed = true; registerModelTools(ctx, [tool], { assertAllowed });
  assert.deepEqual(restrictions, [{ allow: [] }]); assert.equal(typeof guard({ name: 'native_dsh_exec' }), 'string');
});

test('greetings, capability questions, quotes and negations stay in chat without creating native tasks', async t => {
  const requests = ['你好', '能不能并行多开 DSH？', '不要生成图片，只解释怎么调用', '“帮我运行代码”是什么意思'];
  const f = fixture(t, input => {
    assert(input.tools.some(tool => tool.name === 'wechat_work_parallel')); assert.equal(input.workContext, undefined);
    assert.equal(input.history, undefined); assert.equal(input.prompt, undefined);
    return { text: '由原生 DSH 决定的直接回答' };
  });
  for (const text of requests) { f.receive(text); await f.channel.whenIdle(); }
  f.receive('/work status'); await f.channel.whenIdle();
  assert.deepEqual(f.workCalls, []); assert.equal(f.apiCalls.length, 0);
  assert.equal(f.channel.work.list(scope).jobs.length, 0);
  assert.deepEqual(f.store.history(scope.accountId, scope.chatType, scope.peerId).filter(entry => entry.direction === 'incoming').map(entry => entry.text), requests);
});

test('a native parent can start parallel children with distinct IDs, sessions and directories', async t => {
  const running = [], f = fixture(t, async input => {
    if (input.request === '分别处理两个独立目标') {
      const result = await invoke(input, 'wechat_work_parallel', { requests: ['处理目标甲', '处理目标乙'] });
      assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.tasks.length, 2);
      return { text: '两个目标已安排，完成后分别回传。' };
    }
    return new Promise((resolve, reject) => { running.push({ input, resolve }); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); });
  });
  f.receive('分别处理两个独立目标'); await until(() => running.length === 2 && !f.channel.workReplies.size);
  const jobs = f.channel.work.list(scope).jobs;
  assert.equal(jobs.length, 3); assert.equal(f.channel.work.active.size, 2);
  for (const key of ['id', 'cwd', 'sessionId']) assert.equal(new Set(jobs.map(job => job[key])).size, 3, key);
  assert(jobs.every(job => job.peerId === scope.peerId && job.senderId === scope.senderId));
  f.receive(`/work status ${jobs.find(job => job.state === 'running').id}`);
  await until(() => f.sent.some(payload => JSON.stringify(payload).includes('正在执行')));
  assert.equal(f.workCalls.length, 3);
  for (const item of running) item.resolve({ text: '结果已核对' });
  await f.channel.whenIdle(); assert(f.channel.work.list(scope).jobs.every(job => job.state === 'succeeded' && job.delivery.state === 'sent'));
});

test('host status is a native task tool choice and the chat API only polishes its result', async t => {
  let reads = 0;
  const f = fixture(t, async input => { const result = await invoke(input, 'wechat_work_status', { action: 'tasks' }); assert.equal(result.ok, true); return { text: result.text }; });
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: ['alice'] }; f.store.config.commit(next);
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId, { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true });
  f.channel.remote.tasks = () => { reads++; return { observedAt: Date.now(), total: 0, running: 0, tasks: [], backgroundJobs: [] }; };
  f.receive('/dsh tasks'); await f.channel.whenIdle();
  assert.equal(reads, 1); assert.equal(f.workCalls.length, 1); assert.equal(f.workCalls[0].request, '/dsh tasks');
  assert.equal(f.apiCalls.length, 1); assert.equal(f.channel.work.list(scope).jobs.length, 1);
});

test('session tools validate a whole parallel batch and report partial creation without repeating saved tasks', async t => {
  const f = fixture(t); let count = 0;
  const tools = workModelTools({ surface: 'dialogue', channel: f.channel, scope, signal: signal(), request: '并行处理',
    taskState: () => workDialogueState(f.channel, scope), createdTaskCount: () => count, createTask: request => {
      if (count === 1) throw new ChannelError('WORK_QUEUE_FULL', '工作队列已满'); count++; return { task: { id: '111111111111', request, state: 'queued' } };
    } });
  const input = { tools, signal: signal() };
  assert.equal((await invoke(input, 'wechat_work_parallel', { requests: ['处理甲', ' '] })).ok, false); assert.equal(count, 0);
  const result = await invoke(input, 'wechat_work_parallel', { requests: ['处理甲', '处理乙'] });
  assert.equal(result.ok, false); assert.equal(result.complete, false); assert.equal(result.tasks.length, 1); assert.equal(count, 1); assert.equal(result.error.code, 'WORK_QUEUE_FULL');
});

test('native image tool sends model-selected API parameters without replacing the original task message', async t => {
  const requests = [], selected = { prompt: '橙猫海报，保留标题', path: 'poster.png', providerId: 'second', model: 'image-pro', size: '2048x2048' };
  const message = '请使用 second 的 image-pro 生成海报';
  const f = fixture(t, async input => {
    assert.equal(input.request, message); assert.equal(input.imageRequest, undefined);
    const result = await invoke(input, 'wechat_work_generate_image', selected); assert.equal(result.ok, true); return { text: 'poster.png 已生成。' };
  });
  const config = f.store.config.snapshot(f.store.data);
  config.imageGeneration = { enabled: true, defaultProviderId: 'first', providers: [
    { id: 'first', name: 'First', endpoint: 'https://first.invalid/v1', models: ['image-basic'], defaultModel: 'image-basic' },
    { id: 'second', name: 'Second', endpoint: 'https://second.invalid/v1', models: ['image-pro'], defaultModel: 'image-pro' },
  ] }; f.store.config.commit(config);
  f.channel.work.imageGeneration = new ImageGenerationService({ credentials: { resolve: async () => ({ value: 'synthetic-key' }) } }, f.store,
    { fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return Response.json({ data: [{ b64_json: imageBytes.toString('base64') }] }); } });
  f.receive(message); await f.channel.whenIdle();
  assert.deepEqual(requests, [{ url: 'https://second.invalid/v1/images/generations', body: { model: 'image-pro', prompt: selected.prompt, size: selected.size, n: 1 } }]);
  const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.request, message); assert.equal(job.imageRequest, undefined); assert.equal(job.delivery.artifacts[0].state, 'sent');
  assert.deepEqual(fs.readFileSync(path.join(job.cwd, 'poster.png')), imageBytes);
});

function configureImageFixture(f, requests) {
  const config = f.store.config.snapshot(f.store.data);
  config.imageGeneration = { enabled: true, defaultProviderId: '0809', providers: [
    { id: '0809', name: '0809', endpoint: 'https://0809.invalid/v1', models: ['gpt-image-2'], defaultModel: 'gpt-image-2', size: '1536x1024' },
    { id: 'elysiver', name: 'Elysiver', endpoint: 'https://elysiver.invalid/v1', models: ['gpt-image-2'], defaultModel: 'gpt-image-2' },
  ] }; f.store.config.commit(config);
  f.channel.work.imageGeneration = new ImageGenerationService({ credentials: { resolve: async () => ({ value: 'private-image-key' }) } }, f.store,
    { fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return Response.json({ data: [{ b64_json: '', url: '' }] }); } });
}

test('legacy typed image calls retain selected defaults through configuration changes without fallback or repeat', async t => {
  const requests = []; let f;
  f = fixture(t, async input => {
    const changed = f.store.config.snapshot(f.store.data); changed.imageGeneration.defaultProviderId = 'elysiver'; f.store.config.commit(changed);
    const wrong = await invoke(input, 'wechat_work_generate_image', { prompt: '一只小狗', path: 'dog.png', providerId: 'krill' });
    assert.equal(wrong.code, 'WORK_IMAGE_REQUEST_CHANGED'); assert.equal(requests.length, 0);
    const result = await invoke(input, 'wechat_work_generate_image', { prompt: '一只小狗', path: 'dog.png' });
    assert.equal(result.code, 'IMAGE_GENERATION_EMPTY'); assert.equal(result.providerId, '0809'); assert.equal(result.automaticFallback, false);
    assert.equal((await invoke(input, 'wechat_work_generate_image', { prompt: '一只小狗', path: 'dog.png' })).code, 'WORK_IMAGE_ALREADY_ATTEMPTED');
    return { text: result.message };
  }); configureImageFixture(f, requests);
  const selected = { prompt: '一只小狗', path: 'dog.png', providerId: '0809', model: 'gpt-image-2', size: '1536x1024' };
  const created = f.channel.work.create(scope, selected.prompt, undefined, { imageRequest: selected }); await f.channel.whenIdle();
  const job = f.channel.work.get(created.id, scope);
  assert.deepEqual(job.imageRequest, selected); assert.equal(job.state, 'failed'); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://0809.invalid/v1/images/generations'); assert(!JSON.stringify(job).includes('private-image-key'));
});

test('native empty image failures name 0809 and cannot charge the same request again under a new output filename', async t => {
  const requests = [], message = '生成一张小狗的图片给我';
  const f = fixture(t, async input => {
    const result = await invoke(input, 'wechat_work_generate_image', { prompt: '一只小狗', path: 'dog.png' });
    assert.equal(result.code, 'IMAGE_GENERATION_EMPTY'); assert.equal(result.providerId, '0809'); assert.equal(result.model, 'gpt-image-2');
    assert.equal(result.automaticRetry, false); assert.equal(result.automaticFallback, false);
    assert.equal((await invoke(input, 'wechat_work_generate_image', { prompt: '一只小狗', path: 'another-dog.png' })).code, 'WORK_IMAGE_ALREADY_ATTEMPTED');
    return { text: result.message };
  }); configureImageFixture(f, requests);
  f.receive(message); await f.channel.whenIdle();
  const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.request, message); assert.equal(job.imageRequest, undefined); assert.equal(job.state, 'failed'); assert.equal(requests.length, 1);
  assert.equal(requests[0].body.size, '1536x1024'); assert.equal(job.result.artifacts.length, 0); assert.equal(fs.existsSync(path.join(job.cwd, 'dog.png')), false);
});

test('session task detail and cancel keep the verified conversation and sender scope on every call', async t => {
  const f = fixture(t);
  const job = f.channel.work.create({ ...scope, peerId: 'bob', senderId: 'bob' }, '另一个会话的任务', undefined, { defer: true });
  const input = { tools: workModelTools({ surface: 'dialogue', channel: f.channel, scope, signal: signal(), request: '查看任务',
    taskState: id => workDialogueState(f.channel, scope, id), createTask() {} }), signal: signal() };
  assert.equal((await invoke(input, 'wechat_work_task', { id: job.id })).code, 'WORK_NOT_FOUND');
  assert.equal((await invoke(input, 'wechat_work_cancel', { id: job.id })).code, 'WORK_NOT_FOUND');
  assert.equal(f.channel.work.get(job.id, { ...scope, peerId: 'bob', senderId: 'bob' }).state, 'queued');
  f.state.online = false; await assert.rejects(invoke(input, 'wechat_work_tasks'), { code: 'WORK_NOT_AUTHORIZED' });
});

test('standalone native requests do not preload old work task or dialogue bodies', async t => {
  const message = '生成一张小狗的图片给我';
  const f = fixture(t, input => { assert.equal(input.request, message); assert.equal(input.workContext, undefined); assert.equal(input.history, undefined); return { text: 'DSH 的独立回答' }; });
  const job = f.channel.work.create(scope, 'OLD_SSH_REQUEST：查看远端八卡实验', undefined, { defer: true }); f.channel.work.cancel(job.id, scope);
  f.channel.work.store.update(job.id, { result: { text: 'OLD_TASK_RESULT：本机沙箱失败，不能并行', files: [] } });
  const createdAt = Date.now() - 1000;
  f.store.remember('old-dialogue', createdAt, { ...scope, key: 'old-dialogue', mode: 'work', state: 'sent', createdAt,
    question: 'OLD_SSH_QUESTION', reply: 'OLD_REPLY：前面的任务处理完再开始', createdWorkJobIds: [job.id] });
  f.receive(message); await f.channel.whenIdle();
  assert.equal(f.workCalls.length, 1); assert.equal(f.apiCalls.length, 1); assert.equal(f.channel.work.get(job.id, scope).state, 'cancelled');
  assert(!/OLD_|沙箱|八卡/.test(f.apiCalls[0].text));
});

test('native DSH queries frozen sender history on demand and prior task results require explicit detail', async t => {
  let f, job;
  f = fixture(t, async input => {
    assert.equal(input.request, '刚才那个任务的情况呢');
    const list = await invoke(input, 'wechat_work_tasks');
    assert.equal(list.tasks.length, 2); assert(list.tasks.every(task => task.result === undefined));
    assert.equal(list.tasks.find(task => task.id === job.id).request.length, 160);
    const detail = await invoke(input, 'wechat_work_task', { id: job.id }); assert(detail.tasks[0].result.includes('OLD_VERIFIED_RESULT'));
    const first = await invoke(input, 'wechat_work_history', { limit: 8 });
    assert.equal(first.entries.length, 1); assert.deepEqual(first.entries[0].taskIds, [job.id]); assert.equal(first.entries[0].user, '先前的本发起人问题');
    const createdAt = Date.now() - 5000;
    f.store.remember('late-history', createdAt, { ...scope, key: 'late-history', mode: 'work', state: 'sent', createdAt, question: 'LATE_HISTORY', reply: '稍后才加入的回复' });
    assert.deepEqual(await invoke(input, 'wechat_work_history', { limit: 8 }), first);
    assert.equal((await invoke(input, 'wechat_work_history', { limit: 9 })).code, 'WORK_HISTORY_INVALID');
    return { text: '已读取你刚才的任务记录。' };
  });
  job = f.channel.work.create(scope, '先前任务 '.repeat(100), undefined, { defer: true }); f.channel.work.cancel(job.id, scope);
  f.channel.work.store.update(job.id, { result: { text: 'OLD_VERIFIED_RESULT', files: [] } });
  const createdAt = Date.now() - 1000;
  for (const [key, record] of [
    ['own', { ...scope, question: '先前的本发起人问题', state: 'sent', createdWorkJobIds: [job.id] }],
    ['unknown', { ...scope, question: '未确认投递的问题', state: 'unknown' }],
    ['foreign', { ...scope, peerId: 'bob', senderId: 'bob', question: '其他人的问题', state: 'sent' }],
    ['result', { ...scope, question: '任务结果消息', state: 'sent', workJobId: job.id }],
  ]) f.store.remember(key, createdAt, { key, createdAt, mode: 'work', reply: '先前回复', ...record });
  f.receive('刚才那个任务的情况呢'); await f.channel.whenIdle(); assert.equal(f.workCalls.length, 1);
  f.state.online = false; await assert.rejects(invoke(f.workCalls[0], 'wechat_work_history'), { code: 'WORK_NOT_AUTHORIZED' });
});
