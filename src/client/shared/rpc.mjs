import { CHANNEL } from '../../shared/contracts.mjs';

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
        'changelog',
        'identity.get',
        'memory.list',
        'memory.get',
        'tasks.list',
      ].includes(endpoint)
        ? '暂时无法读取微信插件，请检查 DSH 连接后重试。'
        : '未能确认操作结果，请重新读取状态，核对是否已保存后再试。'
    );
  }
  if (!result?.ok) throw new Error(result?.error?.message || '操作未完成，请核对当前状态后重试。');
  return result.value;
}
