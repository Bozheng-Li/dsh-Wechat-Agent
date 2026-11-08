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

test('confirmed owner operation deduplication survives restart and stays inside its account and conversation', async t => {
  const f = await fixture(t), operationKey = 'digest:confirmed-summary:confirmed-todo';
  const original = f.create('message', '第一次确认的内容', { source: 'owner', operationKey });
  await f.scheduler.close();
  const restored = new TaskScheduler({ store: f.store, channel: f.channel, now: f.now });
  t.after(() => restored.close());
  const input = { kind: 'message', content: '改了时间后重试', schedule: { kind: 'once', at: f.now() + 60000 } };
  const again = restored.create(input, { ...f.scope, source: 'owner', operationKey });
  assert.equal(again.id, original.id); assert.equal(again.schedule.at, original.schedule.at); assert.equal(again.content, original.content);
  const otherRoom = restored.create(input, { ...f.scope, peerId: other, source: 'owner', operationKey });
  assert.notEqual(otherRoom.id, original.id);
  f.store.configure('another-scheduler-owner', { enabled: true, groups: [room], privatePeers: [], prompt: '' });
  const otherAccount = restored.create(input, { ...f.scope, accountId: 'another-scheduler-owner', source: 'owner', operationKey });
  assert.notEqual(otherAccount.id, original.id);
  const chat = restored.create(input, { ...f.scope, source: 'chat', senderId: 'alice', operationKey });
  assert.notEqual(chat.id, original.id); assert.equal(chat.operationKey, undefined);
  restored.cancel(original.id, f.scope, true);
  assert.equal(restored.create(input, { ...f.scope, source: 'owner', operationKey }).state, 'cancelled', 'a reconciliation cannot revive a cancelled task');
  assert.equal(f.sent.length, 0);
});

test('scheduled Agent reads durable facts and scoped memory, selects an image, and waits for ACK before completion', async t => {
  const f = await fixture(t, { seedLongMemory: true }), assetId = f.media();
  f.channel.memory.append(f.scope, source('recent-lunch', '今天中午想吃面。', f.now()));
  await f.channel.whenIdle();
  f.runner.run = async input => {
    f.calls.push(input);
    assert.equal(input.mode, 'scheduled');
    const context = JSON.stringify({ history: input.history, memory: input.memory });
    assert(context.includes('对花生过敏') && context.includes('今天中午想吃面'));
    assert(input.adminNotes.includes('重要提醒直接说明时间'));
    assert(!context.includes('秘密生日礼物'));
    assert.deepEqual(input.tools.map(tool => tool.name), ['wechat_reply_media', 'wechat_memory']);
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
    await Promise.race([reached.promise, running.then(() => { throw new Error('Scheduled reply ended before reaching the transport'); })]);
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

test('revoking authorization during generation blocks delivery, with retry waiting for restored authorization', async t => {
  const f = await fixture(t), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.runner.run = async () => { reached.resolve(); await gate.promise; return { text: '已撤权的任务不能发出去。' }; };
  const task = f.create(); f.advance(1000); const running = f.scheduler.tick();
  try { await reached.promise; f.store.configure(owner, { ...f.settings, groups: [other] }); }
  finally { gate.resolve(); await running; }
  assert.equal(f.sent.length, 0); assert.equal(f.task(task.id).state, 'pending'); assert.equal(f.task(task.id).lastState, 'cancelled');
  f.store.configure(owner, f.settings); await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.sent.length, 1); assert.equal(f.task(task.id).state, 'completed');
});

for (const failure of ['model', 'memory', 'timeout', 'empty']) test(`saved agent reminder uses an acknowledged fallback when ${failure} fails before sending`, async t => {
  const f = await fixture(t); let observedModelTimeout = false;
  if (failure === 'memory') f.channel.memory.enrich = async () => { throw new ChannelError('MEMORY_INVALID', '合成记忆无法读取'); };
  else if (failure === 'timeout') {
    f.channel.timeoutMs = 10;
    f.runner.run = async input => { await new Promise((resolve, reject) => {
      // The synthetic model has no socket. Keep this wait alive while the
      // production timeout is unref'ed, and fail if that timeout never fires.
      const watchdog = setTimeout(() => {
        input.signal.removeEventListener('abort', aborted);
        reject(new Error('The model timeout did not abort the synthetic request'));
      }, 1000);
      function aborted() {
        clearTimeout(watchdog);
        observedModelTimeout = input.signal.reason?.code === 'MODEL_TIMEOUT';
        reject(input.signal.reason);
      }
      if (input.signal.aborted) aborted();
      else input.signal.addEventListener('abort', aborted, { once: true });
    }); };
  } else f.runner.run = async () => { if (failure === 'empty') return { text: '' }; throw new ChannelError('MODEL_INCOMPLETE', '模型未完成'); };
  const task = f.create('agent', '下午三点核对会议材料'); f.advance(1000); await f.scheduler.tick();
  if (failure === 'timeout') assert(observedModelTimeout, 'The actual channel deadline must trigger the fallback');
  assert.equal(f.sent.length, 1); assert.equal(f.task(task.id).state, 'completed');
  assert(f.sent[0].message[0].data.text.includes(task.content)); assert(f.sent[0].message[0].data.text.includes('未能生成'));
  assert(f.record(task.id).taskFallback); assert.equal(f.record(task.id).state, 'sent');
  assert.deepEqual(f.record(task.id).acknowledgedMessageIds, ['scheduled-ack-1']);
  await f.scheduler.tick(); assert.equal(f.sent.length, 1);
});

test('definite unsent failure retries the same draft after delay without regenerating or falsely completing', async t => {
  const f = await fixture(t); let models = 0, sends = 0;
  f.runner.run = async () => ({ text: '原定内容，保留全部正文。' + ++models });
  f.transport.send = async input => {
    sends++; if (sends === 1) throw new ChannelError('SEND_REJECTED', '合成明确未发送', { delivery: 'rejected' });
    f.sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['retry-ack'] };
  };
  const task = f.create(); f.advance(1000); await f.scheduler.tick();
  assert.equal(f.task(task.id).state, 'pending'); assert.equal(f.task(task.id).lastState, 'failed'); assert.equal(f.sent.length, 0);
  await f.scheduler.tick(); assert.equal(sends, 1);
  f.advance(60000); await f.scheduler.tick();
  assert.equal(models, 1); assert.equal(sends, 2); assert.equal(f.sent[0].message[0].data.text, '原定内容，保留全部正文。1');
  assert.equal(f.task(task.id).state, 'completed');
});

test('a saved reminder still executes after all related memory expires', async t => {
  const f = await fixture(t, { seedLongMemory: true });
  const task = f.create('message', '核对一个月后的合同'); f.advance(31 * 86400000);
  assert.equal(f.longMemory.adminNotes(f.scope), ''); assert.equal(f.longMemory.view(owner).factCount, 0);
  await f.scheduler.tick(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message[0].data.text, task.content);
});

test('restart recovers only reminders interrupted before send and coalesces missed recurring periods', async t => {
  const f = await fixture(t);
  const task = f.scheduler.create({ kind: 'message', content: '重复提醒', schedule: { kind: 'interval', minutes: 1 } }, f.scope);
  const original = f.scheduler.data.tasks[0]; original.state = 'running'; original.recordKey = 'scheduled:pre-send-crash'; f.scheduler.save();
  f.store.add({ key: original.recordKey, contextKey: 'isolated', accountId: owner, chatType: 'group', peerId: room, messageId: original.recordKey, state: 'generating', createdAt: f.now(), updatedAt: f.now() });
  const restored = new TaskScheduler({ store: f.store, channel: f.channel, now: f.now }); f.channel.scheduler = restored;
  t.after(() => restored.close()); f.advance(3 * 86400000); await restored.tick();
  assert.equal(f.sent.length, 1); assert.equal(restored.list(owner).tasks[0].state, 'pending');
  assert(restored.list(owner).tasks[0].nextRunAt > f.now()); await restored.tick(); assert.equal(f.sent.length, 1);
});

test('shared notes reach every on-demand reply without leaking automatic facts from another room', async t => {
  const f = await fixture(t, { seedLongMemory: true });
  f.store.setConversationSettings(owner, 'group', room, { ...f.store.conversationSettings(owner, 'group', room), memoryMode: 'on-demand' });
  f.runner.run = async input => { f.calls.push(input); assert(input.adminNotes.includes('重要提醒')); assert.equal(input.memory, undefined); assert(!JSON.stringify(input.history).includes('秘密生日礼物')); return { text: '已核对。' }; };
  f.receive('/agent 共同约定是什么？'); await f.channel.whenIdle(); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
});

test('a reminder waiting over ten minutes in the queue still sends once while an ordinary old reply is cancelled', async t => {
  const f = await fixture(t), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.runner.run = async () => { reached.resolve(); await gate.promise; return { text: '旧回复。' }; };
  f.receive('/agent 先处理这条消息'); await reached.promise;
  const task = f.create('message'); f.advance(1000); const running = f.scheduler.tick();
  try {
    assert(f.channel.queue.some(item => item.scheduled?.id === task.id));
    f.advance(600001);
  } finally { gate.resolve(); await running; await f.channel.whenIdle(); }
  assert.equal(f.sent.length, 1); assert.equal(f.task(task.id).state, 'completed'); assert.equal(f.record(task.id).state, 'sent');
  assert.equal(f.sent[0].message[0].data.text, task.content);
  await f.scheduler.tick(); assert.equal(f.sent.length, 1);
});

test('revoked and offline reminders remain pending until online authorization returns, then send once', async t => {
  const f = await fixture(t), revoked = f.create('message', '撤权任务');
  f.store.configure(owner, { ...f.settings, groups: [other] }); f.advance(1000); await f.scheduler.tick();
  assert.equal(f.task(revoked.id).state, 'pending'); assert.equal(f.scheduler.list(owner).runs.length, 0);
  f.advance(600001); await f.scheduler.tick(); assert.equal(f.task(revoked.id).state, 'pending');
  f.store.configure(owner, f.settings); const offline = f.create('message', '离线任务'); f.state.online = false;
  f.advance(1000); await f.scheduler.tick(); assert.equal(f.task(offline.id).state, 'pending');
  f.advance(600001); await f.scheduler.tick(); assert.equal(f.task(offline.id).state, 'pending');
  f.state.online = true; await f.scheduler.tick();
  assert.equal(f.sent.length, 2); assert.equal(f.scheduler.list(owner).runs.length, 2);
  await f.scheduler.tick(); assert.equal(f.sent.length, 2);
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
