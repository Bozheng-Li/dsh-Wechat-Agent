import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PERSONA_PRESETS, DEFAULT_PERSONA_ID, personaFromPreset } from "../prompts/personas/catalog.mjs";
import { StateStore, WechatChannel, TaskScheduler, ConversationMemory, DshAgentRunner, ChannelError, validatePersona, personaText,
  validateConversationSettings, conversationTaskTool, webSearchTool, memoryText, simpleReminder, nextDaily,
  loadObservedMedia, observedImage, NATURAL_REPLY_RULES, REPLY_STYLE_REVIEW_NOTE, needsConversationalRewrite } from '../lib/testing.js';

const temp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const owner = 'fixture_owner', room = 'fixture-room@chatroom', other = 'other-room@chatroom';
const suppliedContext = request => JSON.stringify({ memory: request.memory, history: request.history });
function fixture(t) {
  fs.mkdirSync(temp, { recursive: true }); const root = fs.mkdtempSync(path.join(temp, 'features-'));
  const store = new StateStore(root);
  store.configure(owner, { enabled: true, groups: [room, other], privatePeers: ['alice'], prompt: '' });
  store.setPersona({ name: '小胖', aliases: ['胖胖'], prompt: '自然接话，有分寸。' });
  store.rememberConversationNames(owner, { groups: [{ id: room, name: '产品讨论组' }, { id: other, name: '产品讨论组' }] });
  let now = Date.now(), sequence = 0;
  const calls = [], sent = [], state = { online: true, account: { id: owner, nickname: '测试微信名' } };
  const runner = { run: async input => { calls.push(input); return { text: '好，就按这个来。', sessionId: 'fixture-session-' + calls.length }; },
    summarize: async () => '阿禾喜欢猫，群里约定周五讨论产品。' };
  const transport = { status: () => structuredClone(state), send: async input => { sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['fixture-ack-' + sent.length] }; } };
  transport.call = async (operation, input) => { assert.equal(operation, 'members'); return { accountId: input.accountId, peerId: input.peerId, members: [{ id: 'alice', name: '阿禾' }, { id: 'bob', name: '阿青' }] }; };
  const channel = new WechatChannel({ store, runner, transport, now: () => now, random: () => 0 });
  const scheduler = new TaskScheduler({ store, channel, now: () => now }); channel.scheduler = scheduler;
  const scope = { accountId: owner, chatType: 'group', peerId: room };
  const receive = (text, extras = {}) => { const id = 'feature-message-' + ++sequence;
    const message = { id, serverMessageId: id, direction: 'incoming', time: Math.floor(now / 1000), chatType: 'group', peerId: room,
      sender: { id: 'alice', nickname: '阿禾' }, message: [{ type: 'text', data: { text } }], ...extras }; channel.receive(message, state.account.id); return message; };
  t.after(async () => {
    await scheduler.close(); await channel.close();
    const relative = path.relative(temp, fs.realpathSync(root)); assert(relative.startsWith('features-') && !relative.includes('..'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, channel, scheduler, runner, transport, state, calls, sent, scope, receive, now: () => now, advance: ms => { now += ms; } };
}

test('the only default assistant round-trips through the global editor without losing examples or identity', t => {
  const f = fixture(t);
  assert.equal(PERSONA_PRESETS.length, 1);
  assert.equal(PERSONA_PRESETS[0].id, DEFAULT_PERSONA_ID);
  for (const preset of PERSONA_PRESETS) {
    const legacy = validatePersona(personaFromPreset(preset.id)), prompt = personaText(legacy);
    assert(prompt.includes(preset.background) && prompt.includes(preset.personality) && prompt.includes(preset.style));
    for (const example of preset.examples) assert(prompt.includes(example.message) && prompt.includes(example.reply));
    const saved = { name: '自定义名字', aliases: ['老昵称'], prompt };
    f.store.setPersona(saved); assert.deepEqual(new StateStore(f.root).persona(), saved);
  }
  const aliases = ['保留昵称'], loaded = personaFromPreset(undefined, { name: '我的 Agent', aliases }); loaded.aliases.push('草稿昵称');
  assert.deepEqual(aliases, ['保留昵称']); assert.equal(loaded.name, '我的 Agent');
  assert.throws(() => personaFromPreset('unknown'));
  for (const id of ['aci', 'xiaopang', 'xingli', 'mobai', 'beichen']) assert.throws(() => personaFromPreset(id));
});

test('advanced participation retains mention, command and nickname triggers; fixed bounds include 1 and 100', async t => {
  const f = fixture(t);
  f.store.setConversationSettings(owner, 'group', room, { mode: 'participate', intervalMode: 'fixed', fixedMessages: 100, minMessages: 1, maxMessages: 100, recordsPath: '' });
  f.receive('普通群消息');
  f.receive('小胖，这个怎么看'); await f.channel.whenIdle(); assert.equal(f.sent.length, 1);
  f.receive('/agent 看一下'); await f.channel.whenIdle(); assert.equal(f.sent.length, 2);
  f.receive('', { message: [{ type: 'at', data: { qq: owner } }, { type: 'text', data: { text: '原生提及' } }] });
  await f.channel.whenIdle(); assert.equal(f.sent.length, 3);
  assert.deepEqual(f.store.progress(owner, 'group', room), { count: 0, target: 100 });
  f.store.setConversationSettings(owner, 'group', room, { mode: 'participate', intervalMode: 'fixed', fixedMessages: 1, minMessages: 1, maxMessages: 100, recordsPath: '' });
  f.receive('换成每一条参与'); await f.channel.whenIdle(); assert.equal(f.sent.length, 4);
  assert.equal(f.calls.at(-1).mode, 'participate');
  for (const value of [0, 101, 1.5]) assert.throws(() => validateConversationSettings({ mode: 'participate', intervalMode: 'fixed', fixedMessages: value, minMessages: 1, maxMessages: 100, recordsPath: '' }));
});

test('named directories disambiguate same-named rooms and migrate renamed rooms without losing records', async t => {
  const f = fixture(t); f.receive('旧群名下的一条记录'); await f.channel.whenIdle();
  const before = f.store.conversations(owner).find(peer => peer.peerId === room);
  assert(path.basename(before.recordsPath).startsWith('产品讨论组--'));
  assert.notEqual(before.recordsPath, f.store.conversations(owner).find(peer => peer.peerId === other).recordsPath);
  const content = fs.readFileSync(path.join(before.recordsPath, 'conversation.json'), 'utf8');
  f.store.rememberConversationName(owner, 'group', room, '新群名:产品/讨论');
  const after = f.store.conversations(owner).find(peer => peer.peerId === room);
  assert(path.basename(after.recordsPath).startsWith('新群名_产品_讨论--'));
  assert.equal(fs.readFileSync(path.join(after.recordsPath, 'conversation.json'), 'utf8'), content);
  assert.equal(fs.readFileSync(path.join(before.recordsPath, 'conversation.json'), 'utf8'), content);
});

test('every reply receives room memory, including other speakers and confirmed answers, after a restart', async t => {
  const f = fixture(t);
  f.receive('另一群的未公开计划 OTHER_ROOM_SECRET。', { peerId: other });
  f.receive('我叫阿禾，喜欢猫。'); f.receive('我叫小林，喜欢狗。', { sender: { id: 'bob', nickname: '小林' } });
  f.receive('/agent 我们刚才说了什么'); await f.channel.whenIdle();
  f.receive('/agent 再接着聊'); await f.channel.whenIdle();
  assert(suppliedContext(f.calls[0]).includes('喜欢猫') && suppliedContext(f.calls[0]).includes('喜欢狗'));
  assert(suppliedContext(f.calls[1]).includes('好，就按这个来。')); assert.equal(f.calls[1].sessionId, undefined);
  assert(f.calls.every(call => !suppliedContext(call).includes('OTHER_ROOM_SECRET')));
  const restored = new ConversationMemory(new StateStore(f.root));
  assert(restored.view(f.scope).text.includes('喜欢猫'));
  assert(!restored.view({ ...f.scope, peerId: other }).text.includes('喜欢猫'));
});

test('compaction preserves concurrently appended messages and archives the exact original memory', async t => {
  const f = fixture(t), memory = f.channel.memory;
  memory.onPressure = null; memory.setWindowChars(1000);
  for (let i = 0; i < 5; i++) f.receive('阿禾喜欢猫，周五讨论产品。' + '这是原始细节。'.repeat(55));
  const before = memory.load(f.scope), originalRecords = JSON.stringify(f.store.records(owner));
  const gate = Promise.withResolvers(), reached = Promise.withResolvers();
  f.runner.summarize = async input => { assert(input.includes('原始细节')); reached.resolve(); await gate.promise; return '阿禾喜欢猫；周五讨论产品。'; };
  const pending = memory.compact(f.scope, f.runner, new AbortController().signal); await reached.promise;
  memory.append(f.scope, { key: 'new-during-compaction', text: '压缩期间的新约定：带咖啡。', direction: 'incoming', senderName: '阿禾', time: f.now() });
  gate.resolve(); await pending;
  const after = memory.view(f.scope);
  assert(after.text.includes('带咖啡') && after.text.includes('周五讨论产品')); assert(after.chars <= 1000);
  assert.equal(JSON.stringify(f.store.records(owner)), originalRecords);
  const archive = path.join(path.dirname(after.path), 'archive');
  const snapshot = JSON.parse(fs.readFileSync(path.join(archive, fs.readdirSync(archive)[0]), 'utf8'));
  assert.deepEqual(snapshot, before);
});

test('failed compaction retains raw memory; clearing during model work cannot resurrect old memory', async t => {
  const f = fixture(t), memory = f.channel.memory; memory.onPressure = null; memory.setWindowChars(1000);
  f.receive('保留这句话。'.repeat(400)); const before = memory.load(f.scope);
  f.runner.summarize = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(memory.compact(f.scope, f.runner, new AbortController().signal));
  assert.deepEqual(memory.load(f.scope), before);
  const gate = Promise.withResolvers(), reached = Promise.withResolvers();
  f.runner.summarize = async () => { reached.resolve(); await gate.promise; return '旧记忆。'; };
  const pending = memory.compact(f.scope, f.runner, new AbortController().signal); await reached.promise;
  memory.clear(f.scope); gate.resolve(); await assert.rejects(pending, { code: 'MEMORY_CHANGED' });
  f.receive('从这里开始新记忆。'); assert(!memory.view(f.scope).text.includes('保留这句话'));
  assert(memory.view(f.scope).text.includes('从这里开始新记忆'));
});

test('a requested one-minute reminder is durable and runs once with real delivery evidence', async t => {
  const f = fixture(t);
  f.store.setConversationSettings(owner, 'group', room, { mode: 'nickname', minMessages: 5, maxMessages: 20, recordsPath: '' });
  f.receive('小胖，一分钟后提醒我吃饭'); await f.channel.whenIdle();
  const task = f.scheduler.list(owner).tasks[0]; assert(task); assert.equal(task.nextRunAt, f.now() + 60000);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].mode, 'confirmation');
  assert.deepEqual(f.calls[0].tools, []);
  assert.equal(f.calls[0].persona.name, '小胖');
  const saved = JSON.parse(f.calls[0].text).savedTask;
  assert.equal(saved.id, task.id); assert.equal(saved.when, new Date(task.nextRunAt).toISOString());
  assert(saved.content.includes('吃饭'));
  assert(f.sent[0].message[0].data.text.includes('提醒你：吃饭。'), 'the receipt retains the saved audience and activity');
  assert(!f.sent[0].message[0].data.text.includes('一分钟后'), 'an absolute deadline remains correct after generation latency');
  assert.equal(new TaskScheduler({ store: f.store, channel: f.channel, now: f.now }).list(owner).tasks.length, 1);
  f.advance(59999); await f.scheduler.tick(); assert.equal(f.sent.length, 1);
  f.advance(1); await f.scheduler.tick(); assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1].message[0], { type: 'at', data: { qq: 'alice', name: '阿禾' } });
  assert(f.sent[1].message.find(segment => segment.type === 'text').data.text.includes('吃饭'));
  assert.equal(f.scheduler.list(owner).tasks[0].state, 'completed');
  assert.deepEqual(f.scheduler.list(owner).runs[0].acknowledgedMessageIds, ['fixture-ack-2']);
  await f.scheduler.tick(); assert.equal(f.sent.length, 2);
});

test('scheduled delivery stays pending offline, and revoked peers or other accounts are never sent to', async t => {
  const f = fixture(t);
  f.scheduler.create({ kind: 'message', content: '待发送', schedule: { kind: 'once', at: f.now() + 1000 } }, f.scope);
  f.advance(1000); f.state.online = false; await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  f.state.online = true; f.state.account.id = 'other-account'; await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  f.state.account.id = owner; f.store.configure(owner, { ...f.store.settings(owner), groups: [other] });
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  f.store.configure(owner, { ...f.store.settings(owner), groups: [room, other] });
  await f.scheduler.tick(); assert.equal(f.sent.length, 1);
});

test('uncertain scheduled sends are paused and never automatically retried after restart', async t => {
  const f = fixture(t);
  f.transport.send = async () => { throw new ChannelError('SEND_UNKNOWN', '结果不明', { delivery: 'unknown' }); };
  f.scheduler.create({ kind: 'message', content: '只发一次', schedule: { kind: 'interval', minutes: 1 } }, f.scope);
  f.advance(60000); await f.scheduler.tick();
  const task = f.scheduler.list(owner).tasks[0]; assert.equal(task.state, 'paused'); assert.equal(task.lastState, 'unknown');
  const restored = new TaskScheduler({ store: f.store, channel: f.channel, now: f.now });
  await restored.tick(); assert.equal(restored.list(owner).runs.length, 1);
  assert.throws(() => restored.resume(task.id, { accountId: owner }), { code: 'TASK_CHANGED' });
});

test('chat tools bind creator and room, reject history-only requests, and deduplicate repeated tool calls', async t => {
  const f = fixture(t), scope = { ...f.scope, source: 'chat', senderId: 'alice', senderName: '阿禾', requestKey: 'source-message', requestedAt: f.now() };
  const exec = { signal: new AbortController().signal };
  const tool = conversationTaskTool(f.scheduler, scope, () => {}, '五分钟后提醒我喝水');
  const args = { action: 'create', kind: 'message', content: '喝水', delaySeconds: 300 };
  const first = JSON.parse(await tool.execute(args, exec)); assert(first.ok);
  assert.equal(JSON.parse(await tool.execute(args, exec)).task.id, first.task.id);
  const otherSpeaker = conversationTaskTool(f.scheduler, { ...scope, senderId: 'bob' }, () => {}, '取消任务');
  assert.equal(JSON.parse(await otherSpeaker.execute({ action: 'cancel', taskId: first.task.id }, exec)).ok, false);
  const passive = conversationTaskTool(f.scheduler, scope, () => {}, '今天吃什么');
  assert.equal(JSON.parse(await passive.execute(args, exec)).ok, false);
  for (const text of ['请翻译“一分钟后提醒我吃饭”', '请翻译一分钟后提醒我吃饭', '如果我说五分钟后提醒我喝水会怎样', '不要帮我设置五分钟后的提醒', '> 五分钟后提醒我喝水']) {
    assert.equal(JSON.parse(await conversationTaskTool(f.scheduler, scope, () => {}, text).execute(args, exec)).ok, false, text);
  }
  const quotedCancel = conversationTaskTool(f.scheduler, scope, () => {}, '把“取消任务”翻译成英文');
  assert.equal(JSON.parse(await quotedCancel.execute({ action: 'cancel', taskId: first.task.id }, exec)).ok, false);
  assert.equal(f.scheduler.list(owner).tasks.length, 1);
});

test('one-time task requests stay idempotent even when retried after their due time', t => {
  const f = fixture(t), input = { kind: 'message', content: '不要重复创建', schedule: { kind: 'once', at: f.now() + 1000 } }, scope = { ...f.scope, requestKey: 'ui-idempotency' };
  const first = f.scheduler.create(input, scope); f.advance(5000);
  assert.equal(f.scheduler.create(input, scope).id, first.id);
});

test('task idempotency is room-bound and cancellation preserves an already completed result', async t => {
  const f = fixture(t), input = { kind: 'message', content: '同样的内容', schedule: { kind: 'once', at: f.now() + 1000 } };
  const first = f.scheduler.create(input, { ...f.scope, requestKey: 'same-ui-key' });
  const second = f.scheduler.create(input, { ...f.scope, peerId: other, requestKey: 'same-ui-key' });
  assert.notEqual(first.id, second.id);
  f.advance(1000); await f.scheduler.tick();
  assert.throws(() => f.scheduler.cancel(first.id, { accountId: owner }, true), { code: 'TASK_CHANGED' });
  assert.equal(f.scheduler.list(owner).tasks.find(task => task.id === first.id).state, 'completed');
});

test('daily schedules use the declared timezone and overdue repeats coalesce into one reminder', async t => {
  assert.equal(new Date(nextDaily('08:30', Date.parse('2026-11-06T01:00:00Z'))).toISOString(), '2026-11-07T00:30:00.000Z');
  assert(simpleReminder('小胖，半小时后提醒我休息', ['小胖'], 1000)?.schedule.at === 1801000);
  assert.equal(simpleReminder('请翻译“一分钟后提醒我吃饭”', ['小胖'], 1000), null);
  const f = fixture(t); f.scheduler.create({ kind: 'message', content: '周期', schedule: { kind: 'interval', minutes: 1 } }, f.scope);
  f.advance(20 * 60000); await f.scheduler.tick(); assert.equal(f.sent.length, 1);
  assert(f.scheduler.list(owner).tasks[0].nextRunAt > f.now());
  await f.scheduler.tick(); assert.equal(f.sent.length, 1);
});

test('actual image bytes are message-bound, untrusted filesystem paths are not accepted, and emoji URLs are retained', async t => {
  const f = fixture(t), directory = path.join(f.root, 'media'); fs.mkdirSync(directory);
  const resourceId = 'a'.repeat(64), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5T8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(directory, resourceId + '.json'), JSON.stringify({ messageId: room + ':image-1', inlineBytes: png.length, resources: [] }));
  fs.writeFileSync(path.join(directory, resourceId + '.image'), png);
  const input = { directory, peerId: room, messageId: 'image-1', resourceId, signal: new AbortController().signal };
  const image = await loadObservedMedia(input); assert.equal(image.mediaType, 'image/png'); assert.equal(image.data, png.toString('base64'));
  await assert.rejects(loadObservedMedia({ ...input, peerId: other }), { code: 'IMAGE_OWNER_MISMATCH' });
  await assert.rejects(loadObservedMedia({ ...input, resourceId: '../../secrets' }), { code: 'IMAGE_ID_INVALID' });
  const emoji = observedImage([], '<msg><emoji cdnurl="https://emoji.qpic.cn/example.gif" /></msg>', directory, room + ':emoji-1');
  assert.equal(emoji.type, 'face');
  const meta = JSON.parse(fs.readFileSync(path.join(directory, emoji.data.resourceId + '.json'), 'utf8')); assert.equal(meta.resources[0].reference, 'https://emoji.qpic.cn/example.gif');
});

test('vision descriptions survive restart and enter subsequent model memory without being confused with another room', async t => {
  const f = fixture(t), png = { data: 'fixture', mediaType: 'image/png' }, resourceId = createHash('sha256').update('fixture').digest('hex');
  f.transport.media = async input => { assert.equal(input.peerId, room); return png; };
  f.runner.describeImage = async image => { assert.deepEqual(image, png); return '一只橘猫趴在蓝色椅子上，图中文字是“今天休息”。'; };
  f.receive('', { message: [{ type: 'image', data: { resourceId, file: 'never-read-directly' } }] });
  await f.channel.whenIdle();
  const source = f.channel.memory.load(f.scope).entries[0];
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal, { imageRequest: { key: source.key, resourceId } });
  f.receive('/agent 刚才图里的猫在哪'); await f.channel.whenIdle();
  assert(suppliedContext(f.calls.at(-1)).includes('蓝色椅子'));
  assert(new ConversationMemory(new StateStore(f.root)).view(f.scope).text.includes('今天休息'));
  assert(!f.channel.memory.view({ ...f.scope, peerId: other }).text.includes('蓝色椅子'));
});

test('failed image understanding is explicitly retryable and successful retries replace stale errors', async t => {
  const f = fixture(t), resourceId = createHash('sha256').update('retry-fixture').digest('hex');
  let attempts = 0;
  f.transport.media = async () => ({ data: 'fixture', mediaType: 'image/png' });
  f.runner.describeImage = async () => { if (++attempts === 1) throw new ChannelError('MODEL_UNAVAILABLE', '图像模型暂时不可用'); return '图片是一只困得打哈欠的猫。'; };
  f.receive('', { message: [{ type: 'image', data: { resourceId } }] }); await f.channel.whenIdle();
  assert.equal(attempts, 0);
  const source = f.channel.memory.load(f.scope).entries[0];
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal, { imageRequest: { key: source.key, resourceId } });
  assert.equal(f.channel.memory.view(f.scope).failedImages, 1);
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal);
  assert.equal(attempts, 1, 'failed images must not consume another model request on every chat message');
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal, { retryFailed: true });
  const doc = f.channel.memory.view(f.scope);
  assert.equal(attempts, 2); assert.equal(doc.failedImages, 0); assert(doc.text.includes('打哈欠的猫') && !doc.text.includes('模型暂时不可用'));
});

test('thumbnail notes keep their limits across restart and explicit retries replace them with original-image notes', async t => {
  const f = fixture(t), resourceId = createHash('sha256').update('thumbnail-upgrade-fixture').digest('hex');
  let quality = 'thumbnail', descriptions = 0, downloads = 0;
  f.transport.media = async input => { downloads++; if (downloads > 1) assert.equal(input.preferOriginal, true); return { data: 'fixture', mediaType: 'image/png', quality, bytes: quality === 'original' ? 200000 : 3000 }; };
  f.runner.describeImage = async image => { descriptions++; return image.quality === 'thumbnail' ? '一张截图，小字看不清。' : '截图上明确写着“周五 14:30”。'; };
  f.channel.imageMemory.configure(f.scope, { enabled: false, retentionDays: 30 });
  f.receive('', { message: [{ type: 'image', data: { resourceId } }] }); await f.channel.whenIdle();
  const source = f.channel.memory.load(f.scope).entries[0];
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal, { imageRequest: { key: source.key, resourceId } });
  assert.equal(f.channel.memory.view(f.scope).lowQualityImages, 1);
  assert.match(new ConversationMemory(new StateStore(f.root)).view(f.scope).text, /缩略图/);
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal);
  assert.equal(downloads, 1, 'normal messages do not continuously retry unavailable originals');
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal, { retryFailed: true });
  assert.equal(descriptions, 1, 'an unchanged thumbnail does not consume another vision model request');
  quality = 'original';
  await f.channel.memory.enrich(f.scope, f.runner, f.transport, new AbortController().signal, { retryFailed: true });
  const doc = new ConversationMemory(new StateStore(f.root)).view(f.scope), image = doc.entries[0].attachments[0];
  assert.equal(doc.lowQualityImages, 0); assert.equal(image.quality, 'original'); assert.equal(image.imageBytes, 200000); assert.equal(image.error, undefined);
  assert.match(doc.text, /14:30/); assert(!doc.text.includes('小字看不清')); assert.equal(descriptions, 2);
});

test('image understanding prompts identify each thumbnail without treating it as a verified original', async () => {
  const runner = new DshAgentRunner({}), requests = [];
  runner.run = async request => { requests.push(request); return { text: request.images.length === 1 ? '图像笔记' : '["原图笔记","缩略图笔记"]' }; };
  await runner.describeImage({ quality: 'thumbnail' }, new AbortController().signal);
  assert.match(requests[0].text, /仅取得微信缩略图/);
  await runner.describeImages([{ quality: 'original' }, { quality: 'thumbnail' }], new AbortController().signal);
  assert.match(requests[1].text, /第 1 张：已取得原图/); assert.match(requests[1].text, /第 2 张：仅取得微信缩略图/);
});

test('natural-reply defaults precede the persona and mechanically worded chat remains deliverable with a review note', async () => {
  const answerText = '按聊天里能确定的：阿禾就是刚才问问题的那位。';
  const prompts = [], messages = [], answers = [answerText];
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'chat' }) },
    agents: { create: async options => {
      options.setup({ tools: { restrict() {}, guard() {}, register() {} }, systemPrompt: { suppressRuntimeContext() {}, section: value => prompts.push(value.text) }, on() {} });
      const answer = answers.shift();
      return { agent: { session: { seq: 0, snapshotEvents: () => [{ type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: answer }] } } }, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } }] },
        followup: value => messages.push(value), whenIdle: async () => {}, cancel() {} }, dispose: async () => {} };
    } } };
  const result = await new DshAgentRunner(ctx, () => null, () => ({ persona: { name: '阿衡', prompt: '每次都写一份正式报告' } })).run({ text: '阿禾是谁', memory: '阿禾刚才问过一个问题。', signal: new AbortController().signal });
  assert.equal(result.text, answerText); assert.equal(messages.length, 1);
  assert.equal(result.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.equal(prompts[0].split(NATURAL_REPLY_RULES).length, 2); assert(prompts[0].indexOf(NATURAL_REPLY_RULES) < prompts[0].indexOf('每次都写一份正式报告'));
  assert.equal(needsConversationalRewrite('# 第一条\n你好'), true);
  assert.equal(needsConversationalRewrite('# 分析\n细节', '请给我分析和步骤'), false);
  assert.equal(needsConversationalRewrite('1. 可以确认的关系\n2. 未知的信息', '阿禾是谁'), true);
  assert.equal(needsConversationalRewrite('**结论**：很高兴回答你的问题', '你好'), true);
  assert.equal(needsConversationalRewrite('1. 打开设置\n2. 保存配置', '怎么配置这个软件'), false);
});

test('DSH search only receives a bounded explicit query and reports missing search configuration honestly', async () => {
  const calls = [], exec = { signal: new AbortController().signal };
  const tool = webSearchTool(() => ({ search: async request => { calls.push(request); return { content: '公开天气资料', sources: [{ title: '天气', url: 'https://example.com/weather' }] }; } }));
  const result = JSON.parse(await tool.execute({ query: '上海明天天气' }, exec));
  assert.equal(result.ok, true); assert.deepEqual(calls, [{ query: '上海明天天气', maxResults: 5 }]);
  assert.equal(JSON.parse(await tool.execute({ query: '过长'.repeat(300) }, exec)).ok, false);
  assert.equal(JSON.parse(await webSearchTool(() => null).execute({ query: '天气' }, exec)).ok, false);
});
