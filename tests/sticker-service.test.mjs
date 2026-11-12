import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { StateStore } from '../lib/testing.js';
import { MediaLibrary } from '../modules/media/library.mjs';
import { WechatStickerService } from '../modules/media/sticker-service.mjs';
import { stickerPng as png, stickerDigest as md5 } from './fixtures/stickers.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sticker-service-')), accountId = 'service-owner', peerId = 'authorized@chatroom';
  const store = new StateStore(root); store.configure(accountId, { enabled: true, groups: [peerId], privatePeers: [], prompt: '' });
  const library = new MediaLibrary(store), status = { online: true, account: { id: accountId }, nativeStickersReady: true };
  const transport = new EventEmitter(); transport.status = () => structuredClone(status);
  const calls = [], content = png(); transport.media = async args => { calls.push(args); return { data: content.toString('base64'), quality: 'original', stickerMd5: md5(content) }; };
  const channel = { store, library, transport, now: Date.now, random: () => 0, runner: {}, closed: false };
  const service = new WechatStickerService(channel); service.nextSync.set(accountId, Infinity);
  const message = { id: 'm1', serverMessageId: '123', peerId, chatType: 'group', direction: 'incoming', source: 'longlink:NewSync',
    sender: { id: 'alice' }, time: Math.floor(Date.now() / 1000), message: [{ type: 'face', data: { resourceId: 'fixture-face', stickerMd5: md5(content) } }] };
  t.after(async () => { await service.close(); library.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^wechat-sticker-service-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, accountId, peerId, store, library, status, transport, channel, service, message, calls, content };
}
test('only fresh authorized chat stickers are captured, deduplicated and persisted without invoking a chat model', async t => {
  const f = fixture(t); f.channel.runner.run = () => assert.fail('capture must not invoke the chat model');
  for (const change of [{ peerId: 'foreign@chatroom' }, { source: 'shortlink:SendEmoji' }, { time: 1 }, { message: [{ type: 'image', data: { resourceId: 'photo' } }] }])
    assert.equal((await f.service.capture(f.accountId, { ...f.message, ...change })).skipped, true);
  await f.service.capture(f.accountId, f.message); await f.service.capture(f.accountId, f.message);
  assert.equal(f.calls.length, 1); assert.equal(f.library.list(f.accountId).total, 1);
  assert.equal(f.calls[0].preserveStickerOriginal, true);
  assert.equal(new MediaLibrary(f.store).list(f.accountId).items[0].nativeSticker.md5, md5(f.content));
});

test('a cached sticker collection queue yields to UI and chat events between entries', async t => {
  const f = fixture(t), events = [];
  const pending = Array.from({ length: 20 }, (_, index) => f.service.enqueue(f.accountId, 'queued-' + index, async () => { events.push('sticker'); }));
  await new Promise(resolve => setImmediate(() => { events.push('chat'); resolve(); }));
  await Promise.all(pending);
  assert(events.indexOf('chat') < 20); assert.equal(events.filter(event => event === 'sticker').length, 20);
});
test('favorite syncing keeps native-only references, hydrates originals and never restores a locally deleted sticker', async t => {
  const f = fixture(t), digest = md5(f.content);
  f.transport.readStickers = async () => ({ complete: true, items: [{ md5: digest, previewAvailable: true }] });
  const gate = Promise.withResolvers(); f.transport.readStickerContent = async () => { await gate.promise; return { stickerMd5: digest, data: f.content.toString('base64'), quality: 'original' }; };
  const sync = await f.service.sync(f.accountId); assert.equal(sync.imported, 1); assert.equal(f.library.list(f.accountId).items[0].bytes, 0);
  f.library.remove(f.accountId, [f.library.list(f.accountId).items[0].id]); gate.resolve(); await f.service.whenIdle();
  assert.equal(f.library.list(f.accountId).total, 0); assert.equal((await f.service.sync(f.accountId)).skipped, 1);
});
test('a stale background preview cannot restore a favorite removed in a later complete snapshot', async t => {
  const f = fixture(t), digest = md5(f.content), gate = Promise.withResolvers(); let listed = true;
  f.transport.readStickers = async () => ({ complete: true, items: listed ? [{ md5: digest, previewAvailable: true }] : [] });
  f.transport.readStickerContent = async () => { await gate.promise; return { stickerMd5: digest, data: f.content.toString('base64'), quality: 'original' }; };
  await f.service.sync(f.accountId); listed = false; await f.service.sync(f.accountId); gate.resolve(); await f.service.whenIdle();
  const asset = f.library.list(f.accountId).items[0]; assert.equal(asset.nativeSticker.favorite, false); assert.equal(asset.bytes, f.content.length);
});
for (const change of ['account', 'authorization', 'capture setting']) test(`changing ${change} during chat download prevents storing its late bytes`, async t => {
  const f = fixture(t), started = Promise.withResolvers(), gate = Promise.withResolvers();
  f.transport.media = async () => { started.resolve(); await gate.promise; return { data: f.content.toString('base64'), stickerMd5: md5(f.content) }; };
  const pending = f.service.capture(f.accountId, f.message); await started.promise;
  if (change === 'account') { f.status.account.id = 'another'; f.transport.emit('status'); }
  else if (change === 'authorization') f.store.configure(f.accountId, { enabled: true, groups: [], privatePeers: [], prompt: '' });
  else f.library.configure(f.accountId, { ...f.library.account(f.accountId).settings, captureIncoming: false });
  gate.resolve(); await pending; assert.equal(f.library.list(f.accountId).items[0].bytes, 0);
  assert.equal(f.library.list('another').total, 0);
});
test('incomplete favorites never replace a previously confirmed library', async t => {
  const f = fixture(t); f.library.saveWechatSticker(f.accountId, { md5: md5(f.content), source: 'favorite', favorite: true, content: f.content });
  f.transport.readStickers = async () => ({ complete: false, items: [] });
  await assert.rejects(() => f.service.sync(f.accountId), { code: 'STICKER_SYNC_INCOMPLETE' });
  assert.equal(f.library.list(f.accountId).counts.favorites, 1); assert.equal(f.service.view(f.accountId).state, 'unavailable');
});
test('background understanding saves actual image meaning and scenarios while preserving a manual description', async t => {
  const f = fixture(t); f.store.setModelConfig({ ...f.store.modelConfig(), vision: true });
  await f.service.capture(f.accountId, f.message); const asset = f.library.list(f.accountId).items[0];
  f.library.edit(f.accountId, asset.id, { description: '我手动填写的画面说明' });
  let calls = 0; f.channel.runner.describeStickers = async images => { calls++; assert.equal(images.length, 1); assert.equal(images[0].data, f.content.toString('base64'));
    return [{ name: '红色方块', description: '模型画面说明', usage: '用于讨论红色，不推断人物情绪。', tags: ['红色'] }]; };
  await f.service.describePending(f.accountId); await f.service.describePending(f.accountId);
  const saved = f.library.resolveAsset(f.accountId, asset.id);
  assert.equal(calls, 1); assert.equal(saved.description, '我手动填写的画面说明'); assert.match(saved.usage, /讨论红色/);
  assert.equal(new MediaLibrary(f.store).resolveAsset(f.accountId, asset.id).usage, saved.usage);
});

test('timed-out sticker understanding persists a retry delay without losing originals', async t => {
  const f = fixture(t); f.store.setModelConfig({ ...f.store.modelConfig(), vision: true }); await f.service.capture(f.accountId, f.message);
  const asset = f.library.list(f.accountId).items[0], describe = f.library.describe.bind(f.library); let calls = 0;
  f.library.describe = (id, ids, runner, signal, options) => describe(id, ids, runner, AbortSignal.any([signal, AbortSignal.timeout(15)]), options);
  f.channel.runner.describeStickers = async (_images, signal) => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); signal.throwIfAborted(); };
  await assert.rejects(() => f.service.describePending(f.accountId), { name: 'TimeoutError' });
  const saved = f.library.resolveAsset(f.accountId, asset.id);
  assert.match(saved.descriptionError, /超时/); assert(saved.descriptionAttemptedAt > 0); assert.equal(saved.bytes, f.content.length);
  await f.service.describePending(f.accountId); assert.equal(calls, 1);
  assert.equal(new MediaLibrary(f.store).resolveAsset(f.accountId, asset.id).descriptionAttemptedAt, saved.descriptionAttemptedAt);
});
for (const change of ['edit', 'delete', 'setting', 'account']) test(`late sticker understanding respects concurrent ${change}`, async t => {
  const f = fixture(t); f.store.setModelConfig({ ...f.store.modelConfig(), vision: true }); await f.service.capture(f.accountId, f.message);
  const asset = f.library.list(f.accountId).items[0], started = Promise.withResolvers(), gate = Promise.withResolvers();
  f.channel.runner.describeStickers = async () => { started.resolve(); await gate.promise; return [{ name: '方块', description: '迟到说明', usage: '迟到用法', tags: [] }]; };
  const pending = f.service.describePending(f.accountId).catch(() => {}); await started.promise;
  if (change === 'edit') f.library.edit(f.accountId, asset.id, { description: '最新手动说明', usage: '最新手动情景' });
  else if (change === 'delete') f.library.remove(f.accountId, [asset.id]);
  else if (change === 'setting') f.library.configure(f.accountId, { ...f.library.account(f.accountId).settings, autoDescribe: false });
  else { f.status.account.id = 'other'; f.transport.emit('status'); }
  gate.resolve(); await pending;
  assert(!JSON.stringify(f.library.list(f.accountId)).includes('迟到说明')); assert(!JSON.stringify(f.library.list(f.accountId)).includes('迟到用法'));
});
test('test-send uses only filehelper and persists a real ACK; an unknown result is never retried', async t => {
  const f = fixture(t); await f.service.capture(f.accountId, f.message); let sends = 0;
  f.transport.send = async args => { sends++; assert.equal(args.peerId, 'filehelper'); assert.equal(args.accountId, f.accountId);
    assert.equal(args.message[0].data.nativeSticker.md5, md5(f.content));
    return { delivery: 'server-ack', serverMessageIds: ['9007199254740999'], messageType: 47, deliveryParts: [{ type: 'face', state: 'acknowledged', serverMessageId: '9007199254740999' }] }; };
  assert.equal((await f.service.sendTest(f.accountId)).native, true); assert.equal(f.store.data.records.at(-1).state, 'sent');
  f.transport.send = async () => { sends++; return { delivery: 'server-ack', serverMessageIds: [] }; };
  await assert.rejects(() => f.service.sendTest(f.accountId), { code: 'SEND_UNKNOWN' });
  assert.equal(f.store.data.records.at(-1).state, 'unknown'); assert.equal(sends, 2);
  for (const deliveryParts of [{}, [null]]) {
    f.transport.send = async () => { sends++; return { delivery: 'server-ack', serverMessageIds: ['9007199254740999'], deliveryParts }; };
    await assert.rejects(() => f.service.sendTest(f.accountId), { code: 'SEND_UNKNOWN' });
    assert.equal(f.store.data.records.at(-1).state, 'unknown');
  }
  assert.equal(sends, 4);
});
test('owner collection marks favorites only after the worker explicitly confirms the saved entry', async t => {
  const f = fixture(t); await f.service.capture(f.accountId, f.message); const asset = f.library.list(f.accountId).items[0];
  f.transport.favoriteSticker = async () => ({ saved: false });
  await assert.rejects(() => f.service.favorite(f.accountId, asset.id), { code: 'STICKER_FAVORITE_UNKNOWN' });
  assert.equal(f.library.resolveAsset(f.accountId, asset.id).nativeSticker.favorite, false);
  f.transport.favoriteSticker = async () => ({ saved: true }); await f.service.favorite(f.accountId, asset.id);
  assert.equal(f.library.resolveAsset(f.accountId, asset.id).nativeSticker.favorite, true);
});
