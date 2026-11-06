import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChannelError, StateStore, WechatChannel, DshAgentRunner, WorkerClient,
  completedText, messageText, validateSettings, acquireLock, rpcHandler,
  validateModelChoice, availableModel, selectModel, publicError
} from '../lib/testing.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(repo, 'storage/tmp'); fs.mkdirSync(base, { recursive: true });
const account = { id: 'wxid_owner', nickname: '微信助手' };
const settings = { enabled: true, privatePeers: ['alice'], groups: ['123@chatroom'], prompt: '' };
function temporary(t) {
  const root = fs.mkdtempSync(path.join(base, 'dsh-unit-'));
  t.after(() => { const relative = path.relative(base, fs.realpathSync(root)); assert(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('dsh-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function message(id, extras = {}) { return {
  id: `wx:alice:${id}`, serverMessageId: String(id), time: Math.floor(Date.now() / 1000),
  direction: 'incoming', chatType: 'private', peerId: 'alice', sender: { id: 'alice', nickname: 'Alice' },
  message: [{ type: 'text', data: { text: `问题 ${id}` } }], ...extras
}; }
function fixture(t, options = {}) {
  const root = temporary(t), store = new StateStore(root); store.configure(account.id, settings);
  const calls = [], sent = [], state = { online: true, account };
  const transport = { status: () => structuredClone(state), send: async (params, signal) => { sent.push(params); return { delivery: 'server-ack', serverMessageIds: [`ack-${sent.length}`] }; } };
  const runner = { run: async input => { calls.push(input); const sessionId = input.sessionId || `session-${calls.length}`; await input.onSession?.(sessionId); return { text: `回答 ${input.text}`, sessionId }; } };
  const channel = new WechatChannel({ store, runner, transport, ...options });
  t.after(async () => { await channel.close(); });
  return { root, store, calls, sent, state, transport, runner, channel, receive: m => channel.receive(m, account.id) };
}
const assistant = (turn, content) => ({ type: 'assistant/message', data: { turn, message: { content } } });
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });

test('settings validate account-bound private/group ID types without enabling defaults', () => {
  assert.deepEqual(validateSettings({ ...settings, privatePeers: ['alice', 'alice'] }), settings);
  assert.throws(() => validateSettings({ ...settings, enabled: 'yes' }), /格式/);
  assert.throws(() => validateSettings({ ...settings, groups: ['alice'] }), /群 ID/);
  assert.throws(() => validateSettings({ ...settings, privatePeers: ['123@chatroom'] }), /私聊 ID/);
});

test('group triggers require native mention of this account or explicit command', () => {
  const group = message(1, { chatType: 'group', peerId: '123@chatroom' });
  assert(messageText(group, account).reason);
  assert(messageText({ ...group, message: [{ type: 'at', data: { qq: 'someone-else' } }, ...group.message] }, account).reason);
  assert.equal(messageText({ ...group, message: [{ type: 'at', data: { qq: account.id } }, { type: 'text', data: { text: '@微信助手\u2005 /agent 你好' } }] }, account).text, '你好');
  assert.equal(messageText({ ...group, message: [{ type: 'text', data: { text: '/agent 你好' } }] }, account).text, '你好');
  assert(messageText({ ...group, message: [{ type: 'text', data: { text: '/agents unrelated' } }] }, account).reason);
});

test('final extraction uses completed matching turn, discards reasoning and tool commentary', () => {
  const result = completedText([
    assistant(1, [{ type: 'text', text: '旧答案' }]), end(1),
    assistant(2, [{ type: 'text', text: '中间状态' }, { type: 'tool-call' }]),
    assistant(2, [{ type: 'reasoning', text: '隐藏思考' }, { type: 'text', text: '<think>不可发</think>最终答案 `<think>代码</think>`' }]), end(2)
  ]);
  assert.equal(result, '最终答案 `<think>代码</think>`');
  for (const kind of ['aborted', 'error', 'max-tokens']) assert.throws(() => completedText([assistant(1, [{ type: 'text', text: '完整旧答案' }]), end(1), assistant(2, [{ type: 'text', text: '半截' }]), end(2, kind)]), ChannelError);
  assert.throws(() => completedText([assistant(3, [{ type: 'reasoning', text: '思考' }]), end(3)]), /正文/);
});

test('unauthorized, self and outgoing messages never invoke the model', async t => {
  const f = fixture(t);
  f.receive(message(1, { peerId: 'stranger' }));
  f.receive(message(2, { direction: 'outgoing' }));
  f.receive(message(3, { sender: account }));
  f.channel.receive(message(4), 'other-account');
  await f.channel.whenIdle(); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('consecutive questions queue in order and each receives updated durable conversation memory', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), original = f.runner.run;
  f.runner.run = async input => { if (!f.calls.length) { f.calls.push(input); await gate.promise; f.calls.pop(); } return original(input); };
  f.receive(message(1)); f.receive(message(2)); f.receive(message(3));
  assert.equal(f.channel.summary().queued, 2);
  gate.resolve(); await f.channel.whenIdle();
  assert.deepEqual(f.calls.map(c => c.text), ['问题 1', '问题 2', '问题 3']);
  assert.equal(f.calls[1].sessionId, undefined); assert.equal(f.calls[2].sessionId, undefined);
  assert(f.calls[1].memory.includes('回答 问题 1')); assert(f.calls[2].memory.includes('回答 问题 2'));
  assert.equal(f.sent.length, 3); assert(f.store.data.records.every(r => r.state === 'sent'));
});

test('group speakers share room memory while private conversations remain separate', async t => {
  const f = fixture(t);
  const group = (id, sender) => message(id, { chatType: 'group', peerId: '123@chatroom', sender: { id: sender }, message: [{ type: 'text', data: { text: `/agent ${id}` } }] });
  f.receive(group(1, 'alice')); f.receive(group(2, 'bob')); f.receive(group(3, 'alice')); f.receive(message(4));
  await f.channel.whenIdle();
  assert.equal(f.calls[0].sessionId, undefined); assert.equal(f.calls[1].sessionId, undefined);
  assert.equal(f.calls[2].sessionId, undefined); assert.equal(f.calls[3].sessionId, undefined);
  assert(f.calls[2].memory.includes('alice') && f.calls[2].memory.includes('bob'));
  assert(!f.calls[3].memory.includes('bob'));
});

test('deduplication survives reload and uses account + peer + server message identity', async t => {
  const f = fixture(t), m = message(1); f.receive(m); await f.channel.whenIdle(); await f.channel.close();
  const second = new WechatChannel({ store: new StateStore(f.root), runner: f.runner, transport: f.transport });
  t.after(() => second.close());
  second.receive({ ...m, id: 'changed-local-id' }, account.id); await second.whenIdle();
  assert.equal(f.sent.length, 1);
});

test('message claim and audit are committed together; fresh dedupe entries are never evicted', t => {
  const root = temporary(t), store = new StateStore(root), now = Date.now();
  store.remember('claimed', now, { key: 'claimed', state: 'queued', accountId: 'fake' });
  const disk = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(disk.seen.claimed, now); assert.equal(disk.records[0].key, 'claimed');
  store.data.seen = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`fresh-${i}`, now]));
  assert.throws(() => store.remember('overflow', now), error => error.code === 'DEDUPE_CAPACITY');
  assert.equal(store.data.seen['fresh-0'], now);
});

test('interrupted sends become unknown; unfinished inference is not replayed', t => {
  const root = temporary(t), store = new StateStore(root);
  for (const state of ['sending', 'generating', 'queued']) {
    store.add({ key: state, contextKey: state, accountId: account.id, state }); store.saveSession(state, 'old-session');
  }
  const restored = new StateStore(root);
  assert.deepEqual(restored.data.records.map(r => r.state), ['unknown', 'cancelled', 'cancelled']);
  assert.equal(Object.keys(restored.data.sessions).length, 0);
});

test('revocation cancels current inference and every queued old request', async t => {
  const f = fixture(t);
  f.runner.run = async ({ signal }) => { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  f.receive(message(1)); f.receive(message(2));
  f.store.configure(account.id, { ...settings, enabled: false }); f.channel.cancel('授权已撤销');
  await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert(f.store.data.records.every(r => r.state === 'cancelled'));
});

test('account and authorization are rechecked after inference before sending', async t => {
  const f = fixture(t);
  f.runner.run = async () => { f.state.account = { id: 'replacement-account' }; return { text: '不应发送', sessionId: 's' }; };
  f.receive(message(1)); await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.data.records[0].state, 'cancelled');
});

test('partial ACK and unknown delivery stay distinct and are never retried', async t => {
  const f = fixture(t); let attempts = 0;
  f.transport.send = async () => { attempts++; throw new ChannelError('SEND', '网络失败', attempts === 1 ? { acknowledgedMessageIds: ['confirmed-1'], delivery: 'partially-acknowledged' } : { delivery: 'unknown' }); };
  f.receive(message(1)); f.receive(message(2)); await f.channel.whenIdle();
  assert.deepEqual(f.store.data.records.map(r => r.state), ['partial', 'unknown']);
  assert.deepEqual(f.store.data.records[0].acknowledgedMessageIds, ['confirmed-1']);
  assert.equal(attempts, 2); assert.equal(Object.keys(f.store.data.sessions).length, 0);
});

test('request acceptance without server IDs is never labelled sent', async t => {
  const f = fixture(t); f.transport.send = async () => ({ delivery: 'queued', serverMessageIds: [] });
  f.receive(message(1)); await f.channel.whenIdle(); assert.equal(f.store.data.records[0].state, 'unknown');
});

test('cancellation after network dispatch preserves a genuine server ACK', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers();
  f.transport.send = async () => { reached.resolve(); await gate.promise; return { delivery: 'server-ack', serverMessageIds: ['real-ack'] }; };
  f.receive(message(1)); await reached.promise; f.channel.cancel(); gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.store.data.records[0].state, 'sent'); assert.deepEqual(f.store.data.records[0].acknowledgedMessageIds, ['real-ack']);
});

test('failure discards unsent session context before the next question', async t => {
  const f = fixture(t); let n = 0;
  f.transport.send = async () => { if (++n === 1) throw new ChannelError('SEND_FAILED', '发送失败'); return { delivery: 'server-ack', serverMessageIds: ['ack-2'] }; };
  f.receive(message(1)); f.receive(message(2)); await f.channel.whenIdle(); assert.equal(f.calls[1].sessionId, undefined);
});

test('old, empty and unsupported media messages have understandable skip reasons', async t => {
  const f = fixture(t);
  f.receive(message(1, { time: Math.floor(Date.now() / 1000) - 1200 }));
  f.receive(message(2, { message: [{ type: 'text', data: { text: ' ' } }] }));
  f.receive(message(3, { message: [{ type: 'file', data: { file: 'private-path' } }] }));
  await f.channel.whenIdle(); assert.equal(f.calls.length, 0); assert(f.store.data.records.every(r => r.state === 'skipped' && r.reason));
});

test('persistence failure stops processing before model and network side effects', async t => {
  const f = fixture(t), original = f.store.save;
  f.store.save = () => { throw new ChannelError('STATE_WRITE_FAILED', '磁盘写入失败'); };
  f.receive(message(1)); await f.channel.whenIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.channel.summary().fault.code, 'STATE_WRITE_FAILED');
  f.store.save = original;
});

test('exclusive instance lock prevents two owners and preserves an active worker lock', t => {
  const root = temporary(t), first = acquireLock(root);
  first.worker(process.pid);
  assert.throws(() => acquireLock(root), /另一个 DSH/); first.release();
  const second = acquireLock(root); second.release(); assert(!fs.existsSync(path.join(root, 'owner.lock')));
});

test('native RPC requires owner and allowlists endpoints; arbitrary errors are redacted', async () => {
  let n = 0;
  const handler = rpcHandler({ call: () => { n++; throw new Error('token=SECRET-CREDENTIAL'); } });
  const owner = { principal: { kind: 'owner' } };
  assert.equal((await handler('status', {}, undefined, { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await handler('model.select', { selection: null }, undefined, { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await handler('send-anywhere', {}, undefined, owner)).error.code, 'UNKNOWN_OPERATION');
  assert.equal(n, 0);
  assert(!JSON.stringify(await handler('status', {}, undefined, owner)).includes('SECRET-CREDENTIAL'));
  assert.equal((await rpcHandler({ call() {} }, () => true)('status', {}, undefined, owner)).error.code, 'PLUGIN_STOPPING');
  const signal = new AbortController().signal, payload = { selection: { provider: 'mock', model: 'm' } };
  const select = rpcHandler({ call(endpoint, received, passedSignal) {
    assert.equal(endpoint, 'model.select'); assert.deepEqual(received, payload); assert.equal(passedSignal, signal); return 'saved';
  } });
  assert.deepEqual(await select('model.select', payload, signal, owner), { ok: true, value: 'saved' });
});

test('model selection accepts only DSH identities or follow-default, never independent configuration', () => {
  assert.equal(validateModelChoice(null), null);
  assert.deepEqual(validateModelChoice({ provider: ' mock ', model: ' first ' }), { provider: 'mock', model: 'first' });
  for (const input of [undefined, {}, [], { provider: '', model: 'first' }, { provider: 'mock', model: 'first\n' },
    { provider: 'mock', model: 'first', apiKey: 'SECRET' }, { provider: 'mock', model: 'first', baseUrl: 'https://example.invalid' }])
    assert.throws(() => validateModelChoice(input), error => error.code === 'INVALID_MODEL');
});

test('model choice upgrades existing state, persists independently of account and survives reload', t => {
  const root = temporary(t), store = new StateStore(root);
  store.configure(account.id, settings); store.saveSession('existing', 'kept-session');
  store.remember('already-handled', Date.now(), { key: 'already-handled', accountId: account.id, state: 'sent' });
  store.data.connectionWanted = true; store.save();
  const original = structuredClone(store.data);
  assert.equal(new StateStore(root).modelChoice(), null);
  store.setModelChoice({ provider: 'mock', model: 'first' });
  const loaded = new StateStore(root), detached = loaded.modelChoice(); detached.model = 'changed';
  assert.deepEqual(loaded.modelChoice(), { provider: 'mock', model: 'first' });
  const { modelChoice, ...rest } = loaded.data; assert.deepEqual(rest, original);
  loaded.setModelChoice(null);
  assert.equal(new StateStore(root).modelChoice(), null);
});

test('failed model save restores the last persisted choice without resetting account state', t => {
  const root = temporary(t), store = new StateStore(root), original = store.save;
  store.configure(account.id, settings);
  store.save = () => { throw new ChannelError('STATE_WRITE_FAILED', '测试磁盘错误'); };
  assert.throws(() => store.setModelChoice({ provider: 'mock', model: 'first' }), /磁盘/);
  assert.equal(store.modelChoice(), null); assert.equal(Object.hasOwn(store.data, 'modelChoice'), false);
  store.save = original; store.setModelChoice({ provider: 'mock', model: 'first' });
  store.save = () => { throw new ChannelError('STATE_WRITE_FAILED', '测试磁盘错误'); };
  assert.throws(() => store.setModelChoice(null), /磁盘/);
  assert.deepEqual(store.modelChoice(), { provider: 'mock', model: 'first' });
  assert.deepEqual(new StateStore(root).modelChoice(), store.modelChoice());
  assert.deepEqual(store.settings(account.id), settings);
});

test('selection validates the live DSH registry and does not let another provider failure block it', async t => {
  const store = new StateStore(temporary(t)), lookedUp = [];
  let providers = [{ id: 'mock' }, { id: 'broken' }], models = [{ id: 'first' }];
  const ctx = { llm: { listProviders: () => providers, listModels: async provider => {
    lookedUp.push(provider); if (provider === 'broken') throw new Error('token=SECRET'); return models;
  } } };
  await selectModel(ctx, store, { provider: 'mock', model: 'first' });
  assert.deepEqual(lookedUp, ['mock']);
  const before = store.modelChoice();
  await assert.rejects(selectModel(ctx, store, { provider: 'mock', model: 'invented' }), error => error.code === 'MODEL_UNAVAILABLE');
  models = [{ id: 'second' }];
  await assert.rejects(availableModel(ctx, before), error => error.code === 'MODEL_UNAVAILABLE');
  providers = [];
  await assert.rejects(selectModel(ctx, store, { provider: 'mock', model: 'second' }), error => error.code === 'MODEL_UNAVAILABLE');
  assert.deepEqual(store.modelChoice(), before);
  await selectModel(ctx, store, null); assert.equal(store.modelChoice(), null);
});

test('provider query failure and cancellation preserve selection and redact backend errors', async t => {
  const store = new StateStore(temporary(t)), choice = { provider: 'mock', model: 'first' };
  store.setModelChoice(choice);
  const ctx = { llm: { listProviders: () => [{ id: 'mock' }], listModels: async () => { throw new Error('https://secret.invalid?key=SECRET'); } } };
  await assert.rejects(selectModel(ctx, store, choice), error => {
    assert.equal(error.code, 'MODEL_CATALOG_FAILED'); assert(!JSON.stringify(publicError(error)).includes('SECRET')); return true;
  });
  const gate = Promise.withResolvers(), reached = Promise.withResolvers(), controller = new AbortController();
  ctx.llm.listModels = () => { reached.resolve(); return gate.promise; };
  const pending = selectModel(ctx, store, { provider: 'mock', model: 'second' }, controller.signal);
  await reached.promise; controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  gate.resolve([{ id: 'second' }]); await gate.promise;
  assert.deepEqual(store.modelChoice(), choice);
  const late = Promise.withResolvers(); let registered = true;
  ctx.llm.listProviders = () => registered ? [{ id: 'mock' }] : [];
  ctx.llm.listModels = () => late.promise;
  const disappearing = selectModel(ctx, store, { provider: 'mock', model: 'second' });
  registered = false; late.resolve([{ id: 'second' }]);
  await assert.rejects(disappearing, error => error.code === 'MODEL_UNAVAILABLE');
  assert.deepEqual(store.modelChoice(), choice);
});

test('runner follows DSH defaults and captures a stable route while selection changes mid-task', async t => {
  const store = new StateStore(temporary(t)), requests = [], gate = Promise.withResolvers();
  let defaultChoice = { provider: 'mock', model: 'first', reasoningEffort: 'high' }, valid = true, onCreate;
  const ctx = {
    agentDefaultModel: { currentSelection: () => defaultChoice },
    llm: { listProviders: () => [{ id: 'mock' }, { id: 'other' }], listModels: async () => valid ? [{ id: 'first' }, { id: 'second' }] : [] },
    agents: { create: async options => {
      requests.push(options); onCreate?.(); if (requests.length === 1) await gate.promise;
      return { agent: { session: { seq: 0, snapshotEvents: () => [assistant(0, [{ type: 'text', text: '完成' }]), end(0)] },
        followup() {}, whenIdle: async () => {}, cancel() {} }, dispose: async () => {} };
    } }
  };
  ctx.agents.resume = ctx.agents.create;
  const runner = new DshAgentRunner(ctx, () => store.modelChoice()), signal = new AbortController().signal;
  const started = Promise.withResolvers(); onCreate = started.resolve;
  const active = runner.run({ text: '旧任务', signal }); await started.promise;
  await selectModel(ctx, store, { provider: 'other', model: 'second' });
  defaultChoice = { provider: 'mock', model: 'second', reasoningEffort: 'low' };
  gate.resolve(); await active;
  assert.deepEqual(requests[0].agentOptions, { provider: 'mock', model: 'first', reasoningEffort: 'high', maxTokens: 4096 });
  await runner.run({ text: '续接使用所选模型', sessionId: 'existing-session', signal });
  assert.deepEqual(requests[1].agentOptions, { provider: 'other', model: 'second', maxTokens: 4096 });
  assert.equal(requests[1].resumeSessionId, 'existing-session');
  valid = false;
  await assert.rejects(runner.run({ text: '模型已移除', signal }), error => error.code === 'MODEL_UNAVAILABLE');
  assert.equal(requests.length, 2, 'unavailable choice must never fall back to the default');
  await selectModel(ctx, store, null);
  await runner.run({ text: '跟随新默认', signal });
  assert.deepEqual(requests[2].agentOptions, { ...defaultChoice, maxTokens: 4096 });
});

test('DSH adapter establishes tool limits before followup and always disposes owned handle', async () => {
  const order = [], events = [], abort = new AbortController();
  let options;
  const handle = { agent: {
    session: { seq: 0, snapshotEvents: () => events },
    followup(message) { order.push('followup'); assert(message.id && message.role === 'user' && message.source.kind === 'wechat-agent'); events.push(assistant(0, [{ type: 'text', text: '完成' }]), end(0)); },
    whenIdle: async () => {}, cancel() { order.push('cancel'); }
  }, dispose: async () => { order.push('dispose'); } };
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'm' }) }, agents: {
    create: async opts => { options = opts; opts.setup({
      tools: { restrict: filter => { assert.deepEqual(filter, { allow: [] }); order.push('restrict'); }, guard: fn => { assert.equal(typeof fn({ name: 'any' }), 'string'); order.push('guard'); } },
      systemPrompt: { suppressRuntimeContext: () => order.push('suppress'), section: spec => { assert(spec.complete && spec.interpolate === false); order.push('prompt'); } }
    }); return handle; }
  } };
  const result = await new DshAgentRunner(ctx).run({ text: '问题', group: false, signal: abort.signal });
  assert.equal(result.text, '完成'); assert.equal(options.agentOptions.provider, 'mock');
  assert.deepEqual(order, ['restrict', 'guard', 'suppress', 'prompt', 'followup', 'cancel', 'dispose']);
});

test('bundled protocol worker starts with isolated empty state and exits cleanly', async t => {
  const root = temporary(t), worker = new WorkerClient(root, repo);
  t.after(() => worker.close()); await worker.ready;
  assert.equal(worker.status().online, false); assert.equal(worker.status().account, null);
  assert.equal((await worker.call('status')).state, 'session-missing');
  await worker.close(); assert.notEqual(worker.child.exitCode, null);
  assert(!fs.existsSync(path.join(root, 'storage/private/session.json')));
});

test('worker cancellation waits for delivery outcome instead of losing a late ACK', async t => {
  const root = temporary(t), resources = path.join(root, 'resources'); fs.mkdirSync(path.join(resources, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'lib/worker.cjs'), `
    let sendId;
    process.send({type:'ready',status:{online:true,account:{id:'fake'}}});
    process.on('message',m=>{
      if(m.op==='send') {sendId=m.id; process.send({type:'status',status:{online:true,waiting:true}});}
      if(m.type==='cancel') process.send({type:'result',id:sendId,ok:true,value:{delivery:'server-ack',serverMessageIds:['late-ack']}});
      if(m.op==='close'){process.send({type:'result',id:m.id,ok:true});process.disconnect();}
    });`);
  const worker = new WorkerClient(root, resources); t.after(() => worker.close()); await worker.ready;
  const waiting = new Promise(resolve => worker.once('status', resolve)), controller = new AbortController();
  const result = worker.send({}, controller.signal); await waiting; controller.abort();
  assert.equal((await result).serverMessageIds[0], 'late-ack'); await worker.close();
});
