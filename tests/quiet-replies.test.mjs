import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, WORK_PROGRESS_INTERVAL_MS } from '../lib/testing.js';
import { registerModelTools } from '../modules/tools/registry.mjs';

function fixture(t, { workRunner } = {}) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-quiet-'));
  const store = new StateStore(root), sent = [], requests = [], scope = { accountId: 'self', chatType: 'private', peerId: 'alice', senderId: 'alice' };
  store.configure('self', { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  store.setConversationSettings('self', 'private', 'alice', {
    ...store.conversationSettings('self', 'private', 'alice'), remoteEnabled: true, adminIds: ['alice'], executionMode: workRunner ? 'work' : 'chat',
  });
  const runner = { run: async input => { requests.push(input); return { text: '最终结果' }; } };
  const channel = new WechatChannel({ store, runner, workRunner, transport: {
    status: () => ({ online: true, account: { id: 'self' } }),
    send: async request => { sent.push(request); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sent.length] }; },
  } });
  let serial = 0;
  const receive = text => channel.receive({ id: 'message-' + ++serial, time: Math.floor(Date.now() / 1000),
    direction: 'incoming', chatType: 'private', peerId: 'alice', sender: { id: 'alice' },
    message: [{ type: 'text', data: { text } }] }, 'self');
  t.after(async () => { await channel.close(); assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, channel, runner, sent, requests, scope, receive };
}

async function enteredRunner(f, entered) {
  await Promise.race([entered.promise, f.channel.whenIdle().then(() => assert.fail('expected runner did not start'))]);
}

test('chat tools and retries stay silent until one final reply with its own ACK', { timeout: 10000 }, async t => {
  const f = fixture(t), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.runner.run = async input => {
    for (const name of ['wechat_file', 'wechat_file', 'wechat_capabilities', 'wechat_memory', 'wechat_web_search'])
      await input.onBeforeTool(name, { action: 'list' }, { signal: input.signal, callId: name });
    entered.resolve(); await finish.promise; return { text: '核对结果' };
  };
  try {
    f.receive('帮我核对资料'); await enteredRunner(f, entered);
    assert.equal(f.sent.length, 0); assert(f.store.data.records.every(record => !record.toolProgress));
  } finally { finish.resolve(); }
  await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message[0].data.text, '核对结果');
  const record = f.store.data.records.find(record => record.state === 'sent');
  assert.deepEqual(record.acknowledgedMessageIds, ['ack-1']);
});

test('work confirms once, reports every three minutes and delivers a question with its own ACK', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = fixture(t, { workRunner: { run: async input => {
    assert.equal(typeof input.onBeforeTool, 'function'); assert.equal(typeof input.onProgress, 'function');
    for (let index = 0; index < 20; index++) await input.onBeforeTool('wechat_work_read');
    input.onProgress({ kind: 'assistant', at: Date.now(), text: '正在核对文档内容', tools: [] });
    await input.onOperation({ tool: 'wechat_work_exec', result: { ok: true, stdout: 'PRIVATE_OUTPUT' } });
    await input.onSession('quiet-session'); entered.resolve(); return finish.promise;
  } } });
  f.runner.run = async input => {
    f.requests.push(input); assert.equal(input.mode, 'work-progress'); assert.deepEqual(input.tools, []);
    assert(!input.text.includes('PRIVATE_OUTPUT')); assert(JSON.parse(input.text).observations.length <= 12);
    return { text: '正在核对文档内容，修改后的结果还没确认。' };
  };
  const prepared = [], prepare = f.channel.work.prepareArtifacts.bind(f.channel.work);
  f.channel.work.prepareArtifacts = (...args) => { prepared.push(args[0]); return prepare(...args); };
  try {
    f.receive('/work new 修改刚才的文档'); await enteredRunner(f, entered);
    assert.equal(f.sent.length, 1);
    assert.equal(f.store.data.records[0].state, 'sent');
    assert.deepEqual(f.store.data.records[0].acknowledgedMessageIds, ['ack-1']);
    assert.equal(f.store.data.records[0].createdWorkJobIds.length, 1);
    t.mock.timers.tick(WORK_PROGRESS_INTERVAL_MS - 1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 1); assert.equal(f.requests.length, 0);
    const reporter = [...f.channel.work.active.values()][0].progress;
    t.mock.timers.tick(1); await reporter.pending;
    assert.equal(f.sent.length, 2); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.channel.work.list(f.scope).jobs[0].progress.acknowledgedMessageIds, ['ack-2']);
    assert.equal(f.channel.work.list(f.scope).jobs[0].delivery.state, 'not-ready');
    t.mock.timers.tick(WORK_PROGRESS_INTERVAL_MS); await reporter.pending;
    assert.equal(f.sent.length, 3); assert.equal(f.requests.length, 2);
    assert.equal(prepared.length, 0, 'progress never prepares or resends task artifacts');
    assert.equal(f.channel.work.list(f.scope).jobs[0].state, 'running');
  } finally { finish.resolve({ text: '你指的是刚才的预算表吗？' }); }
  await f.channel.whenIdle();
  assert.equal(f.sent.length, 4); assert.equal(f.sent.at(-1).message[0].data.text, '你指的是刚才的预算表吗？');
  assert.equal(prepared.length, 1);
  assert.equal(f.channel.work.list(f.scope).jobs[0].delivery.state, 'sent');
  assert.deepEqual(f.channel.work.list(f.scope).jobs[0].delivery.acknowledgedMessageIds, ['ack-4']);
  t.mock.timers.tick(2 * WORK_PROGRESS_INTERVAL_MS); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 4); assert.equal(f.requests.length, 2);
});

test('cancellation keeps the opening receipt and prevents old progress or results', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = fixture(t, { workRunner: { run: async () => { entered.resolve(); return finish.promise; } } });
  try {
    f.receive('/work new 整理文档'); await enteredRunner(f, entered);
    f.channel.work.cancel(f.channel.work.list(f.scope).jobs[0].id, f.scope);
  } finally { finish.resolve({ text: '已取消的旧结果' }); }
  await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.channel.work.list(f.scope).jobs[0].delivery.state, 'suppressed');
  t.mock.timers.tick(2 * WORK_PROGRESS_INTERVAL_MS); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1); assert.equal(f.requests.length, 0);
});

test('a slow progress model cannot delay final results or send late progress', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), reviewing = Promise.withResolvers(), late = Promise.withResolvers();
  const f = fixture(t, { workRunner: { run: async () => { entered.resolve(); return finish.promise; } } });
  f.runner.run = async input => { f.requests.push(input); reviewing.resolve(); return late.promise; };
  try {
    f.receive('/work new 整理文档'); await enteredRunner(f, entered);
    t.mock.timers.tick(WORK_PROGRESS_INTERVAL_MS); await reviewing.promise;
    finish.resolve({ text: '文档整理好了。' }); await f.channel.whenIdle();
    assert.equal(f.sent.length, 2); assert.equal(f.sent.at(-1).message[0].data.text, '文档整理好了。');
  } finally { finish.resolve({ text: '文档整理好了。' }); late.resolve({ text: '迟到的旧进度' }); }
  t.mock.timers.tick(2 * WORK_PROGRESS_INTERVAL_MS); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 2); assert.equal(f.requests.length, 1);
});

test('an unknown progress ACK is not repeated and does not replace the final result', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = fixture(t, { workRunner: { run: async () => { entered.resolve(); return finish.promise; } } });
  f.channel.transport.send = async request => {
    f.sent.push(request);
    return f.sent.length === 2 ? {} : { delivery: 'server-ack', serverMessageIds: ['ack-' + f.sent.length] };
  };
  try {
    f.receive('/work new 整理文档'); await enteredRunner(f, entered);
    const reporter = [...f.channel.work.active.values()][0].progress;
    t.mock.timers.tick(WORK_PROGRESS_INTERVAL_MS); await reporter.pending;
    assert.equal(f.channel.work.list(f.scope).jobs[0].progress.state, 'unknown');
    assert.equal(f.channel.work.list(f.scope).jobs[0].delivery.state, 'not-ready');
    t.mock.timers.tick(2 * WORK_PROGRESS_INTERVAL_MS); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 2); assert.equal(f.requests.length, 1);
  } finally { finish.resolve({ text: '文档整理好了。' }); }
  await f.channel.whenIdle(); assert.equal(f.sent.length, 3);
  assert.equal(f.channel.work.list(f.scope).jobs[0].delivery.state, 'sent');
});

test('native dispatch keeps authorization checks and quiet guidance for both direct and deferred tools', async () => {
  const hooks = new Map(), events = [], prompts = [], disposers = [], agent = {};
  let allowed = true;
  const ctx = { tools: { restrict() {}, register() {}, guard() {} },
    on(name, callback) { hooks.set(name, callback); return () => hooks.delete(name); },
    systemPrompt: { section(value) { prompts.push(value.text); } } };
  registerModelTools(ctx, [], { agent, quiet: true, onDispose: value => disposers.push(value),
    assertAllowed() { if (!allowed) throw Error('revoked'); },
    onBeforeTool: name => events.push('observed:' + name) });
  await hooks.get('tools/execute')({ agent, name: 'read_file', signal: new AbortController().signal }, async () => events.push('executed'));
  assert.deepEqual(events, ['observed:read_file', 'executed']);
  assert(prompts.some(text => text.includes('静默执行') && text.includes('简短提问')));
  allowed = false;
  await assert.rejects(hooks.get('tools/execute')({ agent, name: 'read_file' }, () => assert.fail('must remain guarded')), /revoked/);
  for (const dispose of disposers.reverse()) dispose();
  registerModelTools(ctx, []);
  assert.equal(prompts.length, 1, 'internal tools do not acquire user-facing reply instructions');
  registerModelTools(ctx, [], { quiet: true });
  assert.equal(prompts.length, 2, 'quiet guidance also applies when no observation callback exists');
  registerModelTools(ctx, [], { quiet: true, workProgressManaged: true });
  assert(prompts[2].includes('简短开工确认') && prompts[2].includes('每 3 分钟'));
  assert(!prompts[2].includes('用户主动询问进度时再回答'));
});
