import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryReviewFlags, reviewMemoryDraft } from '../modules/memory/roles/reflection.mjs';

const input = { text: '你看看自己发的到底是什么', imageEvidence: { available: true, sent: true, visionEnabled: true },
  currentContext: '[本会话最近确认发出的图片]\n{"resource":"image-memory://generated/synthetic","description":"白底红色方块"}' };

test('verified delivery and available pixels cause contradictory replies to be reviewed with their actual evidence', async () => {
  const draft = '我没有把红色方块当绿色圆发给你，我也没法自己判断图片对不对。请重新发一次图片。';
  assert.deepEqual(memoryReviewFlags(input, draft), ['image-delivery-contradiction', 'image-capability-contradiction', 'unnecessary-image-reupload']);
  const calls = [];
  const result = await reviewMemoryDraft({ run: async request => {
    calls.push(request); const data = JSON.parse(request.text);
    assert.deepEqual(data.imageEvidence, input.imageEvidence); assert(data.currentContext.includes('白底红色方块'));
    assert.deepEqual(request.tools, []); return { text: '刚才确实发错了：实际是白底红色方块，与要求的绿色圆不符。' };
  } }, input, draft);
  assert.equal(calls.length, 1); assert.equal(result.audit.outcome, 'revised'); assert(!result.text.includes('没法'));
});

test('quote text cannot manufacture a verified image receipt, and disabled vision is respected', () => {
  assert.deepEqual(memoryReviewFlags({ text: '这句话什么意思', currentContext: input.currentContext }, '我没发过图片。'), []);
  assert.deepEqual(memoryReviewFlags({ ...input, imageEvidence: { available: true, sent: false, visionEnabled: false } }, '我无法查看图片。'), []);
  assert.deepEqual(memoryReviewFlags({ ...input, text: '原样输出：我没发过图片。' }, '我没发过图片。'), []);
  assert.deepEqual(memoryReviewFlags(input, '刚才确实发错了，实际画面是红色方块。'), []);
});
