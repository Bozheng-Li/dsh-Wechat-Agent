import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationImageTool } from '../modules/memory/images/request-tool.mjs';
import { conversationMemoryTool } from '../modules/memory/query/tool.mjs';

const now = 1794276000000, scope = { accountId: 'synthetic', chatType: 'group', peerId: 'room', requestedAt: now };
function imageFixture(description = '风景。'.repeat(500)) {
  const snapshot = { generation: 'test', createdAt: now, entries: Array.from({ length: 12 }, (_, i) => ({ key: `image-${i}`, messageId: `message-${i}`,
    time: now, rememberedAt: now, senderId: 'a', senderName: '😀'.repeat(100), attachments: [{ type: 'image', resourceId: `resource-${i}`, description, quality: 'original' }] })) };
  const state = { document: structuredClone(snapshot), vision: true, calls: 0, deleted: {} };
  const memory = { load: () => state.document, now: () => now, expiry: () => now + 10000,
    store: { modelConfig: () => ({ vision: state.vision }) }, images: { load: () => ({ deleted: state.deleted }), imageId: (_archive, entry) => entry.key },
    enrich: async () => { state.calls++; return { description: '实际核对到Q782。', quality: 'original' }; } };
  const checks = [];
  const make = strategy => conversationImageTool(memory, { describeImage() {} }, { media() {} }, scope, () => {}, { snapshot, currentKey: 'image-11', promptStrategy: strategy, onNoteRead: check => checks.push(check) });
  return { snapshot, state, memory, checks, tool: make('progressive-v1'), legacy: make('legacy') };
}
const catalog = tool => JSON.parse(tool.description.slice(tool.description.indexOf('[{')));
const read = async (tool, args = {}) => JSON.parse(await tool.execute(args));

test('image catalog stays bounded, puts the current picture first and contains complete Unicode summaries only', () => {
  const f = imageFixture('😀'.repeat(1000)), rows = catalog(f.tool);
  assert.equal(rows[0].current, true); assert(rows.length > 0 && rows.length <= 12);
  assert(JSON.stringify(rows).length <= 6000);
  assert(f.tool.description.length < f.legacy.description.length / 2);
  for (const row of rows) { assert(Array.from(row.summary).length <= 80); assert(row.summary.isWellFormed()); assert(row.sender.isWellFormed()); }
  assert(!f.tool.description.includes('😀'.repeat(81))); assert(!rows.some(row => 'description' in row));
});

test('saved image notes expand without vision and can be reconstructed exactly with versioned pages', async () => {
  const original = '笔记'.repeat(1999) + '😀' + '后文'.repeat(2200), f = imageFixture(original);
  f.state.vision = false;
  const imageId = catalog(f.tool)[0].imageId;
  let page = await read(f.tool, { imageId }), output = page.observation;
  assert.equal(page.source, 'saved-image-note'); assert.equal(page.ok, true); assert(page.nextOffset);
  while (page.nextOffset !== null) {
    assert(page.observation.length <= 4000 && page.observation.isWellFormed());
    page = await read(f.tool, { imageId, offset: page.nextOffset, revision: page.revision });
    assert.equal(page.ok, true); output += page.observation;
  }
  assert.equal(output, original); assert.equal(f.state.calls, 0);
});

test('note reads retain generation, deletion and revision boundaries and reject arbitrary offsets', async () => {
  const f = imageFixture('😀'.repeat(5000)), imageId = catalog(f.tool)[0].imageId;
  const first = await read(f.tool, { imageId });
  assert.equal((await read(f.tool, { imageId, offset: 1, revision: first.revision })).ok, false);
  assert.equal((await read(f.tool, { imageId, offset: first.nextOffset })).code, 'IMAGE_NOTE_CHANGED');
  f.state.document.entries.at(-1).attachments[0].description += '更正';
  assert.equal((await read(f.tool, { imageId, offset: first.nextOffset, revision: first.revision })).code, 'IMAGE_NOTE_CHANGED');
  f.state.deleted['image-11'] = true;
  assert.equal((await read(f.tool, { imageId })).code, 'IMAGE_MEMORY_UNAVAILABLE');
  f.state.deleted = {}; f.state.document.generation = 'cleared';
  assert.equal((await read(f.tool, { imageId })).code, 'IMAGE_CONTEXT_CHANGED');
  assert.equal(f.state.calls, 0);
});

test('a note linked to an unavailable original remains readable, but late deletion or edits invalidate delivery', async () => {
  const f = imageFixture('有效笔记：预约码Q781。'), imageId = catalog(f.tool)[0].imageId;
  f.state.document.entries.at(-1).attachments[0].imageMemoryId = 'saved-image';
  f.memory.images.content = () => { throw Error('Original pixels are unavailable'); };
  const result = await read(f.tool, { imageId });
  assert.equal(result.ok, true); assert(result.observation.includes('Q781')); assert.equal(f.checks.length, 1);
  assert.doesNotThrow(f.checks[0]);
  f.state.document.entries.at(-1).attachments[0].description = '更正：Q782';
  assert.throws(f.checks[0], { code: 'IMAGE_NOTE_CHANGED' });
  f.state.deleted['image-11'] = true;
  assert.throws(f.checks[0], { code: 'IMAGE_MEMORY_UNAVAILABLE' });
});

test('only explicit inspection or a missing note with a question invokes visual work; legacy remains compatible', async () => {
  const f = imageFixture(), imageId = catalog(f.tool)[0].imageId;
  const page = await read(f.tool, { imageId, action: 'inspect', question: '核对预约码' });
  assert.equal(page.source, 'visual-read'); assert.equal(f.state.calls, 1);
  await read(f.tool, { imageId, action: 'inspect', question: '核对预约码' }); assert.equal(f.state.calls, 1);
  assert.equal((await read(f.legacy, { imageId })).code, 'INVALID_IMAGE_REQUEST');
  await read(f.legacy, { imageId, question: '核对预约码' }); assert.equal(f.state.calls, 2);
  const blank = imageFixture(''), blankId = catalog(blank.tool)[0].imageId;
  assert.equal((await read(blank.tool, { imageId: blankId })).found, false); assert.equal(blank.state.calls, 0);
  await read(blank.tool, { imageId: blankId, question: '画面是什么' }); assert.equal(blank.state.calls, 1);
});

test('memory first page shares a 4000-character budget across partitions and retains cursors and conflict notices', async () => {
  const notice = '此会话有新旧事实冲突待管理员确认；被争议的事实暂不作为确定信息使用。';
  const snapshot = { generation: 'g', summary: '较长的旧记忆。'.repeat(1600), entries: [] };
  const tool = conversationMemoryTool({ load: () => snapshot }, { prompt: () => notice + '\n' + '长期事实。'.repeat(1400), readErrors: new Map() }, scope, () => {}, { snapshot, promptStrategy: 'progressive-v1' });
  const first = await read(tool);
  assert(first.partitions.reduce((sum, part) => sum + part.text.length, 0) <= 4000);
  assert.equal(first.allAvailableMemoryReturned, false); assert.equal(first.hasConflicts, true);
  assert(first.partitions.find(part => part.section === 'long-term').notices.includes(notice));
  for (const part of first.partitions) {
    assert(part.nextOffset > 0 && part.revision);
    const next = await read(tool, { section: part.section, offset: part.nextOffset, revision: part.revision });
    assert(next.text.length <= 4000); assert.equal(next.offset, part.nextOffset);
  }
  snapshot.generation = 'cleared'; await assert.rejects(read(tool), { code: 'MEMORY_CHANGED' });
});
