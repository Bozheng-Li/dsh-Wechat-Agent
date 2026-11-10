import { ChannelError } from '../../../shared/contracts.mjs';

/** Admission only. The isolated Agent determines the requested read, not these words. */
export function naturalRemoteRequest(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 12000 || /^[/"“「『`]/u.test(value) || /^(?:转发|引用|例句|示例|翻译|复述)[：:\s]/u.test(value)) return null;
  if (/(?:不要|不用|无需|不必|不需要|别).{0,8}(?:查询|查看|检查|读取|看电脑|看任务)/u.test(value)) return null;
  if (/(?:写|创建|生成|修改|开发|实现).{0,20}(?:代码|脚本|程序|网页|文件)/u.test(value)) return null;
  if (/什么是|解释|科普|原理|概念|定义|是什么意思|是什么|翻译/iu.test(value) && !/现在|当前|目前|本机|我的|这台|查看|查询|看看|检查/u.test(value)) return null;
  const host = /电脑|计算机|本机|这台机器|服务器|\bcpu\b|内存|硬盘|磁盘|deepseek\s*harness|\bdsh\b/iu;
  const request = /查看|查询|查查|查一下|查下|看看|看一下|看下|检查|监控|状态|进度|运行情况|占用|剩余|空闲|忙不忙|高不高|卡不卡|怎么样|咋样|多少|什么情况|正常吗|还在跑|跑(?:完|到哪)|执行(?:完|到哪)|完成(?:了|没)|运行(?:了|没)|进行到哪|到哪一步|how.*(?:doing|progress)|status|progress|usage/iu;
  const demand = /帮我|给我|请|麻烦|查看|查询|查查|查一下|查下|看看|看一下|看下|检查|监控|吗|么|没[？?]?$|多少|怎么样|咋样|什么情况|到哪|忙不忙|高不高|卡不卡|有没有|[？?]|\b(?:check|show|what|how|status|progress)\b/iu.test(value) || /^(?:电脑|本机|cpu|内存|磁盘|硬盘|DSH).{0,10}(?:状态|占用|进度|剩余)$/iu.test(value);
  const execution = /(?:任务|harness|\bdsh\b).{0,30}(?:进度|状态|怎么样|什么情况|跑|运行|执行|完成|结束|进行|到哪|剩余|多久)|(?:跑完了|执行完了|完成了|还在跑|跑到哪|执行到哪).{0,8}[吗么没？?]/iu;
  return demand && (host.test(value) && request.test(value) || execution.test(value)) ? { action: 'interpret', text: value } : null;
}

/** A model can select finite read-only operations; it cannot supply commands or facts. */
export function parseRemoteIntent(raw, request) {
  let value;
  try { value = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {}
  const invalid = () => { throw new ChannelError('REMOTE_INTENT_INVALID', '没能确定你要查询的内容。可以直接说“看看电脑现在的状态”或“DSH 任务跑到哪了”，我再查询实际状态。'); };
  if (!value || Array.isArray(value) || Object.keys(value).some(key => key !== 'queries') || !Array.isArray(value.queries) || value.queries.length > 3) invalid();
  const selected = new Map();
  for (const query of value.queries) {
    if (!query || Array.isArray(query) || !['computer', 'tasks', 'task'].includes(query.action)) invalid();
    if (query.action === 'task') {
      if (Object.keys(query).some(key => !['action', 'id'].includes(key)) || typeof query.id !== 'string' ||
          !/^[a-z0-9_.-]{1,150}$/i.test(query.id) || !String(request).includes(query.id)) invalid();
    } else if (Object.keys(query).some(key => key !== 'action')) invalid();
    selected.set(query.action + ':' + (query.id ?? ''), query.action === 'task' ? { action: 'task', id: query.id } : { action: query.action });
  }
  return [...selected.values()];
}
