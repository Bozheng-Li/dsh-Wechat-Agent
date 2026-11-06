import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, WechatChannel, createPluginService, rpcHandler } from '../lib/testing.js';

const temporary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const account = { id: 'vision-settings-owner', nickname: '视觉设置验收' };
const provider = 'vision-settings-fixture';
const owner = { principal: { kind: 'owner' } };
function fixture(t) {
  fs.mkdirSync(temporary, { recursive: true });
  const base = fs.realpathSync(temporary), root = fs.mkdtempSync(path.join(base, 'vision-settings-'));
  const store = new StateStore(root);
  store.configure(account.id, { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  store.setModelChoice({ provider, model: 'chat' });
  const choice = { provider, model: 'chat' }, requests = [];
  const ctx = { llm: {
    listProviders: () => [{ id: provider }],
    listModels: async () => [{ id: 'chat', inputModalities: ['text'] }, { id: 'vision', inputModalities: ['text', 'image'] }],
    resolveModelInfo: async (selectedProvider, model) => {
      requests.push({ provider: selectedProvider, model });
      return { inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] };
    },
  } };
  const worker = { status: () => ({ online: true, account }), send: async () => { throw new Error('No sends belong to model settings validation'); } };
  const runner = { selection: () => choice, defaultSelection: () => choice };
  const channel = new WechatChannel({ store, runner, transport: worker });
  const service = createPluginService({ ctx, root, store, worker, runner, channel });
  t.after(async () => {
    await service.drain(); await channel.close();
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), base); assert.match(path.basename(target), /^vision-settings-/);
    fs.rmSync(target, { recursive: true, force: false });
  });
  return { root, ctx, store, channel, service, requests, rpc: rpcHandler(service),
    saved: () => fs.readFileSync(path.join(root, 'storage/state/channel.json')),
    config: () => ({ ...store.modelConfig(), maxTokens: 1536, vision: true, visionModel: { provider, model: 'vision' } }) };
}

test('an explicit visual model whose capability changed is rejected before any configuration is saved', async t => {
  const f = fixture(t), before = f.store.modelConfig(), saved = f.saved();
  // The picker previously advertised image support; current provider metadata no longer does.
  f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text'] });
  const result = await f.rpc('model.configure', { modelConfig: f.config() }, new AbortController().signal, owner);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'MODEL_NO_VISION');
  assert.match(result.error.message, /不接受图片|图像/);
  assert.deepEqual(f.store.modelConfig(), before); assert(f.saved().equals(saved));
  assert.deepEqual(f.store.modelChoice(), { provider, model: 'chat' });
});

test('a verified explicit visual model persists without changing the chat model or authorization', async t => {
  const f = fixture(t), authorization = f.store.settings(account.id), config = f.config();
  const result = await f.rpc('model.configure', { modelConfig: config }, new AbortController().signal, owner);
  assert.equal(result.ok, true); assert.deepEqual(result.value.modelConfig, config);
  assert.deepEqual(f.requests, [{ provider, model: 'vision' }]);
  const restored = new StateStore(f.root);
  assert.deepEqual(restored.modelConfig(), config); assert.deepEqual(restored.modelChoice(), { provider, model: 'chat' });
  assert.deepEqual(restored.settings(account.id), authorization);
});

test('cancellation during visual capability lookup preserves the exact previously saved configuration', async t => {
  const f = fixture(t), saved = f.saved(), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.ctx.llm.resolveModelInfo = async () => { reached.resolve(); await gate.promise; return { inputModalities: ['text', 'image'] }; };
  const controller = new AbortController(), reason = new Error('fixture cancelled settings');
  const pending = f.service.call('model.configure', { modelConfig: f.config() }, controller.signal);
  await reached.promise; controller.abort(reason); gate.resolve();
  await assert.rejects(pending, error => error === reason);
  assert(f.saved().equals(saved));
});

test('visual capability lookup failures return a safe error and do not publish a new configuration', async t => {
  const f = fixture(t), saved = f.saved();
  f.ctx.llm.resolveModelInfo = async () => { throw new Error('fixture-private-provider-diagnostics'); };
  const result = await f.rpc('model.configure', { modelConfig: f.config() }, new AbortController().signal, owner);
  assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('fixture-private-provider-diagnostics'));
  assert(f.saved().equals(saved));
});
