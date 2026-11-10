import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as testing from '../lib/testing.js';
import personaAudit from '../scripts/persona-behavior-live-cases.cjs';
import memoryAudit from '../scripts/memory-behavior-live-cases.cjs';
import promptAudit from '../scripts/prompt-live-cases.cjs';
import resumeAudit from '../scripts/persona-resume-live-cases.cjs';
import sectionAudit from '../scripts/persona-section-live-cases.cjs';
import ablationAudit from '../scripts/persona-input-ablation.cjs';
import upgradeAudit from '../scripts/persona-upgrade-live-cases.cjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syntheticSelection = { provider: 'audit-fixture', model: 'agent-model', reasoningEffort: 'high' };

function removeOwnedTemp(directory, prefix) {
  const resolved = fs.realpathSync(directory), temporary = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), temporary);
  assert(path.basename(resolved).startsWith(prefix));
  assert(!fs.lstatSync(directory).isSymbolicLink());
  fs.rmSync(resolved, { recursive: true, force: true });
}

for (const [name, audit, caseId, answer] of [
  ['persona', personaAudit, 'language:recall', '青藤画展。'],
  ['memory', memoryAudit, 'read:no-lookup-independent-question', '56。'],
  ['prompt', promptAudit, 'language:name', '我是微信助手。'],
  ['resume', resumeAudit, 'language:name', '我是微信助手。'],
  ['section', sectionAudit, 'language:name', '我是微信助手。'],
  ['ablation', ablationAudit, 'language:name', '我是微信助手。'],
  ['upgrade', upgradeAudit, 'language:name', '我是微信助手。'],
]) {
  test(`${name} audit requires live generation settings before context access`, async () => {
    let contextReads = 0;
    const ctx = new Proxy({}, { get() { contextReads++; throw new Error('No context access expected'); } });
    for (const productionModelConfig of [undefined, null, {}, { temperature: 0.7 }, { maxTokens: null }]) {
      await assert.rejects(audit.runPersonaAudit({ ctx, selection: syntheticSelection, productionModelConfig }), /productionModelConfig.*running Agent/u);
    }
    assert.equal(contextReads, 0);
  });

  test(`${name} audit preserves the model, explicit reasoning and both default and explicit generation controls`, async t => {
    for (const controls of [{ temperature: null, maxTokens: null }, { temperature: 0, maxTokens: 8192 }]) {
      const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-audit-settings-test-'));
      t.after(() => removeOwnedTemp(outputRoot, 'wechat-audit-settings-test-'));
      const observed = [];
      class RecordingRunner {
        constructor(_ctx, getSelection, getRuntime) {
          observed.push({ selection: structuredClone(getSelection()), runtime: structuredClone(getRuntime()) });
        }
        async run(request) { await request.onSession?.('synthetic-session'); return { text: answer, sessionId: 'synthetic-session' }; }
      }
      const productionModelConfig = Object.freeze({ ...controls, webSearch: true, vision: true });
      audit.caseIds = [caseId];
      let report;
      try {
        report = await audit.runPersonaAudit({ ctx: {}, testing: { ...testing, DshAgentRunner: RecordingRunner },
          sourceRoot: repo, outputRoot, signal: new AbortController().signal,
          selection: Object.freeze({ ...syntheticSelection }), productionModelConfig, onProgress() {} });
      } finally { delete audit.caseIds; }
      if (report.syntheticWorkspaceRoot) t.after(() => removeOwnedTemp(report.syntheticWorkspaceRoot, `wechat-${name}-audit-`));
      assert.equal(report.completed, true);
      assert.equal(report.automatedChecksPassed, true, JSON.stringify(report.failures));
      assert.equal(report.modelCalls, 1);
      assert.deepEqual(report.model, syntheticSelection);
      assert.deepEqual(report.generationSettings, controls);
      assert.deepEqual(observed[0].selection, syntheticSelection);
      assert.equal(observed[0].runtime.modelConfig.temperature, controls.temperature);
      assert.equal(observed[0].runtime.modelConfig.maxTokens, controls.maxTokens);
      assert.equal(observed[0].runtime.modelConfig.webSearch, false);
      assert.deepEqual(productionModelConfig, { ...controls, webSearch: true, vision: true });
    }
  });
}

const require = createRequire(import.meta.url);
const configSource = fs.readFileSync(new URL('../scripts/prompt-config-live-cases.cjs', import.meta.url), 'utf8');
function activeFixture({ expired = false, followHost = false, notesChange = false, hostChanges = false } = {}) {
  const writes = [], generated = [], settings = [], reads = [];
  const status = { account: { id: 'synthetic-owner' }, conversations: [], persona: { name: '合成助手', prompt: '自然接话' },
    settings: { prompt: '' }, modelChoice: followHost ? null : syntheticSelection,
    modelConfig: { temperature: 0.45, maxTokens: 4096, webSearch: true } };
  let notesReads = 0, statusReads = 0;
  const exports = { casePrefixes: ['active:memory:'] };
  vm.runInNewContext(configSource, {
    exports, AbortSignal, structuredClone,
    require: name => name === 'node:fs' ? {
      writeFileSync: (...args) => writes.push(args), mkdirSync() {}, mkdtempSync: value => value + 'synthetic',
    } : name === 'node:child_process' ? {
      execFile: (_cmd, _args, _options, callback) => callback({ code: 128 }, '', 'not a git repository'),
    } : require(name),
    fetch: async (_url, options) => {
      if (options.redirect) return { status: 303, headers: { getSetCookie: () => ['test-cookie=private; HttpOnly'] } };
      const { method, payload } = JSON.parse(options.body); reads.push({ method, payload });
      let value;
      if (method === 'status') { statusReads++; value = status; }
      else if (method === 'identity.get') value = { markdown: 'SYNTHETIC_IDENTITY' };
      else if (method === 'memory.global.get') value = { globalNotes: notesChange && ++notesReads > 1 ? 'CHANGED_NOTE' : 'SYNTHETIC_NOTE', globalNotesExpired: expired };
      else throw new Error('Unexpected RPC');
      return { ok: true, json: async () => ({ result: { ok: true, value } }) };
    },
  }, { filename: 'prompt-config-live-cases.cjs' });
  const options = {
    ctx: { webServer: { protocol: 'http:', port: 12345 }, connection: { authenticatedUrl: origin => origin + '/login' },
      agentDefaultModel: { currentSelection: () => hostChanges && statusReads > 1 ? { ...syntheticSelection, model: 'changed-host-model' } : syntheticSelection } },
    testing: { ChannelError: testing.ChannelError, personaText: testing.personaText,
      DshAgentRunner: class {
        constructor(_ctx, model, runtime) { settings.push({ model: structuredClone(model()), runtime: runtime() }); }
        async run(request) { generated.push(request); request.onSession?.('synthetic-session'); return { text: '青藤书店。' }; }
      } },
    outputRoot: 'synthetic-output', signal: new AbortController().signal, selection: syntheticSelection, onProgress() {},
  };
  return { run: exports.runPersonaAudit, options, generated, settings, reads, writes };
}

test('active configuration audit preserves saved or inherited model settings and includes only unexpired notes', async () => {
  for (const followHost of [false, true]) for (const expired of [false, true]) {
    const f = activeFixture({ expired, followHost });
    const report = await f.run(f.options);
    assert.equal(report.automatedChecksPassed, true);
    assert.equal(report.ownerNotesUnchanged, true);
    assert.equal(report.modelCalls, 1);
    assert.deepEqual(f.settings[0].model, syntheticSelection);
    assert.equal(f.settings[0].runtime.modelConfig.temperature, 0.45);
    assert.equal(f.settings[0].runtime.modelConfig.maxTokens, 4096);
    assert.equal(f.generated[0].adminNotes, expired ? '' : 'SYNTHETIC_NOTE');
    assert(f.reads.filter(row => row.method === 'memory.global.get').every(row => row.payload.accountId === 'synthetic-owner'));
    assert(!f.writes.some(([, value]) => value.includes('test-cookie=private')));
  }
});

test('active configuration audit rejects model or reasoning mismatches before generation', async () => {
  for (const selection of [{ ...syntheticSelection, model: 'other-model' }, { ...syntheticSelection, reasoningEffort: 'low' }]) {
    const f = activeFixture();
    await assert.rejects(f.run({ ...f.options, selection }), /match the running Agent/u);
    assert.equal(f.generated.length, 0);
  }
});

test('active configuration audit reports a note change instead of declaring configuration preserved', async () => {
  const f = activeFixture({ notesChange: true });
  await assert.rejects(f.run(f.options), /owner notes changed/u);
});

test('active configuration audit notices a changed inherited host model', async () => {
  const f = activeFixture({ followHost: true, hostChanges: true });
  await assert.rejects(f.run(f.options), /running Agent model changed/u);
});
