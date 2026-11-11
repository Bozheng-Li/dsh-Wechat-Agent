import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel } from '../lib/testing.js';
import { fixtureWorkRoute, fixtureWorkRouteDecision } from './fixtures/work-dialogue.mjs';

const accountId = 'wxid_sender_route_bot', room = 'sender-route@chatroom';
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sender-route-'));
  const store = new StateStore(root), chat = [], work = [], sent = [], routes = [];
  store.configure(accountId, { enabled: true, privatePeers: ['global-admin', 'member'], groups: [room], prompt: 'CHAT_ONLY_REQUIREMENTS' });
  store.setPersona({ name: '小胖', aliases: ['胖胖', 'Nova'], prompt: 'CHAT_ONLY_PERSONA' });
  const next = store.config.snapshot(store.data); next.remote = { globalAdminIds: ['global-admin'] }; store.config.commit(next);
  const configure = (patch = {}, chatType = 'group', peerId = room) => store.setConversationSettings(accountId, chatType, peerId,
    { ...store.conversationSettings(accountId, chatType, peerId), executionMode: 'work', remoteEnabled: true,
      adminIds: ['local-admin'], workSenderIds: ['code-member'], ...patch });
  configure({ mode: options.mode ?? 'natural', intervalMode: 'fixed', fixedMessages: 1 });
  configure({}, 'private', 'global-admin'); configure({}, 'private', 'member');
  const status = { online: true, account: { id: accountId, nickname: '微信本名' } };
  const transport = { status: () => status, send: async payload => {
    sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['sender-route-ack-' + sent.length] };
  } };
  const runner = { run: async input => {
    if (input.mode === 'work-routing') {
      routes.push(input); await options.routeBefore?.(input);
      const data = JSON.parse(input.text);
      return options.route ? { text: JSON.stringify(fixtureWorkRouteDecision(data, options.route(data))) } : fixtureWorkRoute(input);
    }
    if (input.mode === 'work-result') return { text: JSON.parse(input.text).result };
    chat.push(input); await options.chatBefore?.(input); input.signal.throwIfAborted(); return { text: '普通聊天回复' };
  } };
  const workRunner = { run: async input => {
    work.push(input); await options.workBefore?.(input); input.signal.throwIfAborted();
    await input.onSession(input.sessionId ?? 'sender-route-work-' + work.length, { native: true }); return { text: '管理员工作结果', native: true };
  } };
  const channel = new WechatChannel({ store, runner, workRunner, transport });
  let serial = 0;
  const receive = (text, overrides = {}) => channel.receive({ id: 'sender-route-msg-' + ++serial, direction: 'incoming',
    chatType: 'group', peerId: room, sender: { id: 'member', nickname: '普通成员' }, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }], ...overrides }, accountId);
  t.after(async () => {
    options.release?.();
    await channel.close(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-sender-route-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, channel, status, runner, workRunner, transport, chat, work, sent, routes, configure, receive };
}

test('nickname group work requires an administrator wake before routing, execution or reply', async t => {
  const f = fixture(t, { mode: 'nickname' });
  for (const id of ['global-admin', 'local-admin']) {
    for (const text of ['你好', '处理这项任务', '再生成一张', '现在完成了吗', '切回聊天模式', 'SuperNova'])
      f.receive(text, { sender: { id, nickname: '小胖' } });
  }
  await f.channel.whenIdle();
  assert.equal(f.routes.length, 0); assert.equal(f.work.length, 0); assert.equal(f.chat.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'work');
  assert(f.store.data.records.every(record => record.state === 'skipped'));
  f.receive('小胖，处理这项任务', { sender: { id: 'global-admin' } }); await f.channel.whenIdle();
  f.receive('胖胖，处理另一项任务', { sender: { id: 'local-admin' } }); await f.channel.whenIdle();
  assert.equal(f.routes.length, 2); assert.equal(f.work.length, 2); assert.equal(f.chat.length, 0);
});

test('nickname group administrators keep separate sessions, append their own turns and can choose a fresh session', async t => {
  const f = fixture(t, { mode: 'nickname', route: () => ({ action: 'new' }) });
  const globalScope = { accountId, chatType: 'group', peerId: room, senderId: 'global-admin' };
  const localScope = { ...globalScope, senderId: 'local-admin' };
  for (const [sender, text] of [['global-admin', '小胖，生成甲的图片'], ['local-admin', '胖胖，生成乙的图片'],
      ['global-admin', '小胖，再修改甲的图片'], ['local-admin', '胖胖，再修改乙的图片']]) {
    f.receive(text, { sender: { id: sender } }); await f.channel.whenIdle();
  }
  const globalJobs = f.channel.work.list(globalScope).jobs, localJobs = f.channel.work.list(localScope).jobs;
  assert.equal(globalJobs.length, 2); assert.equal(localJobs.length, 2);
  assert.equal(globalJobs[0].sessionId, globalJobs[1].sessionId); assert.equal(globalJobs[0].cwd, globalJobs[1].cwd);
  assert.equal(localJobs[0].sessionId, localJobs[1].sessionId); assert.equal(localJobs[0].cwd, localJobs[1].cwd);
  assert.notEqual(globalJobs[0].sessionId, localJobs[0].sessionId); assert.notEqual(globalJobs[0].cwd, localJobs[0].cwd);
  assert(!f.routes.filter(input => JSON.parse(input.text).message.includes('甲')).some(input => JSON.stringify(input).includes('乙')));
  f.receive('/work new 新开一轮报告', { sender: { id: 'global-admin' } }); await f.channel.whenIdle();
  const fresh = f.channel.work.list(globalScope).jobs[0];
  assert.notEqual(fresh.sessionId, globalJobs[0].sessionId); assert.notEqual(fresh.cwd, globalJobs[0].cwd);
  f.receive('/work 补充这份报告', { sender: { id: 'global-admin' } }); await f.channel.whenIdle();
  const continued = f.channel.work.list(globalScope).jobs[0];
  assert.equal(continued.sessionId, fresh.sessionId); assert.equal(continued.cwd, fresh.cwd); assert.equal(continued.continues, fresh.id);
  assert.equal(f.channel.work.list(localScope).jobs[0].sessionId, localJobs[0].sessionId);
});

test('nickname group wake preserves explicit commands and native mention compatibility', async t => {
  const f = fixture(t, { mode: 'nickname' }), sender = { id: 'global-admin' };
  f.receive('/agent 处理这项任务', { sender }); await f.channel.whenIdle();
  f.receive('ignored', { sender, message: [{ type: 'at', data: { qq: accountId, name: '小胖' } },
    { type: 'text', data: { text: '@小胖\u2005处理这项任务' } }] }); await f.channel.whenIdle();
  assert.equal(f.routes.length, 2); assert.equal(f.work.length, 2);
  f.receive('/mode status', { sender }); await f.channel.whenIdle(); assert.equal(f.routes.length, 2);
  f.receive('小胖，切回聊天模式', { sender }); await f.channel.whenIdle();
  assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'chat');
});

test('changing the wake nickname during work classification cancels the old input before execution', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { mode: 'nickname', routeBefore: async () => { started.resolve(); await release.promise; }, release: () => release.resolve() });
  f.receive('小胖，处理这项任务', { sender: { id: 'global-admin' } }); await started.promise;
  f.store.setPersona({ name: '新名字', aliases: [], prompt: 'CHAT_ONLY_PERSONA' });
  release.resolve(); await f.channel.whenIdle();
  assert.equal(f.routes.length, 1); assert.equal(f.work.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.store.data.records.at(-1).state, 'cancelled');
});

for (const mode of ['default', 'nickname', 'participate', 'natural']) test(`work conversation keeps non-administrators in nickname chat with ${mode} settings`, async t => {
  const f = fixture(t, { mode }), progress = f.store.progress(accountId, 'group', room);
  for (const text of ['你好', '帮我写代码', '/agent 你好', '/work 写代码', '/pc status', '/mode chat', 'SuperNova']) f.receive(text);
  f.receive('你好', { sender: { id: 'code-member', nickname: '管理员' } });
  f.receive('你好', { sender: { id: 'member', nickname: '小胖' } });
  f.receive('你好', { message: [{ type: 'at', data: { qq: accountId, name: '小胖' } }, { type: 'text', data: { text: '@小胖\u2005你好' } }] });
  f.receive('', { message: [{ type: 'image', data: {} }] });
  f.receive('小胖请执行', { messageType: 10000 });
  await f.channel.whenIdle();
  assert.equal(f.chat.length, 0); assert.equal(f.work.length, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(f.store.progress(accountId, 'group', room), progress);

  f.receive('小胖，你好'); await f.channel.whenIdle();
  f.receive('胖胖，解释一下 Python', { sender: { id: 'code-member' } }); await f.channel.whenIdle();
  f.receive('ＮＯＶＡ，聊聊吧'); await f.channel.whenIdle();
  f.receive('微信本名，聊聊吧'); await f.channel.whenIdle();
  assert.equal(f.work.length, 0); assert.equal(f.chat.length, 4); assert.equal(f.sent.length, 4);
  assert(f.chat.every(input => input.mode === 'nickname' && input.persona.name === '小胖'));
  assert(f.chat.every(input => !input.tools.some(tool => tool.name.startsWith('wechat_work_'))));
  assert(f.store.history(accountId, 'group', room).some(entry => entry.text === '小胖，你好'));
  assert(f.channel.memory.load({ accountId, chatType: 'group', peerId: room }).entries.some(entry => entry.text === '小胖，你好'));
  assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'work');
});

test('global and conversation administrators work without nickname while same-name members chat', async t => {
  const f = fixture(t);
  for (const id of ['global-admin', 'local-admin']) f.receive('处理这项任务', { sender: { id, nickname: '普通成员' } });
  await f.channel.whenIdle();
  assert.equal(f.work.length, 2); assert.equal(f.chat.length, 0);
  assert(f.work.every(input => input.request === '处理这项任务' && input.persona === undefined && input.history === undefined));
  f.receive('处理这项任务', { sender: { id: 'code-member', nickname: '管理员' } }); await f.channel.whenIdle();
  assert.equal(f.work.length, 2); assert.equal(f.chat.length, 0);
  f.receive('小胖，处理这项任务', { sender: { id: 'code-member', nickname: '管理员' } }); await f.channel.whenIdle();
  assert.equal(f.work.length, 2); assert.equal(f.chat.length, 1);
  assert(!f.store.history(accountId, 'group', room).some(entry => entry.senderId === 'global-admin' || entry.senderId === 'local-admin'));
});

test('nickname chat cannot switch modes, query administrator data or submit work commands', async t => {
  const f = fixture(t);
  f.channel.remote.query = () => { throw Error('non-administrator entered remote query'); };
  for (const text of ['小胖，切回聊天模式', '/work 写一个文件 小胖', '/pc status 小胖', '/dsh tasks 小胖']) {
    f.receive(text); await f.channel.whenIdle();
  }
  assert.equal(f.chat.length, 4); assert.equal(f.work.length, 0);
  assert(f.chat.every(input => input.mode === 'nickname' && !input.tools.some(tool => tool.name.startsWith('wechat_work_'))));
  assert.equal(f.store.conversationSettings(accountId, 'group', room).executionMode, 'work');
  assert(f.store.data.records.filter(record => record.state === 'sent').every(record => !record.modeControl && !record.remoteQuery && !record.workRequest));
});

test('private conversations use the same sender rule and nickname chat survives reloading configuration', async t => {
  const f = fixture(t), member = { chatType: 'private', peerId: 'member', sender: { id: 'member' } };
  f.receive('你好', member); await f.channel.whenIdle(); assert.equal(f.sent.length, 0);
  f.receive('小胖，你好', member); await f.channel.whenIdle(); assert.equal(f.chat.length, 1); assert.equal(f.work.length, 0);
  f.receive('处理任务', { chatType: 'private', peerId: 'global-admin', sender: { id: 'global-admin' } }); await f.channel.whenIdle();
  assert.equal(f.work.length, 1);
  await f.channel.close();
  const restored = new StateStore(f.root), channel = new WechatChannel({ store: restored, runner: f.runner, workRunner: f.workRunner, transport: f.transport });
  t.after(() => channel.close());
  channel.receive({ id: 'after-reload', direction: 'incoming', time: Math.floor(Date.now() / 1000), ...member,
    message: [{ type: 'text', data: { text: '胖胖，回来聊聊' } }] }, accountId);
  await channel.whenIdle(); assert.equal(f.chat.length, 2); assert.equal(f.work.length, 1);
  assert.equal(restored.conversationSettings(accountId, 'private', 'member').executionMode, 'work');
});

test('granting administrator access during chat generation cancels the old chat before sending', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { chatBefore: async () => { started.resolve(); await release.promise; }, release: () => release.resolve() });
  f.receive('小胖，你好'); await started.promise;
  f.configure({ adminIds: ['local-admin', 'member'] }); release.resolve(); await f.channel.whenIdle();
  assert.equal(f.chat.length, 1); assert.equal(f.work.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.store.data.records.find(record => record.question === '小胖，你好').state, 'cancelled');
});

test('administrator work does not block a different member nickname chat', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { workBefore: async () => { started.resolve(); await release.promise; }, release: () => release.resolve() });
  f.receive('处理任务', { sender: { id: 'global-admin' } }); await started.promise;
  f.receive('小胖，你好'); await f.channel.running;
  assert.equal(f.chat.length, 1); assert.equal(f.work.length, 1); assert(f.sent.some(payload => JSON.stringify(payload).includes('普通聊天回复')));
  release.resolve(); await f.channel.whenIdle();
  assert(f.sent.some(payload => JSON.stringify(payload).includes('管理员工作结果')));
});
