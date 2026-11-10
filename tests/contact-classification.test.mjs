import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { nativeQrSession } from './fixtures/native-qr-session.mjs';
import { StateStore } from '../lib/testing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = ['backend.ts', 'wire.ts'].map(name =>
  `export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol', name))};`).join('\n');
const build = await rolldown({ input: 'virtual:contacts', platform: 'node',
  resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') } },
  plugins: [{ name: 'contacts', resolveId: id => id === 'virtual:contacts' ? id : null,
    load: id => id === 'virtual:contacts' ? entry : null }] });
let api;
try {
  const { output } = await build.generate({ format: 'esm' });
  api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);
} finally { await build.close(); }
const { ProtocolBackend, fields, ld, fv } = api;
const room = 'fixture-system-room@chatroom';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'wechat-contacts-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    assert(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const qr = nativeQrSession(api), sessionFile = path.join(directory, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify(qr.credential));
  const options = { sessionFile, cacheDir: path.join(directory, 'cache'), syncIntervalMs: 60000,
    heartbeatIntervalMs: 60000, requestTimeoutMs: 1000, reconnectMs: 1000,
    sendIntervalMs: 0, sendJitterMs: 0, segmentBytes: 4096 };
  return { directory, qr, options, backend: new ProtocolBackend(options) };
}

test('group system and other non-text messages never create private contacts with a group ID', async t => {
  const f = fixture(t);
  for (const type of [10000, 10002, 34, 43, 49]) {
    const message = f.backend.decodeMessage(fields(Buffer.concat([
      ld(2, room), ld(3, f.qr.credential.wxid), fv(4, type), ld(5, 'system event'),
      fv(9, 1700000000), fv(12, type),
    ])));
    assert.equal(message.chatType, 'group');
    assert.equal(message.peerId, room);
  }
  f.backend.decodeMessage(fields(Buffer.concat([
    ld(2, 'fixture-friend'), ld(3, f.qr.credential.wxid), fv(4, 1), ld(5, 'hello'),
    fv(9, 1700000000), fv(12, 1),
  ])));
  assert.deepEqual((await f.backend.call('action.get_friend_list', {})).map(c => c.id), ['fixture-friend']);
  assert(!f.backend.cache.contacts.some(c => c.id.endsWith('@chatroom')));
});

test('legacy cached group contacts are excluded from private contacts without deleting cached history', async t => {
  const f = fixture(t), cacheFile = path.join(f.options.cacheDir, `${f.qr.credential.uin}.json`);
  const stale = { ...f.backend.cache,
    contacts: [{ id: room, nickname: room }, { id: 'fixture-friend', nickname: 'Friend' }],
    groups: [{ id: room, name: 'Fixture room', memberCount: 0, memberCountKnown: false }],
  };
  fs.mkdirSync(f.options.cacheDir, { recursive: true });
  const before = JSON.stringify(stale);
  fs.writeFileSync(cacheFile, before);
  const backend = new ProtocolBackend(f.options);
  const friends = await backend.call('action.get_friend_list', {});
  assert.deepEqual(friends.map(c => c.id), ['fixture-friend']);
  assert.deepEqual((await backend.call('action.get_group_list', {})).map(c => c.id), [room]);
  const store = new StateStore(path.join(f.directory, 'workspace'));
  store.configure(f.qr.credential.wxid, { enabled: true, privatePeers: [], groups: [room], prompt: '' });
  store.rememberConversationNames(f.qr.credential.wxid, {
    privatePeers: friends.map(c => ({ id: c.id, name: c.nickname })),
    groups: (await backend.call('action.get_group_list', {})).map(g => ({ id: g.id, name: g.name })),
  });
  assert.equal(store.conversations(f.qr.credential.wxid)[0].name, 'Fixture room');
  assert.equal(store.settings(f.qr.credential.wxid).enabled, true);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), before);
});
