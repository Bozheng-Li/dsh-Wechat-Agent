import { Button, Tag } from '../../components/workbench-ui.jsx';
import { CleanupControl } from '../../components/cleanup-control.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_DEFAULTS, momentsReplyEnabled, momentsSettings } from '../../../shared/moments.mjs';

const replyLabels = { sent: '微信已确认', existing: '已有回复', sending: '提交中', unknown: '结果不明，未重发', rejected: '已拒绝，未重发',
  failed: '未完成，尚未提交', generating: '生成中', draft: '草稿', skipped: '已跳过' };
const runLabels = { completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已停止' };

export function MomentsReplySchedule({ state, status, posts, settings, update, dirty, reset, saved }) {
  const data = state.data, enabled = momentsReplyEnabled(data?.settings ?? MOMENTS_DEFAULTS), last = data?.lastRun;
  const busy = !!state.busy || !data;
  let invalid = ''; try { momentsSettings(settings); } catch (error) { invalid = error.message; }
  const quota = (field, label) => <label>{label}<input aria-label={label} type="number" min={1} max={50} value={settings[field]}
    onChange={e => update({ [field]: Number(e.target.value) })} /><small>每轮 1–50 条，生成失败也计入尝试次数。</small></label>;
  return <>
    <section className="wa-moments-schedule wa-automation-editor" aria-label="定时抓取与回复" data-testid="moments-reply-schedule">
      <div className="wa-wb-between"><h2>定时抓取与回复</h2><Tag state={data?.running ? 'running' : enabled ? 'ready' : 'disabled'}>
        {!data ? '正在加载' : data.running ? '正在处理' : enabled ? '已开启' : '已关闭'}</Tag></div>
      <p className="wa-wb-note">选择要接住的两类评论，共用抓取节奏，分别控制开关和数量。</p>
      <fieldset disabled={busy} className="wa-moments-reply-fields"><legend className="wa-sr-only">自动回复设置</legend>
        <div className="wa-moments-reply-modes">
          <section className="wa-moments-reply-mode" aria-label="自己朋友圈回复设置">
            <label className="wa-wb-check"><input type="checkbox" aria-label="回复自己朋友圈里的评论" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />
              <span><strong>回复自己朋友圈里的评论</strong><small>别人评论我的动态 → 我回复。</small></span></label>
            {quota('maxRepliesPerRun', '自己朋友圈每轮最多尝试回复')}
            <label>自己动态的处理范围<select aria-label="定时回复范围" value={settings.scope} onChange={e => update({ scope: e.target.value })}>
              <option value="own">当前账号自己的全部动态</option><option value="selected">仅手动选中的本人动态</option></select></label>
            {settings.scope === 'selected' && <div className="wa-moments-reply-selection">
              {posts.some(post => !post.deleted) ? posts.filter(post => !post.deleted).map(post => <label className="wa-wb-check" key={post.id}>
                <input type="checkbox" checked={settings.selectedPostIds.includes(post.id)} onChange={e => update({ selectedPostIds: e.target.checked ? [...settings.selectedPostIds, post.id] : settings.selectedPostIds.filter(id => id !== post.id) })} />
                <span>{formatTime(post.createdAt * 1000)} · {post.text.slice(0, 50) || '图片动态'}</span></label>)
                : <p className="wa-wb-note">先在“我的动态”拉取内容，再选择要回复的动态。</p>}
              <p className="wa-wb-note">此选择只影响自己的动态。</p>
            </div>}
          </section>
          <section className="wa-moments-reply-mode" aria-label="好友朋友圈接续回复设置">
            <label className="wa-wb-check"><input type="checkbox" aria-label="自动接续好友朋友圈对话" checked={settings.friendRepliesEnabled} onChange={e => update({ friendRepliesEnabled: e.target.checked })} />
              <span><strong>自动接续好友朋友圈对话</strong><small>我评论好友动态 → 对方回复我 → 我继续回复。</small></span></label>
            {quota('maxFriendRepliesPerRun', '好友对话每轮最多尝试回复')}
            <p className="wa-wb-note">对方再次回复也会继续接话；只处理明确回复当前账号的评论，话题结束时可不再回复。</p>
            <p className="wa-wb-note">结合原动态图文与前文生成回复。有配图时先读取图片，读取失败则跳过本次生成。</p>
          </section>
        </div>
        <section className="wa-form-section"><h3>共用抓取节奏</h3><div className="wa-wb-generator">
          {[["intervalMinutes", "抓取间隔（分钟）", 1440], ["lookbackDays", "处理近几天动态", 365]].map(([field, label, max]) => <label key={field}>{label}
            <input aria-label={label} type="number" min={1} max={max} value={settings[field]} onChange={e => update({ [field]: Number(e.target.value) })} /></label>)}
        </div>
          <label className="wa-wb-check"><input type="checkbox" checked={settings.includeExisting} onChange={e => update({ includeExisting: e.target.checked })} />也回复开启前已存在、尚未回复的评论</label>
          <p className="wa-wb-note">默认从各自开关开启后的新评论开始。已回复内容自动跳过，结果不明时不重复提交。</p>
          <label>回复风格与要求<textarea aria-label="定时评论回复要求" maxLength={2000} rows={3} value={settings.replyInstructions} onChange={e => update({ replyInstructions: e.target.value })} /></label>
        </section>
      </fieldset>
      <section className="wa-form-section wa-moments-reply-status" aria-label="定时回复运行状态"><h3>运行状态</h3>
        <p>下一次：{data?.running ? '本轮正在处理' : data?.nextRunAt ? formatTime(data.nextRunAt) : '未安排'}</p>
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
      {dirty && invalid && <p role="alert" className="wa-alert is-error">{invalid}</p>}
      <div className="wa-form-actions"><span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : '更改在保存后生效。'}</span><div className="wa-wb-actions">
        <Button quiet disabled={busy || !dirty} onClick={reset}>取消更改</Button>
        <Button disabled={busy || !dirty || !!invalid} onClick={async () => {
          if (await state.execute('moments.configure', { settings })) { saved(); state.setNotice('朋友圈定时设置已保存。'); }
        }}>保存定时设置</Button>
      </div></div>
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
      </div>) : <p className="wa-wb-note">尚无记录。两类自动回复默认关闭，保存开启后按周期处理。</p>}
    </section>
  </>;
}
