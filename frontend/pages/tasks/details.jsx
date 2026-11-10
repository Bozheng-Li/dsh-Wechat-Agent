import { date } from "../../shared/peers.mjs";

export const taskStates = {
  pending: '等待执行',
  running: '正在执行',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
  sent: '微信已确认',
  failed: '失败',
  unknown: '结果不明',
  partial: '部分已确认',
  queued: '等待处理',
  settling: '等待最终结果',
};

export function localDateInput(ms) {
  const time = new Date(ms);
  return new Date(ms - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function scheduleLabel(schedule) {
  return schedule.kind === 'once'
    ? '一次性'
    : schedule.kind === 'daily'
      ? '每天 ' + schedule.time + '（北京时间）'
      : '每 ' + schedule.minutes + ' 分钟';
}

export function TaskBadge({ state }) {
  return <span className={'wa-task-badge is-' + state}>{taskStates[state] || state}</span>;
}

export function TaskDetails({ task, runs = [] }) {
  return (
    <div className="wa-task-detail-content">
      <p className="wa-task-content">{task.content}</p>
      <div className="wa-task-facts">
        <span>
          {task.kind === 'agent' ? 'Agent 任务' : '发送消息'} · {scheduleLabel(task.schedule)}
        </span>
        <span>{task.source === 'chat' ? task.senderName + ' 在聊天中创建' : '管理员创建'}</span>
        {task.targets?.length > 0 && (
          <span>提醒对象：{task.targets.map((target) => '@' + target.name).join('、')}</span>
        )}
        <span>创建时间：{date(task.createdAt)}</span>
        <span>
          {task.state === 'pending' ? '下次计划' : '计划时间'}：{date(task.nextRunAt)}
        </span>
        {task.state === 'cancelled' && <span>状态更新：{date(task.updatedAt)}</span>}
      </div>
      {task.lastError && <p className="wa-task-warning">{task.lastError}</p>}
      {runs.length > 0 && (
        <div className="wa-task-executions">
          <h3>最近执行记录</h3>
          {runs.map((run) => (
            <div className="wa-task-execution" key={run.id}>
              <div className="wa-row">
                <TaskBadge state={run.state} />
                <span>{run.finishedAt ? '结束时间：' + date(run.finishedAt) : '开始时间：' + date(run.startedAt)}</span>
              </div>
              <p className="wa-help">
                本次计划：{date(run.scheduledAt)}
                {run.acknowledgedMessageIds?.length ? ` · 微信确认 ${run.acknowledgedMessageIds.length} 条` : ''}
              </p>
              {run.reason && <p className="wa-task-warning">{run.reason}</p>}
              {run.acknowledgedMessageIds?.length > 0 && (
                <p className="wa-help wa-task-receipts">回执：{run.acknowledgedMessageIds.join('、')}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
