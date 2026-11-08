import test from 'node:test';
import assert from 'node:assert/strict';
import audit from '../scripts/memory-behavior-live-cases.cjs';

test('future unknown-birthday checks recognize the observed reply without classifying its style', () => {
  const observed = '我翻了一圈，记得的内容里没有姐姐生日这一条，这回真答不上来。是几号呀？跟我说一声，我记着。';
  assert.doesNotThrow(() => audit.assertUnknownBirthdayReply(observed));
  assert.doesNotThrow(() => audit.assertUnknownBirthdayReply('没有姐姐生日这一条。你再告诉我一次吧。'));
  assert.doesNotThrow(() => audit.assertUnknownBirthdayReply('这回真答不上来。是几号呀？'));
});

test('existing unknown wording still passes without a supplied birthday', () => {
  for (const reply of ['不记得了，你再告诉我一次好吗？', '没找到姐姐生日的记录。', '不知道具体是哪一天。', '这部分记忆是空的。'])
    assert.doesNotThrow(() => audit.assertUnknownBirthdayReply(reply), reply);
});

test('a concrete birthday remains a failure even after an uncertainty disclaimer', () => {
  for (const reply of ['姐姐生日是11月7日。', '姐姐生日是十一月七号。', '不确定，好像是11月7日。', '答不上来，但我猜是十一月七号。', '我没有记错，就是 11 月 7 日。', '没找到记录，我猜十二月二十六号。'])
    assert.throws(() => audit.assertUnknownBirthdayReply(reply), { name: 'AssertionError' }, reply);
});
