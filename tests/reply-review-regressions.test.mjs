import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, TaskScheduler } from '../lib/testing.js';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-reply-review-'));
  const scope = { accountId: 'review-owner', chatType: 'group', peerId: 'review-room@chatroom' };
  const store = new StateStore(root), sent = [], calls = [];
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: ['alice'], prompt: '' });
  store.setPersona({ name: '桃枝', aliases: [], prompt: '自然轻快地回应。' });
  let now = Date.now(), sequence = 0;
  const runner = { run: async request => { calls.push(request); return { text: '好呀。' }; } };
  const transport = {
    status: () => ({ online: true, account: { id: scope.accountId } }),
    call: async () => ({ accountId: scope.accountId, peerId: scope.peerId, members: [{ id: 'alice', name: '阿禾' }] }),
    send: async request => { sent.push(request); return { delivery: 'server-ack', serverMessageIds: ['review-ack-' + sent.length] }; },
  };
  const channel = new WechatChannel({ store, runner, transport, now: () => now });
  const scheduler = new TaskScheduler({ store, channel, now: () => now }); channel.scheduler = scheduler;
  const receive = text => channel.receive({ id: 'review-message-' + ++sequence, chatType: scope.chatType, peerId: scope.peerId,
    direction: 'incoming', time: Math.floor(now / 1000), sender: { id: 'alice', nickname: '阿禾' },
    message: [{ type: 'text', data: { text: '/agent ' + text } }] }, scope.accountId);
  t.after(async () => {
    await scheduler.close(); await channel.close();
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('wechat-reply-review-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { scope, store, runner, channel, scheduler, receive, sent, calls, now: () => now, advance: milliseconds => { now += milliseconds; },
    sentText: () => sent.flatMap(message => message.message).filter(segment => segment.type === 'text').map(segment => segment.data.text).join('\n') };
}

test('persona reminder confirmation cannot change the saved audience or activity while retaining its time', async t => {
  const f = fixture(t);
  f.runner.run = async request => { f.calls.push(request); return { text: '一分钟后提醒大家去跑步。' }; };
  f.receive('一分钟后提醒我喝水'); await f.channel.whenIdle();
  const task = f.scheduler.list(f.scope.accountId).tasks[0];
  assert(task.content.includes('喝水')); assert.equal(task.targets[0].id, 'alice');
  assert(!/跑步|大家/u.test(f.sentText()), 'an incorrect model-written status was sent for a different saved task');
  assert.equal(f.sent.length, 1);
});

test('slow reminder confirmation cannot restart the original relative countdown in its wording', async t => {
  const f = fixture(t);
  f.runner.run = async request => { f.calls.push(request); f.advance(12000); return { text: '10秒后提醒你喝水。' }; };
  f.receive('10秒后提醒我喝水'); await f.channel.whenIdle();
  const task = f.scheduler.list(f.scope.accountId).tasks[0];
  if (f.now() >= task.nextRunAt)
    assert(!f.sentText().includes('10秒后'), 'the confirmation promises a new countdown even though the saved task is already due');
  assert.equal(f.sent.length, 1);
});

test('a reminder cancelled during persona generation is not confirmed as still scheduled', async t => {
  const f = fixture(t); let cancelled = false;
  f.runner.run = async request => {
    f.calls.push(request);
    const task = f.scheduler.list(f.scope.accountId).tasks[0];
    f.scheduler.cancel(task.id, { accountId: f.scope.accountId }, true); cancelled = true;
    return { text: '一分钟后提醒你喝水。' };
  };
  f.receive('一分钟后提醒我喝水'); await f.channel.whenIdle();
  if (cancelled) {
    assert.equal(f.scheduler.list(f.scope.accountId).tasks[0].state, 'cancelled');
    assert(f.sent.length === 0 || /取消/u.test(f.sentText()), 'the task was cancelled but its old positive confirmation was still sent');
  }
});
