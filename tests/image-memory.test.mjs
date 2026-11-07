import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { StateStore, ConversationMemory, ImageMemory, imageMemoryTool, inspectAssetImage,
  WechatChannel, createPluginService, rpcHandler, migrateWorkspaceRoot, ChannelError } from '../lib/testing.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 'base64');
const image = (quality = 'original') => ({ data: png.toString('base64'), mediaType: 'image/png', quality, bytes: png.length });
const entry = (label = 'menu') => ({ key: label, messageId: 'message-' + label, senderId: 'alice', senderName: '阿禾', text: '[图片] ' + label, direction: 'incoming', time: 1794024000000,
  attachments: [{ type: 'image', resourceId: 'resource-' + label, description: '菜单截图：番茄面 18 元。' }] });
const signal = () => new AbortController().signal;
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), container = fs.mkdtempSync(path.join(parent, 'wechat-image-memory-'));
  const root = path.join(container, 'data'), store = new StateStore(root);
  const scope = { accountId: 'image-owner', chatType: 'group', peerId: 'images-a@chatroom' };
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId, 'images-b@chatroom'], privatePeers: ['alice'], prompt: '' });
  store.configure('other-image-owner', { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  let now = 1794024000000;
  const images = new ImageMemory(store, { now: () => now, thumbnailMaker: async () => png });
  t.after(() => {
    const resolved = fs.realpathSync(container); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^wechat-image-memory-/);
    assert(!fs.lstatSync(resolved).isSymbolicLink()); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { container, root, store, scope, images, tick: amount => { now += amount; }, capture: async (scopeOverride = scope, source = entry(), pixels = image()) => images.capture(scopeOverride, source, source.attachments[0], pixels, signal()) };
}

test('originals and real image previews survive restart independently of cache, and identical captures deduplicate', async t => {
  const f = fixture(t), saved = await f.capture();
  assert.equal(saved.quality, 'original'); assert(saved.hasThumbnail);
  assert.deepEqual(Buffer.from(f.images.content(f.scope, saved.id).data, 'base64'), png);
  assert.deepEqual(Buffer.from(f.images.content(f.scope, saved.id, { preview: true }).data, 'base64'), png);
  const restored = new ImageMemory(new StateStore(f.root));
  assert.equal(restored.list(f.scope, { query: '菜单' }).total, 1);
  assert.equal(restored.list(f.scope, { query: '阿禾' }).total, 1);
  assert.equal(restored.list(f.scope, { query: '不存在的词' }).total, 0);
  const before = fs.readdirSync(f.images.directory(f.images.selector(f.scope)));
  await f.capture(); assert.equal(f.images.list(f.scope).storedCount, 1);
  assert.deepEqual(fs.readdirSync(f.images.directory(f.images.selector(f.scope))), before);
});

test('the same source identifiers in other groups, private chats and accounts never expose each other pixels', async t => {
  const f = fixture(t), saved = await f.capture();
  for (const other of [{ ...f.scope, peerId: 'images-b@chatroom' }, { ...f.scope, chatType: 'private', peerId: 'alice' }, { ...f.scope, accountId: 'other-image-owner' }]) {
    assert.equal(f.images.list(other).storedCount, 0);
    assert.throws(() => f.images.content(other, saved.id), { code: 'IMAGE_MEMORY_UNAVAILABLE' });
    assert.throws(() => f.images.remove(other, [saved.id]), { code: 'IMAGE_MEMORY_UNAVAILABLE' });
    assert.notEqual((await f.capture(other)).id, saved.id);
  }
  assert.equal(f.images.list(f.scope).storedCount, 1);
  assert.throws(() => f.images.content(f.scope, '../index.json'), { code: 'IMAGE_MEMORY_UNAVAILABLE' });
});

test('text compaction and clearing preserve independently saved pictures and their searchable description', async t => {
  const f = fixture(t), memory = new ConversationMemory(f.store);
  memory.images.thumbnailMaker = async () => png;
  const source = entry(); delete source.attachments[0].description; source.text += '长背景资料。'.repeat(400);
  memory.append(f.scope, source);
  await memory.enrich(f.scope, { describeImage: async () => '菜单截图：番茄面 18 元。' }, { media: async () => image() }, signal(), { imageRequest: { key: source.key, resourceId: source.attachments[0].resourceId } });
  const saved = memory.images.list(f.scope).items[0]; assert(saved);
  memory.setWindowChars(1000);
  await memory.compact(f.scope, { summarize: async () => '讨论了菜单与背景。' }, signal());
  assert.equal(memory.images.list(f.scope, { query: '番茄面' }).total, 1);
  memory.clear(f.scope);
  assert.equal(memory.view(f.scope).entries.length, 0);
  assert.equal(memory.images.content(f.scope, saved.id).data, png.toString('base64'));
});

test('pictures still save when vision is disabled or the model fails, and no missing bytes are called saved', async t => {
  const f = fixture(t), memory = new ConversationMemory(f.store); memory.images.thumbnailMaker = async () => png;
  const source = entry('disabled'); delete source.attachments[0].description; memory.append(f.scope, source);
  f.store.setModelConfig({ ...f.store.modelConfig(), vision: false });
  await memory.enrich(f.scope, { describeImage: () => assert.fail('disabled vision must not call a model') }, { media: async () => image() }, signal());
  assert.equal(memory.images.list(f.scope).storedCount, 1); assert.equal(memory.images.list(f.scope).items[0].description, '');
  f.store.setModelConfig({ ...f.store.modelConfig(), vision: true });
  await memory.enrich(f.scope, { describeImage: async () => { throw new ChannelError('MODEL_INCOMPLETE', '传输失败'); } }, { media: async () => image() }, signal(), { imageRequest: { key: source.key, resourceId: source.attachments[0].resourceId } });
  assert.equal(memory.view(f.scope).failedImages, 1); assert.equal(memory.images.list(f.scope).storedCount, 1);
  await assert.rejects(f.images.capture(f.scope, entry('missing'), entry('missing').attachments[0], { quality: 'original' }, signal()), { code: 'IMAGE_MEMORY_INVALID' });
  assert.equal(f.images.list(f.scope).storedCount, 1);
});

test('failed thumbnail generation preserves the original, and lower quality cannot replace an original', async t => {
  const f = fixture(t); f.images.thumbnailMaker = async () => { throw new Error('PRIVATE_COMPONENT_TRACE'); };
  const saved = await f.capture(); assert(saved.thumbnailError); assert(!saved.thumbnailError.includes('PRIVATE_COMPONENT_TRACE'));
  assert.equal(f.images.content(f.scope, saved.id).data, png.toString('base64'));
  assert.throws(() => f.images.content(f.scope, saved.id, { preview: true }), { code: 'IMAGE_THUMBNAIL_UNAVAILABLE' });
  await f.capture(f.scope, entry(), image('thumbnail'));
  assert.equal(f.images.list(f.scope).items[0].quality, 'original');
});

test('deletion removes only scoped files and durable tombstones prevent retries or imports from resurrecting them', async t => {
  const f = fixture(t), saved = await f.capture(), other = { ...f.scope, peerId: 'images-b@chatroom' };
  const otherSaved = await f.capture(other);
  f.images.remove(f.scope, [saved.id]); assert.equal(f.images.list(f.scope).storedCount, 0);
  assert.equal(fs.readdirSync(f.images.directory(f.images.selector(f.scope))).filter(name => name.endsWith('.image') || name.endsWith('.png')).length, 0);
  assert.equal(f.images.content(other, otherSaved.id).data, png.toString('base64'));
  assert.equal(await f.capture(), null);
  const restored = new ImageMemory(new StateStore(f.root));
  const result = await restored.importExisting(f.scope, [entry()], { media: () => assert.fail('deleted sources must not fetch') }, signal());
  assert.equal(result.saved, 0); assert.equal(result.skipped, 1);
});

test('expiry removes pixels and previews, and cannot be undone by changing retention back to forever', async t => {
  const f = fixture(t), saved = await f.capture(); f.images.configure(f.scope, { enabled: true, retentionDays: 1 });
  f.tick(86400000); assert.equal(f.images.list(f.scope).storedCount, 0);
  assert.throws(() => f.images.content(f.scope, saved.id), { code: 'IMAGE_MEMORY_UNAVAILABLE' });
  f.images.configure(f.scope, { enabled: true, retentionDays: null }); assert.equal(await f.capture(), null);
  assert.equal(fs.readdirSync(f.images.directory(f.images.selector(f.scope))).filter(name => name.endsWith('.image') || name.endsWith('.png')).length, 0);
});

test('background expiry removes files without opening the image library, including when saving is disabled', async t => {
  const f = fixture(t), saved = await f.capture();
  f.images.configure(f.scope, { enabled: false, retentionDays: 1 });
  const directory = f.images.directory(f.images.selector(f.scope));
  f.images.start({ intervalMs: 10 }); t.after(() => f.images.close());
  assert(f.images.timer); assert.equal(f.images.timer.hasRef(), false);
  f.tick(86400000);
  const deadline = Date.now() + 2000;
  while (fs.readdirSync(directory).some(name => name.endsWith('.image') || name.endsWith('.png'))) {
    assert(Date.now() < deadline, 'background cleanup must run without a list or content request');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
  assert.equal(index.items[saved.id], undefined); assert.equal(index.deleted[saved.id].reason, 'expired');
  f.images.close(); assert.equal(f.images.timer, null);
});

test('startup cleans overdue files from all owned accounts and keeps another conversation with an invalid index', async t => {
  const f = fixture(t), saved = await f.capture(), other = { ...f.scope, accountId: 'other-image-owner' };
  const otherSaved = await f.capture(other);
  f.images.configure(f.scope, { enabled: true, retentionDays: 1 });
  f.images.configure(other, { enabled: true, retentionDays: 1 });
  const bad = { ...f.scope, peerId: 'images-b@chatroom' }, badSaved = await f.capture(bad);
  const badDirectory = f.images.directory(f.images.selector(bad));
  fs.writeFileSync(path.join(badDirectory, 'index.json'), '{broken'); f.tick(86400000);
  const restored = new ImageMemory(new StateStore(f.root), { now: () => entry().time + 86400000 });
  restored.start(); t.after(() => restored.close());
  for (const [scope, id] of [[f.scope, saved.id], [other, otherSaved.id]]) {
    const directory = restored.directory(restored.selector(scope));
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.image') || name.endsWith('.png')).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8')).deleted[id].reason, 'expired');
  }
  assert(restored.errors.get(restored.selector(bad).key));
  assert(fs.existsSync(f.images.file(f.images.selector(bad), badSaved.id, false, badSaved.digest)), 'a damaged index must not delete its original');
});

test('periodic cleanup retries an expired file after a filesystem failure while its tombstone remains authoritative', async t => {
  const f = fixture(t), saved = await f.capture(); f.images.configure(f.scope, { enabled: true, retentionDays: 1 });
  const directory = f.images.directory(f.images.selector(f.scope)), original = f.images.file(f.images.selector(f.scope), saved.id, false, saved.digest);
  const unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = file => { if (file === original) { const error = new Error('private filesystem details'); error.code = 'EPERM'; throw error; } return unlink(file); };
    f.tick(86400000); f.images.sweep();
    assert(fs.existsSync(original)); assert(f.images.errors.get(f.images.selector(f.scope).key));
    assert.equal(await f.capture(), null, 'cleanup failures must not restore expired sources');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8')).deleted[saved.id].reason, 'expired');
  } finally { fs.unlinkSync = unlink; }
  f.images.sweep(); assert(!fs.existsSync(original));
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.image') || name.endsWith('.png')).length, 0);
  assert.equal(f.images.errors.get(f.images.selector(f.scope).key), undefined);
});

test('clear cancels late thumbnail writes and also tombstones existing sources not acquired yet', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), started = Promise.withResolvers();
  f.images.thumbnailMaker = async () => { started.resolve(); return gate.promise; };
  const pending = f.capture(); await started.promise;
  f.images.clear(f.scope, [entry(), entry('not-acquired')]); gate.resolve(png);
  assert.equal(await pending, null); assert.equal(f.images.list(f.scope).storedCount, 0);
  assert.equal(await f.capture(f.scope, entry('not-acquired')), null);
});

test('clear during a media download cannot publish its late result', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), started = Promise.withResolvers();
  const pending = f.images.importExisting(f.scope, [entry()], { media: async () => { started.resolve(); return gate.promise; } }, signal());
  await started.promise; f.images.clear(f.scope, [entry()]); gate.resolve(image());
  assert.equal((await pending).saved, 0); assert.equal(f.images.list(f.scope).storedCount, 0);
});

test('modified pixel bytes or a foreign owner index cannot be used as the old saved image', async t => {
  const f = fixture(t), saved = await f.capture(), state = f.images.load(f.scope);
  fs.writeFileSync(f.images.file(state, saved.id), Buffer.from('changed'));
  assert.throws(() => f.images.content(f.scope, saved.id), { code: 'IMAGE_MEMORY_CHANGED' });
  const index = path.join(f.images.directory(state), 'index.json'); state.ownerStoreId = 'other-store'; fs.writeFileSync(index, JSON.stringify(state));
  assert.throws(() => f.images.list(f.scope), { code: 'IMAGE_MEMORY_INVALID' });
});

test('an index write failure while upgrading quality keeps the previous stored version readable', async t => {
  const f = fixture(t), saved = await f.capture(f.scope, entry(), image('thumbnail'));
  const originalSave = f.images.save.bind(f.images);
  f.images.save = () => { throw new ChannelError('STATE_WRITE_FAILED', '模拟索引写入失败'); };
  const upgraded = { mediaType: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', quality: 'original' };
  await assert.rejects(f.capture(f.scope, entry(), upgraded), { code: 'STATE_WRITE_FAILED' });
  assert.equal(f.images.content(f.scope, saved.id).quality, 'thumbnail');
  assert.equal(f.images.content(f.scope, saved.id).data, png.toString('base64'));
  f.images.save = originalSave; f.images.remove(f.scope, [saved.id]);
  assert.equal(fs.readdirSync(f.images.directory(f.images.selector(f.scope))).filter(name => name.endsWith('.image') || name.endsWith('.png')).length, 0);
});

test('image-memory search uses no model; reading supplies original bytes to an isolated vision task', async t => {
  const f = fixture(t), saved = await f.capture(), requests = [], refs = [];
  const tool = imageMemoryTool(f.images, { run: async request => { requests.push(request); return { text: '画面中番茄面标价 18 元。' }; } }, f.scope, () => {}, { onRead: ref => refs.push(ref) });
  const found = JSON.parse(await tool.execute({ action: 'search', query: '菜单' }, { signal: signal() }));
  assert.equal(found.images[0].imageId, saved.id); assert.equal(requests.length, 0); assert(!JSON.stringify(found).includes(png.toString('base64')));
  const read = JSON.parse(await tool.execute({ action: 'read', imageId: saved.id, question: '番茄面价格是多少？' }, { signal: signal() }));
  assert(read.ok); assert(read.observation.includes('18 元')); assert.equal(requests.length, 1);
  assert.equal(requests[0].images[0].data, png.toString('base64')); assert.equal(requests[0].mode, 'vision'); assert(requests[0].systemOverride); assert(!requests[0].tools?.length);
  assert.equal(refs.length, 1);
  const foreign = imageMemoryTool(f.images, { run: () => assert.fail('foreign image must never reach the model') }, { ...f.scope, peerId: 'images-b@chatroom' }, () => {});
  assert.equal(JSON.parse(await foreign.execute({ action: 'read', imageId: saved.id }, { signal: signal() })).ok, false);
});

test('a deleted or expired picture during vision cannot produce a successful read or reusable reference', async t => {
  const f = fixture(t), saved = await f.capture(), gate = Promise.withResolvers(), started = Promise.withResolvers(), refs = [];
  const tool = imageMemoryTool(f.images, { run: async () => { started.resolve(); return gate.promise; } }, f.scope, () => {}, { onRead: ref => refs.push(ref) });
  const pending = tool.execute({ action: 'read', imageId: saved.id }, { signal: signal() }); await started.promise;
  f.images.remove(f.scope, [saved.id]); gate.resolve({ text: '旧画面' });
  assert.equal(JSON.parse(await pending).code, 'IMAGE_MEMORY_CHANGED'); assert.equal(refs.length, 0);
});

test('image tools enforce cancellation, vision state, receive-time boundaries and honest thumbnail quality', async t => {
  const f = fixture(t), saved = await f.capture(f.scope, entry(), image('thumbnail'));
  const tool = imageMemoryTool(f.images, { run: async () => ({ text: '小字看不清。' }) }, f.scope, () => {});
  assert.equal(JSON.parse(await tool.execute({ action: 'read', imageId: saved.id }, { signal: signal() })).quality, 'thumbnail');
  f.store.setModelConfig({ ...f.store.modelConfig(), vision: false });
  assert.equal(JSON.parse(await tool.execute({ action: 'read', imageId: saved.id }, { signal: signal() })).code, 'VISION_DISABLED');
  const before = imageMemoryTool(f.images, { run: () => assert.fail('future image must not enter an old turn') }, f.scope, () => {}, { maxTime: entry().time - 1 });
  assert.equal(JSON.parse(await before.execute({ action: 'search' }, { signal: signal() })).total, 0);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(tool.execute({ action: 'search' }, { signal: controller.signal }), /cancelled/);
});

test('owner RPC exposes only current-account images, imports report real partial results and permissions cannot be forged', async t => {
  const f = fixture(t), account = { id: f.scope.accountId }, channel = new WechatChannel({ store: f.store, runner: {}, transport: { status: () => ({ account, online: true }) } });
  channel.maintainMemory = () => {}; channel.imageMemory.thumbnailMaker = async () => png;
  const source = entry(); channel.memory.append(f.scope, source); channel.memory.append(f.scope, entry('failed'));
  const worker = { status: () => ({ account, online: true }), media: async ({ messageId }) => {
    if (messageId.includes('failed')) throw new ChannelError('IMAGE_UNAVAILABLE', '这张图片资源已过期'); return image();
  } };
  const service = createPluginService({ root: f.root, store: f.store, worker, channel, runner: {} }), rpc = rpcHandler(service);
  let pauses = 0; const pause = channel.pause.bind(channel); channel.pause = (...args) => { pauses++; return pause(...args); };
  t.after(() => channel.close());
  const owner = { principal: { kind: 'owner' } };
  const denied = await rpc('memory.images.list', f.scope, signal(), { principal: { kind: 'wechat' } }); assert.equal(denied.error.code, 'OWNER_REQUIRED');
  const partial = await rpc('memory.images.import', f.scope, signal(), owner);
  assert(partial.ok); assert.equal(partial.value.saved, 1); assert.equal(partial.value.failed, 1);
  const listed = await rpc('memory.images.list', f.scope, signal(), owner); assert.equal(listed.value.storedCount, 1);
  const changed = await rpc('memory.images.list', { ...f.scope, accountId: 'other-image-owner' }, signal(), owner); assert.equal(changed.error.code, 'ACCOUNT_CHANGED');
  assert.equal((await rpc('memory.images.configure', { ...f.scope, settings: { enabled: true, retentionDays: 0 } }, signal(), owner)).ok, false);
  assert.equal(pauses, 0, 'invalid settings must not cancel ordinary replies');
  assert.equal((await rpc('memory.images.configure', { ...f.scope, settings: { retentionDays: 30, enabled: true } }, signal(), owner)).ok, true);
  assert.equal(pauses, 0, 'saving unchanged settings in a different field order must not cancel replies');
});

test('workspaces move the entire independent image archive without invalidating source ownership', async t => {
  const f = fixture(t), saved = await f.capture(); f.store.ensureWorkspace();
  const transfer = migrateWorkspaceRoot({ bootstrap: f.root, store: f.store, targetRoot: path.join(f.container, 'moved') }); transfer.commit();
  const restored = new ImageMemory(new StateStore(transfer.root));
  assert.equal(restored.content(f.scope, saved.id).data, png.toString('base64'));
  assert.equal(restored.list(f.scope).items[0].description, saved.description);
});

test('the shipped thumbnail converter actually resizes a large PNG and leaves its original unchanged', async t => {
  const f = fixture(t), crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (kind, bytes) => { const name = Buffer.from(kind), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes]))); return Buffer.concat([size, name, bytes, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(600); header.writeUInt32BE(400, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((600 * 3 + 1) * 400, 230); for (let row = 0; row < 400; row++) rows[row * (600 * 3 + 1)] = 0;
  const original = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const images = new ImageMemory(f.store, { pythonPath: 'python' });
  const source = entry('large'); const saved = await images.capture(f.scope, source, source.attachments[0], { mediaType: 'image/png', data: original.toString('base64'), quality: 'original' }, signal());
  assert(saved.hasThumbnail, saved.thumbnailError);
  const preview = Buffer.from(images.content(f.scope, saved.id, { preview: true }).data, 'base64');
  assert.equal(inspectAssetImage(preview).width, 384); assert.equal(inspectAssetImage(preview).height, 256);
  assert.deepEqual(Buffer.from(images.content(f.scope, saved.id).data, 'base64'), original);
});
