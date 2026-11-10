import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Tag } from '../../components/workbench-ui.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_PLAN_DEFAULTS, MOMENTS_PUBLISH_DEFAULTS, momentsPlanSettings } from '../../../shared/moments-publishing.mjs';
import { AudiencePicker, audiencePreview } from './audience-picker.jsx';

const labels = { generating: 'AI 生成中', draft: '待审核草稿', sending: '等待微信确认', published: '微信已确认发布', failed: '生成或验证失败',
  rejected: '未取得发布确认', unknown: '结果不明，未重发', skipped: '时段已过，已跳过', discarded: '已放弃' };
const times = plan => plan.schedule.type === 'once' ? plan.schedule.onceAt.replace('T', ' ') :
  (plan.schedule.type === 'weekly' ? '每周 ' + plan.schedule.weekdays.map(day => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、') : '每天') + ' ' + plan.schedule.times.join('、');
const fresh = () => structuredClone(MOMENTS_PLAN_DEFAULTS);

export function MomentsPublishingPage({ state, status, audience, audienceError, loadAudience }) {
  const data = state.data?.publishing, plans = data?.plans ?? [], runs = data?.runs ?? [];
  const [global, setGlobal] = useState({ ...MOMENTS_PUBLISH_DEFAULTS }), [globalDirty, setGlobalDirty] = useState(false);
  const [editor, setEditor] = useState(null), [themesText, setThemesText] = useState(''), [timesText, setTimesText] = useState(''), [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState(null), [runId, setRunId] = useState(null), [draftText, setDraftText] = useState(''), [image, setImage] = useState(null);
  const operation = useRef({}), selection = audiencePreview(audience, editor?.settings.blockedLabelIds ?? [], editor?.settings.blockedUserIds ?? []);
  const run = runs.find(row => row.id === runId), busy = state.busy || !!data?.running, online = status.online;
  useEffect(() => { if (data?.settings && !globalDirty) setGlobal(data.settings); }, [data, globalDirty]);
  const open = plan => { const settings = structuredClone(plan?.settings ?? fresh()); setEditor({ id: plan?.id, settings }); setThemesText(settings.themes.join('\n')); setTimesText(settings.schedule.times.join('\n')); setError(''); };
  const update = values => setEditor({ ...editor, settings: { ...editor.settings, ...values } });
  const schedule = values => update({ schedule: { ...editor.settings.schedule, ...values } });
  const picture = values => update({ image: { ...editor.settings.image, ...values } });
  const validated = () => {
    try { const settings = momentsPlanSettings({ ...editor.settings, themes: themesText.split('\n').map(text => text.trim()).filter(Boolean),
      schedule: { ...editor.settings.schedule, times: timesText.split(/[\n,，、 ]+/).filter(Boolean) } }); setError(''); return settings; }
    catch (error) { setError(error.message); return null; }
  };
  const execute = async (method, payload) => {
    const signature = JSON.stringify(payload), previous = operation.current[method];
    if (previous?.signature !== signature) operation.current[method] = { signature, requestId: 'ui-moments-' + crypto.randomUUID() };
    const result = await state.execute(method, { ...payload, requestId: operation.current[method].requestId });
    if (result) delete operation.current[method]; else await state.refresh();
    return result;
  };
  const showRun = async row => { setRunId(row.id); setDraftText(row.text ?? ''); setImage(null); if (row.hasImage) {
    const value = await state.execute('moments.drafts.image', { id: row.id }, false);
    if (value) setImage({ id: row.id, url: 'data:' + value.mediaType + ';base64,' + value.data });
  } };
  const imageSettings = status.imageGeneration, providers = imageSettings?.providers ?? [], selectedProvider = providers.find(row => row.id === (editor?.settings.image.providerId || imageSettings?.defaultProviderId));
  return <div className="wa-moments-publishing wa-section-stack" data-testid="moments-publishing">
    <div className="wa-wb-card">
      <div className="wa-wb-between"><h2>发布控制</h2><Tag state={data?.running ? 'running' : data?.settings.enabled ? 'ready' : 'disabled'}>{data?.running ? '正在处理' : data?.settings.enabled ? '已开启' : '已关闭'}</Tag></div>
      <p className="wa-wb-note">按主题由 AI 决定正文。总开关和计划都开启后才定时执行；全局自动回复暂停时也暂停发布。离线过期的时段跳过，结果不明时暂停对应计划。</p>
      {data?.error && <p role="alert" className="wa-alert is-error">{data.error}</p>}
      <label className="wa-wb-check"><input aria-label="开启朋友圈自动发布" type="checkbox" disabled={state.busy} checked={global.enabled} onChange={e => { setGlobal({ ...global, enabled: e.target.checked }); setGlobalDirty(true); }} />开启朋友圈自动发布</label>
      <div className="wa-wb-generator">
        {[["maxPostsPer24Hours", "24 小时最多自动发布", 1, 24], ["minGapMinutes", "自动发布最短间隔（分钟）", 0, 1440]].map(([key, label, min, max]) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} value={global[key]} onChange={e => { setGlobal({ ...global, [key]: Number(e.target.value) }); setGlobalDirty(true); }} /></label>)}
      </div>
      <div className="wa-form-actions"><span className={globalDirty ? 'wa-dirty' : 'wa-help'}>{globalDirty ? '有尚未保存的更改' : '更改在保存后生效。'}</span><div className="wa-wb-actions">
        <Button quiet disabled={state.busy || !globalDirty} onClick={() => { setGlobalDirty(false); setGlobal(data?.settings ?? { ...MOMENTS_PUBLISH_DEFAULTS }); }}>取消总设置更改</Button>
        <Button disabled={state.busy || !globalDirty || !online} onClick={async () => { if (await state.execute('moments.publishing.configure', { settings: global })) { setGlobalDirty(false); state.setNotice('自动发布总设置已保存。'); } }}>保存自动发布设置</Button></div></div>
    </div>
    <div className="wa-wb-card">
      <div className="wa-wb-between"><h2>发布计划</h2><Button disabled={busy || !online || plans.length >= 20} onClick={() => open()}>新增发布计划</Button></div>
      {plans.length ? plans.map(plan => <div className="wa-wb-summary-item wa-moments-plan" key={plan.id}>
        <div className="wa-wb-between"><strong>{plan.settings.name}</strong><Tag state={plan.settings.enabled ? 'ready' : 'disabled'}>{plan.settings.enabled ? '计划已开启' : '计划已暂停'}</Tag></div>
        <p>{plan.settings.themes.join('、')}</p><p className="wa-wb-note">{times(plan.settings)} · {plan.settings.schedule.timezone} · {plan.settings.reviewRequired ? '先生成草稿' : '直接发布'}{plan.settings.image.mode === 'ai' ? ' · AI 配图' : ' · 纯文字'}</p>
        <small>下一次：{plan.nextRunAt ? formatTime(plan.nextRunAt) : '未安排'}{!data?.settings.enabled && plan.settings.enabled ? '（总开关关闭）' : ''}</small>
        {plan.waitingReason && <p className="wa-wb-note">{plan.waitingReason}</p>}
        <div className="wa-wb-actions wa-moments-post-actions"><Button quiet disabled={busy || !online} onClick={() => open(plan)}>编辑计划</Button>
          <Button quiet disabled={state.busy || !online} onClick={() => state.execute('moments.plans.enable', { id: plan.id, enabled: !plan.settings.enabled })}>{plan.settings.enabled ? '暂停计划' : '开启计划'}</Button>
          <Button quiet danger disabled={state.busy || !online} onClick={() => setDeleteId(plan.id)}>删除计划</Button></div>
        {deleteId === plan.id && <div className="wa-wb-review" role="alert"><p>删除计划后停止定时执行，已有草稿与发布记录保留。</p><div className="wa-wb-actions"><Button danger disabled={state.busy} onClick={async () => { if (await state.execute('moments.plans.delete', { id: plan.id })) setDeleteId(null); }}>确认删除计划</Button><Button quiet onClick={() => setDeleteId(null)}>保留计划</Button></div></div>}
      </div>) : <Empty title="尚无发布计划">设置主题与时间，AI 会在到期时生成内容。</Empty>}
    </div>
    {editor && <div className="wa-wb-card wa-moments-plan-editor" data-testid="moments-plan-editor">
      <h2>{editor.id ? '编辑发布计划' : '新增发布计划'}</h2>
      <fieldset disabled={busy || !online}>
        <section className="wa-form-section"><h3>主题与文案</h3>
        <label>计划名称<input aria-label="发布计划名称" maxLength={80} value={editor.settings.name} onChange={e => update({ name: e.target.value })} /></label>
        <label>内容主题（每行一个）<textarea aria-label="发布主题" rows={3} maxLength={6030} value={themesText} onChange={e => setThemesText(e.target.value)} placeholder="日常心情\n小笑话\n科技见闻" /></label>
        <label>写作风格<input aria-label="发布写作风格" maxLength={1000} value={editor.settings.style} onChange={e => update({ style: e.target.value })} /></label>
        <label>内容要求<textarea aria-label="发布内容要求" maxLength={4000} rows={3} value={editor.settings.instructions} onChange={e => update({ instructions: e.target.value })} placeholder="比如：不要介绍功能，不虚构自己的真实经历。" /></label>
        <div className="wa-wb-generator"><label>正文最多字数<input aria-label="发布正文最多字数" type="number" min={30} max={2000} value={editor.settings.maxChars} onChange={e => update({ maxChars: Number(e.target.value) })} /></label>
          <label>发布方式<select aria-label="自动发布方式" value={editor.settings.reviewRequired ? 'review' : 'direct'} onChange={e => update({ reviewRequired: e.target.value === 'review' })}><option value="direct">按时直接发布</option><option value="review">先生成草稿，由我审核发布</option></select></label></div>
        </section>
        <section className="wa-form-section"><h3>发布节奏</h3>
        <div className="wa-wb-generator"><label>计划周期<select aria-label="发布计划周期" value={editor.settings.schedule.type} onChange={e => schedule({ type: e.target.value })}><option value="daily">每天</option><option value="weekly">每周</option><option value="once">仅一次</option></select></label>
          <label>时区<input aria-label="发布时区" value={editor.settings.schedule.timezone} maxLength={80} onChange={e => schedule({ timezone: e.target.value })} placeholder="Asia/Shanghai" /></label></div>
        {editor.settings.schedule.type === 'once' ? <label>单次发布时间<input aria-label="单次发布时间" type="datetime-local" value={editor.settings.schedule.onceAt} onChange={e => schedule({ onceAt: e.target.value })} /></label> : <label>每天的发布时间（每行一个 HH:mm，最多 8 个）<textarea aria-label="每天发布时间" rows={2} value={timesText} maxLength={48} onChange={e => setTimesText(e.target.value)} /></label>}
        {editor.settings.schedule.type === 'weekly' && <div className="wa-row wa-moments-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((label, index) => <label className="wa-wb-check" key={label}><input type="checkbox" aria-label={'发布星期' + label} checked={editor.settings.schedule.weekdays.includes(index + 1)} onChange={e => schedule({ weekdays: e.target.checked ? [...editor.settings.schedule.weekdays, index + 1] : editor.settings.schedule.weekdays.filter(day => day !== index + 1) })} />周{label}</label>)}</div>}
        <label>超过预定时间允许等待（分钟）<input aria-label="发布过期等待分钟" type="number" min={1} max={1440} value={editor.settings.graceMinutes} onChange={e => update({ graceMinutes: Number(e.target.value) })} /></label>
        <p className="wa-wb-note">按所选时区执行；应用须保持运行且微信在线。超过等待时间不补发，避免恢复连接后集中刷屏。</p>
        </section>
        <section className="wa-form-section"><h3>取材与配图</h3>
        <label className="wa-wb-check"><input aria-label="发布联网取材" type="checkbox" checked={editor.settings.research} onChange={e => update({ research: e.target.checked })} />生成前联网取材</label>
        {editor.settings.research && <label>公开搜索主题（可选）<input aria-label="发布搜索主题" maxLength={240} value={editor.settings.researchQuery} onChange={e => update({ researchQuery: e.target.value })} /><small>留空时按内容主题搜索；未取得有效来源时不发布。</small></label>}
        <label>配图<select aria-label="发布配图方式" value={editor.settings.image.mode} onChange={e => picture({ mode: e.target.value })}><option value="none">不配图，纯文字</option><option value="ai">由 AI 生成一张配图</option></select></label>
        {editor.settings.image.mode === 'ai' && <>
          <p className="wa-wb-note">使用已有生图设置；默认接口为 {providers.find(row => row.id === imageSettings?.defaultProviderId)?.name ?? '当前默认接口'}。图片失败时保留正文，不擅自换接口或降级为纯文字。</p>
          {!imageSettings?.enabled && <p className="wa-alert is-error">生图尚未启用，请先在模型设置中配置。</p>}
          <div className="wa-wb-generator"><label>生图接口<select aria-label="发布生图接口" value={editor.settings.image.providerId} onChange={e => picture({ providerId: e.target.value, model: '', size: '' })}><option value="">跟随默认接口</option>{providers.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
            <label>生图模型<select aria-label="发布生图模型" value={editor.settings.image.model} onChange={e => picture({ model: e.target.value })}><option value="">接口默认模型</option>{(selectedProvider?.models ?? []).map(model => <option key={model} value={model}>{model}</option>)}</select></label>
            <label>配图尺寸<input aria-label="发布配图尺寸" maxLength={40} placeholder={selectedProvider?.size ?? '跟随接口默认尺寸'} value={editor.settings.image.size} onChange={e => picture({ size: e.target.value })} /></label></div>
          <label>配图要求<textarea aria-label="发布配图要求" rows={2} maxLength={2000} value={editor.settings.image.instructions} onChange={e => picture({ instructions: e.target.value })} /></label>
        </>}
        </section>
        <AudiencePicker data={audience} error={audienceError} labelIds={editor.settings.blockedLabelIds} userIds={editor.settings.blockedUserIds} onChange={update} onRead={loadAudience} busy={busy} online={online} />
        <label className="wa-wb-check"><input aria-label="保存并开启发布计划" type="checkbox" checked={editor.settings.enabled} onChange={e => update({ enabled: e.target.checked })} />保存后开启此计划（仍受总开关控制）</label>
      </fieldset>
      {error && <p role="alert" className="wa-alert is-error">{error}</p>}
      <div className="wa-wb-actions"><Button disabled={busy || !online || selection.missing || audienceError && (editor.settings.blockedLabelIds.length + editor.settings.blockedUserIds.length > 0)} onClick={async () => {
        const settings = validated(); if (!settings) return;
        if (await execute('moments.plans.save', { settings, ...(editor.id ? { id: editor.id } : {}) })) { setEditor(null); state.setNotice('发布计划已保存，按总开关和计划开关执行。'); }
      }}>保存发布计划</Button><Button quiet disabled={busy || !online} onClick={async () => { const settings = validated(); if (!settings) return;
        const value = await execute('moments.plans.preview', { settings }); if (value) { await showRun(value); state.setNotice('预览已生成并保存为草稿，尚未发布。'); }
      }}>生成预览（不发布）</Button><Button quiet disabled={state.busy} onClick={() => { setEditor(null); setError(''); }}>关闭编辑</Button></div>
    </div>}
    <div className="wa-wb-card"><h2>草稿与发布记录</h2>
      <p className="wa-wb-note">展示最近 100 条记录。生成失败不会再次自动调用 AI；未知结果只核对已保存回执。文字和配图保留在本机。</p>
      {runs.length ? <div className="wa-wb-split"><div className="wa-wb-list">{runs.map(row => <button type="button" className={'wa-wb-list-item' + (runId === row.id ? ' is-selected' : '')} aria-current={runId === row.id ? 'true' : undefined} key={row.id} disabled={state.busy} onClick={() => showRun(row)}>
        <small>{formatTime(row.createdAt)} · {labels[row.state]}</small><strong>{row.settings.name}</strong><p>{row.text?.slice(0, 90) ?? row.error ?? '正在生成内容'}</p>
      </button>)}</div><div className="wa-moments-draft-detail">{run ? <>
        <Tag state={run.state}>{labels[run.state]}</Tag><p className="wa-wb-note">{run.theme ?? run.settings.themes.join('、')} · {run.origin === 'schedule' ? '定时计划' : '手动预览'}</p>
        {['draft', 'failed'].includes(run.state) ? <label>草稿正文<textarea aria-label="自动发布草稿正文" rows={7} maxLength={run.settings.maxChars} disabled={busy} value={draftText} onChange={e => setDraftText(e.target.value)} /></label> : <p style={{ whiteSpace: 'pre-wrap' }}>{run.text}</p>}
        {image?.id === run.id && <div className="wa-moments-photos"><img src={image.url} alt="本条朋友圈的 AI 配图" /></div>}
        {run.image && <p className="wa-wb-note">{run.image.providerName} · {run.image.model}</p>}
        {!!run.sources?.length && <details><summary>取材来源</summary>{run.sources.map(source => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></p>)}</details>}
        {run.error && <p role="alert" className="wa-alert is-error">{run.error}</p>}
        {run.postId && <p className="wa-wb-note">已确认动态编号：{run.postId}</p>}
        <div className="wa-wb-actions">
          {['draft', 'failed'].includes(run.state) && <><Button quiet disabled={busy || !online || !draftText.trim() || draftText === run.text} onClick={async () => { if (await state.execute('moments.drafts.edit', { id: run.id, text: draftText })) state.setNotice('草稿修改已保存，尚未发布。'); }}>保存草稿修改</Button>
            <Button disabled={busy || !online || !run.text || draftText !== run.text || run.settings.image.mode === 'ai' && !run.hasImage} onClick={async () => { if (await state.execute('moments.drafts.publish', { id: run.id })) state.setNotice('微信已确认发布这份草稿。'); else await state.refresh(); }}>发布这份草稿</Button>
            <Button quiet danger disabled={busy || !online} onClick={() => state.execute('moments.drafts.discard', { id: run.id })}>放弃这份草稿</Button></>}
          {run.state === 'unknown' && <Button quiet disabled={busy || !online} onClick={async () => { const value = await state.execute('moments.drafts.reconcile', { id: run.id }); if (value) state.setNotice(value.confirmed ? '已找到微信成功回执。' : '仍无成功回执，未重发；请在微信核对。'); }}>只核对发布回执</Button>}
        </div>
      </> : <Empty title="选择一条记录">查看正文、配图、取材来源和实际发布状态。</Empty>}</div></div> : <Empty title="尚无发布记录">可以先生成预览，或保存并开启一个发布计划。</Empty>}
    </div>
  </div>;
}
