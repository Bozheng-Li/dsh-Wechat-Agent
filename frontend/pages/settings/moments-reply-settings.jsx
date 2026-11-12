import { useEffect, useState } from 'react';
import { Button, Feedback } from '../../components/workbench-ui.jsx';
import { FormActions } from '../../components/form-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_DEFAULTS, momentsSettings } from '../../../shared/moments.mjs';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';

export function MomentsReplySettings({ rpc, status, blocked }) {
  const state = useWorkbench(rpc, status.account?.id, 'moments.list', '', 3000, status.timeSettings);
  const [settings, setSettings] = useState(() => structuredClone(MOMENTS_DEFAULTS)), [dirty, setDirty] = useState(false);
  const data = state.data, posts = data?.posts ?? [], busy = !!state.busy || blocked || !data;
  useEffect(() => { if (data?.settings && !dirty) setSettings(data.settings); }, [data?.settings, dirty]);
  const update = patch => { setSettings(current => ({ ...current, ...patch })); setDirty(true); state.setNotice(''); };
  let invalid = ''; try { momentsSettings(settings); } catch (failure) { invalid = failure.message; }
  const quota = (field, label) => <label>{label}<input aria-label={label} type="number" min={1} max={50} value={settings[field]}
    onChange={event => update({ [field]: Number(event.target.value) })} /><small>每轮 1–50 条，生成失败也计入尝试次数。</small></label>;
  return <form className="wa-moments-schedule" aria-label="定时抓取与回复" data-testid="moments-reply-settings" onSubmit={async event => {
    event.preventDefault(); if (busy || !dirty || invalid) return;
    if (await state.execute('moments.configure', { settings: preserveTimeValues('replies', settings, data.settings), preserveTimeSettings: true })) {
      setDirty(false); state.setNotice('朋友圈定时设置已保存。');
    }
  }}>
    <Feedback state={state} cancellable={false} />
    {state.error && <Button quiet disabled={!!state.busy || blocked} onClick={state.refresh}>重新读取回复设置</Button>}
    <p className="wa-wb-note">两类评论共用抓取节奏，分别控制开关和数量。微信在线且自动回复总开关开启时运行。</p>
    <fieldset disabled={busy} className="wa-moments-reply-fields"><legend className="wa-sr-only">自动回复设置</legend>
      <div className="wa-moments-reply-modes">
        <section className="wa-moments-reply-mode" aria-label="自己朋友圈回复设置">
          <label className="wa-wb-check"><input type="checkbox" role="switch" aria-label="回复自己朋友圈里的评论" checked={settings.enabled}
            onChange={event => update({ enabled: event.target.checked })} /><span><strong>回复自己朋友圈里的评论</strong><small>别人评论我的动态 → 我回复。</small></span></label>
          {quota('maxRepliesPerRun', '自己朋友圈每轮最多尝试回复')}
          <label>自己动态的处理范围<select aria-label="定时回复范围" value={settings.scope} onChange={event => update({ scope: event.target.value })}>
            <option value="own">当前账号自己的全部动态</option><option value="selected">仅手动选中的本人动态</option></select></label>
          {settings.scope === 'selected' && <div className="wa-moments-reply-selection">
            {posts.some(post => !post.deleted) ? posts.filter(post => !post.deleted).map(post => <label className="wa-wb-check" key={post.id}>
              <input type="checkbox" checked={settings.selectedPostIds.includes(post.id)} onChange={event => update({ selectedPostIds: event.target.checked
                ? [...settings.selectedPostIds, post.id] : settings.selectedPostIds.filter(id => id !== post.id) })} />
              <span>{formatTime(post.createdAt * 1000)} · {post.text.slice(0, 50) || '图片动态'}</span></label>)
              : <p className="wa-wb-note">先在朋友圈的“我的动态”拉取内容，再选择要回复的动态。</p>}
            <p className="wa-wb-note">此选择只影响自己的动态。</p>
          </div>}
        </section>
        <section className="wa-moments-reply-mode" aria-label="好友朋友圈接续回复设置">
          <label className="wa-wb-check"><input type="checkbox" role="switch" aria-label="自动接续好友朋友圈对话" checked={settings.friendRepliesEnabled}
            onChange={event => update({ friendRepliesEnabled: event.target.checked })} /><span><strong>自动接续好友朋友圈对话</strong><small>我评论好友动态 → 对方回复我 → 我继续回复。</small></span></label>
          {quota('maxFriendRepliesPerRun', '好友对话每轮最多尝试回复')}
          <p className="wa-wb-note">对方再次回复也会继续接话；只处理明确回复当前账号的评论，话题结束时可不再回复。</p>
          <p className="wa-wb-note">结合原动态图文与前文生成回复。有配图时先读取图片，读取失败则跳过本次生成。</p>
        </section>
      </div>
      <section className="wa-form-section"><h3>回复范围与要求</h3>
        <p className="wa-wb-note">抓取间隔与处理最近天数统一在“时间设置”中修改。</p>
        <label className="wa-wb-check"><input type="checkbox" checked={settings.includeExisting}
          onChange={event => update({ includeExisting: event.target.checked })} />也回复开启前已存在、尚未回复的评论</label>
        <p className="wa-wb-note">默认从各自开关开启后的新评论开始。已回复内容自动跳过，结果不明时不重复提交。</p>
        <label>回复风格与要求<textarea aria-label="定时评论回复要求" maxLength={2000} rows={3} value={settings.replyInstructions}
          onChange={event => update({ replyInstructions: event.target.value })} /></label>
      </section>
    </fieldset>
    {dirty && invalid && <p role="alert" className="wa-alert is-error">{invalid}</p>}
    <FormActions dirty={dirty} busy={state.busy} disabled={busy} invalid={!!invalid} label="保存定时设置"
      onReset={() => { setDirty(false); setSettings(data.settings); state.setNotice(''); }} />
  </form>;
}
