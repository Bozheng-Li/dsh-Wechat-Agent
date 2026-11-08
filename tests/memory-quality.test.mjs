import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, ConversationMemory, LongTermMemory, WechatChannel, EMPTY_MEMORY_SUMMARY } from '../lib/testing.js';
import { conversationMemoryTool, relevantMemoryReference } from '../src/features/memory/tool.mjs';

const signal = () => new AbortController().signal;
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-memory-quality-'));
  const store = new StateStore(root), scope = { accountId: 'quality-owner', chatType: 'group', peerId: 'quality@chatroom' };
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  let time = Date.parse('2026-11-07T06:00:00Z');
  const now = () => time, local = new ConversationMemory(store, { now }), long = new LongTermMemory(store, { now });
  store.memory = local;
  const entry = (key, text, extra = {}) => ({ key, text, time, senderId: 'alice', senderName: '阿禾', direction: 'incoming', ...extra });
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('wechat-memory-quality-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, scope, local, long, entry, now, cleanup, advance: value => { time += value; } };
}

test('explicitly worthless compaction clears only the covered material and archives its original source', async t => {
  const f = fixture(t); f.local.setWindowChars(1000);
  f.local.append(f.scope, f.entry('noise', '你好。哈哈。收到。'.repeat(250)));
  f.local.append(f.scope, f.entry('recent', '等下继续聊'));
  const before = f.local.load(f.scope);
  await f.local.compact(f.scope, { summarize: async () => EMPTY_MEMORY_SUMMARY }, signal());
  const after = f.local.view(f.scope);
  assert.equal(after.summary, ''); assert.equal(after.summaryExpiresAt, null); assert.equal(after.error, null);
  assert.equal(after.entries.length, 1); assert.equal(after.entries[0].key, 'recent');
  assert.equal(after.compressions, 1);
  const archive = path.join(path.dirname(after.path), 'archive');
  const saved = JSON.parse(fs.readFileSync(path.join(archive, fs.readdirSync(archive)[0]), 'utf8'));
  assert.deepEqual(saved, before);
  assert(!new ConversationMemory(f.store).view(f.scope).text.includes(EMPTY_MEMORY_SUMMARY));
});

test('empty provider responses preserve all source material while a retry re-reads original evidence', async t => {
  const f = fixture(t); f.local.setWindowChars(1000);
  f.local.append(f.scope, f.entry('fact', '阿禾不吃花生。' + '普通闲聊。'.repeat(400)));
  const before = f.local.load(f.scope);
  await assert.rejects(f.local.compact(f.scope, { summarize: async () => '' }, signal()), { code: 'MEMORY_COMPRESSION_FAILED' });
  assert.deepEqual(f.local.load(f.scope), before);
  let calls = 0;
  await f.local.compact(f.scope, { summarize: async material => {
    calls++;
    assert(material.includes('阿禾不吃花生'));
    assert(!material.includes('第一轮捏造了另一种过敏'));
    return calls === 1 ? '第一轮捏造了另一种过敏。'.repeat(200) : '阿禾不吃花生。';
  } }, signal());
  assert.equal(calls, 2); assert.equal(f.local.view(f.scope).summary, '阿禾不吃花生。');
});

test('automatic references select relevant facts without dumping unrelated history or changing its source', () => {
  const source = '- 阿禾喜欢吃柚子。\n- 小林周五去书店。\n' + '无关调试流水账。\n'.repeat(2000);
  const relevant = relevantMemoryReference(source, '阿禾喜欢什么水果', { maxChars: 200 });
  assert(relevant.text.includes('阿禾喜欢吃柚子')); assert(!relevant.text.includes('小林')); assert(relevant.text.length <= 200);
  const none = relevantMemoryReference(source, '早上好', { maxChars: 200 });
  assert.equal(none.text, ''); assert.equal(none.found, true);
  assert.equal(source.split('\n').length, 2003);
});

test('automatic recall ignores salutations, role names, JSON metadata and self-contained tasks', () => {
  const source = [
    JSON.stringify({ senderId: 'old-metadata', speaker: '小胖', direction: 'incoming', text: '早上好，你在吗？我想知道你今天好吗。' }),
    JSON.stringify({ senderId: 'postgres', speaker: 'metadata', direction: 'incoming', text: '阿禾喜欢猫。' }),
    '- 以前有人问过如何安装 Python，以及如何写一个函数。',
    '- 上次计算 123+456 的结果。',
  ].join('\n');
  for (const query of ['早上好', '小胖', '小胖，在吗？', '你今天好吗？', 'postgres', '如何安装 Python', '请计算 123+456']) {
    assert.equal(relevantMemoryReference(source, query, { names: ['小胖'] }).text, '', query);
  }
  assert(relevantMemoryReference(source, '阿禾喜欢什么', { names: ['小胖'] }).text.includes('阿禾喜欢猫'));
});

test('an unqueried large memory can be paged to its tail without pretending the first page is complete', async () => {
  const scope = { accountId: 'quality-owner', chatType: 'group', peerId: 'quality@chatroom' };
  const source = '既有资料。'.repeat(9000) + '末尾约定：周六下午去青藤书店。';
  const tool = conversationMemoryTool({}, { prompt: () => source }, scope, () => {});
  const first = JSON.parse(await tool.execute({ section: 'long-term' }, {}));
  assert(first.nextOffset > 0); assert.equal(first.coverage, 'partial'); assert(first.omitted);
  let text = first.text, page = first;
  while (page.nextOffset !== null) {
    page = JSON.parse(await tool.execute({ section: 'long-term', offset: page.nextOffset, revision: page.revision }, {}));
    text += page.text;
  }
  assert.equal(text, source); assert(text.endsWith('青藤书店。'));
});

test('paging refuses a changed memory revision and tool reads remain bounded to the received snapshot', async t => {
  const f = fixture(t); let source = '原始资料。'.repeat(6000);
  const tool = conversationMemoryTool({}, { prompt: () => source }, f.scope, () => {});
  const first = JSON.parse(await tool.execute({ section: 'long-term' }, {})); source += '更新后的资料';
  await assert.rejects(tool.execute({ section: 'long-term', offset: first.nextOffset, revision: first.revision }, {}), { code: 'MEMORY_CHANGED' });
  f.local.append(f.scope, f.entry('past', '阿禾喜欢猫。'));
  const snapshot = f.local.snapshot(f.scope);
  f.local.append(f.scope, f.entry('future', '后来的一条不属于本轮的消息。'));
  const scoped = conversationMemoryTool(f.local, f.long, f.scope, () => {}, { snapshot });
  const result = JSON.parse(await scoped.execute({ section: 'conversation' }, {}));
  assert(result.text.includes('喜欢猫')); assert(!result.text.includes('后来的一条'));
  f.local.clear(f.scope);
  await assert.rejects(scoped.execute({ section: 'conversation' }, {}), { code: 'MEMORY_CHANGED' });
});

test('greetings, acknowledgements and unseen images complete extraction without calling a model', async t => {
  const f = fixture(t);
  f.long.capture(f.scope, [f.entry('hi', '你好！'), f.entry('laugh', '哈哈哈哈'), f.entry('ack', '收到，谢谢。'), f.entry('image', '[图片]')]);
  let calls = 0;
  const result = await f.long.extract(f.scope, { run: async () => { calls++; throw new Error('should not call'); } }, signal());
  assert.equal(calls, 0); assert.equal(result.processed, 4); assert.equal(result.pendingCount, 0); assert.equal(result.added, 0);
});

test('useful statements following a greeting are extracted and checked quotations are preserved for review', async t => {
  const f = fixture(t), text = '你好！我对花生过敏，聚餐别点含花生的菜。';
  f.long.capture(f.scope, [f.entry('allergy', text)]);
  const result = await f.long.extract(f.scope, { run: async request => {
    assert(request.text.includes(text));
    return { text: JSON.stringify({ facts: [{ text: '阿禾对花生过敏。', sources: ['s1'], evidence: [{ source: 's1', quote: '我对花生过敏' }], replaces: [] }] }) };
  } }, signal());
  assert.equal(result.added, 1);
  const fact = f.long.view(f.scope.accountId).sections[0].facts[0];
  assert.equal(fact.sources[0].quote, '我对花生过敏'); assert.equal(fact.sources[0].senderId, 'alice');
  const tool = conversationMemoryTool(f.local, f.long, f.scope, () => {});
  const read = JSON.parse(await tool.execute({ section: 'long-term', query: '过敏' }, {}));
  const attributed = JSON.parse(read.text.split('\n').find(line => line.startsWith('{')));
  assert.equal(attributed.text, fact.text);
  assert.equal(attributed.sources[0].senderId, 'alice');
  assert.equal(attributed.sources[0].time, f.now());
  assert.equal(attributed.sources[0].quote, '我对花生过敏');
  assert.equal(read.coverage, 'complete');
});

test('invented quotations reject the whole extraction and retain the pending source for retry', async t => {
  const f = fixture(t); f.long.capture(f.scope, [f.entry('source', '我喜欢猫。')]);
  await assert.rejects(f.long.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text: '阿禾讨厌狗。', sources: ['s1'], evidence: [{ source: 's1', quote: '我讨厌狗' }], replaces: [] }] }) }) }, signal()), { code: 'LONG_MEMORY_EXTRACTION_FAILED' });
  assert.equal(f.long.view(f.scope.accountId).factCount, 0); assert.equal(f.long.view(f.scope.accountId).pendingCount, 1);
});

test('turn-bounded long memory hides later facts and observes owner deletion immediately', async t => {
  const f = fixture(t), extract = async (key, text) => {
    f.long.capture(f.scope, [f.entry(key, text)]);
    await f.long.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text, sources: ['s1'], replaces: [] }] }) }) }, signal());
  };
  await extract('past', '阿禾喜欢猫。'); const beforeTime = f.now(); f.advance(1000);
  await extract('future', '阿禾下周搬家。');
  assert(f.long.prompt(f.scope, { beforeTime }).includes('喜欢猫')); assert(!f.long.prompt(f.scope, { beforeTime }).includes('下周搬家'));
  f.long.clear(f.scope.accountId); assert.equal(f.long.prompt(f.scope, { beforeTime }), '');
});

test('already ended temporary facts are not added even with an explicit source expiry', async t => {
  const f = fixture(t); f.long.capture(f.scope, [f.entry('ended', '今天上午九点的临时碰头已经结束。')]);
  const result = await f.long.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text: '阿禾上午九点临时碰头。', sources: ['s1'], replaces: [], expiresAt: f.now() - 1000 }] }) }) }, signal());
  assert.equal(result.added, 0); assert.equal(f.long.view(f.scope.accountId).sections.length, 0);
});

test('calendar expiry preserves the stated year and timezone without model epoch arithmetic', async t => {
  const f = fixture(t), text = '2026 年 11 月 15 日下午三点在青藤书店碰面，这条安排保留到 2026 年 11 月 16 日零点。';
  f.long.capture(f.scope, [f.entry('future-arrangement', text)]);
  const result = await f.long.extract(f.scope, { run: async request => {
    assert(request.text.includes('ISO 8601'));
    return { text: JSON.stringify({ facts: [{ text, sources: ['s1'], evidence: [{ source: 's1', quote: text }], replaces: [], expiresAt: '2026-11-16T00:00:00+08:00' }] }) };
  } }, signal());
  assert.equal(result.added, 1);
  const fact = f.long.view(f.scope.accountId).sections[0].facts[0];
  assert.equal(fact.expiresAt, Date.parse('2026-11-15T16:00:00Z'));
  assert.equal(fact.expirySource, 'source');
  assert(f.long.prompt(f.scope).includes('青藤书店'));
});

test('invalid or timezone-free calendar expiry keeps its original sources available for retry', async t => {
  const f = fixture(t), text = '请把这条临时安排保留到明年二月底。';
  f.long.capture(f.scope, [f.entry('invalid-expiry', text)]);
  for (const expiresAt of ['2027-02-30T00:00:00+08:00', '2027-02-28T00:00:00', '明年二月底']) {
    await assert.rejects(f.long.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text, sources: ['s1'], replaces: [], expiresAt }] }) }) }, signal()), { code: 'LONG_MEMORY_EXTRACTION_FAILED' });
    assert.equal(f.long.view(f.scope.accountId).pendingCount, 1);
    assert.equal(f.long.view(f.scope.accountId).factCount, 0);
  }
});

test('startup resumes persisted fact extraction below the conversation-window threshold', async t => {
  const f = fixture(t);
  f.long.capture(f.scope, [f.entry('before-restart', '阿禾以后聚餐要避开花生。')]);
  let calls = 0;
  const runner = { extractLongTermMemory: async () => { calls++; return { text: '{"facts":[]}' }; } };
  const channel = new WechatChannel({ store: f.store, memory: f.local, longMemory: new LongTermMemory(f.store, { now: f.now }), runner, now: f.now,
    transport: { status: () => ({ online: true, account: { id: f.scope.accountId } }), send: async () => { throw new Error('maintenance cannot send'); } } });
  f.cleanup.push(() => channel.close());
  await new Promise(resolve => setImmediate(resolve)); await channel.whenIdle();
  assert.equal(calls, 1); assert.equal(f.long.view(f.scope.accountId).pendingCount, 0);
  assert(f.local.view(f.scope).chars < f.local.windowChars(f.scope));
});

test('failed fact extraction retries without new messages and incoming sources respect its backoff', async t => {
  const f = fixture(t); let calls = 0;
  const runner = { extractLongTermMemory: async () => { calls++; if (calls === 1) throw new Error('synthetic provider offline'); return { text: '{"facts":[]}' }; } };
  const channel = new WechatChannel({ store: f.store, memory: f.local, longMemory: f.long, runner, now: f.now,
    transport: { status: () => ({ online: true, account: { id: f.scope.accountId } }), send: async () => { throw new Error('maintenance cannot send'); } } });
  f.cleanup.push(() => channel.close());
  f.local.append(f.scope, f.entry('failure', '阿禾下周开始改喝红茶。'));
  await new Promise(resolve => setImmediate(resolve)); await channel.whenIdle();
  assert.equal(calls, 1); assert(f.long.view(f.scope.accountId).error); assert.equal(f.local.view(f.scope).retryAt, f.now() + 30000);
  f.local.append(f.scope, f.entry('during-backoff', '阿禾还要记得带茶杯。'));
  await new Promise(resolve => setImmediate(resolve)); await channel.whenIdle();
  channel.checkMemoryPressure(); await channel.whenIdle(); assert.equal(calls, 1);
  f.advance(30000); channel.checkMemoryPressure(); await channel.whenIdle();
  assert.equal(calls, 2); assert.equal(f.long.view(f.scope.accountId).pendingCount, 0);
  assert.equal(f.long.view(f.scope.accountId).error, null); assert.equal(f.local.view(f.scope).retryAt, null);
});
