import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { StateStore, identity, conversationKey } = await import(process.env.DSH_STATE_TEST_MODULE || '../lib/testing.js');

const account = 'wxid_owner';
const groupA = 'group_a@chatroom', groupB = 'group_b@chatroom';
const settings = { enabled: true, privatePeers: ['alice'], groups: [groupA, groupB], prompt: '' };
function temporary(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'dsh-store-v2-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
    assert.match(path.basename(resolved), /^dsh-store-v2-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}
function message(n, peerId = groupA) {
  return { id: 'message-' + n, serverMessageId: String(n), peerId, chatType: peerId.endsWith('@chatroom') ? 'group' : 'private',
    direction: 'incoming', time: Math.floor(Date.now() / 1000), sender: { id: 'alice', nickname: 'Alice' },
    message: [{ type: 'text', data: { text: 'Question ' + n } }] };
}
function record(n, incoming = message(n), accountId = account) {
  return { key: identity([accountId, incoming.chatType, incoming.peerId, incoming.serverMessageId]),
    contextKey: identity([accountId, incoming.chatType, incoming.peerId, incoming.sender.id]), accountId,
    chatType: incoming.chatType, peerId: incoming.peerId, senderId: incoming.sender.id, sender: 'Alice',
    messageId: incoming.id, state: 'queued', question: 'Question ' + n, createdAt: Date.now(), updatedAt: Date.now() };
}
function receive(store, n, peerId = groupA, accountId = account) {
  const incoming = message(n, peerId), item = record(n, incoming, accountId);
  store.remember(item.key, Date.now(), item, { accountId, message: incoming, progress: { count: 1, target: 5 } });
  return item;
}
function archive(store, peerId = groupA, accountId = account) {
  return path.join(store.recordsPage(accountId, { chatType: peerId.endsWith('@chatroom') ? 'group' : 'private', peerId }).recordsPath, 'conversation.json');
}

test('v1 migration separates archives, retains backup and preserves uncertain delivery', t => {
  const root = temporary(t), file = path.join(root, 'storage/state/channel.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const first = record(1), second = record(2, message(2, 'alice'));
  first.state = 'sending'; second.state = 'generating';
  const legacy = { version: 1, connectionWanted: true, accounts: { [account]: settings },
    seen: { [first.key]: 123, [second.key]: 124 },
    sessions: { [first.contextKey]: { id: 'old-1', at: 123 }, [second.contextKey]: { id: 'old-2', at: 124 } },
    records: [first, second] };
  const original = JSON.stringify(legacy, null, 2);
  fs.writeFileSync(file, original);
  const modified = new Date(1700000000000);
  fs.utimesSync(file, modified, modified);
  const store = new StateStore(root);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'channel.v1.backup.json'), 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).records, []);
  assert.equal(store.recordsPage(account, { chatType: 'group', peerId: groupA }).records[0].state, 'unknown');
  assert.equal(store.recordsPage(account, { chatType: 'private', peerId: 'alice' }).records[0].state, 'cancelled');
  assert.equal(Object.keys(store.data.sessions).length, 0);
  assert.notEqual(archive(store), archive(store, 'alice'));
  assert.equal(JSON.parse(fs.readFileSync(archive(store), 'utf8')).records.length, 1);
  // Simulate recovery after snapshots completed but before the v1 index switched.
  fs.writeFileSync(file, original);
  fs.utimesSync(file, modified, modified);
  const resumed = new StateStore(root);
  assert.equal(resumed.data.records.length, 2);
  assert.equal(resumed.data.seen[first.key], 123);
  assert.equal(new StateStore(root).data.records.length, 2);
});

test('claim, observation, processing record and participation count share one archive commit', t => {
  const store = new StateStore(temporary(t));
  store.configure(account, settings);
  const item = receive(store, 1);
  const disk = JSON.parse(fs.readFileSync(archive(store), 'utf8'));
  assert.equal(disk.records[0].key, item.key);
  assert.equal(disk.seen[item.key], store.data.seen[item.key]);
  assert.equal(disk.messages[0].text, 'Question 1');
  assert.deepEqual(disk.progress, { count: 1, target: 5 });
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).seen[item.key], undefined);
  const restored = new StateStore(store.root);
  assert.equal(restored.remember(item.key, Date.now(), item, { accountId: account, message: message(1) }), false);
  assert.deepEqual(restored.progress(account, 'group', groupA), { count: 1, target: 5 });
  assert.equal(restored.history(account, 'group', groupA).length, 1);
});

test('private, group and account archives have separate records and context', t => {
  const store = new StateStore(temporary(t));
  store.configure(account, settings); store.configure('wxid_other', settings);
  for (const [n, peerId, owner] of [[1, groupA, account], [2, groupB, account], [3, 'alice', account], [4, groupA, 'wxid_other']])
    receive(store, n, peerId, owner);
  const paths = [archive(store), archive(store, groupB), archive(store, 'alice'), archive(store, groupA, 'wxid_other')];
  assert.equal(new Set(paths).size, 4);
  for (const file of paths) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 1);
  assert.equal(store.recordsPage(account, { chatType: 'group', peerId: groupA }).records[0].question, 'Question 1');
  assert.equal(store.history('wxid_other', 'group', groupA)[0].text, 'Question 4');
  assert(store.conversations(account).every(conversation => conversation.accountId === account));
});

test('records remain independently pageable beyond the former global 300 record cap', t => {
  const store = new StateStore(temporary(t));
  store.configure(account, settings);
  for (let n = 0; n < 320; n++) {
    const item = record(n); item.state = 'sent';
    store.add(item);
  }
  const privateRecord = record(999, message(999, 'alice')); privateRecord.state = 'sent'; store.add(privateRecord);
  const first = store.recordsPage(account, { chatType: 'group', peerId: groupA, offset: 0, limit: 100 });
  const last = store.recordsPage(account, { chatType: 'group', peerId: groupA, offset: 300, limit: 100 });
  assert.equal(first.total, 320); assert.equal(first.records.length, 100); assert(first.hasMore);
  assert.equal(last.records.length, 20); assert.equal(last.hasMore, false);
  assert.equal(store.recordsPage(account, { chatType: 'private', peerId: 'alice' }).total, 1);
  assert.equal(new StateStore(store.root).recordsPage(account, { chatType: 'group', peerId: groupA }).total, 320);
});

test('history pages keep their position while new records arrive and still show updated delivery states', t => {
  const store = new StateStore(temporary(t));
  const items = Array.from({ length: 8 }, (_, n) => receive(store, n));
  const query = { chatType: 'group', peerId: groupA, limit: 3 };
  const first = store.recordsPage(account, query);
  assert.equal(first.anchor, items[7].key);
  receive(store, 8); receive(store, 9);
  store.update(items[4], { state: 'sent', reply: '已确认回复', acknowledgedMessageIds: ['stable-page-ack'] });
  const second = store.recordsPage(account, { ...query, offset: 3, anchor: first.anchor });
  assert.deepEqual(second.records.map(value => value.key), [items[4].key, items[3].key, items[2].key]);
  assert.equal(second.records[0].state, 'sent');
  assert.equal(second.total, 8); assert.equal(second.newerCount, 2); assert(second.hasMore);
  const last = store.recordsPage(account, { ...query, offset: 6, anchor: first.anchor });
  assert.deepEqual(last.records.map(value => value.key), [items[1].key, items[0].key]);
  assert.equal(last.hasMore, false);
  assert.equal(new Set([...first.records, ...second.records, ...last.records].map(value => value.key)).size, 8);
  const refreshed = store.recordsPage(account, query);
  assert.equal(refreshed.total, 10); assert.equal(refreshed.newerCount, 0);
  assert.notEqual(refreshed.anchor, first.anchor);
  assert.deepEqual(new StateStore(store.root).recordsPage(account, { ...query, offset: 6, anchor: first.anchor }).records.map(value => value.key), last.records.map(value => value.key));
});

test('history anchors cannot select another conversation or silently fall back after a missing record', t => {
  const store = new StateStore(temporary(t));
  const a = receive(store, 1), b = receive(store, 2, groupB), otherAccount = receive(store, 3, groupA, 'wxid_other_owner');
  const query = { chatType: 'group', peerId: groupA };
  for (const anchor of [b.key, otherAccount.key, 'missing-record'])
    assert.throws(() => store.recordsPage(account, { ...query, anchor }), error => error.code === 'HISTORY_POSITION_CHANGED');
  for (const anchor of ['', 1, {}, 'x'.repeat(257)])
    assert.throws(() => store.recordsPage(account, { ...query, anchor }), error => error.code === 'INVALID_HISTORY_PAGE');
  assert.equal(store.recordsPage(account, { ...query, anchor: a.key }).total, 1);
  assert.equal(store.recordsPage(account, { chatType: 'private', peerId: 'no-records' }).anchor, null);
});

test('observed context retains only its latest 1000 messages without leaking media paths', t => {
  const store = new StateStore(temporary(t));
  for (let n = 0; n < 1002; n++) {
    const incoming = message(n), key = identity([n]);
    if (n === 1001) incoming.message = [{ type: 'image', data: { file: 'PRIVATE_LOCAL_PATH', url: 'https://private.invalid/SECRET' } }];
    store.remember(key, Date.now(), undefined, { accountId: account, message: incoming });
  }
  const history = store.history(account, 'group', groupA, 1000);
  assert.equal(history.length, 1000);
  assert.equal(history[0].text, 'Question 2');
  assert.equal(history.at(-1).mediaOnly, true);
  assert(!JSON.stringify(history).includes('PRIVATE_LOCAL_PATH'));
  assert(!JSON.stringify(history).includes('private.invalid'));
  assert.equal(store.history(account, 'group', groupA, 0).length, 0);
  assert.equal(store.recordsPage(account, { chatType: 'group', peerId: groupA }).total, 0);
});

test('only confirmed replies enter observed context, once, with the original recipient', t => {
  const store = new StateStore(temporary(t)), item = receive(store, 1);
  store.update(item, { state: 'partial', reply: 'UNCONFIRMED', acknowledgedMessageIds: ['partial'] });
  assert.equal(store.history(account, 'group', groupA).filter(message => message.direction === 'outgoing').length, 0);
  store.update(item, { state: 'sent', reply: 'Confirmed answer', acknowledgedMessageIds: ['server-1'], agentName: 'Agent' });
  store.update(item, { reason: undefined });
  const sent = store.history(account, 'group', groupA).filter(message => message.direction === 'outgoing');
  assert.equal(sent.length, 1); assert.equal(sent[0].replyTo, 'alice'); assert.equal(sent[0].sourceKey, item.key);
  assert.equal(sent[0].text, 'Confirmed answer');
});

test('storage path migration preserves old snapshots and moves only inherited archives', t => {
  const root = temporary(t), store = new StateStore(root);
  const initialPaths = store.storageSettings();
  store.configure(account, settings);
  receive(store, 1); receive(store, 2, groupB);
  const oldA = archive(store), oldB = archive(store, groupB);
  const custom = path.join(root, 'custom-group');
  store.setConversationSettings(account, 'group', groupB, { mode: 'nickname', minMessages: 5, maxMessages: 20, recordsPath: custom });
  const customB = archive(store, groupB);
  const next = { workspacePath: path.join(root, 'work-next'), recordsPath: path.join(root, 'records-next') };
  store.setStorageSettings(next);
  assert.equal(store.ensureWorkspace(), fs.realpathSync(next.workspacePath));
  assert.notEqual(archive(store), oldA); assert.equal(archive(store, groupB), customB);
  for (const file of [oldA, oldB, customB, archive(store)]) assert(fs.existsSync(file));
  const restored = new StateStore(root);
  assert.equal(restored.storageSettings().recordsPath, fs.realpathSync(next.recordsPath));
  assert.equal(restored.recordsPage(account, { chatType: 'group', peerId: groupA }).total, 1);
  assert.equal(restored.conversationSettings(account, 'group', groupB).recordsPath, fs.realpathSync(custom));
  receive(restored, 3);
  restored.setStorageSettings(initialPaths);
  assert.equal(archive(restored), oldA);
  assert.equal(restored.recordsPage(account, { chatType: 'group', peerId: groupA }).total, 2);
});

test('path conflict and failed index commit leave the old paths and records authoritative', t => {
  const root = temporary(t), store = new StateStore(root);
  receive(store, 1);
  const before = store.storageSettings(), oldFile = archive(store);
  const target = path.join(root, 'conflict'), relative = path.relative(before.recordsPath, path.dirname(oldFile));
  const conflictFile = path.join(target, relative, 'conversation.json');
  fs.mkdirSync(path.dirname(conflictFile), { recursive: true });
  const other = JSON.parse(fs.readFileSync(oldFile, 'utf8')); other.ownerStoreId = 'different-owner';
  const untouched = JSON.stringify(other); fs.writeFileSync(conflictFile, untouched);
  assert.throws(() => store.setStorageSettings({ workspacePath: path.join(root, 'work'), recordsPath: target }), error => error.code === 'CONVERSATION_DATA_MISMATCH');
  assert.equal(fs.readFileSync(conflictFile, 'utf8'), untouched);
  assert.deepEqual(store.storageSettings(), before);
  const original = store.save;
  store.save = () => { throw new Error('synthetic index failure'); };
  assert.throws(() => store.setStorageSettings({ workspacePath: path.join(root, 'work'), recordsPath: path.join(root, 'after-failure') }), /synthetic/);
  store.save = original;
  assert.deepEqual(store.storageSettings(), before);
  assert.equal(archive(new StateStore(root)), oldFile);
  assert.equal(new StateStore(root).recordsPage(account, { chatType: 'group', peerId: groupA }).total, 1);
});

test('model, persona and per-conversation resets persist without clearing other peers', t => {
  const store = new StateStore(temporary(t));
  const a = receive(store, 1), b = receive(store, 2, groupB);
  store.update(a, { state: 'sent' }); store.update(b, { state: 'sent' });
  store.saveSession(a.contextKey, 'a-session'); store.saveSession(b.contextKey, 'b-session');
  store.setPersona({ name: 'Companion', aliases: ['buddy'], background: 'A friend', personality: 'Kind', style: 'Short' });
  store.setModelConfig({ maxTokens: 2048, temperature: 0.4 });
  store.resetSessions({ accountId: account, chatType: 'group', peerId: groupA });
  store.resetProgress(account, 'group', groupA);
  assert.equal(store.session(a.contextKey), undefined);
  assert.equal(store.session(b.contextKey), 'b-session');
  assert.deepEqual(store.progress(account, 'group', groupA), { count: 0, target: null });
  assert.deepEqual(store.progress(account, 'group', groupB), { count: 1, target: 5 });
  const restored = new StateStore(store.root);
  assert.equal(restored.persona().name, 'Companion');
  assert.deepEqual(restored.modelConfig(), { maxTokens: 2048, temperature: 0.4, vision: true, visionModel: null, webSearch: false, searchProvider: 'tavily', tavilyBaseURL: 'https://api.tavily.com' });
  assert.equal(restored.history(account, 'group', groupA).length, 1);
  assert.equal(restored.recordsPage(account, { chatType: 'group', peerId: groupA }).total, 1);
});

test('bulk contact names commit once and never archive unrelated discovered contacts', t => {
  const store = new StateStore(temporary(t)); store.configure(account, settings);
  let commits = 0; const save = store.save.bind(store);
  store.save = () => { commits++; return save(); };
  store.rememberConversationNames(account, {
    privatePeers: [{ id: 'alice', name: 'Alice Remark' }, { id: 'stranger', name: 'Not authorized' }],
    groups: [{ id: groupA, name: 'Group A' }, { id: 'strangers@chatroom', name: 'Not authorized group' }],
  });
  assert.equal(commits, 1);
  const list = store.conversations(account);
  assert.equal(list.find(item => item.peerId === groupA).name, 'Group A');
  assert.equal(list.find(item => item.peerId === 'alice').name, 'Alice Remark');
  assert(!list.some(item => item.peerId === 'stranger' || item.peerId === 'strangers@chatroom'));
  assert.equal(Object.keys(store.data.conversations).length, 2);
});

test('invalid paths and private participation settings fail before changing configuration', t => {
  const root = temporary(t), store = new StateStore(root), before = store.storageSettings();
  assert.throws(() => store.setStorageSettings({ workspacePath: 'relative-path', recordsPath: path.join(root, 'next') }), error => error.code === 'INVALID_STORAGE_PATH');
  assert.deepEqual(store.storageSettings(), before);
  assert.throws(() => store.setConversationSettings(account, 'private', 'alice', { mode: 'participate', minMessages: 5, maxMessages: 20, recordsPath: '' }),
    error => error.code === 'INVALID_CONVERSATION_MODE');
  if (process.platform === 'win32' && process.env.SystemRoot)
    assert.throws(() => store.setStorageSettings({ workspacePath: process.env.SystemRoot, recordsPath: path.join(root, 'next') }), error => error.code === 'INVALID_STORAGE_PATH');
  assert.deepEqual(store.storageSettings(), before);
});

test('conversation keys cannot expose or collide with raw path-like identities', t => {
  assert.match(conversationKey(account, 'group', groupA), /^[0-9a-f]{64}$/);
  assert.notEqual(conversationKey(account, 'group', groupA), conversationKey('other', 'group', groupA));
  const store = new StateStore(temporary(t));
  assert.throws(() => store.recordsPage(account, { chatType: 'group', peerId: '../outside' }), error => error.code === 'INVALID_CONVERSATION');
});

test('stale archive writers cannot overwrite a newer claim, including an identical incoming message', t => {
  const first = new StateStore(temporary(t)), initial = receive(first, 1);
  first.update(initial, { state: 'sent' });
  const stale = new StateStore(first.root);
  const incoming = message(2), item = record(2, incoming), at = Date.now();
  first.remember(item.key, at, item, { accountId: account, message: incoming });
  const committed = fs.readFileSync(archive(first), 'utf8');
  assert.throws(() => stale.remember(item.key, at, structuredClone(item), { accountId: account, message: incoming }),
    error => error.code === 'STATE_WRITE_FAILED');
  assert.equal(fs.readFileSync(archive(first), 'utf8'), committed);
  assert.equal(JSON.parse(committed).records.length, 2);
});

test('an active conversation writer lock prevents persistence and is never reaped', t => {
  const store = new StateStore(temporary(t)), item = receive(store, 1);
  const file = archive(store), before = fs.readFileSync(file, 'utf8');
  const lock = path.join(path.dirname(file), '.wechat-agent-write.lock');
  const owner = JSON.stringify({ ownerStoreId: store.data.storeId, key: conversationKey(account, 'group', groupA), pid: process.pid, token: 'other-writer' });
  fs.writeFileSync(lock, owner);
  assert.throws(() => store.update(item, { state: 'generating' }), error => error.code === 'STATE_WRITE_FAILED');
  assert.equal(fs.readFileSync(lock, 'utf8'), owner);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('migration refuses an older same-store archive that contains divergent history', t => {
  const root = temporary(t), store = new StateStore(root), item = receive(store, 1);
  store.update(item, { state: 'sent', reply: 'Confirmed', acknowledgedMessageIds: ['ack'] });
  const originalPath = archive(store), before = store.storageSettings();
  const target = path.join(root, 'divergent-target');
  const targetFile = path.join(target, path.relative(before.recordsPath, originalPath));
  const branch = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
  branch.revision--;
  branch.records.push({ ...record(999), state: 'sent' });
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const branchText = JSON.stringify(branch); fs.writeFileSync(targetFile, branchText);
  assert.throws(() => store.setStorageSettings({ workspacePath: path.join(root, 'work'), recordsPath: target }),
    error => error.code === 'CONVERSATION_PATH_CONFLICT');
  assert.equal(fs.readFileSync(targetFile, 'utf8'), branchText);
  assert.deepEqual(store.storageSettings(), before);
});

function clonedStore(store, root) {
  const file = path.join(root, 'storage/state/channel.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(store.file, file);
  return new StateStore(root);
}

test('both global and per-conversation migration refuse a stale source after another profile writes', t => {
  const root = temporary(t), first = new StateStore(path.join(root, 'first'));
  const initial = receive(first, 1); first.update(initial, { state: 'sent' });
  const other = clonedStore(first, path.join(root, 'cloned-profile'));
  receive(other, 2);
  const before = first.storageSettings(), oldFile = archive(first), current = fs.readFileSync(oldFile, 'utf8');
  const globalTarget = path.join(root, 'new-global'), customTarget = path.join(root, 'new-group');
  assert.throws(() => first.setStorageSettings({ workspacePath: path.join(root, 'workspace'), recordsPath: globalTarget }),
    error => error.code === 'STORAGE_SOURCE_CHANGED');
  assert.throws(() => first.setConversationSettings(account, 'group', groupA, { mode: 'default', minMessages: 5, maxMessages: 20, recordsPath: customTarget }),
    error => error.code === 'STORAGE_SOURCE_CHANGED');
  assert.deepEqual(first.storageSettings(), before);
  assert.equal(first.conversationSettings(account, 'group', groupA).recordsPath, '');
  assert.equal(fs.readFileSync(oldFile, 'utf8'), current);
  assert.equal(JSON.parse(current).records.length, 2);
  assert.equal(fs.readdirSync(globalTarget).length, 0);
  assert.equal(fs.readdirSync(customTarget).length, 0);
});

test('migration holds the source archive lock through copying and index commit', t => {
  const root = temporary(t), first = new StateStore(path.join(root, 'first'));
  const initial = receive(first, 1); first.update(initial, { state: 'sent' });
  const other = clonedStore(first, path.join(root, 'cloned-profile'));
  const source = archive(first), sourceLock = path.join(path.dirname(source), '.wechat-agent-write.lock');
  const save = first.save.bind(first); let checked = false;
  first.save = () => {
    assert(fs.existsSync(sourceLock));
    assert.throws(() => receive(other, 2), error => error.code === 'STATE_WRITE_FAILED');
    checked = true;
    return save();
  };
  first.setStorageSettings({ workspacePath: path.join(root, 'workspace'), recordsPath: path.join(root, 'migrated') });
  assert(checked); assert(!fs.existsSync(sourceLock));
  assert.notEqual(archive(first), source);
  assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).records.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(archive(first), 'utf8')).records.length, 1);
});
