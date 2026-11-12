import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaLibrary } from '../modules/media/library.mjs';
import { prepareStickerImage } from '../modules/media/sticker-image.mjs';
import { stickerDigest as md5, stickerPng as png, stickerGif, stickerJpeg } from './fixtures/stickers.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sticker-library-'));
  const store = { root, data: { storeId: 'sticker-library-fixture' } }, library = new MediaLibrary(store, { pythonPath: path.join(root, 'missing-python.exe') }), account = 'sticker-owner';
  t.after(() => { library.close(); assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^wechat-sticker-library-/); fs.rmSync(root, { recursive: true, force: true }); });
  const save = (content = png(), extra = {}) => library.saveWechatSticker(account, { source: 'favorite', favorite: true, md5: md5(content), content, quality: 'original', ...extra });
  return { root, store, library, account, save };
}
test('an empty library contains no bundled artwork or network download packs', t => {
  const f = fixture(t), list = f.library.list(f.account);
  assert.equal(list.total, 0); assert.deepEqual(list.packs, []); assert(!fs.existsSync(f.library.indexFile));
  assert.equal(list.settings.captureIncoming, true); assert.equal(list.settings.preferNative, true);
});

test('native JPEG originals retain their WeChat identity while vision receives only clean image bytes', async t => {
  const f = fixture(t), { original, pixels } = stickerJpeg(), saved = f.save(original);
  assert.equal(f.library.getContent(f.account, saved.asset.id).data, original.toString('base64'));
  assert.equal(saved.asset.nativeSticker.md5, md5(original));
  assert.equal((await f.library.thumbnail(f.account, saved.asset.id)).data, pixels.toString('base64'));
  const segment = await f.library.prepareSendSegment(f.account, saved.asset.id);
  assert.equal(segment.data.nativeSticker.md5, md5(original)); assert.equal(segment.data.base64, pixels.toString('base64'));
  f.library.edit(f.account, saved.asset.id, { kind: 'image' });
  await f.library.describe(f.account, [saved.asset.id], { describeImages: async images => {
    assert.equal(images[0].data, pixels.toString('base64')); return ['clean picture'];
  } }, new AbortController().signal);
  assert.equal(f.library.getContent(f.account, saved.asset.id).data, original.toString('base64'));
});

test('native GIF and PNG trailers are archived intact without being mistaken for corrupt pictures', async t => {
  const f = fixture(t);
  for (const pixels of [png(), stickerGif]) {
    const original = Buffer.concat([pixels, Buffer.from('wechat-cdn-extra-metadata')]), saved = f.save(original);
    assert.equal(f.library.getContent(f.account, saved.asset.id).data, original.toString('base64'));
    assert.deepEqual(prepareStickerImage(original).content, pixels);
    const segment = await f.library.prepareSendSegment(f.account, saved.asset.id);
    assert.equal(segment.data.nativeSticker.md5, md5(original));
    if (saved.asset.mediaType === 'image/png') {
      assert.equal(segment.data.base64, pixels.toString('base64'));
      assert.equal((await f.library.thumbnail(f.account, saved.asset.id)).data, pixels.toString('base64'));
    }
  }
});

test('sticker stream validation follows GIF blocks and rejects truncated pixels and oversized trailers', () => {
  const comment = Buffer.from([0x21, 0xfe, 3, 0x61, 0x3b, 0x62, 0]);
  const pixels = Buffer.concat([stickerGif.subarray(0, 19), comment, stickerGif.subarray(19)]);
  assert.deepEqual(prepareStickerImage(Buffer.concat([pixels, Buffer.from('trailer')])).content, pixels);
  assert.throws(() => prepareStickerImage(stickerGif.subarray(0, -1)), { code: 'STICKER_IMAGE_INVALID' });
  assert.throws(() => prepareStickerImage(Buffer.concat([png(), Buffer.alloc(65537)])), { code: 'STICKER_IMAGE_INVALID' });
  const broken = png(); broken[broken.length - 1] ^= 1;
  assert.throws(() => prepareStickerImage(broken), { code: 'ASSET_IMAGE_INVALID' });
});
test('retirement removes only old bundled assets and groups, preserving manual uploads and their bytes', t => {
  const f = fixture(t), old = png(), own = png([0, 0, 255]);
  const oldId = f.library.import(f.account, { name: 'old.png', kind: 'sticker', data: old.toString('base64') }).assetIds[0];
  const ownId = f.library.import(f.account, { name: '自己的.png', kind: 'image', data: own.toString('base64') }).assetIds[0];
  f.library.edit(f.account, ownId, { enabled: false, description: '自己的含义' });
  f.library.mutate(data => { const record = data.accounts[f.account]; record.assets.find(asset => asset.id === oldId).packId = 'builtin-fluent-cats'; record.packs['builtin-fluent-cats'] = { name: '旧版猫咪', enabled: true }; });
  const oldFile = f.library.file(f.account, f.library.resolveAsset(f.account, oldId, { enabledOnly: false }));
  const restored = new MediaLibrary(f.store);
  assert.equal(restored.list(f.account).total, 1); assert.equal(restored.list(f.account).retiredBuiltinCount, 1); assert(!fs.existsSync(oldFile));
  assert.equal(restored.getContent(f.account, ownId, { enabledOnly: false }).data, own.toString('base64'));
  assert.equal(restored.resolveAsset(f.account, ownId, { enabledOnly: false }).enabled, false);
  assert.equal(restored.resolveAsset(f.account, ownId, { enabledOnly: false }).description, '自己的含义');
  assert(!restored.packs(f.account).some(pack => pack.id.startsWith('builtin-')));
  assert.equal(new MediaLibrary(f.store).list(f.account).retiredBuiltinCount, 1);
});
test('failed retirement commit leaves both old artwork and the original index intact', t => {
  const f = fixture(t), imported = f.library.import(f.account, { name: 'old.png', kind: 'sticker', data: png().toString('base64') }).assetIds[0];
  f.library.mutate(data => { data.accounts[f.account].assets[0].packId = 'builtin-fluent-moods'; });
  const original = fs.readFileSync(f.library.indexFile), file = f.library.file(f.account, f.library.account(f.account).assets[0]);
  const update = f.store.config.update; f.store.config.update = () => { throw new Error('fixture write failed'); };
  assert.throws(() => new MediaLibrary(f.store), /fixture write failed/); f.store.config.update = update;
  assert.deepEqual(fs.readFileSync(f.library.indexFile), original); assert(fs.existsSync(file)); assert.equal(f.library.account(f.account).assets[0].id, imported);
});
test('native metadata survives missing previews and later receives original bytes under the same asset ID', async t => {
  const f = fixture(t), content = png();
  const first = f.save(undefined, { md5: md5(content), content: undefined }).asset;
  assert.equal(first.bytes, 0); assert.equal(first.mediaType, null);
  assert.throws(() => f.library.getContent(f.account, first.id), { code: 'STICKER_PREVIEW_UNAVAILABLE' });
  assert.deepEqual((await f.library.prepareSendSegment(f.account, first.id)).data, { nativeSticker: { md5: md5(content) } });
  const upgraded = f.save(content).asset;
  assert.equal(upgraded.id, first.id); assert.equal(upgraded.bytes, content.length);
  assert.equal(f.library.getContent(f.account, first.id).data, content.toString('base64'));
  assert.equal(new MediaLibrary(f.store).getContent(f.account, first.id).data, content.toString('base64'));
  assert.throws(() => f.library.getContent('another-account', first.id), { code: 'ASSET_NOT_FOUND' });
});
test('chat collection and favorites deduplicate without overwriting owner descriptions, disabled state or custom names', t => {
  const f = fixture(t), content = png(), message = { peerId: 'group@chatroom', chatType: 'group', serverMessageId: '100', observedAt: Date.now() };
  const first = f.save(content, { source: 'chat', favorite: false, message }).asset;
  f.library.edit(f.account, first.id, { name: '自己的叫法', description: '自己编辑的用法', enabled: false });
  const added = f.save(content).asset;
  assert.equal(f.library.list(f.account).total, 1); assert.equal(added.nativeSticker.favorite, true);
  assert.equal(added.name, '自己的叫法'); assert.equal(added.description, '自己编辑的用法'); assert.equal(added.enabled, false);
  const uploaded = f.library.import(f.account, { name: '重复.png', data: content.toString('base64'), kind: 'image' });
  assert.equal(uploaded.imported, 0); assert.deepEqual(uploaded.duplicateIds, [first.id]);
  assert.equal(f.library.list(f.account, { source: 'favorite' }).total, 1); assert.equal(f.library.list(f.account, { source: 'chat' }).total, 1);
});
test('two distinct native animations sharing a thumbnail retain distinct references', t => {
  const f = fixture(t), content = png();
  f.save(content, { md5: 'a'.repeat(32), quality: 'thumbnail' });
  f.save(content, { md5: 'b'.repeat(32), quality: 'thumbnail' });
  assert.equal(f.library.list(f.account).total, 2);
  const [a, b] = f.library.list(f.account).items; f.library.remove(f.account, [a.id]);
  assert.equal(f.library.getContent(f.account, b.id).data, content.toString('base64'));
});
test('deleting a collected sticker persists a tombstone and cannot be reversed by automatic resync', t => {
  const f = fixture(t), content = png(), first = f.save(content).asset;
  f.library.remove(f.account, [first.id]);
  assert.equal(f.save(content).deleted, true); assert.equal(f.library.list(f.account).total, 0);
  const reopened = new MediaLibrary(f.store); assert.equal(reopened.saveWechatSticker(f.account, { md5: md5(content), source: 'favorite', favorite: true }).deleted, true);
  assert.equal(reopened.list(f.account).total, 0);
});
test('native GIF references work without a converter and never alter the animated source', async t => {
  const f = fixture(t), asset = f.save(stickerGif).asset;
  const segment = await f.library.prepareSendSegment(f.account, asset.id);
  assert.equal(segment.type, 'face'); assert.deepEqual(segment.data.nativeSticker, { md5: md5(stickerGif) }); assert.equal(segment.data.base64, undefined);
  assert.equal(f.library.getContent(f.account, asset.id).data, stickerGif.toString('base64'));
  f.library.configure(f.account, { ...f.library.account(f.account).settings, preferNative: false });
  await assert.rejects(f.library.prepareSendSegment(f.account, asset.id), { code: 'ASSET_CONVERTER_MISSING' });
});
test('native PNG prepares an exact fallback while settings, deletion and corrupt files still prevent sending', async t => {
  const f = fixture(t), content = png(), asset = f.save(content).asset;
  const segment = await f.library.prepareSendSegment(f.account, asset.id);
  assert.equal(segment.data.base64, content.toString('base64')); assert.equal(segment.data.nativeSticker.md5, md5(content));
  f.library.edit(f.account, asset.id, { enabled: false }); await assert.rejects(f.library.prepareSendSegment(f.account, asset.id), { code: 'ASSET_NOT_FOUND' });
  f.library.edit(f.account, asset.id, { enabled: true });
  const changed = Buffer.from(content); changed[40] ^= 1; fs.writeFileSync(f.library.file(f.account, asset), changed);
  await assert.rejects(f.library.prepareSendSegment(f.account, asset.id), { code: 'ASSET_CONTENT_INVALID' });
});
test('random selection prioritizes current favorites, avoids the last send and obeys account and group switches', t => {
  const f = fixture(t), one = f.save(png()).asset, two = f.save(png([0, 255, 0])).asset;
  f.save(png([0, 0, 255]), { source: 'chat', favorite: false });
  assert.equal(f.library.randomSticker(f.account, { random: () => 0, excludeIds: [one.id] }).id, two.id);
  assert.equal(f.library.randomSticker('other'), null);
  f.library.configurePack(f.account, 'wechat-favorites', false);
  assert.equal(f.library.randomSticker(f.account, { random: () => 0 }).nativeSticker.favorite, false);
  f.library.configure(f.account, { ...f.library.account(f.account).settings, enabled: false }); assert.equal(f.library.randomSticker(f.account), null);
});
test('a complete favorite refresh clears removed remote favorites without deleting their local originals', t => {
  const f = fixture(t), content = png(), asset = f.save(content).asset;
  f.library.reconcileFavorites(f.account, [], Date.now());
  assert.equal(f.library.resolveAsset(f.account, asset.id).nativeSticker.favorite, false);
  assert.equal(f.library.list(f.account, { source: 'favorite' }).total, 0);
  assert.equal(f.library.getContent(f.account, asset.id).data, content.toString('base64'));
});
