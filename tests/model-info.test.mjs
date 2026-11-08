import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readModelInfo, createPluginService, rpcHandler, StateStore } from '../lib/testing.js';

const choice = { provider: 'model-info-fixture', model: 'reasoner' };
const owner = { principal: { kind: 'owner' } };
const metadata = {
  id: choice.model,
  reasoning: { efforts: [
    { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium', description: 'Balanced reasoning.' }, { id: 'high', name: 'High' },
  ] },
};

function fixture() {
  const reads = [], lists = [];
  return { reads, lists, ctx: { llm: {
    listProviders: () => [{ id: choice.provider }, { id: 'unrelated' }],
    listModels: async provider => {
      lists.push(provider);
      return [{ id: choice.model, name: 'Reasoner' }, { id: 'plain' }];
    },
    resolveModelInfo: async (provider, model, signal) => {
      reads.push({ provider, model, signal });
      return structuredClone(metadata);
    },
  } } };
}

function temporaryStore(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'wechat-model-info-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), base);
    assert(path.basename(resolved).startsWith('wechat-model-info-'));
    fs.rmSync(resolved, { recursive: true, force: false });
  });
  const store = new StateStore(root);
  store.setModelChoice({ ...choice, reasoningEffort: 'low' });
  return { root, store };
}

test('model details discover real effort levels even when the model list omits reasoning', async () => {
  const f = fixture(), result = await readModelInfo(f.ctx, choice);
  assert.deepEqual(result, { ...choice, reasoning: metadata.reasoning });
  assert.equal(Object.hasOwn(result.reasoning, 'defaultEffort'), false, 'No provider default was advertised');
  assert.deepEqual(f.lists, [choice.provider]);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].provider, choice.provider);
  assert.equal(f.reads[0].model, choice.model);
  assert(f.reads[0].signal instanceof AbortSignal);
});

test('capability projection preserves custom levels and advertised defaults without exposing raw configuration', async () => {
  const f = fixture();
  const raw = { id: choice.model, apiKey: 'SYNTHETIC_PRIVATE_KEY', extra: { endpoint: 'private.invalid' },
    reasoning: { efforts: [{ id: 'adaptive/custom', description: '  Provider-defined level.  ', secret: 'hidden' },
      { id: 'adaptive/custom', name: 'duplicate' }], defaultEffort: 'adaptive/custom', private: 'hidden' } };
  f.ctx.llm.resolveModelInfo = async () => raw;
  const expected = { ...choice, reasoning: { efforts: [{ id: 'adaptive/custom', name: 'adaptive/custom', description: 'Provider-defined level.' }], defaultEffort: 'adaptive/custom' } };
  assert.deepEqual(await readModelInfo(f.ctx, choice), expected);
  const copy = await readModelInfo(f.ctx, choice);
  copy.reasoning.efforts[0].name = 'mutated';
  assert.equal(raw.reasoning.efforts[0].name, undefined);
  raw.reasoning.defaultEffort = 'unadvertised';
  assert.equal(Object.hasOwn((await readModelInfo(f.ctx, choice)).reasoning, 'defaultEffort'), false);
});

test('a valid model with no advertised reasoning differs from a failed or malformed capability lookup', async () => {
  const f = fixture();
  for (const info of [{ id: choice.model }, { reasoning: null }, { reasoning: { efforts: [] } }]) {
    f.ctx.llm.resolveModelInfo = async () => info;
    assert.deepEqual(await readModelInfo(f.ctx, choice), { ...choice, reasoning: { efforts: [] } });
  }
  for (const info of [undefined, null, [], { id: 'different-model' }, { reasoning: {} },
    { reasoning: { efforts: 'low,high' } }, { reasoning: { efforts: [{ id: 'high\n' }] } },
    { reasoning: { efforts: [null] } }, { reasoning: { efforts: [{ id: '' }] } }]) {
    f.ctx.llm.resolveModelInfo = async () => info;
    await assert.rejects(readModelInfo(f.ctx, choice), { code: 'MODEL_REASONING_UNAVAILABLE' });
  }
  f.ctx.llm.resolveModelInfo = async () => { throw new Error('SYNTHETIC_PRIVATE_URL?key=secret'); };
  await assert.rejects(readModelInfo(f.ctx, choice), error => error.code === 'MODEL_REASONING_UNAVAILABLE' && !error.message.includes('SYNTHETIC_PRIVATE'));
  delete f.ctx.llm.resolveModelInfo;
  await assert.rejects(readModelInfo(f.ctx, choice), { code: 'MODEL_REASONING_UNAVAILABLE' });
});

test('model detail reads validate the selected model and do not query unrelated providers', async () => {
  const f = fixture();
  for (const input of [null, undefined, {}, { ...choice, apiKey: 'secret' }])
    await assert.rejects(readModelInfo(f.ctx, input), { code: 'INVALID_MODEL' });
  assert.equal(f.lists.length, 0);
  await assert.rejects(readModelInfo(f.ctx, { ...choice, provider: 'removed' }), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(readModelInfo(f.ctx, { ...choice, model: 'removed' }), { code: 'MODEL_UNAVAILABLE' });
  assert.deepEqual(f.lists, [choice.provider]);
  assert.equal(f.reads.length, 0);
  f.ctx.llm.resolveModelInfo = async () => {
    f.ctx.llm.listProviders = () => [];
    return metadata;
  };
  await assert.rejects(readModelInfo(f.ctx, choice), { code: 'MODEL_UNAVAILABLE' });
});

test('owner-only model.info RPC reads work without WeChat login and never change saved settings', async t => {
  const f = fixture(), { root, store } = temporaryStore(t), before = fs.readFileSync(store.file);
  const service = createPluginService({ ctx: f.ctx, root, store });
  const rpc = rpcHandler(service), payload = { selection: choice };
  assert.equal((await rpc('model.info', payload, undefined, { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.equal(f.reads.length, 0);
  assert.deepEqual(await rpc('model.info', payload, undefined, owner), { ok: true, value: { ...choice, reasoning: metadata.reasoning } });
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.deepEqual(new StateStore(root).modelChoice(), { ...choice, reasoningEffort: 'low' });
  await service.drain();
});

test('a read-only capability request does not queue behind a pending model save', async t => {
  const f = fixture(), { root, store } = temporaryStore(t);
  const before = fs.readFileSync(store.file), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  let first = true;
  const list = f.ctx.llm.listModels;
  f.ctx.llm.listModels = async provider => {
    if (first) { first = false; reached.resolve(); await gate.promise; }
    return list(provider);
  };
  const lifetime = new AbortController();
  const service = createPluginService({ ctx: f.ctx, root, store, lifetime: lifetime.signal });
  const save = service.call('model.select', { selection: { ...choice, model: 'plain' } });
  t.after(() => { lifetime.abort(); gate.resolve(); });
  await reached.promise;
  assert.deepEqual(await service.call('model.info', { selection: choice }), { ...choice, reasoning: metadata.reasoning });
  assert.deepEqual(fs.readFileSync(store.file), before);
  gate.resolve();
  await save;
  await service.drain();
});

test('model detail reads cancel with caller or plugin lifetime and service drain waits for them', async t => {
  for (const source of ['caller', 'plugin']) {
    const f = fixture(), { root, store } = temporaryStore(t), before = fs.readFileSync(store.file);
    const reached = Promise.withResolvers(), gate = Promise.withResolvers();
    const lifetime = new AbortController(), caller = new AbortController();
    let receivedSignal;
    f.ctx.llm.resolveModelInfo = (_provider, _model, signal) => {
      receivedSignal = signal; reached.resolve(); return gate.promise;
    };
    const service = createPluginService({ ctx: f.ctx, root, store, lifetime: lifetime.signal });
    const pending = service.call('model.info', { selection: choice }, caller.signal);
    await reached.promise;
    let drained = false;
    const drain = service.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    const controller = source === 'caller' ? caller : lifetime;
    controller.abort(new Error('synthetic cancellation'));
    await assert.rejects(pending, error => error === controller.signal.reason);
    await drain;
    assert.equal(receivedSignal.aborted, true);
    gate.resolve(metadata);
    await gate.promise;
    assert.deepEqual(fs.readFileSync(store.file), before);
  }
});
