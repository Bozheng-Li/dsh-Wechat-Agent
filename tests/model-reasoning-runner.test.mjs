import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshAgentRunner, StateStore, createPluginService } from '../lib/testing.js';

const signal = () => new AbortController().signal;
function fixture() {
  const calls = [], requests = [], proposals = [], sessions = new Map();
  const state = { choice: { provider: 'fixture', model: 'first', reasoningEffort: 'low' },
    hostDefault: { provider: 'fixture', model: 'first', reasoningEffort: 'high' }, beforeResolve: null };
  const modelInfo = (_provider, model) => ({ reasoning: {
    efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })),
    defaultEffort: model === 'first' ? 'medium' : 'low',
  } });
  const create = async options => {
    calls.push(options);
    const hooks = [];
    options.setup({ tools: { restrict() {}, guard() {}, register() {} },
      systemPrompt: { suppressRuntimeContext() {}, section() {} },
      on(event, hook) { assert.equal(event, 'agent/request'); hooks.push(hook); },
    });
    const id = options.sessionId ?? options.resumeSessionId;
    const previous = sessions.get(id), seed = { ...options.agentOptions };
    // The Host retains a prior explicit effort only when resuming the same route.
    if (previous?.explicit && previous.provider === seed.provider && previous.model === seed.model && seed.reasoningEffort === undefined)
      seed.reasoningEffort = previous.reasoningEffort;
    let pending;
    const dispatch = async () => {
      const proposed = await hooks.reduceRight((next, hook) => () => hook({ turn: 1, step: 1 }, next), async () => seed)();
      proposals.push(proposed);
      const request = { ...proposed, reasoningEffort: proposed.reasoningEffort ?? modelInfo(proposed.provider, proposed.model).reasoning.defaultEffort };
      requests.push(request);
      sessions.set(id, { ...request, explicit: proposed.reasoningEffort !== undefined });
    };
    return { agent: { session: { seq: 0, surface: { nodes: [] }, deriveMessages: () => [], append() {}, snapshotEvents: () => [
      { type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: '合成回复。' }] } } },
      { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
    ] }, followup() { pending = dispatch(); }, whenIdle: async () => { await pending; }, cancel() {} }, dispose: async () => {} };
  };
  const ctx = { agentDefaultModel: { currentSelection: () => state.hostDefault },
    llm: { listProviders: () => [{ id: 'fixture' }, { id: 'alternate' }], listModels: async () => [{ id: 'first' }, { id: 'second' }],
      resolveModelInfo: async (provider, model) => { await state.beforeResolve?.(); return modelInfo(provider, model); } },
    agents: { create, resume: create } };
  const runner = new DshAgentRunner(ctx, () => state.choice);
  return { state, ctx, runner, calls, requests, proposals };
}

test('same-model resume can clear an explicit effort while following the Host retains its explicit default', async () => {
  const f = fixture();
  const first = await f.runner.run({ text: '第一轮', signal: signal() });
  assert.equal(f.requests.at(-1).reasoningEffort, 'low');
  f.state.choice = { provider: 'fixture', model: 'first' };
  await f.runner.run({ text: '本模型默认', sessionId: first.sessionId, signal: signal() });
  assert.equal(Object.hasOwn(f.proposals.at(-1), 'reasoningEffort'), false);
  assert.equal(f.requests.at(-1).reasoningEffort, 'medium');
  f.state.choice = null;
  await f.runner.run({ text: '跟随宿主明确默认', sessionId: first.sessionId, signal: signal() });
  assert.equal(f.requests.at(-1).reasoningEffort, 'high');
  assert.equal(f.calls.at(-1).agentOptions.reasoningEffort, 'high');
  f.state.choice = { provider: 'alternate', model: 'second' };
  await f.runner.run({ text: '新模型默认', sessionId: first.sessionId, signal: signal() });
  assert.equal(f.requests.at(-1).provider, 'alternate');
  assert.equal(f.requests.at(-1).reasoningEffort, 'low');
  assert.equal(Object.hasOwn(f.proposals.at(-1), 'reasoningEffort'), false);
});

test('explicit effort remains frozen during asynchronous model lookup and later turns use the new choice', async () => {
  const f = fixture(), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.state.beforeResolve = async () => { reached.resolve(); await gate.promise; };
  const pending = f.runner.run({ text: '已开始的任务', signal: signal() });
  await reached.promise;
  f.state.choice.provider = 'alternate'; f.state.choice.model = 'second'; f.state.choice.reasoningEffort = 'high';
  gate.resolve();
  const first = await pending;
  assert.deepEqual(f.calls[0].agentOptions, { provider: 'fixture', model: 'first', reasoningEffort: 'low' });
  await f.runner.run({ text: '后续任务', sessionId: first.sessionId, signal: signal() });
  assert.deepEqual(f.calls[1].agentOptions, { provider: 'alternate', model: 'second', reasoningEffort: 'high' });
});

test('execution snapshots preserve their own effort and cannot inherit a newer same-route resumed choice', async () => {
  const f = fixture();
  const first = await f.runner.run({ text: '已保存低强度', signal: signal() });
  f.state.choice.reasoningEffort = 'high';
  const snapshot = { selection: { provider: 'fixture', model: 'first', reasoningEffort: 'medium' }, runtime: {} };
  await f.runner.run({ text: '快照任务', sessionId: first.sessionId, executionSnapshot: snapshot, signal: signal(),
    onSession() { snapshot.selection.reasoningEffort = 'high'; } });
  assert.equal(f.calls.at(-1).agentOptions.reasoningEffort, 'medium');
  assert.equal(f.requests.at(-1).reasoningEffort, 'medium');
  await f.runner.run({ text: '没有显式强度的快照', sessionId: first.sessionId,
    executionSnapshot: { selection: { provider: 'fixture', model: 'first' }, runtime: {} }, signal: signal() });
  assert.equal(Object.hasOwn(f.proposals.at(-1), 'reasoningEffort'), false);
  assert.equal(f.requests.at(-1).reasoningEffort, 'medium');
});

test('unavailable explicit reasoning fails before creating a model session', async () => {
  const f = fixture(); f.state.choice.reasoningEffort = 'not-offered';
  await assert.rejects(f.runner.run({ text: '不得生成', signal: signal() }), error => error.code === 'MODEL_REASONING_UNSUPPORTED');
  assert.equal(f.calls.length, 0);
});

test('status preserves fixed and Host default effort while exposing only model selection fields', t => {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'wechat-reasoning-status-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), base); assert(path.basename(resolved).startsWith('wechat-reasoning-status-'));
    fs.rmSync(resolved, { recursive: true });
  });
  const store = new StateStore(root), f = fixture();
  store.setModelChoice(f.state.choice);
  f.state.hostDefault.unrelatedPrivateField = 'synthetic-hidden-value';
  const service = createPluginService({ ctx: f.ctx, root, store, runner: f.runner, identity: { file: 'synthetic-identity' } });
  const status = service.call('status');
  assert.deepEqual(status.modelChoice, { provider: 'fixture', model: 'first', reasoningEffort: 'low' });
  assert.deepEqual(status.model, status.modelChoice);
  assert.deepEqual(status.defaultModel, { provider: 'fixture', model: 'first', reasoningEffort: 'high' });
  assert(!JSON.stringify(status).includes('synthetic-hidden-value'));
  status.modelChoice.reasoningEffort = 'high';
  assert.equal(store.modelChoice().reasoningEffort, 'low');
});
