import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { MediaLibrary } from "../modules/media/library.mjs";
import { MEDIA_LIBRARY_LIMITS } from "../modules/media/limits.mjs";
import { readAssetZip } from "../modules/media/zip.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const crc32 = data => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
function png(rgb = [255, 0, 0]) {
  const chunk = (kind, data) => { const name = Buffer.from(kind), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, ...rgb, ...rgb, 0, ...rgb, ...rgb]))), chunk('IEND', Buffer.alloc(0))]);
}
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function zip(items) {
  const locals = [], central = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8'), data = item.data || Buffer.alloc(0), method = item.method ?? 8, compressed = method === 0 ? data : deflateRawSync(data), size = item.declaredSize ?? data.length, checksum = item.crc ?? crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(item.attributes ?? (0x81a4 * 65536), 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(directory, name); offset += local.length + name.length + compressed.length;
  }
  const listing = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(listing.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, listing, end]);
}
function fixture(t) {
  fs.mkdirSync(workspace, { recursive: true }); const root = fs.mkdtempSync(path.join(workspace, 'asset-library-'));
  const store = { root, data: { storeId: 'asset-library-fixture' } }, library = new MediaLibrary(store), owner = 'fixture-alice';
  t.after(() => { library.close(); const real = fs.realpathSync(root), relative = path.relative(workspace, real); assert(relative.startsWith('asset-library-') && !relative.includes('..')); fs.rmSync(real, { recursive: true, force: true }); });
  return { root, store, library, owner, import: (data = png(), name = '开心.png', kind = 'sticker') => library.import(owner, { name, kind, data: data.toString('base64') }) };
}

test('ZIP imports keep original images, account isolation, deduplication and descriptive metadata after restart', t => {
  const f = fixture(t), data = zip([{ name: '开心/猫咪.png', data: png() }, { name: '开心/又一张猫.png', data: png() }, { name: '动图.gif', data: gif }, { name: '说明.txt', data: Buffer.from('不是图片') }]);
  const result = f.import(data, '我的表情.zip'); assert.deepEqual([result.imported, result.duplicates, result.skipped], [2, 1, 1]);
  const first = f.library.list(f.owner).items.find(asset => asset.mediaType === 'image/png');
  assert.deepEqual(first.tags, ['开心']); assert.equal(first.name, '猫咪'); assert.equal(first.kind, 'sticker');
  f.library.edit(f.owner, first.id, { description: '开心时用的红色方块', tags: ['开心', '赞同'], revision: first.revision });
  assert.equal(f.library.search(f.owner, '赞同')[0].id, first.id);
  assert.deepEqual(Buffer.from(f.library.getContent(f.owner, first.id).data, 'base64'), png());
  assert.equal(f.library.list('another-account').total, 0);
  assert.throws(() => f.library.getContent('another-account', first.id), { code: 'ASSET_NOT_FOUND' });
  const restored = new MediaLibrary(f.store); assert.equal(restored.search(f.owner, '红色')[0].id, first.id);
  const animation = restored.list(f.owner).items.find(asset => asset.mediaType === 'image/gif');
  assert.deepEqual(Buffer.from(restored.getContent(f.owner, animation.id).data, 'base64'), gif);
  assert.equal(f.import(data, '重复.zip').duplicates, 3);
});

test('ZIP groups can be disabled independently and later same-name imports keep the saved group switch', t => {
  const f = fixture(t);
  f.import(zip([{ name: '点头.png', data: png() }]), '可爱猫猫.zip');
  const group = f.library.packs(f.owner).find(pack => pack.name === '可爱猫猫');
  assert(group?.enabled); f.library.configurePack(f.owner, group.id, false);
  f.import(zip([{ name: '微笑.png', data: png([0, 255, 0]) }]), '可爱猫猫.zip');
  f.import(zip([{ name: '企鹅.png', data: png([0, 0, 255]) }]), '小企鹅.zip');
  const members = f.library.list(f.owner, { packId: group.id });
  assert.equal(members.total, 2); assert(members.items.every(item => item.enabled && !item.effectiveEnabled));
  assert.equal(f.library.search(f.owner).length, 1); assert.equal(f.library.search(f.owner)[0].name, '企鹅');
  const restored = new MediaLibrary(f.store); assert.equal(restored.packs(f.owner).find(pack => pack.id === group.id).enabled, false);
  restored.configurePack(f.owner, group.id, true); assert.equal(restored.search(f.owner).length, 3);
});

test('ZIP rejects traversal, symlinks, executables, corrupt CRC and inflated data before publishing any asset', t => {
  const f = fixture(t);
  for (const bad of [
    { name: '../escaped.png', data: png() }, { name: 'C:/escaped.png', data: png() },
    { name: 'link.png', data: png(), attributes: 0xa1ff * 65536 },
    { name: 'payload.js', data: Buffer.from('never execute') },
    { name: 'bad.png', data: png(), crc: 10 },
    { name: 'bomb.png', data: Buffer.alloc(2 * 1024 * 1024, 7), declaredSize: 16 },
    { name: 'huge.png', data: png(), declaredSize: MEDIA_LIBRARY_LIMITS.expandedBytes + 1 },
  ]) {
    assert.throws(() => f.import(zip([{ name: 'normal.png', data: png() }, bad]), 'invalid.zip'), undefined, bad.name);
    assert.equal(f.library.list(f.owner).total, 0);
  }
  assert(!fs.existsSync(path.join(f.root, 'escaped.png')));
  const invalid = png(); invalid[invalid.length - 5] ^= 1;
  assert.throws(() => f.import(invalid), { code: 'ASSET_IMAGE_INVALID' });
  assert.throws(() => readAssetZip(Buffer.from('not a zip')), { code: 'ASSET_ZIP_INVALID' });
});

test('chunked uploads are account-bound, ordered, retryable and commit exactly once', t => {
  const f = fixture(t), source = png(), upload = f.library.beginUpload(f.owner, { name: '上传.png', kind: 'image', size: source.length });
  const first = source.subarray(0, 20).toString('base64');
  assert.throws(() => f.library.appendUpload('other', upload.uploadId, { offset: 0, data: first }), { code: 'ASSET_UPLOAD_MISSING' });
  assert.throws(() => f.library.appendUpload(f.owner, upload.uploadId, { offset: 1, data: first }), { code: 'ASSET_UPLOAD_INVALID' });
  assert.equal(f.library.appendUpload(f.owner, upload.uploadId, { offset: 0, data: first }).received, 20);
  assert.equal(f.library.appendUpload(f.owner, upload.uploadId, { offset: 0, data: first }).received, 20);
  assert.throws(() => f.library.appendUpload(f.owner, upload.uploadId, { offset: 0, data: Buffer.alloc(20, 1).toString('base64') }), { code: 'ASSET_UPLOAD_INVALID' });
  assert.throws(() => f.library.finishUpload(f.owner, upload.uploadId), { code: 'ASSET_UPLOAD_INCOMPLETE' });
  f.library.appendUpload(f.owner, upload.uploadId, { offset: 20, data: source.subarray(20).toString('base64') });
  const result = f.library.finishUpload(f.owner, upload.uploadId);
  assert.equal(result.imported, 1); assert.deepEqual(f.library.finishUpload(f.owner, upload.uploadId), result); assert.equal(f.library.list(f.owner).total, 1);
  const next = f.library.beginUpload(f.owner, { name: '取消.png', kind: 'sticker', size: source.length });
  f.library.abortUpload(f.owner, next.uploadId); assert.equal(f.library.uploads.size, 0);
});

test('large canonical base64 and 256 KiB upload chunks import without regular-expression stack exhaustion', t => {
  const f = fixture(t), data = zip([{ name: '大包中的图片.png', data: png() }, { name: '说明.txt', data: Buffer.alloc(1024 * 1024, 42), method: 0 }]);
  assert(data.length > 1024 * 1024); assert.equal(f.import(data, '大包.zip').imported, 1);
  const upload = f.library.beginUpload(f.owner, { name: '再次上传.zip', kind: 'sticker', size: data.length });
  for (let offset = 0; offset < data.length; offset += upload.chunkBytes) f.library.appendUpload(f.owner, upload.uploadId, { offset, data: data.subarray(offset, offset + upload.chunkBytes).toString('base64') });
  assert.equal(f.library.finishUpload(f.owner, upload.uploadId).duplicates, 1);
});

test('disabled assets cannot be selected for replies but remain previewable by the owner; file replacement is detected', t => {
  const f = fixture(t), result = f.import(), id = result.assetIds[0];
  f.library.edit(f.owner, id, { enabled: false });
  assert.equal(f.library.search(f.owner).length, 0); assert.throws(() => f.library.getContent(f.owner, id), { code: 'ASSET_NOT_FOUND' });
  assert(f.library.getContent(f.owner, id, { enabledOnly: false }).data);
  f.library.edit(f.owner, id, { enabled: true }); f.library.configure(f.owner, { enabled: false, probability: 0, minGapMessages: 100 });
  assert.equal(f.library.search(f.owner).length, 0); assert.throws(() => f.library.resolveAsset(f.owner, id), { code: 'ASSET_NOT_FOUND' });
  f.library.configure(f.owner, { enabled: true, probability: 20, minGapMessages: 3 });
  const asset = f.library.resolveAsset(f.owner, id); const changed = png(); changed[35] ^= 1; fs.writeFileSync(f.library.file(f.owner, asset), changed);
  assert.throws(() => f.library.getContent(f.owner, id), { code: 'ASSET_CONTENT_INVALID' });
});

test('failed index commit publishes no new images and does not replace existing metadata', t => {
  const f = fixture(t); f.import();
  const before = f.library.list(f.owner), saved = f.library.indexFile + '.previous'; fs.renameSync(f.library.indexFile, saved); fs.mkdirSync(f.library.indexFile);
  assert.throws(() => f.import(png([0, 255, 0]), '第二张.png'), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual(f.library.list(f.owner), before);
  assert.equal(fs.readdirSync(f.library.folder(f.owner)).length, 1);
  fs.rmdirSync(f.library.indexFile); fs.renameSync(saved, f.library.indexFile);
});

test('batch understanding persists errors and retries while preserving concurrent manual edits and deletions', async t => {
  const f = fixture(t), first = f.import(png(), '测试图片.png', 'image').assetIds[0], second = f.import(gif, '测试动图.gif', 'image').assetIds[0];
  const reached = Promise.withResolvers(), gate = Promise.withResolvers();
  const pending = f.library.describe(f.owner, [first, second], { describeImages: async images => { assert.equal(images.length, 2); reached.resolve(); await gate.promise; return ['模型写的第一张', '模型写的第二张']; } }, new AbortController().signal);
  await reached.promise; assert(f.library.list(f.owner).progress.running);
  f.library.edit(f.owner, first, { description: '用户亲自写的适用场景' }); f.library.remove(f.owner, [second]); gate.resolve();
  const result = await pending; assert.equal(result.skipped, 2); assert.equal(f.library.resolveAsset(f.owner, first).description, '用户亲自写的适用场景'); assert.equal(f.library.list(f.owner).total, 1);
  f.library.edit(f.owner, first, { description: '' });
  const failure = await f.library.describe(f.owner, [first], { describeImages: async () => { throw new Error('private provider token should not escape'); } }, new AbortController().signal);
  assert.equal(failure.failed, 1); assert(!f.library.resolveAsset(f.owner, first).descriptionError.includes('token'));
  const retried = await f.library.describe(f.owner, [first], { describeImages: async () => ['红色方块，可以表达赞同。'] }, new AbortController().signal);
  assert.equal(retried.succeeded, 1); assert.equal(f.library.resolveAsset(f.owner, first).descriptionError, null);
  assert(new MediaLibrary(f.store).search(f.owner, '赞同').length === 1);
});

test('explicit mixed asset analysis skips stickers before decoding or calling the model and reports them honestly', async t => {
  const f = fixture(t), sticker = f.import().assetIds[0], photo = f.import(png([0, 0, 255]), '普通图片.png', 'image').assetIds[0];
  let calls = 0;
  const result = await f.library.describe(f.owner, [sticker, photo], { describeImages: async images => { calls++; assert.equal(images.length, 1); return ['蓝色方块。']; } }, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result.skippedStickers, 1); assert.equal(result.succeeded, 1); assert.equal(result.completed, 2);
  assert.equal(f.library.resolveAsset(f.owner, sticker).description, '');
  const skipped = await f.library.describe(f.owner, [sticker], {}, new AbortController().signal);
  assert.equal(skipped.skippedStickers, 1); assert.equal(skipped.failed, 0); assert.equal(calls, 1);
});

test('cancelled model analysis does not overwrite assets or claim unfinished work succeeded', async t => {
  const f = fixture(t), id = f.import(png(), '测试图片.png', 'image').assetIds[0], controller = new AbortController(), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  const pending = f.library.describe(f.owner, [id], { describeImages: async () => { reached.resolve(); await gate.promise; return ['不应保存的迟到结果']; } }, controller.signal);
  await reached.promise; controller.abort(); gate.resolve(); await assert.rejects(pending);
  const after = f.library.list(f.owner); assert.equal(after.items[0].description, ''); assert.equal(after.progress.running, false); assert.equal(after.progress.succeeded, 0);
});

test('analysis progress counts only captions actually committed to storage', async t => {
  const f = fixture(t), id = f.import(png(), '测试图片.png', 'image').assetIds[0], saved = f.library.indexFile + '.previous';
  fs.renameSync(f.library.indexFile, saved); fs.mkdirSync(f.library.indexFile);
  await assert.rejects(f.library.describe(f.owner, [id], { describeImages: async () => ['没有保存成功的说明'] }, new AbortController().signal), { code: 'STATE_WRITE_FAILED' });
  const result = f.library.list(f.owner); assert.equal(result.items[0].description, ''); assert.equal(result.progress.succeeded, 0); assert.equal(result.progress.completed, 0);
  fs.rmdirSync(f.library.indexFile); fs.renameSync(saved, f.library.indexFile);
});
