/* Installed DSH kernel acceptance for synchronized persona behavior.
 * Uses a fresh Cordis Context and synthetic adapter only: no user profile,
 * credentials, network providers, production WeChat runtime or social writes.
 * Usage: node scripts/test-sync-persona-native.cjs D:\\deepseek-harness
 * Build the plugin testing exports before running this script. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const installation = process.argv[2] || process.env.DSH_INSTALLATION;
if (!installation) throw Error('Pass the installed DSH directory as an argument or DSH_INSTALLATION');
if (!process.versions.electron) {
  const result = spawnSync(path.join(installation, 'DeepSeek Harness.exe'), ['--expose-internals', __filename, installation], {
    stdio: 'inherit', windowsHide: true, timeout: 180000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const tempParent = path.join(repo, 'storage', 'tmp');
fs.mkdirSync(tempParent, { recursive: true });
const root = fs.mkdtempSync(path.join(tempParent, 'sync-persona-native-'));
process.env.DSH_HOME = path.join(root, 'home');
process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
process.env.DSH_PROFILE_DIR = path.join(root, 'profile');
process.chdir(root);
const host = createRequire(path.join(installation, 'resources', 'app.asar', 'dsh', 'package.json'));
const { Context } = host('@deepseek-ai/cordis');
const { LlmAdapter } = host('@deepseek-ai/dsh-llm');
const T = require(path.join(repo, 'lib', 'testing.js'));
assert.equal(typeof T.DshAgentRunner, 'function', 'Build lib/testing.js before native persona acceptance');
assert.equal(typeof T.previewPersonaChat, 'function', 'Build the synchronized persona testing exports before this run');
const dshManifest = JSON.parse(fs.readFileSync(path.join(installation, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
assert.equal(dshManifest.name, '@deepseek-ai/dsh', 'The installation anchor is not the DSH CLI package');
const dshVersion = dshManifest.version;

const ctx = new Context();
const forks = [], cases = [], requests = [], creations = [];
let registration, forbiddenTool, scenario, forbiddenExecutions = 0, fixtureExecutions = 0, networkRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkRequests++; throw Error('Network access is forbidden in the native persona fixture'); };
const persona = { name: '小满', aliases: [], prompt: 'PERSONA_NATIVE_VOICE：自然完整地接话。', personaMode: 'standard' };
const state = { selection: { provider: 'sync-persona-fixture', model: 'one', reasoningEffort: 'low' },
  runtime: { persona: structuredClone(persona), identityMarkdown: 'PERSONA_OWNER_REQUIREMENT',
    modelConfig: { promptStrategy: 'legacy', webSearch: false, maxTokens: 4096, temperature: 0.2 } } };
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
const systemOf = options => options.messages.filter(message => message.role === 'system').map(textOf).join('\n');
const inputOf = options => textOf(options.messages.findLast(message => message.role === 'user'));
const toolOutputs = options => options.messages.filter(message => message.role === 'tool').map(textOf);
function* textReply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function* callRead() {
  const block = { type: 'tool-call', id: 'persona-native-read', name: 'persona_fixture_read', arguments: '{}' };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
class PersonaAdapter extends LlmAdapter {
  async listModels(provider) { return ['one', 'two'].map(id => ({ provider, id, name: 'Synthetic persona ' + id })); }
  async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], defaultMaxTokens: 16384,
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }; }
  async *stream(options) {
    try {
      assert(scenario, 'A native request escaped its case');
      const system = systemOf(options), input = inputOf(options), tools = (options.tools || []).map(tool => tool.name);
      const expression = system.includes('这是后台发起的独立人设表达阶段');
      const planning = !expression && system.includes('高精度人设模式的第一阶段');
      const row = { case: scenario.name, strategy: state.runtime.modelConfig.promptStrategy,
        phase: expression ? 'expression' : planning ? 'planning' : 'single',
        sessionId: options.sessionId, provider: options.provider, model: options.model,
        reasoningEffort: options.reasoningEffort, tools };
      requests.push(row);
      assert(!tools.includes('host_persona_forbidden'), 'A host tool leaked into the WeChat agent');
      assert(!system.includes('HOST_PERSONA_SENTINEL'), 'The host persona leaked into the WeChat prompt');
      assert(!options.messages.some(message => textOf(message).includes('Current working directory:')),
        'The unrelated host working-directory prompt leaked into the conversation');
      if (scenario.kind === 'high') {
        assert.equal(options.model, 'one', 'An in-flight selection changed model');
        assert.equal(options.reasoningEffort, 'low', 'An in-flight selection changed reasoning effort');
        if (expression) {
          assert.deepEqual(tools, [], 'Expression inherited tools');
          assert(system.includes('PERSONA_NATIVE_VOICE')); assert(!system.includes('MUTATED_PERSONA'));
          assert(system.includes('2026-11-21T00:00:02+08:00'));
          assert(!system.includes('不扮演聊天角色'), 'Expression inherited the extraction-only instruction');
          const evidence = JSON.parse(input);
          assert.equal(evidence.request, 'NATIVE_HIGH_REQUEST');
          assert.equal(evidence.clock.currentTime, '2026-11-21T00:00:02+08:00');
          assert(evidence.recentConversation.some(message => message.text === 'ORIGINAL_HISTORY'));
          assert(!JSON.stringify(evidence).includes('MUTATED_HISTORY'));
          assert(evidence.references.some(reference => reference.tool === 'persona_fixture_read' && reference.text.includes('NATIVE_CONFIRMED_EVIDENCE')),
            'Expression did not receive the actually executed native tool result');
          yield* textReply('原生两阶段最终回复'); return;
        }
        assert(planning, 'High precision omitted the planning protocol');
        assert(!system.includes('PERSONA_NATIVE_VOICE'), 'Planning inherited the authored voice');
        assert.deepEqual(tools, ['persona_fixture_read']);
        if (!toolOutputs(options).length) { yield* callRead(); return; }
        assert(toolOutputs(options).some(text => text.includes('NATIVE_CONFIRMED_EVIDENCE')));
        yield* textReply(JSON.stringify({ request: '本轮需求', facts: ['真实工具证据已读取'], constraints: ['按角色表达'], unknown: ['其余情况未知'] })); return;
      }
      if (scenario.kind === 'skip') {
        assert(planning); assert.deepEqual(tools, [], 'Natural planning inherited a non-person/sticker tool');
        assert(system.includes('未授权冷场主动开题'));
        yield* textReply('{"action":"skip","reason":"no_topic","text":""}'); return;
      }
      if (scenario.kind === 'preview-high') {
        assert.deepEqual(tools, []);
        if (expression) {
          assert(system.includes('DRAFT_NATIVE_PERSONA'));
          const evidence = JSON.parse(input);
          assert(evidence.recentConversation.some(message => message.text === 'PREVIEW_HISTORY'));
          yield* textReply('原生高精度试聊'); return;
        }
        assert(planning); assert(!system.includes('DRAFT_NATIVE_PERSONA'));
        yield* textReply('{"request":"接话","facts":[],"constraints":[],"unknown":[]}'); return;
      }
      assert(!expression && !planning, 'Standard mode unexpectedly entered a second stage');
      assert.deepEqual(tools, []);
      if (scenario.kind === 'preview') {
        assert(system.includes('DRAFT_NATIVE_PERSONA')); assert(input.includes('PREVIEW_HISTORY'));
        yield* textReply('原生标准试聊'); return;
      }
      assert(system.includes('PERSONA_NATIVE_VOICE')); assert(input.includes('NATIVE_STANDARD_REQUEST'));
      yield* textReply('原生单阶段回复');
    } catch (error) {
      console.error('Native persona adapter assertion:', error.stack || error);
      throw error;
    }
  }
}
async function mount(name, config = {}) {
  const module = host('@deepseek-ai/' + name);
  const fork = ctx.plugin(module.default || module, config);
  forks.push(fork); await fork.await();
}
const signal = () => AbortSignal.timeout(60000);
function reset(strategy = 'legacy') {
  state.selection = { provider: 'sync-persona-fixture', model: 'one', reasoningEffort: 'low' };
  state.runtime = { persona: structuredClone(persona), identityMarkdown: 'PERSONA_OWNER_REQUIREMENT',
    modelConfig: { promptStrategy: strategy, webSearch: false, maxTokens: 4096, temperature: 0.2 } };
}
async function runCase(name, kind, strategy, body) {
  reset(strategy); scenario = { name, kind };
  const from = requests.length, createdFrom = creations.length, executedFrom = fixtureExecutions;
  try {
    await body();
    const rows = requests.slice(from), nativeSessions = creations.slice(createdFrom);
    assert(rows.length, 'Case did not reach the installed DSH adapter');
    assert.equal(forbiddenExecutions, 0); assert.equal(networkRequests, 0);
    cases.push({ name, ok: true, requests: rows.length, sessions: nativeSessions.length, phases: rows.map(row => row.phase),
      toolExecutions: fixtureExecutions - executedFrom });
  } catch (error) {
    cases.push({ name, ok: false, error: error.message, requests: requests.length - from });
    throw error;
  } finally { scenario = null; }
}
async function main() {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm']) await mount(name);
  await mount('dsh-system-prompt', { personaPrefix: 'HOST_PERSONA_SENTINEL' });
  await mount('dsh-fs-local');
  await mount('dsh-working-directory', { defaultDirectory: root });
  let explicitNativeExecutor = false;
  try { host.resolve('@deepseek-ai/dsh-tool-executor-native'); explicitNativeExecutor = true; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (explicitNativeExecutor) {
    await mount('dsh-tools', {});
    await mount('dsh-tool-executor-native');
  } else await mount('dsh-tools', { mode: 'native' });
  await mount('dsh-agent-default-model', { provider: 'sync-persona-fixture', model: 'one', reasoningEffort: 'low' });
  await mount('dsh-session-persistence-jsonl', { root: path.join(root, 'sessions') });
  await mount('dsh-agent-loop', { agents: [] });
  registration = ctx.llm.registerAdapter(['sync-persona-fixture'], new PersonaAdapter());
  forbiddenTool = ctx.tools.register({ name: 'host_persona_forbidden', description: 'A host tool that no persona call may inherit.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { forbiddenExecutions++; throw Error('A forbidden host tool executed'); } });
  const create = ctx.agents.create.bind(ctx.agents);
  ctx.agents.create = async options => { creations.push({ sessionId: options.sessionId, selection: { ...options.agentOptions } }); return create(options); };
  const runner = new T.DshAgentRunner(ctx, () => state.selection, () => state.runtime);
  for (const strategy of ['legacy', 'progressive-v1']) {
    await runCase('standard-' + strategy, 'standard', strategy, async () => {
      const from = requests.length;
      const result = await runner.run({ text: 'NATIVE_STANDARD_REQUEST', signal: signal() });
      assert.equal(result.text, '原生单阶段回复'); assert.equal(result.personaPasses, 1);
      assert.equal(requests.length - from, 1);
    });
    await runCase('high-precision-evidence-' + strategy, 'high', strategy, async () => {
      state.runtime.persona.personaMode = 'high-precision';
      const history = [{ text: 'ORIGINAL_HISTORY', senderId: 'fixture-speaker', senderName: '合成人物', direction: 'incoming', time: Date.parse('2026-11-20T23:59:58+08:00') }];
      const from = requests.length, createdFrom = creations.length, executedFrom = fixtureExecutions;
      const read = { name: 'persona_fixture_read', description: 'Return a deterministic source, with no external effects.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute() {
          fixtureExecutions++;
          state.selection = { provider: 'sync-persona-fixture', model: 'two', reasoningEffort: 'high' };
          state.runtime.persona.prompt = 'MUTATED_PERSONA'; history[0].text = 'MUTATED_HISTORY';
          return '{"ok":true,"fact":"NATIVE_CONFIRMED_EVIDENCE"}';
        } };
      const result = await runner.run({ text: 'NATIVE_HIGH_REQUEST', history, tools: [read], signal: signal(),
        now: () => Date.parse('2026-11-21T00:00:02+08:00'), messageTime: Date.parse('2026-11-20T23:59:59+08:00'), timeZone: 'Asia/Shanghai' });
      assert.equal(result.text, '原生两阶段最终回复'); assert.equal(result.personaApplied, true); assert.equal(result.personaPasses, 2);
      assert.equal(fixtureExecutions - executedFrom, 1);
      const rows = requests.slice(from), sessions = creations.slice(createdFrom);
      assert.deepEqual(rows.map(row => row.phase), ['planning', 'planning', 'expression']);
      assert.equal(sessions.length, 2); assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
      assert(sessions.every(row => row.selection.model === 'one' && row.selection.reasoningEffort === 'low'));
      assert.equal(result.requestMetrics.length, 3); assert(result.requestMetrics.some(row => row.personaPass === 'expression'));
    });
    await runCase('natural-skip-' + strategy, 'skip', strategy, async () => {
      state.runtime.persona.personaMode = 'high-precision';
      let decision;
      const from = requests.length;
      const result = await runner.run({ text: '合成群聊参与', mode: 'natural', naturalDecision: { trigger: 'count', allowColdOpening: false, smartSkip: true },
        tools: [{ name: 'persona_fixture_denied', description: 'Must be filtered out', parameters: { type: 'object' }, execute() { throw Error('Unexpected natural tool'); } }],
        allowEmptyReply: true, selectReplyText: raw => { decision = JSON.parse(raw); return decision.text; }, signal: signal() });
      assert.equal(decision.action, 'skip'); assert.equal(result.text, ''); assert.equal(result.personaApplied, false);
      assert.equal(requests.length - from, 1);
    });
  }
  await runCase('draft-preview-standard', 'preview', 'legacy', async () => {
    const result = await T.previewPersonaChat(runner, { text: '试聊当前草稿', persona: { ...persona, prompt: 'DRAFT_NATIVE_PERSONA', personaMode: 'standard' },
      messages: [{ role: 'user', content: 'PREVIEW_HISTORY' }, { role: 'assistant', content: 'PREVIEW_OLD_VOICE' }] }, signal());
    assert.equal(result.text, '原生标准试聊'); assert.equal(result.personaMode, 'standard'); assert.equal(result.modelCalls, 1);
  });
  await runCase('draft-preview-high-precision', 'preview-high', 'legacy', async () => {
    const result = await T.previewPersonaChat(runner, { text: '试聊高精度草稿', persona: { ...persona, prompt: 'DRAFT_NATIVE_PERSONA', personaMode: 'high-precision' },
      messages: [{ role: 'user', content: 'PREVIEW_HISTORY' }] }, signal());
    assert.equal(result.text, '原生高精度试聊'); assert.equal(result.personaMode, 'high-precision'); assert.equal(result.modelCalls, 2);
  });
  assert(ctx.tools.get('host_persona_forbidden'), 'The agent restriction changed the root host registry');
  assert.equal(networkRequests, 0); assert.equal(forbiddenExecutions, 0);
}
const reportFile = path.join(root, 'report.json');
(async () => {
  let failure;
  try { await main(); } catch (error) { failure = error; }
  finally {
    try { forbiddenTool?.(); } catch (error) { failure ??= error; }
    try { if (typeof registration === 'function') registration(); else registration?.dispose?.(); } catch (error) { failure ??= error; }
    for (const fork of forks.reverse()) { try { await fork.dispose(); } catch (error) { failure ??= error; } }
    globalThis.fetch = originalFetch;
  }
  const report = { ok: !failure, dshVersion, electron: process.versions.electron, node: process.versions.node,
    installedDshKernel: true, syntheticAdapter: true, userProfileMounted: false, productionWechatRuntimeMounted: false,
    realModelRequests: 0, networkRequests, productionSocialWrites: 0, forbiddenExecutions,
    cases, requests, fixtureExecutions, root, reportFile,
    ...(failure ? { error: { message: failure.message, stack: failure.stack } } : {}), at: new Date().toISOString() };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  // Infrastructure can retain idle timers; all native agent handles are disposed.
  setTimeout(() => process.exit(process.exitCode || 0), 20);
});
