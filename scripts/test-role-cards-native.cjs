/* Real installed DSH agents and tool registry; model text and WeChat ACKs are synthetic. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module'), { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..'), installation = process.argv[2] || process.env.DSH_INSTALLATION;
if (!installation) throw Error('Pass the DSH installation directory');
if (!process.versions.electron) {
  const result = spawnSync(path.join(installation, 'DeepSeek Harness.exe'), ['--expose-internals', __filename, installation], {
    windowsHide: true, encoding: 'utf8', timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message); process.exit(result.status ?? 1);
}
const host = createRequire(path.join(installation, 'resources/app.asar/dsh/package.json'));
const { Context } = host('@deepseek-ai/cordis'), { LlmAdapter } = host('@deepseek-ai/dsh-llm');
const T = require(path.join(repo, 'lib/testing.js'));
fs.mkdirSync(path.join(repo, 'storage/tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'storage/tmp/native-person-memory-'));
process.env.DSH_HOME = path.join(root, 'home'); process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
const ctx = new Context(), forks = [], sessions = [], requests = [], sent = [];
const started = Promise.withResolvers(), release = Promise.withResolvers();
let held = false, sequence = 0, channel;
function* answer(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
}
function* call(name, args) {
  const id = 'role-native-' + ++sequence, value = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
class Fixture extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'] }; }
  async *stream(options) {
    const names = (options.tools || []).map(tool => tool.name);
    const textOf = row => (row?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const system = options.messages.filter(row => row.role === 'system').map(textOf).join('\n');
    const user = textOf(options.messages.findLast(row => row.role === 'user'));
    assert(!names.includes('unrelated_native_tool'));
    if (system.includes('你是后台人物记忆 Agent')) {
      const data = JSON.parse(user); assert.deepEqual(names, []);
      assert(data.task.includes('没有待回复'));
      assert(data.outputContract.includes('只输出一个 JSON 对象'));
      assert(user.lastIndexOf('"outputContract"') > user.lastIndexOf('"conversationContext"'));
      requests.push({ mode: 'role-memory', personId: data.person.personId, tools: names });
      if (data.person.personId === 'alice' && !held) { held = true; started.resolve(); await release.promise; }
      const source = data.sources.find(source => source.text.includes('叫我'));
      const updates = source ? [{ field: 'addressAs', value: data.person.personId === 'alice' ? '阿宁' : '阿哲',
        evidence: [{ sourceId: source.id, quote: source.text }] }] : [];
      if (source?.text.includes('红茶')) updates.push({ field: 'preferences', value: '喜欢红茶',
        evidence: [{ sourceId: source.id, quote: source.text }] });
      const moment = data.sources.find(source => source.kind === 'moments');
      if (moment) {
        assert.equal(moment.chatType, 'moments'); assert.equal(moment.senderId, data.person.personId);
        assert.equal(moment.postId, '9007199254740997');
        updates.push({ field: 'preferences', value: '喜欢红茶', evidence: [{ sourceId: moment.id, quote: moment.text }] });
      }
      yield* answer(JSON.stringify({ updates, conflicts: [] })); return;
    }
    if (system.includes('为一个微信会话提取可供以后使用的有来源事实')) {
      assert.deepEqual(names, []); yield* answer('{"facts":[],"unresolved":[]}'); return;
    }
    if (system.includes('把输入草稿校对为可以直接发给微信对方的一条回复')) {
      assert.deepEqual(names, []);
      assert(!system.includes('不扮演聊天角色'), 'reply review must preserve the supplied character voice');
      requests.push({ mode: 'reply-review', tools: names });
      yield* answer(JSON.parse(user).draft); return;
    }
    const moment = system.includes('NATIVE_MOMENTS_ROLE_READ');
    const groupRead = user.includes('NATIVE_GROUP_ROLE_READ'), update = user.includes('NATIVE_ROLE_UPDATE');
    if (moment) {
      assert(!system.includes('不扮演聊天角色'), 'Moments must retain the supplied persona');
      assert(!system.includes('不调用工具'), 'Moments must permit the actual role-card tools');
      assert(system.includes('有主见，也讲证据'), 'Moments must receive the configured persona');
    }
    const results = options.messages.filter(row => row.role === 'tool').flatMap(row => row.content || [])
      .filter(block => block.type === 'text').map(block => { try { return JSON.parse(block.text); } catch { return {}; } });
    const read = results.find(result => result.personId === 'alice' && result.card);
    requests.push({ mode: moment ? 'moments-reply' : update ? 'role-update' : groupRead ? 'group-chat' : 'chat', tools: names });
    if (!names.includes('wechat_role_card')) {
      assert(names.includes('wechat_capabilities')); yield* call('wechat_capabilities', { modules: ['memory'] }); return;
    }
    if (update) {
      if (!results.some(result => result.queued && result.personId === 'alice')) {
        yield* call('wechat_role_card', { action: 'update', personId: 'alice', reason: '核对本人明确纠正的称呼' }); return;
      }
      yield* answer('已排入独立后台更新。'); return;
    }
    if (!read) { yield* call('wechat_role_card', { action: 'read', personId: 'alice', fields: ['preferences'], includeEvidence: true }); return; }
    if (moment || groupRead) {
      assert.equal(read.card.preferences, '喜欢红茶'); assert(read.evidence.preferences.sources[0].quote.includes('红茶'));
      yield* answer(moment ? '朋友圈读取到了红茶偏好。' : '群聊读取到了红茶偏好。');
    } else {
      assert.equal(read.found, false, 'the held background result is not yet published');
      yield* answer('可以继续聊天。');
    }
  }
}
async function mount(name, config = {}) {
  const module = host('@deepseek-ai/' + name), fork = ctx.plugin(module.default || module, config);
  forks.push(fork); await fork.await();
}
async function main() {
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-fs-local']) await mount(name);
  await mount('dsh-tools', { mode: 'native' }); await mount('dsh-working-directory', { defaultDirectory: root });
  await mount('dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: root });
  for (const name of ['dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-pwsh-sandbox']) await mount(name);
  await mount('dsh-agent-default-model', { provider: 'native-person', model: 'fixture' });
  await mount('dsh-session-persistence-jsonl', { root: path.join(root, 'sessions') });
  await mount('dsh-agent-loop', { agents: [] });
  const adapter = ctx.llm.registerAdapter(['native-person'], new Fixture());
  const disposeTool = ctx.tools.register({ name: 'unrelated_native_tool', description: 'Must never enter person memory',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { throw Error('Unrelated tool executed'); } });
  const create = ctx.agents.create.bind(ctx.agents);
  ctx.agents.create = async options => { sessions.push(options.sessionId); return create(options); };
  const store = new T.StateStore(path.join(root, 'channel')), accountId = 'native-person-owner';
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob', 'carol'], groups: ['native-people@chatroom'], prompt: '' });
  store.setPersona({ name: '小胖', aliases: [], prompt: '有主见，也讲证据。根据事实判断，愿意接受有依据的更正。' });
  store.setModelConfig({ ...store.modelConfig(), promptStrategy: 'progressive-v1', webSearch: false });
  const runner = new T.DshAgentRunner(ctx, () => null, () => ({ persona: store.persona(), workspacePath: root, modelConfig: { promptStrategy: 'progressive-v1', webSearch: false } }));
  channel = new T.WechatChannel({ store, runner, transport: {
    status: () => ({ online: true, account: { id: accountId, nickname: '合成测试' } }),
    send: async value => { sent.push(value); return { delivery: 'server-ack', serverMessageIds: ['fake-ack-' + sent.length] }; },
  } });
  try {
    clearInterval(channel.personMemory.timer); clearTimeout(channel.personMemory.wakeTimer); channel.personMemory.wake = () => {};
    channel.personMemory.lastAccountId = accountId; channel.personMemory.nextScanAt = Infinity;
    const group = { accountId, chatType: 'group', peerId: 'native-people@chatroom' };
    for (const [id, name, text] of [['alice', '阿宁', '叫我阿宁，我喜欢红茶。'], ['bob', '阿哲', '叫我阿哲。']])
      channel.memory.append(group, { key: 'native-role-' + id, time: Date.now(), senderId: id, senderName: name, direction: 'incoming', text });
    channel.personMemory.tick();
    let startTimer;
    try {
      await Promise.race([started.promise, new Promise((_, reject) => {
        startTimer = setTimeout(() => reject(Error(JSON.stringify({ stage: 'background-start', requests,
          errors: [...store.roleCards.errors.values()], people: store.roleCards.list(accountId).map(row => ({ personId: row.personId, error: row.error })) }))), 5000);
      })]);
    } finally { clearTimeout(startTimer); }
    const bob = channel.personMemory.active.get(store.roleCards.identity({ accountId, personId: 'bob' }));
    await bob?.promise;
    assert.equal(store.roleCards.view({ accountId, personId: 'bob' }).card.addressAs, '阿哲');
    assert.equal(store.roleCards.view({ accountId, personId: 'alice' }).card.addressAs, '');
    channel.receive({ id: 'native-chat', time: Math.floor(Date.now() / 1000), direction: 'incoming', chatType: 'private', peerId: 'alice',
      sender: { id: 'alice', nickname: '阿宁' }, message: [{ type: 'text', data: { text: '之前的称呼是什么？' } }] }, accountId);
    await channel.whenIdle();
    assert.equal(sent.length, 1); assert.equal(sent[0].message[0].data.text, '可以继续聊天。');
    assert.equal(channel.personMemory.active.size, 1, 'chat completes while the person agent remains busy');
    release.resolve(); await channel.personMemory.whenIdle();
    const card = store.roleCards.view({ accountId, personId: 'alice' });
    assert.equal(card.card.preferences, '喜欢红茶');
    assert.equal(card.roleId, store.roleCards.identity({ accountId, chatType: 'private', peerId: 'alice' }));
    channel.receive({ id: 'native-group-card', time: Math.floor(Date.now() / 1000), direction: 'incoming', chatType: 'group', peerId: group.peerId,
      sender: { id: 'alice', nickname: '阿宁' }, message: [{ type: 'text', data: { text: '/agent NATIVE_GROUP_ROLE_READ 之前的口味是什么？' } }] }, accountId);
    await channel.whenIdle();
    assert.equal(sent.length, 2, JSON.stringify({ records: store.data.records.map(row => ({ text: row.text, state: row.state, reason: row.reason })), requests }));
    assert.equal(sent[1].message[0].data.text, '群聊读取到了红茶偏好。');
    channel.receive({ id: 'native-update-card', time: Math.floor(Date.now() / 1000), direction: 'incoming', chatType: 'group', peerId: group.peerId,
      sender: { id: 'alice', nickname: '阿宁' }, message: [{ type: 'text', data: { text: '/agent NATIVE_ROLE_UPDATE 更正一下称呼，请按已有原话核对。' } }] }, accountId);
    await channel.whenIdle();
    assert.equal(sent.length, 3); assert.equal(sent[2].message[0].data.text, '已排入独立后台更新。');
    assert(channel.personMemory.jobs.has(card.roleId), 'model update must enqueue the independent person agent');
    channel.personMemory.tick(); await channel.personMemory.whenIdle();
    const tool = T.personRoleCardTool(channel, { accountId, senderId: 'bob' }, () => {});
    const result = await runner.run({ mode: 'moments-reply', signal: new AbortController().signal,
      systemOverride: 'NATIVE_MOMENTS_ROLE_READ\n' + T.personaInstructions(store.persona()), tools: [tool], text: '{"post":"synthetic"}' });
    assert.equal(result.text, '朋友圈读取到了红茶偏好。');
    assert(requests.some(row => row.mode === 'moments-reply' && row.tools.includes('wechat_capabilities')));
    assert(requests.some(row => row.mode === 'moments-reply' && row.tools.includes('wechat_role_card')));
    channel.transport.readMoments = async () => ({ accountId, action: 'timeline', source: 'wechat-sns-live', nextCursor: null,
      items: [{ id: '9007199254740997', author: { userId: 'carol', nickname: '阿可' }, createdAt: Math.floor(Date.now() / 1000),
        text: '我长期喜欢红茶。', contentAvailable: true, deleted: false, comments: [], likes: [], media: [], imageCount: 0 }] });
    await T.readMomentsWithMemory(channel, { accountId, scopeKey: 'native-owner', query: { action: 'timeline' } }, new AbortController().signal);
    const carol = { accountId, personId: 'carol' };
    assert.equal(store.roleCards.view(carol).pendingCount, 1);
    channel.personMemory.configure({ ...store.roleCardSettings(), messageThreshold: 1 }, store.roleCardSettingsView().revision);
    channel.personMemory.tick(); await channel.personMemory.whenIdle();
    const momentCard = store.roleCards.view(carol);
    assert.equal(momentCard.card.preferences, '喜欢红茶');
    assert.equal(momentCard.evidence.preferences.sources[0].postId, '9007199254740997');
    const momentRead = JSON.parse(await T.personRoleCardTool(channel, { accountId, senderId: 'carol' }, () => {})
      .execute({ action: 'read', personId: 'carol' }, { signal: new AbortController().signal }));
    assert.equal(momentRead.card.preferences, '喜欢红茶'); assert.equal(sent.length, 3);
    assert(sessions.length >= 4); assert.equal(new Set(sessions).size, sessions.length);
    assert(ctx.tools.get('unrelated_native_tool'));
    const report = { ok: true, installedDshSdk: true, syntheticModelAndReceipts: true, productionSocialWrites: 0,
      cases: ['parallel-person-agents', 'chat-with-background-pending', 'cross-conversation-card', 'group-person-card', 'model-triggered-update', 'progressive-moments-read', 'isolated-tools', 'moments-source-to-shared-card'],
      sessions: sessions.length, requests, at: new Date().toISOString() };
    fs.mkdirSync(path.join(repo, 'storage/logs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'storage/logs/person-role-native-test.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, cases: report.cases.length, sessions: sessions.length, requests: requests.length, productionSocialWrites: 0 }));
  } finally { release.resolve(); await channel.close(); disposeTool(); adapter(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  // This standalone context contains only fixtures. Its channel is already
  // drained; SDK infrastructure disposal may otherwise leave no live handles
  // while its promises are pending, before the explicit test exit is scheduled.
  release.resolve();
  const exitTimer = setTimeout(() => process.exit(process.exitCode || 0), 1000);
  try { for (const fork of forks.reverse()) await fork.dispose(); }
  finally { clearTimeout(exitTimer); process.exit(process.exitCode || 0); }
});
