import test from 'node:test';
import assert from 'node:assert/strict';
import { workRoutingContext, guardWorkFollowup, workChatFallbackPrompt } from '../modules/work/routing-context.mjs';

const now = 1794288000000, scope = { accountId: 'bot', chatType: 'private', peerId: 'alice', senderId: 'alice' };
const A = 'aaaaaaaaaaaa', B = 'bbbbbbbbbbbb';
const task = (id, request, state = 'succeeded') => ({ ...scope, id, request, state, createdAt: now - 20000,
  delivery: { state: 'sent' }, result: { artifacts: [] } });
const report = task(A, '整理销售报告，导出报表'), poster = task(B, '制作活动海报');
const entry = (patch = {}) => ({ ...scope, key: 'prior', createdAt: now - 2000, sentAt: now - 1000,
  mode: 'scheduled', state: 'sent', workJobId: A, reply: '文字稿已完成，确认后再导出。', ...patch });
function fixture(message, { jobs = [report], records = [entry()], current = A, inserted = true } = {}) {
  const record = { ...scope, key: 'current', createdAt: now, question: message, mode: 'work-routing' };
  const owned = id => { const found = jobs.find(job => job.id === id && Object.keys(scope).every(key => job[key] === scope[key])); assert(found, 'foreign task read'); return found; };
  const channel = { now: () => now, store: { data: { records: inserted ? [...records, record] : records } },
    work: { list: () => ({ jobs: jobs.slice(0, 200) }), store: { list: () => jobs }, owned, dialogueTask: () => current ? owned(current) : null } };
  const item = { text: message, record };
  item.workRoutingContext = workRoutingContext(channel, item);
  return { item, context: item.workRoutingContext };
}
const continuation = id => ({ action: 'continue', taskId: id, review: { intent: 'continue', evidence: '可以', target: 'unique' } });

test('a short reply can continue its immediately preceding acknowledged work result', () => {
  const { context } = fixture('可以');
  assert.equal(context.focus.kind, 'work-result'); assert.equal(context.focus.taskId, A); assert(context.focus.fresh);
  assert.equal(guardWorkFollowup(continuation(A), '可以', context).action, 'continue');
});
for (const message of ['可以。', '好的', '嗯嗯', 'ok', '好，按你说的来']) test(`stale assent does not restart work: ${message}`, () => {
  const { context } = fixture(message, { records: [entry({ createdAt: now - 7200000, sentAt: now - 7100000 })] });
  assert.equal(guardWorkFollowup(continuation(A), message, context).action, 'chat');
  assert.equal(context.focus.fresh, false);
});
test('an explicit older-task request and a direct continuation retain usable work context', () => {
  const { context } = fixture('继续', { records: [entry({ createdAt: now - 7200000, sentAt: now - 7100000 })] });
  assert.equal(guardWorkFollowup(continuation(A), '继续', context).action, 'continue');
  assert.equal(guardWorkFollowup(continuation(A), '把销售报告导出为 PDF', context).action, 'continue');
});
test('ordinary intervening conversation blocks old assent without exposing its body', () => {
  const ordinary = entry({ key: 'chat', workJobId: undefined, mode: 'default', createdAt: now - 500, sentAt: now - 400,
    question: 'PRIVATE_ORDINARY_BODY', reply: 'PRIVATE_ORDINARY_REPLY', workRoute: { action: 'chat', review: { intent: 'chat' } } });
  const { context } = fixture('可以', { records: [entry(), ordinary] });
  assert.equal(context.focus.kind, 'chat');
  assert.equal(guardWorkFollowup(continuation(A), '可以', context).action, 'chat');
  assert(!JSON.stringify(context).includes('PRIVATE_ORDINARY'));
});
test('a newer unanswered message is also a conversational boundary', () => {
  const { context } = fixture('继续', { records: [entry(), entry({ key: 'pending', mode: 'default', workJobId: undefined,
    createdAt: now - 100, sentAt: undefined, state: 'generating', question: 'PENDING_PRIVATE', reply: '' })] });
  assert.equal(context.focus.kind, 'pending-reply');
  assert.equal(guardWorkFollowup(continuation(A), '继续', context).action, 'chat');
  assert(!JSON.stringify(context).includes('PENDING_PRIVATE'));
});
test('acceptance acknowledgement is not a new task, while direct continue remains possible', () => {
  const { context } = fixture('好的', { records: [entry({ mode: 'work', workJobId: undefined,
    question: '写报告', reply: '好，我来处理。', createdWorkJobIds: [A] })] });
  assert.equal(context.focus.kind, 'work-turn');
  assert.equal(guardWorkFollowup({ action: 'new' }, '好的', context).action, 'chat');
  assert.equal(guardWorkFollowup(continuation(A), '继续', context).action, 'continue');
});
test('a short followup cannot silently select a different task from the latest result', () => {
  const { context } = fixture('继续', { jobs: [report, poster], current: B });
  const decision = guardWorkFollowup(continuation(B), '继续', context);
  assert.equal(decision.action, 'chat'); assert.equal(decision.guard, 'FOLLOWUP_TARGET_MISMATCH');
});

test('short assent cannot start a task in a different current session through a new decision', () => {
  const { context } = fixture('可以', { jobs: [report, poster], current: B });
  const decision = guardWorkFollowup({ action: 'new', review: { intent: 'execute', evidence: '可以', target: 'none' } }, '可以', context);
  assert.equal(decision.action, 'chat'); assert.equal(decision.guard, 'FOLLOWUP_NEW_TASK');
});

test('short assent cannot cancel a task different from its actual work focus', () => {
  const { context } = fixture('好的', { jobs: [report, poster], current: B });
  const decision = guardWorkFollowup({ action: 'cancel', taskId: B }, '好的', context);
  assert.equal(decision.action, 'chat'); assert.equal(decision.guard, 'FOLLOWUP_TARGET_MISMATCH');
});
test('future delivery, progress and other senders never establish an assent target', () => {
  for (const row of [entry({ sentAt: now + 1 }), entry({ workProgress: true }), entry({ senderId: 'bob' })]) {
    const { context } = fixture('可以', { records: [row] });
    assert.equal(guardWorkFollowup(continuation(A), '可以', context).action, 'chat');
    assert.equal(context.workResults.length, 0);
  }
});
test('an absent current record excludes equal-time records with unknown ordering', () => {
  const { context } = fixture('可以', { inserted: false, records: [entry({ createdAt: now, sentAt: now })] });
  assert.equal(context.workResults.length, 0); assert.equal(context.focus.kind, 'none');
});
test('related older tasks and exact task identifiers are retrieved beyond the recent catalog window', () => {
  const unrelated = Array.from({ length: 24 }, (_, index) => task(index.toString(16).padStart(12, '0'), '生成会议图案' + index));
  const old = task(A, '整理南极考察数据，校正企鹅体重记录');
  const jobs = [...unrelated, old];
  for (const message of ['把企鹅体重记录的单位改为千克', '继续任务 ' + A]) {
    const { context } = fixture(message, { jobs, records: [], current: unrelated[0].id });
    assert(context.tasks.some(job => job.id === A)); assert(context.tasks.some(job => job.id === unrelated[0].id));
    assert(context.tasks.length <= 8); assert.equal(context.catalog.total, 25); assert.equal(context.catalog.omitted, 17);
  }
});
test('registered file names support retrieval without supplying file bodies', () => {
  const jobs = Array.from({ length: 15 }, (_, index) => task(index.toString(16).padStart(12, '0'), '生成图片' + index));
  jobs.push({ ...report, result: { artifacts: [{ name: 'penguin.csv', path: 'PRIVATE_PATH', content: 'PRIVATE_FILE_BODY' }] } });
  const { context } = fixture('把 penguin.csv 增加体重列', { jobs, records: [], current: jobs[0].id });
  assert(context.tasks.some(job => job.id === A)); assert(!JSON.stringify(context).includes('PRIVATE_'));
});

test('retrieval searches past the UI list cap without expanding the model context', () => {
  const jobs = Array.from({ length: 205 }, (_, index) => task(index.toString(16).padStart(12, '0'), '生成会议图案' + index));
  jobs.push({ ...report, request: '整理企鹅体重记录', result: { artifacts: [{ name: 'penguin.csv' }] } });
  const { context } = fixture('在 penguin.csv 里增加观测地点', { jobs, records: [], current: jobs[0].id });
  assert(context.tasks.some(job => job.id === A)); assert.equal(context.tasks.length, 8);
  assert.deepEqual(context.catalog, { total: 206, shown: 8, omitted: 198 });
});
test('clarification hints contain bounded owned titles but ordinary chat receives no task titles', () => {
  const { item } = fixture('改一下那个', { jobs: [report, poster] });
  item.workRoute = { action: 'chat', review: { intent: 'unclear', target: 'ambiguous' } };
  const prompt = workChatFallbackPrompt(item);
  assert(prompt.includes(report.request) && prompt.includes(poster.request));
  assert(!prompt.includes(A)); assert(!prompt.includes(B));
  item.workRoute = { action: 'chat', review: { intent: 'chat', target: 'none' } };
  assert(!workChatFallbackPrompt(item).includes(report.request));
});
