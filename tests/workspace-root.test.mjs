import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeWorkspace, migrateWorkspaceRoot, readWorkspaceLocation } from "../backend/storage/workspace.mjs";

const { StateStore, ConversationMemory, LongTermMemory, acquireLock, identity, conversationKey } =
  await import(process.env.DSH_STATE_TEST_MODULE || '../lib/testing.js');
const account = 'wxid_migration', secondAccount = 'wxid_other_migration';
const group = 'migration@chatroom', customGroup = 'custom_migration@chatroom';
const settings = { enabled: true, privatePeers: ['alice'], groups: [group, customGroup], prompt: 'Keep this authorization' };

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'dsh-workspace-root-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^dsh-workspace-root-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function put(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  return file;
}

function contents(root) {
  const files = {};
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (['owner.lock', '.workspace-migration.lock', 'location.json', '.wechat-agent-write.lock'].includes(name)) continue;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) visit(file);
      else files[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  };
  visit(root); return files;
}

function receive(store, n, peerId = group, accountId = account) {
  const chatType = peerId.endsWith('@chatroom') ? 'group' : 'private';
  const incoming = { id: 'message-' + n, serverMessageId: String(n), peerId, chatType, direction: 'incoming',
    time: 1793949000 + n, sender: { id: 'alice', nickname: 'Alice' }, message: [{ type: 'text', data: { text: 'Message ' + n } }] };
  const item = { key: identity([accountId, chatType, peerId, incoming.serverMessageId]),
    contextKey: identity([accountId, chatType, peerId, 'alice']), accountId, chatType, peerId, senderId: 'alice',
    messageId: incoming.id, state: 'queued', question: 'Message ' + n, createdAt: 1793949000000 + n, updatedAt: 1793949000000 + n };
  store.remember(item.key, item.createdAt, item, { accountId, message: incoming, progress: { count: 2, target: 5 } });
  store.update(item, { state: 'sent', reply: 'Confirmed ' + n, acknowledgedMessageIds: ['wechat-ack-' + n] });
  return item;
}

function recordFile(store, peerId = group, accountId = account) {
  return path.join(store.data.conversations[conversationKey(accountId, peerId.endsWith('@chatroom') ? 'group' : 'private', peerId)].directory, 'conversation.json');
}

function fresh(t) {
  const parent = temporary(t), bootstrap = path.join(parent, 'bootstrap'), store = new StateStore(bootstrap);
  return { parent, bootstrap, store, targetRoot: path.join(parent, 'next') };
}

test('workspace defaults do not create data and descriptions report actual legacy locations', t => {
  const parent = temporary(t), bootstrap = path.join(parent, 'bootstrap');
  assert.equal(readWorkspaceLocation(bootstrap), bootstrap);
  assert(!fs.existsSync(bootstrap));
  const store = new StateStore(bootstrap), description = describeWorkspace(bootstrap, store);
  assert.deepEqual(description, { basePath: bootstrap, workspacePath: path.join(bootstrap, 'workspace'), agentWorkspacePath: path.join(bootstrap, 'workspace', '微信agent'),
    recordsPath: path.join(bootstrap, 'storage/conversations'), memoryPath: path.join(bootstrap, 'storage/memory'),
    assetsPath: path.join(bootstrap, 'storage/assets'), tasksPath: path.join(bootstrap, 'storage/tasks'),
    loginPath: path.join(bootstrap, 'storage/private'), cachePath: path.join(bootstrap, 'storage/cache'), legacyPaths: [] });
  const legacy = { workspacePath: path.join(parent, 'external-work'), recordsPath: path.join(parent, 'external-records') };
  store.setStorageSettings(legacy);
  const actual = describeWorkspace(bootstrap, store);
  assert.equal(actual.workspacePath, fs.realpathSync(legacy.workspacePath));
  assert.equal(actual.recordsPath, fs.realpathSync(legacy.recordsPath));
  assert(actual.legacyPaths.includes(actual.workspacePath)); assert(actual.legacyPaths.includes(actual.recordsPath));
  assert.equal(actual.memoryPath, description.memoryPath);
});

test('migration consolidates current and legacy data without touching source state, ACKs or Markdown', t => {
  const { parent, bootstrap, store, targetRoot } = fresh(t);
  store.configure(account, settings); store.configure(secondAccount, settings);
  const first = receive(store, 1), second = receive(store, 2, customGroup), other = receive(store, 3, 'alice', secondAccount);
  store.saveSession(first.contextKey, 'dsh-session-preserved');
  store.data.connectionWanted = true; store.save();
  put(bootstrap, 'workspace/note.txt', 'Retained old workspace');
  const externalWorkspace = path.join(parent, 'external-workspace'), externalRecords = path.join(parent, 'external-records');
  put(externalWorkspace, 'note.txt', 'Current workspace'); put(externalWorkspace, 'project/analysis.txt', 'Current project file');
  store.setStorageSettings({ workspacePath: externalWorkspace, recordsPath: externalRecords });
  const individualRecords = path.join(parent, 'individual-records');
  store.setConversationSettings(account, 'group', customGroup, { ...store.conversationSettings(account, 'group', customGroup), recordsPath: individualRecords });
  store.update(second, { state: 'unknown', reason: 'Uncertain send must never replay', acknowledgedMessageIds: ['wechat-partial-2'] });
  const imageFile = put(bootstrap, 'storage/media/observed.image', Buffer.from([0, 1, 2, 255]));
  store.update(first, { localPath: imageFile });
  const selector = { accountId: account, chatType: 'group', peerId: group };
  const memory = new ConversationMemory(store); store.memory = memory; memory.seed();
  memory.edit(selector, 'A durable memory summary', memory.load(selector).revision);
  const indexEntry = memory.index.conversations[conversationKey(account, 'group', group)];
  indexEntry.folder = path.join(memory.root, indexEntry.folder);
  put(bootstrap, 'storage/memory/index.json', memory.index);
  const longTerm = new LongTermMemory(store), initial = longTerm.view(account);
  const markdown = initial.markdown.replace('<!-- wechat-global:begin -->', '<!-- wechat-global:begin -->\n\n每周五下午整理本周工作。');
  longTerm.edit(account, markdown, initial.revision);
  const identityMd = '# Shared identity\n\nPreserve this literal path: ' + bootstrap + '\n';
  put(bootstrap, 'AGENT.md', identityMd);
  const retained = {
    'storage/private/credential.json': { accountId: account, token: 'TEST_ONLY_CREDENTIAL' },
    'storage/private/qrcode/nested.png': Buffer.from([137, 80, 78, 71]),
    'storage/assets/index.json': { version: 1, ownerStoreId: store.data.storeId, accounts: {} },
    'storage/assets/asset/image.gif': Buffer.from('GIF89a-retained'),
    'storage/tasks/schedules.json': { version: 1, ownerStoreId: store.data.storeId, tasks: [{ id: 'task-1', state: 'pending', content: 'Keep task' }], runs: [{ id: 'run-1', state: 'sent', acknowledgedMessageIds: ['task-ack'] }] },
    'storage/cache/nested/cache.bin': Buffer.from([9, 8, 7, 0]),
    'storage/tmp/preserved.txt': 'Temporary data retained',
    'storage/knowledge/note.md': '# Knowledge',
    'storage/exports/record.txt': 'Export retained',
    'storage/logs/history.log': 'Log retained',
    'storage/backups/old-backup.json': { old: true },
    '.cache/client.bin': Buffer.from([0, 22, 34]),
  };
  for (const [file, value] of Object.entries(retained)) put(bootstrap, file, value);
  put(bootstrap, 'storage/state/private-acl-v1.json', { protectedPaths: ['storage'] });
  const owner = acquireLock(bootstrap); t.after(() => owner.release());
  const ownerBefore = fs.readFileSync(path.join(bootstrap, 'owner.lock'), 'utf8');
  const before = contents(bootstrap), beforeExternal = contents(externalRecords), beforeIndividual = contents(individualRecords);
  const originalSettings = store.storageSettings(), sourceArchive = fs.readFileSync(recordFile(store));
  const transaction = migrateWorkspaceRoot({ bootstrap, store, targetRoot });
  assert.equal(transaction.root, fs.realpathSync(targetRoot));
  assert.equal(readWorkspaceLocation(bootstrap), transaction.root);
  assert.deepEqual(contents(bootstrap), before);
  assert.deepEqual(contents(externalRecords), beforeExternal); assert.deepEqual(contents(individualRecords), beforeIndividual);
  assert.deepEqual(store.storageSettings(), originalSettings);
  assert.equal(fs.readFileSync(path.join(bootstrap, 'owner.lock'), 'utf8'), ownerBefore);
  assert(!fs.existsSync(path.join(targetRoot, 'owner.lock')));
  assert(!fs.existsSync(path.join(targetRoot, 'location.json')));
  assert(!fs.existsSync(path.join(targetRoot, 'storage/state/private-acl-v1.json')));
  const newOwner = acquireLock(targetRoot); newOwner.release();
  const restored = new StateStore(targetRoot);
  assert.equal(restored.data.storeId, store.data.storeId); assert.equal(restored.data.connectionWanted, true);
  assert.deepEqual(restored.settings(account), store.settings(account)); assert.deepEqual(restored.settings(secondAccount), store.settings(secondAccount));
  assert.equal(restored.session(first.contextKey), 'dsh-session-preserved');
  assert.deepEqual(restored.progress(account, 'group', group), { count: 2, target: 5 });
  const records = new Map(restored.data.records.map(item => [item.key, item]));
  assert.equal(records.size, 3);
  assert.equal(records.get(first.key).state, 'sent'); assert.deepEqual(records.get(first.key).acknowledgedMessageIds, ['wechat-ack-1']);
  assert.equal(records.get(first.key).localPath, path.join(targetRoot, 'storage/media/observed.image'));
  assert.equal(records.get(second.key).state, 'unknown'); assert.deepEqual(records.get(second.key).acknowledgedMessageIds, ['wechat-partial-2']);
  assert.equal(records.get(other.key).accountId, secondAccount);
  assert.equal(restored.data.seen[first.key], store.data.seen[first.key]);
  assert.equal(restored.conversationSettings(account, 'group', customGroup).recordsPath, '');
  assert.deepEqual(describeWorkspace(targetRoot, restored).legacyPaths, []);
  for (const metadata of Object.values(restored.data.conversations)) {
    assert(metadata.directory.startsWith(path.join(targetRoot, 'storage/conversations') + path.sep));
    assert(!fs.existsSync(path.join(metadata.directory, '.wechat-agent-write.lock')));
  }
  assert.equal(fs.readFileSync(path.join(targetRoot, 'workspace/note.txt'), 'utf8'), 'Current workspace');
  assert.equal(fs.readFileSync(path.join(targetRoot, 'workspace/project/analysis.txt'), 'utf8'), 'Current project file');
  assert(Object.values(contents(path.join(targetRoot, 'storage/backups/workspace-migration'))).includes(Buffer.from('Retained old workspace').toString('base64')));
  assert.equal(fs.readFileSync(path.join(targetRoot, 'AGENT.md'), 'utf8'), identityMd);
  for (const file of Object.keys(retained)) assert.deepEqual(fs.readFileSync(path.join(targetRoot, file)), fs.readFileSync(path.join(bootstrap, file)));
  const restoredMemory = new ConversationMemory(restored); restored.memory = restoredMemory;
  assert.equal(restoredMemory.load(selector).summary, 'A durable memory summary');
  assert(!path.isAbsolute(restoredMemory.index.conversations[conversationKey(account, 'group', group)].folder));
  assert.equal(new LongTermMemory(restored).view(account).markdown, markdown);
  assert.equal(transaction.commit(), transaction.root); assert.equal(transaction.commit(), transaction.root);
  assert.throws(() => transaction.rollback(), error => error.code === 'WORKSPACE_MIGRATION_FINISHED');
  receive(restored, 4);
  assert.deepEqual(fs.readFileSync(recordFile(store)), sourceArchive);
  assert.deepEqual(contents(bootstrap), before);
});

test('failed runtime validation can roll back an absent pointer while retaining both complete copies', t => {
  const { bootstrap, store, targetRoot } = fresh(t); receive(store, 10);
  const before = contents(bootstrap), transaction = migrateWorkspaceRoot({ bootstrap, store, targetRoot });
  assert.equal(readWorkspaceLocation(bootstrap), targetRoot);
  assert.equal(transaction.rollback(), bootstrap); assert.equal(transaction.rollback(), bootstrap);
  assert(!fs.existsSync(path.join(bootstrap, 'location.json')));
  assert.equal(readWorkspaceLocation(bootstrap), bootstrap);
  assert.deepEqual(contents(bootstrap), before);
  assert.equal(new StateStore(targetRoot).data.records[0].state, 'sent');
  assert(!fs.existsSync(path.join(bootstrap, '.workspace-migration.lock')));
});

test('a second migration restores the exact previous pointer and leaves earlier roots untouched', t => {
  const { parent, bootstrap, store, targetRoot } = fresh(t); receive(store, 20);
  migrateWorkspaceRoot({ bootstrap, store, targetRoot }).commit();
  const pointer = path.join(bootstrap, 'location.json');
  const formatted = JSON.stringify(JSON.parse(fs.readFileSync(pointer, 'utf8'))) + '\n\n'; fs.writeFileSync(pointer, formatted);
  const active = new StateStore(targetRoot), before = contents(targetRoot), next = path.join(parent, 'third');
  const transaction = migrateWorkspaceRoot({ bootstrap, store: active, targetRoot: next });
  assert.equal(readWorkspaceLocation(bootstrap), next);
  transaction.rollback();
  assert.equal(fs.readFileSync(pointer, 'utf8'), formatted); assert.equal(readWorkspaceLocation(bootstrap), targetRoot);
  assert.deepEqual(contents(targetRoot), before); assert(fs.existsSync(path.join(next, 'storage/state/channel.json')));
});

test('existing unrelated files, nested directories and legacy in-place changes are refused', t => {
  const { parent, bootstrap, store, targetRoot } = fresh(t), before = contents(bootstrap);
  const unrelated = put(targetRoot, 'user-document.txt', 'Do not overwrite');
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot }), error => error.code === 'WORKSPACE_TARGET_NOT_EMPTY');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'Do not overwrite');
  for (const overlapping of [path.join(bootstrap, 'inside'), parent])
    assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot: overlapping }), error => error.code === 'WORKSPACE_PATH_OVERLAP');
  assert.deepEqual(contents(bootstrap), before); assert(!fs.existsSync(path.join(bootstrap, 'location.json')));
  const same = migrateWorkspaceRoot({ bootstrap, store, targetRoot: bootstrap });
  assert.equal(same.commit(), bootstrap); assert.equal(same.rollback(), bootstrap);
  const external = path.join(parent, 'external');
  store.setStorageSettings({ workspacePath: external, recordsPath: store.storageSettings().recordsPath });
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot: bootstrap }), error => error.code === 'WORKSPACE_LEGACY_PATHS');
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot: path.join(external, 'inside') }), error => error.code === 'WORKSPACE_PATH_OVERLAP');
});

test('source links and links in destination ancestors never redirect a migration', t => {
  const { parent, bootstrap, store, targetRoot } = fresh(t), outside = path.join(parent, 'outside');
  const sentinel = put(outside, 'keep.txt', 'Outside remains unchanged');
  const link = path.join(parent, 'linked'); fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot: path.join(link, 'new') }), error => error.code === 'WORKSPACE_PATH_LINK');
  fs.symlinkSync(outside, path.join(bootstrap, 'workspace'), 'junction');
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot }), error => error.code === 'WORKSPACE_PATH_LINK');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Outside remains unchanged');
  assert(!fs.existsSync(path.join(outside, 'new'))); assert(!fs.existsSync(path.join(bootstrap, 'location.json')));
});

test('a stale store cannot publish over a newer conversation claim or acknowledgement', t => {
  const { bootstrap, store, targetRoot } = fresh(t); receive(store, 30);
  const other = new StateStore(bootstrap); receive(other, 31);
  const latest = fs.readFileSync(recordFile(other));
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot }), error => error.code === 'STORAGE_SOURCE_CHANGED');
  assert.deepEqual(fs.readFileSync(recordFile(other)), latest); assert(!fs.existsSync(path.join(bootstrap, 'location.json')));
  assert(!fs.existsSync(path.join(bootstrap, '.workspace-migration.lock')));
});

test('a missing configured external workspace cannot be replaced by an empty new directory', t => {
  const { parent, bootstrap, store, targetRoot } = fresh(t), external = path.join(parent, 'external-workspace');
  store.setStorageSettings({ workspacePath: external, recordsPath: store.storageSettings().recordsPath });
  assert.equal(path.dirname(fs.realpathSync(external)), parent);
  fs.rmdirSync(external);
  const before = contents(bootstrap);
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot }), error => error.code === 'WORKSPACE_SOURCE_MISSING');
  assert.deepEqual(contents(bootstrap), before); assert(!fs.existsSync(path.join(bootstrap, 'location.json')));
  assert(!fs.existsSync(external)); assert.deepEqual(fs.readdirSync(targetRoot), []);
});

test('a write failure during copying leaves the source authoritative and removes only its staging directory', t => {
  const { parent, bootstrap, store, targetRoot } = fresh(t); receive(store, 40);
  put(bootstrap, 'workspace/disk-failure.txt', 'WORKSPACE_DISK_FAILURE_SENTINEL');
  const before = contents(bootstrap), originalWrite = fs.writeSync;
  t.mock.method(fs, 'writeSync', function(descriptor, buffer, ...args) {
    if (Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('WORKSPACE_DISK_FAILURE_SENTINEL')))
      throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
    return originalWrite.call(this, descriptor, buffer, ...args);
  });
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot }), error => error.code === 'WORKSPACE_MIGRATION_FAILED');
  assert.deepEqual(contents(bootstrap), before); assert(!fs.existsSync(path.join(bootstrap, 'location.json')));
  assert.deepEqual(fs.readdirSync(targetRoot), []);
  assert(!fs.readdirSync(parent).some(name => name.includes('.wechat-agent-')));
});

test('a source file created during the copy prevents publishing a mixed workspace', t => {
  const { bootstrap, store, targetRoot } = fresh(t);
  put(bootstrap, 'workspace/trigger.txt', 'ADD_SOURCE_DURING_COPY');
  const originalWrite = fs.writeSync; let injected = false;
  t.mock.method(fs, 'writeSync', function(descriptor, buffer, ...args) {
    if (!injected && Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('ADD_SOURCE_DURING_COPY'))) {
      injected = true; put(bootstrap, 'workspace/arrived-later.txt', 'This must remain in the source');
    }
    return originalWrite.call(this, descriptor, buffer, ...args);
  });
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot }), error => error.code === 'STORAGE_SOURCE_CHANGED');
  assert(injected); assert(!fs.existsSync(path.join(bootstrap, 'location.json')));
  assert.equal(fs.readFileSync(path.join(bootstrap, 'workspace/arrived-later.txt'), 'utf8'), 'This must remain in the source');
});

test('pointer publication failure preserves the old selection and keeps the complete new copy', t => {
  const { bootstrap, store, targetRoot } = fresh(t); receive(store, 50);
  const before = contents(bootstrap), pointer = path.join(bootstrap, 'location.json'), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function(from, to) {
    if (to === pointer) throw Object.assign(new Error('Synthetic pointer failure'), { code: 'EIO' });
    return rename.call(this, from, to);
  });
  assert.throws(() => migrateWorkspaceRoot({ bootstrap, store, targetRoot }), error => error.code === 'WORKSPACE_MIGRATION_FAILED');
  assert.equal(readWorkspaceLocation(bootstrap), bootstrap); assert.deepEqual(contents(bootstrap), before);
  assert.equal(new StateStore(targetRoot).data.records[0].state, 'sent');
  assert(!fs.readdirSync(bootstrap).some(name => name.startsWith('location.json.') || name === '.workspace-migration.lock'));
});

test('rollback refuses to overwrite a pointer changed by another operation', t => {
  const { parent, bootstrap, store, targetRoot } = fresh(t);
  const transaction = migrateWorkspaceRoot({ bootstrap, store, targetRoot });
  const anotherRoot = path.join(parent, 'another'), another = new StateStore(anotherRoot);
  const changed = JSON.stringify({ version: 1, root: anotherRoot, storeId: another.data.storeId });
  put(bootstrap, 'location.json', changed);
  assert.throws(() => transaction.rollback(), error => error.code === 'WORKSPACE_LOCATION_CHANGED');
  assert.equal(fs.readFileSync(path.join(bootstrap, 'location.json'), 'utf8'), changed);
  assert.equal(readWorkspaceLocation(bootstrap), anotherRoot);
});

test('invalid, missing and mismatched pointer targets never silently start empty accounts', t => {
  const { parent, bootstrap, store } = fresh(t);
  put(bootstrap, 'location.json', '{broken');
  assert.throws(() => readWorkspaceLocation(bootstrap), error => error.code === 'WORKSPACE_LOCATION_INVALID');
  put(bootstrap, 'location.json', { version: 1, root: path.join(parent, 'missing'), storeId: store.data.storeId });
  assert.throws(() => readWorkspaceLocation(bootstrap), error => error.code === 'WORKSPACE_SOURCE_MISSING');
  assert(!fs.existsSync(path.join(parent, 'missing')));
  const otherRoot = path.join(parent, 'other'); new StateStore(otherRoot);
  put(bootstrap, 'location.json', { version: 1, root: otherRoot, storeId: store.data.storeId });
  assert.throws(() => readWorkspaceLocation(bootstrap), error => error.code === 'WORKSPACE_LOCATION_INVALID');
});
