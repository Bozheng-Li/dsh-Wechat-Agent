const time = timestamp => Number.isSafeInteger(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '未提供';
const project = cwd => String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1);
const goalLabels = { active: '未完成', paused: '已暂停', blocked: '受阻', complete: 'DSH 已标记完成' };
const jobLabels = { running: '运行中', stopping: '正在停止', completed: '已完成', failed: '失败', stopped: '已停止' };
function execution(task) {
  if (task.status === 'running') return '正在执行';
  if (task.jobs?.some(job => ['running', 'stopping'].includes(job.status))) return '后台任务仍在运行';
  if (task.queued) return '有消息等待处理';
  if (task.status && task.status !== 'idle') return { failed: '执行失败', stopped: '已停止', stopping: '正在停止' }[task.status] ?? '状态：' + task.status;
  return { completed: '本轮已结束', error: '本轮出错', aborted: '本轮已取消', interrupted: '本轮已中断', blocked: '本轮未能执行', 'max-tokens': '本轮达到输出上限' }[task.turnEnd] ?? '当前未执行（结束原因未提供）';
}
export function formatDshTasks(result) {
  const background = result.backgroundAvailable === false ? '后台任务数量暂时无法确认' : '后台运行 ' + (result.backgroundRunning ?? 0) + ' 个';
  const lines = ['DSH 任务 · ' + time(result.observedAt), '正在执行 ' + result.running + ' 个会话 · ' + background];
  if (result.detail) {
    const task = result.tasks[0];
    if (task) lines.push(task.title + ' · ' + execution(task), '编号：' + task.id, task.cwd ? '目录：' + task.cwd : '');
  }
  for (const task of result.tasks) {
    if (!result.detail) lines.push(task.title + ' · ' + execution(task), '短编号：' + (task.shortId ?? task.id) + (task.cwd ? ' · 项目：' + project(task.cwd) : ''));
    if (task.goal) lines.push('目标记录：' + (goalLabels[task.goal.phase] ?? task.goal.phase) + ' · ' + task.goal.objective,
      task.goal.blockedReason ? '受阻原因：' + task.goal.blockedReason : '');
    if (task.checklist?.total) lines.push('本轮清单：已勾选完成 ' + task.checklist.completed + '/' + task.checklist.total,
      task.checklist.active.length ? '清单当前项：' + task.checklist.active.join('；') : '');
    lines.push(task.lastReply ? '最近回复摘录：' + task.lastReply : '本轮暂无已记录的文字回复。',
      '最近活动：' + time(task.lastActivityAt));
    if (task.jobs?.length) lines.push('后台任务：' + task.jobs.map(job => job.id + '（' + (jobLabels[job.status] ?? job.status) + '）').join('、'));
    lines.push('');
  }
  if (!result.tasks.length) lines.push('当前没有可展示的用户任务。');
  if (result.hiddenInternal || result.hiddenEmpty) lines.push('已省略 ' + (result.hiddenInternal ?? 0) + ' 个内部会话、' + (result.hiddenEmpty ?? 0) + ' 个空会话；只调整展示，原会话仍保留。');
  if (result.hasMore) lines.push('这里只列出前 10 项，优先显示执行中的任务；可提供编号查看指定任务。');
  lines.push('“本轮已结束”不代表整个需求已完成；回复摘录和清单来自 DSH 记录，最近活动时间不能单独证明任务卡住。');
  if (!result.detail && result.tasks.length) lines.push('可以说“查看 DSH 任务 <短编号>”获取详情。');
  return lines.filter(line => line !== null && line !== undefined).join('\n').trim();
}
