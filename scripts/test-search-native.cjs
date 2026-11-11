/* Isolated installed DSH SDK; model, search responses and WeChat ACKs are fixtures. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module'), { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..'), installation = process.argv[2] || process.env.DSH_INSTALLATION;
if (!installation) throw Error('Pass the DSH installation directory');
if (!process.versions.electron) {
  const run = spawnSync(path.join(installation, 'DeepSeek Harness.exe'), ['--expose-internals', __filename, installation], {
    windowsHide: true, encoding: 'utf8', timeout: 90000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
  if (run.error) console.error(run.error.message); process.exit(run.status ?? 1);
}
const host = createRequire(path.join(installation, 'resources/app.asar/dsh/package.json'));
const { Context } = host('@deepseek-ai/cordis'), { LlmAdapter } = host('@deepseek-ai/dsh-llm');
const T = require(path.join(repo, 'lib/testing.js'));
fs.mkdirSync(path.join(repo, 'storage/tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'storage/tmp/search-native-'));
process.env.DSH_HOME = path.join(root, 'home'); process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
let current, sequence = 0;
const requests = [], timeline = [], cases = [], forks = [], ctx = new Context();
const evidence = provider => ({ sources: [{ title: 'Native fixture evidence', url: `https://example.org/${provider}`, snippet: 'SYNTHETIC_PUBLIC_FACT' }] });
function* textReply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
}
function* call(name, args) {
  const id = 'search-native-' + ++sequence, value = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
class Fixture extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'] }; }
  async *stream(options) {
    const names = (options.tools || []).map(tool => tool.name), system = options.messages.filter(row => row.role === 'system').flatMap(row => row.content).map(row => row.text || '').join('\n');
    if (system.includes('你为微信会话筛选以后真正用得上的人物事实')) {
      assert.deepEqual(names, []); yield* textReply('{"facts":[]}'); return;
    }
    requests.push({ id: current.id, names, provider: options.provider });
    const results = options.messages.filter(row => row.role === 'tool').flatMap(row => row.content).filter(row => row.type === 'text').map(row => { try { return JSON.parse(row.text); } catch { return {}; } });
    if (!current.search || current.isolated || current.imageRequest) {
      assert(!names.includes('wechat_web_search')); assert(!system.includes('先用 wechat_web_search'));
      yield* textReply('本轮不调用搜索。'); return;
    }
    assert(system.includes('wechat_web_search') && system.includes('公开'));
    if (current.scopedSearch) {
      assert(names.includes('web_search'), 'a preset-local tool survives global restrictions');
      if (!current.hostAttempted) {
        current.hostAttempted = true; yield* call('web_search', {}); return;
      }
      assert(options.messages.some(row => row.role === 'tool' && JSON.stringify(row.content).includes('请使用 wechat_web_search')),
        'a preset-local host search must be redirected before its body executes');
    } else assert(!names.includes('web_search'), 'host search must not bypass the configured fallback');
    if (!names.includes('wechat_web_search')) {
      assert(names.includes('wechat_capabilities')); assert(current.lazy);
      yield* call('wechat_capabilities', { modules: ['search'] }); return;
    }
    const result = results.find(value => value.primaryProvider);
    if (!result) { yield* call('wechat_web_search', { query: 'SYNTHETIC_PUBLIC_QUERY' }); return; }
    assert.equal(result.ok, true); assert.equal(result.primaryProvider, current.primary);
    assert.equal(result.fallbackUsed, current.fail);
    assert.equal(result.provider, current.fail ? current.primary === 'dsh' ? 'tavily' : 'dsh' : current.primary);
    assert.equal(result.sources[0].snippet, 'SYNTHETIC_PUBLIC_FACT');
    if (current.inherited && !results.some(value => value.inherited)) {
      assert(names.includes('native_fixture_read')); yield* call('native_fixture_read', {}); return;
    }
    yield* textReply('原生工具返回了合成公开依据：' + result.sources[0].url);
  }
}
async function mount(name, config = {}) {
  const module = host('@deepseek-ai/' + name), fork = ctx.plugin(module.default || module, config); forks.push(fork); await fork.await();
}
async function main() {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-fs-local']) await mount(name);
  await mount('dsh-tools', { mode: 'native' }); await mount('dsh-working-directory', { defaultDirectory: root });
  await mount('dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: root });
  await mount('dsh-subprocess-local'); await mount('dsh-sandbox-local'); await mount('dsh-pwsh-sandbox');
  await mount('dsh-agent-default-model', { provider: 'native-search-work', model: 'fixture' });
  await mount('dsh-session-persistence-jsonl', { root: path.join(root, 'sessions') }); await mount('dsh-agent-loop', { agents: [] });
  const adapter = ctx.llm.registerAdapter(['native-search-chat', 'native-search-work'], new Fixture());
  const inherited = ctx.tools.register({ name: 'native_fixture_read', description: 'Inherited read-only native fixture', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { assert.equal(timeline.at(-1).kind, 'notice'); timeline.push({ kind: 'inherited', id: current.id }); return '{"inherited":true}'; } });
  const hostSearch = ctx.tools.register({ name: 'web_search', description: 'Unrouted host search fixture', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { throw Error('The scoped plugin search must own search routing'); } });
  const create = ctx.agents.create.bind(ctx.agents);
  ctx.agents.create = async options => {
    try { return await create({ ...options, setup: async (...args) => {
      try {
        if (current?.scopedSearch) args[0].tools.register({ name: 'web_search', description: 'Preset-local host search fixture',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute() { throw Error('The preset-local single-provider search must never execute'); } });
        return await options.setup(...args);
      } catch (error) { console.error('setup:', error.stack); throw error; }
    } }); } catch (error) { console.error('create:', error.stack); throw error; }
  };
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') console.error('native turn:', JSON.stringify(event.data.reason));
  });
  const state = new T.StateStore(path.join(root, 'channel'));
  const scope = { accountId: 'native-search-owner', chatType: 'private', peerId: 'native-search-friend', senderId: 'native-search-friend' };
  state.configure(scope.accountId, { enabled: true, privatePeers: [scope.peerId], groups: [], prompt: '' });
  let runtime = { persona: T.emptyPersona(), workspacePath: root, modelConfig: {} };
  const runner = new T.DshAgentRunner(ctx, () => ({ provider: 'native-search-chat', model: 'fixture' }), () => runtime);
  class Provider {
    constructor(resolveOptions) { this.resolveOptions = resolveOptions; }
    async search(query) {
      assert.equal(this.resolveOptions().apiKey, 'fixture-search-dsh'); assert.equal(query.query, 'SYNTHETIC_PUBLIC_QUERY');
      timeline.push({ kind: 'provider', provider: 'dsh', id: current.id });
      if (current.primary === 'dsh' && current.fail) throw new Error('HTTP 503'); return evidence('dsh');
    }
  }
  const service = new T.SearchService({ credentials: { resolve: async ref => ({ value: ref === T.SEARCH_CREDENTIALS.dsh ? 'fixture-search-dsh' : 'fixture-search-tavily' }) },
    web: { searchProviders: new Map([['deepseek-official', new Provider(() => ({}))]]) } }, { fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); assert.equal(body.api_key, 'fixture-search-tavily'); assert.equal(body.query, 'SYNTHETIC_PUBLIC_QUERY');
      timeline.push({ kind: 'provider', provider: 'tavily', id: current.id });
      return current.primary === 'tavily' && current.fail ? new Response('', { status: 429 }) : Response.json({ results: evidence('tavily').sources });
    } });
  runner.search = service;
  const channel = new T.WechatChannel({ store: state, runner, transport: { status: () => ({ online: true, account: { id: scope.accountId } }),
    send: async payload => {
      assert.equal(payload.accountId, scope.accountId); assert.equal(payload.peerId, scope.peerId);
      const text = payload.message[0].data.text;
      timeline.push({ kind: text.startsWith('我') ? 'notice' : 'final', text, id: current.id });
      return { delivery: 'server-ack', serverMessageIds: ['native-search-ack-' + timeline.length] };
    } } });
  try {
    for (const item of [
      { id: 'chat-lazy', search: true, primary: 'tavily', fail: true, lazy: true, text: '这个说法靠谱吗' },
      { id: 'chat-primary', search: true, primary: 'dsh', fail: false, text: '比較公开研究资料' },
      { id: 'chat-disabled', search: false, primary: 'tavily', text: '核实公开资料' },
      { id: 'internal', search: true, isolated: true, primary: 'tavily', text: '内部记忆整理' },
      { id: 'work-search', work: true, search: true, primary: 'dsh', fail: true, inherited: true, text: '比较公开研究资料' },
      { id: 'work-scoped-search', work: true, search: true, primary: 'tavily', fail: true, scopedSearch: true, text: '核实公开事实' },
      { id: 'work-image', work: true, search: true, primary: 'tavily', imageRequest: { prompt: '合成图案', path: 'fixture.png', providerId: 'fixture', model: 'fixture', size: 'auto' }, text: '生成合成图案' },
    ]) {
      current = item; const start = timeline.length, requestStart = requests.length;
      runtime.modelConfig = { webSearch: item.search, searchProvider: item.primary, promptStrategy: 'progressive-v1' };
      state.setModelConfig({ ...state.modelConfig(), ...runtime.modelConfig });
      if (item.work) {
        const work = new T.DshWorkRunner(runner), abort = new AbortController();
        const result = await work.run({ request: item.text, cwd: root, workspaceRoot: root, signal: abort.signal,
          limits: { commandTimeoutSeconds: 30 }, assertAllowed() {}, onSession() {}, onOperation() {},
          imageGeneration: { catalog: () => ({ defaultProviderId: 'fixture', providers: [{ providerId: 'fixture', models: ['fixture'] }] }),
            generate() { throw Error('Image generation is outside this search isolation check'); } },
          ...(item.imageRequest ? { imageRequest: item.imageRequest } : {}),
          onBeforeTool: T.createToolNotifier(channel, { scope, requestKey: item.id, signal: abort.signal, assertAllowed() {} }) });
        assert(result.text); assert(requests.slice(requestStart).every(row => row.provider === 'native-search-work'));
      } else if (item.isolated) {
        await runner.run({ text: item.text, signal: new AbortController().signal, mode: 'memory', systemOverride: '内部专用协议' });
      } else {
        channel.receive({ id: item.id, serverMessageId: item.id, time: Math.floor(Date.now() / 1000), direction: 'incoming',
          chatType: scope.chatType, peerId: scope.peerId, sender: { id: scope.senderId }, message: [{ type: 'text', data: { text: item.text } }] }, scope.accountId);
        await channel.whenIdle();
        assert.equal(state.data.records.find(row => row.messageId === item.id).state, 'sent');
      }
      const events = timeline.slice(start), providers = events.filter(row => row.kind === 'provider');
      if (item.search && !item.isolated && !item.imageRequest) {
        assert.equal(events[0].kind, 'notice'); assert.equal(providers.length, item.fail ? 2 : 1);
        const first = events.findIndex(row => row.kind === 'provider'); assert(first > 0 && events[first - 1].kind === 'notice');
        assert.equal(runner.searchStatus().provider, providers.at(-1).provider);
        if (item.lazy) assert.equal(events.filter(row => row.kind === 'notice').length, 2);
        if (item.inherited) assert(events.some(row => row.kind === 'inherited'));
      } else assert.equal(providers.length, 0);
      cases.push({ id: item.id, passed: true, requests: requests.length - requestStart, events });
    }
  } finally { await channel.close(); assert(ctx.tools.get('web_search'), 'the parent host search registration must remain intact'); hostSearch(); inherited(); adapter(); }
  const report = { ok: true, at: new Date().toISOString(), cases, requests: requests.length, productionSocialWrites: 0, installedDshSdk: true, syntheticModelAndSearch: true };
  fs.mkdirSync(path.join(repo, 'storage/logs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'storage/logs/search-native-test.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, cases: cases.length, requests: requests.length, productionSocialWrites: 0 }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  for (const fork of forks.reverse()) await fork.dispose(); setTimeout(() => process.exit(process.exitCode || 0), 20);
});
