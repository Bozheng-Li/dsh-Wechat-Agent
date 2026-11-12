import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, ConversationMemory, LongTermMemory, WechatChannel } from '../lib/testing.js';

async function fixture(t, count = 24) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-memory-scan-'));
  const store = new StateStore(root), accountId = 'scan-owner';
  const peers = Array.from({ length: count }, (_, index) => 'peer-' + index);
  store.configure(accountId, { enabled: true, groups: ['scan-room@chatroom'], privatePeers: peers, prompt: '' });
  const scope = peerId => ({ accountId, chatType: 'private', peerId });
  const memory = new ConversationMemory(store), longMemory = new LongTermMemory(store);
  const status = { online: true, account: { id: accountId } };
  const runner = { run: async () => ({ text: '合成回复' }), summarize: async () => '合成摘要',
    extractLongTermMemory: async () => ({ text: '{"facts":[],"unresolved":[]}' }) };
  const transport = { status: () => status, send: async () => assert.fail('巡检不得发送微信消息') };
  const channel = new WechatChannel({ store, memory, longMemory, runner, transport });
  await channel.personMemory.close();
  t.after(async () => {
    await channel.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('wechat-memory-scan-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  await channel.whenIdle();
  return { root, store, accountId, peers, scope, memory, longMemory, status, runner, channel };
}

test('a person or group resolves its bound memory without constructing any conversation UI rows', async t => {
  const f = await fixture(t, 2), privateScope = f.scope(f.peers[0]);
  const groupScope = { accountId: f.accountId, chatType: 'group', peerId: 'scan-room@chatroom' };
  f.store.rememberConversationName(f.accountId, 'private', privateScope.peerId, '阿禾');
  const privateFile = f.memory.view(privateScope).path, groupFile = f.memory.view(groupScope).path;
  f.store.conversations = () => assert.fail('single-peer lookup must not enumerate the UI list');
  f.store.conversationSettings = () => assert.fail('single-peer lookup must not validate unrelated configuration');
  assert.equal(f.memory.load(privateScope).key, f.store.conversationSelector(f.accountId, 'private', privateScope.peerId).key);
  assert.equal(f.longMemory.selector(privateScope).name, '阿禾');
  assert.equal(f.memory.file(f.memory.selector(privateScope)), privateFile);
  assert.equal(f.memory.file(f.memory.selector(groupScope)), groupFile);
  assert.notEqual(privateFile, groupFile);
  const beforeRevocation = fs.readFileSync(privateFile);
  f.store.configure(f.accountId, { enabled: true, groups: [], privatePeers: [f.peers[1]], prompt: '' });
  assert.deepEqual(fs.readFileSync(privateFile), beforeRevocation, 'the existing document is retained byte for byte');
  assert.equal(f.store.conversationSelector(f.accountId, 'private', privateScope.peerId).name, '阿禾', 'historical metadata remains bound after revocation');
  assert.throws(() => f.store.conversationSelector(f.accountId, 'private', 'unknown'), { code: 'MEMORY_CONVERSATION_MISSING' });
});

test('direct bindings retain account, conversation type, document ownership and path boundary checks', async t => {
  const f = await fixture(t, 1), first = f.scope(f.peers[0]);
  f.store.configure('another-owner', { enabled: true, groups: [], privatePeers: f.peers, prompt: '' });
  const other = { ...first, accountId: 'another-owner', key: f.memory.selector(first).key };
  const firstDoc = f.memory.load(first), otherDoc = f.memory.load(other);
  assert.notEqual(firstDoc.key, otherDoc.key); assert.notEqual(f.memory.file(firstDoc), f.memory.file(otherDoc));
  assert.throws(() => f.store.conversationSelector(first.accountId, 'group', first.peerId), { code: 'INVALID_CONVERSATION' });
  assert.throws(() => f.store.conversationSelector('unbound-owner', first.chatType, first.peerId), { code: 'MEMORY_CONVERSATION_MISSING' });
  const file = f.memory.file(firstDoc), bytes = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...firstDoc, ownerStoreId: 'another-store' }));
  assert.throws(() => f.memory.load(first), { code: 'MEMORY_INVALID' }); fs.writeFileSync(file, bytes);
  f.memory.index.conversations[firstDoc.key].folder = '../outside';
  assert.throws(() => f.memory.load(first), { code: 'MEMORY_INVALID' });
});

test('180 conversations and repeated pressure requests read one public index and never rebuild UI rows', async t => {
  const f = await fixture(t, 179), calls = { list: 0, state: 0, load: 0 };
  const selectors = f.store.conversationSelectors.bind(f.store), state = f.longMemory.state.bind(f.longMemory), load = f.memory.load.bind(f.memory);
  f.store.conversations = () => assert.fail('maintenance must not build UI rows');
  f.store.conversationSelectors = (...args) => { calls.list++; return selectors(...args); };
  f.longMemory.state = (...args) => { calls.state++; return state(...args); };
  f.memory.load = (...args) => { calls.load++; return load(...args); };
  const scan = f.channel.checkMemoryPressure();
  for (let i = 0; i < 50; i++) assert.equal(f.channel.checkMemoryPressure(), scan);
  assert.deepEqual(calls, { list: 0, state: 0, load: 0 }, 'scheduling leaves the status callback lightweight');
  await f.channel.whenIdle();
  assert.deepEqual(calls, { list: 1, state: 1, load: 180 });
  assert.equal(f.channel.memoryScan, undefined); assert.equal(f.channel.fault, null);
});

test('a memory scan yields to the event loop before it finishes all conversations', async t => {
  const f = await fixture(t), load = f.memory.load.bind(f.memory); let loaded = 0, observed;
  f.memory.load = (...args) => {
    loaded++;
    if (loaded === 1) setImmediate(() => { observed = loaded; });
    return load(...args);
  };
  f.channel.checkMemoryPressure(); await f.channel.whenIdle();
  assert.equal(loaded, f.peers.length + 1); assert(observed > 0 && observed <= 8); assert(observed < loaded);
});

test('revoked and paused peers are rechecked after a batch yields', async t => {
  const f = await fixture(t), load = f.memory.load.bind(f.memory); let changed = false, resume;
  const afterChange = [];
  f.memory.load = (scope, ...args) => {
    if (changed) afterChange.push(scope.peerId);
    else setImmediate(() => {
      if (changed) return;
      changed = true; resume = f.channel.pause('应用设置', f.scope(f.peers.at(-1)));
      f.store.configure(f.accountId, { enabled: true, groups: [], privatePeers: [f.peers.at(-2), f.peers.at(-1)], prompt: '' });
    });
    return load(scope, ...args);
  };
  f.channel.checkMemoryPressure(); await f.channel.whenIdle(); resume();
  assert.deepEqual(afterChange, [], 'a stale scan stops before loading any peer after a revocation changes the account epoch');
});

test('an account switch cancels the old scan and coalesces a fresh scan for the new account', async t => {
  const f = await fixture(t), otherId = 'other-scan-owner', otherPeers = ['other-peer'];
  f.store.configure(otherId, { enabled: true, groups: [], privatePeers: otherPeers, prompt: '' });
  const load = f.memory.load.bind(f.memory), loaded = []; let switched = false;
  f.memory.load = (scope, ...args) => {
    loaded.push(scope);
    if (!switched) {
      switched = true;
      setImmediate(() => {
        f.status.account = { id: otherId };
        f.channel.cancel('账号已变化', { accountId: f.accountId }, { resetProgress: false });
        f.channel.checkMemoryPressure(); f.channel.checkMemoryPressure();
      });
    }
    return load(scope, ...args);
  };
  f.channel.checkMemoryPressure(); await f.channel.whenIdle();
  const previous = loaded.filter(scope => scope.accountId === f.accountId), current = loaded.filter(scope => scope.accountId === otherId);
  assert(previous.length > 0 && previous.length <= 8); assert.deepEqual(current.map(scope => scope.peerId), otherPeers);
  assert.equal(f.channel.memoryScan, undefined); assert.equal(f.channel.memoryPending.size, 0);
});

test('closing or disconnecting prevents a late batch from loading or queuing more memory', async t => {
  const f = await fixture(t), load = f.memory.load.bind(f.memory); let loaded = 0, closing;
  f.memory.load = (...args) => {
    if (++loaded === 1) setImmediate(() => { f.status.online = false; closing = f.channel.close(); });
    return load(...args);
  };
  f.channel.checkMemoryPressure(); await f.channel.whenIdle(); await closing;
  assert(loaded > 0 && loaded <= 8); assert.equal(f.channel.memoryScan, undefined);
  assert.equal(f.channel.memoryPending.size, 0); assert.equal(f.channel.checkMemoryPressure(), undefined);
});

test('a shared index read failure preserves the file and records per-conversation failures once per scan', async t => {
  const f = await fixture(t, 2), file = f.longMemory.paths(f.accountId).state, bytes = Buffer.from('{broken index');
  fs.writeFileSync(file, bytes); let reads = 0;
  const state = f.longMemory.state.bind(f.longMemory);
  f.longMemory.state = (...args) => { reads++; return state(...args); };
  f.channel.checkMemoryPressure(); await f.channel.whenIdle();
  assert.equal(reads, 1); assert.deepEqual(fs.readFileSync(file), bytes);
  for (const peer of f.store.conversationSelectors(f.accountId)) assert.match(f.memory.errors.get(peer.key), /索引无法读取/);
  assert.equal(f.channel.fault, null);
});

test('pending facts, forced compaction and retry backoff remain visible with the shared scan snapshot', async t => {
  const f = await fixture(t, 4), selected = [], selectors = f.peers.map(peerId => f.memory.selector(f.scope(peerId)));
  const originalState = f.longMemory.state.bind(f.longMemory); let reads = 0;
  f.longMemory.state = accountId => {
    reads++; const state = originalState(accountId);
    state.pending[selectors[0].key] = { entries: [{ key: 'pending-source' }] };
    state.pending[selectors[1].key] = { entries: [{ key: 'retry-source' }] };
    return state;
  };
  f.channel.memoryRetries.set(selectors[1].key, { nextAt: Date.now() + 30000 });
  f.channel.memoryForced.set(selectors[2].key, 'manual-request');
  f.memory.onPressure = scope => selected.push(scope.key);
  f.memory.errors.set(selectors[3].key, '可清除的旧错误');
  f.channel.checkMemoryPressure(); await f.channel.whenIdle();
  assert.equal(reads, 1); assert.deepEqual(new Set(selected), new Set([selectors[0].key, selectors[2].key]));
  assert(f.channel.memoryRetries.has(selectors[1].key)); assert(!f.memory.errors.has(selectors[3].key));
});
