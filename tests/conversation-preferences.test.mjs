import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitConversationPreference } from "../modules/agent/reply-style.mjs";
import { conversationPreference } from "../modules/agent/conversation-preferences.mjs";

test('direct conversation preferences cover participants, opt-outs and ordinary negation', () => {
  const cases = [
    ['只想跟你聊聊。', 'chat'],
    ['我只是想和你随便聊两句。', 'chat'],
    ['现在只想与你说说话。', 'chat'],
    ['就陪我聊聊天。', 'chat'],
    ['陪我说说话就好。', 'chat'],
    ['我不想听安排。', 'chat'],
    ['不用给我建议。', 'chat'],
    ['别再替我列计划了。', 'chat'],
    ['不要帮我做方案。', 'chat'],
    ['不要告诉我怎么做。', 'chat'],
    ['不是要建议，就聊聊。', 'chat'],
    ['不用买东西，就只聊两句。', 'chat'],
    ['不要只聊。', 'help'],
    ['别再光聊天。', 'help'],
    ['我不想只聊。', 'help'],
    ['不只是想聊，给我具体办法。', 'help'],
    ['我不是不想听建议。', 'help'],
    ['现在帮我修一下这个错误。', 'help'],
    ['请给我一套可执行的安排。', 'help'],
    ['这段程序具体怎么实现？', 'help'],
    ['早上好。', undefined],
    ['今天把书架整理乱了。', undefined],
    ['我不想出门，所以请给我一个室内活动方案。', 'help'],
    ['我不想出门就只想跟你聊聊。', 'chat'],
  ];
  for (const [request, expected] of cases) assert.equal(explicitConversationPreference(request), expected, request);
});

test('the latest direct choice wins across negation and changes of direction', () => {
  const cases = [
    ['我只想和你聊，还是给我一个方案吧。', 'help'],
    ['别给我安排，但是现在帮我选一个。', 'help'],
    ['先随便聊聊。现在具体怎么做？', 'help'],
    ['给我一个计划。不过我改主意了，只想跟你聊聊。', 'chat'],
    ['告诉我怎么做，还是不用给建议，就陪我聊聊。', 'chat'],
    ['我不是不想听建议，只是想先跟你聊聊。', 'chat'],
    ['就聊聊这段代码怎么修。', 'help'],
    ['先说说怎么办，算了，不想听安排。', 'chat'],
  ];
  for (const [request, expected] of cases) assert.equal(explicitConversationPreference(request), expected, request);
});

test('quoted and reported preferences do not replace the current task', () => {
  const quotePairs = [['“', '”'], ['「', '」'], ['『', '』'], ['‘', '’'], ['"', '"'], ["'", "'"], ['`', '`']];
  for (const [open, close] of quotePairs) {
    const quoted = open + '只想跟你聊聊，不想听安排' + close;
    assert.equal(explicitConversationPreference('翻译' + quoted + '。'), 'help', quoted);
    assert.equal(explicitConversationPreference(quoted + '现在给我一个方案。'), 'help', quoted);
  }
  for (const request of [
    '```text\n只想跟你聊聊，不想听安排\n```',
    '~~~text\n只想跟你聊聊，不想听安排\n~~~',
    '> 只想跟你聊聊，不想听安排',
    '如果对方说只想跟你聊聊，该怎么回应？',
    '假设我说不想听安排，这句话是什么意思？',
    '他只想聊聊天，不想听安排。',
    '她说只想聊，不要建议。',
    '例句：只想跟你聊聊，不想听安排。',
  ]) assert.equal(explicitConversationPreference(request), undefined, request);
  assert.equal(explicitConversationPreference('他只想聊聊天，不想听安排。我现在要一个回应方案。'), 'help');
  assert.equal(explicitConversationPreference('如果对方只想聊，先别讨论他。我只想跟你聊聊。'), 'chat');
});

test('later explanation, translation or creative requests end chat-only without promoting refused or quoted tasks', () => {
  for (const request of [
    '不要给我建议，帮我解释一下这段代码。',
    '我不需要计划，请帮我翻译下面这段话。',
    '不要给我方案，给我写一首诗。',
    '只想聊天，现在给我解释贝叶斯公式。',
    '不想听安排，不过我现在需要你解释这张图。',
    '请分析对方说只想和你聊聊的意思。',
  ]) assert.equal(explicitConversationPreference(request), 'help', request);
  for (const request of [
    '我只想跟你聊聊，别帮我解释原理。',
    '不想听安排，也不用给我写一首诗。',
    '只想聊天，他说“给我解释这个公式”。',
    '只想聊。如果有人请你帮我翻译一句话呢？',
  ]) assert.equal(explicitConversationPreference(request), 'chat', request);
});

test('only the same speaker carries a recent explicit choice into a continuation', () => {
  const now = new Date('2026-11-08T05:00:00Z'), speaker = { id: 'member-a' };
  const entry = (text, extra = {}) => ({ direction: 'incoming', senderId: speaker.id,
    time: Number(now) / 1000 - 60, text, ...extra });
  const history = [entry('今天挑晚饭挑了半小时，只想和你聊聊，不要建议。'),
    entry('下次可以先定个菜单。', { direction: 'outgoing' }),
    entry('帮我做一个计划。', { senderId: 'member-b' })];
  assert.deepEqual(conversationPreference('明天要是还这样呢？', { history, speaker, now }), { value: 'chat', source: 'recent' });
  assert.deepEqual(conversationPreference('现在给我一个办法。', { history, speaker, now }), { value: 'help', source: 'current' });
  assert.equal(conversationPreference('明天要是还这样呢？', { history, speaker: { id: 'member-c' }, now }), undefined);
  assert.equal(conversationPreference('大家继续聊。', { history, now }), undefined, 'ambient participation cannot turn a member preference into a group rule');
  for (const text of ['给我写一首诗。', '帮我解释一下贝叶斯公式。', '牛顿第二定律是什么？', '三加五等于几？']) {
    assert.deepEqual(conversationPreference(text, { history, speaker, now }), { value: 'help', source: 'current' }, text);
    assert.deepEqual(conversationPreference('继续。', { history: [...history, entry(text)], speaker, now }), { value: 'help', source: 'recent' }, text);
  }
});

test('expired, incomplete, undated, future or quoted choices cannot create a sticky chat mode', () => {
  const now = new Date('2026-11-08T05:00:00Z'), speaker = { id: 'member-a' };
  const entry = (extra = {}) => ({ direction: 'incoming', senderId: speaker.id,
    time: Number(now) - 1000, text: '不想听安排，只想聊聊。', ...extra });
  for (const history of [
    [entry({ time: Number(now) - 31 * 60 * 1000 })], [entry({ time: 0 })], [entry({ time: undefined })],
    [entry({ time: Number(now) + 1000 })], [entry({ contextOmitted: true })],
    [entry({ direction: 'outgoing' })], [entry({ text: '她说“只想聊天，不要建议”。' })],
    [entry({ text: '```text\n只想聊天，不要建议\n```' })],
    [entry(), entry({ text: '现在帮我做个方案。', contextOmitted: true })],
    [entry(), ...Array.from({ length: 20 }, () => entry({ text: '其他话题', senderId: 'member-b' }))],
  ]) assert.equal(conversationPreference('明天要是还这样呢？', { history, speaker, now }), undefined);
  assert.deepEqual(conversationPreference('只想聊天。', { history: [], now }), { value: 'chat', source: 'current' });
});
