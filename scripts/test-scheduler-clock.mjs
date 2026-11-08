import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, WechatChannel, TaskScheduler } from '../lib/testing.js';

// An integration check with the real scheduler interval and clock. Transport is
// entirely local; no WeChat connection, network call, or model call is used.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(project, 'storage/tmp');
const reportPath = path.join(project, 'storage/logs/scheduler-clock.json');
fs.mkdirSync(temporary, { recursive: true });
const root = fs.mkdtempSync(path.join(temporary, 'scheduler-clock-'));
const owner = 'clock_fixture_owner', room = 'clock_fixture_room@chatroom', senderId = 'clock_alice';
const scope = { accountId: owner, chatType: 'group', peerId: room };
const store = new StateStore(root);
store.configure(owner, { enabled: true, groups: [room], privatePeers: [], prompt: '' });
store.setPersona({ name: '小胖', aliases: [], prompt: '自然接话。' });
store.rememberConversationName(owner, 'group', room, '一分钟提醒测试组');
store.setConversationSettings(owner, 'group', room, { mode: 'nickname', intervalMode: 'random', minMessages: 1, maxMessages: 100, fixedMessages: 5, recordsPath: '' });
const sends = [];
const reminderAck = Promise.withResolvers();
const transport = {
  status: () => ({ online: true, account: { id: owner, nickname: '测试微信' } }),
  call: async (operation, input, { signal } = {}) => {
    signal?.throwIfAborted();
    assert.equal(operation, 'members');
    assert.deepEqual(input, { accountId: owner, peerId: room });
    return { accountId: owner, peerId: room, scope: 'protocol-observed-only', members: [{ id: senderId, name: '阿禾', nickname: '阿禾', groupId: room }] };
  },
  send: async input => {
    assert.equal(input.accountId, owner); assert.equal(input.chatType, 'group'); assert.equal(input.peerId, room);
    const ack = 'clock-stub-ack-' + (sends.length + 1);
    const sent = { at: Date.now(), text: input.message.map(part => part.data?.text || '').join(''),
      mentions: input.message.filter(part => part.type === 'at').map(part => ({ id: part.data.qq, name: part.data.name })), ack, acknowledgedAt: null };
    sends.push(sent);
    if (sends.length === 2) await reminderAck.promise;
    sent.acknowledgedAt = Date.now();
    return { delivery: 'server-ack', serverMessageIds: [ack] };
  },
};
const runner = { run: async () => { throw new Error('Simple reminders must not call the model'); } };
const channel = new WechatChannel({ store, transport, runner });
const scheduler = new TaskScheduler({ store, channel }); channel.scheduler = scheduler;
const startedAt = Date.now();
const report = { passed: false, actualWeChatMessages: 0, request: '小胖，一分钟后提醒我吃饭', startedAt, sends };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  channel.receive({ id: 'clock-incoming-1', serverMessageId: 'clock-incoming-1', direction: 'incoming', time: Math.floor(startedAt / 1000),
    chatType: scope.chatType, peerId: room, sender: { id: senderId, nickname: '阿禾' },
    message: [{ type: 'text', data: { text: report.request } }] }, owner);
  await channel.whenIdle();
  const task = scheduler.list(owner).tasks[0];
  assert(task, 'The conversation request must create a task');
  assert.equal(scheduler.list(owner).tasks.length, 1);
  assert.equal(task.kind, 'message');
  assert.equal(task.state, 'pending');
  assert.deepEqual(task.targets, [{ id: senderId, name: '阿禾' }]);
  assert.equal(sends.length, 1, 'Only the immediate acknowledgement is sent before the due time');
  assert.deepEqual(sends[0].mentions, [], 'The immediate confirmation must not send an extra mention');
  const confirmation = sends[0].text.match(/(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})提醒你：吃饭。$/u);
  assert(confirmation, 'The confirmation must state the saved absolute deadline and activity');
  // Check the reported components against the persisted timestamp independently
  // of the receipt formatter. Shanghai currently uses UTC+08:00.
  const localDeadline = new Date(task.nextRunAt + 8 * 60 * 60 * 1000);
  assert.deepEqual(confirmation.slice(1).map(Number), [localDeadline.getUTCMonth() + 1, localDeadline.getUTCDate(),
    localDeadline.getUTCHours(), localDeadline.getUTCMinutes(), localDeadline.getUTCSeconds()]);
  assert(task.nextRunAt >= startedAt + 60000);
  report.dueAt = task.nextRunAt;
  report.mentionTargets = task.targets;
  console.log('Waiting for the real one-minute deadline; all sends use a local stub.');
  scheduler.start();
  while (sends.length < 2 && Date.now() - startedAt < 85000) await wait(250);
  assert.equal(sends.length, 2, 'The reminder must reach the local transport at the real deadline');
  assert.deepEqual(sends[1].mentions, [{ id: senderId, name: '阿禾' }], 'The reminder must really @ the original sender, not just include their name in text');
  assert.equal(sends[1].acknowledgedAt, null);
  report.taskStateBeforeAck = scheduler.list(owner).tasks[0].state;
  assert.equal(report.taskStateBeforeAck, 'running', 'Dispatch alone must not complete the task before the server ACK');
  assert.deepEqual(scheduler.list(owner).runs[0].acknowledgedMessageIds, []);
  const record = store.data.records.find(record => record.key === scheduler.list(owner).tasks[0].recordKey);
  assert.equal(record?.state, 'sending');
  report.ackReleasedAt = Date.now(); reminderAck.resolve();
  while (scheduler.list(owner).tasks[0].state !== 'completed' && Date.now() - report.ackReleasedAt < 10000) await wait(25);
  assert.equal(scheduler.list(owner).tasks[0].state, 'completed');
  report.completedAt = Date.now();
  assert(sends[1].acknowledgedAt <= report.completedAt);
  await wait(2200);
  assert.equal(sends.length, 2, 'The confirmation and exactly one reminder should be sent');
  assert(sends[1].at >= task.nextRunAt, 'The reminder must not be sent before the deadline');
  assert.match(sends[1].text, /吃饭/u);
  const finished = scheduler.list(owner);
  assert.equal(finished.runs.length, 1);
  assert.equal(finished.runs[0].state, 'sent');
  assert.deepEqual(finished.runs[0].acknowledgedMessageIds, [sends[1].ack]);
  report.passed = true;
  report.reminderElapsedMs = sends[1].at - startedAt;
  report.reminderLatenessMs = sends[1].at - task.nextRunAt;
  report.taskState = finished.tasks[0].state;
  report.runs = finished.runs;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  reminderAck.resolve();
  await scheduler.close(); await channel.close();
  report.finishedAt = Date.now();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const relative = path.relative(temporary, fs.realpathSync(root));
  assert(relative.startsWith('scheduler-clock-') && !relative.includes('..') && !path.isAbsolute(relative));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
