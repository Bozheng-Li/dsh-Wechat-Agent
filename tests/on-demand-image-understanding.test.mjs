import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, ConversationMemory, conversationImageTool, imageMemoryTool, DshAgentRunner, ChannelError, messageText } from '../lib/testing.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 'base64');
const pixels = () => ({ data: png.toString('base64'), mediaType: 'image/png', quality: 'original', bytes: png.length });
const signal = () => new AbortController().signal;
const picture = (id, type = 'image') => ({ type, data: { resourceId: id } });
const catalog = tool => JSON.parse(tool.description.split('图片列表：')[1]);
function fixture(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'wechat-on-demand-'));
  const store = new StateStore(root), scope = { accountId: 'on-demand-owner', chatType: 'group', peerId: 'room@chatroom' };
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId, 'other@chatroom'], privatePeers: ['alice'], prompt: '' });
  const models = [], reads = [], sent = [], chats = [];
  const runner = { run: async request => { chats.push(request); return { text: '收到。' }; }, summarize: async () => '保留当前约定。',
    describeImage: async (image, _signal, options) => { models.push({ image, options }); return '图中文字是周五 14:30。'; } };
  const transport = { status: () => ({ online: true, account: { id: scope.accountId } }), media: async request => { reads.push(request); return pixels(); },
    send: async request => { sent.push(request); return { delivery: 'server-ack', serverMessageIds: ['synthetic-' + sent.length] }; } };
  const channel = new WechatChannel({ store, runner, transport }); channel.imageMemory.thumbnailMaker = async () => png;
  let sequence = 0;
  const receive = (text = '', images = [], overrides = {}) => channel.receive({ id: 'synthetic-' + ++sequence, direction: 'incoming', time: Math.floor(Date.now() / 1000),
    chatType: scope.chatType, peerId: scope.peerId, sender: { id: 'alice', nickname: '阿禾' }, message: [...(text ? [{ type: 'text', data: { text } }] : []), ...images], ...overrides }, scope.accountId);
  const tool = (snapshot = channel.memory.load(scope)) => conversationImageTool(channel.memory, runner, transport, scope, () => {}, { snapshot });
  t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), base); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, scope, runner, transport, channel, models, reads, sent, chats, receive, tool };
}

test('bare private pictures and mention-only pictures receive neutral text instead of an invented visual-analysis request', async t => {
  const f = fixture(t), account = { id: f.scope.accountId };
  for (const type of ['image', 'face']) {
    for (const chatType of ['private', 'group']) {
      const message = { chatType, message: [...(chatType === 'group' ? [{ type: 'at', data: { qq: account.id } }] : []), picture(type, type)] };
      const result = messageText(message, account);
      assert(result.text.includes('没有文字问题')); assert(result.text.includes('不主动分析')); assert(!result.text.includes('请理解')); assert(result.text.includes('表情包不调用'));
    }
  }
  f.receive('', [picture('private-only')], { chatType: 'private', peerId: 'alice' }); await f.channel.whenIdle();
  assert.equal(f.models.length, 0); assert.equal(f.chats.length, 1); assert(f.chats[0].text.includes('没有文字问题'));
});

test('receiving pictures, ordinary chat, maintenance and compression archive pixels without calling vision', async t => {
  const f = fixture(t);
  f.receive('', [picture('photo-a'), picture('photo-b'), picture('sticker', 'face')]); await f.channel.whenIdle();
  f.receive('/agent 今天怎么样'); await f.channel.whenIdle();
  await f.channel.processMemory(f.scope);
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, signal());
  await f.channel.memory.compact(f.scope, f.runner, signal());
  assert.equal(f.models.length, 0); assert.equal(f.channel.imageMemory.list(f.scope).storedCount, 3);
  assert(f.channel.imageMemory.list(f.scope).items.every(item => !item.description));
  assert.equal(f.channel.memory.view(f.scope).failedImages, 0); assert.equal(f.sent.length, 1);
  assert(!catalog(f.chats[0].tools.find(tool => tool.name === 'wechat_read_image')).some(item => item.imageId === 'sticker'));
});

test('a same-message question selects exactly one current picture; repeated identical reads reuse that turn result', async t => {
  const f = fixture(t);
  f.runner.run = async request => {
    f.chats.push(request); const tool = request.tools.find(tool => tool.name === 'wechat_read_image'), list = catalog(tool);
    assert.equal(list.length, 2); assert(list.every(item => item.current));
    const args = { imageId: list[1].imageId, question: '第二张图的约定几点？' };
    const result = JSON.parse(await tool.execute(args, { signal: request.signal, executionSnapshot: { selection: { provider: 'test', model: 'current' } } }));
    assert(result.ok); assert.equal(await tool.execute(args, { signal: request.signal }), JSON.stringify(result));
    return { text: result.observation };
  };
  f.receive('/agent 第二张图的约定几点？', [picture('unused'), picture('wanted'), picture('sticker', 'face')]); await f.channel.whenIdle();
  assert.equal(f.models.length, 1); assert.equal(f.models[0].options.question, '第二张图的约定几点？');
  assert.equal(f.models[0].options.executionSnapshot.selection.model, 'current');
  assert.equal(f.reads.filter(read => read.preferOriginal).length, 1); assert.equal(f.reads.find(read => read.preferOriginal).resourceId, 'wanted');
  assert.equal(f.sent.length, 1); assert(f.sent[0].message[0].data.text.includes('14:30'));
  const doc = new ConversationMemory(new StateStore(f.root)).view(f.scope);
  assert(doc.entries[0].attachments.find(image => image.resourceId === 'wanted').description.includes('14:30'));
  assert(!doc.entries[0].attachments.find(image => image.resourceId === 'unused').description);
  assert.equal(f.channel.imageMemory.list(f.scope).items.filter(image => image.description).length, 1);
});

test('recent pictures are available to later questions; ordinary recall of their description calls no vision', async t => {
  const f = fixture(t); f.receive('', [picture('earlier')]); await f.channel.whenIdle();
  f.runner.run = async request => { f.chats.push(request); const tool = request.tools.find(tool => tool.name === 'wechat_read_image');
    const result = JSON.parse(await tool.execute({ imageId: catalog(tool)[0].imageId, question: '刚才图片上写的时间？' }, { signal: request.signal })); assert(result.ok); return { text: result.observation }; };
  f.receive('/agent 刚才图片上写的时间？'); await f.channel.whenIdle(); assert.equal(f.models.length, 1);
  f.runner.run = async request => { assert(request.memory.includes('14:30')); return { text: '周五 14:30。' }; };
  f.receive('/agent 再说一遍刚才的约定'); await f.channel.whenIdle(); assert.equal(f.models.length, 1);
});

test('turn boundaries and photo selection reject future, foreign and sticker ids before a visual request', async t => {
  const f = fixture(t); f.receive('', [picture('visible'), picture('sticker', 'face')]); await f.channel.whenIdle();
  const first = f.tool(), firstList = catalog(first); assert.equal(firstList.length, 1);
  f.receive('', [picture('future')]); await f.channel.whenIdle(); const futureId = catalog(f.tool())[0].imageId;
  for (const imageId of [futureId, 'foreign-room-image', 'sticker']) {
    const result = JSON.parse(await first.execute({ imageId, question: '画面是什么？' }, { signal: signal() })); assert.equal(result.code, 'INVALID_IMAGE_REQUEST');
  }
  assert.equal(f.models.length, 0);
});

test('current images can be read with image saving disabled and after text compression without restoring old entries', async t => {
  const f = fixture(t); f.channel.imageMemory.configure(f.scope, { enabled: false, retentionDays: 30 });
  f.receive('', [picture('current')]); await f.channel.whenIdle(); const tool = f.tool();
  f.channel.memory.setWindowChars(1000);
  f.channel.memory.append(f.scope, { key: 'long-background', text: '较长的普通讨论。'.repeat(600), direction: 'incoming', time: Date.now() });
  await f.channel.whenIdle(); assert.equal(f.channel.memory.load(f.scope).entries.length, 0);
  const result = JSON.parse(await tool.execute({ imageId: catalog(tool)[0].imageId, question: '图上的时间？' }, { signal: signal() }));
  assert(result.ok); assert.equal(f.models.length, 1); assert.equal(f.channel.imageMemory.list(f.scope).storedCount, 0);
  assert.equal(f.channel.memory.load(f.scope).entries.length, 0);
});

test('deletion or clearing during an on-demand read cannot save or reuse a late visual result', async t => {
  const f = fixture(t); f.receive('', [picture('deleted')]); await f.channel.whenIdle();
  const tool = f.tool(), args = { imageId: catalog(tool)[0].imageId, question: '文字？' }, saved = f.channel.imageMemory.list(f.scope).items[0];
  f.channel.imageMemory.remove(f.scope, [saved.id]);
  assert.equal(JSON.parse(await tool.execute(args, { signal: signal() })).code, 'IMAGE_MEMORY_UNAVAILABLE'); assert.equal(f.models.length, 0);
  f.receive('', [picture('cleared')]); await f.channel.whenIdle(); const next = f.tool(), gate = Promise.withResolvers(), started = Promise.withResolvers();
  f.runner.describeImage = async () => { started.resolve(); return gate.promise; };
  const pending = next.execute({ imageId: catalog(next)[0].imageId, question: '文字？' }, { signal: signal() });
  await started.promise; f.channel.memory.clear(f.scope); gate.resolve('迟到的结果');
  assert.equal(JSON.parse(await pending).ok, false); assert.equal(f.channel.memory.load(f.scope).entries.length, 0);
  assert(!f.channel.imageMemory.list(f.scope).items.some(item => item.description.includes('迟到')));
});

test('failed requested reads preserve older descriptions and return failure instead of reporting the old text as freshly seen', async t => {
  const f = fixture(t); f.receive('', [picture('fail')]); await f.channel.whenIdle(); const tool = f.tool(), imageId = catalog(tool)[0].imageId;
  assert(JSON.parse(await tool.execute({ imageId, question: '时间？' }, { signal: signal() })).ok);
  f.runner.describeImage = async () => { throw new ChannelError('MODEL_INCOMPLETE', '视觉请求失败'); };
  const result = JSON.parse(await tool.execute({ imageId, question: '再核对地址？' }, { signal: signal() }));
  assert.equal(result.ok, false); assert(result.error.includes('视觉请求失败')); assert(f.channel.memory.view(f.scope).text.includes('14:30'));
});

test('on-demand image source validation follows the configured memory retention instead of a fixed thirty days', async t => {
  for (const [retentionDays, elapsedDays, expected] of [[1, 2, false], [60, 32, true]]) {
    const f = fixture(t);
    f.store.config.update('memory', { ...f.store.config.section('memory'), retentionDays }, f.store.data);
    f.channel.imageMemory.configure(f.scope, { enabled: false, retentionDays: 30 });
    f.receive('', [picture('retention-fixture')]); await f.channel.whenIdle();
    const snapshot = f.channel.memory.load(f.scope), tool = f.tool(snapshot), imageId = catalog(tool)[0].imageId;
    f.channel.memory.now = () => snapshot.entries[0].rememberedAt + elapsedDays * 86400000;
    const result = JSON.parse(await tool.execute({ imageId, question: 'Read the time.' }, { signal: signal() }));
    assert.equal(result.ok, expected);
    assert.equal(f.models.length, expected ? 1 : 0);
    if (!expected) assert.equal(result.code, 'IMAGE_CONTEXT_CHANGED');
  }
});

test('saved-image search and direct reads exclude native stickers; generic runner paths reject them before provider access', async t => {
  const f = fixture(t); f.receive('', [picture('photo'), picture('sticker', 'face')]); await f.channel.whenIdle();
  const images = f.channel.imageMemory, tool = imageMemoryTool(images, { run: () => assert.fail('sticker must not reach a model') }, f.scope, () => {});
  const search = JSON.parse(await tool.execute({ action: 'search' }, { signal: signal() })); assert.equal(search.total, 1);
  const sticker = images.list(f.scope).items.find(item => item.type === 'face');
  assert.equal(JSON.parse(await tool.execute({ action: 'read', imageId: sticker.id }, { signal: signal() })).code, 'STICKER_VISION_SKIPPED');
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, signal(), { retryFailed: true }); assert.equal(f.models.length, 0);
  const runner = new DshAgentRunner({});
  for (const image of [{ type: 'face' }, { kind: 'sticker' }]) {
    await assert.rejects(runner.describeImage(image, signal()), { code: 'STICKER_VISION_SKIPPED' });
    await assert.rejects(runner.describeImages([image], signal()), { code: 'STICKER_VISION_SKIPPED' });
    await assert.rejects(runner.run({ text: '看看图', images: [image], signal: signal() }), { code: 'STICKER_VISION_SKIPPED' });
  }
});
