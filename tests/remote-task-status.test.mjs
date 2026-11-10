import test from 'node:test';
import assert from 'node:assert/strict';
import { dshTaskStatus, formatDshTasks } from '../lib/testing.js';

const ev = (type, data, seq, time = 1700000000000 + seq) => ({ type, data, seq, time });
const message = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
function agent(id, options = {}) {
  const events = options.events ?? [ev('user/message', message(options.title ?? '测试需求'), 0),
    ev('turn/start', { turn: 1 }, 1), ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '最近真实回复' }] } }, 2),
    ev('turn/end', { turn: 1, reason: { kind: options.end ?? 'completed' } }, 3)];
  return { id, status: options.status ?? 'idle', inbox: { nextTurn: options.queued ? [1] : [], nextStep: [] },
    ctx: options.ctx, session: { header: { cwd: options.cwd ?? 'E:\\项目\\目录' }, seq: events.length, snapshotEvents: () => events }, events };
}
function context(agents, jobs = []) {
  return { agents: { list: () => agents, resume: () => assert.fail('must not resume'), create: () => assert.fail('must not create') },
    jobs: { list: owner => jobs.filter(job => !job.owner || job.owner === owner), kill: () => assert.fail('must not kill'), read: () => assert.fail('must not consume job output') } };
}

test('titles come from the existing agent scope, with logged title and human request fallbacks and no mutations', () => {
  const a = agent('task-a', { ctx: { get: key => key === 'sessionTitle' ? { get: session => { assert.equal(session, a.session); return { title: '填写年度业绩表格说明' }; } } : undefined } });
  const b = agent('task-b', { events: [ev('user/message', message('搜集后训练项目'), 0), ev('session/title', { title: '已保存的 DSH 标题' }, 1)] });
  const c = agent('task-c', { title: '用户最初的需求' });
  const before = JSON.stringify([a.events, b.events, c.events]);
  const result = dshTaskStatus(context([a, b, c]));
  assert.equal(result.tasks.find(row => row.id === a.id).title, '填写年度业绩表格说明');
  assert.equal(result.tasks.find(row => row.id === b.id).title, '已保存的 DSH 标题');
  assert.equal(result.tasks.find(row => row.id === c.id).title, '用户最初的需求');
  assert.equal(JSON.stringify([a.events, b.events, c.events]), before);
  assert.equal(a.status, 'idle');
});

test('the six-session production shape yields three user tasks and omits empty and idle internal sessions without deleting them', () => {
  const users = ['task-a', 'task-b', 'task-c'].map(id => agent(id));
  const empty = agent('empty-task', { events: [] });
  const internals = ['old-test-a', 'old-test-b'].map(id => agent(id, { cwd: 'D:\\storage\\logs\\synthetic-workspaces',
    events: [ev('user/message', { source: { kind: 'wechat-agent' }, content: [{ type: 'text', text: '内部合成输入' }] }, 0)] }));
  const ctx = context([...users, empty, ...internals]), result = dshTaskStatus(ctx);
  assert.equal(result.total, 6); assert.equal(result.visibleTotal, 3); assert.equal(result.hiddenEmpty, 1); assert.equal(result.hiddenInternal, 2);
  assert.equal(ctx.agents.list().length, 6);
  const text = formatDshTasks(result);
  assert(!text.includes('synthetic-workspaces')); assert(!text.includes('事件序号'));
  const detail = dshTaskStatus(ctx, 'old-test-a');
  assert.equal(detail.tasks.length, 1, 'explicit inspection retains the original live session');
  assert.equal(detail.hiddenInternal, 0);
});

test('idle execution, unfinished goal, failure, cancellation and active background work have separate factual labels', () => {
  const activeGoal = { failure: null, current: { goal: { objective: '整理新闻摘要', phase: 'active' } } };
  const a = agent('task-goal', { ctx: { sessionProjections: { stateOf: (_, key) => key === 'goal' ? activeGoal : undefined } } });
  const failed = agent('task-failed', { end: 'error' }), cancelled = agent('task-cancelled', { end: 'aborted' }), background = agent('task-background');
  const result = dshTaskStatus(context([a, failed, cancelled, background], [{ id: 'job-a', status: 'running', owner: background.id }]));
  const text = formatDshTasks(result);
  assert(text.includes('本轮已结束')); assert(text.includes('目标记录：未完成')); assert(text.includes('本轮出错'));
  assert(text.includes('本轮已取消')); assert(text.includes('后台任务仍在运行'));
  assert.equal(result.running, 0); assert.equal(result.backgroundRunning, 1);
  assert.equal(result.tasks[0].id, background.id);
  assert.equal(activeGoal.current.goal.phase, 'active');
});

test('a new turn never presents the previous reply or completed checklist as current progress', () => {
  const events = [ev('user/message', message('原任务'), 0), ev('turn/start', { turn: 1 }, 1),
    ev('todo/write', { todos: [{ content: '旧步骤', status: 'completed' }] }, 2),
    ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '旧轮已完成' }] } }, 3),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4), ev('turn/start', { turn: 2 }, 5)];
  const a = agent('task-new-turn', { status: 'running', events });
  const row = dshTaskStatus(context([a])).tasks[0];
  assert.equal(row.checklist, null); assert.equal(row.lastReply, ''); assert.equal(row.turnEnd, null);
  events.push(ev('todo/write', { todos: [{ content: '新步骤', status: 'in_progress' }] }, 6));
  const current = dshTaskStatus(context([a])).tasks[0];
  assert.deepEqual(current.checklist, { total: 1, completed: 0, active: ['新步骤'] });
});

test('owned and unowned jobs are counted once, detailed lookup retains global counts and commands or hidden reasoning are not copied', () => {
  const a = agent('task-a'), b = agent('task-b', { events: [ev('user/message', message('任务 B'), 0),
    ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '<think>PRIVATE_THOUGHT</think>可见的回复' }] } }, 1)] });
  const ctx = context([a, b], [{ id: 'job-a', status: 'running', owner: a.id, label: 'PRIVATE_COMMAND_VALUE' },
    { id: 'job-global', status: 'running', label: 'PRIVATE_COMMAND_VALUE' }, { id: 'job-old', status: 'completed', owner: b.id }]);
  const result = dshTaskStatus(ctx, b.id);
  assert.equal(result.backgroundRunning, 2); assert.deepEqual(result.tasks[0].jobs.map(job => job.id), ['job-old']);
  const text = formatDshTasks(result);
  assert(text.includes('可见的回复')); assert(!text.includes('PRIVATE_THOUGHT')); assert(!text.includes('PRIVATE_COMMAND_VALUE'));
});

test('short UUID IDs resolve uniquely, colliding prefixes expand and ambiguous reads never choose a session', () => {
  const a = agent('session-12345678-aaaa-4000-8000-000000000001'), b = agent('session-12345678-bbbb-4000-8000-000000000002');
  const ctx = context([a, b]), result = dshTaskStatus(ctx);
  assert(result.tasks.every(row => row.shortId.length > 8));
  assert.throws(() => dshTaskStatus(ctx, '12345678'), { code: 'REMOTE_TASK_AMBIGUOUS' });
  assert.equal(dshTaskStatus(ctx, result.tasks[0].shortId).tasks[0].id, result.tasks[0].id);
  assert.equal(dshTaskStatus(ctx, '12345678-AAAA').tasks[0].id, a.id);
  assert.equal(dshTaskStatus(ctx, b.id).tasks[0].id, b.id);
  assert.throws(() => dshTaskStatus(ctx, '1234'), { code: 'REMOTE_TASK_NOT_FOUND' });
});

test('missing snapshot or job capabilities preserve an unknown session rather than fabricating an empty or finished task', () => {
  const a = agent('task-unknown', { events: [] });
  a.session.snapshotEvents = () => { throw Error('snapshot unavailable'); };
  const result = dshTaskStatus({ agents: { list: () => [a] } });
  assert.equal(result.visibleTotal, 1); assert.equal(result.hiddenEmpty, 0); assert.equal(result.tasks[0].turnEnd, null);
  assert.equal(result.backgroundAvailable, false);
  const text = formatDshTasks(result);
  assert(text.includes('结束原因未提供')); assert(text.includes('后台任务数量暂时无法确认'));
});

test('only known internal source namespaces are omitted and running internal agents remain visible', () => {
  const latest = agent('unknown-source', { events: [ev('user/message', { source: { kind: 'latest-followup' }, content: [] }, 0)] });
  const running = agent('active-test', { status: 'running', events: [ev('user/message', { source: { kind: 'remote-native-fixture' }, content: [] }, 0)] });
  const result = dshTaskStatus(context([latest, running]));
  assert.equal(result.visibleTotal, 2); assert.equal(result.hiddenInternal, 0); assert.equal(result.running, 1);
});

test('large lists prioritize active work, report truncation and preserve the full loaded registry', () => {
  const agents = Array.from({ length: 12 }, (_, i) => agent('task-' + i, { status: i === 11 ? 'running' : 'idle' }));
  const result = dshTaskStatus(context(agents));
  assert.equal(result.total, 12); assert.equal(result.visibleTotal, 12); assert.equal(result.tasks.length, 10);
  assert.equal(result.tasks[0].id, 'task-11'); assert.equal(result.hasMore, true);
});
