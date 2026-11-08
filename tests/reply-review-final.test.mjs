import test from 'node:test';
import assert from 'node:assert/strict';
import { replyMemoryContext } from '../src/features/conversation/reply-context.mjs';
import { reminderReaction, reminderReceipt } from '../src/features/conversation/task-confirmation.mjs';

test('relevant recall retains the latest explicit correction when older repeated topics fill the budget', () => {
  const entry = (key, text) => ({ key, text, direction: 'incoming', senderId: 'alice', senderName: '阿禾', time: 1762500000000 });
  const entries = [
    ...Array.from({ length: 100 }, (_, index) => entry('old-' + index, '采购预算暂定100元，后续报价都按这个数准备。')),
    entry('correction', '采购预算更正：原100元已经作废，目前采购预算是980元。'),
    ...Array.from({ length: 20 }, (_, index) => entry('recent-' + index, '最近正在聊天窗外的风景。')),
  ];
  const result = replyMemoryContext({ snapshot: { entries, summary: '' }, text: '采购预算多少？' });
  assert(result.referenceChars <= 6000);
  assert(result.memory?.includes('980元') || result.history.some(value => value.text.includes('980元')),
    'The supplied context contains repeated outdated 100-yuan budgets but omits the latest explicit 980-yuan correction.');
});

test('a reminder reaction cannot add an unsupported person, activity and later deadline', () => {
  const reaction = reminderReaction(JSON.stringify({ reaction: '下周叫小王去跑步' }));
  const text = reminderReceipt({ nextRunAt: 1762500600000, content: '到点啦，别忘了喝水。' }, '你', reaction);
  assert(!/下周|小王|跑步/u.test(text), 'An extra unsupported commitment precedes the authoritative saved-task receipt.');
  assert(!reminderReceipt({ nextRunAt: 1762500600000, content: '喝水' }, '你', '下周叫小王去跑步').includes('小王'));
  for (const candidate of ['next week call Alice', '喝完再叫别人', '过会儿去见阿禾', '好，顺便帮你改了', '好\n下周再说'])
    assert.equal(reminderReaction(JSON.stringify({ reaction: candidate })), '', candidate);
  assert.equal(reminderReaction(JSON.stringify({ reaction: '得嘞！' })), '得嘞');
  assert.equal(reminderReaction(JSON.stringify({ reaction: '知晓了' })), '知晓了');
});
