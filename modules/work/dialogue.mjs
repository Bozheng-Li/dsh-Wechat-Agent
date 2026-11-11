import { ChannelError } from '../../shared/contracts.mjs';
import { workResult } from './result.mjs';

const same = (record, scope) => ['accountId', 'chatType', 'peerId', 'senderId'].every(key => record[key] === scope[key]);
const stages = { wechat_work_list: '查看目录', wechat_work_read: '读取文件', wechat_work_write: '保存文件',
  wechat_work_exec: '执行本机命令', wechat_work_ssh_connect: '验证 SSH', wechat_work_ssh_exec: '读取远端结果',
  wechat_work_output: '登记成果', wechat_work_generate_image: '生成图片', wechat_work_status: '查询状态' };

export function workDialogueState(channel, scope, id) {
  const { jobs, capacity } = id ? { jobs: [channel.work.get(id, scope)], capacity: channel.work.capacity() } : channel.work.list(scope);
  const active = job => ['queued', 'running'].includes(job.state);
  const selected = id ? jobs : [...jobs.filter(active), ...jobs.filter(job => !active(job))].slice(0, 12);
  return { capacity, tasks: selected.map(job => ({
    id: job.id, request: id ? job.request : job.request.slice(0, 160), state: job.state, delivery: job.delivery.state,
    ...(!id && job.request.length > 160 ? { requestTruncated: true } : {}),
    ...(job.startedAt ? { elapsedSeconds: Math.max(0, Math.floor(((job.finishedAt ?? channel.now()) - job.startedAt) / 1000)) } : {}),
    operations: job.operations.length,
    ...(job.operations.length ? { lastStage: { name: stages[job.operations.at(-1).tool] ?? '处理任务', ok: job.operations.at(-1).result.ok } } : {}),
    ...(id && !active(job) ? { result: workResult(job, job.cwd).slice(0, 4000) } : {}),
    files: (job.result?.artifacts ?? []).map(file => ({ name: file.name, ...(id ? { path: file.path } : {}) })),
  })) };
}

export function workDialogueHistory(channel, item, scope) {
  const position = channel.store.data.records.findIndex(record => record.key === item.record.key);
  const records = position < 0 ? channel.store.data.records.filter(record => record.createdAt < item.record.createdAt)
    : channel.store.data.records.slice(0, position);
  // Freeze this turn's eligible history. Later messages cannot enter a tool
  // call in an earlier turn, and no previous text is preloaded into the model.
  const entries = records.filter(record => record.mode === 'work' && same(record, scope) &&
    !record.workJobId && record.state === 'sent' && typeof record.question === 'string' && typeof record.reply === 'string' && record.reply).slice(-8).map(record => ({
      user: record.question.slice(0, 1200), assistant: record.reply.slice(0, 1200),
      createdAt: record.createdAt, taskIds: [...(record.createdWorkJobIds ?? [])],
      ...(record.question.length > 1200 || record.reply.length > 1200 ? { truncated: true } : {}),
    }));
  return (limit = 4) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
      throw new ChannelError('WORK_HISTORY_INVALID', '请查询最近 1–8 条已确认的工作对话');
    return { source: 'confirmed-work-dialogue', entries: entries.slice(-limit) };
  };
}

export function recordWorkCreation(channel, item, job) {
  item.createdWorkJobIds ??= [];
  item.createdWorkJobIds.push(job.id);
  channel.store.update(item.record, { createdWorkJobIds: [...item.createdWorkJobIds] });
}

export async function replyToWork(channel, item, scope, signal) {
  signal.throwIfAborted(); channel.work.assertAllowed(scope, signal);
  const command = item.workCommand;
  return { text: channel.work.handle(command, scope, { defer: true,
    quotedReferences: item.quotedReferences,
    conversationTurn: ['create', 'continue'].includes(command.action),
    onCreated: job => recordWorkCreation(channel, item, job) }) };
}
