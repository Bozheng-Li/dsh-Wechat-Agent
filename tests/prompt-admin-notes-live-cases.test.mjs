import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../scripts/prompt-admin-notes-live-cases.cjs', import.meta.url), 'utf8');
const expectedName = '合成亲友甲';
const savedNotes = `${expectedName}是合成助手的爸爸。`;

function fixture({ notes = savedNotes, reply = `${expectedName}是我的爸爸。`, expired = false } = {}) {
  const requests = [], writes = [], modelRequests = [], runnerSettings = [];
  const selection = { provider: 'synthetic-provider', model: 'synthetic-model', reasoningEffort: 'high' };
  const status = { account: { id: 'synthetic-owner' }, conversations: [], persona: { name: '合成助手' },
    settings: { prompt: 'SYNTHETIC_ACCOUNT_RULE' }, modelChoice: selection, modelConfig: { temperature: null, maxTokens: null, webSearch: true } };
  const exports = {};
  vm.runInNewContext(source, {
    exports, AbortSignal, structuredClone,
    require: name => name === 'node:fs' ? {
      writeFileSync: (...args) => writes.push(args), mkdirSync() {},
    } : require(name),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (options.redirect) return { status: 303, headers: { getSetCookie: () => ['synthetic-session=fixture; HttpOnly'] } };
      const { method } = JSON.parse(options.body);
      const value = { status, 'identity.get': { markdown: 'SYNTHETIC_IDENTITY' }, 'memory.global.get': { globalNotes: notes, globalNotesExpired: expired } }[method];
      assert(value, 'Only the fixture owner settings may be read');
      return { ok: true, json: async () => ({ result: { ok: true, value } }) };
    },
  }, { filename: 'prompt-admin-notes-live-cases.cjs' });
  const options = {
    ctx: { webServer: { protocol: 'http:', port: 12345 }, connection: { authenticatedUrl: origin => `${origin}/synthetic-login` } },
    testing: {
      ChannelError: class extends Error {},
      parseNaturalDecision: JSON.parse,
      DshAgentRunner: class {
        constructor(_ctx, model, runtime) { runnerSettings.push({ model: model(), runtime: runtime() }); }
        async run(request) {
          modelRequests.push(request);
          const text = request.mode === 'scheduled' ? '现在核对会议材料。' : request.text === status.persona.name ? '在，怎么了？' : reply;
          return { text: request.selectReplyText ? request.selectReplyText(JSON.stringify({ action: 'reply', text })) : text };
        }
      },
    },
    outputRoot: 'synthetic-output', signal: new AbortController().signal,
    selection, onProgress() {},
    expectedRelationshipName: expectedName,
  };
  return { run: exports.runPersonaAudit, options, requests, writes, modelRequests, runnerSettings };
}

test('relationship audit rejects missing or invalid expected names before any context access or request', async () => {
  for (const expectedRelationshipName of [undefined, null, '', ' \n\t ', 0, {}, []]) {
    const f = fixture();
    let contextReads = 0;
    const ctx = new Proxy({}, { get() { contextReads++; throw new Error('Context must not be accessed'); } });
    await assert.rejects(f.run({ ...f.options, ctx, expectedRelationshipName }), /expectedRelationshipName is required.*no request was sent/u);
    assert.equal(contextReads, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.modelRequests.length, 0);
  }
  await assert.rejects(fixture().run(), /expectedRelationshipName is required/u);
});

test('relationship audit requires the explicit name and relationship to already exist in saved notes', async () => {
  for (const notes of ['合成亲友乙是合成助手的爸爸。', `${expectedName}喜欢看书。`]) {
    const f = fixture({ notes });
    await assert.rejects(f.run(f.options), /relationship note.*not saved/u);
    assert.equal(f.requests.length, 4, 'Only fixture login and three settings reads precede validation');
    assert.equal(f.modelRequests.length, 0);
  }
});

test('relationship audit keeps the expected name out of questions and verifies all six saved-note scenarios', async () => {
  const f = fixture();
  const report = await f.run({ ...f.options, expectedRelationshipName: ` ${expectedName} ` });
  assert.equal(report.completed, true);
  assert.equal(report.automatedChecksPassed, true);
  assert.equal(report.ownerConfigurationUnchanged, true);
  assert.equal(report.modelCalls, 6);
  assert.equal(report.actualWeChatMessages, 0);
  assert.equal(report.notificationsSent, 0);
  assert.equal(report.model.reasoningEffort, 'high');
  assert.equal(f.runnerSettings[0].model.reasoningEffort, 'high');
  assert.equal(f.runnerSettings[0].runtime.modelConfig.temperature, null);
  assert.equal(f.runnerSettings[0].runtime.modelConfig.maxTokens, null);
  assert(!f.writes.some(([file, text]) => String(file).includes('owner-access') || text.includes('synthetic-session=fixture')),
    'Owner cookies must remain only in memory');
  for (const request of f.modelRequests) {
    assert.equal(request.adminNotes, savedNotes);
    assert(!request.text.includes(expectedName));
    assert(!request.memory.includes(expectedName));
  }
});

test('relationship audit rejects a different model or lost reasoning effort before generation', async () => {
  for (const selection of [
    { provider: 'different-provider', model: 'synthetic-model', reasoningEffort: 'high' },
    { provider: 'synthetic-provider', model: 'different-model', reasoningEffort: 'high' },
    { provider: 'synthetic-provider', model: 'synthetic-model' },
  ]) {
    const f = fixture();
    await assert.rejects(f.run({ ...f.options, selection }), /match the running Agent/u);
    assert.equal(f.modelRequests.length, 0);
  }
});

test('expired relationship notes are not used as active configuration', async () => {
  const f = fixture({ expired: true });
  await assert.rejects(f.run(f.options), /relationship note.*not saved/u);
  assert.equal(f.modelRequests.length, 0);
});

test('relationship audit still fails answers with a wrong name, missing relationship or old refusal', async () => {
  for (const reply of ['合成亲友乙是我的爸爸。', expectedName, `${expectedName}说我没爹。`]) {
    const f = fixture({ reply });
    const report = await f.run(f.options);
    assert.equal(report.completed, true);
    assert.equal(report.automatedChecksPassed, false);
    assert.equal(report.failures.length, 4);
    assert(report.failures.every(item => /Saved owner relationship omitted|Old refusal overrode owner relationship/u.test(item.error)));
    assert.equal(report.scenarios.filter(item => item.automatedChecksPassed).length, 2);
  }
});
