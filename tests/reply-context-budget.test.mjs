import test from 'node:test';
import assert from 'node:assert/strict';
import { recentReplyHistory, replyMemoryContext, relevantMemoryReference } from '../lib/testing.js';

const image = (resourceId, description) => ({ type: 'image', resourceId, quality: 'original', description });
const entry = (key, text, attachments = []) => ({ key, text, direction: 'incoming', senderId: 'alice', senderName: '阿禾', attachments });
const contentChars = entries => entries.reduce((sum, entry) => sum + entry.text.length + (entry.attachments || []).reduce((chars, image) => chars + (image.description || image.error || '').length, 0), 0);

test('recent attachment notes fit the same context budget as text without modifying their saved sources', () => {
  const entries = Array.from({ length: 3 }, (_, index) => entry('images-' + index, '',
    Array.from({ length: 6 }, (_, item) => image(index + '-' + item, '图'.repeat(1000)))));
  const before = structuredClone(entries), recent = recentReplyHistory(entries, { maxChars: 10000 });
  assert(contentChars(recent) <= 10000, 'attachment descriptions exceeded the recent-context budget');
  assert(recent.some(value => value.contextOmitted));
  assert.deepEqual(entries, before);
  assert.equal(recent.at(-1).key, 'images-2', 'latest images keep priority over older messages');
});

test('a small remaining budget cannot admit a full extra image description or an oversized error', () => {
  const entries = [entry('old', '', [{ type: 'image', resourceId: 'failed', error: '失败原因。'.repeat(1500) }]),
    entry('new', '新的具体问题。', [image('new-image', '有效图像内容。'.repeat(300))])];
  for (const maxChars of [199, 200, 500, 1200, 1800]) {
    const recent = recentReplyHistory(entries, { maxChars });
    assert(contentChars(recent) <= maxChars, String(maxChars));
    assert(recent.every(value => value.attachments.length <= 6));
  }
});

test('automatic mode recovers a relevant detail truncated out of recent image notes', () => {
  const saved = entry('long-picture', '[图片]', [image('long-picture', '普通背景。'.repeat(250) + '青藤书店的预约码是Q778。')]);
  const result = replyMemoryContext({ snapshot: { entries: [saved], summary: '' }, text: '青藤书店的预约码是什么？' });
  assert(!result.history[0].attachments[0].description.includes('Q778'));
  assert.equal(result.history[0].contextOmitted, true);
  assert.equal(result.history[0].attachments[0].descriptionTruncated, true);
  assert(result.memory?.includes('Q778'), 'text equality incorrectly treated truncated attachments as complete recent context');
  assert(saved.attachments[0].description.endsWith('Q778。'));
});

test('automatic mode recalls a relevant seventh image omitted from the recent six-image display', () => {
  const saved = entry('many-images', '[图片]', [...Array.from({ length: 6 }, (_, index) => image('simple-' + index, '普通山水图。')),
    image('seventh', '青藤书店的预约码是Q779。')]);
  const result = replyMemoryContext({ snapshot: { entries: [saved], summary: '' }, text: '青藤书店预约码是什么？' });
  assert.equal(result.history[0].attachments.length, 6); assert.equal(result.history[0].contextOmitted, true);
  assert(result.memory?.includes('Q779'));
});

test('complete short image notes are not duplicated into the automatic reference', () => {
  const saved = entry('complete', '[图片]', [image('short', '青藤书店预约码Q780。')]);
  const result = replyMemoryContext({ snapshot: { entries: [saved], summary: '' }, text: '青藤书店预约码是什么？' });
  assert.deepEqual(result.history, [saved]); assert.equal(result.memory, undefined);
});

test('on-demand labels truncated excerpts while leaving omitted detail for the scoped read tool', () => {
  const saved = entry('long-picture', '[图片]', [image('long-picture', '普通背景。'.repeat(250) + '预约码Q781。')]);
  const result = replyMemoryContext({ snapshot: { entries: [saved], summary: '' }, text: '预约码是什么？', onDemand: true });
  assert.equal(result.memory, undefined); assert.equal(result.referenceChars, 0);
  assert(result.history[0].contextOmitted); assert(!result.history[0].attachments[0].description.includes('Q781'));
  assert(saved.attachments[0].description.includes('Q781'));
});

test('automatic recall deduplicates repeated old values and presents the newer correction last', () => {
  const entries = [
    ...Array.from({ length: 100 }, (_, index) => ({ ...entry('old-' + index, '采购预算暂定100元，后续报价都按这个数准备。'), time: 1000 + index })),
    { ...entry('correction', '采购预算更正：原100元已经作废，目前采购预算是980元。'), time: 2000 },
    ...Array.from({ length: 20 }, (_, index) => entry('recent-' + index, '窗外天色不错。')),
  ];
  const before = structuredClone(entries);
  const result = replyMemoryContext({ snapshot: { entries, summary: '' }, text: '采购预算多少？' });
  assert(result.memory.includes('980元'));
  assert.equal(result.memory.match(/采购预算暂定100元/gu)?.length, 1);
  assert(result.memory.indexOf('采购预算暂定100元') < result.memory.indexOf('目前采购预算是980元'));
  assert(result.memory.includes('"time":1099'), 'deduplication retained an earlier source instead of the latest one');
  assert.deepEqual(entries, before, 'reference selection must not rewrite original memory');
});

test('recall deduplication keeps identical statements from different speakers separate', () => {
  const first = JSON.stringify({ time: 1000, senderId: 'alice', speaker: '阿禾', direction: 'incoming', text: '我对花生过敏。' });
  const second = JSON.stringify({ time: 2000, senderId: 'bob', speaker: '阿青', direction: 'incoming', text: '我对花生过敏。' });
  const result = relevantMemoryReference(first + '\n' + second, '花生过敏');
  assert(result.text.includes('"senderId":"alice"'));
  assert(result.text.includes('"senderId":"bob"'));
  assert.equal(result.text.match(/我对花生过敏/gu)?.length, 2);
});

test('older correction wording cannot displace a more recent equally relevant statement', () => {
  const entries = [
    ...Array.from({ length: 100 }, (_, index) => entry('old-' + index, '采购预算更正为' + (100 + index) + '元，后续报价按这个数准备。')),
    entry('current', '现在采购预算是980元。'),
    ...Array.from({ length: 20 }, (_, index) => entry('recent-' + index, '最近在聊窗外的风景。')),
  ];
  const result = replyMemoryContext({ snapshot: { entries, summary: '' }, text: '采购预算多少？' });
  assert(result.referenceChars <= 6000);
  assert(result.memory.includes('现在采购预算是980元'));
  assert(result.memory.endsWith('"现在采购预算是980元。"}'));
});

test('a late matching excerpt retains the speaker and time of its original source', () => {
  const source = JSON.stringify({ time: 1794040000000, senderId: 'alice', speaker: '阿禾', direction: 'incoming', text: '普通聊天内容。'.repeat(600) + '采购预算更正为980元。' });
  const result = relevantMemoryReference(source, '采购预算', { maxChars: 2200 });
  const excerpt = JSON.parse(result.text);
  assert.equal(excerpt.time, 1794040000000);
  assert.equal(excerpt.senderId, 'alice');
  assert.equal(excerpt.speaker, '阿禾');
  assert(excerpt.excerpt.includes('采购预算更正为980元'));
  assert(result.text.length <= 2200);
});
