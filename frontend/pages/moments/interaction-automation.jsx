import { useEffect, useState } from 'react';
import { Button, Tag } from '../../components/workbench-ui.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_INTERACTION_AUTOMATION_DEFAULTS as defaults, interactionAutomationSettings } from '../../../shared/moments-interaction-settings.mjs';

const finished = { completed: '已结束', partial: '部分完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' };
export function InteractionAutomation({ state, status }) {
  const saved = state.data.automation, [settings, setSettings] = useState({ ...defaults }), [base, setBase] = useState(null), [notice, setNotice] = useState('');
  const dirty = !!base && JSON.stringify(settings) !== JSON.stringify(base.settings), stale = !!saved && !!base && saved.revision !== base.revision;
  useEffect(() => {
    if (saved && (!base || saved.revision !== base.revision && !dirty)) { setSettings(saved.settings); setBase({ settings: saved.settings, revision: saved.revision }); }
  }, [saved?.revision, !!base, dirty]);
  const update = patch => { setSettings(current => ({ ...current, ...patch })); setNotice(''); };
  const quota = (key, value) => update({ [key]: value, poolSize: Math.max(settings.poolSize, Math.min(20, value + settings[key === 'likeCount' ? 'commentCount' : 'likeCount'])) });
  let invalid = ''; try { interactionAutomationSettings(settings); } catch (error) { invalid = error.message; }
  const save = async patch => {
    const result = await state.execute('configure', { settings: patch ?? settings, revision: patch ? saved.revision : base.revision });
    if (result) {
      setSettings(result.settings); setBase({ settings: result.settings, revision: result.revision });
      setNotice(result.settings.enabled ? '自动设置已保存，从下次检查时间开始运行。' : '自动互动已关闭，未完成的旧轮次会停止。');
    }
  };
  const last = saved?.lastRun, loading = !saved || !base, busy = !!state.busy, disabled = loading || busy;
  const inspectId = saved?.activeId || last?.runId;
  return <section className="wa-interaction-auto" aria-label="自动朋友圈互动设置" data-testid="moments-interaction-automation">
    <header className="wa-interaction-auto-heading"><div><span className="wa-interaction-eyebrow">自动互动</span><h3>按你的节奏，刷刷朋友圈</h3><p>定期读取真实好友动态，分别挑选要点赞和评论的内容。</p></div>
      <Tag state={saved?.running ? 'running' : saved?.settings.enabled && !saved.pausedReason ? 'completed' : 'draft'}>{loading ? '正在加载' : saved.running ? '本轮运行中' : saved.settings.enabled ? saved.pausedReason ? '已开启 · 等待恢复' : '已开启' : '未开启'}</Tag></header>
    <div className="wa-interaction-auto-grid"><div>
      <fieldset disabled={disabled}><legend className="wa-sr-only">自动互动频率与数量</legend>
        <label className="wa-wb-check wa-interaction-auto-toggle"><input type="checkbox" aria-label="启用自动朋友圈互动" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} /><span>启用自动互动<small>保存后生效，关闭页面仍会按时检查</small></span></label>
        <div className="wa-interaction-auto-fields">
          <label>每隔多久检查<input type="number" aria-label="自动检查间隔分钟" min={5} max={1440} value={settings.intervalMinutes} onChange={e => update({ intervalMinutes: Number(e.target.value) })} /><small>分钟，5–1440</small></label>
          <label>读取最近几天<input type="number" aria-label="自动读取最近天数" min={1} max={30} value={settings.lookbackDays} onChange={e => update({ lookbackDays: Number(e.target.value) })} /><small>天，1–30</small></label>
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
            <label>两条动态间隔（秒）<input type="number" aria-label="自动逐条间隔秒数" min={0} max={60} value={settings.intervalSeconds} onChange={e => update({ intervalSeconds: Number(e.target.value) })} /></label>
            <label>评论方式<select aria-label="自动互动评论方式" disabled={!settings.commentCount} value={settings.commentMode} onChange={e => update({ commentMode: e.target.value })}><option value="generated">按每条真实图文生成</option><option value="fixed">使用指定评论</option></select></label>
          </div>
          {settings.commentCount > 0 && (settings.commentMode === 'generated' ? <label>评论风格<textarea aria-label="自动评论风格" rows={3} maxLength={1000} value={settings.instructions} onChange={e => update({ instructions: e.target.value })} /></label> : <label>指定评论<textarea aria-label="自动指定评论" rows={3} maxLength={2000} value={settings.commentText} onChange={e => update({ commentText: e.target.value })} /></label>)}
          <p className="wa-wb-note">每轮最多互动 20 条不同动态；需要生成评论时先读图文，图片读取失败会跳过该条评论。纯点赞不读图，指定评论按原文发送。自动评论会直接提交。</p>
        </details>
      </fieldset>
      {stale && <p className="wa-alert" role="alert">自动设置已在其他入口修改，请载入最新设置后再编辑。<Button quiet disabled={busy} onClick={() => { setSettings(saved.settings); setBase({ settings: saved.settings, revision: saved.revision }); }}>载入最新自动设置</Button></p>}
      {dirty && invalid && <p role="alert" className="wa-alert is-error">{invalid}</p>}
      {(saved?.error || state.error) && <p role="alert" className="wa-alert is-error">{saved?.error || state.error}</p>}
      {notice && <p role="status" className="wa-wb-note">{notice}</p>}
      <div className="wa-wb-actions"><Button disabled={disabled || !!invalid || stale || !dirty} onClick={() => save()}>{state.busy === 'configure' ? '正在保存…' : '保存自动设置'}</Button>
        {saved?.settings.enabled && <Button quiet disabled={disabled} onClick={() => save({ enabled: false })}>关闭自动互动</Button>}
        {dirty && !stale && <span className="wa-wb-note">有尚未保存的设置</span>}</div>
    </div>
    <aside className="wa-interaction-auto-status" aria-label="自动互动运行状态">
      <div><span>当前计划</span><p>{saved?.settings.enabled ? `每 ${saved.settings.intervalMinutes} 分钟检查最近 ${saved.settings.lookbackDays} 天` : '保存并开启后开始计时'}</p>{saved?.settings.enabled && <small>每轮最多 {saved.settings.likeCount} 赞 / {saved.settings.commentCount} 评论</small>}</div>
      <div><span>下次检查</span><p data-testid="interaction-next-check">{saved?.running ? '本轮正在处理，结束后重新计时' : saved?.settings.enabled ? saved.pausedReason || formatTime(saved.nextRunAt) : '尚未安排'}</p><small>微信在线、自动回复总开关开启时执行；插件重启后重新计时。</small></div>
      <div><span>上轮结果{last ? ` · ${finished[last.state] ?? last.state}` : ''}</span>{last ? <><p>确认 {last.counts.liked} 赞 / {last.counts.commented} 评论</p><small>{formatTime(last.finishedAt)}<br />{last.message}</small>{last.counts.unknown > 0 && <p className="wa-alert">{last.counts.unknown} 项结果未确认，已保留记录且未重发。</p>}</> : <p>还没有自动执行记录</p>}</div>
      {saved?.running && <Button quiet disabled={busy} onClick={async () => { const result = await state.execute('stop', {}); if (result) setNotice('已请求停止本轮，后续计划保留；要持续停用请关闭自动互动。'); }}>停止本轮自动互动</Button>}
      {inspectId && <Button quiet disabled={busy} onClick={() => state.select(inspectId)}>查看自动互动记录</Button>}
      {!status.online && saved?.settings.enabled && <p className="wa-wb-note">当前微信未连接，暂不执行互动。</p>}
    </aside></div>
  </section>;
}
