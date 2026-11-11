import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, LongTermMemory, ConversationMemory, buildWechatPrompt } from '../lib/testing.js';
import { projectMemory, resolveTargets } from '../modules/memory/roles/retrieval.mjs';
import { extractionPeople } from '../modules/memory/roles/people.mjs';
import { validateExtraction } from '../modules/memory/roles/extraction.mjs';
import { memoryReviewFlags, removeUnsupportedExclusions, reviewMemoryDraft } from '../modules/memory/roles/reflection.mjs';
import { factEvidence } from '../modules/memory/roles/references.mjs';

const now = Date.parse('2026-11-10T12:00:00Z'), scope = { accountId: 'test-owner', chatType: 'private', peerId: 'alice' };
const alice = { accountId: scope.accountId, id: 'alice', name: '阿宁', aliases: [] };
const source = (text, senderId = 'alice', time = now - 86400000) => ({ id: 's1', senderId, speaker: '阿宁', direction: 'incoming', time: new Date(time).toISOString(), text, images: [] });
const proposal = (text, extra = {}) => ({ subjectId: 'alice', text, sources: ['s1'], evidence: [{ source: 's1', quote: text }], replaces: [], expiresAt: null, ...extra });
const data = (extra = {}) => ({ scope, now, query: '', history: [], speaker: alice, people: [alice], persona: {}, facts: [], ...extra });
const fact = (id, text, extra = {}) => ({ id, text, scope, subjectId: 'alice', state: 'active', createdAt: now - 1000, expiresAt: now + 86400000,
  sources: [{ senderId: 'alice', sender: '阿宁', time: now - 86400000, quote: text }], ...extra });

test('empty role memory does not pretend identity metadata is recalled evidence', () => {
  assert.equal(projectMemory(data({ query: '我最喜欢什么电影' })).memory, '');
});

test('source time survives automatic recall of relative dates', () => {
  const value = projectMemory(data({ query: '我们约的是几号几点', facts: [fact('date', '阿宁说：明天下午三点在滨江咖啡见。')] }));
  assert(value.memory.includes('2026-11-09T20:00:00.000+08:00'));
});

test('timeless preferences omit an irrelevant clock while dated sources keep their local date anchor', () => {
  assert.equal(factEvidence(fact('drink', '阿宁说：我只喝热可可。')).saidAt, undefined);
  assert.equal(factEvidence(fact('event', '阿宁说：后天上午十点去取书。')).saidAt, '2026-11-09T20:00:00.000+08:00');
});

test('food constraints stay out of unrelated work and waking-up small talk', () => {
  const facts = [fact('food', '阿宁说：我不吃香菜。')];
  for (const query of ['早呀，今天终于睡饱了', '帮我写工作汇报']) assert(!projectMemory(data({ query, facts })).memory.includes('香菜'));
  assert(projectMemory(data({ query: '我好饿，晚饭吃什么', facts })).memory.includes('香菜'));
});

test('asking for a drink does not preload an unrelated meal preference', () => {
  const result = projectMemory(data({ query: '我平时喝哪种咖啡', facts: [fact('food', '阿宁说：我不吃香菜。')] }));
  assert(!result.memory.includes('香菜'));
});

test('single-character nicknames resolve only at person mention boundaries', () => {
  const value = data({ scope: { ...scope, chatType: 'group' }, people: [alice, { ...alice, id: 'lin', name: '林' }] });
  assert.deepEqual(resolveTargets(value, '林吃饭有什么要注意的？').targets, ['lin']);
  assert.deepEqual(resolveTargets(value, '森林里吃饭要注意什么？').targets, ['alice']);
});

test('a joint question includes the speaker when their pronoun follows the other person', () => {
  const value = data({ scope: { ...scope, chatType: 'group' }, people: [alice, { ...alice, id: 'bob', name: '阿哲' }] });
  assert.deepEqual(new Set(resolveTargets(value, '阿哲和我各自有什么忌口').targets), new Set(['alice', 'bob']));
});

test('a relative explicitly named in private chat gets a local identity, separate from the reporter', () => {
  const text = '我妹妹小禾对花生过敏，下次家里聚餐要避开花生。', sources = [source(text)], people = extractionPeople([alice], sources, scope),
    relative = people.find(person => person.id !== alice.id);
  assert(relative); assert.equal(relative.name, '小禾'); assert.equal(relative.reference.ownerId, 'alice');
  const definition = { data: { ...data({ people }), sources } };
  assert.throws(() => validateExtraction(JSON.stringify({ facts: [proposal(text)] }), definition));
  const result = validateExtraction(JSON.stringify({ facts: [proposal(text, { subjectId: relative.id })] }), definition);
  assert.equal(result.facts[0].state, 'pending'); assert.equal(result.facts[0].reviewReason, 'reported');
  assert.deepEqual(resolveTargets(data({ people }), '我妹妹聚餐要注意什么？').targets, [relative.id]);
});

test('local relatives with the same name remain separate across speakers and conversations', () => {
  const sources = [source('我妹妹小禾不吃辣。'), source('我妹妹小禾喜欢红茶。', 'bob')],
    people = extractionPeople([alice, { ...alice, id: 'bob', name: '阿哲' }], sources, scope), relatives = people.filter(value => value.reference);
  assert.equal(relatives.length, 2); assert.notEqual(relatives[0].id, relatives[1].id);
  const other = extractionPeople([alice], sources.slice(0, 1), { ...scope, peerId: 'elsewhere' }).find(value => value.reference);
  assert.notEqual(other.id, relatives[0].id);
  assert.deepEqual(resolveTargets(data({ people }), '我妹妹吃什么？').targets, [relatives.find(value => value.reference.ownerId === 'alice').id]);
  assert(resolveTargets(data({ people }), '小禾吃什么？').ambiguousNames.includes('小禾'));
});

test('possessive relationships are not first-person evidence for personal preferences', () => {
  const text = '我的妹妹小禾不吃香菜。', sources = [source(text)], people = extractionPeople([alice], sources, scope), relative = people.find(value => value.reference);
  assert(relative);
  const definition = { data: { ...data({ people }), sources } };
  assert.equal(validateExtraction(JSON.stringify({ facts: [proposal(text, { subjectId: relative.id })] }), definition).facts[0].state, 'pending');
  assert.throws(() => validateExtraction(JSON.stringify({ facts: [proposal(text)] }), definition));
});

test('a model-invented expiry at the meeting start does not discard the source-backed appointment', () => {
  const text = '明天下午三点在滨江咖啡见。', definition = { data: { ...data(), sources: [source(text)] } };
  const result = validateExtraction(JSON.stringify({ facts: [proposal(text, { expiresAt: '2026-11-10T15:00:00+08:00' })] }), definition);
  assert.equal(result.facts[0].expiresAt, null);
  assert.throws(() => validateExtraction(JSON.stringify({ facts: [proposal(text, { expiresAt: '2026-02-30T15:00:00+08:00' })] }), definition));
});

test('full-sentence evidence does not inherit a condition from the next independent sentence', () => {
  const text = '我不吃香菜。喝咖啡时才换燕麦奶，其他饮品不要求。', definition = { data: { ...data(), sources: [source(text)] } };
  const result = validateExtraction(JSON.stringify({ facts: [proposal('我不吃香菜。'), proposal('喝咖啡时才换燕麦奶，其他饮品不要求。')] }), definition);
  assert.equal(result.facts.length, 2);
  assert.throws(() => validateExtraction(JSON.stringify({ facts: [proposal('才换燕麦奶')] }), definition));
});

test('ordinary descriptions of a relative are not guessed to be personal names', () => {
  for (const text of ['我儿子刚满三岁。', '我妹妹最近在苏州读书。', '我的朋友是老师。', '我同事正在开会。'])
    assert(extractionPeople([alice], [source(text)], scope).filter(person => person.reference).every(person => person.reference.name === ''));
});

test('an unnamed mother is still a separate reported person and common relationship wording resolves it', () => {
  const text = '我妈不吃香菜。', sources = [source(text)], people = extractionPeople([alice], sources, scope), relative = people.find(person => person.reference);
  assert(relative); assert.equal(relative.name, '阿宁的妈妈');
  const definition = { data: { ...data({ people }), sources } };
  assert.throws(() => validateExtraction(JSON.stringify({ facts: [proposal(text)] }), definition));
  assert.equal(validateExtraction(JSON.stringify({ facts: [proposal(text, { subjectId: relative.id })] }), definition).facts[0].state, 'pending');
  assert.deepEqual(resolveTargets(data({ people }), '我妈妈不吃什么').targets, [relative.id]);
  assert.deepEqual(resolveTargets(data({ people }), '我不吃什么').targets, ['alice']);
});

test('explicit naming creates one local person and does not retain the naming verb as a name', () => {
  const people = extractionPeople([alice], [source('我妹妹叫小禾，她不吃辣。')], scope).filter(person => person.reference);
  assert.equal(people.length, 1); assert.equal(people[0].name, '小禾');
});

test('a deferred memory tool still explains when personal questions need retrieval', () => {
  const prompt = buildWechatPrompt({ promptStrategy: 'progressive-v1', memoryAvailable: true,
    capabilities: [{ name: 'wechat_capabilities' }], requestText: '我喝咖啡要备注什么？' });
  assert(prompt.includes('wechat_memory')); assert(prompt.includes('加载 memory'));
  assert(!buildWechatPrompt({ promptStrategy: 'progressive-v1', capabilities: [], requestText: '你好' }).includes('加载 memory'));
});

test('reflection catches empty-memory metadata and unsupported promises without rewriting literal quotations', () => {
  const input = { text: '我的忌口是什么？' };
  assert(memoryReviewFlags(input, '只查到你的发言者信息，聊天里也没聊过。').includes('memory-metadata'));
  assert(memoryReviewFlags(input, '你告诉我，我记着。').includes('unrequested-promise'));
  assert.equal(removeUnsupportedExclusions('这次没找到具体忌口。聊天里也没聊过。'), '这次没找到具体忌口。');
  assert.deepEqual(memoryReviewFlags({ text: '原样输出：聊天里也没聊过' }, '聊天里也没聊过'), []);
});

test('reported-memory projection retains original uncertainty without narrating the review workflow', () => {
  const original = fact('report', '阿宁说：我妹妹小禾不吃香菜，还没问清原因。（转述，未由本人确认）',
    { state: 'pending', reviewReason: 'reported' }), result = projectMemory(data({ query: '我有什么忌口', facts: [original] }));
  assert(result.memory.includes('还没问清原因')); assert(result.memory.includes('"sourceType":"reported"'));
  assert(!result.memory.includes('待确认')); assert(!result.memory.includes('未由本人确认'));
  assert.equal(original.state, 'pending'); assert(original.text.endsWith('（转述，未由本人确认）'));
  assert(memoryReviewFlags({ text: '忌口是什么', memory: result.memory }, '不吃香菜。').includes('pending-claim'));
});

test('a failed memory review does not leave an unrequested promise of permanent recall', async () => {
  const result = await reviewMemoryDraft({ run: async () => { throw new Error('offline'); } },
    { text: '我有什么忌口？' }, '这次没找到具体忌口，你跟我说一下，我记下来，下回就不用再问了。');
  assert.equal(result.text, '这次没找到具体忌口，你跟我说一下。');
  const history = await reviewMemoryDraft({ run: async () => ({ text: '这次没找到。会话里也没聊过。' }) },
    { text: '我的忌口是什么？' }, '这次没找到。会话里也没聊过。');
  assert.equal(history.text, '这次没找到。');
});

test('another person reporting a correction cannot become a first-person confirmation in the prompt', () => {
  const value = fact('new', '阿宁说：阿哲现在改喝豆奶。（转述，未由本人确认）',
    { subjectId: 'bob', state: 'pending', reviewReason: 'correction', replaces: ['old'] });
  assert.equal(factEvidence(value).sourceType, 'reported');
  assert.equal(value.state, 'pending');
});

test('failed reflection removes unsupported heard-before claims and casual memory promises', async () => {
  for (const unsupported of ['之前也没听你提过', '我没听你说过', '没人提过你有什么忌口']) {
    const draft = `这次没找到具体忌口，${unsupported}。你可以告诉我，我记一下。`;
    const flags = memoryReviewFlags({ text: '我有什么忌口来着？' }, draft);
    assert(flags.includes('unsupported-exclusion')); assert(flags.includes('unrequested-promise'));
    const result = await reviewMemoryDraft({ run: async () => { throw new Error('offline'); } }, { text: '我有什么忌口来着？' }, draft);
    assert.equal(result.text, '这次没找到具体忌口，你可以告诉我。');
  }
  assert.equal(removeUnsupportedExclusions('你之前没提过吗？'), '你之前没提过吗？');
});

test('review receives the actual draft concerns and preserves a grounded short work reply', async () => {
  let captured;
  const input = { text: '请写一句汇报开头：试运行完成，花费八百元。', memory: '{"text":"工作回复先给结论"}' };
  const result = await reviewMemoryDraft({ run: async request => {
    captured = JSON.parse(request.text);
    return { text: '试运行已完成，花费八百元。' };
  } }, input, '试运行已完成，花费八百元，账目清晰可查。');
  assert(captured.reviewFocus.includes('memory-synthesis'));
  assert.equal(result.text, '试运行已完成，花费八百元。');
});

test('ambiguous-name replies are reviewed when internal person ids replace a useful clarification', () => {
  const input = { text: '小王有什么忌口？', memory: '本句提及对象：小王[wxid_abc]、小王[wxid_def]。' };
  assert(memoryReviewFlags(input, '你指的是 wxid_abc 还是 wxid_def？').includes('memory-metadata'));
  assert(!memoryReviewFlags(input, '你说的是哪位小王？').includes('memory-metadata'));
  assert(!memoryReviewFlags({ text: 'Bob 喝什么？', history: [{ senderId: 'Bob', senderName: 'Bob' }] }, 'Bob 喜欢茶。').includes('memory-metadata'));
});

test('a full quote mentioning another person triggers focused review without rewriting its evidence', () => {
  const people = [alice, { ...alice, id: 'bob', name: '阿哲' }],
    value = fact('self', '阿宁说：我不吃辣，阿哲不吃香菜。', { sources: [{ senderId: 'alice', quote: '我不吃辣，阿哲不吃香菜。', time: now - 1000 }] });
  const result = projectMemory(data({ people, query: '我不吃什么来着？', facts: [value] }));
  assert(result.memory.includes('我不吃辣，阿哲不吃香菜。'));
  assert(memoryReviewFlags({ text: '我不吃什么来着？', memory: result.memory }, '你不吃辣，阿哲不吃香菜。').includes('multi-person-source'));
  const joint = projectMemory(data({ people, query: '阿哲和我有什么忌口？', facts: [value] }));
  assert(!joint.memory.includes('原话同时提到多人'));
});

test('an empty scoped lookup triggers reflection even when the draft uses new wording', async () => {
  const input = { text: '我的忌口是什么？', extraReadResults: ['{"found":false,"coverage":"complete"}'] },
    draft = '这次没有找到你的忌口，早前的聊天和长期记录里都没提到。你可以告诉我，我可以记下来。';
  assert(memoryReviewFlags(input, draft).includes('empty-memory-result'));
  const result = await reviewMemoryDraft({ run: async () => { throw new Error('offline'); } }, input, draft);
  assert.equal(result.text, '这次没有找到你的忌口，你可以告诉我。');
  assert(!memoryReviewFlags({ text: '你好' }, '你好呀。').includes('empty-memory-result'));
});

test('newer pending correction hides the replaced proposal without confirming either', () => {
  const facts = [fact('old', '喝牛奶'), fact('middle', '改喝燕麦奶', { state: 'pending', replaces: ['old'] }),
    fact('latest', '现在改喝豆奶', { state: 'pending', replaces: ['middle', 'old'] })],
    result = projectMemory(data({ query: '现在喝什么奶', facts }));
  assert(result.memory.includes('豆奶')); assert(!result.selectedIds.includes('middle')); assert(!result.selectedIds.includes('old'));
});

function runtime(t) {
  const base = path.resolve('storage/tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'practical-test-')), store = new StateStore(root);
  let clock = now, serial = 0;
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  store.memory = new ConversationMemory(store, { now: () => clock });
  const memory = new LongTermMemory(store, { now: () => clock });
  t.after(() => { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(base));
    assert(path.basename(resolved).startsWith('practical-test-')); fs.rmSync(resolved, { recursive: true, force: true }); });
  const write = async (text, pick) => {
    clock += 1000;
    memory.capture(scope, [{ key: 'entry-' + ++serial, time: clock, direction: 'incoming', text, senderId: 'alice', senderName: '阿宁' }]);
    let input;
    await memory.extract(scope, { run: async request => {
      input = JSON.parse(request.text.split('\n到期时间')[0]);
      return { text: JSON.stringify({ facts: [proposal(text, pick ? pick(input) : {})], unresolved: [] }) };
    } }, new AbortController().signal);
    return input;
  };
  return { store, memory, root, write, facts: () => memory.view(scope.accountId).sections.flatMap(section => section.facts) };
}

test('successive private corrections survive reopening and can be confirmed as one current version', async t => {
  const f = runtime(t);
  await f.write('我只喝牛奶。'); const old = f.facts()[0];
  await f.write('更正，我现在改喝燕麦奶。', () => ({ replaces: [old.id] })); const middle = f.facts().find(value => value.state === 'pending');
  await f.write('再更正，现在改喝豆奶。', input => {
    assert(input.existing.some(value => value.id === middle.id), 'The extractor must see the previous unconfirmed correction');
    return { replaces: [middle.id] };
  });
  const latest = f.facts().find(value => value.text.includes('豆奶'));
  assert.deepEqual(new Set(latest.replaces), new Set([middle.id, old.id]));
  assert.equal(latest.state, 'pending');
  assert.throws(() => f.memory.resolveFact(scope.accountId, { factId: middle.id, decision: 'accept', revision: f.memory.view(scope.accountId).revision }), { code: 'LONG_MEMORY_CONFLICT' });
  f.memory.resolveFact(scope.accountId, { factId: latest.id, decision: 'accept', revision: f.memory.view(scope.accountId).revision });
  assert.deepEqual(f.facts().filter(value => value.state === 'active').map(value => value.id), [latest.id]);
  const reopened = new LongTermMemory(new StateStore(f.root), { now: () => now + 10000 });
  assert(reopened.roleContext(scope, { text: '我现在喝哪种奶' }).memory.includes('豆奶'));
});

test('named relative metadata and self/relative separation survive a private-memory restart', async t => {
  const f = runtime(t);
  await f.write('我妹妹小禾不吃香菜。', input => {
    const relative = input.people.find(person => person.reference); assert(relative);
    return { subjectId: relative.id };
  });
  const reopened = new LongTermMemory(new StateStore(f.root), { now: () => now + 10000 });
  assert(reopened.roleContext(scope, { text: '我妹妹不吃什么' }).memory.includes('香菜'));
  assert(!reopened.roleContext(scope, { text: '我不吃什么' }).memory.includes('香菜'));
});

test('the same WeChat speaker keeps different private and group facts in their original conversations', async t => {
  const f = runtime(t), group = { ...scope, chatType: 'group', peerId: 'group@chatroom' };
  f.store.configure(scope.accountId, { enabled: true, privatePeers: ['alice'], groups: [group.peerId], prompt: '' });
  await f.write('我不吃辣。');
  const text = '我不吃香菜。';
  f.memory.capture(group, [{ key: 'group-source', time: now, direction: 'incoming', text, senderId: 'alice', senderName: '阿宁' }]);
  await f.memory.extract(group, { run: async () => ({ text: JSON.stringify({ facts: [proposal(text)] }) }) }, new AbortController().signal);
  const privateContext = f.memory.roleContext(scope, { text: '我有什么忌口' }).memory,
    groupContext = f.memory.roleContext({ ...group, senderId: 'alice', senderName: '阿宁' }, { text: '我有什么忌口' }).memory;
  assert(privateContext.includes('辣')); assert(!privateContext.includes('香菜'));
  assert(groupContext.includes('香菜')); assert(!groupContext.includes('不吃辣'));
});
