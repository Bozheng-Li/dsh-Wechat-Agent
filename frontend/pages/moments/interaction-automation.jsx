import { useState } from 'react';
import { Button, Tag } from '../../components/workbench-ui.jsx';
import { AutomationLink } from '../../components/automation-link.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

const finished = { completed: '已结束', partial: '部分完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' };

export function InteractionAutomationStatus({ state, status, onNavigate }) {
  const saved = state.data.automation, last = saved?.lastRun, busy = !!state.busy;
  const [notice, setNotice] = useState('');
  const inspectId = saved?.activeId || last?.runId;
  return <section className="wa-interaction-auto-status" aria-label="自动互动运行状态" data-testid="moments-interaction-status">
    <div className="wa-wb-between"><h3>自动互动</h3><Tag state={saved?.running ? 'running' : saved?.settings.enabled ? 'ready' : 'disabled'}>
      {!saved ? '正在加载' : saved.running ? '本轮运行中' : saved.settings.enabled ? '已开启' : '已关闭'}</Tag></div>
    {onNavigate && <AutomationLink onNavigate={onNavigate} from="moments" section="moments-interactions" />}
    <div><span>当前计划</span><p>{saved?.settings.enabled ? `每 ${saved.settings.intervalMinutes} 分钟检查最近 ${saved.settings.lookbackDays} 天` : '在“设置 → 自动功能”中开启'}</p>
      {saved?.settings.enabled && <small>每轮最多 {saved.settings.likeCount} 赞 / {saved.settings.commentCount} 评论</small>}</div>
    <div><span>下次检查</span><p data-testid="interaction-next-check">{saved?.running ? '本轮正在处理，结束后重新计时' : saved?.settings.enabled ? saved.pausedReason || formatTime(saved.nextRunAt) : '尚未安排'}</p>
      {saved && <ScheduleCountdown at={saved.nextRunAt} enabled={saved.settings.enabled} running={saved.running} paused={saved.pausedReason} status={status} action="检查" />}
      <small>微信在线、自动回复总开关开启时执行；插件重启后重新计时。</small></div>
    <div><span>上轮结果{last ? ` · ${finished[last.state] ?? last.state}` : ''}</span>{last ? <><p>确认 {last.counts.liked} 赞 / {last.counts.commented} 评论</p>
      <small>{formatTime(last.finishedAt)}<br />{last.message}</small>{last.counts.unknown > 0 && <p className="wa-alert">{last.counts.unknown} 项结果未确认，已保留记录且未重发。</p>}</> : <p>还没有自动执行记录</p>}</div>
    {saved?.error && <p role="alert" className="wa-alert is-error">{saved.error}</p>}
    {notice && <p role="status" className="wa-wb-note">{notice}</p>}
    {saved?.running && <Button quiet disabled={busy} onClick={async () => {
      if (await state.execute('stop', {})) setNotice('已请求停止本轮，后续计划保留；持续停用可在“设置 → 自动功能”中关闭自动互动。');
    }}>停止本轮自动互动</Button>}
    {onNavigate && inspectId && <Button quiet disabled={busy} onClick={() => state.select(inspectId)}>查看自动互动记录</Button>}
    {!status.online && saved?.settings.enabled && <p className="wa-wb-note">当前微信未连接，暂不执行互动。</p>}
  </section>;
}
