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
const owner = 'clock_fixture_owner', room = 'clock_fixture_room@chatroom';
const scope = { accountId: owner, chatType: 'group', peerId: room };
const store = new StateStore(root);
store.configure(owner, { enabled: true, groups: [room], privatePeers: [], prompt: '' });
store.setPersona({ name: '小胖', aliases: [], prompt: '自然接话。' });
store.rememberConversationName(owner, 'group', room, '一分钟提醒测试组');
store.setConversationSettings(owner, 'group', room, { mode: 'nickname', intervalMode: 'random', minMessages: 1, maxMessages: 100, fixedMessages: 5, recordsPath: '' });
const sends = [];
const transport = {
  status: () => ({ online: true, account: { id: owner, nickname: '测试微信' } }),
  send: async input => {
    const ack = 'clock-stub-ack-' + (sends.length + 1);
    sends.push({ at: Date.now(), text: input.message.map(part => part.data?.text || '').join(''), ack });
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
    chatType: scope.chatType, peerId: room, sender: { id: 'clock_alice', nickname: '阿禾' },
    message: [{ type: 'text', data: { text: report.request } }] }, owner);
  await channel.whenIdle();
  const task = scheduler.list(owner).tasks[0];
  assert(task, 'The conversation request must create a task');
  assert.equal(scheduler.list(owner).tasks.length, 1);
  assert.equal(task.kind, 'message');
  assert.equal(task.state, 'pending');
  assert.equal(sends.length, 1, 'Only the immediate acknowledgement is sent before the due time');
  assert.match(sends[0].text, /一分钟后提醒你/);
  assert(task.nextRunAt >= startedAt + 60000);
  report.dueAt = task.nextRunAt;
  console.log('Waiting for the real one-minute deadline; all sends use a local stub.');
  scheduler.start();
  while (scheduler.list(owner).tasks[0].state !== 'completed' && Date.now() - startedAt < 85000) await wait(250);
  assert.equal(scheduler.list(owner).tasks[0].state, 'completed');
  await wait(2200);
  assert.equal(sends.length, 2, 'The confirmation and exactly one reminder should be sent');
  assert(sends[1].at >= task.nextRunAt, 'The reminder must not be sent before the deadline');
  assert.match(sends[1].text, /阿禾.*吃饭/u);
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
  await scheduler.close(); await channel.close();
  report.finishedAt = Date.now();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const relative = path.relative(temporary, fs.realpathSync(root));
  assert(relative.startsWith('scheduler-clock-') && !relative.includes('..') && !path.isAbsolute(relative));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
