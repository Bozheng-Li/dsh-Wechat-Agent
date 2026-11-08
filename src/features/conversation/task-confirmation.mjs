// A character may react to a saved reminder, but never rewrite its state,
// recipient, content or deadline. Those remain an application-owned receipt.
export const REMINDER_REACTIONS = Object.freeze([
  '好', '好的', '好呀', '好嘞', '得嘞', '行', '成', '妥了', '明白', '收到',
  '记下了', '记好了', '晓得了', '知晓了', '应下了', '嗯', '行吧', '遵命',
]);
function safeReaction(value) {
  const text = typeof value === 'string' ? value.trim().replace(/[。！!～~]+$/u, '') : '';
  return REMINDER_REACTIONS.includes(text) ? text : '';
}

export function reminderReaction(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return ''; }
  if (!value || Array.isArray(value) || Object.keys(value).some(key => key !== 'reaction')) return '';
  return safeReaction(value.reaction);
}

export function reminderReceipt(task, audience, reaction = '') {
  reaction = safeReaction(reaction);
  const when = new Date(task.nextRunAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const activity = task.content.replace(/^到点啦，别忘了/u, '').replace(/[。！!]+$/u, '');
  return `${reaction ? reaction + (/[。！!？?～~]$/u.test(reaction) ? '' : '。') : '记下了。'}${when}提醒${audience}：${activity}。`;
}
