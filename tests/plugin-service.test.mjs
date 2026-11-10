import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, WechatChannel, createPluginService, rpcHandler, identity, availableModel, selectModel, SearchService, SEARCH_CREDENTIALS } from '../lib/testing.js';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const account = { id: 'wxid_service_owner', nickname: '测试账号' };
const roomA = 'service-a@chatroom', roomB = 'service-b@chatroom';
const settings = { enabled: true, privatePeers: ['alice'], groups: [roomA, roomB], prompt: '' };
const persona = { name: '小胖', aliases: ['胖胖'], background: '日常聊天助手', personality: '友善，直接', style: '简洁' };
const config = (mode = 'default') => ({ mode, minMessages: 5, maxMessages: 20, recordsPath: '' });
const selector = (peerId = roomA, chatType = 'group') => ({ accountId: account.id, chatType, peerId });
const isCode = code => error => error.code === code;

function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'plugin-service-'));
  const store = new StateStore(root); store.configure(account.id, settings);
  const calls = [], sent = [], workerCalls = [], cleanups = [];
  const state = { online: true, account: structuredClone(account), disposed: false };
  const lifetime = new AbortController();
  const worker = {
    status: () => ({ online: state.online, account: structuredClone(state.account), state: 'online', login: { state: 'idle' } }),
    call: async (endpoint, payload, options) => { workerCalls.push({ endpoint, payload, options }); return {}; },
    send: async params => { sent.push(params); return { delivery: 'server-ack', serverMessageIds: [`ack-${sent.length}`] }; },
  };
  const selected = { provider: 'fixture-provider', model: 'fixture-model' };
  const runner = {
    selection: () => selected, defaultSelection: () => selected,
    run: async input => {
      calls.push(input); const sessionId = input.sessionId || `fixture-session-${calls.length}`;
      await input.onSession?.(sessionId); return { text: '模拟回答', sessionId };
    },
  };
  const ctx = { llm: { listProviders: () => [{ id: selected.provider }], listModels: () => [{ id: selected.model }] } };
  const channel = new WechatChannel({ store, runner, transport: worker });
  const dshSessionPath = path.join(root, 'actual-host-jsonl-backend');
  const service = createPluginService({ ctx, root, store, worker, runner, channel, lifetime: lifetime.signal, isDisposed: () => state.disposed, dshSessionPath });
  const rpc = rpcHandler(service, () => state.disposed);
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await channel.close(); await service.drain();
    const relative = path.relative(base, fs.realpathSync(root));
    assert(relative.startsWith('plugin-service-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let serial = 0;
  const message = (text = '测试问题', extras = {}) => {
    const id = `event-${++serial}`;
    return { id, serverMessageId: id, time: Math.floor(Date.now() / 1000), direction: 'incoming', chatType: 'private',
      peerId: 'alice', sender: { id: 'alice', nickname: 'Alice' }, message: [{ type: 'text', data: { text } }], ...extras };
  };
  const seedSession = (peerId, chatType = 'group', ownerId = account.id) => {
    const contextKey = identity([ownerId, chatType, peerId, 'alice']);
    const key = `seed-${ownerId}-${peerId}`;
    store.remember(key, Date.now(), { key, contextKey, accountId: ownerId, chatType, peerId, senderId: 'alice',
      state: 'sent', question: `已处理 ${peerId}`, createdAt: Date.now() });
    store.saveSession(contextKey, `saved-${ownerId}-${peerId}`);
    return contextKey;
  };
  return { root, store, calls, sent, workerCalls, cleanups, state, lifetime, worker, runner, channel,
    service, rpc, dshSessionPath, message, seedSession, receive: value => channel.receive(value, state.account.id) };
}

function blockRunner(f) {
  const released = Promise.withResolvers(), started = Promise.withResolvers(), aborted = Promise.withResolvers();
  const original = f.runner.run;
  let first = true;
  f.runner.run = async input => {
    if (!first) return original(input);
    first = false; f.calls.push(input); started.resolve();
    input.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    // An in-flight provider may settle only after cancellation was requested.
    await released.promise;
    return { text: '取消后到达的旧回答', sessionId: 'late-old-session' };
  };
  f.cleanups.push(() => released.resolve());
  return { released, started, aborted };
}

for (const conflict of ['invalid', 'stale']) test(`${conflict} identity drafts are rejected without cancelling active or queued replies`, async t => {
  const f = fixture(t), initial = await f.service.call('identity.get');
  const current = '# 当前全局身份\n保留正在执行的回复。';
  if (conflict === 'stale') fs.writeFileSync(initial.path, current, 'utf8');
  const gate = blockRunner(f);
  f.receive(f.message('第一问')); await gate.started.promise;
  f.receive(f.message('排队的第二问'));
  const release = setTimeout(() => gate.released.resolve(), 100);
  try {
    await assert.rejects(f.service.call('identity.save', {
      markdown: conflict === 'invalid' ? ' \n' : '# 过期的草稿', revision: initial.revision,
    }), isCode(conflict === 'invalid' ? 'IDENTITY_INVALID' : 'IDENTITY_CHANGED'));
    assert.equal(f.calls[0].signal.aborted, false, 'validation must happen before draining replies');
    assert.equal(f.channel.summary().queued, 1);
  } finally { clearTimeout(release); gate.released.resolve(); await f.channel.whenIdle(); }
  assert.equal(f.sent.length, 2, 'both authorized replies complete normally');
  assert.equal((await f.service.call('identity.get')).markdown, conflict === 'stale' ? current : initial.markdown);
});

test('saving identical identity content leaves active and queued replies running', async t => {
  const f = fixture(t), initial = await f.service.call('identity.get'), gate = blockRunner(f);
  f.receive(f.message('第一问')); await gate.started.promise;
  f.receive(f.message('排队的第二问'));
  const release = setTimeout(() => gate.released.resolve(), 100);
  try {
    await f.service.call('identity.save', { markdown: initial.markdown, revision: initial.revision });
    assert.equal(f.calls[0].signal.aborted, false); assert.equal(f.channel.summary().queued, 1);
  } finally { clearTimeout(release); gate.released.resolve(); await f.channel.whenIdle(); }
  assert.equal(f.sent.length, 2); assert.deepEqual(await f.service.call('identity.get'), initial);
});

test('new configuration and records endpoints remain owner-only', async t => {
  const f = fixture(t), agent = { principal: { kind: 'agent' } };
  for (const endpoint of ['changelog', 'model.configure', 'search.credentials', 'persona.save', 'storage.save', 'conversation.configure', 'records.list']) {
    const response = await f.rpc(endpoint, {}, undefined, agent);
    assert.equal(response.ok, false); assert.equal(response.error.code, 'OWNER_REQUIRED');
  }
  assert.deepEqual(f.store.modelConfig(), { maxTokens: null, temperature: null, vision: true, visionModel: null, webSearch: false, searchProvider: 'tavily', tavilyBaseURL: 'https://api.tavily.com' });
  assert.equal(f.store.persona().name, '微信助手');
  assert.equal(f.workerCalls.length, 0);
  const owner = { principal: { kind: 'owner' } };
  const response = await f.rpc('model.configure', { modelConfig: { maxTokens: 1024, temperature: 0.6 } }, undefined, owner);
  assert.equal(response.ok, true); assert.equal(response.value.modelConfig.maxTokens, 1024);
});

test('owner search credential updates preserve active replies and never return the stored key', async t => {
  const f = fixture(t), stored = new Map();
  f.runner.search = new SearchService({ credentials: {
    set: async (ref, value) => { stored.set(ref, value); },
    describe: async ref => ({ configured: stored.has(ref) }),
  } });
  const gate = blockRunner(f); f.receive(f.message('正在回复')); await gate.started.promise;
  try {
    const result = await f.rpc('search.credentials', { provider: 'tavily', apiKey: 'fixture-owner-search-key' }, undefined, { principal: { kind: 'owner' } });
    assert.equal(result.ok, true); assert.equal(result.value.search.credentials.tavily, true);
    assert.equal(stored.get(SEARCH_CREDENTIALS.tavily), 'fixture-owner-search-key');
    assert(!JSON.stringify(result).includes('fixture-owner-search-key'));
    assert.equal(f.calls[0].signal.aborted, false); assert.equal(f.workerCalls.length, 0);
  } finally { gate.released.resolve(); await f.channel.whenIdle(); }
  assert.equal(f.sent.length, 1);
});

test('configuration rejects stale accounts and invalid conversation identities before changing settings', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.call('settings', { accountId: 'wxid_wrong', settings: { ...settings, enabled: false } }), isCode('ACCOUNT_CHANGED'));
  await assert.rejects(f.service.call('conversation.configure', { ...selector(), accountId: 'wxid_wrong', config: config('nickname') }), isCode('ACCOUNT_CHANGED'));
  await assert.rejects(f.service.call('conversation.configure', { ...selector('alice'), config: config('nickname') }), isCode('INVALID_PEERS'));
  await assert.rejects(f.service.call('conversation.configure', { ...selector('alice', 'private'), config: config('participate') }), isCode('INVALID_CONVERSATION'));
  assert.throws(() => f.service.call('records.list', { ...selector(), accountId: 'wxid_wrong' }), isCode('ACCOUNT_CHANGED'));
  assert.throws(() => f.service.call('records.list', selector(roomA, 'private')), isCode('INVALID_PEERS'));
  assert.deepEqual(f.store.settings(account.id), settings);
  assert.equal(f.store.conversationSettings(account.id, 'group', roomA).mode, 'default');
});

test('status exposes separate conversations and actual storage paths; records queries stay within the selected account and room', t => {
  const f = fixture(t);
  f.seedSession(roomA); f.seedSession(roomB); f.seedSession('alice', 'private');
  f.seedSession(roomA, 'group', 'wxid_other_owner');
  const status = f.service.call('status');
  assert.deepEqual(status.records, []);
  assert.equal(status.conversations.length, 3);
  assert(status.conversations.every(value => value.accountId === account.id));
  assert.equal(status.storage.dshSessionPath, f.dshSessionPath);
  assert.equal(status.storage.recordsPath, f.store.storageSettings().recordsPath);
  assert.equal(new Set(status.conversations.map(value => value.recordsPath)).size, 3);
  const page = f.service.call('records.list', { ...selector(), limit: 1, offset: 0 });
  assert.equal(page.total, 1); assert.equal(page.records[0].peerId, roomA); assert.equal(page.records[0].accountId, account.id);
  assert.equal(Object.hasOwn(page.records[0], 'contextKey'), false);
  assert.equal(page.recordsPath, status.conversations.find(value => value.peerId === roomA).recordsPath);
});

test('persona updates drain old inference before persisting and clear old session associations', { timeout: 10000 }, async t => {
  const f = fixture(t), oldContext = f.seedSession('alice', 'private'), block = blockRunner(f);
  f.receive(f.message()); await block.started.promise;
  const pending = f.service.call('persona.save', { persona });
  await block.aborted.promise;
  assert.equal(f.store.persona().name, '微信助手');
  assert(f.store.session(oldContext));
  f.receive(f.message('修改人设期间到达的问题'));
  assert.equal(f.calls.length, 1);
  block.released.resolve(); const result = await pending;
  assert.deepEqual(result.persona, persona);
  assert.equal(f.sent.length, 0); assert.equal(Object.keys(f.store.data.sessions).length, 0);
  assert.deepEqual(new StateStore(f.root).persona(), persona);
  f.receive(f.message('应用新人设后的问题')); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.calls[1].sessionId, undefined);
});

test('model parameters persist without cancelling an inference that already captured its configuration', { timeout: 10000 }, async t => {
  const f = fixture(t), block = blockRunner(f);
  f.receive(f.message()); await block.started.promise;
  const result = await f.service.call('model.configure', { modelConfig: { maxTokens: 2048, temperature: 0 } });
  assert.deepEqual(result.modelConfig, { maxTokens: 2048, temperature: 0, vision: true, visionModel: null, webSearch: false, searchProvider: 'tavily', tavilyBaseURL: 'https://api.tavily.com' });
  assert.equal(f.calls[0].signal.aborted, false);
  block.released.resolve(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(new StateStore(f.root).modelConfig(), { maxTokens: 2048, temperature: 0, vision: true, visionModel: null, webSearch: false, searchProvider: 'tavily', tavilyBaseURL: 'https://api.tavily.com' });
  await assert.rejects(f.service.call('model.configure', { modelConfig: { maxTokens: 1, temperature: 5 } }), isCode('INVALID_MODEL_CONFIG'));
  assert.deepEqual(f.store.modelConfig(), { maxTokens: 2048, temperature: 0, vision: true, visionModel: null, webSearch: false, searchProvider: 'tavily', tavilyBaseURL: 'https://api.tavily.com' });
});

test('cancelling follow-default selection before or during validation preserves the saved model', async t => {
  const f = fixture(t), selection = { provider: 'fixture-provider', model: 'fixture-model' };
  f.store.setModelChoice(selection);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(availableModel({}, null, cancelled.signal), error => error.name === 'AbortError');
  await assert.rejects(selectModel({}, f.store, null, cancelled.signal), error => error.name === 'AbortError');
  assert.deepEqual(f.store.modelChoice(), selection);

  const controller = new AbortController();
  const pending = selectModel({}, f.store, null, controller.signal);
  // Null validation resolves without querying providers, but still yields at
  // await; cancellation in that gap must be checked before persisting null.
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.deepEqual(f.store.modelChoice(), selection);
  assert.deepEqual(new StateStore(f.root).modelChoice(), selection);
  await selectModel({}, f.store, null);
  assert.equal(new StateStore(f.root).modelChoice(), null);
});

test('records migration preserves session continuity while workspace changes start new sessions', async t => {
  const f = fixture(t), contextA = f.seedSession(roomA), contextB = f.seedSession(roomB);
  const before = f.store.storageSettings(), previousPath = f.service.call('records.list', selector()).recordsPath;
  const originalSession = f.store.session(contextA);
  const moved = await f.service.call('storage.save', { storage: { ...before, recordsPath: path.join(f.root, 'new-records') } });
  assert.equal(f.store.session(contextA), originalSession); assert(f.store.session(contextB));
  const page = f.service.call('records.list', selector());
  assert.notEqual(page.recordsPath, previousPath);
  assert(fs.existsSync(path.join(previousPath, 'conversation.json')));
  assert(fs.existsSync(path.join(page.recordsPath, 'conversation.json')));
  const after = await f.service.call('storage.save', { storage: { recordsPath: moved.storage.recordsPath, workspacePath: path.join(f.root, 'new-workspace') } });
  assert.equal(f.store.session(contextA), undefined); assert.equal(f.store.session(contextB), undefined);
  assert(fs.statSync(after.storage.workspacePath).isDirectory());
  assert.equal(f.service.call('records.list', selector()).total, 1);
  assert.deepEqual(new StateStore(f.root).storageSettings(), f.store.storageSettings());
});

test('conversation mode changes cancel only the selected room and reset only that room context', { timeout: 10000 }, async t => {
  const f = fixture(t), contextA = f.seedSession(roomA), contextB = f.seedSession(roomB), block = blockRunner(f);
  f.receive(f.message('/agent A 正在生成', { chatType: 'group', peerId: roomA })); await block.started.promise;
  f.receive(f.message('/agent B 排队问题', { chatType: 'group', peerId: roomB }));
  const pending = f.service.call('conversation.configure', { ...selector(), config: config('nickname') });
  await block.aborted.promise;
  assert.equal(f.store.conversationSettings(account.id, 'group', roomA).mode, 'default');
  assert(f.store.session(contextB));
  block.released.resolve(); await pending; await f.channel.whenIdle();
  assert.equal(f.store.conversationSettings(account.id, 'group', roomA).mode, 'nickname');
  assert.equal(f.store.session(contextA), undefined);
  assert(f.store.session(contextB));
  assert.deepEqual(f.sent.map(value => value.peerId), [roomB]);
});

test('request cancellation while draining leaves settings unchanged and releases the pause', { timeout: 10000 }, async t => {
  const f = fixture(t), block = blockRunner(f), controller = new AbortController();
  f.receive(f.message()); await block.started.promise;
  const pending = f.service.call('persona.save', { persona }, controller.signal);
  await block.aborted.promise; controller.abort(); block.released.resolve();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(f.store.persona().name, '微信助手');
  f.receive(f.message('取消设置后继续')); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1);
});

test('account changes during draining cannot apply settings to a stale account', { timeout: 10000 }, async t => {
  const f = fixture(t), block = blockRunner(f);
  f.receive(f.message()); await block.started.promise;
  const pending = f.service.call('settings', { accountId: account.id, settings: { ...settings, prompt: '不应写入的要求' } });
  await block.aborted.promise;
  f.state.account = { id: 'wxid_replacement', nickname: '新账号' };
  block.released.resolve(); await assert.rejects(pending, isCode('ACCOUNT_CHANGED'));
  assert.deepEqual(f.store.settings(account.id), settings);
  assert.equal(f.sent.length, 0);
});

test('shutdown during drain prevents a late persona save and reports stopping', { timeout: 10000 }, async t => {
  const f = fixture(t), block = blockRunner(f);
  f.receive(f.message()); await block.started.promise;
  const pending = f.service.call('persona.save', { persona });
  await block.aborted.promise;
  f.state.disposed = true; f.lifetime.abort(); block.released.resolve();
  await assert.rejects(pending, isCode('PLUGIN_STOPPING'));
  assert.equal(f.store.persona().name, '微信助手');
  assert.equal(new StateStore(f.root).persona().name, '微信助手');
  assert.equal(f.sent.length, 0);
});

test('contact lookup rejects late results after account switch or shutdown and preserves saved names', { timeout: 10000 }, async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.worker.call = async endpoint => { assert.equal(endpoint, 'contacts'); return gate.promise; };
  const pending = f.service.call('contacts');
  f.state.account = { id: 'wxid_replacement', nickname: '新账号' };
  gate.resolve({ groups: [{ id: roomA, name: '旧账号群名不应写入' }], privatePeers: [] });
  await assert.rejects(pending, isCode('ACCOUNT_CHANGED'));
  assert.equal(f.store.conversations(account.id).find(value => value.peerId === roomA).name, roomA);

  f.state.account = structuredClone(account);
  const late = Promise.withResolvers(); f.worker.call = () => late.promise;
  const stopped = f.service.call('contacts');
  f.state.disposed = true; f.lifetime.abort();
  late.resolve({ groups: [{ id: roomA, name: '停用后群名不应写入' }], privatePeers: [] });
  await assert.rejects(stopped, isCode('PLUGIN_STOPPING'));
  assert.equal(f.store.conversations(account.id).find(value => value.peerId === roomA).name, roomA);
});

test('discovered conversation names are saved when a new contact becomes authorized', async t => {
  const f = fixture(t), newRoom = 'newly-authorized@chatroom';
  f.worker.call = async () => ({ groups: [{ id: newRoom, name: '产品讨论群' }], privatePeers: [] });
  await f.service.call('contacts');
  assert(!f.store.conversations(account.id).some(value => value.peerId === newRoom));
  await f.service.call('settings', { accountId: account.id, settings: { ...settings, groups: [...settings.groups, newRoom] } });
  const conversation = f.store.conversations(account.id).find(value => value.peerId === newRoom);
  assert.equal(conversation.name, '产品讨论群'); assert.equal(conversation.authorized, true);
  assert.equal(new StateStore(f.root).conversations(account.id).find(value => value.peerId === newRoom).name, '产品讨论群');
});

test('granting another conversation preserves active replies and unrelated participation progress', { timeout: 10000 }, async t => {
  const f = fixture(t), block = blockRunner(f);
  const observed = f.message('B 已观察的消息', { chatType: 'group', peerId: roomB });
  f.store.remember('progress-b', Date.now(), undefined, { accountId: account.id, message: observed, progress: { count: 3, target: 5 } });
  f.receive(f.message()); await block.started.promise;
  const pending = f.service.call('settings', { accountId: account.id, settings: { ...settings, groups: [...settings.groups, 'new-room@chatroom'] } });
  await new Promise(resolve => setImmediate(resolve));
  const wasAborted = f.calls[0].signal.aborted;
  block.released.resolve(); await pending; await f.channel.whenIdle();
  assert.equal(wasAborted, false, 'adding authorization must not cancel an unrelated reply');
  assert.deepEqual(f.store.progress(account.id, 'group', roomB), { count: 3, target: 5 });
  assert.deepEqual(f.sent.map(value => value.peerId), ['alice']);
});

test('revoking a group drains only that group and preserves another queued reply and counter', { timeout: 10000 }, async t => {
  const f = fixture(t), block = blockRunner(f);
  for (const peerId of [roomA, roomB]) {
    const observed = f.message('已观察的群聊消息', { chatType: 'group', peerId });
    f.store.remember('progress-' + peerId, Date.now(), undefined, { accountId: account.id, message: observed, progress: { count: 2, target: 5 } });
  }
  f.receive(f.message('/agent A 需要取消', { chatType: 'group', peerId: roomA })); await block.started.promise;
  f.receive(f.message('/agent B 应继续回复', { chatType: 'group', peerId: roomB }));
  const pending = f.service.call('settings', { accountId: account.id, settings: { ...settings, groups: [roomB] } });
  await block.aborted.promise;
  block.released.resolve(); await pending; await f.channel.whenIdle();
  assert.deepEqual(f.sent.map(value => value.peerId), [roomB]);
  assert.deepEqual(f.store.progress(account.id, 'group', roomA), { count: 0, target: null });
  assert.deepEqual(f.store.progress(account.id, 'group', roomB), { count: 2, target: 5 });
  assert.equal(f.store.recordsPage(account.id, selector()).records[0].state, 'cancelled');
  assert.deepEqual(new StateStore(f.root).settings(account.id).groups, [roomB]);
});

test('account reply instructions reset only that account session associations', async t => {
  const f = fixture(t), current = f.seedSession(roomA), other = f.seedSession(roomA, 'group', 'wxid_other_owner');
  const otherSession = f.store.session(other);
  await f.service.call('settings', { accountId: account.id, settings: { ...settings, prompt: '请简短回答' } });
  assert.equal(f.store.session(current), undefined);
  assert.equal(f.store.session(other), otherSession);
  assert.equal(new StateStore(f.root).session(other), otherSession);
});

test('partial conversation cancellation selectors cannot become a global cancellation', async t => {
  const f = fixture(t);
  const observed = f.message('保留计数', { chatType: 'group', peerId: roomB });
  f.store.remember('cancel-progress', Date.now(), undefined, { accountId: account.id, message: observed, progress: { count: 4, target: 5 } });
  for (const payload of [{ ...selector(), peerId: '' }, { accountId: account.id }, { ...selector(), accountId: 'wrong' }]) {
    await assert.rejects(f.service.call('cancel', payload), error => ['INVALID_PEERS', 'ACCOUNT_CHANGED'].includes(error.code));
    assert.deepEqual(f.store.progress(account.id, 'group', roomB), { count: 4, target: 5 });
  }
});

test('status and targeted cancellation expose the selected conversation queue without touching another active reply', { timeout: 10000 }, async t => {
  const f = fixture(t), block = blockRunner(f);
  f.receive(f.message('/agent A 正在回复', { chatType: 'group', peerId: roomA })); await block.started.promise;
  f.receive(f.message('/agent B 排队', { chatType: 'group', peerId: roomB }));
  const snapshot = f.service.call('status'), a = snapshot.conversations.find(peer => peer.peerId === roomA), b = snapshot.conversations.find(peer => peer.peerId === roomB);
  assert(a.processing?.active); assert.equal(a.processing.queued, 0);
  assert.equal(b.processing?.active, null); assert.equal(b.processing.queued, 1);
  await f.service.call('cancel', selector(roomB));
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.store.recordsPage(account.id, selector(roomB)).records[0].state, 'cancelled');
  block.released.resolve(); await f.channel.whenIdle();
  assert.deepEqual(f.sent.map(value => value.peerId), [roomA]);
});
