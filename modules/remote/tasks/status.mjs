import { ChannelError } from '../../../shared/contracts.mjs';
import { publicText } from '../../../backend/wechat/ai/public-output.ts';
const clean = (value, limit = 180) => {
  const text = publicText(String(value ?? '')).replace(/[\u0000-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
};
const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : '';
const service = (ctx, name) => { try { return ctx?.get?.(name) ?? ctx?.[name]; } catch { return undefined; } };
const read = operation => { try { return operation(); } catch { return undefined; } };
const activeJob = job => ['running', 'stopping'].includes(job.status);
const identity = id => String(id).replace(/^session-(?=[a-f0-9]{8}-)/i, '');
const human = event => event.type === 'user/message' && ['user', 'wechat-work'].includes(event.data?.source?.kind);
const internal = event => event.type === 'user/message' && (event.data?.source?.kind === 'wechat-agent' || /(?:^|[-_/])(?:fixture|test|synthetic)(?:$|[-_/])/i.test(event.data?.source?.kind ?? ''));

function shortId(id, live) {
  const token = identity(id);
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(token)) return id;
  for (let size = 8; size <= token.length; size++) {
    const prefix = token.slice(0, size);
    if (live.filter(agent => identity(agent.id).toLowerCase().startsWith(prefix.toLowerCase())).length === 1) return prefix;
  }
  return id;
}

function snapshot(ctx, agent, live) {
  const session = agent.session;
  const captured = read(() => session.snapshotEvents());
  const events = Array.isArray(captured) ? captured : [];
  const projections = service(agent.ctx, 'sessionProjections') ?? service(ctx, 'sessionProjections');
  const titleService = service(agent.ctx, 'sessionTitle') ?? service(ctx, 'sessionTitle');
  const title = read(() => titleService?.get?.(session)?.title) ??
    read(() => projections?.stateOf?.(session, 'title')) ??
    events.findLast(event => event.type === 'session/title')?.data?.title ?? session.header?.title;
  const goalState = read(() => projections?.stateOf?.(session, 'goal'));
  const currentGoal = goalState?.failure ? null : goalState?.current?.goal;
  const goal = currentGoal ? { phase: clean(currentGoal.phase), objective: clean(currentGoal.objective),
    blockedReason: clean(currentGoal.blockedReason?.message) } : null;
  // The host clears this projection on turn/start; never present an older
  // turn's checklist as progress of the current request.
  const lastTurn = events.findLast(event => event.type === 'turn/start');
  const recordedTodos = events.findLast(event => event.type === 'todo/write' && (!lastTurn || event.seq > lastTurn.seq));
  const todos = read(() => projections?.stateOf?.(session, 'todos')) ?? recordedTodos?.data?.todos;
  const checklist = Array.isArray(todos) ? { total: todos.length, completed: todos.filter(todo => todo.status === 'completed').length,
    active: todos.filter(todo => todo.status === 'in_progress').map(todo => clean(todo.content)).slice(0, 3) } : null;
  const jobsService = service(agent.ctx, 'jobs') ?? service(ctx, 'jobs');
  const listed = read(() => jobsService?.list?.(agent.id));
  // Native list(owner) also returns unowned jobs. They belong in the global
  // background count, never under each individual session.
  const jobs = Array.isArray(listed) ? listed.filter(job => job.owner === agent.id).map(job => ({
    id: clean(job.id), status: clean(job.status), startedAt: job.startedAt, finishedAt: job.finishedAt,
  })) : null;
  const end = events.findLast(event => event.type === 'turn/end');
  const closedTurn = end && (!lastTurn || end.seq > lastTurn.seq) ? end : null;
  const recentReply = events.findLast(event => event.type === 'assistant/message' && !event.data?.interrupted &&
    (!lastTurn || event.data?.turn === lastTurn.data?.turn));
  const lastActivity = events.findLast(event => /^(?:user\/message|assistant\/message|assistant\/attempt|tool\/call|tool\/result|turn\/start|turn\/end|step\/start|step\/end|job\/registered|job\/settled|todo\/write|goal\/change)$/.test(event.type));
  const queued = (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0);
  const firstHuman = events.find(human);
  const hasHuman = !!firstHuman, hasInternal = events.some(internal);
  const working = agent.status === 'running' || queued > 0 || jobs?.some(activeJob);
  const omitted = !working && !hasHuman && !goal && hasInternal ? 'internal'
    : !working && !hasHuman && !goal && !title && Array.isArray(captured) && !events.some(event => event.type === 'user/message') ? 'empty' : null;
  return { id: clean(agent.id, 300), shortId: shortId(agent.id, live), title: clean(title) || clean(textOf(firstHuman?.data?.content), 60) || '会话（名称未提供）',
    status: clean(agent.status), cwd: clean(session.header?.cwd, 500), seq: session.seq, queued, jobs, goal, checklist,
    lastReply: clean(textOf(recentReply?.data?.message?.content)), lastReplyAt: recentReply?.time,
    lastActivityAt: Number.isSafeInteger(lastActivity?.time) ? lastActivity.time : null,
    turnEnd: closedTurn?.data?.reason?.kind ?? null, metadataAvailable: Array.isArray(captured), omitted };
}

/** Read only live instances and their existing scoped projections/logs. */
export function dshTaskStatus(ctx, id) {
  const agents = service(ctx, 'agents');
  if (typeof agents?.list !== 'function') throw new ChannelError('REMOTE_UNAVAILABLE', 'DSH 未提供当前任务列表，无法确认执行状态');
  const live = agents.list();
  let selected = live;
  if (id) {
    selected = live.filter(agent => agent.id === id);
    if (!selected.length && id.length >= 8) selected = live.filter(agent => identity(agent.id).toLowerCase().startsWith(id.toLowerCase()) || agent.id.toLowerCase().startsWith(id.toLowerCase()));
    if (!selected.length) throw new ChannelError('REMOTE_TASK_NOT_FOUND', '未找到这个运行实例中的任务。可以说“列出 DSH 当前任务”，再提供列表中的短编号或完整编号查询。');
    if (selected.length > 1) throw new ChannelError('REMOTE_TASK_AMBIGUOUS', '这个短编号匹配多个会话，请提供更长或完整的编号；未任选一个任务。');
  }
  const rows = live.map(agent => snapshot(ctx, agent, live));
  const visible = id ? rows.filter(row => selected.some(agent => agent.id === row.id)) : rows.filter(row => !row.omitted);
  visible.sort((a, b) => Number(b.status === 'running' || b.jobs?.some(activeJob)) - Number(a.status === 'running' || a.jobs?.some(activeJob)) ||
    (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const globalJobsService = service(ctx, 'jobs');
  const unowned = read(() => globalJobsService?.list?.());
  const background = new Map();
  for (const row of rows) for (const job of row.jobs ?? []) background.set(job.id, job);
  for (const job of Array.isArray(unowned) ? unowned.filter(job => !job.owner) : []) background.set(job.id, { id: clean(job.id), status: clean(job.status) });
  const backgroundJobs = [...background.values()];
  return { observedAt: Date.now(), total: live.length, running: live.filter(agent => agent.status === 'running').length,
    visibleTotal: visible.length, detail: !!id, hiddenInternal: id ? 0 : rows.filter(row => row.omitted === 'internal').length,
    hiddenEmpty: id ? 0 : rows.filter(row => row.omitted === 'empty').length, tasks: visible.slice(0, 10), hasMore: visible.length > 10,
    backgroundRunning: backgroundJobs.filter(activeJob).length, backgroundJobs,
    backgroundAvailable: rows.every(row => row.jobs !== null) && Array.isArray(unowned) };
}
