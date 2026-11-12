import { ChannelError } from '../../shared/contracts.mjs';
export const TRACE_ENDPOINTS = ['traces.list', 'traces.get', 'traces.content', 'traces.export'];

export async function traceQuery(traces, endpoint, accountId, payload, signal) {
  if (!traces) throw new ChannelError('TRACE_UNAVAILABLE', '任务执行轨迹尚未启用');
  signal?.throwIfAborted();
  if (endpoint === 'traces.list') return traces.list(accountId, payload);
  if (endpoint === 'traces.get') return traces.get(accountId, payload.traceId, payload);
  if (endpoint === 'traces.content') return traces.content(accountId, payload.traceId, payload.contentId);
  const first = await traces.get(accountId, payload.traceId, { limit: 200 });
  const steps = [...first.steps];
  for (let offset = first.limit; offset < first.total; offset += 200) {
    signal?.throwIfAborted();
    steps.push(...(await traces.get(accountId, payload.traceId, { offset, limit: 200 })).steps);
  }
  const content = {}, ids = new Set([first.trace.input, first.trace.output, first.trace.configuration,
    ...steps.flatMap(step => [step.input, step.output, step.error])].filter(Boolean).map(ref => ref.id));
  let size = 0;
  for (const id of ids) {
    signal?.throwIfAborted();
    content[id] = await traces.content(accountId, payload.traceId, id);
    size += JSON.stringify(content[id]).length;
    if (size > 64 * 1024 * 1024) throw new ChannelError('TRACE_EXPORT_LARGE', '这条轨迹较大，请在步骤详情中分项查看；完整记录仍保存在本机');
  }
  const after = await traces.get(accountId, payload.traceId, { limit: 1 });
  return { filename: 'wechat-task-' + payload.traceId + '.json', data: { version: 1, exportedAt: new Date().toISOString(),
    snapshotAt: first.trace.updatedAt, changedDuringExport: after.trace.updatedAt !== first.trace.updatedAt || after.trace.eventCount !== first.trace.eventCount,
    trace: first.trace, steps, content } };
}
