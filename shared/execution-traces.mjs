export const TRACE_TYPES = Object.freeze([
  ['all', '全部任务', '汇总各类任务的执行过程'],
  ['conversation', '会话回复', '消息接收、上下文读取、模型与工具调用、微信回执'],
  ['work', '工作任务', '工作调度、执行步骤、成果处理与投递'],
  ['scheduled', '定时任务', '每次定时执行、生成内容与实际发送结果'],
  ['moments', '朋友圈', '取材、生成、发布、评论与点赞的执行过程'],
  ['memory', '记忆整理', '会话记忆、长期记忆与人物资料的后台整理'],
  ['media', '表情图片', '表情同步、聊天收集、图像理解与素材处理'],
  ['digest', '群聊简报', '简报取材、生成与发送'],
  ['maintenance', '诊断恢复', '运行诊断、发送核对与恢复处理'],
]);

export const TRACE_STATES = Object.freeze({
  queued: '等待执行', running: '执行中', completed: '已完成', failed: '失败',
  cancelled: '已取消', skipped: '已跳过', unknown: '结果待核实', interrupted: '记录中断', partial: '部分完成',
});
export const TRACE_KINDS = Object.freeze({ stage: '处理步骤', model: '模型调用', tool: '工具调用',
  transport: '微信接口', lifecycle: '任务状态', child: '关联任务' });
export const TRACE_ACTIVE = new Set(['queued', 'running']);
export const TRACE_PROBLEMS = new Set(['failed', 'unknown', 'interrupted', 'partial']);
export const traceTypeLabel = type => TRACE_TYPES.find(row => row[0] === type)?.[1] || '其他任务';
export function traceState(value, failure) {
  if (failure) return /UNKNOWN/.test(failure.code || '') || failure.details?.delivery === 'unknown' || failure.details?.snsDelivery === 'unknown'
    ? 'unknown' : /CANCEL|ABORT|ACCOUNT_CHANGED|AUTH_CHANGED|PLUGIN_STOPPING|SETTINGS_CHANGED|YIELD_TO_/.test(failure.code || '') || failure.name === 'AbortError' ? 'cancelled' : 'failed';
  const state = value?.state;
  if (value?.delivery === 'unknown' || value?.delivery?.state === 'unknown' || value?.snsDelivery === 'unknown' || state === 'published-unverified' ||
      value?.confirmed === false && ['unknown', 'published-unverified'].includes(value?.outcome)) return 'unknown';
  if (['failed', 'cancelled', 'unknown', 'interrupted', 'partial', 'skipped'].includes(state)) return state;
  if (['rejected', 'not-sent'].includes(state)) return 'failed';
  if (state === 'discarded') return 'cancelled';
  if (state === 'empty') return 'skipped';
  if (value?.ok === false || value?.failed === true || value?.failed > 0 || value?.error) return value?.succeeded > 0 ? 'partial' : 'failed';
  if (Object.hasOwn(TRACE_STATES, state)) return state;
  if (['sent', 'published', 'ready', 'saved', 'succeeded', 'confirmed', 'draft', 'done', 'liked', 'existing', 'deleted'].includes(state)) return 'completed';
  if (value?.skipped) return 'skipped';
  return 'completed';
}
export function traceDuration(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return Math.round(Math.max(0, value)) + ' 毫秒';
  if (value < 60000) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + ' 秒';
  const minutes = Math.floor(value / 60000), seconds = Math.floor(value % 60000 / 1000);
  if (minutes < 60) return minutes + ' 分 ' + seconds + ' 秒';
  return Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分';
}
