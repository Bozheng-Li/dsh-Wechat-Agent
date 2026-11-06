/* Run through the installed DSH Electron/Node executable, without mounting a
 * user profile, credentials, skills, network providers or a WeChat session. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const installation = process.argv[2] || process.env.DSH_INSTALLATION;
if (!installation) throw new Error('Pass the DeepSeek Harness installation directory as an argument or DSH_INSTALLATION');
for (const name of ['tmp', 'logs']) fs.mkdirSync(path.join(repo, 'storage', name), { recursive: true });
if (!process.versions.electron) {
  const run = spawnSync(path.join(installation, 'DeepSeek Harness.exe'), ['--expose-internals', __filename, installation], {
    windowsHide: true, encoding: 'utf8', timeout: 45000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}
const hostRequire = createRequire(path.join(installation, 'resources/app.asar/dsh/package.json'));
const { Context } = hostRequire('@deepseek-ai/cordis');
const { LlmAdapter } = hostRequire('@deepseek-ai/dsh-llm');
const { buildModelCatalog } = hostRequire('@deepseek-ai/dsh-api-session-controller');
const { DshAgentRunner, WechatChannel, StateStore, ChannelError, selectModel } = require(path.join(repo, 'lib/testing.js'));
const root = fs.mkdtempSync(path.join(repo, 'storage/tmp/dsh-native-'));
process.env.DSH_HOME = path.join(root, 'home');
process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
const ctx = new Context();
const requests = [];
let mode = 'complete';
class FixtureAdapter extends LlmAdapter {
  async listModels(provider) {
    return ['fixture', 'alternate'].map(id => ({ provider, id, name: `测试模型 ${id}` }));
  }
  async resolveModel(provider, id) {
    return { provider, id, name: `测试模型 ${id}`, reasoning: {
      efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], defaultEffort: id === 'alternate' ? 'low' : 'high'
    } };
  }
  async *stream(options) {
    requests.push(options);
    assert.equal(options.tools?.length || 0, 0, 'WeChat must not inherit host tools');
    const systems = options.messages.filter(m => m.role === 'system').flatMap(m => m.content).map(b => b.text || '').join('\n');
    assert(systems.includes('微信')); assert(!systems.includes('HOST_SECRET_PERSONA'));
    if (mode === 'cancel') {
      await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_TEST_REASONING' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_TEST_REASONING' } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: '<think>HIDDEN</think>DSH 原生回复完成' };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: '<think>HIDDEN</think>DSH 原生回复完成' } };
    yield { type: 'finish', reason: { kind: mode === 'truncate' ? 'max-tokens' : 'stop' } };
  }
}

(async () => {
  const forks = [];
  const mount = async (name, config = {}) => {
    const module = hostRequire(`@deepseek-ai/${name}`);
    const fork = ctx.plugin(module.default || module, config); forks.push(fork); await fork.await();
    return fork;
  };
  await mount('dsh-session');
  await mount('dsh-session-projection');
  await mount('dsh-agent');
  await mount('dsh-llm');
  await mount('dsh-system-prompt', { personaPrefix: 'HOST_SECRET_PERSONA' });
  await mount('dsh-tools', { mode: 'native' });
  await mount('dsh-agent-default-model', { provider: 'wechat-test-fixture', model: 'fixture', reasoningEffort: 'high' });
  await mount('dsh-session-persistence-jsonl', { root: path.join(root, 'sessions') });
  await mount('dsh-agent-loop', { agents: [] });
  const providers = ['wechat-test-fixture', 'wechat-test-alternate'];
  const registration = ctx.llm.registerAdapter(providers, new FixtureAdapter());
  const catalog = await buildModelCatalog(ctx);
  assert.deepEqual(catalog.groups.map(group => group.id), providers); assert.equal(catalog.failures.length, 0);
  assert(catalog.groups.every(group => group.models.some(model => model.id === 'alternate')));
  const store = new StateStore(path.join(root, 'channel'));
  const runner = new DshAgentRunner(ctx, () => store.modelChoice()), controller = new AbortController();
  const first = await runner.run({ text: '第一问', group: true, prompt: '回答简洁', signal: controller.signal });
  assert.equal(first.text, 'DSH 原生回复完成');
  assert.equal(requests[0].provider, 'wechat-test-fixture'); assert.equal(requests[0].model, 'fixture'); assert.equal(requests[0].reasoningEffort, 'high');
  await selectModel(ctx, store, { provider: 'wechat-test-alternate', model: 'alternate' });
  assert.deepEqual(new StateStore(path.join(root, 'channel')).modelChoice(), { provider: 'wechat-test-alternate', model: 'alternate' });
  const second = await runner.run({ text: '第二问', group: true, sessionId: first.sessionId, signal: controller.signal });
  assert.equal(second.sessionId, first.sessionId);
  assert(requests[1].messages.some(m => m.role === 'user' && m.content.some(b => b.text === '第一问')));
  assert.equal(requests[1].provider, 'wechat-test-alternate'); assert.equal(requests[1].model, 'alternate'); assert.equal(requests[1].reasoningEffort, 'low');
  registration.replace(['wechat-test-fixture']);
  assert.equal((await buildModelCatalog(ctx)).groups.length, 1);
  await assert.rejects(runner.run({ text: '所选服务已停用', group: false, signal: controller.signal }), error => error.code === 'MODEL_UNAVAILABLE');
  assert.equal(requests.length, 2);
  await selectModel(ctx, store, null);
  await runner.run({ text: '恢复跟随默认', group: true, sessionId: first.sessionId, signal: controller.signal });
  assert.equal(requests[2].provider, 'wechat-test-fixture'); assert.equal(requests[2].model, 'fixture'); assert.equal(requests[2].reasoningEffort, 'high');
  mode = 'truncate';
  await assert.rejects(runner.run({ text: '截断测试', group: false, signal: controller.signal }), error => error.code === 'MODEL_INCOMPLETE');
  mode = 'cancel'; const cancelling = new AbortController();
  const pending = runner.run({ text: '取消测试', group: false, signal: cancelling.signal });
  const timeout = setTimeout(() => cancelling.abort(new ChannelError('CANCELLED', 'test cancellation')), 100);
  await assert.rejects(pending); clearTimeout(timeout);
  mode = 'complete';
  store.configure('fake-owner', { enabled: true, privatePeers: ['fake-friend'], groups: [], prompt: '' });
  const sent = [];
  const transport = { status: () => ({ online: true, account: { id: 'fake-owner' } }), send: async params => { sent.push(params); return { delivery: 'server-ack', serverMessageIds: [`mock-ack-${sent.length}`] }; } };
  const channel = new WechatChannel({ store, runner, transport });
  const incoming = n => ({ id: `mock-${n}`, serverMessageId: String(n), direction: 'incoming', chatType: 'private', peerId: 'fake-friend', sender: { id: 'fake-friend' }, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: `隔离链路 ${n}` } }] });
  channel.receive(incoming(1), 'fake-owner'); channel.receive(incoming(2), 'fake-owner'); await channel.whenIdle();
  assert.equal(sent.length, 2); assert(store.data.records.every(r => r.state === 'sent'));
  await channel.close();
  const reloaded = new WechatChannel({ store: new StateStore(path.join(root, 'channel')), runner, transport });
  reloaded.receive(incoming(1), 'fake-owner'); await reloaded.whenIdle(); await reloaded.close(); assert.equal(sent.length, 2);
  const report = { ok: true, dsh: hostRequire('./package.json').version, node: process.versions.node,
    assertions: ['shared native model catalog', 'model choice persistence', 'real provider/model routing on resume', 'chosen model reasoning defaults', 'removed provider refuses fallback', 'return to DSH default', 'real agent create', 'persistent resume', 'complete prompt isolation', 'no inherited tools', 'final reasoning filtering', 'max-token refusal', 'cancellation', 'queued channel-to-agent-to-ACK', 'reload deduplication'], requests: requests.length, at: new Date().toISOString() };
  fs.writeFileSync(path.join(repo, 'storage/logs/dsh-plugin-native-test.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const fork of forks.reverse()) await fork.dispose();
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  // The standalone SDK fixture has no user work and may retain infrastructure
  // timers; all per-message Agent handles and channel work have already drained.
  setTimeout(() => process.exit(process.exitCode || 0), 20);
});
