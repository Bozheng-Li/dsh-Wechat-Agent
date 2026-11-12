import { CHANNEL } from "../../shared/contracts.mjs";

export async function call(connection, endpoint, payload = {}, signal) {
  let result;
  try {
    result = await connection.rpc.call(CHANNEL, endpoint, payload, signal);
  } catch {
    throw new Error(
      [
        'status',
        'contacts',
        'records.list',
        'traces.list',
        'traces.get',
        'traces.content',
        'traces.export',
        'changelog',
        'identity.get',
        'model.info',
        'memory.list',
        'memory.get',
        'memory.role.get',
        'memory.role.list',
        'time.list',
        'tasks.list',
        'moments.list',
        'moments.likes.list',
        'moments.interactions.list',
        'moments.read',
        'moments.images',
        'moments.audience',
        'moments.discover',
      ].includes(endpoint)
        ? '暂时无法读取微信插件，请检查 DSH 连接后重试。'
        : '未能确认操作结果，请重新读取状态，核对是否已保存后再试。'
    );
  }
  if (!result?.ok) {
    const error = new Error(result?.error?.message || '操作未完成，请核对当前状态后重试。');
    if (typeof result?.error?.code === 'string') error.code = result.error.code;
    if (['not-sent', 'rejected'].includes(result?.error?.delivery)) error.delivery = result.error.delivery;
    throw error;
  }
  return result.value;
}
