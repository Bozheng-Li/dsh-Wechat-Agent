/* Isolated DSH SDK, one synthetic running Agent, read-only computer queries,
 * mock WeChat ACKs. Never loads a user profile or real model credentials. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createRequire } = require('node:module'), { spawnSync } = require('node:child_process');
const installation = process.argv[2], repo = path.resolve(__dirname, '..');
if (!installation) throw Error('Pass the DSH installation directory');
if (!process.versions.electron) {
  const result = spawnSync(path.join(installation, 'DeepSeek Harness.exe'), ['--expose-internals', __filename, installation],
    { windowsHide: true, encoding: 'utf8', timeout: 45000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 && result.stdout?.includes('"ok":true') ? 0 : 1);
}
const host = createRequire(path.join(installation, 'resources/app.asar/dsh/package.json'));
const { Context } = host('@deepseek-ai/cordis'), { LlmAdapter } = host('@deepseek-ai/dsh-llm');
const { StateStore, DshAgentRunner, WechatChannel } = require(path.join(repo, 'lib/testing.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-remote-native-'));
process.env.DSH_HOME = path.join(root, 'home'); process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
const started = Promise.withResolvers(), finish = Promise.withResolvers(); let requests = 0;
class Fixture extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }]; }
  async resolveModel(provider, id) { return { provider, id, name: 'Fixture', inputModalities: ['text'] }; }
  async *stream(options) {
    requests++;
    const intent = options.messages.filter(message => message.role === 'system').flatMap(message => message.content).some(block => block.text?.includes('REMOTE_QUERY_INTENT'));
    if (intent) {
      assert.deepEqual(options.tools, []); assert(JSON.stringify(options.messages).includes('DSH 任务跑到哪了'));
      const text = '{"queries":[{"action":"tasks"}]}';
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    started.resolve(); await finish.promise;
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Finished original task' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Finished original task' } }; yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
(async () => {
  const ctx = new Context(), forks = []; let handle, channel, registration;
  let phase = 'mounting';
  const watchdog = setTimeout(() => { console.error('Native remote verification timed out at ' + phase); process.exit(1); }, 30000);
  ctx.baseUrl = require('node:url').pathToFileURL(path.join(installation, 'resources/app.asar/dsh/cordis.yml')).href;
  const mount = async (name, config = {}) => { const module = host('@deepseek-ai/' + name), fork = ctx.plugin(module.default || module, config); forks.push(fork); await fork.await(); };
  try {
    await mount('dsh-session'); await mount('dsh-session-projection'); await mount('dsh-agent'); await mount('dsh-llm');
    await mount('dsh-attachment-local', { dshHome: process.env.DSH_HOME }); await mount('dsh-system-prompt');
    await mount('dsh-fs-local'); await mount('dsh-working-directory', { defaultDirectory: root }); await mount('dsh-tools', { mode: 'native' });
    await mount('dsh-agent-default-model', { provider: 'remote-fixture', model: 'fixture' });
    await mount('dsh-session-persistence-jsonl', { root: path.join(root, 'sessions') }); await mount('dsh-agent-loop', { agents: [] });
    registration = ctx.llm.registerAdapter(['remote-fixture'], new Fixture());
    phase = 'creating original agent';
    handle = await ctx.agents.create({ sessionId: 'remote-native-existing', agentOptions: { provider: 'remote-fixture', model: 'fixture' }, meta: { cwd: root } });
    const agent = handle.agent;
    agent.followup({ id: 'original-request', role: 'user', content: [{ type: 'text', text: 'Synthetic long-running task' }], source: { kind: 'remote-native-fixture' } });
    phase = 'waiting for original model request';
    await Promise.race([started.promise, agent.whenIdle().then(() => { throw Error('Native Agent became idle before the fixture model started: ' + JSON.stringify(agent.session.snapshotEvents(0))); })]); assert.equal(agent.status, 'running');
    const seq = agent.session.seq, originalSession = agent.session;
    const store = new StateStore(path.join(root, 'channel')), accountId = 'wxid_remote_bot', peerId = 'wxid_remote_admin';
    store.configure(accountId, { enabled: true, privatePeers: [peerId], groups: [], prompt: '' });
    store.setConversationSettings(accountId, 'private', peerId, { ...store.conversationSettings(accountId, 'private', peerId), remoteEnabled: true, adminIds: [peerId] });
    const sent = [], transport = { status: () => ({ online: true, account: { id: accountId } }), send: async payload => { sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['native-remote-ack'] }; } };
    channel = new WechatChannel({ store, runner: new DshAgentRunner(ctx, () => null, () => ({})), transport });
    phase = 'querying tasks';
    channel.receive({ id: 'query', direction: 'incoming', chatType: 'private', peerId, sender: { id: peerId }, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '/dsh tasks' } }] }, accountId);
    await channel.whenIdle(); assert.equal(store.data.records.at(-1).state, 'sent'); assert(JSON.stringify(sent).includes('remote-native-existing'));
    const scope = { accountId, chatType: 'private', peerId, senderId: peerId };
    const computer = await channel.remote.query({ action: 'computer' }, scope); assert(computer.includes('内存：')); assert(computer.includes('DSH Host 进程：'));
    assert.equal(ctx.agents.get(agent.id), agent); assert.equal(agent.session, originalSession); assert.equal(agent.session.seq, seq); assert.equal(agent.status, 'running'); assert.equal(requests, 1);
    const next = store.config.snapshot(store.data); next.remote = { globalAdminIds: [peerId] }; store.config.commit(next);
    store.setConversationSettings(accountId, 'private', peerId, { ...store.conversationSettings(accountId, 'private', peerId), adminIds: [] });
    assert((await channel.remote.query({ action: 'task', id: agent.id }, scope)).includes(agent.id));
    await assert.rejects(channel.remote.query({ action: 'tasks' }, { ...scope, senderId: 'wxid_other' }), { code: 'REMOTE_NOT_AUTHORIZED' });
    phase = 'interpreting natural query';
    channel.receive({ id: 'natural-query', direction: 'incoming', chatType: 'private', peerId, sender: { id: peerId }, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'DSH 任务跑到哪了' } }] }, accountId);
    await channel.whenIdle(); assert.equal(store.data.records.at(-1).state, 'sent'); assert.equal(requests, 2);
    assert.equal(ctx.agents.get(agent.id), agent); assert.equal(agent.session, originalSession); assert.equal(agent.session.seq, seq); assert.equal(agent.status, 'running');
    assert.equal(channel.memory.load(scope).entries.length, 0);
    finish.resolve(); await agent.whenIdle(); assert.equal(requests, 2);
    console.log(JSON.stringify({ ok: true, checks: 10, modelRequests: requests, intentRequests: 1, nativeAgentRetainedDuringQueries: true, realComputerQuery: true, actualWeChatMessages: 0 }));
  } finally {
    finish.resolve(); await channel?.close(); if (handle) { handle.agent.cancel({ kind: 'disposed' }); await handle.agent.whenIdle(); await handle.dispose(); }
    registration?.(); for (const fork of forks.reverse()) await fork.dispose(); clearTimeout(watchdog);
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-remote-native-/); fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
