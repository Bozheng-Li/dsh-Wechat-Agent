import { useEffect, useState } from 'react';
import { Button, Tag } from '../../components/workbench-ui.jsx';
import { MOMENTS_INTERACTION_AUTOMATION_DEFAULTS as defaults, interactionAutomationSettings } from '../../../shared/moments-interaction-settings.mjs';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';
import { useInteractions } from '../moments/use-interactions.mjs';
import { InteractionAutomationStatus } from '../moments/interaction-automation.jsx';

export function MomentsInteractionSettings({ rpc, status, blocked }) {
  const state = useInteractions(rpc, status.account?.id, status.timeSettings);
  return <InteractionAutomation state={state} status={status} blocked={blocked} />;
}

function InteractionAutomation({ state, status, blocked }) {
  const saved = state.data.automation, [settings, setSettings] = useState({ ...defaults }), [base, setBase] = useState(null), [notice, setNotice] = useState('');
  const dirty = !!base && JSON.stringify(settings) !== JSON.stringify(base.settings), stale = !!saved && !!base && saved.revision !== base.revision;
  useEffect(() => {
    if (saved && (!base || saved.revision !== base.revision && !dirty)) { setSettings(saved.settings); setBase({ settings: saved.settings, revision: saved.revision }); }
  }, [saved?.revision, !!base, dirty]);
  const update = patch => { setSettings(current => ({ ...current, ...patch })); setNotice(''); };
  const quota = (key, value) => update({ [key]: value, poolSize: Math.max(settings.poolSize, Math.min(20, value + settings[key === 'likeCount' ? 'commentCount' : 'likeCount'])) });
  let invalid = ''; try { interactionAutomationSettings(settings); } catch (error) { invalid = error.message; }
  const save = async patch => {
    const result = await state.execute('configure', { settings: patch ?? preserveTimeValues('interactions', settings, saved.settings), revision: patch ? saved.revision : base.revision, preserveTimeSettings: !patch });
    if (result) {
      setSettings(result.settings); setBase({ settings: result.settings, revision: result.revision });
      setNotice(result.settings.enabled ? '自动设置已保存，从下次检查时间开始运行。' : '自动互动已关闭，未完成的旧轮次会停止。');
    }
  };
  const loading = !saved || !base, busy = !!state.busy, disabled = loading || busy || blocked;
  return <section className="wa-interaction-auto" aria-label="自动朋友圈互动设置" data-testid="moments-interaction-automation">
    <header className="wa-interaction-auto-heading"><div><span className="wa-interaction-eyebrow">自动互动</span><h3>按你的节奏，刷刷朋友圈</h3><p>定期读取真实好友动态，分别挑选要点赞和评论的内容。</p></div>
      <Tag state={saved?.running ? 'running' : saved?.settings.enabled && !saved.pausedReason ? 'completed' : 'draft'}>{loading ? '正在加载' : saved.running ? '本轮运行中' : saved.settings.enabled ? saved.pausedReason ? '已开启 · 等待恢复' : '已开启' : '未开启'}</Tag></header>
    <div className="wa-interaction-auto-grid"><div>
      <p className="wa-wb-note">检查间隔、最近天数与逐条间隔统一在“设置 → 时间设置”中修改。</p>
      <fieldset disabled={disabled}><legend className="wa-sr-only">自动互动频率与数量</legend>
        <label className="wa-wb-check wa-interaction-auto-toggle"><input type="checkbox" role="switch" aria-label="启用自动朋友圈互动" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} /><span>启用自动互动<small>保存后生效，关闭页面仍会按时检查</small></span></label>
        <div className="wa-interaction-auto-fields">
          <label>每轮点赞几条<input type="number" aria-label="自动每轮点赞条数" min={0} max={20} value={settings.likeCount} onChange={e => quota('likeCount', Number(e.target.value))} /><small>0–20，0 表示不点赞</small></label>
          <label>每轮评论几条<input type="number" aria-label="自动每轮评论条数" min={0} max={20} value={settings.commentCount} onChange={e => quota('commentCount', Number(e.target.value))} /><small>0–20，0 表示不评论</small></label>
        </div>
        <div className="wa-interaction-auto-skips">
          <label className="wa-wb-check"><input type="checkbox" aria-label="自动跳过已点赞" checked={settings.skipLiked} onChange={e => update({ skipLiked: e.target.checked })} />点赞时跳过已赞动态</label>
          <label className="wa-wb-check"><input type="checkbox" aria-label="自动跳过已评论" checked={settings.skipCommented} onChange={e => update({ skipCommented: e.target.checked })} />评论时跳过已评动态</label>
        </div>
        <p className="wa-wb-note">分别按点赞、评论筛选，再选够本轮额度；没有足够的新内容就少做。已赞不会取消或重复点赞。</p>
        <div className="wa-interaction-fields">
          <label>挑选方式<select aria-label="自动互动挑选方式" value={settings.mode} onChange={e => update({ mode: e.target.value })}><option value="latest">优先最近的动态</option><option value="random">在候选里随机挑选</option></select></label>
          <label>动态来源<select aria-label="自动互动动态来源" value={settings.source} onChange={e => update({ source: e.target.value })}><option value="timeline">当前账号看到的好友动态</option><option value="user">指定一位好友</option></select></label>
        </div>
        {settings.source === 'user' && <label>指定好友<input aria-label="自动互动指定好友" maxLength={150} value={settings.user} onChange={e => update({ user: e.target.value })} placeholder="准确昵称、备注或微信 ID" /><small>开启时核实联系人并保存为 ID。</small></label>}
        <details className="wa-interaction-auto-details"><summary>评论方式与更多设置</summary>
          <div className="wa-interaction-fields">
            <label>每轮候选上限<input type="number" aria-label="自动候选动态数" min={Math.max(1, Math.min(20, settings.likeCount + settings.commentCount))} max={100} value={settings.poolSize} onChange={e => update({ poolSize: Number(e.target.value) })} /></label>
            <label>每位好友每轮最多<input type="number" aria-label="自动每位好友上限" min={1} max={20} disabled={settings.source === 'user'} value={settings.perFriendLimit} onChange={e => update({ perFriendLimit: Number(e.target.value) })} /></label>
            <label>评论方式<select aria-label="自动互动评论方式" disabled={!settings.commentCount} value={settings.commentMode} onChange={e => update({ commentMode: e.target.value })}><option value="generated">按每条真实图文生成</option><option value="fixed">使用指定评论</option></select></label>
          </div>
          {settings.commentCount > 0 && (settings.commentMode === 'generated' ? <label>评论风格<textarea aria-label="自动评论风格" rows={3} maxLength={1000} value={settings.instructions} onChange={e => update({ instructions: e.target.value })} /></label> : <label>指定评论<textarea aria-label="自动指定评论" rows={3} maxLength={2000} value={settings.commentText} onChange={e => update({ commentText: e.target.value })} /></label>)}
          <p className="wa-wb-note">每轮最多互动 20 条不同动态；评论使用读到的图片，未读到图片时按正文回复，图文都不可用时跳过评论并保留点赞。未读到的图片会记录原因。纯点赞不读图，指定评论按原文发送。自动评论会直接提交。</p>
        </details>
      </fieldset>
      {stale && <p className="wa-alert" role="alert">自动设置已在其他入口修改，请载入最新设置后再编辑。<Button quiet disabled={busy} onClick={() => { setSettings(saved.settings); setBase({ settings: saved.settings, revision: saved.revision }); }}>载入最新自动设置</Button></p>}
      {dirty && invalid && <p role="alert" className="wa-alert is-error">{invalid}</p>}
      {(saved?.error || state.error) && <p role="alert" className="wa-alert is-error">{saved?.error || state.error}</p>}
      {state.refreshError && <p role="alert" className="wa-alert is-error">{state.refreshError}<Button quiet disabled={busy || blocked} onClick={() => state.refresh()}>重新读取自动设置</Button></p>}
      {notice && <p role="status" className="wa-wb-note">{notice}</p>}
      <div className="wa-wb-actions"><Button disabled={disabled || !!invalid || stale || !dirty} onClick={() => save()}>{state.busy === 'configure' ? '正在保存…' : '保存自动设置'}</Button>
        {saved?.settings.enabled && <Button quiet disabled={disabled} onClick={() => save({ enabled: false })}>关闭自动互动</Button>}
        {dirty && !stale && <span className="wa-wb-note">有尚未保存的设置</span>}</div>
    </div>
    <InteractionAutomationStatus state={state} status={status} /></div>
  </section>;
}
