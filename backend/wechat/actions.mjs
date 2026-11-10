export const endpoints = ['connect', 'disconnect', 'login.start', 'login.cancel', 'cancel'];

export async function connectionMutation(
  { store, worker, scheduler, assertLive, conversation, paused, status },
  endpoint,
  payload,
  signal
) {
  switch (endpoint) {
    case 'connect':
      store.data.connectionWanted = true;
      store.save();
      await worker.call('connect');
      if (scheduler?.stopped) {
        scheduler.error = null;
        scheduler.start();
      }
      break;
    case 'disconnect':
      store.data.connectionWanted = false;
      store.save();
      await paused('微信已断开，任务已取消', () => {
        assertLive(signal);
        return worker.call('disconnect');
      });
      break;
    case 'login.start':
      await paused('正在重新登录，旧账号任务已取消', () => {
        assertLive(signal);
        return worker.call('login.start', { replace: payload.replace === true });
      });
      assertLive(signal);
      store.data.connectionWanted = true;
      store.save();
      break;
    case 'login.cancel':
      await worker.call('login.cancel');
      break;
    case 'cancel': {
      const scoped = ['accountId', 'chatType', 'peerId'].some((field) => Object.hasOwn(payload, field));
      const selector = scoped ? conversation(payload) : undefined;
      await paused('已取消当前任务和排队消息', () => {}, selector);
      break;
    }
  }
  assertLive(signal);
  return status();
}
