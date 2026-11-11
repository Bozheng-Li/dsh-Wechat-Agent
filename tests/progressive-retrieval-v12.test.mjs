import test from 'node:test';
import assert from 'node:assert/strict';
import { replyMemoryContext, recentReplyHistory } from '../modules/conversation/reply-context.mjs';
import { conversationMemoryTool } from '../modules/memory/query/tool.mjs';
import { conversationImageTool } from '../modules/memory/images/request-tool.mjs';

const now = 1794276000000;
const scope = { accountId: 'retrieval-v12', chatType: 'group', peerId: 'synthetic-room', requestedAt: now };
const entry = (key, text, extra = {}) => ({ key, text, time: now - 1000, senderId: 'alice', senderName: '小许', direction: 'incoming', ...extra });
const document = entries => ({ generation: 'g1', createdAt: now - 2000, summary: '', entries });
const contextualize = (snapshot, text, extra = {}) => replyMemoryContext({ snapshot, text, promptStrategy: 'progressive-v1', ...extra });
const read = async (tool, args = {}) => JSON.parse(await tool.execute(args, {}));
const partition = (result, section) => result.partitions.find(item => item.section === section);
const image = description => ({ type: 'image', resourceId: 'resource-1', description, quality: 'thumbnail' });

function memoryFixture(snapshot, longText = '', strategy = 'progressive-v1') {
  const reports = [], longMemory = { prompt: () => longText, readErrors: new Map() };
  return { reports, longMemory, tool: conversationMemoryTool({ load: () => snapshot }, longMemory, scope, () => {},
    { snapshot, promptStrategy: strategy, onRead: report => reports.push(report) }) };
}

test('progressive image history uses 80 complete Unicode characters within the existing UTF-16 budget', () => {
  const original = document([entry('photo', '用户的文字事实不变。', { attachments: [image('😀'.repeat(1000))] })]);
  const before = structuredClone(original);
  const result = contextualize(original, '看看之前的图片', { onDemand: true });
  const row = result.history[0], note = row.attachments[0];
  assert.equal(Array.from(note.description).length, 80);
  assert(note.description.isWellFormed()); assert.equal(note.quality, 'thumbnail');
  assert.equal(note.descriptionTruncated, true); assert.equal(row.contextOmitted, true);
  assert.equal(row.contextTextOmitted, false); assert.equal(row.text, original.entries[0].text);
  const tight = recentReplyHistory(original.entries, { maxChars: 444, maxEntries: 1, imageSummaryChars: 80 });
  const tightRow = tight[0];
  assert(tightRow.attachments[0].description.isWellFormed());
  assert(tightRow.text.length + 200 + tightRow.attachments[0].description.length + 200 <= 444);
  assert.deepEqual(original, before);
  assert.equal(recentReplyHistory(original.entries)[0].attachments[0].description.length, 1000, 'legacy projection remains unchanged');
});

test('image-only clipping does not reinsert full notes into automatic memory and explicit note reading still expands them', async () => {
  const note = '票据上的普通背景。'.repeat(80) + '末尾收据编号 Z918。';
  const snapshot = document([entry('photo', '这是我的票据。', { messageId: 'msg-1', rememberedAt: now - 1000, attachments: [image(note)] })]);
  const before = structuredClone(snapshot);
  const context = contextualize(snapshot, '票据的收据编号是什么');
  assert.equal(context.history[0].contextTextOmitted, false);
  assert.equal(context.memory, undefined, 'a shortened attachment alone does not make the whole recent row old memory');
  assert(!JSON.stringify(context).includes('Z918'));
  const memory = { load: () => snapshot, expiry: () => now + 10000, now: () => now,
    images: { load: () => ({ deleted: {} }), imageId: () => 'saved-photo' } };
  const tool = conversationImageTool(memory, {}, {}, scope, () => {}, { snapshot, currentKey: 'photo', promptStrategy: 'progressive-v1' });
  const catalog = JSON.parse(tool.description.slice(tool.description.indexOf('[{')));
  const expanded = await read(tool, { imageId: catalog[0].imageId, action: 'read' });
  assert.equal(expanded.observation, note); assert.equal(expanded.source, 'saved-image-note');
  assert(expanded.limitation, 'thumbnail uncertainty is retained');
  assert.deepEqual(snapshot, before);
});

test('automatic references keep old message facts and source quality while long image tails remain deferred', () => {
  const old = entry('old-photo', '送货地址是柳路42号。', { attachments: [image('票据图像背景。'.repeat(100) + '图片末尾凭证 R681。')] });
  const snapshot = document([old, ...Array.from({ length: 13 }, (_, i) => entry('new-' + i, '今天天气话题。'))]);
  const before = structuredClone(snapshot);
  const result = contextualize(snapshot, '送货地址和票据凭证');
  assert(result.memory.includes('柳路42号')); assert(result.memory.includes('alice'));
  assert(result.memory.includes('thumbnail')); assert(result.memory.includes('图片笔记有省略'));
  assert(!result.memory.includes('R681')); assert(result.referenceChars <= 3000);
  assert.deepEqual(snapshot, before);
});

test('text omitted with or without an image remains searchable instead of being mistaken for image-only clipping', () => {
  for (const withImage of [false, true]) {
    const text = '日常讨论。'.repeat(1300) + '最终送货地址是竹路73号。';
    const snapshot = document([entry('long', text, withImage ? { attachments: [image('票据背景。'.repeat(80) + '笔记尾部 U319。')] } : {})]);
    const before = structuredClone(snapshot);
    const result = contextualize(snapshot, '最终送货地址');
    assert.equal(result.history[0].contextTextOmitted, true);
    assert(result.memory.includes('竹路73号')); assert(!result.memory.includes('U319'));
    assert.deepEqual(snapshot, before);
  }
});

function withoutGuidance(value) {
  if (Array.isArray(value)) return value.map(withoutGuidance);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['guidance', 'matchGuidance', 'fragmentGuidance'].includes(key))
    .map(([key, item]) => [key, withoutGuidance(item)]));
  return value;
}

test('complete progressive memory results shorten repeated instructions without changing evidence or audit state', async () => {
  const snapshot = document([entry('known', '小许偏好热茶。')]);
  const plain = memoryFixture(snapshot, '收据应发给小许。', 'legacy');
  const compact = memoryFixture(snapshot, '收据应发给小许。');
  const a = await read(plain.tool, { query: '小许 偏好' }), b = await read(compact.tool, { query: '小许 偏好' });
  assert.deepEqual(withoutGuidance(b), withoutGuidance(a));
  assert(JSON.stringify(b).length < JSON.stringify(a).length * 0.8);
  assert(b.partitions.every(part => !('guidance' in part) && !('matchGuidance' in part)));
  assert.deepEqual(compact.tool.getReadState(), plain.tool.getReadState());
  assert.deepEqual(compact.reports, plain.reports);
  const single = await read(compact.tool, { section: 'conversation' });
  assert(single.guidance.includes('本次所选分区'));
  assert(!single.guidance.includes('两个分区均完整返回'));
  assert.equal(compact.tool.getReadState().allAvailableMemoryReturned, false);
});

test('compact partial and conflicted reads retain scoped cursors, complete source fragments and query coverage semantics', async () => {
  const notice = '此会话有新旧事实冲突待管理员确认；被争议的事实暂不作为确定信息使用。';
  const snapshot = { ...document([]), summary: '普通长期讨论。'.repeat(1500) };
  const f = memoryFixture(snapshot, notice + '\n' + '等待确认的讨论。'.repeat(1600));
  const first = await read(f.tool);
  assert.equal(first.coverage, 'partial'); assert.equal(first.hasConflicts, true);
  assert(partition(first, 'long-term').notices.includes(notice));
  for (const part of first.partitions) {
    assert(part.nextOffset > 0 && part.revision);
    if (part.fragmented) assert(part.fragmentGuidance.includes('完整来源'));
    const next = await read(f.tool, { section: part.section, offset: part.nextOffset, revision: part.revision });
    assert.equal(next.offset, part.nextOffset); assert.equal(next.revision, part.revision);
    assert(next.text.length > 0 && next.text.length <= 4000);
  }
  const absent = await read(f.tool, { section: 'conversation', query: '并未出现的关键词' });
  assert.equal(absent.found, true); assert.equal(absent.queryMatched, false);
  assert.equal(absent.coverage, 'matches'); assert.equal(absent.omitted, true);
  assert(absent.guidance.includes('不代表没有记录'));
  await assert.rejects(read(f.tool, { section: 'conversation', offset: first.partitions[0].nextOffset, revision: 'stale' }), { code: 'MEMORY_CHANGED' });
});

test('compact responses preserve real partition failures and memory clear still invalidates the snapshot', async () => {
  const snapshot = document([entry('known', '收件人是小许。')]);
  const f = memoryFixture(snapshot);
  f.longMemory.readErrors.set(scope.accountId, '长期资料读取失败，请检查存储。');
  const result = await read(f.tool);
  assert.equal(partition(result, 'long-term').error, '长期资料读取失败，请检查存储。');
  assert.equal(partition(result, 'long-term').coverage, 'unavailable');
  assert.equal(result.allAvailableMemoryReturned, false);
  assert(result.guidance.includes('读取失败'));
  assert.equal(f.tool.getReadState().partitions[1].error, partition(result, 'long-term').error);
  snapshot.generation = 'cleared';
  await assert.rejects(read(f.tool), { code: 'MEMORY_CHANGED' });
});
