import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, WechatChannel, TaskScheduler, LongTermMemory, ChannelError } from '../lib/testing.js';

const temporary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const owner = 'scheduled_fixture_owner', room = 'scheduled_room@chatroom', other = 'scheduled_other@chatroom';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC';
const freshSignal = () => new AbortController().signal;
const source = (key, text, time) => ({ key, text, time, direction: 'incoming', senderId: 'alice', senderName: '阿禾' });

async function fixture(t, { seedLongMemory = false } = {}) {
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, 'scheduled-features-'));
  const store = new StateStore(root);
  const settings = { enabled: true, groups: [room, other], privatePeers: [], prompt: '' };
  store.configure(owner, settings);
  store.setPersona({ name: '小胖', aliases: [], prompt: '自然接话，有分寸。' });
  store.rememberConversationNames(owner, { groups: [{ id: room, name: '吃饭提醒组' }, { id: other, name: '别的群' }] });
  let stamp = Date.parse('2026-11-06T06:00:00Z'), sequence = 0;
  const now = () => stamp, scope = { accountId: owner, chatType: 'group', peerId: room };
  const longMemory = new LongTermMemory(store, { now });
  if (seedLongMemory) {
    const original = longMemory.view(owner);
    longMemory.edit(owner, original.markdown.slice(0, original.globalRange.start) + '\n共同约定：重要提醒直接说明时间。\n' + original.markdown.slice(original.globalRange.end), original.revision);
    for (const [selector, text] of [[scope, '阿禾对花生过敏，吃饭时应避免花生。'], [{ ...scope, peerId: other }, '另一个群在讨论秘密生日礼物。']]) {
      longMemory.capture(selector, [source('seed-' + selector.peerId, text, stamp)]);
      await longMemory.extract(selector, { run: async () => ({ text: JSON.stringify({ facts: [{ text, sources: ['s1'], replaces: [] }] }) }) }, freshSignal());
    }
  }
  const sent = [], calls = [], state = { online: true, account: { id: owner, nickname: '测试微信' } };
  const runner = { run: async input => { calls.push(input); return { text: '该吃饭啦。' }; } };
  const transport = { status: () => structuredClone(state), send: async input => { sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['scheduled-ack-' + sent.length] }; } };
  const channel = new WechatChannel({ store, runner, transport, longMemory, now, random: () => 0 });
  const scheduler = new TaskScheduler({ store, channel, now }); channel.scheduler = scheduler;
  const create = (kind = 'agent', content = '提醒阿禾吃饭', extraScope = {}) => scheduler.create({ kind, content, schedule: { kind: 'once', at: stamp + 1000 } }, { ...scope, ...extraScope });
  const receive = text => {
    const id = 'scheduled-input-' + ++sequence;
    channel.receive({ id, serverMessageId: id, direction: 'incoming', time: Math.floor(stamp / 1000), chatType: 'group', peerId: room,
      sender: { id: 'alice', nickname: '阿禾' }, message: [{ type: 'text', data: { text } }] }, owner);
  };
  const media = () => {
    const result = channel.library.import(owner, { name: '吃饭提醒.png', kind: 'image', data: png });
    channel.library.edit(owner, result.assetIds[0], { description: '用于提醒吃饭的一张图片', tags: ['提醒', '吃饭'] });
    channel.library.configure(owner, { enabled: true, probability: 100, minGapMessages: 0 });
    return result.assetIds[0];
  };
  t.after(async () => {
    await scheduler.close(); await channel.close();
    const resolved = fs.realpathSync(root), relative = path.relative(fs.realpathSync(temporary), resolved);
    assert(relative.startsWith('scheduled-features-') && !relative.includes('..') && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, settings, scope, longMemory, channel, scheduler, runner, transport, state, sent, calls, now, create, receive, media,
    advance: milliseconds => { stamp += milliseconds; }, task: id => scheduler.list(owner).tasks.find(task => task.id === id),
    record: id => store.data.records.find(record => record.taskId === id) };
}

test('scheduled Agent reads durable facts and scoped memory, selects an image, and waits for ACK before completion', async t => {
  const f = await fixture(t, { seedLongMemory: true }), assetId = f.media();
  f.channel.memory.append(f.scope, source('recent-lunch', '今天中午想吃面。', f.now()));
  await f.channel.whenIdle();
  f.runner.run = async input => {
    f.calls.push(input);
    assert.equal(input.mode, 'scheduled');
    assert(input.memory.includes('对花生过敏') && input.memory.includes('今天中午想吃面') && input.memory.includes('重要提醒直接说明时间'));
    assert(!input.memory.includes('秘密生日礼物'));
    assert.deepEqual(input.tools.map(tool => tool.name), ['wechat_reply_media']);
    const tool = input.tools[0], execution = { signal: input.signal };
    const matches = JSON.parse(await tool.execute({ action: 'search', query: '吃饭' }, execution));
    assert.equal(matches.ok, true); assert.equal(matches.assets[0].id, assetId);
    assert.equal(JSON.parse(await tool.execute({ action: 'select', assetId: '../another-account', caption: '' }, execution)).ok, false);
    const selection = JSON.parse(await tool.execute({ action: 'select', assetId, caption: '阿禾，该吃饭啦，记得避开花生。' }, execution));
    assert.equal(selection.ok, true); assert.equal(selection.sent, false); assert.equal(f.sent.length, 0);
    return { text: '这一段最终正文不应重复发送。' };
  };
  const reached = Promise.withResolvers(), ack = Promise.withResolvers();
  f.transport.send = async input => { f.sent.push(input); reached.resolve(); await ack.promise; return { delivery: 'server-ack', serverMessageIds: ['image-caption-ack'] }; };
  const task = f.create('agent', '根据饮食偏好提醒阿禾吃饭，配图'); f.advance(1000);
  const running = f.scheduler.tick();
  try {
    await reached.promise;
    assert.equal(f.task(task.id).state, 'running'); assert.equal(f.record(task.id).state, 'sending');
    assert.equal(f.store.history(owner, 'group', room).filter(entry => entry.direction === 'outgoing').length, 0);
  } finally { ack.resolve(); await running; }
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], { accountId: owner, chatType: 'group', peerId: room, message: [
    { type: 'text', data: { text: '阿禾，该吃饭啦，记得避开花生。' } },
    { type: 'image', data: { base64: png, mediaType: 'image/png' } },
  ] });
  assert.equal(f.task(task.id).state, 'completed'); assert.equal(f.record(task.id).state, 'sent');
  assert.deepEqual(f.scheduler.list(owner).runs[0].acknowledgedMessageIds, ['image-caption-ack']);
  await f.scheduler.tick(); assert.equal(f.sent.length, 1);
});

test('cancelling generation prevents delivery and keeps local and pending durable memory sources', async t => {
  const f = await fixture(t), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.channel.memory.append(f.scope, source('unextracted-allergy', '我叫阿禾，对花生过敏。', f.now())); await f.channel.whenIdle();
  assert.equal(f.longMemory.view(owner).pendingCount, 1);
  f.runner.run = async input => { reached.resolve(input); await gate.promise; return { text: '这条取消后的回复不能发送。' }; };
  const task = f.create(); f.advance(1000); const running = f.scheduler.tick();
  try { await reached.promise; f.scheduler.cancel(task.id, { accountId: owner }, true); }
  finally { gate.resolve(); await running; }
  assert.equal(f.sent.length, 0); assert.equal(f.task(task.id).state, 'cancelled'); assert.equal(f.record(task.id).state, 'cancelled');
  assert(f.channel.memory.view(f.scope).text.includes('对花生过敏'));
  assert(!f.channel.memory.view(f.scope).text.includes('取消后的回复'));
  const restored = new LongTermMemory(f.store);
  assert.equal(restored.view(owner).pendingCount, 1);
  await restored.extract(f.scope, { run: async input => { assert(input.text.includes('我叫阿禾，对花生过敏')); return { text: JSON.stringify({ facts: [{ text: '阿禾对花生过敏。', sources: ['s1'], replaces: [] }] }) }; } }, freshSignal());
  assert(restored.prompt(f.scope).includes('阿禾对花生过敏'));
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
});

test('revoking authorization during generation stops delivery and a later reauthorization does not replay it', async t => {
  const f = await fixture(t), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.runner.run = async () => { reached.resolve(); await gate.promise; return { text: '已撤权的任务不能发出去。' }; };
  const task = f.create(); f.advance(1000); const running = f.scheduler.tick();
  try { await reached.promise; f.store.configure(owner, { ...f.settings, groups: [other] }); }
  finally { gate.resolve(); await running; }
  assert.equal(f.sent.length, 0); assert.equal(f.task(task.id).state, 'paused'); assert.equal(f.task(task.id).lastState, 'cancelled');
  f.store.configure(owner, f.settings); await f.scheduler.tick(); assert.equal(f.sent.length, 0);
});

test('tasks becoming overdue in the channel queue never send a stale reminder', async t => {
  const f = await fixture(t), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.runner.run = async () => { reached.resolve(); await gate.promise; return { text: '旧回复。' }; };
  f.receive('/agent 先处理这条消息'); await reached.promise;
  const task = f.create('message'); f.advance(1000); const running = f.scheduler.tick();
  try {
    assert(f.channel.queue.some(item => item.scheduled?.id === task.id));
    f.advance(600001);
  } finally { gate.resolve(); await running; await f.channel.whenIdle(); }
  assert.equal(f.sent.length, 0); assert.equal(f.task(task.id).state, 'paused'); assert.equal(f.record(task.id).state, 'cancelled');
  assert.match(f.record(task.id).reason, /等待.*(?:十分钟|过长)/u);
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
});

test('revoked or offline tasks stay pending until expiry without creating a delivery attempt', async t => {
  const f = await fixture(t), revoked = f.create('message', '撤权任务');
  f.store.configure(owner, { ...f.settings, groups: [other] }); f.advance(1000); await f.scheduler.tick();
  assert.equal(f.task(revoked.id).state, 'pending'); assert.equal(f.scheduler.list(owner).runs.length, 0);
  f.advance(600001); await f.scheduler.tick(); assert.equal(f.task(revoked.id).state, 'expired');
  f.store.configure(owner, f.settings); const offline = f.create('message', '离线任务'); f.state.online = false;
  f.advance(1000); await f.scheduler.tick(); assert.equal(f.task(offline.id).state, 'pending');
  f.advance(600001); await f.scheduler.tick(); assert.equal(f.task(offline.id).state, 'expired');
  f.state.online = true; await f.scheduler.tick();
  assert.equal(f.sent.length, 0); assert.equal(f.scheduler.list(owner).runs.length, 0);
});

for (const [label, outcome, expectedState, expectedIds] of [
  ['missing ACK', () => undefined, 'unknown', []],
  ['invalid zero ACK', () => ({ delivery: 'server-ack', serverMessageIds: ['0'] }), 'unknown', []],
  ['transport unknown', () => { throw new ChannelError('SEND_UNKNOWN', '网络返回不明', { delivery: 'unknown' }); }, 'unknown', []],
  ['partial image delivery', () => { throw new ChannelError('SEND_PARTIAL', '文字已确认，图片结果不明', { delivery: 'unknown', acknowledgedMessageIds: ['caption-only-ack'] }); }, 'partial', ['caption-only-ack']],
]) test(`${label} pauses the task, preserves delivery truth and never replays after restart`, async t => {
  const f = await fixture(t); let attempts = 0;
  f.transport.send = async () => { attempts++; return outcome(); };
  const task = f.create('message'); f.advance(1000); await f.scheduler.tick();
  assert.equal(attempts, 1); assert.equal(f.task(task.id).state, 'paused'); assert.equal(f.task(task.id).lastState, expectedState);
  assert.equal(f.record(task.id).state, expectedState); assert.deepEqual(f.scheduler.list(owner).runs[0].acknowledgedMessageIds, expectedIds);
  assert.equal(f.store.history(owner, 'group', room).filter(entry => entry.direction === 'outgoing').length, 0);
  await f.scheduler.tick();
  const restarted = new TaskScheduler({ store: new StateStore(f.root), channel: f.channel, now: f.now });
  try {
    await restarted.tick(); assert.equal(attempts, 1);
    assert.throws(() => restarted.resume(task.id, { accountId: owner }), { code: 'TASK_CHANGED' });
    assert.equal(restarted.list(owner).tasks[0].lastState, expectedState);
  } finally { await restarted.close(); }
});

test('a genuine server ACK arriving after cancellation remains recorded without rescheduling', async t => {
  const f = await fixture(t), reached = Promise.withResolvers(), ack = Promise.withResolvers();
  f.transport.send = async (input, signal) => { f.sent.push(input); reached.resolve(signal); await ack.promise; return { delivery: 'server-ack', serverMessageIds: ['late-but-real-ack'] }; };
  const task = f.create('message'); f.advance(1000); const running = f.scheduler.tick();
  try {
    const signal = await reached.promise; f.scheduler.cancel(task.id, { accountId: owner }, true); assert.equal(signal.aborted, true);
    assert.equal(f.record(task.id).state, 'sending');
  } finally { ack.resolve(); await running; }
  assert.equal(f.task(task.id).state, 'cancelled'); assert.equal(f.task(task.id).lastState, 'sent');
  assert.equal(f.record(task.id).state, 'sent'); assert.deepEqual(f.record(task.id).acknowledgedMessageIds, ['late-but-real-ack']);
  assert.equal(f.scheduler.list(owner).runs[0].state, 'sent');
  assert.deepEqual(f.scheduler.list(owner).runs[0].acknowledgedMessageIds, ['late-but-real-ack']);
  assert.equal(f.store.history(owner, 'group', room).filter(entry => entry.direction === 'outgoing').length, 1);
  await f.scheduler.tick(); assert.equal(f.sent.length, 1);
});

for (const action of ['cancel', 'revoke']) test(`${action} while an image is being prepared stops the send boundary`, async t => {
  const f = await fixture(t), assetId = f.media(), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.runner.run = async input => {
    const result = JSON.parse(await input.tools.find(tool => tool.name === 'wechat_reply_media').execute({ action: 'select', assetId, caption: '吃饭啦。' }, { signal: input.signal }));
    assert.equal(result.ok, true); return { text: '' };
  };
  const prepare = f.channel.library.prepareSendContent.bind(f.channel.library);
  f.channel.library.prepareSendContent = async (...args) => { const image = await prepare(...args); reached.resolve(); await gate.promise; return image; };
  const task = f.create('agent', '提醒吃饭，配图'); f.advance(1000); const running = f.scheduler.tick();
  try {
    await reached.promise;
    if (action === 'cancel') f.scheduler.cancel(task.id, { accountId: owner }, true);
    else f.store.configure(owner, { ...f.settings, enabled: false });
  } finally { gate.resolve(); await running; }
  assert.equal(f.sent.length, 0); assert.equal(f.record(task.id).state, 'cancelled');
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
});
