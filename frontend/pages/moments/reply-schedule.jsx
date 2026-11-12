import { Tag } from '../../components/workbench-ui.jsx';
import { AutomationLink } from '../../components/automation-link.jsx';
import { CleanupControl } from '../../components/cleanup-control.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_DEFAULTS, momentsReplyEnabled } from '../../../shared/moments.mjs';
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

const replyLabels = { sent: '微信已确认', existing: '已有回复', sending: '提交中', unknown: '结果不明，未重发', rejected: '已拒绝，未重发',
  failed: '未完成，尚未提交', generating: '生成中', draft: '草稿', skipped: '已跳过' };
const runLabels = { completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已停止' };

export function MomentsReplySchedule({ state, status, onNavigate }) {
  const data = state.data, enabled = momentsReplyEnabled(data?.settings ?? MOMENTS_DEFAULTS), last = data?.lastRun;
  return <>
    <section className="wa-moments-schedule" aria-label="定时回复状态" data-testid="moments-reply-schedule">
      <div className="wa-wb-between"><h2>定时抓取与回复</h2><Tag state={data?.running ? 'running' : enabled ? 'ready' : 'disabled'}>
        {!data ? '正在加载' : data.running ? '正在处理' : enabled ? '已开启' : '已关闭'}</Tag></div>
      <div className="wa-wb-between"><p className="wa-wb-note">评论回复的开关、范围和要求统一在“设置 → 自动功能”中修改。</p>
        <AutomationLink onNavigate={onNavigate} from="moments" section="moments-replies" /></div>
      <section className="wa-form-section wa-moments-reply-status" aria-label="定时回复运行状态"><h3>运行状态</h3>
        <p className="wa-schedule-time"><span>下一次：{data?.running ? '本轮正在处理' : data?.nextRunAt ? formatTime(data.nextRunAt) : '未安排'}</span>
          {data && <ScheduleCountdown at={data.nextRunAt} enabled={enabled} running={data.running}
            paused={data.error || data.schedulerStarted === false} status={status} action="检查" />}</p>
        <p className="wa-wb-note">保存后按周期执行；微信在线且自动回复总开关开启时运行，关闭页面仍然有效。</p>
        {last && <><p>上轮：{runLabels[last.state] ?? last.state} · {formatTime(last.finishedAt)}</p>
          {last.ownEnabled !== false && <p>我的动态：扫描 {last.scanned} 条，尝试 {last.attempted ?? 0} 条，微信确认 {last.replied} 条。</p>}
          {last.friend && <><p>好友对话：扫描 {last.friend.scanned} 条，尝试 {last.friend.attempted} 条，微信确认 {last.friend.replied} 条，跳过 {last.friend.skipped} 条。</p>
            {(last.friend.failed > 0 || last.friend.unknown > 0 || last.friend.readFailed > 0) && <p className="wa-alert">未完成 {last.friend.failed} 条，结果不明 {last.friend.unknown} 条，读取失败 {last.friend.readFailed} 次。{last.friend.lastError}</p>}
          </>}
        </>}
        {!!last?.unavailable && <p className="wa-wb-note" data-testid="moments-unavailable-posts">已跳过 {last.unavailable} 条暂不可读动态，其他评论继续检查。{data.settings?.enabled ? '稍后会自动重查，' : '开启自动检查后会重查，'}也可在“我的动态”中手动读取。</p>}
        {data?.lastError && <p className="wa-alert is-error">{data.lastError}</p>}
      </section>
    </section>
    <section className="wa-moments-replies"><header className="wa-index-heading"><h2>评论回复记录</h2><span>{(data?.replies ?? []).length}</span></header>
      <CleanupControl key={status.account?.id} state={state} kind="moments.replies" label="清空回复记录" />
      {(data?.replies ?? []).length ? data.replies.map(row => <div className="wa-wb-summary-item wa-moments-reply-record" key={row.postId + ':' + row.commentId}>
        <div className="wa-wb-between"><strong>{row.origin === 'friend' ? '好友对话 · ' : ''}{row.author || `评论 #${row.commentId}`}</strong><Tag state={row.state}>{replyLabels[row.state] ?? row.state}</Tag></div>
        {row.origin === 'friend' && <><p><small>{row.postNickname || row.postAuthorId} 的动态</small><br />{row.postText || '图片动态'}</p><p><small>我之前说</small><br />{row.ourComment?.text}</p></>}
        <p><small>{row.origin === 'friend' ? '对方回复我' : '对方评论'}</small><br />{row.commentText}</p>
        {row.text && <p><small>{['sent', 'existing'].includes(row.state) ? '我的回复' : '待发送内容'}</small><br />{row.text}</p>}
        {row.error && <p className="wa-wb-note">{row.error}</p>}<small>{formatTime(row.updatedAt)} · 动态 {row.postId}</small>
        <CleanupControl state={state} kind="moments.replies" ids={[row.postId + ':' + row.commentId]} label="删除回复记录" />
      </div>) : <p className="wa-wb-note">尚无记录。可在“设置 → 自动功能”开启评论回复，之后按周期处理。</p>}
    </section>
  </>;
}
