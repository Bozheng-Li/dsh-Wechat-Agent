import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { StateStore, WechatChannel, identity } from '../lib/testing.js';
import { stateBackupScopes } from '../modules/authorization/backups.mjs';

const base = path.resolve('storage/tmp');
function fixture(t, { grantAlice = false } = {}) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'authorization-backup-')), store = new StateStore(root), accountId = 'backup-owner';
  store.configure(accountId, { enabled: false, privatePeers: ['bob', ...(grantAlice ? ['alice'] : [])], groups: ['room@chatroom'], prompt: '' });
  store.configure('another-owner', { enabled: false, privatePeers: ['alice'], groups: [], prompt: '保留其他账号配置' });
  const scope = (peerId, account = accountId) => ({ accountId: account, chatType: peerId.endsWith('@chatroom') ? 'group' : 'private', peerId });
  const metadata = target => ({ ...target, key: identity([target.accountId, target.chatType, target.peerId]), name: target.peerId });
  const conversations = [metadata(scope('alice')), metadata(scope('bob')), metadata(scope('room@chatroom')), metadata(scope('alice', 'another-owner'))];
  const record = (target, senderId, key) => ({ ...target, senderId, key, contextKey: 'context-' + key, text: '原资料-' + key });
  const records = [record(scope('alice'), 'alice', 'private-a'), record(scope('room@chatroom'), 'alice', 'group-a'),
    record(scope('room@chatroom'), 'bob', 'group-b'), record(scope('alice', 'another-owner'), 'alice', 'other-a')];
  const snapshot = { version: 2, storeId: store.data.storeId, accounts: {
    [accountId]: { enabled: false, privatePeers: ['alice', 'bob'], groups: ['room@chatroom'], prompt: '' },
    'another-owner': store.settings('another-owner'),
  }, conversations: Object.fromEntries(conversations.map(row => [row.key, row])),
  conversationConfigs: Object.fromEntries(conversations.map(row => [row.key, { prompt: row.peerId, adminIds: ['alice', 'bob'] }])),
  records, seen: Object.fromEntries(records.map(row => [row.key, 1])), sessions: Object.fromEntries(records.map(row => [row.contextKey, { id: row.key }])) };
  const file = path.join(root, 'storage/state/channel.before-yaml-0123456789ab.backup.json');
  fs.writeFileSync(file, JSON.stringify(snapshot));
  let channel;
  const start = () => channel = new WechatChannel({ store,
    runner: { run: async () => { throw Error('No model call is expected'); } },
    transport: { status: () => ({ online: false, account: { id: accountId } }), send: async () => { throw Error('No WeChat write is expected'); } },
  });
  t.after(async () => {
    if (channel) await channel.close();
    const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(base));
    assert(path.basename(target).startsWith('authorization-backup-')); fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, store, accountId, file, snapshot, conversations, scope, start, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('startup clears withdrawn identities found only in owned migration snapshots while keeping authorized and other-account data', async t => {
  const f = fixture(t); assert.equal(f.store.data.authorizationRevocations.length, 0);
  assert(stateBackupScopes(f.store).some(scope => scope.peerId === 'alice' && scope.accountId === f.accountId));
  const channel = f.start(); await channel.authorization.ready;
  const cleaned = f.read(), alice = f.conversations[0].key, bob = f.conversations[1].key, group = f.conversations[2].key, other = f.conversations[3].key;
  assert.equal(cleaned.conversations[alice], undefined); assert.equal(cleaned.conversationConfigs[alice], undefined);
  assert.deepEqual(cleaned.accounts[f.accountId].privatePeers, ['bob']);
  assert.deepEqual(cleaned.accounts['another-owner'], f.snapshot.accounts['another-owner']);
  assert.deepEqual(cleaned.conversations[bob], f.snapshot.conversations[bob]);
  assert.deepEqual(cleaned.conversations[other], f.snapshot.conversations[other]);
  assert.deepEqual(cleaned.conversationConfigs[other], f.snapshot.conversationConfigs[other]);
  assert.deepEqual(cleaned.conversationConfigs[group].adminIds, ['bob']);
  assert.deepEqual(cleaned.records.map(row => row.key), ['group-b', 'other-a']);
  assert.deepEqual(Object.keys(cleaned.seen), ['group-b', 'other-a']);
  assert.deepEqual(Object.keys(cleaned.sessions), ['context-group-b', 'context-other-a']);
  assert.equal(f.store.data.authorizationRevocations.length, 0);
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: ['alice', 'bob'] });
  await channel.authorization.whenIdle(); assert.equal(f.read().conversations[alice], undefined);
});

test('snapshot persistence failure keeps revocation pending and preserves the old bytes until a successful retry', async t => {
  const f = fixture(t, { grantAlice: true }), channel = f.start(); await channel.authorization.ready;
  const originalBytes = fs.readFileSync(f.file), originalRename = fs.renameSync;
  fs.renameSync = (from, to) => { if (path.resolve(to) === path.resolve(f.file)) throw Object.assign(Error('模拟快照占用'), { code: 'EIO' }); return originalRename(from, to); };
  syncBuiltinESMExports();
  try {
    f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: ['bob'] });
    await assert.rejects(channel.authorization.whenIdle(), /模拟快照占用/);
    assert.equal(f.store.data.authorizationRevocations.length, 1);
    assert(fs.readFileSync(f.file).equals(originalBytes));
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  await channel.authorization.reconcile();
  assert.equal(f.store.data.authorizationRevocations.length, 0);
  assert.deepEqual(f.read().accounts[f.accountId].privatePeers, ['bob']);
  assert.equal(f.read().conversations[f.conversations[0].key], undefined);
});

test('foreign-owner snapshots and unrelated backup files remain byte-for-byte intact', async t => {
  const f = fixture(t), foreign = path.join(f.root, 'storage/state/channel.personas-v1-abcdef012345.backup.json'),
    unrelated = path.join(f.root, 'storage/state/manual.backup.json');
  const foreignBytes = Buffer.from(JSON.stringify({ ...f.snapshot, storeId: 'another-store' }));
  fs.writeFileSync(foreign, foreignBytes); fs.writeFileSync(unrelated, foreignBytes);
  const channel = f.start(); await channel.authorization.ready;
  assert(fs.readFileSync(foreign).equals(foreignBytes)); assert(fs.readFileSync(unrelated).equals(foreignBytes));
});

test('group revocation also removes its old snapshot settings and records without erasing authorized private or other-account history', async t => {
  const f = fixture(t, { grantAlice: true }), channel = f.start(); await channel.authorization.ready;
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), groups: [] }); await channel.authorization.whenIdle();
  const cleaned = f.read(), group = f.conversations[2].key;
  assert.equal(cleaned.conversations[group], undefined); assert.equal(cleaned.conversationConfigs[group], undefined);
  assert.deepEqual(cleaned.accounts[f.accountId].groups, []);
  assert.deepEqual(cleaned.records.map(row => row.key), ['private-a', 'other-a']);
  assert.deepEqual(cleaned.conversations[f.conversations[0].key], f.snapshot.conversations[f.conversations[0].key]);
});
