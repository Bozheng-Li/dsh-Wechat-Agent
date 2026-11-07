import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuiltinStickerCatalog } from '../src/features/media/builtin-stickers.mjs';
import { MediaLibrary } from '../src/features/media/library.mjs';
import { inspectAssetImage } from '../src/features/media/image-format.mjs';

const temporary = fileURLToPath(new URL('../storage/tmp/', import.meta.url));
const source = fileURLToPath(new URL('../assets/stickers/', import.meta.url));
function fixture(t, options) {
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, 'builtin-stickers-'));
  const store = { root, data: { storeId: 'builtin-stickers-fixture' } }, library = new MediaLibrary(store, options), account = 'sticker-owner';
  t.after(() => { library.close(); const real = fs.realpathSync(root); assert.equal(path.dirname(real), fs.realpathSync(temporary)); assert.match(path.basename(real), /^builtin-stickers-/); fs.rmSync(real, { recursive: true, force: true }); });
  return { root, store, library, account };
}

test('three bundled packs provide 30 intact original PNGs, source attribution and offline previews without changing account settings', t => {
  const f = fixture(t), list = f.library.list(f.account), catalog = f.library.builtins;
  assert.equal(list.total, 0); assert.equal(list.packs.length, 3);
  assert.deepEqual(list.packs.map(pack => pack.total), [9, 10, 11]);
  assert(list.packs.every(pack => pack.builtin && !pack.enabled && !pack.installed));
  assert(!fs.existsSync(f.library.indexFile));
  assert.match(fs.readFileSync(catalog.localFile(catalog.source.licenseFile), 'utf8'), /Copyright \(c\) Microsoft Corporation/);
  assert.equal(catalog.source.license, 'MIT');
  for (const pack of catalog.packs) for (const item of pack.items) {
    const content = catalog.read(pack.id, item.id).content, info = inspectAssetImage(content);
    assert.equal(info.mediaType, 'image/png'); assert.equal(info.width, item.width); assert.equal(info.height, item.height);
    assert.equal(content.length, item.bytes); assert(item.description && item.tags.length);
    assert(item.sourceUrl.includes(catalog.source.revision));
    assert.deepEqual(Buffer.from(catalog.preview(pack.id, item.id).data, 'base64'), content);
  }
  assert.deepEqual(f.library.search(f.account), []);
  assert.throws(() => catalog.preview(catalog.packs[0].id, catalog.packs[1].items[0].id), { code: 'ASSET_NOT_FOUND' });
  assert.throws(() => catalog.preview('../../runtime', catalog.packs[0].items[0].id), { code: 'ASSET_PACK_NOT_FOUND' });
});

test('pack toggles preserve per-image edits, master settings and account isolation across restart', async t => {
  const f = fixture(t), [cats, animals] = f.library.builtins.packs;
  f.library.configure(f.account, { enabled: false, probability: 0, minGapMessages: 17 });
  assert.equal(f.library.configurePack(f.account, cats.id, true).imported, 9);
  assert.deepEqual(f.library.list(f.account).settings, { enabled: false, probability: 0, minGapMessages: 17 });
  assert.deepEqual(f.library.search(f.account), []);
  f.library.configure(f.account, { enabled: true, probability: 0, minGapMessages: 17 });
  f.library.configurePack(f.account, animals.id, true);
  const first = cats.items[0];
  f.library.edit(f.account, first.id, { enabled: false, name: '我喜欢的猫猫', description: '自己填写的问候方式' });
  f.library.configurePack(f.account, cats.id, false);
  const list = f.library.list(f.account, { packId: cats.id });
  assert.equal(list.total, 9); assert.equal(list.counts.enabled, 10);
  assert(list.items.every(asset => !asset.packEnabled && !asset.effectiveEnabled));
  assert(!f.library.search(f.account, '', { limit: 50 }).some(asset => asset.packId === cats.id));
  assert.throws(() => f.library.resolveAsset(f.account, cats.items[1].id), { code: 'ASSET_NOT_FOUND' });
  assert.equal(f.library.getContent(f.account, first.id, { enabledOnly: false }).name, '我喜欢的猫猫');
  const restored = new MediaLibrary(f.store);
  assert.equal(restored.packs(f.account).find(pack => pack.id === cats.id).enabled, false);
  assert.equal(restored.list('another-owner').total, 0); assert(restored.packs('another-owner').every(pack => !pack.enabled));
  assert.equal(restored.configurePack(f.account, cats.id, true).imported, 0);
  assert.equal(restored.list(f.account).counts.enabled, 18);
  assert.equal(restored.getContent(f.account, first.id, { enabledOnly: false }).description, '自己填写的问候方式');
  assert.throws(() => restored.resolveAsset(f.account, first.id), { code: 'ASSET_NOT_FOUND' });
  const ready = await restored.prepareSendContent(f.account, cats.items[1].id);
  assert.equal(ready.mediaType, 'image/png'); assert.deepEqual(Buffer.from(ready.data, 'base64'), restored.builtins.read(cats.id, cats.items[1].id).content);
  restored.remove(f.account, [cats.items[2].id]);
  const afterDelete = new MediaLibrary(f.store); assert.equal(afterDelete.list(f.account, { packId: cats.id }).total, 8);
  assert.equal(afterDelete.configurePack(f.account, cats.id, true).imported, 1);
  assert.equal(afterDelete.getContent(f.account, first.id, { enabledOnly: false }).enabled, false);
});

test('a failed enable commit rolls back new files and leaves the saved pack state unchanged', t => {
  const f = fixture(t), pack = f.library.builtins.packs[0];
  f.library.configure(f.account, { enabled: true, probability: 20, minGapMessages: 3 });
  const before = f.library.list(f.account), backup = f.library.indexFile + '.backup';
  fs.renameSync(f.library.indexFile, backup); fs.mkdirSync(f.library.indexFile);
  try {
    assert.throws(() => f.library.configurePack(f.account, pack.id, true), { code: 'STATE_WRITE_FAILED' });
    assert.deepEqual(f.library.list(f.account), before);
    assert.deepEqual(fs.readdirSync(f.library.folder(f.account)), []);
  } finally { fs.rmdirSync(f.library.indexFile); fs.renameSync(backup, f.library.indexFile); }
  assert.equal(new MediaLibrary(f.store).packs(f.account)[0].enabled, false);
});

test('corrupt or missing bundled content fails before installing any of the pack', t => {
  const f = fixture(t), copied = path.join(f.root, 'bundled-copy'); fs.cpSync(source, copied, { recursive: true });
  const catalog = new BuiltinStickerCatalog(copied), pack = catalog.packs[0], file = catalog.localFile(pack.items[2].file);
  const content = fs.readFileSync(file); content[40] ^= 1; fs.writeFileSync(file, content);
  const library = new MediaLibrary(f.store, { builtinCatalog: catalog });
  assert.throws(() => library.configurePack(f.account, pack.id, true), { code: 'ASSET_PACK_INVALID' });
  assert.equal(library.list(f.account).total, 0); assert(!fs.existsSync(library.indexFile));
  fs.unlinkSync(file);
  assert.throws(() => catalog.preview(pack.id, pack.items[2].id), { code: 'ASSET_PACK_INVALID' });
  assert.throws(() => library.configurePack(f.account, pack.id, true), { code: 'ASSET_PACK_INVALID' });
});

test('enabling a pack does not move or overwrite an identical previously imported image', t => {
  const f = fixture(t), pack = f.library.builtins.packs[0], item = pack.items[0];
  f.library.import(f.account, { name: '我的旧猫.png', kind: 'image', data: f.library.builtins.preview(pack.id, item.id).data });
  f.library.edit(f.account, item.id, { description: '已有图片的自定义说明', enabled: false });
  const result = f.library.configurePack(f.account, pack.id, true);
  assert.deepEqual([result.imported, result.duplicates], [8, 1]);
  const existing = f.library.resolveAsset(f.account, item.id, { enabledOnly: false });
  assert.equal(existing.packId, 'user-uploads'); assert.equal(existing.kind, 'image'); assert.equal(existing.name, '我的旧猫');
  assert.equal(existing.description, '已有图片的自定义说明'); assert.equal(existing.enabled, false);
});

test('legacy ungrouped images retain their settings and support a persistent imported-images switch', t => {
  const f = fixture(t), pack = f.library.builtins.packs[0], item = pack.items[0];
  f.library.import(f.account, { name: '旧版.png', kind: 'image', data: f.library.builtins.preview(pack.id, item.id).data });
  const legacy = JSON.parse(fs.readFileSync(f.library.indexFile, 'utf8'));
  delete legacy.accounts[f.account].packs; delete legacy.accounts[f.account].assets[0].packId;
  fs.writeFileSync(f.library.indexFile, JSON.stringify(legacy));
  const restored = new MediaLibrary(f.store);
  assert.equal(restored.search(f.account)[0].id, item.id);
  assert.equal(restored.packs(f.account).find(pack => !pack.builtin).name, '我导入的图片');
  restored.configurePack(f.account, 'user-uploads', false);
  assert.deepEqual(restored.search(f.account), []);
  assert.equal(restored.resolveAsset(f.account, item.id, { enabledOnly: false }).enabled, true);
  assert.deepEqual(new MediaLibrary(f.store).search(f.account), []);
});
