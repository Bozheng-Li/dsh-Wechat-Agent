import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { conversationMemoryTool } from '../src/features/memory/tool.mjs';
import { ConversationMemory, memoryText } from '../src/features/memory/conversation-memory.mjs';
import { LongTermMemory } from '../src/features/memory/long-term-memory.mjs';
import { StateStore } from '../src/storage/state-store.mjs';
import { ChannelError } from '../src/shared/contracts.mjs';

const scope = { accountId: 'combined-owner', chatType: 'group', peerId: 'combined@chatroom', requestedAt: 1794050000000 };
const notice = '此会话有新旧事实冲突待管理员确认；被争议的事实暂不作为确定信息使用。';
const entry = (text, senderId = 'alice', extra = {}) => ({ key: `${senderId}-${text.slice(0, 20)}`, text, senderId, senderName: '阿禾', direction: 'incoming', time: scope.requestedAt - 1000, ...extra });
const doc = (entries = [], extra = {}) => ({ generation: 'generation-1', summary: '', entries, ...extra });
const read = async (tool, args = {}) => JSON.parse(await tool.execute(args, {}));
const part = (result, section) => result.partitions.find(value => value.section === section);
const jsonRows = text => text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));

function stub({ document = doc(), longText = '', snapshot = document, allowed = () => {}, onRead } = {}) {
  const state = { document, longText, options: [], reads: 0 };
  const memory = { load: input => { assert.deepEqual(input, scope); state.reads++; return structuredClone(state.document); } };
  const longMemory = { readErrors: new Map(), prompt: (input, options) => { assert.deepEqual(input, scope); state.options.push(options); return state.longText; } };
  return { state, memory, longMemory, tool: conversationMemoryTool(memory, longMemory, scope, allowed, { snapshot, onRead }) };
}

test('one default read provides both sources of the final allergy case and reports a turn-local complete delivery', async () => {
  const original = entry('我对花生过敏。我们确认 2026 年 11 月 15 日下午三点在青藤书店见面。');
  const sources = [{ senderId: 'alice', sender: '阿禾', time: original.time, quote: '我对花生过敏。' }];
  const reports = [], f = stub({ document: doc([original]), longText: JSON.stringify({ text: '阿禾对花生过敏。', sources }), onRead: report => reports.push(report) });
  assert.equal(f.tool.getReadState(), undefined);
  const result = await read(f.tool, { query: '过敏 聚餐' });
  assert.equal(result.section, 'all'); assert.equal(result.partitions.length, 2);
  assert.equal(result.coverage, 'complete'); assert.equal(result.allAvailableMemoryReturned, true); assert.equal(result.receiveBounded, true);
  assert.equal(jsonRows(part(result, 'conversation').text)[0].senderId, 'alice');
  assert.deepEqual(jsonRows(part(result, 'long-term').text)[0].sources, sources);
  assert.equal(part(result, 'long-term').queryMatched, true); assert.deepEqual(part(result, 'long-term').unmatchedTerms, ['聚餐']);
  assert.deepEqual(f.state.options, [{ includeGlobal: false, includeSources: true, beforeTime: scope.requestedAt }]);
  assert.equal(reports.length, 1); assert.equal(reports[0].snapshotGeneration, 'generation-1');
  assert.equal(reports[0].requestedAt, scope.requestedAt); assert.equal(reports[0].allAvailableMemoryReturned, true);
  reports[0].allAvailableMemoryReturned = false;
  const exposed = f.tool.getReadState(); exposed.partitions[0].revision = 'changed-by-caller';
  assert.equal(f.tool.getReadState().allAvailableMemoryReturned, true);
  assert.notEqual(f.tool.getReadState().partitions[0].revision, 'changed-by-caller');
  assert.equal(stub().tool.getReadState(), undefined);
});

test('explicit all matches the default and archived single-section arguments retain their response shape', async () => {
  const f = stub({ document: doc([entry('本周去书店。')]), longText: '阿禾喜欢猫。' });
  assert.deepEqual(await read(f.tool), await read(f.tool, { section: 'all' }));
  const combined = await read(f.tool, { query: '书店' });
  const legacy = await read(f.tool, { section: 'conversation', query: '书店' });
  assert.deepEqual(legacy, part(combined, 'conversation'));
  assert.equal(legacy.partitions, undefined);
  assert.equal(f.tool.getReadState().allAvailableMemoryReturned, false);
  const full = await read(f.tool);
  assert.deepEqual(await read(f.tool, { section: 'all', offset: 0 }), full);
  await assert.rejects(read(f.tool, { revision: part(full, 'conversation').revision }), { code: 'INVALID_MEMORY_QUERY' });
  assert.equal(f.tool.getReadState(), undefined);
});

test('explicit first-page placeholders return the same sourced allergy fact without a false paging error', async () => {
  const f = stub({ document: doc([entry('我对花生过敏。')]), longText: '阿禾对花生过敏。' });
  const expected = await read(f.tool, { query: '阿禾 过敏' });
  for (const args of [
    { section: 'all', query: '阿禾 过敏', offset: 0, revision: '' },
    { section: null, query: '阿禾 过敏', offset: null, revision: null },
    { query: '阿禾 过敏', offset: 0, revision: null },
  ]) assert.deepEqual(await read(f.tool, args), expected);
  assert.deepEqual(await read(f.tool, { section: null, query: null, offset: null, revision: null }), await read(f.tool));
  assert.deepEqual(await read(f.tool, { section: 'conversation', query: '阿禾 过敏', offset: 0, revision: '' }), part(expected, 'conversation'));
  assert.equal(jsonRows(part(expected, 'conversation').text)[0].senderId, 'alice');
});

test('first-page placeholder compatibility cannot bypass pagination revisions or combine section cursors', async () => {
  const f = stub({ document: doc([], { summary: '分页原文。'.repeat(10000) }), longText: '阿禾对花生过敏。' });
  const first = await read(f.tool), local = part(first, 'conversation');
  assert(local.nextOffset > 0);
  for (const revision of [undefined, '', null])
    await assert.rejects(read(f.tool, { section: 'conversation', offset: local.nextOffset, revision }), { code: 'INVALID_MEMORY_QUERY' });
  for (const args of [{ section: 'all', offset: local.nextOffset, revision: null }, { section: 'all', offset: 0, revision: local.revision }])
    await assert.rejects(read(f.tool, args), { code: 'INVALID_MEMORY_QUERY' });
  await assert.rejects(read(f.tool, { section: 'conversation', offset: local.nextOffset, revision: 'initial' }), { code: 'MEMORY_CHANGED' });
  assert((await read(f.tool, { section: 'conversation', offset: local.nextOffset, revision: local.revision })).text.length > 0);
  f.state.document.summary += '最新更正。';
  const freshTool = conversationMemoryTool(f.memory, f.longMemory, scope, () => {});
  await assert.rejects(read(freshTool, { section: 'conversation', offset: 0, revision: local.revision }), { code: 'MEMORY_CHANGED' });
});

test('a complete first read leaves legitimate new-person and single-partition follow-ups available', async () => {
  const f = stub({ document: doc([entry('我对花生过敏。'), entry('我对牛奶过敏。', 'bob'), entry('小李说他爱喝茶。', 'assistant', { direction: 'outgoing' })]) });
  const result = await read(f.tool, { query: '过敏' }), rows = jsonRows(part(result, 'conversation').text);
  assert.equal(result.allAvailableMemoryReturned, true);
  assert.deepEqual(rows.map(row => row.senderId), ['alice', 'bob', 'assistant']);
  assert.deepEqual(rows.map(row => row.direction), ['incoming', 'incoming', 'outgoing']);
  assert.equal(rows[0].speaker, rows[1].speaker);
  assert((await read(f.tool, { section: 'conversation', query: 'bob' })).text.includes('牛奶过敏'));
  assert((await read(f.tool, { section: 'conversation', query: '小李' })).text.includes('小李说'));
});

test('short lexical misses, facts in only the other partition, and two empty stores remain distinguishable', async () => {
  const f = stub({ longText: '阿禾一直喜欢猫。' }), result = await read(f.tool, { query: '偏好' });
  assert.equal(result.found, true); assert.equal(result.coverage, 'complete');
  assert.equal(part(result, 'conversation').found, false);
  assert.equal(part(result, 'long-term').queryMatched, false); assert.equal(part(result, 'long-term').text, '阿禾一直喜欢猫。');
  const empty = await read(stub().tool, { query: '姐姐 生日' });
  assert.equal(empty.found, false); assert.equal(empty.coverage, 'complete'); assert.equal(empty.allAvailableMemoryReturned, true);
  assert(empty.partitions.every(value => value.text === '' && !value.error));
});

test('two large partitions share the text budget and independently paginate every original record', async () => {
  const f = stub({ document: doc(Array.from({ length: 180 }, (_, index) => entry(`原文${index}：${'完整证据。'.repeat(60)}`, `speaker-${index}`))),
    longText: Array.from({ length: 180 }, (_, index) => JSON.stringify({ text: `长期${index}：${'有效事实。'.repeat(60)}`, sources: [{ senderId: `speaker-${index}`, sender: '阿禾', time: index, quote: '原文依据' }] })).join('\n') });
  const result = await read(f.tool);
  assert.equal(result.coverage, 'partial'); assert.equal(result.allAvailableMemoryReturned, false);
  assert(result.partitions.reduce((total, value) => total + value.text.length, 0) <= 24000);
  assert(result.partitions.every(value => value.text.length <= 12000 && value.nextOffset > 0 && !value.fragmented));
  const expected = { conversation: memoryText(f.state.document), 'long-term': f.state.longText };
  for (const first of result.partitions) {
    let page = first, text = first.text;
    while (page.nextOffset !== null) {
      page = await read(f.tool, { section: page.section, offset: page.nextOffset, revision: page.revision });
      assert(page.text.length <= 24000); assert(!page.fragmented); jsonRows(page.text); text += page.text;
    }
    assert.equal(text, expected[first.section]);
  }
  await assert.rejects(read(f.tool, { section: 'conversation', revision: part(result, 'long-term').revision, offset: 12000 }), { code: 'MEMORY_CHANGED' });
});

test('an empty or short partition lends its unused budget without hiding the other partition', async () => {
  for (const longText of ['', '长期事实。']) {
    const f = stub({ document: doc([], { summary: '背景资料。'.repeat(10000) }), longText });
    const result = await read(f.tool), local = part(result, 'conversation'), long = part(result, 'long-term');
    assert.equal(long.text, longText); assert.equal(long.coverage, 'complete');
    assert(local.text.length > 12000); assert(local.text.length + long.text.length <= 24000);
    assert.equal(result.allAvailableMemoryReturned, false);
  }
});

test('source or query revisions changing reject paging and a change in one partition does not invalidate the other', async () => {
  const f = stub({ document: doc([], { summary: '会话资料。'.repeat(10000) }), longText: '长期资料。'.repeat(10000) });
  const result = await read(f.tool), local = part(result, 'conversation'), long = part(result, 'long-term');
  f.state.longText += '新增资料';
  await assert.rejects(read(f.tool, { section: 'long-term', offset: long.nextOffset, revision: long.revision }), { code: 'MEMORY_CHANGED' });
  assert((await read(f.tool, { section: 'conversation', offset: local.nextOffset, revision: local.revision })).text.length > 0);
  await assert.rejects(read(f.tool, { section: 'conversation', query: '资料', offset: local.nextOffset, revision: local.revision }), { code: 'MEMORY_CHANGED' });
  const oldRevision = createHash('sha256').update(f.state.longText + '\n').digest('hex');
  await assert.rejects(read(f.tool, { section: 'long-term', offset: 24000, revision: oldRevision }), { code: 'MEMORY_CHANGED' });
});

test('long JSON excerpts retain sender, direction, time and original fact quotations', async () => {
  const sources = [{ senderId: 'alice', sender: '阿禾', time: 1, quote: '书店约定就在下周五。' }];
  const text = '背景。'.repeat(10000) + '书店约定就在下周五。' + '背景。'.repeat(10000);
  const f = stub({ document: doc([entry(text)]), longText: JSON.stringify({ text, sources }) });
  const result = await read(f.tool, { query: '书店约定' });
  assert(result.partitions.reduce((sum, value) => sum + value.text.length, 0) <= 24000);
  const local = jsonRows(part(result, 'conversation').text)[0], long = jsonRows(part(result, 'long-term').text)[0];
  assert.equal(local.senderId, 'alice'); assert.equal(local.direction, 'incoming'); assert.equal(local.time, scope.requestedAt - 1000);
  assert(local.text.includes('书店约定就在下周五')); assert(local.excerpted); assert.deepEqual(long.sources, sources);
  assert.equal(result.allAvailableMemoryReturned, false);
});

test('overlong raw records remain recoverable through marked fragments without a false complete result', async () => {
  const f = stub({ longText: JSON.stringify({ text: '长原文。'.repeat(10000), sources: [{ senderId: 'alice', time: 10, quote: '原文尾部证据' }] }) });
  let page = part(await read(f.tool), 'long-term'), text = page.text;
  assert.equal(page.fragmented, true); assert.match(page.fragmentGuidance, /完整来源/);
  while (page.nextOffset !== null) {
    page = await read(f.tool, { section: 'long-term', offset: page.nextOffset, revision: page.revision });
    assert.equal(page.fragmented, true); text += page.text;
  }
  assert.equal(text, f.state.longText); assert.equal(JSON.parse(text).sources[0].senderId, 'alice');
});

test('a keyword found only in a saved quotation retains the complete attributed record', async () => {
  const sources = [{ senderId: 'alice', sender: '阿禾', time: 10, quote: '原话重点是周五。' }];
  const longText = JSON.stringify({ text: '一段未包含检索词的概括。' + '背景资料。'.repeat(1400), sources });
  const result = await read(stub({ longText }).tool, { query: '原话重点' });
  const long = part(result, 'long-term');
  assert.equal(long.text, longText); assert.equal(long.queryMatched, true);
  assert.deepEqual(JSON.parse(long.text).sources, sources); assert.equal(long.truncated, false);
});

test('conflict notices survive lexical filtering and never signal closure even when both partitions fit', async () => {
  const f = stub({ document: doc([entry('时间改成周日。')]), longText: notice + '\n' + '无关背景。\n'.repeat(1500) + JSON.stringify({ text: '另一个书店安排。', sources: [{ senderId: 'bob', time: 5, quote: '书店' }] }) });
  const filtered = await read(f.tool, { query: '书店' }), long = part(filtered, 'long-term');
  assert.equal(long.coverage, 'matches'); assert.equal(long.hasConflicts, true); assert.deepEqual(long.notices, [notice]);
  assert.equal(filtered.allAvailableMemoryReturned, false);
  f.state.longText = notice;
  const complete = await read(f.tool, { query: '时间' });
  assert.equal(complete.coverage, 'complete'); assert.equal(complete.hasConflicts, true);
  assert.equal(complete.allAvailableMemoryReturned, false); assert.equal(f.tool.getReadState().hasConflicts, true);
});

test('a damaged partition is unavailable while healthy evidence remains usable', async () => {
  const f = stub({ document: doc([entry('阿禾喜欢猫。')]) });
  f.longMemory.readErrors.set(scope.accountId, '长期记忆文件无法读取');
  const result = await read(f.tool, { query: '喜欢' });
  assert.equal(result.found, true); assert.equal(result.coverage, 'partial'); assert.equal(result.allAvailableMemoryReturned, false);
  assert(part(result, 'conversation').text.includes('喜欢猫')); assert.equal(part(result, 'long-term').coverage, 'unavailable');
  assert.match(part(result, 'long-term').error, /无法读取/);
  f.longMemory.readErrors.clear(); f.state.longText = '阿禾喜欢猫。';
  f.memory.load = () => { throw new ChannelError('MEMORY_INVALID', '会话记忆文件无法读取'); };
  const other = await read(f.tool);
  assert.equal(part(other, 'conversation').coverage, 'unavailable'); assert.equal(part(other, 'long-term').text, '阿禾喜欢猫。');
  assert.equal(other.allAvailableMemoryReturned, false);
  await assert.rejects(read(f.tool, { section: 'conversation' }), { code: 'MEMORY_INVALID' });
});

test('the receive snapshot hides later messages and clearing invalidates it before returning either partition', async () => {
  const document = doc([entry('接收前的资料。')]), f = stub({ document });
  document.entries.push(entry('之后才到的资料。', 'bob'));
  const result = await read(f.tool);
  assert(part(result, 'conversation').text.includes('接收前')); assert(!part(result, 'conversation').text.includes('之后才到'));
  f.state.document.generation = 'generation-cleared';
  await assert.rejects(read(f.tool), { code: 'MEMORY_CHANGED' });
  assert.equal(f.tool.getReadState(), undefined);
});

test('a clear during the synchronous dual read cannot report the old snapshot as complete', async () => {
  const f = stub({ document: doc([entry('旧资料。')]) });
  f.longMemory.prompt = () => { f.state.document.generation = 'new-generation'; return ''; };
  await assert.rejects(read(f.tool), { code: 'MEMORY_CHANGED' }); assert.equal(f.tool.getReadState(), undefined);
});

test('authorization and cancellation are rechecked before reads and never leave an old complete report', async () => {
  let allowed = true;
  const f = stub({ allowed: () => { if (!allowed) throw new Error('revoked'); } });
  await read(f.tool); const reads = f.state.reads; allowed = false;
  await assert.rejects(read(f.tool), /revoked/); assert.equal(f.state.reads, reads); assert.equal(f.tool.getReadState(), undefined);
  allowed = true; await read(f.tool);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(f.tool.execute({}, { signal: controller.signal }), /cancelled/); assert.equal(f.tool.getReadState(), undefined);
});

test('unbounded callers cannot claim a receive-bounded read and invalid parameters fail clearly', async () => {
  const f = stub(), tool = conversationMemoryTool(f.memory, f.longMemory, scope, () => {});
  assert.equal((await read(tool)).receiveBounded, false); assert.equal(tool.getReadState().receiveBounded, false);
  for (const args of [null, [], { section: 'private' }, { query: 1 }, { query: 'x'.repeat(121) }, { section: 'conversation', offset: -1 }, { section: 'long-term', revision: 5 }, { query: '，；' }])
    await assert.rejects(read(tool, args), { code: 'INVALID_MEMORY_QUERY' });
});

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-combined-memory-'));
  const store = new StateStore(root); store.configure(scope.accountId, { enabled: true, groups: [scope.peerId, 'other@chatroom'], privatePeers: [], prompt: '' });
  let time = scope.requestedAt - 2000;
  const now = () => time, memory = new ConversationMemory(store, { now }), longMemory = new LongTermMemory(store, { now });
  store.memory = memory; memory.onPressure = null;
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('wechat-combined-memory-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const save = async (target, key, text, senderId = 'alice', replaces = []) => {
    longMemory.capture(target, [entry(text, senderId, { key, time })]);
    return longMemory.extract(target, { run: async () => ({ text: JSON.stringify({ facts: [{ text, sources: ['s1'], evidence: [{ source: 's1', quote: text }], replaces }] }) }) }, new AbortController().signal);
  };
  return { store, memory, longMemory, save, advance: value => { time += value; } };
}

test('real stores keep account, peer, global notes and receive-time boundaries while owner deletion is immediate', async t => {
  const f = fixture(t);
  await f.save(scope, 'prior', '阿禾对花生过敏。');
  await f.save({ ...scope, peerId: 'other@chatroom' }, 'other-room', '另一群的专属事实。');
  const otherAccount = { ...scope, accountId: 'other-owner' };
  f.store.configure(otherAccount.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  await f.save(otherAccount, 'other-account', '另一个账号的专属事实。');
  const notes = f.longMemory.view(scope.accountId);
  f.longMemory.edit(scope.accountId, notes.markdown.slice(0, notes.globalRange.start) + '\n不得读取的全局备注。\n' + notes.markdown.slice(notes.globalRange.end), notes.revision);
  f.advance(4000); await f.save(scope, 'future', '后来才收到的生日。');
  const tool = conversationMemoryTool(f.memory, f.longMemory, scope, () => {}, { snapshot: f.memory.snapshot(scope) });
  const result = await read(tool), text = part(result, 'long-term').text;
  assert(text.includes('花生过敏')); assert(!/专属事实|全局备注|后来才收到/u.test(text));
  assert.equal(jsonRows(text)[0].sources[0].senderId, 'alice'); assert.equal(result.receiveBounded, true);
  const revision = part(result, 'long-term').revision;
  f.longMemory.clear(scope.accountId);
  await assert.rejects(read(tool, { section: 'long-term', revision, offset: 0 }), { code: 'MEMORY_CHANGED' });
  assert.equal(part(await read(tool), 'long-term').text, '');
});

test('real pending corrections remain visibly disputed in a complete combined read', async t => {
  const f = fixture(t); await f.save(scope, 'old', '阿禾习惯喝咖啡。');
  const old = f.longMemory.view(scope.accountId).sections[0].facts[0];
  f.advance(100); await f.save(scope, 'new', '阿禾现在只喝红茶。', 'alice', [old.id]);
  f.memory.append(scope, entry('之前咖啡说错了，现在只喝红茶。'));
  const tool = conversationMemoryTool(f.memory, f.longMemory, scope, () => {}, { snapshot: f.memory.snapshot(scope) });
  const result = await read(tool, { query: '红茶' });
  assert.equal(result.hasConflicts, true); assert.equal(result.allAvailableMemoryReturned, false);
  assert(part(result, 'conversation').text.includes('只喝红茶')); assert.deepEqual(part(result, 'long-term').notices, [notice]);
  assert(!part(result, 'long-term').text.includes('阿禾习惯喝咖啡。'));
});
