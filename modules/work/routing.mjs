import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { workDialogueState } from './dialogue.mjs';

const same = (record, scope) => ['accountId', 'chatType', 'peerId', 'senderId'].every(key => record[key] === scope[key]);

/** A tool-free decision grants no authority; execution checks the live scope again. */
export async function routeWorkMessage(channel, item, signal) {
  channel.assertAllowed(item);
  channel.work.assertAllowed(item.record, signal);
  const position = channel.store.data.records.indexOf(item.record);
  const previous = position < 0 ? channel.store.data.records.filter(record => record.createdAt < item.record.createdAt)
    : channel.store.data.records.slice(0, position);
  const history = previous.filter(record => record.mode === 'work' && same(record, item.record) &&
    !record.workJobId && !record.modeControl && !record.remoteQuery && record.state === 'sent' && record.reply)
    .slice(-8).map(record => ({ user: record.question?.slice(0, 1200), assistant: record.reply.slice(0, 1200) }));
  const state = workDialogueState(channel, item.record);
  const current = channel.work.dialogueTask(item.record);
  const tasks = current && !state.tasks.some(task => task.id === current.id)
    ? [...state.tasks, { id: current.id, request: current.request.slice(0, 160), state: current.state }] : state.tasks;
  try {
    const result = await channel.runner.run({ mode: 'work-routing', tools: [],
      systemOverride: readPrompt('work/routing.md'),
      text: JSON.stringify({ message: item.text, history, tasks, currentTaskId: current?.id ?? null }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    signal.throwIfAborted();
    channel.assertAllowed(item);
    channel.work.assertAllowed(item.record, signal);
    const value = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        Object.keys(value).some(key => !['action', 'taskId'].includes(key)) ||
        !['chat', 'new', 'continue', 'status', 'cancel'].includes(value.action))
      throw new ChannelError('WORK_ROUTE_INVALID', '模型未返回有效的工作判断');
    const id = value.taskId;
    if (id != null && (typeof id !== 'string' || !tasks.some(task => task.id === id)))
      throw new ChannelError('WORK_ROUTE_INVALID', '模型选择的任务不在当前发起人的任务范围内');
    if (['chat', 'new'].includes(value.action) && id != null || ['continue', 'cancel'].includes(value.action) && !id)
      throw new ChannelError('WORK_ROUTE_INVALID', '工作判断缺少明确的任务目标');
    if (id) channel.work.owned(id, item.record);
    return { action: value.action, ...(id ? { taskId: id } : {}) };
  } catch (error) {
    signal.throwIfAborted();
    channel.assertAllowed(item);
    channel.work.assertAllowed(item.record, signal);
    if (['STATE_WRITE_FAILED', 'CONFIG_CHANGED'].includes(error?.code)) throw error;
    return { action: 'chat', fallback: publicError(error, '工作判断暂时不可用').code };
  }
}
