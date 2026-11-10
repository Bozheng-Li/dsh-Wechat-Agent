import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateStore, WechatChannel, ChannelError, executionModeCommand, nicknameMentioned } from '../lib/testing.js';
import { fixtureWorkRoute } from './fixtures/work-dialogue.mjs';
import { modeLanguageCases, formattedModeCases } from './fixtures/execution-mode-language.mjs';

for (const row of [...modeLanguageCases, ...formattedModeCases]) test(`mode language: ${row.category}: ${row.text}`, () => {
  const result = executionModeCommand(row.text, ['小胖', '小墨']);
  assert.equal(result?.action === 'set' ? result.target : result?.action ?? null, row.expected);
});

const accountId = 'wxid_mode_owner', room = 'mode@chatroom', senderId = 'wxid_admin';
const scope = { accountId, chatType: 'group', peerId: room, senderId };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-mode-control-')), store = new StateStore(root), sent = [], work = [], chat = [];
  store.configure(accountId, { enabled: true, privatePeers: ['wxid_other'], groups: [room, 'other@chatroom'], prompt: 'chat-only' });
  store.setPersona({ name: '小胖', aliases: ['小墨'], prompt: 'chat-only-persona' });
  const config = patch => store.setConversationSettings(accountId, 'group', room, { ...store.conversationSettings(accountId, 'group', room), ...patch });
  config({ remoteEnabled: true, adminIds: options.local ? [senderId] : [], workSenderIds: ['wxid_code_member'] });
  if (!options.local) { const next = store.config.snapshot(store.data); next.remote = { globalAdminIds: [senderId] }; store.config.commit(next); }
  const state = { online: true, account: { id: accountId, nickname: '小胖' } };
  const runner = { ctx: { agents: { list: () => [] } }, run: async input => {
    if (input.mode === 'work-routing') return fixtureWorkRoute(input);
    chat.push(input); return { text: '聊天回复' };
  } };
  const channel = new WechatChannel({ store, runner, transport: { status: () => state, send: async payload => { sent.push(payload); return options.send ? options.send(payload) : { delivery: 'server-ack', serverMessageIds: ['mode-ack-' + sent.length] }; } },
    workRunner: { run: async input => { work.push(input); return options.run ? options.run(input) : { text: '工作执行结果' }; } } });
  let serial = 0;
  const receive = (text, overrides = {}) => channel.receive({ id: 'mode-msg-' + ++serial, direction: 'incoming', chatType: 'group', peerId: room, sender: { id: senderId, nickname: '管理员' },
    time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], ...overrides }, accountId);
  t.after(async () => { await channel.close(); assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, channel, sent, work, chat, config, state, receive };
}

test('mode grammar accepts direct semantic equivalents and explicit commands, rejects quoted, negated and explanatory text', () => {
  for (const text of ['切换到工作模式', '小胖，进入工作模式吧', '请把模式改为工作', '现在开始干活', '能切换到工作模式吗？', '/mode work', '/mode 工作'])
    assert.deepEqual(executionModeCommand(text, ['小胖']), { action: 'set', target: 'work' }, text);
  for (const text of ['切回聊天模式', '小墨，恢复聊天', '退出工作模式', '请切换到聊天模式', '/mode chat', '/mode 聊天模式'])
    assert.deepEqual(executionModeCommand(text, ['小墨']), { action: 'set', target: 'chat' }, text);
  for (const text of ['“切换到工作模式”', '示例：切换到工作模式', '不要切换到工作模式', '怎么切换到工作模式？', '假如切换到工作模式会怎样', '他说切回聊天模式', '工作模式是什么', '我们聊聊天吧', '写代码切换模式的函数', '写一段切换到工作模式的代码'])
    assert.equal(executionModeCommand(text), null, text);
  assert.deepEqual(executionModeCommand('切换到工作模式，然后写代码'), { action: 'help' });
  assert.deepEqual(executionModeCommand('/mode work; whoami'), { action: 'help' });
  assert.deepEqual(executionModeCommand('现在是什么模式？'), { action: 'status' });
});
test('administrator mode changes commit on reception so the next message uses the new independent route', async t => {
  const f = fixture(t); const before = f.store.conversationSettings(accountId, 'group', room);
  f.receive('小胖切换到工作模式');
  assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'work');
  assert.deepEqual(f.store.conversationSettings(accountId, 'group', room), { ...before, executionMode: 'work' });
  f.receive('帮我写一个 Python 脚本'); await f.channel.whenIdle();
  assert.equal(f.work.length, 1); assert.equal(f.chat.length, 0); assert(JSON.stringify(f.sent).includes('设置已保存'));
  const restored = new StateStore(f.root); assert.equal(restored.conversationSettings(accountId, 'group', room).executionMode, 'work');
  const modes = f.store.data.records.filter(record => record.modeControl);
  assert.equal(modes[0].modeChange.state, 'saved'); assert.equal(modes[0].state, 'sent');
  assert.equal(f.store.history(accountId, 'group', room, 100).length, 0);
  assert.equal(f.channel.memory.load(scope).entries.length, 0);
});

test('work mode routes administrator chat separately and switching chat keeps persona replies', async t => {
  const f = fixture(t); f.receive('切换到工作模式');
  for (const text of ['你好', '帮我整理明天的安排', '解释一下这段代码', '示例：写一个文件', '不要执行命令，先分析问题']) {
    f.receive(text); await f.channel.whenIdle();
  }
  assert.deepEqual(f.work.map(input => input.request), ['帮我整理明天的安排']);
  assert.equal(f.chat.length, 4);
  assert(!f.store.history(accountId, 'group', room, 100).some(entry => entry.text === '帮我整理明天的安排'));
  f.receive('切回聊天模式'); await f.channel.whenIdle();
  f.receive('/agent 你好'); await f.channel.whenIdle();
  assert.equal(f.chat.length, 5); assert.equal(f.work.length, 1);
});

test('administrator work queries status through its tools while other members need nickname chat', async t => {
  const f = fixture(t, { run: async input => ({ text: await input.queryStatus({ action: 'tasks' }, input.signal) }) });
  f.receive('/mode work'); await f.channel.whenIdle();
  let queried = 0;
  f.channel.remote.query = async () => { queried++; return '实际任务快照'; };
  f.receive('查看 DSH 任务情况'); await f.channel.whenIdle();
  assert.equal(queried, 1); assert.equal(f.work.length, 1); assert.equal(f.chat.length, 0);
  f.receive('/dsh tasks'); await f.channel.whenIdle();
  assert.equal(queried, 2); assert.equal(f.work.length, 2); assert.equal(f.work[1].request, '/dsh tasks');
  const sent = f.sent.length;
  f.receive('帮我整理安排', { sender: { id: 'outsider', nickname: '管理员' } }); await f.channel.whenIdle();
  assert.equal(f.work.length, 2); assert.equal(f.chat.length, 0); assert.equal(f.sent.length, sent);
  f.receive('查看 DSH 任务情况', { sender: { id: 'outsider', nickname: '管理员' } }); await f.channel.whenIdle();
  assert.equal(queried, 2); assert.equal(f.work.length, 2); assert.equal(f.sent.length, sent);
  f.receive('小胖，查看 DSH 任务情况', { sender: { id: 'outsider', nickname: '管理员' } }); await f.channel.whenIdle();
  assert.equal(queried, 2); assert.equal(f.work.length, 2); assert.equal(f.chat.length, 1); assert.match(JSON.stringify(f.sent.at(-1)), /聊天回复/);
});

test('nontext and system messages never enter chat or execute a placeholder work request', async t => {
  const f = fixture(t); f.receive('/mode work'); await f.channel.whenIdle();
  f.receive('', { message: [{ type: 'image', data: {} }] }); await f.channel.whenIdle();
  assert.match(JSON.stringify(f.sent.at(-1)), /请用文字/);
  const count = f.sent.length;
  f.receive('请运行这个任务', { messageType: 10000 }); await f.channel.whenIdle();
  assert.equal(f.sent.length, count); assert.equal(f.work.length, 0); assert.equal(f.chat.length, 0);
  f.receive('x'.repeat(12001)); await f.channel.whenIdle();
  assert.equal(f.work.length, 0); assert.equal(f.chat.length, 0); assert.match(JSON.stringify(f.sent.at(-1)), /12000/);
});

test('language controls change administrator mode while other members follow their current chat route', async t => {
  const f = fixture(t, { local: true });
  const controls = modeLanguageCases.filter(row => ['work', 'chat', 'status'].includes(row.expected));
  let rejected = 0, nicknameChats = 0;
  for (const row of controls) {
    const before = f.store.conversationSettings(accountId, 'group', room).executionMode;
    const sentBefore = f.sent.length;
    f.receive(row.text, { sender: { id: 'wxid_outsider', nickname: '管理员' } }); await f.channel.whenIdle();
    assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, before, row.text);
    if (before === 'chat') rejected++;
    else if (nicknameMentioned(row.text, ['小胖', '小墨'])) nicknameChats++;
    else assert.equal(f.sent.length, sentBefore, row.text);
    f.receive(row.text); await f.channel.whenIdle();
    assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, row.expected === 'status' ? before : row.expected, row.text);
  }
  assert.equal(f.sent.length, controls.length + rejected + nicknameChats);
  assert.equal(f.chat.length, nicknameChats); assert.equal(f.work.length, 0);
  assert(!f.store.history(accountId, 'group', room, 100).some(entry => entry.senderId === senderId));
  assert.equal(new StateStore(f.root).conversationSettings(accountId, 'group', room).executionMode, f.store.conversationSettings(accountId, 'group', room).executionMode);
});
test('code members and same-name outsiders cannot switch or impersonate administrators', async t => {
  const f = fixture(t, { local: true });
  for (const id of ['wxid_code_member', 'wxid_outsider']) f.receive('/mode work', { sender: { id, nickname: '管理员' } });
  await f.channel.whenIdle(); assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'chat');
  assert.equal(f.chat.length, 0); assert.equal(f.work.length, 0); assert.equal(f.sent.length, 2); assert(JSON.stringify(f.sent).includes('只有全局或当前会话管理员'));
  f.receive('切换到工作模式'); await f.channel.whenIdle(); assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'work');
  f.receive('/mode work', { peerId: 'other@chatroom' }); await f.channel.whenIdle();
  assert.equal(f.store.conversationSettings(accountId, 'group', 'other@chatroom').executionMode, 'chat');
});
test('disabled remote access, old and system messages, false private identity and other accounts cannot switch', async t => {
  const f = fixture(t); f.config({ remoteEnabled: false });
  f.receive('/mode work'); await f.channel.whenIdle(); assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'chat');
  f.config({ remoteEnabled: true });
  f.receive('/mode work', { time: Math.floor(Date.now() / 1000) - 601 });
  f.receive('/mode work', { messageType: 10000 });
  f.receive('/mode work', { chatType: 'private', peerId: 'wxid_other' });
  f.state.account.id = 'foreign'; f.receive('/mode work'); f.state.account.id = accountId;
  await f.channel.whenIdle(); assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'chat');
  assert.equal(f.work.length, 0);
});
test('same-mode request leaves active work running; switching chat cancels only current room tasks', async t => {
  const started = Promise.withResolvers();
  const f = fixture(t, { run: async input => { if (!started.input) { started.input = input; started.resolve(input); await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); } return { text: 'other room result' }; } });
  f.config({ executionMode: 'work' }); const first = f.channel.work.create(scope, '写脚本'); const input = await started.promise;
  f.receive('/mode work'); await f.channel.running; assert.equal(input.signal.aborted, false);
  const sameRoom = f.channel.work.create({ ...scope, senderId: 'wxid_code_member' }, '写另一个脚本');
  f.store.setConversationSettings(accountId, 'private', 'wxid_other', { ...f.store.conversationSettings(accountId, 'private', 'wxid_other'), executionMode: 'work' });
  const other = f.channel.work.create({ accountId, chatType: 'private', peerId: 'wxid_other', senderId: 'wxid_other' }, '写其他会话脚本');
  f.receive('切回聊天模式'); assert.equal(input.signal.aborted, true); await f.channel.whenIdle();
  assert.equal(f.channel.work.store.get(first.id).state, 'cancelled'); assert.equal(f.channel.work.store.get(sameRoom.id).state, 'cancelled');
  assert.equal(f.channel.work.store.get(other.id).state, 'succeeded');
  assert.equal(f.store.conversationSettings(accountId, 'private', 'wxid_other').executionMode, 'work');
});
test('duplicate incoming controls are not replayed and unknown ACK does not undo the saved mode or resend', async t => {
  const f = fixture(t, { send: () => ({}) }); f.receive('/mode work', { id: 'stable-mode-id' }); await f.channel.whenIdle();
  f.receive('/mode work', { id: 'stable-mode-id' }); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'work');
  assert.equal(f.store.data.records.find(record => record.modeControl).state, 'unknown');
  f.receive('/mode status'); await f.channel.whenIdle(); assert(JSON.stringify(f.sent.at(-1)).includes('当前会话使用工作模式'));
});
test('failed configuration save never reports a completed switch and preserves prior mode', async t => {
  const f = fixture(t); f.store.setConversationSettings = () => { throw new ChannelError('STATE_WRITE_FAILED', '模拟保存失败'); };
  f.receive('切换到工作模式'); await f.channel.whenIdle();
  assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'chat'); assert.equal(f.sent.length, 0);
  assert.equal(f.channel.fault.code, 'STATE_WRITE_FAILED');
});
test('revoking administrator while confirmation is queued suppresses it without reverting saved mode', async t => {
  const f = fixture(t); f.channel.running = Promise.resolve();
  f.receive('切换到工作模式'); assert.equal(f.channel.queue.length, 1);
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: [] }; f.store.config.commit(next);
  f.channel.running = undefined; await f.channel.whenIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'work');
});
test('switching execution mode preserves queued fixed reminders and ordinary chat counters', async t => {
  const f = fixture(t); f.channel.running = Promise.resolve();
  const reminder = f.channel.submitScheduled({ ...scope, id: 'fixed-reminder', recordKey: 'mode-fixed-reminder', source: 'owner', kind: 'message', content: '固定提醒仍应发送' }, new AbortController().signal);
  const before = f.store.progress(accountId, 'group', room);
  f.receive('/mode work'); assert(f.channel.queue.some(item => item.scheduled?.id === 'fixed-reminder'));
  assert.deepEqual(f.store.progress(accountId, 'group', room), before);
  f.channel.running = undefined; await f.channel.whenIdle();
  assert.equal((await reminder).state, 'sent'); assert(JSON.stringify(f.sent).includes('固定提醒仍应发送'));
});
