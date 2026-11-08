import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelError, publicError, validateModelChoice } from '../src/shared/contracts.mjs';
import { availableModel, selectModel } from '../src/features/agent/models.mjs';
import { StateStore } from '../src/storage/state-store.mjs';

const choice = Object.freeze({ provider: 'synthetic-provider', model: 'first' });
const selectedEffort = Object.freeze({ ...choice, reasoningEffort: 'low' });
const supported = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } };

function temporaryStore(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'wechat-model-reasoning-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
    assert(path.basename(root).startsWith('wechat-model-reasoning-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store: new StateStore(root) };
}

function fixture() {
  const catalogReads = [], metadataReads = [];
  const ctx = { llm: {
    listProviders: () => [{ id: choice.provider }, { id: 'unrelated-provider' }],
    listModels: async provider => {
      catalogReads.push(provider);
      assert.equal(provider, choice.provider, 'Unrelated provider metadata must not be queried');
      return [{ id: 'first' }, { id: 'second' }];
    },
    resolveModelInfo: async (provider, model, signal) => {
      metadataReads.push({ provider, model, signal });
      return supported;
    },
  } };
  return { ctx, catalogReads, metadataReads };
}

test('model choices accept normalized explicit effort without inventing one for older selections', () => {
  assert.equal(validateModelChoice(null), null);
  assert.deepEqual(validateModelChoice(choice), choice);
  const omitted = validateModelChoice({ ...choice, reasoningEffort: undefined });
  assert.deepEqual(omitted, choice);
  assert.equal(Object.hasOwn(omitted, 'reasoningEffort'), false);
  assert.deepEqual(validateModelChoice({ provider: ` ${choice.provider} `, model: ' first ', reasoningEffort: ' low ' }), selectedEffort);
  assert.equal(validateModelChoice({ ...choice, reasoningEffort: 'x'.repeat(300) }).reasoningEffort.length, 300);
  assert.throws(() => validateModelChoice({ ...selectedEffort, apiKey: 'synthetic-secret' }), { code: 'INVALID_MODEL' });
});

test('invalid explicit efforts fail before any model lookup', async () => {
  const f = fixture();
  for (const reasoningEffort of [null, true, 0, {}, [], '', '   ', 'low\n', '\tlow', 'low\u0000', 'low\u007f', 'x'.repeat(301)]) {
    const input = { ...choice, reasoningEffort };
    assert.throws(() => validateModelChoice(input), { code: 'INVALID_REASONING_EFFORT' });
    await assert.rejects(availableModel(f.ctx, input), { code: 'INVALID_REASONING_EFFORT' });
  }
  assert.equal(f.catalogReads.length, 0);
  assert.equal(f.metadataReads.length, 0);
});

test('omitted effort retains the model default without requiring the metadata interface', async () => {
  const f = fixture();
  delete f.ctx.llm.resolveModelInfo;
  assert.deepEqual(await availableModel(f.ctx, choice), choice);
  assert.deepEqual(await availableModel(f.ctx, { ...choice, reasoningEffort: undefined }), choice);
  assert.equal(await availableModel(f.ctx, null), null);
  assert.deepEqual(f.catalogReads, [choice.provider, choice.provider]);
  assert.equal(f.metadataReads.length, 0);
});

test('explicit effort is checked against the exact provider and model before selection is saved', async t => {
  const { root, store } = temporaryStore(t), f = fixture();
  const next = { provider: choice.provider, model: 'second', reasoningEffort: 'high' };
  const selected = await selectModel(f.ctx, store, next, new AbortController().signal);
  assert.deepEqual(selected, next);
  assert.deepEqual(f.catalogReads, [choice.provider]);
  assert.equal(f.metadataReads.length, 1);
  assert.equal(f.metadataReads[0].provider, choice.provider);
  assert.equal(f.metadataReads[0].model, 'second');
  assert(f.metadataReads[0].signal instanceof AbortSignal);
  assert.equal(f.metadataReads[0].signal.aborted, false);
  assert.deepEqual(new StateStore(root).modelChoice(), next);
});

test('saved effort survives reload detached from callers and clears when returning to model defaults', async t => {
  const { root, store } = temporaryStore(t);
  store.setModelChoice(choice);
  const olderBytes = fs.readFileSync(store.file);
  const older = new StateStore(root);
  assert.deepEqual(older.modelChoice(), choice);
  assert.equal(Object.hasOwn(older.modelChoice(), 'reasoningEffort'), false);
  assert.deepEqual(fs.readFileSync(store.file), olderBytes, 'Loading an older selection must not write a default effort');

  const input = { ...choice, reasoningEffort: ' low ' };
  store.setModelChoice(input);
  input.reasoningEffort = 'high';
  const loaded = new StateStore(root), detached = loaded.modelChoice();
  detached.reasoningEffort = 'high';
  detached.model = 'second';
  assert.deepEqual(loaded.modelChoice(), selectedEffort);
  assert.deepEqual(new StateStore(root).modelChoice(), selectedEffort);

  const f = fixture();
  await selectModel(f.ctx, loaded, { ...choice, reasoningEffort: undefined });
  assert.deepEqual(new StateStore(root).modelChoice(), choice);
  loaded.setModelChoice(selectedEffort);
  await selectModel(f.ctx, loaded, { provider: choice.provider, model: 'second' });
  assert.deepEqual(new StateStore(root).modelChoice(), { provider: choice.provider, model: 'second' });
  await selectModel(f.ctx, loaded, null);
  assert.equal(new StateStore(root).modelChoice(), null);
  assert.equal(f.metadataReads.length, 0, 'Removing an effort never reads or copies a model default');
});

test('unsupported or unreadable effort metadata preserves the saved selection and redacts backend errors', async t => {
  const { root, store } = temporaryStore(t);
  store.setModelChoice(selectedEffort);
  const before = fs.readFileSync(store.file);
  const target = { ...choice, model: 'second', reasoningEffort: 'high' };
  const cases = [
    { resolve: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'high' } }), code: 'MODEL_REASONING_UNSUPPORTED' },
    { resolve: async () => ({ reasoning: { efforts: [] } }), code: 'MODEL_REASONING_UNSUPPORTED' },
    { resolve: async () => ({ reasoning: { efforts: [null] } }), code: 'MODEL_REASONING_UNSUPPORTED' },
    { resolve: async () => ({}), code: 'MODEL_REASONING_UNSUPPORTED' },
    { resolve: async () => undefined, code: 'MODEL_REASONING_UNSUPPORTED' },
    { resolve: undefined, code: 'MODEL_REASONING_UNAVAILABLE' },
    { resolve: async () => { throw new Error('https://synthetic.invalid/?key=SYNTHETIC_PRIVATE_ERROR'); }, code: 'MODEL_REASONING_UNAVAILABLE' },
  ];
  for (const scenario of cases) {
    const f = fixture();
    f.ctx.llm.resolveModelInfo = scenario.resolve;
    await assert.rejects(selectModel(f.ctx, store, target), error => {
      assert.equal(error.code, scenario.code);
      assert(!error.message.includes('SYNTHETIC_PRIVATE_ERROR'));
      assert(!JSON.stringify(publicError(error)).includes('SYNTHETIC_PRIVATE_ERROR'));
      return true;
    });
    assert.deepEqual(store.modelChoice(), selectedEffort);
    assert.deepEqual(new StateStore(root).modelChoice(), selectedEffort);
    assert.deepEqual(fs.readFileSync(store.file), before);
  }
});

test('an unsupported explicit none is not accepted merely because metadata calls it the default', async () => {
  const f = fixture();
  f.ctx.llm.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'none' } });
  await assert.rejects(availableModel(f.ctx, { ...choice, reasoningEffort: 'none' }), { code: 'MODEL_REASONING_UNSUPPORTED' });
  assert.deepEqual(await availableModel(f.ctx, selectedEffort), selectedEffort);
});

test('cancelling an in-flight metadata lookup prevents a late result from saving', async t => {
  const { root, store } = temporaryStore(t), f = fixture();
  store.setModelChoice(selectedEffort);
  const before = fs.readFileSync(store.file), reached = Promise.withResolvers(), metadata = Promise.withResolvers();
  const controller = new AbortController();
  let receivedSignal;
  f.ctx.llm.resolveModelInfo = (_provider, _model, signal) => { receivedSignal = signal; reached.resolve(); return metadata.promise; };
  const pending = selectModel(f.ctx, store, { ...choice, model: 'second', reasoningEffort: 'high' }, controller.signal);
  await reached.promise;
  controller.abort();
  await assert.rejects(pending, error => error === controller.signal.reason);
  assert.equal(receivedSignal.aborted, true);
  metadata.resolve(supported);
  await metadata.promise;
  assert.deepEqual(store.modelChoice(), selectedEffort);
  assert.deepEqual(new StateStore(root).modelChoice(), selectedEffort);
  assert.deepEqual(fs.readFileSync(store.file), before);
});

test('provider removal during metadata lookup refuses the selection without changing persistence', async t => {
  const { root, store } = temporaryStore(t), f = fixture();
  store.setModelChoice(selectedEffort);
  const before = fs.readFileSync(store.file), reached = Promise.withResolvers(), metadata = Promise.withResolvers();
  let registered = true;
  f.ctx.llm.listProviders = () => registered ? [{ id: choice.provider }] : [];
  f.ctx.llm.resolveModelInfo = () => { reached.resolve(); return metadata.promise; };
  const pending = selectModel(f.ctx, store, { ...choice, model: 'second', reasoningEffort: 'high' });
  await reached.promise;
  registered = false;
  metadata.resolve(supported);
  await assert.rejects(pending, { code: 'MODEL_UNAVAILABLE' });
  assert.deepEqual(store.modelChoice(), selectedEffort);
  assert.deepEqual(new StateStore(root).modelChoice(), selectedEffort);
  assert.deepEqual(fs.readFileSync(store.file), before);
});

test('a failed disk save restores the original effort in memory and on disk', async t => {
  const { root, store } = temporaryStore(t), f = fixture();
  store.setModelChoice(selectedEffort);
  const before = fs.readFileSync(store.file);
  store.save = () => { throw new ChannelError('STATE_WRITE_FAILED', 'Synthetic disk failure'); };
  await assert.rejects(selectModel(f.ctx, store, { ...choice, reasoningEffort: 'high' }), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual(store.modelChoice(), selectedEffort);
  assert.deepEqual(new StateStore(root).modelChoice(), selectedEffort);
  assert.deepEqual(fs.readFileSync(store.file), before);
});
