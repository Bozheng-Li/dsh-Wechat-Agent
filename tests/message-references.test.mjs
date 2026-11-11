import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore, ConversationMemory, WechatChannel, ChannelError, messageText, messageReferences,
  resolveMessageReferences, readWorkArtifact, archiveWorkImages } from '../lib/testing.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const pixels = () => ({ data: png.toString('base64'), mediaType: 'image/png', quality: 'original', bytes: png.length });
const signal = () => new AbortController().signal;
const scope = { accountId: 'quote-owner', chatType: 'group', peerId: 'quoted@chatroom', senderId: 'alice' };
const quote = (id, data = {}) => ({ type: 'reply', data: { id: `wx:${scope.peerId}:${id}`, messageType: 3,
  senderId: 'bob', senderName: '小柏', ...data } });
const picture = resourceId => ({ type: 'image', data: { resourceId } });

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-quote-memory-'));
  const store = new StateStore(root), chats = [], visions = [], reads = [], sent = [], works = [];
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId, 'other@chatroom'], privatePeers: ['alice'], prompt: '' });
  store.configure('other-owner', { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  let now = Date.now(), serial = 0;
  const runner = { run: async request => {
    if (request.mode === 'vision') { visions.push(request); return { text: '图中文字：周五 14:30，地点 A203。' }; }
    if (request.mode === 'work-result') return { text: JSON.parse(request.text).result };
    chats.push(request); return { text: '收到。' };
  }, describeImage: async image => { visions.push({ images: [image] }); return '图中文字：周五 14:30，地点 A203。'; },
  summarize: async () => '保留讨论。' };
  const transport = { status: () => ({ online: true, account: { id: scope.accountId } }),
    media: async request => { reads.push(request); return pixels(); },
    send: async request => { sent.push(request); return { delivery: 'server-ack', serverMessageIds: ['synthetic-ack-' + sent.length] }; } };
  const channel = new WechatChannel({ store, runner, transport, now: () => now,
    workRunner: { run: async request => { works.push(request); return { text: '已读取引用，完成合成任务。' }; } } });
  channel.imageMemory.thumbnailMaker = async () => png;
  const receive = (text = '', segments = [], overrides = {}) => {
    now += 10;
    const id = String(9007199254740999n + BigInt(++serial));
    const message = { id: `wx:${scope.peerId}:${id}`, serverMessageId: id, direction: 'incoming',
      time: Math.floor(now / 1000), chatType: scope.chatType, peerId: scope.peerId,
      sender: { id: 'alice', nickname: '阿禾' }, message: [...(text ? [{ type: 'text', data: { text } }] : []), ...segments], ...overrides };
    channel.receive(message, scope.accountId); return message;
  };
  const history = () => store.history(scope.accountId, scope.chatType, scope.peerId, 1000);
  const entry = message => history().find(entry => entry.messageId === message.serverMessageId);
  const record = message => store.data.records.find(record => record.messageId === message.id);
  const seedGenerated = ({ ack = 'generated-image-ack', secondAck = 'other-image-ack', delivered = true } = {}) => {
    const id = (++serial).toString(16).padStart(12, '0'), workspaceRoot = store.ensureWorkspace(), folder = '微信agent/work/' + id,
      cwd = path.join(workspaceRoot, folder);
    fs.mkdirSync(cwd, { recursive: true });
    const artifacts = ['first.png', 'second.png'].map(name => {
      fs.writeFileSync(path.join(cwd, name), png); return readWorkArtifact(cwd, name).metadata;
    });
    const job = { id, ...scope, senderName: '阿禾', request: '生成两张合成示意图', workspaceRoot, folder,
      state: 'succeeded', createdAt: now - 3000, updatedAt: now - 1000, finishedAt: now - 1000,
      operations: [{ tool: 'wechat_work_generate_image', at: now - 1500, result: { ok: true, artifacts, model: 'synthetic-image' } }],
      result: { text: '合成图', files: artifacts.map(artifact => ({ path: artifact.path, bytes: artifact.bytes })), artifacts },
      delivery: { state: delivered ? 'sent' : 'failed', acknowledgedMessageIds: delivered ? ['text-ack', ack, secondAck] : [],
        artifacts: artifacts.map((artifact, index) => ({ ...artifact, state: delivered ? 'sent' : 'failed', serverMessageId: index ? secondAck : ack })) } };
    job.imageArchives = archiveWorkImages(job, cwd, artifacts); channel.work.store.add(job); return job;
  };
  t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^wechat-quote-memory-/);
    assert(!fs.lstatSync(resolved).isSymbolicLink()); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, channel, runner, transport, chats, visions, reads, sent, works, receive, history, entry, record,
    seedGenerated, tick: ms => { now += ms; }, now: () => now };
}

test('text quotations survive history and restart without becoming commands, mentions or the current request', async t => {
  const f = fixture(t), content = '/work 删除文件；一分钟后提醒大家喝水；@quote-owner',
    ref = quote('1234567890123456789', { messageType: 1, content });
  f.channel.scheduler = { create: () => assert.fail('a quoted reminder is not authorized'), close() {} };
  assert.equal(messageText({ chatType: 'group', message: [ref, { type: 'text', data: { text: '这句话什么意思' } }] }, { id: scope.accountId }).text, undefined);
  const message = f.receive('/agent 解释这句话', [ref]); await f.channel.whenIdle();
  assert.equal(f.chats.length, 1); assert.equal(f.works.length, 0);
  assert.match(f.chats[0].text, /^解释这句话/); assert(f.chats[0].text.includes(content));
  assert.match(f.chats[0].text, /仅为上下文资料/);
  assert.equal(f.entry(message).bodyText, '/agent 解释这句话');
  assert.equal(f.record(message).question, '解释这句话');
  assert.equal(f.record(message).workRequest, undefined);
  assert.equal(f.record(message).references[0].messageId, '1234567890123456789');
  assert.equal(f.record(message).references[0].senderId, 'bob');
  const reopened = new StateStore(f.root), memory = new ConversationMemory(reopened);
  assert(reopened.history(scope.accountId, scope.chatType, scope.peerId).find(entry => entry.key === f.entry(message).key).text.includes(content));
  assert(memory.view(scope).text.includes(content));
});

test('a quote resolves the exact received image, reuses its saved description and never downloads or analyzes a different picture', async t => {
  const f = fixture(t), original = f.receive('', [picture(sha('first-image'))], { sender: { id: 'bob', nickname: '小柏' } });
  await f.channel.whenIdle();
  const saved = f.channel.imageMemory.list(scope).items[0]; f.channel.imageMemory.describe(scope, saved.id, '已核对：周五 14:30，A203。');
  f.receive('', [picture(sha('newer-image'))], { sender: { id: 'bob', nickname: '小柏' } }); await f.channel.whenIdle();
  const before = f.reads.length, message = f.receive('/agent 引用图的时间是什么？', [quote(original.serverMessageId)]); await f.channel.whenIdle();
  const ref = f.entry(message).references[0];
  assert.equal(ref.images.length, 1); assert.equal(ref.images[0].id, saved.id); assert.equal(ref.images[0].collection, 'conversation');
  assert(f.chats[0].text.includes(`image-memory://conversation/${saved.id}`)); assert(f.chats[0].text.includes('周五 14:30'));
  assert.equal(f.reads.length, before); assert.equal(f.visions.length, 0);
  assert.equal(f.entry(original).attachments[0].description, '已核对：周五 14:30，A203。');
});

for (const promptStrategy of ['legacy', 'progressive-v1']) test(`quoted generated image reads actual pixels and writes its observation into history and memory (${promptStrategy})`, async t => {
  const f = fixture(t); f.seedGenerated(); f.store.setModelConfig({ ...f.store.modelConfig(), promptStrategy });
  const run = f.runner.run;
  f.runner.run = async request => {
    if (request.mode === 'vision') return run(request);
    f.chats.push(request);
    const ref = JSON.parse(request.text.split('\n').at(-1)), image = ref.images[0];
    assert.equal(image.tool, 'wechat_generated_image_memory'); assert.match(image.description, /尚未按需理解/);
    const tool = request.tools.find(tool => tool.name === image.tool); assert(tool);
    const result = JSON.parse(await tool.execute({ action: 'read', imageId: image.imageId, question: '图里的时间和地点？' }, { signal: request.signal }));
    assert(result.ok); return { text: result.observation };
  };
  const message = f.receive('/agent 看这张图里的时间和地点', [quote('generated-image-ack', { senderId: scope.accountId, senderName: 'Agent' })]);
  await f.channel.whenIdle();
  assert.equal(f.chats.length, 1); assert.equal(f.visions.length, 1); assert.equal(f.reads.length, 0);
  assert.equal(f.visions[0].images[0].data, png.toString('base64'));
  assert.equal(f.visions[0].images[0].generation.fileName, 'first.png');
  assert(f.entry(message).text.includes('周五 14:30')); assert(f.record(message).references[0].images[0].description.includes('A203'));
  const restarted = new ConversationMemory(new StateStore(f.root)); assert(restarted.view(scope).text.includes('A203'));
});

test('text acknowledgements and unconfirmed or wrong image acknowledgements never identify a generated image', async t => {
  const f = fixture(t); f.seedGenerated(); f.seedGenerated({ delivered: false, ack: 'unconfirmed-image' });
  for (const id of ['text-ack', 'unconfirmed-image', 'never-seen-image']) {
    const message = f.receive('/agent 这张引用图呢？', [quote(id, { senderId: scope.accountId })]); await f.channel.whenIdle();
    assert.deepEqual(f.entry(message).references[0].images, []); assert.match(f.entry(message).text, /未找到/);
  }
  assert.equal(f.visions.length, 0); assert.equal(f.reads.length, 0);
});

test('a usable quote resource archives the actual image even when the original message was never observed', async t => {
  const f = fixture(t), resourceId = sha('quote-resource'),
    message = f.receive('/agent 记住这个图片引用', [quote('previously-unobserved', { image: { resourceId } })]);
  await f.channel.whenIdle();
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].messageId, message.serverMessageId);
  assert.equal(f.reads[0].resourceId, resourceId); assert.equal(f.reads[0].preferOriginal, true);
  const ref = f.entry(message).references[0], saved = f.channel.imageMemory.content(scope, ref.images[0].id);
  assert.equal(saved.messageId, 'previously-unobserved'); assert.equal(saved.senderId, 'bob'); assert.equal(saved.data, png.toString('base64'));
  assert.equal(f.visions.length, 0); assert.match(f.entry(message).text, /image-memory:\/\/conversation\//);
});

test('passive group image quotes are retained for a later question without an automatic model call', async t => {
  const f = fixture(t), message = f.receive('这是当时的安排', [quote('unobserved-group-original', { image: { resourceId: sha('passive-quote') } })]);
  await f.channel.whenIdle();
  assert.equal(f.chats.length, 0); assert.equal(f.visions.length, 0); assert.equal(f.reads.length, 1);
  const saved = f.entry(message).references[0].images[0]; assert(saved);
  const run = f.runner.run;
  f.runner.run = async request => {
    if (request.mode === 'vision') return run(request);
    assert(JSON.stringify({ memory: request.memory, history: request.history }).includes(`image-memory://conversation/${saved.id}`));
    const result = JSON.parse(await request.tools.find(tool => tool.name === 'wechat_image_memory').execute(
      { action: 'read', imageId: saved.id, question: '刚才引用的时间是什么？' }, { signal: request.signal }));
    assert(result.ok); return { text: result.observation };
  };
  f.receive('/agent 刚才引用的时间是什么？'); await f.channel.whenIdle();
  assert.equal(f.visions.length, 1); assert(f.entry(message).text.includes('14:30'));
});

test('retrying multiple image descriptions preserves every quote update in history and memory', async t => {
  const f = fixture(t), original = f.receive('', [picture(sha('batch-a')), picture(sha('batch-b'))], { sender: { id: 'bob' } });
  await f.channel.whenIdle();
  const message = f.receive('两张图在这里', [quote(original.serverMessageId)]); await f.channel.whenIdle();
  const doc = f.channel.memory.load(scope);
  for (const image of doc.entries.find(entry => entry.messageId === original.serverMessageId).attachments) image.error = 'synthetic failed description';
  f.channel.memory.save(doc);
  f.runner.describeImages = async images => { assert.equal(images.length, 2); return ['第一张说明：甲楼。', '第二张说明：乙楼。']; };
  await f.channel.memory.enrich(scope, f.runner, f.transport, signal(), { retryFailed: true });
  const remembered = f.channel.memory.load(scope).entries.find(entry => entry.key === f.entry(message).key);
  for (const label of ['甲楼', '乙楼']) { assert(remembered.text.includes(label)); assert(f.entry(message).text.includes(label)); }
  assert(f.entry(original).attachments.every(image => image.description));
});

test('cleared generated archives cannot be restored via a quoted resource, including legacy tombstones', async t => {
  const f = fixture(t); f.seedGenerated();
  const generated = { ...scope, collection: 'generated' };
  f.channel.imageMemory.clear(generated, f.channel.work.generatedImages.entries(scope));
  const state = f.channel.imageMemory.load(generated);
  for (const deleted of Object.values(state.deleted)) { delete deleted.messageId; delete deleted.serverMessageIds; }
  f.channel.imageMemory.save(state);
  const message = f.receive('/agent 引用你之前生成的图', [quote('generated-image-ack',
    { senderId: scope.accountId, image: { resourceId: sha('deleted-generation-cdn') } })]);
  await f.channel.whenIdle();
  assert.deepEqual(f.entry(message).references[0].images, []); assert.equal(f.reads.length, 0);
  assert.equal(f.channel.imageMemory.list(generated).storedCount, 0); assert.equal(f.channel.imageMemory.list(scope).storedCount, 0);
});

for (const action of ['deleted', 'expired', 'disabled', 'missing-file', 'legacy-deleted']) test(`a ${action} original cannot be restored from the quote CDN`, async t => {
  const f = fixture(t), original = f.receive('', [picture(sha('protected-original'))], { sender: { id: 'bob' } });
  await f.channel.whenIdle(); const saved = f.channel.imageMemory.list(scope).items[0];
  if (action === 'deleted' || action === 'legacy-deleted') {
    f.channel.imageMemory.remove(scope, [saved.id]);
    if (action === 'legacy-deleted') { const state = f.channel.imageMemory.load(scope); delete state.deleted[saved.id].messageId; f.channel.imageMemory.save(state); }
  } else if (action === 'expired') { f.channel.imageMemory.configure(scope, { enabled: true, retentionDays: 1 }); f.tick(86400001); }
  else if (action === 'disabled') f.channel.imageMemory.configure(scope, { enabled: false, retentionDays: 30 });
  else fs.unlinkSync(f.channel.imageMemory.file(f.channel.imageMemory.load(scope), saved.id));
  const before = f.reads.length, message = f.receive('/agent 引用的原图呢', [quote(original.serverMessageId, { image: { resourceId: sha('different-quote-resource') } })]);
  await f.channel.whenIdle(); assert.equal(f.reads.length, before);
  assert.deepEqual(f.entry(message).references[0].images, []); assert.equal(f.visions.length, 0);
});

test('exact image matching rejects foreign rooms, accounts, authors and future messages', async t => {
  const f = fixture(t), id = 'same-message-number', attachment = { type: 'image', resourceId: sha('scoped') },
    entry = { messageId: id, senderId: 'bob', text: '', time: f.now() - 1000 };
  for (const input of [{ ...scope, accountId: 'other-owner' }, { ...scope, peerId: 'other@chatroom' }])
    await f.channel.imageMemory.capture(input, entry, attachment, pixels(), signal());
  const absent = f.receive('/agent 引用图', [quote(id)]); await f.channel.whenIdle();
  assert.deepEqual(f.entry(absent).references[0].images, []);
  await f.channel.imageMemory.capture(scope, entry, attachment, pixels(), signal());
  const wrongAuthor = f.receive('/agent 引用图', [quote(id, { senderId: 'mallory' })]); await f.channel.whenIdle();
  assert.deepEqual(f.entry(wrongAuthor).references[0].images, []);
  assert.deepEqual(f.channel.imageMemory.byMessage(scope, `wx:other@chatroom:${id}`), []);
  assert.deepEqual(f.channel.imageMemory.byMessage(scope, id, { before: entry.time - 1 }), []);
});

for (const changed of ['memory', 'images', 'account', 'cancel']) test(`a pending quote download cannot write old references after ${changed} changes`, async t => {
  const f = fixture(t); f.channel.maintainMemory = () => {};
  const message = f.receive('普通引用', [quote('pending-original', { image: { resourceId: sha('pending-resource') } })]);
  await f.channel.whenIdle();
  const started = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
  f.transport.media = async () => { started.resolve(); return release.promise; };
  let allowed = true;
  const pending = resolveMessageReferences(f.channel, scope, f.entry(message), controller.signal,
    () => { if (!allowed) throw new ChannelError('ACCOUNT_CHANGED', 'synthetic account change'); });
  await started.promise;
  if (changed === 'memory') f.channel.memory.clear(scope);
  if (changed === 'images') f.channel.imageMemory.clear(scope);
  if (changed === 'account') allowed = false;
  if (changed === 'cancel') controller.abort(new ChannelError('CANCELLED', 'synthetic cancellation'));
  release.resolve(pixels());
  if (changed === 'images') await pending;
  else await assert.rejects(pending, { code: changed === 'memory' ? 'MEMORY_CHANGED' : changed === 'account' ? 'ACCOUNT_CHANGED' : 'CANCELLED' });
  assert.equal(f.channel.imageMemory.list(scope).storedCount, 0);
  assert(!f.entry(message).references[0].images?.length);
});

test('native work receives quote context and the image tool while retaining the actual request unchanged', async t => {
  const f = fixture(t), config = f.store.config.snapshot(f.store.data);
  config.remote = { globalAdminIds: ['alice'] }; f.store.config.commit(config);
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true });
  const original = f.receive('', [picture(sha('work-source'))], { sender: { id: 'bob' } }); await f.channel.whenIdle();
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), executionMode: 'work' });
  const message = f.receive('/work 读取引用图片并整理文字', [quote(original.serverMessageId)]); await f.channel.whenIdle();
  assert.equal(f.works.length, 1);
  assert.match(f.works[0].request, /^读取引用图片并整理文字\n\n\[微信引用消息/);
  assert(f.works[0].imageMemoryTools.some(tool => tool.name === 'wechat_image_memory'));
  const job = f.channel.work.list(scope).jobs[0]; assert.equal(job.request, '读取引用图片并整理文字');
  assert.equal(job.quotedReferences[0].images.length, 1); assert.equal(f.record(message).references[0].images.length, 1);
});

test('a queued native task rechecks quoted images before sending cached descriptions to its model', async t => {
  const f = fixture(t), config = f.store.config.snapshot(f.store.data);
  config.remote = { globalAdminIds: ['alice'] }; f.store.config.commit(config);
  const original = f.receive('', [picture(sha('queued-source'))], { sender: { id: 'bob' } }); await f.channel.whenIdle();
  const message = f.receive('留作参考', [quote(original.serverMessageId)]); await f.channel.whenIdle();
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true, executionMode: 'work' });
  const job = f.channel.work.create(scope, '整理引用图', undefined, { defer: true, quotedReferences: f.entry(message).references });
  f.channel.imageMemory.remove(scope, [job.quotedReferences[0].images[0].id]);
  f.channel.work.release([job.id]); await f.channel.whenIdle();
  assert.equal(f.works.length, 1); assert.match(f.works[0].request, /原图已删除/); assert(!f.works[0].request.includes('image-memory://'));
  assert(!f.works[0].imageMemoryTools.some(tool => tool.name === 'wechat_image_memory'));
});

test('deleting an image during a quoted-description reply prevents sending stale visual claims', async t => {
  const f = fixture(t), original = f.receive('', [picture(sha('pre-send-original'))], { sender: { id: 'bob' } }); await f.channel.whenIdle();
  const saved = f.channel.imageMemory.list(scope).items[0]; f.channel.imageMemory.describe(scope, saved.id, '仅旧图存在时有效的观察');
  f.runner.run = async request => {
    assert(request.text.includes('仅旧图存在时有效的观察'));
    f.channel.imageMemory.remove(scope, [saved.id]); return { text: '不能发送的旧图回答' };
  };
  const message = f.receive('/agent 引用图是什么', [quote(original.serverMessageId)]); await f.channel.whenIdle();
  assert.equal(f.sent.length, 0); assert.notEqual(f.record(message).state, 'sent');
});

test('image quote metadata never retains arbitrary XML, file paths or image descriptors as model text', () => {
  const segments = [quote('1', { content: '<img aeskey="SYNTHETIC_PRIVATE_KEY"/>', image: { resourceId: '../../private.png', file: 'C:\\private\\image.png' } })];
  const references = messageReferences(segments, scope.peerId);
  assert(!JSON.stringify(references).includes('PRIVATE_KEY')); assert(!JSON.stringify(references).includes('private.png'));
});

test('an ID-only legacy quote reconstructs the exact saved text with its author, not the nearest message', async t => {
  const f = fixture(t), original = f.receive('原话：蓝色方案只在周五使用。', [], { sender: { id: 'bob', nickname: '小柏' } });
  await f.channel.whenIdle();
  f.receive('最新方案是红色的，与引用无关。', [], { sender: { id: 'bob', nickname: '小柏' } }); await f.channel.whenIdle();
  const message = f.receive('/agent 他这句是什么意思', [quote(original.serverMessageId, { messageType: undefined })]); await f.channel.whenIdle();
  const ref = f.entry(message).references[0];
  assert.equal(ref.messageType, 1); assert.equal(ref.senderId, 'bob');
  assert.equal(ref.content, '原话：蓝色方案只在周五使用。');
  assert(f.chats.at(-1).text.includes(ref.content)); assert(!f.chats.at(-1).text.includes('最新方案是红色的'));
  assert(new ConversationMemory(new StateStore(f.root)).view(scope).text.includes(ref.content));
});

test('legacy text lookup respects author, receive time and an explicit memory clear', async t => {
  const f = fixture(t), original = f.receive('仅原发言者的旧文字。', [], { sender: { id: 'bob' } }); await f.channel.whenIdle();
  const wrongAuthor = f.receive('/agent 引用的原文呢', [quote(original.serverMessageId, { messageType: 1, senderId: 'alice' })]); await f.channel.whenIdle();
  assert(!f.entry(wrongAuthor).references[0].content);
  const early = await resolveMessageReferences(f.channel, scope, { key: 'synthetic-early', observedAt: f.entry(original).observedAt - 1,
    references: [{ messageId: original.serverMessageId, messageType: 1, senderId: 'bob' }] }, signal());
  assert(!early[0].content);
  f.channel.memory.clear(scope);
  const cleared = f.receive('/agent 引用原文', [quote(original.serverMessageId, { messageType: 1 })]); await f.channel.whenIdle();
  assert(!f.entry(cleared).references[0].content); assert.match(f.entry(cleared).text, /未保存该原消息编号/);
});

test('an ID-only image quote binds the generated image ACK even when newer pictures exist', async t => {
  const f = fixture(t), old = f.seedGenerated({ ack: 'old-image-ack', secondAck: 'old-second-ack' });
  f.tick(500); f.seedGenerated({ ack: 'new-image-ack', secondAck: 'new-second-ack' });
  const message = f.receive('/agent 看这个引用', [quote('old-image-ack', { messageType: undefined, senderId: scope.accountId })]); await f.channel.whenIdle();
  const ref = f.entry(message).references[0]; assert.equal(ref.messageType, 3); assert.equal(ref.images.length, 1);
  const item = f.channel.imageMemory.content({ ...scope, collection: 'generated' }, ref.images[0].id);
  assert.equal(item.generation.jobId, old.id); assert.equal(item.generation.fileName, 'first.png');
  assert(!f.chats[0].text.includes('本会话最近确认发出的图片'));
  assert(!f.chats[0].text.includes('new-image-ack'));
});

for (const text of ['这是利威尔', '你干嘛把兵长的图片当成我然后发给我']) test(`a short follow-up sees the confirmed image it was sent: ${text}`, async t => {
  const f = fixture(t); f.seedGenerated({ ack: 'actual-picture-ack' });
  f.receive('/agent ' + text); await f.channel.whenIdle();
  assert.equal(f.chats.length, 1);
  assert.match(f.chats[0].text, /你确实向本会话发过以下图片/);
  assert(f.chats[0].text.includes('actual-picture-ack'));
  assert.match(f.chats[0].text, /image-memory:\/\/generated\/[a-f0-9]{64}/);
  assert.match(f.chats[0].text, /不表示当前消息引用了其中某张/);
  assert(f.chats[0].tools.some(tool => tool.name === 'wechat_generated_image_memory'));
  assert.equal(f.visions.length, 0, 'delivery context must not invoke vision automatically');
});

test('a missing WeChat payload keeps its limitation and the available sent-image context in the same turn', async t => {
  const f = fixture(t); f.seedGenerated();
  const message = f.receive('无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。', [{ type: 'at', data: { qq: scope.accountId } }]);
  await f.channel.whenIdle();
  assert.equal(f.chats.length, 1); assert.match(f.chats[0].text, /本条只收到“版本不支持”占位/);
  assert.match(f.chats[0].text, /你确实向本会话发过以下图片/);
  assert.equal(f.entry(message).contentUnavailable, true); assert.match(f.entry(message).text, /微信消息内容缺失/);
  assert.equal(f.entry(message).references?.length ?? 0, 0, 'a placeholder cannot invent a quote ID');
});

test('delayed image ACKs do not appear in earlier chat turns or become visible to another group member early', async t => {
  const f = fixture(t), job = f.seedGenerated(), sentAt = f.now() + 2000;
  f.channel.work.store.update(job.id, { delivery: { ...job.delivery, artifacts: job.delivery.artifacts.map(artifact => ({ ...artifact, sentAt })) } });
  f.receive('/agent 这是刚才那张吗'); await f.channel.whenIdle();
  assert(!f.chats.at(-1).text.includes('你确实向本会话发过以下图片'));
  const tool = f.chats.at(-1).tools.find(tool => tool.name === 'wechat_generated_image_memory');
  const result = JSON.parse(await tool.execute({ action: 'search' }, { signal: signal() }));
  assert(result.images.length); assert(result.images.every(image => image.generation.deliveryState === 'not-confirmed' && !image.generation.serverMessageIds.length));
  f.receive('/agent 刚才的图呢', [], { sender: { id: 'bob' } }); await f.channel.whenIdle();
  assert(!f.chats.at(-1).tools.some(tool => tool.name === 'wechat_generated_image_memory'));
  f.tick(2200); f.receive('/agent 现在这张呢', [], { sender: { id: 'bob' } }); await f.channel.whenIdle();
  assert.match(f.chats.at(-1).text, /你确实向本会话发过以下图片/);
});

test('deleted generated images do not reappear as recent candidates, and unknown quotes never bind the nearest image', async t => {
  const f = fixture(t); f.seedGenerated();
  const unknown = f.receive('/agent 这张引用是啥', [quote('never-sent-ack', { senderId: scope.accountId })]); await f.channel.whenIdle();
  assert.deepEqual(f.entry(unknown).references[0].images, []);
  assert(!f.chats.at(-1).text.includes('image-memory://'));
  f.channel.imageMemory.clear({ ...scope, collection: 'generated' });
  f.receive('/agent 这是利威尔'); await f.channel.whenIdle();
  assert(!f.chats.at(-1).text.includes('image-memory://'));
  assert.equal(f.channel.imageMemory.list({ ...scope, collection: 'generated' }).storedCount, 0);
});

test('native work can read ordinary chat on demand while a queued task excludes future and other-room messages', async t => {
  const f = fixture(t), config = f.store.config.snapshot(f.store.data);
  config.remote = { globalAdminIds: ['alice'] }; f.store.config.commit(config);
  f.receive('我喜欢画法律主题的漫画，人物戴蓝色围巾。'); await f.channel.whenIdle();
  f.channel.memory.append({ ...scope, peerId: 'other@chatroom' }, { key: 'other', senderId: 'alice', senderName: '阿禾',
    text: 'OTHER_ROOM_PRIVATE_NOTE', direction: 'incoming', time: f.now(), observedAt: f.now() });
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true, executionMode: 'work' });
  const job = f.channel.work.create(scope, '根据我们的聊天生成一幅画像', undefined, { defer: true });
  f.tick(1000); f.channel.memory.append(scope, { key: 'future', senderId: 'alice', senderName: '阿禾', text: 'FUTURE_NOTE',
    direction: 'incoming', time: f.now(), observedAt: f.now() });
  let result;
  f.channel.work.runner.run = async request => {
    f.works.push(request); assert(!request.request.includes('蓝色围巾'), 'ordinary chat stays out of the preloaded work prompt');
    const tool = request.memoryTools.find(tool => tool.name === 'wechat_memory'); assert(tool);
    result = await tool.execute({ section: 'conversation' }, { signal: request.signal });
    return { text: '合成工作已完成。' };
  };
  f.channel.work.release([job.id]); await f.channel.whenIdle();
  assert(result.includes('蓝色围巾')); assert(!result.includes('FUTURE_NOTE')); assert(!result.includes('OTHER_ROOM_PRIVATE_NOTE'));
  assert(Number.isSafeInteger(job.requestedAt));
});

test('clearing chat memory while work waits invalidates its on-demand snapshot', async t => {
  const f = fixture(t), config = f.store.config.snapshot(f.store.data);
  config.remote = { globalAdminIds: ['alice'] }; f.store.config.commit(config);
  f.receive('之后应该忘掉的原始资料。'); await f.channel.whenIdle();
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true, executionMode: 'work' });
  const job = f.channel.work.create(scope, '根据聊天写说明', undefined, { defer: true });
  f.channel.memory.clear(scope);
  let checked = false;
  f.channel.work.runner.run = async request => {
    const tool = request.memoryTools.find(tool => tool.name === 'wechat_memory'); assert(tool);
    await assert.rejects(tool.execute({ section: 'conversation' }, { signal: request.signal }), { code: 'MEMORY_CHANGED' });
    checked = true; return { text: '当前资料已清空，未使用旧内容。' };
  };
  f.channel.work.release([job.id]); await f.channel.whenIdle(); assert(checked);
});
