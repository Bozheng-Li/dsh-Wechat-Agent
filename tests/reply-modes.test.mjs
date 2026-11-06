import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelError, StateStore, WechatChannel, nicknameMentioned } from '../lib/testing.js';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const account = { id: 'wxid_modes_owner', nickname: '微信本名' };
const roomA = 'mode-a@chatroom', roomB = 'mode-b@chatroom';
const settings = { enabled: true, privatePeers: ['alice', 'bob'], groups: [roomA, roomB], prompt: '' };
const persona = { name: '小胖', aliases: ['Ann'], background: '', personality: '友善', style: '简短' };
const config = (mode, minMessages = 5, maxMessages = 20) => ({ mode, minMessages, maxMessages, recordsPath: '' });

function fixture(t, options = {}) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'reply-modes-'));
  const store = new StateStore(root); store.configure(account.id, settings); store.setPersona(persona);
  const calls = [], sent = [], cleanups = [], state = { online: true, account: structuredClone(account) };
  const now = Date.now();
  const transport = {
    status: () => structuredClone(state),
    send: async params => { sent.push(params); return { delivery: 'server-ack', serverMessageIds: [`ack-${sent.length}`] }; },
  };
  const runner = { run: async input => {
    calls.push(input); const sessionId = input.sessionId || `session-${calls.length}`;
    await input.onSession?.(sessionId); return { text: `回答 ${calls.length}`, sessionId };
  } };
  const channel = new WechatChannel({ store, runner, transport, now: () => now, ...options });
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await channel.close();
    const relative = path.relative(base, fs.realpathSync(root));
    assert(relative.startsWith('reply-modes-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let serial = 0;
  const message = (text, extras = {}) => {
    const id = `message-${++serial}`;
    return { id, serverMessageId: id, time: Math.floor(now / 1000), direction: 'incoming', chatType: 'group',
      peerId: roomA, sender: { id: 'alice', nickname: 'Alice' }, message: [{ type: 'text', data: { text } }], ...extras };
  };
  return { root, store, calls, sent, state, runner, transport, channel, message, now, cleanups,
    receive: value => channel.receive(value, state.account.id),
    configure: (peerId, mode, min = 5, max = 20) => store.setConversationSettings(account.id, 'group', peerId, config(mode, min, max)),
  };
}

test('nickname mode recognizes configured names and aliases without changing default or private triggers', async t => {
  const f = fixture(t); f.configure(roomB, 'nickname');
  f.receive(f.message('cue 小胖，你觉得呢'));
  f.receive(f.message('/agent 默认问题'));
  f.receive(f.message('@微信本名\u2005 原生提及', { message: [
    { type: 'at', data: { qq: account.id } }, { type: 'text', data: { text: '@微信本名\u2005 原生提及' } },
  ] }));
  for (const text of ['cue 小胖，你觉得呢', 'ＡＮＮ，hello', '微信本名，看看这个', 'Anna is here', 'myAnn_account'])
    f.receive(f.message(text, { peerId: roomB }));
  f.receive(f.message('普通私聊问题', { chatType: 'private', peerId: 'alice' }));
  await f.channel.whenIdle();
  assert.deepEqual(f.calls.map(call => call.text), ['默认问题', '原生提及', 'cue 小胖，你觉得呢', 'ＡＮＮ，hello', '微信本名，看看这个', '普通私聊问题']);
  assert.deepEqual(f.calls.map(call => call.mode), ['default', 'default', 'nickname', 'nickname', 'nickname', 'default']);
  assert.equal(nicknameMentioned('Ann2 and Anna', ['Ann']), false);
  assert.equal(nicknameMentioned('Anna; ANN?', ['Ann']), true);
  assert.equal(f.sent.length, 6);
});

test('participation thresholds are random per group and persistent; direct calls reply immediately and restart counting', async t => {
  const draws = [0, 0.999999, 0.5];
  const f = fixture(t, { random: () => draws.shift() ?? 0 });
  f.configure(roomA, 'participate'); f.configure(roomB, 'participate');
  const first = f.message('A 的新话题'); f.receive(first);
  f.receive(f.message('B 的独立话题', { peerId: roomB }));
  assert.deepEqual(f.store.progress(account.id, 'group', roomA), { count: 1, target: 5 });
  assert.deepEqual(f.store.progress(account.id, 'group', roomB), { count: 1, target: 20 });

  f.receive({ ...first, id: 'duplicate-local-id' });
  f.receive(f.message('自己的消息', { sender: account }));
  f.receive(f.message('发出消息', { direction: 'outgoing' }));
  f.receive(f.message('未授权群', { peerId: 'unapproved@chatroom' }));
  f.receive(f.message('历史消息', { time: Math.floor(f.now / 1000) - 601 }));
  f.receive(f.message('未来消息', { time: Math.floor(f.now / 1000) + 120 }));
  f.state.online = false; f.receive(f.message('离线同步')); f.state.online = true;
  f.channel.receive(f.message('其他账号事件'), 'wxid_other');
  assert.deepEqual(f.store.progress(account.id, 'group', roomA), { count: 1, target: 5 });

  f.receive(f.message('@微信本名\u2005 被提及', { message: [
    { type: 'at', data: { qq: account.id } }, { type: 'text', data: { text: '@微信本名\u2005 被提及' } },
  ] }));
  f.receive(f.message('/agent 直接提问'));
  await f.channel.whenIdle();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.text), ['被提及', '直接提问']);
  f.receive(f.message('', { message: [{ type: 'image', data: { file: 'fixture-image' } }] }));
  for (let i = 0; i < 4; i++) f.receive(f.message('普通话题 ' + i));
  await f.channel.whenIdle();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].mode, 'participate');
  assert(f.calls[2].history.some(entry => entry.mediaOnly));
  assert(!JSON.stringify(f.calls[2].history).includes('B 的独立话题'));
  assert.deepEqual(f.store.progress(account.id, 'group', roomA), { count: 0, target: 5 });
  const reloaded = new StateStore(f.root);
  assert.deepEqual(reloaded.progress(account.id, 'group', roomA), { count: 0, target: 5 });
  assert.deepEqual(reloaded.progress(account.id, 'group', roomB), { count: 1, target: 20 });
  assert.equal(draws.length, 0);
});

test('a normal plugin close preserves unfinished participation counts for the next instance', async t => {
  const f = fixture(t, { random: () => 0 }); f.configure(roomA, 'participate');
  const first = f.message('重启前第一条');
  f.receive(first); f.receive(f.message('重启前第二条')); f.receive(f.message('重启前第三条'));
  await f.channel.close();
  const reloaded = new StateStore(f.root);
  assert.deepEqual(reloaded.progress(account.id, 'group', roomA), { count: 3, target: 5 });
  let randomCalls = 0;
  const next = new WechatChannel({ store: reloaded, runner: f.runner, transport: f.transport,
    now: () => f.now, random: () => { randomCalls++; return 0.999999; } });
  f.cleanups.push(() => next.close());
  next.receive({ ...first, id: 'reconnected-local-id' }, account.id);
  next.receive(f.message('重启后第四条'), account.id);
  assert.equal(f.calls.length, 0); assert.equal(randomCalls, 0);
  assert.deepEqual(reloaded.progress(account.id, 'group', roomA), { count: 4, target: 5 });
  next.receive(f.message('重启后第五条'), account.id); await next.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.calls[0].history.filter(entry => entry.direction === 'incoming').length, 5);
  assert.deepEqual(reloaded.progress(account.id, 'group', roomA), { count: 0, target: 20 });
  assert.equal(randomCalls, 1);
});

test('media messages count toward participation but an unreadable window is skipped', async t => {
  const f = fixture(t); f.configure(roomA, 'participate', 5, 5);
  for (let i = 0; i < 5; i++) f.receive(f.message('', { message: [{ type: 'image', data: {} }] }));
  await f.channel.whenIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  const page = f.store.recordsPage(account.id, { chatType: 'group', peerId: roomA });
  assert.equal(page.total, 1); assert.equal(page.records[0].state, 'skipped');
  assert.match(page.records[0].reason, /没有可理解的文字/);
  f.receive(f.message('现在有文字讨论了'));
  for (let i = 0; i < 4; i++) f.receive(f.message('', { message: [{ type: 'image', data: {} }] }));
  await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
});

test('a busy group coalesces batches into one queued reply and reads the latest room context', { timeout: 10000 }, async t => {
  const f = fixture(t), gate = Promise.withResolvers(), original = f.runner.run;
  f.configure(roomA, 'participate', 5, 5); f.configure(roomB, 'participate', 5, 5);
  f.runner.run = async input => {
    if (input.text === '占用模型') await gate.promise;
    return original(input);
  };
  f.cleanups.push(() => gate.resolve());
  f.receive(f.message('占用模型', { chatType: 'private', peerId: 'alice' }));
  for (let i = 1; i <= 15; i++) f.receive(f.message(`A 话题 ${i}`));
  for (let i = 1; i <= 5; i++) f.receive(f.message(`B 话题 ${i}`, { peerId: roomB }));
  f.receive(f.message('A 最新话题：周末露营'));
  assert.equal(f.channel.summary().queued, 2);
  const waiting = f.store.recordsPage(account.id, { chatType: 'group', peerId: roomA }).records;
  assert.equal(waiting.length, 1); assert.equal(waiting[0].batches, 3);
  gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.calls.length, 3);
  assert(f.calls[1].history.some(entry => entry.text === 'A 最新话题：周末露营'));
  assert(!f.calls[1].history.some(entry => entry.text.startsWith('B 话题')));
  assert(f.calls[2].history.every(entry => entry.text.startsWith('B 话题')));
  assert.deepEqual(f.sent.map(value => value.peerId), ['alice', roomA, roomB]);
  assert.deepEqual(f.store.progress(account.id, 'group', roomA), { count: 1, target: 5 });
});

test('group memory includes different speakers while rooms, private peers and accounts remain isolated', async t => {
  const f = fixture(t);
  f.receive(f.message('BOB 的普通发言', { sender: { id: 'bob', nickname: 'Bob' } }));
  f.receive(f.message('ALICE 的普通发言'));
  f.receive(f.message('/agent ALICE 第一个问题')); await f.channel.whenIdle();
  f.receive(f.message('/agent BOB 的问题', { sender: { id: 'bob', nickname: 'Bob' } })); await f.channel.whenIdle();
  f.receive(f.message('/agent ALICE 第二个问题')); await f.channel.whenIdle();
  f.receive(f.message('ALICE 私聊', { chatType: 'private', peerId: 'alice' })); await f.channel.whenIdle();
  f.receive(f.message('/agent ALICE 其他群', { peerId: roomB })); await f.channel.whenIdle();
  f.state.account = { id: 'wxid_second_owner', nickname: '另一个账号' };
  f.store.configure(f.state.account.id, settings);
  f.receive(f.message('/agent ALICE 其他账号')); await f.channel.whenIdle();
  assert.deepEqual(f.calls[0].history.map(entry => entry.text), ['BOB 的普通发言', 'ALICE 的普通发言']);
  assert(f.calls[1].memory.includes('BOB 的普通发言') && f.calls[1].memory.includes('ALICE 的普通发言'));
  assert(f.calls[2].memory.includes('BOB 的问题'));
  assert.equal(f.calls[2].sessionId, undefined, 'each turn receives the current memory instead of reusing stale host history');
  for (const index of [1, 3, 4, 5]) assert.equal(f.calls[index].sessionId, undefined);
  for (const index of [3, 4, 5]) assert.deepEqual(f.calls[index].history, []);
});

test('reconstructed context includes an acknowledged reply before the next message in the same second', async t => {
  const f = fixture(t);
  const millisecond = Math.floor(f.now / 1000) * 1000 + 200;
  t.mock.method(Date, 'now', () => millisecond);
  f.receive(f.message('第一条私聊', { chatType: 'private', peerId: 'alice' }));
  await f.channel.whenIdle();
  // A persona/workspace change discards the DSH association, while the local
  // conversation is still available to reconstruct an accurate short context.
  f.store.resetSessions();
  f.receive(f.message('同一秒追问', { chatType: 'private', peerId: 'alice' }));
  await f.channel.whenIdle();
  assert.equal(f.calls[1].sessionId, undefined);
  assert.deepEqual(f.calls[1].history.map(entry => [entry.direction, entry.text]), [
    ['incoming', '第一条私聊'], ['outgoing', '回答 1'],
  ]);
});

test('queued default replies exclude more than 80 later messages from the same second', { timeout: 10000 }, async t => {
  const f = fixture(t), gate = Promise.withResolvers(), original = f.runner.run;
  f.runner.run = async input => {
    if (input.text === '占用模型') await gate.promise;
    return original(input);
  };
  f.cleanups.push(() => gate.resolve());
  f.receive(f.message('占用模型', { chatType: 'private', peerId: 'alice' }));
  f.receive(f.message('提问之前的群上下文'));
  f.receive(f.message('/agent 原来的问题'));
  for (let i = 0; i < 85; i++) f.receive(f.message(`同秒后到的发言 ${i}`));
  assert.equal(f.channel.summary().queued, 1);
  gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.calls[1].text, '原来的问题');
  assert.deepEqual(f.calls[1].history.map(entry => entry.text), ['提问之前的群上下文']);
});

test('an evicted queued-message anchor does not reconstruct context from later retained messages', { timeout: 10000 }, async t => {
  const f = fixture(t), gate = Promise.withResolvers(), original = f.runner.run;
  f.runner.run = async input => {
    if (input.text === '占用模型') await gate.promise;
    return original(input);
  };
  f.cleanups.push(() => gate.resolve());
  f.receive(f.message('占用模型', { chatType: 'private', peerId: 'alice' }));
  f.receive(f.message('/agent 已被保留窗口淘汰的问题'));
  const view = [...f.store.views.values()].find(value => value.accountId === account.id && value.chatType === 'group' && value.peerId === roomA);
  // Materialize the same retained snapshot as 1000 later observations in one
  // real atomic store write; the behavior under test is the missing anchor.
  view.messages = Array.from({ length: 1000 }, (_, index) => ({
    key: `retained-${index}`, messageId: `retained-${index}`, direction: 'incoming', senderId: 'alice', senderName: 'Alice',
    text: `锚点淘汰后保留的消息 ${index}`, time: Math.floor(f.now / 1000) * 1000, observedAt: f.now, kind: 'message', mediaOnly: false,
  }));
  f.store.save();
  assert.equal(f.store.history(account.id, 'group', roomA, 1000).length, 1000);
  gate.resolve(); await f.channel.whenIdle();
  assert.equal(f.calls[1].text, '已被保留窗口淘汰的问题');
  assert.deepEqual(f.calls[1].history, []);
});

test('partial or unknown delivery never enters confirmed outgoing history or automatic replay', async t => {
  const f = fixture(t); f.configure(roomA, 'participate', 5, 5);
  let attempts = 0;
  f.transport.send = async () => {
    attempts++;
    throw new ChannelError('SEND_FAILED', '模拟发送失败', attempts === 1
      ? { delivery: 'partially-acknowledged', acknowledgedMessageIds: ['partial-ack'] }
      : { delivery: 'unknown' });
  };
  const delivered = [];
  for (let batch = 0; batch < 2; batch++) {
    for (let i = 0; i < 5; i++) { const message = f.message(`批次 ${batch} 话题 ${i}`); delivered.push(message); f.receive(message); }
    await f.channel.whenIdle();
  }
  assert.deepEqual(f.store.recordsPage(account.id, { chatType: 'group', peerId: roomA }).records.map(record => record.state), ['unknown', 'partial']);
  assert(f.store.history(account.id, 'group', roomA).every(entry => entry.direction === 'incoming'));
  assert.equal(Object.keys(f.store.data.sessions).length, 0);
  assert.equal(f.calls[1].sessionId, undefined);
  delivered.forEach(f.receive); await f.channel.whenIdle();
  assert.equal(attempts, 2);
  const reloaded = new StateStore(f.root);
  assert(reloaded.history(account.id, 'group', roomA).every(entry => entry.direction === 'incoming'));
  assert.equal(Object.keys(reloaded.data.seen).length, 10);
});

test('room cancellation resets only that room and preserves another queued group', { timeout: 10000 }, async t => {
  const f = fixture(t), started = Promise.withResolvers(), original = f.runner.run;
  f.configure(roomA, 'participate', 5, 5); f.configure(roomB, 'participate', 5, 5);
  let first = true;
  f.runner.run = async input => {
    if (!first) return original(input);
    first = false; f.calls.push(input); started.resolve();
    return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
  };
  const incoming = [];
  for (let i = 0; i < 5; i++) { const message = f.message(`A 等待 ${i}`); incoming.push(message); f.receive(message); }
  await started.promise;
  for (let i = 0; i < 5; i++) f.receive(f.message(`B 等待 ${i}`, { peerId: roomB }));
  f.receive(f.message('A 未满下一轮')); f.receive(f.message('B 未满下一轮', { peerId: roomB }));
  f.channel.cancel('只取消 A', { accountId: account.id, chatType: 'group', peerId: roomA });
  await f.channel.whenIdle();
  assert.deepEqual(f.sent.map(value => value.peerId), [roomB]);
  assert.deepEqual(f.store.progress(account.id, 'group', roomA), { count: 0, target: null });
  assert.deepEqual(f.store.progress(account.id, 'group', roomB), { count: 1, target: 5 });
  assert.equal(f.store.recordsPage(account.id, { chatType: 'group', peerId: roomA }).records[0].state, 'cancelled');
  incoming.forEach(f.receive); await f.channel.whenIdle();
  assert.deepEqual(f.store.progress(account.id, 'group', roomA), { count: 0, target: null });
  assert.equal(f.calls.length, 2);
});
