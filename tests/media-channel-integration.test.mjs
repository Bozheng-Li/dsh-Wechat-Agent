import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { StateStore, WechatChannel, createPluginService, rpcHandler, ChannelError } from '../lib/testing.js';

const accountId = 'media-integration-owner', peerId = 'media-integration@chatroom';
const scope = { accountId, chatType: 'group', peerId };
function png() {
  const crc = data => { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const tag = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([tag, data]))); return Buffer.concat([length, tag, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(t) {
  const temporary = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temporary, 'wechat-media-channel-'));
  const store = new StateStore(root), settings = { enabled: true, groups: [peerId], privatePeers: [], prompt: '' };
  store.configure(accountId, settings);
  const status = { online: true, account: { id: accountId, nickname: '本机测试账号' } }, sent = [], cleanup = [];
  const worker = { status: () => structuredClone(status), send: async params => { sent.push(params); return { delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }; } };
  const runner = { selection: () => ({ provider: 'fixture', model: 'fixture' }), defaultSelection: () => ({ provider: 'fixture', model: 'fixture' }) };
  const channel = new WechatChannel({ store, runner, transport: worker, random: () => 0 });
  channel.library.import(accountId, { name: '点头.png', kind: 'sticker', data: png().toString('base64') });
  const asset = channel.library.list(accountId).items[0];
  channel.library.edit(accountId, asset.id, { description: '点头表示赞同' });
  runner.run = async input => {
    const tool = input.tools.find(value => value.name === 'wechat_reply_media'); assert.ok(tool);
    const selected = JSON.parse(await tool.execute({ action: 'select', assetId: asset.id, caption: null }, { signal: input.signal }));
    assert.equal(selected.ok, true); assert.equal(selected.sent, false);
    return { text: '工具已选中，不应重复发送这句话' };
  };
  const service = createPluginService({ ctx: {}, root, store, worker, runner, channel });
  let serial = 0;
  const receive = () => { const id = 'media-channel-' + ++serial; channel.receive({ id, serverMessageId: id, direction: 'incoming', time: Math.floor(Date.now() / 1000), chatType: 'group', peerId,
    sender: { id: 'alice', nickname: '阿禾' }, message: [{ type: 'text', data: { text: '/agent 发个表情包' } }] }, accountId); };
  const outgoing = () => channel.memory.load(scope).entries.filter(value => value.direction === 'outgoing');
  t.after(async () => {
    for (const action of cleanup) action();
    await channel.close(); await service.drain(); channel.library.close();
    assert.equal(path.dirname(root), temporary); assert.match(path.basename(root), /^wechat-media-channel-/); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, worker, runner, channel, service, status, settings, asset, sent, cleanup, receive, outgoing, record: () => store.data.records.at(-1) };
}
function holdSend(f) {
  const started = Promise.withResolvers(), complete = Promise.withResolvers(), cancelled = Promise.withResolvers();
  f.worker.send = async (params, signal) => { f.sent.push(params); signal.addEventListener('abort', () => cancelled.resolve(), { once: true }); started.resolve(); return complete.promise; };
  f.cleanup.push(() => complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }));
  return { started, complete, cancelled };
}

test('selected image enters history and memory only after the whole reply is server-acknowledged', async t => {
  const f = fixture(t), gate = holdSend(f); f.receive(); await gate.started.promise;
  assert.equal(f.record().state, 'sending'); assert.equal(f.outgoing().length, 0);
  assert.equal(f.store.history(accountId, 'group', peerId).filter(row => row.direction === 'outgoing').length, 0);
  assert.equal(f.sent[0].message.length, 1); assert.equal(f.sent[0].message[0].type, 'face');
  assert.equal(f.sent[0].accountId, accountId);
  gate.complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }); await f.channel.whenIdle();
  assert.equal(f.record().state, 'sent'); assert.equal(f.outgoing().length, 1);
  assert.equal(f.outgoing()[0].attachments[0].assetId, f.asset.id);
  assert.equal(f.outgoing()[0].attachments[0].description, '点头表示赞同');
  assert.ok(!JSON.stringify(f.outgoing()).includes('base64'));
});

test('partial text confirmation never promotes its unconfirmed image into memory', async t => {
  const f = fixture(t), original = f.runner.run;
  f.runner.run = async input => { await original(input); await input.tools.find(tool => tool.name === 'wechat_reply_media').execute({ action: 'select', assetId: f.asset.id, caption: '嗯嗯' }, { signal: input.signal }); return { text: '' }; };
  f.worker.send = async params => { f.sent.push(params); throw new ChannelError('ERR_SEND_REJECTED', 'fixture reject', { delivery: 'partially-acknowledged', acknowledgedMessageIds: ['9007199254740901'] }); };
  f.receive(); await f.channel.whenIdle();
  assert.equal(f.record().state, 'partial'); assert.deepEqual(f.record().acknowledgedMessageIds, ['9007199254740901']);
  assert.equal(f.outgoing().length, 0); assert.equal(f.sent[0].message.length, 2);
});

test('unknown or malformed completion does not claim an image in memory', async t => {
  const f = fixture(t); f.worker.send = async params => { f.sent.push(params); return { delivery: 'server-ack', serverMessageIds: [] }; };
  f.receive(); await f.channel.whenIdle(); assert.equal(f.record().state, 'unknown'); assert.equal(f.outgoing().length, 0); assert.equal(f.sent.length, 1);
});

test('cancellation racing the final ACK preserves real delivery in image memory', async t => {
  const f = fixture(t), gate = holdSend(f); f.receive(); await gate.started.promise;
  f.channel.cancel('fixture cancel', scope); await gate.cancelled.promise;
  gate.complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }); await f.channel.whenIdle();
  assert.equal(f.record().state, 'sent'); assert.equal(f.outgoing().length, 1);
});

for (const action of ['switch-account', 'revoke-room']) test(`media preparation rechecks ${action} before crossing the send boundary`, async t => {
  const f = fixture(t), prepare = f.channel.library.prepareSendContent.bind(f.channel.library);
  f.channel.library.prepareSendContent = async (...args) => {
    const asset = await prepare(...args);
    if (action === 'switch-account') { f.status.account.id = 'different-account'; f.store.configure('different-account', f.settings); }
    else f.store.configure(accountId, { ...f.settings, groups: [] });
    return asset;
  };
  f.receive(); await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(f.record().state, 'cancelled'); assert.equal(f.outgoing().length, 0);
});

for (const operation of ['disable', 'delete']) test(`a selected asset that is ${operation}d before preparation cannot be sent`, async t => {
  const f = fixture(t), original = f.runner.run;
  f.runner.run = async input => { const result = await original(input); if (operation === 'disable') f.channel.library.edit(accountId, f.asset.id, { enabled: false }); else f.channel.library.remove(accountId, [f.asset.id]); return result; };
  f.receive(); await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(f.record().state, 'failed'); assert.equal(f.outgoing().length, 0);
});

test('deleting media waits for cancellation and final delivery reconciliation before removing the asset', async t => {
  const f = fixture(t), gate = holdSend(f); f.receive(); await gate.started.promise;
  let finished = false;
  const removal = f.service.call('assets.delete', { accountId, assetIds: [f.asset.id] }).then(result => { finished = true; return result; });
  await gate.cancelled.promise;
  assert.equal(finished, false); assert.equal(f.channel.library.resolveAsset(accountId, f.asset.id).id, f.asset.id);
  gate.complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }); await removal; await f.channel.whenIdle();
  assert.equal(f.record().state, 'sent'); assert.equal(f.outgoing().length, 1);
  assert.throws(() => f.channel.library.resolveAsset(accountId, f.asset.id), { code: 'ASSET_NOT_FOUND' });
});

test('media management rejects another account before changing its assets', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.call('assets.delete', { accountId: 'different-account', assetIds: [f.asset.id] }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.channel.library.resolveAsset(accountId, f.asset.id).id, f.asset.id);
});

test('removing an unselected asset does not cancel an unrelated text reply', async t => {
  const f = fixture(t); f.runner.run = async () => ({ text: '正常的文字回复' });
  const gate = holdSend(f); f.receive(); await gate.started.promise;
  let cancelled = false; gate.cancelled.promise.then(() => { cancelled = true; });
  await f.service.call('assets.delete', { accountId, assetIds: [f.asset.id] });
  assert.equal(cancelled, false); assert.equal(f.record().state, 'sending');
  gate.complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }); await f.channel.whenIdle();
  assert.equal(f.record().state, 'sent'); assert.equal(f.outgoing()[0].text, '正常的文字回复');
});

for (const phase of ['before-prepare', 'after-prepare']) test(`disabling a selected media group ${phase} prevents its image from crossing the send boundary`, async t => {
  const f = fixture(t), packId = f.asset.packId;
  if (phase === 'before-prepare') {
    const original = f.runner.run;
    f.runner.run = async input => { const result = await original(input); f.channel.library.configurePack(accountId, packId, false); return result; };
  } else {
    const original = f.channel.library.prepareSendContent.bind(f.channel.library);
    f.channel.library.prepareSendContent = async (...args) => { const image = await original(...args); f.channel.library.configurePack(accountId, packId, false); return image; };
  }
  f.receive(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.outgoing().length, 0); assert.equal(f.record().state, 'failed');
  assert.equal(f.channel.library.resolveAsset(accountId, f.asset.id, { enabledOnly: false }).enabled, true);
});

test('disabling a group reconciles an in-flight ACK before saving the disabled state', async t => {
  const f = fixture(t), gate = holdSend(f); f.receive(); await gate.started.promise;
  let saved = false;
  const disabling = f.service.call('assets.packs.configure', { accountId, packId: f.asset.packId, enabled: false }).then(result => { saved = true; return result; });
  await gate.cancelled.promise; assert.equal(saved, false);
  gate.complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] });
  await disabling; await f.channel.whenIdle();
  assert.equal(f.record().state, 'sent'); assert.equal(f.outgoing().length, 1);
  assert.equal(f.channel.library.packs(accountId).find(pack => pack.id === f.asset.packId).enabled, false);
  assert.deepEqual(f.channel.library.search(accountId), []);
});

test('group switches leave unrelated text replies running and reject stale accounts and non-owner RPC peers', async t => {
  const f = fixture(t); f.runner.run = async () => ({ text: '普通文字回复' });
  const gate = holdSend(f); f.receive(); await gate.started.promise;
  let cancelled = false; gate.cancelled.promise.then(() => { cancelled = true; });
  await f.service.call('assets.packs.configure', { accountId, packId: f.asset.packId, enabled: false });
  assert.equal(cancelled, false);
  await assert.rejects(f.service.call('assets.packs.configure', { accountId: 'other-owner', packId: f.asset.packId, enabled: true }), { code: 'ACCOUNT_CHANGED' });
  const builtin = f.channel.library.builtins.packs[0], rpc = rpcHandler(f.service);
  for (const endpoint of ['assets.packs.content', 'assets.packs.configure']) {
    const result = await rpc(endpoint, { accountId, packId: builtin.id, assetId: builtin.items[0].id, enabled: true }, undefined, { principal: { kind: 'guest' } });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'OWNER_REQUIRED');
  }
  assert.throws(() => f.service.call('assets.packs.content', { accountId: 'other-owner', packId: builtin.id, assetId: builtin.items[0].id }), { code: 'ACCOUNT_CHANGED' });
  gate.complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }); await f.channel.whenIdle();
  assert.equal(f.record().state, 'sent');
});

test('cancelling a group change during drain leaves the previous group state saved', async t => {
  const f = fixture(t), gate = holdSend(f), controller = new AbortController(); f.receive(); await gate.started.promise;
  const disabling = f.service.call('assets.packs.configure', { accountId, packId: f.asset.packId, enabled: false }, controller.signal);
  const rejected = assert.rejects(disabling, { name: 'AbortError' });
  await gate.cancelled.promise; controller.abort();
  gate.complete.resolve({ delivery: 'server-ack', serverMessageIds: ['9007199254740999'] }); await rejected; await f.channel.whenIdle();
  assert.equal(f.channel.library.packs(accountId).find(pack => pack.id === f.asset.packId).enabled, true);
  assert.equal(f.record().state, 'sent'); assert.equal(f.channel.pauses.size, 0);
});
