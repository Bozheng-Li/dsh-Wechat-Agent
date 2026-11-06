import test from 'node:test';
import assert from 'node:assert/strict';
import { visionSelection } from '../lib/testing.js';

test('image understanding keeps the chat selection and chooses the advertised vision route of the same family', async () => {
  const original = { provider: 'fixture', model: 'fixture/flash-1017', reasoningEffort: 'high' };
  const calls = [];
  const ctx = { llm: {
    listProviders: () => [{ id: 'fixture' }],
    resolveModelInfo: async (_provider, model) => ({ inputModalities: model.endsWith('-1017') ? ['text'] : ['text', 'image'] }),
    listModels: async provider => { calls.push(provider); return [{ id: 'fixture/other', inputModalities: ['text', 'image'] }, { id: 'fixture/flash', inputModalities: ['text', 'image'] }]; },
  } };
  assert.deepEqual(await visionSelection(ctx, original, null, new AbortController().signal), { provider: 'fixture', model: 'fixture/flash' });
  assert.equal(original.model, 'fixture/flash-1017'); assert.equal(original.reasoningEffort, 'high');
  assert.deepEqual(calls, ['fixture']);
  assert.deepEqual(await visionSelection(ctx, { provider: 'fixture', model: 'fixture/flash' }, null), { provider: 'fixture', model: 'fixture/flash' });
});

test('an explicit image model must remain available and image-capable; it cannot silently switch', async () => {
  const ctx = { llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'text-only' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) } };
  await assert.rejects(visionSelection(ctx, { provider: 'fixture', model: 'text-only' }, { provider: 'fixture', model: 'text-only' }), { code: 'MODEL_NO_VISION' });
  await assert.rejects(visionSelection(ctx, { provider: 'fixture', model: 'text-only' }, { provider: 'gone', model: 'vision' }), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(visionSelection(ctx, { provider: 'fixture', model: 'text-only' }, null), { code: 'MODEL_NO_VISION' });
});
