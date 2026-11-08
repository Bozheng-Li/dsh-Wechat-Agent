import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateStore, WechatChannel, createPluginService, replyMemoryContext } from '../lib/testing.js';

const scope = { accountId: 'context-owner', chatType: 'group', peerId: 'context-room@chatroom' };
const entry = (key, text, extras = {}) => ({ key, text, direction: 'incoming', senderId: 'alice', senderName: '阿禾', time: Date.now(), ...extras });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-reply-context-'));
  const store = new StateStore(root);
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '账号表达约定' });
  const calls = [], sent = [];
  const runner = { run: async input => { calls.push(input); return { text: '好，继续聊。' }; } };
  const worker = {
    status: () => ({ online: true, account: { id: scope.accountId, nickname: '合成账号' } }),
    send: async input => { sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['synthetic-ack-' + sent.length] }; },
  };
  const channel = new WechatChannel({ store, runner, transport: worker });
  const service = createPluginService({ ctx: {}, root, store, runner, worker, channel });
  let sequence = 0;
  const receive = text => {
    const id = 'context-message-' + ++sequence;
    channel.receive({ id, serverMessageId: id, chatType: scope.chatType, peerId: scope.peerId, direction: 'incoming',
      time: Math.floor(Date.now() / 1000), sender: { id: 'alice', nickname: '阿禾' }, message: [{ type: 'text', data: { text } }] }, scope.accountId);
  };
  t.after(async () => {
    await channel.close(); await service.drain(); channel.library.close();
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert(path.basename(target).startsWith('wechat-reply-context-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { store, channel, service, calls, sent, receive };
}

test('on-demand keeps recent conversation but neither a huge summary nor unrelated old facts', () => {
  const recent = entry('recent', '这家店的咖啡不错。');
  const result = replyMemoryContext({ snapshot: { entries: [recent], summary: '旧项目的工作日报。'.repeat(12000) },
    history: [recent], text: '是有点香', longTerm: '阿禾住在旧街。', onDemand: true });
  assert.equal(result.memory, undefined);
  assert.equal(result.referenceChars, 0);
  assert.deepEqual(result.history, [recent]);
});

test('automatic recall keeps a relevant older fact within budget and excludes recent duplicates', () => {
  const recent = entry('recent', '青藤书店的门口有树。');
  const old = entry('old', '阿禾约好周五十点在青藤书店见面。');
  const unrelated = entry('unrelated', '别的项目部署失败。'.repeat(10000));
  const filler = Array.from({ length: 19 }, (_, index) => entry('filler-' + index, '最近正在讨论一幅油画。'));
  const result = replyMemoryContext({ snapshot: { entries: [old, unrelated, ...filler, recent], summary: '' },
    history: [recent], text: '青藤书店的约定是什么？' });
  assert(result.memory.includes('周五十点'));
  assert(!result.memory.includes('部署失败'));
  assert(!result.memory.includes('门口有树'));
  assert(result.referenceChars <= 6000);
  assert.equal(result.history.at(-1).text, recent.text);
});

test('cleared or expired memory cannot come back through the separate chat archive', () => {
  const stale = entry('stale', '删除后不能复活的地址。');
  const current = entry('current', '你好');
  for (const onDemand of [true, false]) {
    const result = replyMemoryContext({ snapshot: { entries: [current], summary: '', triggerKey: 'current' },
      history: [stale], text: '还记得地址吗？', onDemand });
    assert.deepEqual(result.history, []);
    assert.equal(result.memory, undefined);
  }
});

test('on-demand has a scoped retrieval tool and current persona, with no old automatic prompt', async t => {
  const f = fixture(t);
  await f.service.call('persona.save', { persona: { name: '茶馆掌柜', aliases: [], prompt: '用掌柜口吻接话。' } });
  await f.service.call('conversation.configure', { ...scope, config: { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), memoryMode: 'on-demand' } });
  f.channel.memory.append(scope, entry('old', '阿禾约好周五在青藤书店见面。'));
  f.receive('/agent 你好'); await f.channel.whenIdle();
  const call = f.calls.at(-1);
  assert.equal(call.memory, undefined);
  assert.equal(call.persona.name, '茶馆掌柜');
  assert.equal(call.prompt, '账号表达约定');
  const tool = call.tools.find(tool => tool.name === 'wechat_memory'); assert(tool);
  const read = JSON.parse(await tool.execute({ section: 'conversation', query: '青藤书店' }, { signal: new AbortController().signal }));
  assert(read.text.includes('周五'));
  assert.equal(f.store.records(scope.accountId)[0].memoryContext.referenceChars, 0);
  assert.equal(f.sent.length, 1);
});

test('a compaction provider failure leaves the current reply deliverable and old material recoverable', async t => {
  const f = fixture(t);
  f.channel.memory.setWindowChars(1000);
  f.channel.runner.summarize = async () => { throw new Error('summary provider unavailable'); };
  f.channel.memory.append(scope, entry('oversized', '旧工作记录，需留在原文中。'.repeat(500)));
  f.receive('/agent 2加3是多少'); await f.channel.whenIdle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.records(scope.accountId)[0].state, 'sent');
  assert(f.channel.memory.view(scope).text.includes('旧工作记录'));
  assert(f.channel.memoryRetries.size > 0);
});

test('conversation persona overrides default and returns to the current default after clearing override', async t => {
  const f = fixture(t);
  await f.service.call('persona.save', { persona: { name: '默认阿宁', aliases: [], prompt: '轻快直接。' } });
  await f.service.call('conversation.configure', { ...scope, config: { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), persona: { name: '独立掌柜', aliases: [], prompt: '温和古风。' } } });
  f.receive('/agent 今天天气不错'); await f.channel.whenIdle();
  assert.equal(f.calls.at(-1).persona.name, '独立掌柜');
  await f.service.call('persona.save', { persona: { name: '新默认阿宁', aliases: [], prompt: '爽快。' } });
  f.receive('/agent 再聊两句'); await f.channel.whenIdle();
  assert.equal(f.calls.at(-1).persona.name, '独立掌柜');
  await f.service.call('conversation.configure', { ...scope, config: { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), persona: null } });
  f.receive('/agent 晚上好'); await f.channel.whenIdle();
  assert.equal(f.calls.at(-1).persona.name, '新默认阿宁');
  assert.equal(f.sent.length, 3);
});
