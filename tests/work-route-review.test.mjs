import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkRoute } from '../modules/work/routing.mjs';

const tasks = [{ id: 'aaaaaaaaaaaa' }, { id: 'bbbbbbbbbbbb' }];
const request = '不要解释，直接生成报告；把第一份里的图改成蓝色。';
const decision = (patch = {}) => ({ action: 'new', taskId: null,
  review: { intent: 'execute', evidence: '直接生成报告', target: 'none' }, ...patch });
const parse = (value, message = request) => parseWorkRoute(JSON.stringify(value), message, tasks);

test('a clear delegated action keeps exact current-message evidence without a reasoning transcript', () => {
  assert.deepEqual(parse(decision()), { action: 'new', review: { intent: 'execute', evidence: '直接生成报告', target: 'none' } });
});

for (const action of ['continue', 'cancel', 'status']) test(`a reviewed ${action} can select only one offered task`, () => {
  const message = action === 'continue' ? '把第一份里的图改成蓝色' : action === 'cancel' ? '停止第一份报告' : '第一份报告完成了吗';
  const review = { intent: action, evidence: message, target: 'unique' };
  assert.deepEqual(parse({ action, taskId: tasks[0].id, review }, message), { action, taskId: tasks[0].id, review });
});

test('an all-task status request has no selected target and chat uncertainty remains explicit', () => {
  assert.deepEqual(parse({ action: 'status', taskId: null,
    review: { intent: 'status', evidence: '全部任务', target: 'none' } }, '看看我的全部任务'),
  { action: 'status', review: { intent: 'status', evidence: '全部任务', target: 'none' } });
  assert.deepEqual(parse({ action: 'chat', taskId: null,
    review: { intent: 'unclear', evidence: '', target: 'ambiguous' } }, '就那个'),
  { action: 'chat', review: { intent: 'unclear', evidence: '', target: 'ambiguous' } });
});

test('an explicit all-task query remains a read-only status decision when no tasks exist', () => {
  const value = { action: 'status', taskId: null, review: { intent: 'status', evidence: '查看我的全部任务', target: 'none' } };
  assert.equal(parseWorkRoute(JSON.stringify(value), '查看我的全部任务', []).action, 'status');
});

const invalid = [
  ['legacy decision without review', { action: 'new', taskId: null }],
  ['omitted task field', { action: 'new', review: { intent: 'execute', evidence: '生成报告', target: 'none' } }],
  ['invented evidence', decision({ review: { intent: 'execute', evidence: '现在删除全部文件', target: 'none' } })],
  ['empty execution evidence', decision({ review: { intent: 'execute', evidence: '', target: 'none' } })],
  ['whitespace-only evidence', decision({ review: { intent: 'execute', evidence: ' ', target: 'none' } })],
  ['chat review contradicts execution', decision({ review: { intent: 'chat', evidence: '生成报告', target: 'none' } })],
  ['unclear review contradicts execution', decision({ review: { intent: 'unclear', evidence: '生成报告', target: 'none' } })],
  ['ambiguous execution target', decision({ review: { intent: 'execute', evidence: '生成报告', target: 'ambiguous' } })],
  ['execution selects an existing target', decision({ taskId: tasks[0].id })],
  ['continuation misses its target', { action: 'continue', taskId: null, review: { intent: 'continue', evidence: '改成蓝色', target: 'unique' } }],
  ['cancellation has ambiguous target', { action: 'cancel', taskId: tasks[0].id, review: { intent: 'cancel', evidence: '报告', target: 'ambiguous' } }],
  ['unoffered target', { action: 'continue', taskId: 'cccccccccccc', review: { intent: 'continue', evidence: '改成蓝色', target: 'unique' } }],
  ['status target conflicts with review', { action: 'status', taskId: null, review: { intent: 'status', evidence: '报告', target: 'unique' } }],
  ['chat selects a task', { action: 'chat', taskId: tasks[0].id, review: { intent: 'chat', evidence: '', target: 'none' } }],
  ['chat misrepresents an execute review', { action: 'chat', taskId: null, review: { intent: 'execute', evidence: '生成报告', target: 'none' } }],
  ['unbounded reasoning field', decision({ review: { intent: 'execute', evidence: '生成报告', target: 'none', thoughts: 'do not expose this' } })],
  ['rewritten work request field', decision({ request: '删除文件' })],
  ['unknown action', decision({ action: 'start' })],
];
for (const [name, value] of invalid) test(`rejects ${name} before any work is admitted`, () => {
  assert.throws(() => parse(value), { code: 'WORK_ROUTE_INVALID' });
});

test('bounded Unicode evidence is exact and malformed JSON is never repaired into a work decision', () => {
  const evidence = '🧩'.repeat(240);
  assert.equal(parse(decision({ review: { intent: 'execute', evidence, target: 'none' } }), evidence).review.evidence, evidence);
  assert.throws(() => parse(decision({ review: { intent: 'execute', evidence: evidence + '🧩', target: 'none' } }), evidence + '🧩'),
    { code: 'WORK_ROUTE_INVALID' });
  for (const raw of ['not-json', 'null', '[]', JSON.stringify(decision()) + '\n我已经开始了'])
    assert.throws(() => parseWorkRoute(raw, request, tasks), { code: 'WORK_ROUTE_INVALID' });
  assert.equal(parseWorkRoute('```json\n' + JSON.stringify(decision()) + '\n```', request, tasks).action, 'new');
});
