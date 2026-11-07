import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, validateModelConfig, DshAgentRunner, completedText } from '../lib/testing.js';

function temporary(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'wechat-output-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
    assert.match(path.basename(resolved), /^wechat-output-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

test('output is automatic by default; manual budgets above 8192 persist exactly', t => {
  const root = temporary(t), store = new StateStore(root);
  assert.equal(store.modelConfig().maxTokens, null);
  assert.equal(validateModelConfig({ temperature: null }).maxTokens, null);
  for (const maxTokens of [1, 128, 8193, 32768, 131072, 256000, 1048576, 4096, null]) {
    store.setModelConfig({ ...store.modelConfig(), maxTokens });
    assert.equal(new StateStore(root).modelConfig().maxTokens, maxTokens);
  }
  for (const maxTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '32768', ''])
    assert.throws(() => validateModelConfig({ maxTokens, temperature: null }), error => error.code === 'INVALID_MODEL_CONFIG');
});

for (const legacyTokens of [4096, 2048, 8192]) test(`legacy ${legacyTokens} migration preserves authorization and explicit settings`, t => {
  const root = temporary(t), store = new StateStore(root), account = 'fixture-owner';
  store.configure(account, { enabled: true, privatePeers: ['fixture-friend'], groups: ['fixture@chatroom'], prompt: '保留要求' });
  store.setModelConfig({ ...store.modelConfig(), maxTokens: legacyTokens, temperature: 0.4, vision: false, webSearch: true });
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  delete saved.modelConfigVersion;
  fs.writeFileSync(store.file, JSON.stringify(saved));
  const restored = new StateStore(root), expected = legacyTokens === 4096 ? null : legacyTokens;
  assert.equal(restored.modelConfig().maxTokens, expected);
  assert.equal(restored.modelConfig().temperature, 0.4);
  assert.equal(restored.modelConfig().vision, false);
  assert.equal(restored.modelConfig().webSearch, true);
  assert.deepEqual(restored.settings(account), store.settings(account));
  assert.equal(new StateStore(root).modelConfig().maxTokens, expected);
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).modelConfigVersion, 2);
  restored.setModelConfig({ ...restored.modelConfig(), maxTokens: 4096 });
  assert.equal(new StateStore(root).modelConfig().maxTokens, 4096, 'a new explicit 4096 must survive reload');
});

test('reply, compression, vision and rewrites inherit model output; a captured manual budget stays exact', async () => {
  const calls = [];
  const events = [
    { type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: '完整正文' }] } } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } }
  ];
  const create = async options => {
    calls.push(options.agentOptions);
    return { agent: { session: { seq: 0, snapshotEvents: () => events }, followup() {}, whenIdle: async () => {}, cancel() {} }, dispose: async () => {} };
  };
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'large' }) },
    agents: { create, resume: create } };
  let maxTokens = null;
  const runner = new DshAgentRunner(ctx, () => null, () => ({ modelConfig: { maxTokens } }));
  const signal = new AbortController().signal;
  await runner.run({ text: '正常回复', signal });
  await runner.summarize('压缩资料', 8000, signal);
  await runner.run({ text: '图像笔记', mode: 'vision', systemOverride: '记录图像', signal });
  await runner.run({ text: '改写', mode: 'rewrite', signal });
  assert(calls.every(options => !Object.hasOwn(options, 'maxTokens')));
  maxTokens = 131072;
  await runner.run({ text: '手动输出额度', signal });
  assert.equal(calls.at(-1).maxTokens, 131072);
  maxTokens = null;
  await runner.run({ text: '同轮改写', mode: 'rewrite', signal,
    executionSnapshot: { selection: { provider: 'fixture', model: 'captured' }, runtime: { modelConfig: { maxTokens: 256000 } } } });
  assert.deepEqual(calls.at(-1), { provider: 'fixture', model: 'captured', maxTokens: 256000 });
  assert.throws(() => completedText([...events.slice(0, 1), { type: 'turn/end', data: { turn: 0, reason: { kind: 'max-tokens' } } }]),
    error => error.code === 'MODEL_INCOMPLETE', 'provider-truncated text must still never be sent as a complete reply');
});

test('a completed model answer beyond the input character limit keeps its complete body and ending', () => {
  const reply = '双曲线：x²/a² − y²/b² = 1。\n'.repeat(1000) + '完整结尾。';
  assert(reply.length > 12000);
  const events = [{ type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } }];
  assert.equal(completedText(events), reply);
});
