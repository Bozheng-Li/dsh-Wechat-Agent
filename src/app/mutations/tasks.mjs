import { ChannelError } from '../../shared/contracts.mjs';

export const endpoints = ['tasks.create', 'tasks.cancel', 'tasks.pause', 'tasks.resume'];

export async function tasksMutation(
  { scheduler, assertLive, currentAccount, conversation, status },
  endpoint,
  payload,
  signal
) {
  switch (endpoint) {
    case 'tasks.create': {
      const selector = conversation(payload);
      if (!scheduler) throw new ChannelError('TASKS_UNAVAILABLE', '定时任务组件尚未启动');
      if (
        payload.requestId !== undefined &&
        (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.requestId))
      )
        throw new ChannelError('INVALID_TASK', '任务请求标识无效，请重新打开任务表单');
      const scope = {
        ...selector,
        source: 'owner',
        senderId: selector.accountId,
        senderName: '管理员',
        requestKey: payload.requestId ? 'owner:' + selector.accountId + ':' + payload.requestId : undefined,
      };
      const targets = await scheduler.resolveTargets(payload.task?.targets || [], scope, signal);
      assertLive(signal);
      currentAccount(payload);
      scheduler.create({ ...payload.task, targets }, scope);
      break;
    }
    case 'tasks.cancel':
    case 'tasks.pause':
    case 'tasks.resume': {
      const account = currentAccount(payload);
      if (!scheduler) throw new ChannelError('TASKS_UNAVAILABLE', '定时任务组件尚未启动');
      const scope = { accountId: account.id };
      if (endpoint === 'tasks.cancel') scheduler.cancel(payload.taskId, scope, true);
      else if (endpoint === 'tasks.pause') scheduler.pause(payload.taskId, scope);
      else scheduler.resume(payload.taskId, scope);
      break;
    }
  }
  assertLive(signal);
  return status();
}
