import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WorkStore, ImageMemory, GeneratedImageMemory, imageMemoryTool, readWorkArtifact,
  archiveWorkImages, WechatChannel, createPluginService, rpcHandler } from '../lib/testing.js';
import { planProgressiveTools } from '../modules/tools/progressive.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 'base64');
const baseScope = { accountId: 'generated-owner', chatType: 'group', peerId: 'generated-a@chatroom' };
const generatedScope = { ...baseScope, collection: 'generated' };
const signal = () => new AbortController().signal;

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-generated-memory-'));
  const store = new StateStore(root);
  store.configure(baseScope.accountId, { enabled: true, groups: [baseScope.peerId, 'generated-b@chatroom'], privatePeers: ['alice'], prompt: '' });
  store.configure('other-generated-owner', { enabled: true, groups: [baseScope.peerId], privatePeers: [], prompt: '' });
  let now = Date.now();
  const images = new ImageMemory(store, { now: () => now, thumbnailMaker: async () => png }),
    work = new WorkStore(store, () => now), generated = new GeneratedImageMemory(images, work);
  let sequence = 0;
  const cleanups = [];
  const seed = ({ scope = baseScope, delivered = true, archives = true, request = '生成一张小胖自己的样貌，穿绿色毛衣', model = 'fixture-image-model' } = {}) => {
    const id = (++sequence).toString(16).padStart(12, '0'), workspaceRoot = store.ensureWorkspace(), folder = '微信agent/work/' + id,
      cwd = path.join(workspaceRoot, folder);
    fs.mkdirSync(cwd, { recursive: true }); fs.writeFileSync(path.join(cwd, 'portrait.png'), png);
    const artifact = readWorkArtifact(cwd, 'portrait.png').metadata,
      job = { id, ...scope, senderId: 'alice', senderName: 'Alice', request, workspaceRoot, folder,
        state: 'succeeded', createdAt: now - 3000, updatedAt: now - 1000, startedAt: now - 2000, finishedAt: now - 1000,
        operations: [{ tool: 'wechat_work_generate_image', at: now - 1500, result: { ok: true, artifacts: [artifact], providerName: '合成生图接口', model } }],
        result: { text: '合成图片已生成', files: [{ path: artifact.path, bytes: artifact.bytes }], artifacts: [artifact] },
        delivery: { state: delivered ? 'sent' : 'failed', acknowledgedMessageIds: delivered ? ['fixture-image-ack-' + id] : [],
          artifacts: [{ ...artifact, state: delivered ? 'sent' : 'failed', ...(delivered ? { serverMessageId: 'fixture-image-ack-' + id } : {}) }] } };
    if (archives) job.imageArchives = archiveWorkImages(job, cwd, [artifact]);
    work.add(job); return { ...job, cwd, artifact };
  };
  const captureConversation = async () => {
    const entry = { messageId: 'received-image', senderId: 'alice', senderName: 'Alice', text: '朋友发来的菜单', time: now };
    return images.capture(baseScope, entry, { resourceId: 'received-resource', type: 'image', description: '实际菜单' },
      { data: png.toString('base64'), mediaType: 'image/png', quality: 'original' }, signal());
  };
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    images.close();
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^wechat-generated-memory-/);
    assert(!fs.lstatSync(resolved).isSymbolicLink()); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, work, images, generated, seed, captureConversation, cleanups, tick: duration => { now += duration; } };
}

test('generated outputs have independent image files, search metadata and settings and survive restarting without the original task file', async t => {
  const f = fixture(t), incoming = await f.captureConversation(), job = f.seed();
  const result = await f.generated.sync(baseScope); assert.equal(result.saved, 1);
  const memory = f.images.list(generatedScope, { query: '小胖' }), saved = memory.items[0];
  assert.equal(memory.total, 1); assert.equal(saved.description, '');
  assert.equal(saved.generation.jobId, job.id); assert.equal(saved.generation.model, 'fixture-image-model');
  assert.match(saved.generation.prompt, /绿色毛衣/); assert.equal(saved.generation.deliveryState, 'sent');
  assert.equal(f.images.list(generatedScope, { query: 'portrait.png' }).total, 1);
  assert.equal(f.images.list(generatedScope, { query: 'fixture-image-model' }).total, 1);
  assert.notEqual(memory.path, f.images.list(baseScope).path);
  assert.notEqual(memory.key, f.images.list(baseScope).key);
  assert.equal(f.images.list(baseScope).items[0].id, incoming.id);
  fs.unlinkSync(path.join(job.cwd, 'portrait.png'));
  const reopened = new ImageMemory(new StateStore(f.root));
  assert.equal(reopened.content(generatedScope, saved.id).data, png.toString('base64'));
  f.images.configure(generatedScope, { enabled: false, retentionDays: 7 });
  assert.deepEqual(f.images.list(baseScope).settings, { enabled: true, retentionDays: 30 });
  assert.deepEqual(f.images.list(generatedScope).settings, { enabled: false, retentionDays: 7 });
});

test('backfill reads only the exact archived bytes, deduplicates repeats and can recover from the task original on older installations', async t => {
  const f = fixture(t), archived = f.seed(), legacy = f.seed({ archives: false, request: '生成另一张蓝色图片' });
  fs.unlinkSync(path.join(archived.cwd, 'portrait.png'));
  assert.equal((await f.generated.sync(baseScope)).saved, 2);
  assert.equal((await f.generated.sync(baseScope)).saved, 0);
  assert.equal(f.images.list(generatedScope).storedCount, 2);
  const item = f.images.list(generatedScope).items.find(item => item.generation.jobId === legacy.id);
  assert.equal(f.images.content(generatedScope, item.id).data, png.toString('base64'));
});

test('a mismatched or missing archived image is not fabricated from its prompt and does not enter image memory', async t => {
  const f = fixture(t), job = f.seed();
  fs.writeFileSync(path.join(job.workspaceRoot, job.imageArchives[0].path), Buffer.from('not the registered pixels'));
  fs.unlinkSync(path.join(job.cwd, 'portrait.png'));
  const result = await f.generated.sync(baseScope);
  assert.equal(result.failed, 1); assert.equal(result.saved, 0);
  assert.equal(f.images.list(generatedScope).storedCount, 0); assert.match(f.images.list(generatedScope).error, /未能加入记忆/);
});

test('generated pictures cannot cross account, room, private-chat or received-image boundaries', async t => {
  const f = fixture(t); f.seed(); await f.generated.sync(baseScope);
  const saved = f.images.list(generatedScope).items[0];
  for (const scope of [baseScope, { ...generatedScope, accountId: 'other-generated-owner' },
    { ...generatedScope, peerId: 'generated-b@chatroom' }, { ...generatedScope, chatType: 'private', peerId: 'alice' }]) {
    assert.equal(f.images.list(scope).storedCount, 0);
    assert.throws(() => f.images.content(scope, saved.id), { code: 'IMAGE_MEMORY_UNAVAILABLE' });
    assert.throws(() => f.images.remove(scope, [saved.id]), { code: 'IMAGE_MEMORY_UNAVAILABLE' });
  }
  assert.throws(() => f.images.list({ ...baseScope, collection: 'invalid' }), { code: 'INVALID_IMAGE_MEMORY_COLLECTION' });
});

test('unconfirmed group task images remain requester-only until a matching server acknowledgement is present', async t => {
  const f = fixture(t), job = f.seed({ delivered: false }); await f.generated.sync(baseScope);
  const item = f.images.list(generatedScope).items[0], bob = { ...generatedScope, senderId: 'bob' };
  assert.equal(f.images.list({ ...generatedScope, senderId: 'alice' }).total, 1);
  assert.equal(f.images.list(bob).total, 0);
  assert.throws(() => f.images.content(bob, item.id), { code: 'IMAGE_MEMORY_UNAVAILABLE' });
  f.work.update(job.id, { delivery: { state: 'sent', acknowledgedMessageIds: [], artifacts: [{ ...job.artifact, state: 'sent', serverMessageId: 'ack' }] } });
  await f.generated.sync(baseScope); assert.equal(f.images.list(bob).total, 0);
  f.work.update(job.id, { delivery: { state: 'sent', acknowledgedMessageIds: ['ack'], artifacts: [{ ...job.artifact, state: 'sent', serverMessageId: 'ack' }] } });
  await f.generated.sync(baseScope); assert.equal(f.images.content(bob, item.id).data, png.toString('base64'));
});

test('generated-image deletion and clearing preserve received pictures and original files and prevent old archives from repopulating memory', async t => {
  const f = fixture(t), received = await f.captureConversation(), first = f.seed(); await f.generated.sync(baseScope);
  f.images.remove(generatedScope, [f.images.list(generatedScope).items[0].id]);
  assert.equal((await f.generated.sync(baseScope)).saved, 0);
  f.seed(); // A historical task can exist before its memory has been imported.
  f.images.clear(generatedScope, f.generated.entries(baseScope));
  assert.equal((await f.generated.sync(baseScope)).saved, 0);
  assert.equal(f.images.list(generatedScope).storedCount, 0);
  assert.equal(f.images.content(baseScope, received.id).data, png.toString('base64'));
  assert.deepEqual(fs.readFileSync(path.join(first.cwd, 'portrait.png')), png);
  f.seed(); assert.equal((await f.generated.sync(baseScope)).saved, 1);
});

test('generated-image expiry is enforced by the sweep and does not restore old task pictures', async t => {
  const f = fixture(t), incoming = await f.captureConversation();
  f.images.configure(baseScope, { enabled: true, retentionDays: null }); f.seed(); await f.generated.sync(baseScope);
  f.tick(31 * 86400000); f.images.sweep();
  assert.equal(f.images.list(generatedScope).storedCount, 0);
  assert.equal((await f.generated.sync(baseScope)).saved, 0);
  assert.equal(f.images.content(baseScope, incoming.id).data, png.toString('base64'));
});

test('clearing while a generated thumbnail is pending cannot resurrect the saved picture', async t => {
  const f = fixture(t), started = Promise.withResolvers(), release = Promise.withResolvers();
  f.seed(); f.images.thumbnailMaker = async () => { started.resolve(); return release.promise; };
  const pending = f.generated.sync(baseScope); await started.promise;
  f.images.clear(generatedScope, f.generated.entries(baseScope)); release.resolve(png);
  await pending; assert.equal(f.images.list(generatedScope).storedCount, 0);
  assert.equal((await f.generated.sync(baseScope)).saved, 0);
});

test('generated-image tools search request metadata but read the actual saved image even without a WeChat media reference', async t => {
  const f = fixture(t); f.seed(); await f.generated.sync(baseScope);
  const calls = [], references = [], scope = { ...generatedScope, senderId: 'alice' };
  const tool = imageMemoryTool(f.images, { run: async request => { calls.push(request); return { text: '实际图片是红色方块，没有毛衣。' }; } }, scope, () => {}, { onRead: ref => references.push(ref) });
  assert.equal(tool.name, 'wechat_generated_image_memory');
  assert.match(tool.description, /版本不支持/);
  const found = JSON.parse(await tool.execute({ action: 'search', query: '自己的样貌' }, { signal: signal() }));
  assert.equal(found.images.length, 1); assert.equal(calls.length, 0);
  assert.equal(found.images[0].description, '尚未按需查看');
  const result = JSON.parse(await tool.execute({ action: 'read', imageId: found.images[0].imageId, question: '就是你生成的自己样貌的那张小胖，实际是什么样？' }, { signal: signal() }));
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].images[0].data, png.toString('base64'));
  assert.match(result.observation, /没有毛衣/); assert.equal(references[0].collection, 'generated');
  assert.equal(f.images.list(generatedScope).items[0].description, result.observation);
  const plan = planProgressiveTools([tool], '这张呢小胖');
  assert.equal(plan.initial[0].name, tool.name);
  assert.equal(planProgressiveTools([tool], '你好').deferredGroups[0].id, 'images');
});

test('only an explicitly identified current task can inspect its newly generated images from an older request', async t => {
  const f = fixture(t), current = f.seed(), other = f.seed();
  await f.generated.sync(baseScope);
  const saved = f.images.list(generatedScope).items, currentImage = saved.find(item => item.generation.jobId === current.id),
    otherImage = saved.find(item => item.generation.jobId === other.id), maxTime = Math.min(...saved.map(item => item.time)) - 1;
  const tool = imageMemoryTool(f.images, { run: async () => ({ text: '当前任务生成的绿色毛衣图片。' }) },
    { ...generatedScope, currentJobId: current.id }, () => {}, { maxTime });
  const result = JSON.parse(await tool.execute({ action: 'search' }, { signal: signal() }));
  assert.deepEqual(result.images.map(item => item.imageId), [currentImage.id]);
  assert.equal(JSON.parse(await tool.execute({ action: 'read', imageId: currentImage.id }, { signal: signal() })).ok, true);
  assert.equal(JSON.parse(await tool.execute({ action: 'read', imageId: otherImage.id }, { signal: signal() })).code, 'IMAGE_MEMORY_UNAVAILABLE');
  const unidentified = imageMemoryTool(f.images, { run: () => assert.fail('a missing task id cannot cross the turn boundary') },
    { ...generatedScope, currentJobId: '' }, () => {}, { maxTime });
  assert.equal(JSON.parse(await unidentified.execute({ action: 'search' }, { signal: signal() })).total, 0);
  assert.equal(JSON.parse(await unidentified.execute({ action: 'read', imageId: currentImage.id }, { signal: signal() })).code, 'IMAGE_MEMORY_UNAVAILABLE');
});

test('generated image reads respect disabled vision, original turn time and deletion during visual inspection', async t => {
  const f = fixture(t); f.seed(); await f.generated.sync(baseScope); const saved = f.images.list(generatedScope).items[0];
  const past = imageMemoryTool(f.images, { run: () => assert.fail('future image cannot be inspected') }, generatedScope, () => {}, { maxTime: saved.time - 1 });
  assert.equal(JSON.parse(await past.execute({ action: 'search' }, { signal: signal() })).total, 0);
  assert.equal(JSON.parse(await past.execute({ action: 'read', imageId: saved.id }, { signal: signal() })).ok, false);
  f.store.setModelConfig({ ...f.store.modelConfig(), vision: false });
  const disabled = imageMemoryTool(f.images, { run: () => assert.fail('disabled vision') }, generatedScope, () => {});
  assert.equal(JSON.parse(await disabled.execute({ action: 'read', imageId: saved.id }, { signal: signal() })).code, 'VISION_DISABLED');
  f.store.setModelConfig({ ...f.store.modelConfig(), vision: true });
  const changing = imageMemoryTool(f.images, { run: async () => { f.images.remove(generatedScope, [saved.id]); return { text: '不能使用的旧图观察' }; } }, generatedScope, () => {});
  assert.equal(JSON.parse(await changing.execute({ action: 'read', imageId: saved.id }, { signal: signal() })).code, 'IMAGE_MEMORY_CHANGED');
});

for (const promptStrategy of ['legacy', 'progressive-v1']) test(`a real ${promptStrategy} chat can inspect its generated portrait when the WeChat quotation has no image`, async t => {
  const f = fixture(t); f.seed();
  f.store.setModelConfig({ ...f.store.modelConfig(), vision: true, promptStrategy });
  const chats = [], vision = [], sent = [], media = [];
  const runner = { run: async request => {
    if (request.mode === 'vision') {
      vision.push(request);
      assert.equal(request.images[0].data, png.toString('base64'));
      assert.equal(request.images[0].quality, 'original');
      return { text: '实际图片是红色方块，没有毛衣。' };
    }
    chats.push(request);
    const tool = request.tools.find(tool => tool.name === 'wechat_generated_image_memory');
    assert(tool, 'generated images must be available even though this turn contains no usable WeChat image');
    const found = JSON.parse(await tool.execute({ action: 'search', query: '小胖' }, { signal: request.signal }));
    assert.equal(found.images.length, 1); assert.equal(vision.length, 0);
    const read = JSON.parse(await tool.execute({ action: 'read', imageId: found.images[0].imageId, question: '图里实际是什么？' }, { signal: request.signal }));
    assert.equal(read.ok, true); return { text: read.observation };
  } };
  const transport = { status: () => ({ online: true, account: { id: baseScope.accountId } }),
    media: async request => { media.push(request); throw new Error('The unavailable WeChat quotation must not be fetched'); },
    send: async payload => { sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['generated-portrait-reply-ack'] }; } };
  const channel = new WechatChannel({ store: f.store, runner, transport });
  channel.maintainMemory = () => {}; channel.imageMemory.thumbnailMaker = async () => png;
  f.cleanups.push(() => channel.close());
  assert.equal(channel.imageMemory.list(generatedScope).storedCount, 0, 'the chat must backfill an existing generated image');
  channel.receive({ id: 'generated-portrait-question', serverMessageId: 'generated-portrait-question',
    direction: 'incoming', time: Math.floor(Date.now() / 1000), chatType: baseScope.chatType, peerId: baseScope.peerId,
    sender: { id: 'alice', nickname: 'Alice' }, message: [{ type: 'text', data: {
      text: '/agent 就是你刚才生成的自己样貌那张，小胖，图里是什么？引用显示“版本不支持”，没有图片。' } }] }, baseScope.accountId);
  await channel.whenIdle();
  assert.equal(chats.length, 1); assert.equal(vision.length, 1); assert.equal(media.length, 0);
  assert.equal(sent.length, 1); assert(sent[0].message.some(part => part.data.text?.includes('红色方块，没有毛衣')));
  assert.equal(channel.imageMemory.list(baseScope).storedCount, 0);
  assert.equal(channel.imageMemory.list(generatedScope).items[0].description, '实际图片是红色方块，没有毛衣。');
});

test('owner RPC keeps generated and received collections separate through backfill, settings, deletion, clearing and account checks', async t => {
  const f = fixture(t), received = await f.captureConversation(); f.seed(); f.seed();
  const account = { id: baseScope.accountId }, worker = { status: () => ({ account, online: true }) };
  const channel = new WechatChannel({ store: f.store, runner: {}, transport: worker });
  channel.maintainMemory = () => {}; channel.imageMemory.thumbnailMaker = async () => png;
  const service = createPluginService({ root: f.root, store: f.store, worker, channel, runner: {} }), rpc = rpcHandler(service);
  f.cleanups.push(async () => { await channel.close(); await service.drain(); });
  const owner = { principal: { kind: 'owner' } }, call = (endpoint, payload = generatedScope) => rpc(endpoint, payload, signal(), owner);
  assert.equal((await rpc('memory.images.list', generatedScope, signal(), { principal: { kind: 'wechat' } })).error.code, 'OWNER_REQUIRED');
  const listed = await call('memory.images.list'); assert.equal(listed.ok, true); assert.equal(listed.value.storedCount, 2);
  const saved = listed.value.items[0];
  assert.equal((await call('memory.images.content', { ...generatedScope, imageId: saved.id })).value.data, png.toString('base64'));
  assert.equal((await call('memory.images.content', { ...baseScope, imageId: saved.id })).error.code, 'IMAGE_MEMORY_UNAVAILABLE');
  assert.equal((await call('memory.images.delete', { ...generatedScope, imageId: received.id })).error.code, 'IMAGE_MEMORY_UNAVAILABLE');
  for (const endpoint of ['memory.images.list', 'memory.images.content', 'memory.images.import', 'memory.images.configure', 'memory.images.delete', 'memory.images.clear']) {
    assert.equal((await call(endpoint, { ...generatedScope, collection: 'other' })).error.code, 'INVALID_IMAGE_MEMORY_COLLECTION', endpoint);
    assert.equal((await call(endpoint, { ...generatedScope, accountId: 'other-generated-owner' })).error.code, 'ACCOUNT_CHANGED', endpoint);
  }
  const configured = await call('memory.images.configure', { ...generatedScope, settings: { enabled: false, retentionDays: 7 } });
  assert.equal(configured.ok, true);
  assert.deepEqual((await call('memory.images.list', baseScope)).value.settings, { enabled: true, retentionDays: 30 });
  assert.equal((await call('memory.images.configure', { ...generatedScope, settings: { enabled: true, retentionDays: 7 } })).ok, true);
  assert.equal((await call('memory.images.delete', { ...generatedScope, imageId: saved.id })).ok, true);
  assert.equal((await call('memory.images.import')).value.saved, 0);
  assert.equal((await call('memory.images.list')).value.storedCount, 1);
  assert.equal((await call('memory.images.clear')).ok, true);
  assert.equal((await call('memory.images.import')).value.saved, 0);
  assert.equal((await call('memory.images.list')).value.storedCount, 0);
  assert.equal((await call('memory.images.content', { ...baseScope, imageId: received.id })).value.data, png.toString('base64'));
});

test('an account switch during generated-image backfill never returns the previous account image list', async t => {
  const f = fixture(t); f.seed();
  const account = { id: baseScope.accountId }, started = Promise.withResolvers(), release = Promise.withResolvers(),
    worker = { status: () => ({ account, online: true }) },
    channel = new WechatChannel({ store: f.store, runner: {}, transport: worker });
  channel.maintainMemory = () => {}; channel.imageMemory.thumbnailMaker = async () => { started.resolve(); return release.promise; };
  const service = createPluginService({ root: f.root, store: f.store, worker, channel, runner: {} }), rpc = rpcHandler(service);
  f.cleanups.push(async () => { release.resolve(png); await channel.close(); await service.drain(); });
  const pending = rpc('memory.images.list', generatedScope, signal(), { principal: { kind: 'owner' } });
  await started.promise; account.id = 'other-generated-owner'; release.resolve(png);
  const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(channel.imageMemory.list({ ...generatedScope, accountId: account.id }).storedCount, 0);
});
