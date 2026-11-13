import { CleanupControl } from '../../components/cleanup-control.jsx';
import { AutomationLink } from '../../components/automation-link.jsx';
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Tag } from '../../components/workbench-ui.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_PLAN_DEFAULTS, momentsPlanSettings, momentsLocalInstant } from '../../../shared/moments-publishing.mjs';
import { AudiencePicker, audiencePreview } from './audience-picker.jsx';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

const labels = { generating: 'AI 生成中', draft: '待审核草稿', sending: '等待微信确认', published: '微信已确认发布', failed: '生成或验证失败',
  rejected: '未取得发布确认', unknown: '结果不明，未重发', 'published-unverified': '已发布，屏蔽范围待核实', deleted: '已确认删除', skipped: '本次已跳过', discarded: '已放弃' };
const stages = { research: '正在查找公开资料', text: '正在生成正文', reviewing: '正在检查内容是否适合公开', 'content-review': '正在检查正文与配图方案', image: '正在生成配图', 'image-review': '正在核对实际配图', 'text-review': '正在准备纯文字内容', sending: '正在等待微信确认' };
const times = plan => plan.schedule.type === 'once' ? plan.schedule.onceAt.replace('T', ' ') :
  (plan.schedule.type === 'weekly' ? '每周 ' + plan.schedule.weekdays.map(day => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、') : '每天') + ' ' + plan.schedule.times.join('、');
const fresh = () => ({ ...structuredClone(MOMENTS_PLAN_DEFAULTS), themes: [], useMaterials: true,
  image: { ...MOMENTS_PLAN_DEFAULTS.image, mode: 'library' } });

export function MomentsPublishingPage({ rpc, state, status, audience, audienceError, loadAudience, onNavigate, defaultAudience, onEditAudience }) {
  const data = state.data?.publishing, plans = data?.plans ?? [], runs = data?.runs ?? [];
  const [selectedRuns, setSelectedRuns] = useState([]), [stopping, setStopping] = useState(false), [stopError, setStopError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [editor, setEditor] = useState(null), [themesText, setThemesText] = useState(''), [timesText, setTimesText] = useState(''), [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState(null), [runId, setRunId] = useState(null), [draftText, setDraftText] = useState(''), [image, setImage] = useState(null);
  const [now, setNow] = useState(Date.now), loadedDraft = useRef({ id: null, text: '' });
  const editorRef = useRef(null);
  const operation = useRef({}), selection = audiencePreview(audience, editor?.settings.blockedLabelIds ?? [], editor?.settings.blockedUserIds ?? []);
  const defaults = defaultAudience ?? { blockedLabelIds: [], blockedUserIds: [] }, defaultCount = defaults.blockedLabelIds.length + defaults.blockedUserIds.length;
  const run = runs.find(row => row.id === runId), busy = state.busy || !!data?.running, online = status.online;
  const activeRun = runs.find(row => ['generating', 'sending'].includes(row.state));
  const elapsed = Math.max(0, Math.floor((now - (data?.operationStartedAt || now)) / 1000));
  const ended = plan => plan.settings.schedule.type === 'once' && !plan.nextRunAt && momentsLocalInstant(plan.settings.schedule.onceAt, plan.settings.schedule.timezone) <= Date.now();
  const visiblePlans = plans.filter(plan => showHistory || !plan.automatic || !ended(plan));
  useEffect(() => {
    if (!data?.running) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [data?.running, data?.operationStartedAt]);
  useEffect(() => {
    if (!run) return;
    const previous = loadedDraft.current; loadedDraft.current = { id: run.id, text: run.text ?? '' };
    setDraftText(value => previous.id !== run.id || value === previous.text ? run.text ?? '' : value);
  }, [run?.id, run?.text]);
  useEffect(() => {
    if (!editor) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      editorRef.current?.querySelector('input')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [!!editor, editor?.id]);
  const open = plan => { const settings = structuredClone(plan?.settings ?? fresh()); setEditor({ id: plan?.id, automatic: plan?.automatic, settings }); setThemesText(settings.themes.join('\n')); setTimesText(settings.schedule.times.join('\n')); setError(''); };
  const update = values => setEditor({ ...editor, settings: { ...editor.settings, ...values } });
  const schedule = values => update({ schedule: { ...editor.settings.schedule, ...values } });
  const picture = values => update({ image: { ...editor.settings.image, ...values } });
  const validated = () => {
    try { const settings = momentsPlanSettings({ ...preserveTimeValues('plan', editor.settings, plans.find(plan => plan.id === editor.id)?.settings ?? { graceMinutes: data?.settings.automatic.content.graceMinutes ?? MOMENTS_PLAN_DEFAULTS.graceMinutes }), themes: themesText.split('\n').map(text => text.trim()).filter(Boolean),
      schedule: { ...editor.settings.schedule, times: timesText.split(/[\n,，、 ]+/).filter(Boolean) } }); setError(''); return settings; }
    catch (error) { setError(error.message); return null; }
  };
  const execute = async (method, payload) => {
    const signature = JSON.stringify(payload), previous = operation.current[method];
    const retryable = method === 'moments.plans.preview' && runs.some(row => row.requestId === previous?.requestId && ['failed', 'discarded'].includes(row.state));
    if (previous?.signature !== signature || retryable) operation.current[method] = { signature, requestId: 'ui-moments-' + crypto.randomUUID() };
    const result = await state.execute(method, { ...payload, requestId: operation.current[method].requestId, ...(method === 'moments.plans.save' ? { preserveTimeSettings: true } : {}) });
    if (result) delete operation.current[method]; else await state.refresh(true);
    return result;
  };
  const showRun = async row => { loadedDraft.current = { id: row.id, text: row.text ?? '' }; setRunId(row.id); setDraftText(row.text ?? ''); setImage(null); if (row.hasImage) {
    const value = await state.execute('moments.drafts.image', { id: row.id }, false);
    if (value) setImage({ id: row.id, url: 'data:' + value.mediaType + ';base64,' + value.data });
  } };
  const generatePreview = async settings => {
    const value = await execute('moments.plans.preview', { settings });
    if (value) { await showRun(value); state.setNotice(value.state === 'draft'
      ? '预览已生成并保存为草稿，尚未发布。' : '已读取原预览记录：' + (labels[value.state] || '请核对状态') + '。'); }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true); setStopError('');
    try {
      await rpc('moments.publishing.cancel', { accountId: status.account.id }, AbortSignal.timeout(10000));
      state.setNotice('已停止本次处理，后续计划保留；已提交的发布请核对微信回执。');
      await state.refresh(true);
    } catch (error) { setStopError(error.message); }
    finally { setStopping(false); }
  };
  const imageSettings = status.imageGeneration, providers = imageSettings?.providers ?? [], selectedProvider = providers.find(row => row.id === (editor?.settings.image.providerId || imageSettings?.defaultProviderId));
  return <div className="wa-moments-publishing wa-section-stack" data-testid="moments-publishing">
    <section className="wa-moments-global">
      <div className="wa-wb-between"><h2>发布控制</h2><Tag state={data?.running ? 'running' : data?.settings.enabled ? 'ready' : 'disabled'}>{data?.running ? '正在处理' : data?.settings.enabled ? '已开启' : '已关闭'}</Tag></div>
      <p className="wa-wb-note">主题可留空，由 AI 结合人设与可用素材选择内容。总开关和计划都开启后才执行；没有合适内容可以跳过，发布结果不明时暂停计划。</p>
      {data?.error && <p role="alert" className="wa-alert is-error">{data.error}</p>}
      {state.refreshError && <p role="alert" className="wa-alert is-error">{state.refreshError}</p>}
      {data?.running && <div className="wa-wb-between"><p className="wa-wb-note" role="status">{stages[activeRun?.stage] || labels[activeRun?.state] || '正在处理'} · 已等待 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒，达到设定超时后停止。</p><Button quiet disabled={stopping} onClick={stop}>停止本次发布处理</Button></div>}
      <p className="wa-wb-note">生图失败会改发纯文字；联网取材失败会改写不依赖实时资料的内容。</p>
      {stopError && <p className="wa-alert is-error" role="alert">{stopError}</p>}
      <div className="wa-wb-actions">
        <AutomationLink onNavigate={onNavigate} from="moments" section="moments-publishing">自动发布设置</AutomationLink>
        <Button quiet disabled={!onEditAudience} onClick={onEditAudience}>屏蔽名单设置</Button>
      </div>
      <p className="wa-wb-note">屏蔽谁在这里设置，自动发布勾选『使用默认屏蔽名单』时按它执行。</p>
      <p className="wa-wb-note">发布总开关和自动安排统一在“设置 → 自动功能”中修改。</p>
    </section>
    <section className="wa-moments-plan-list">
      <header className="wa-section-heading"><div><h2>发布计划<span className="wa-section-count">{visiblePlans.length}</span></h2><p className="wa-wb-note">自动生成和手动添加的计划都可以修改。手动计划最多 20 个，自动安排另计。</p></div><Button aria-expanded={!!editor} aria-controls="wa-moments-plan-editor" disabled={busy || !online || plans.filter(plan => !plan.automatic).length >= 20 || !!editor} onClick={() => open()}>新增发布计划</Button></header>
      <label className="wa-wb-check"><input type="checkbox" aria-label="显示已结束的自动计划" checked={showHistory} onChange={e => setShowHistory(e.target.checked)} />显示已结束的自动计划（最近 100 个）</label>
      {visiblePlans.length ? visiblePlans.map(plan => <article className="wa-moments-plan" key={plan.id} data-plan-id={plan.id}>
        <div className="wa-moments-plan-copy">
        <div className="wa-wb-between"><strong>{plan.settings.name}</strong><Tag state={plan.settings.enabled && !ended(plan) ? 'ready' : 'disabled'}>{ended(plan) ? '本次已结束' : plan.settings.enabled ? '计划已开启' : '计划已暂停'}</Tag><span className="wa-help">{plan.automatic ? '自动生成' + (plan.automatic.edited ? ' · 已手动调整' : '') : '手动添加'}</span></div>
        <p>{plan.settings.themes.join('、') || '到时间自主选题'}</p><p className="wa-wb-note">{times(plan.settings)} · {plan.settings.schedule.timezone} · {plan.settings.reviewRequired ? '先生成草稿' : '直接发布'}{plan.settings.image.mode === 'ai' ? ' · AI 配图' : plan.settings.image.mode === 'library' ? ' · 素材库选图' : ' · 纯文字'}{plan.settings.useDefaultAudience ? ' · 使用默认屏蔽名单' : ''}</p>
        <small className="wa-schedule-time"><span>下一次：{plan.nextRunAt ? formatTime(plan.nextRunAt) : '未安排'}{!data?.settings.enabled && plan.settings.enabled ? '（总开关关闭）' : plan.automatic && !data?.settings.automatic.enabled ? '（自动安排已关闭）' : ''}</span>
          {!ended(plan) && <ScheduleCountdown at={plan.nextRunAt} enabled={plan.settings.enabled} running={data?.running && data.activePlanId === plan.id}
            paused={!data?.settings.enabled || plan.automatic && !data?.settings.automatic.enabled || data?.error || data?.schedulerStarted === false}
            status={status} action={plan.settings.reviewRequired ? '生成草稿' : '发布'} />}</small>
        {plan.waitingReason && <p className="wa-wb-note">{plan.waitingReason}</p>}
        </div>
        <div className="wa-wb-actions wa-moments-post-actions"><Button quiet disabled={busy || !online} onClick={() => open(plan)}>编辑计划</Button>
          <Button quiet disabled={state.busy || !online} onClick={() => state.execute('moments.plans.enable', { id: plan.id, enabled: !plan.settings.enabled })}>{plan.settings.enabled ? '暂停计划' : '开启计划'}</Button>
          <Button quiet danger disabled={state.busy || !online} onClick={() => setDeleteId(plan.id)}>删除计划</Button></div>
        {deleteId === plan.id && <div className="wa-wb-review" role="alert"><p>删除计划后停止定时执行，已有草稿与发布记录保留。</p><div className="wa-wb-actions"><Button danger disabled={state.busy} onClick={async () => { if (await state.execute('moments.plans.delete', { id: plan.id })) setDeleteId(null); }}>确认删除计划</Button><Button quiet onClick={() => setDeleteId(null)}>保留计划</Button></div></div>}
      </article>) : !editor && <Empty title="尚无待执行计划">在“设置 → 自动功能”中开启自动安排，或在这里手动新增发布计划。主题可以留空。</Empty>}
    </section>
    {editor && <div className="wa-automation-editor wa-moments-plan-editor" id="wa-moments-plan-editor" ref={editorRef} data-testid="moments-plan-editor">
      <header className="wa-editor-heading"><h2>{editor.id ? '编辑发布计划' : '新增发布计划'}</h2><p>文案、节奏和可见范围保存后生效。</p></header>
      <fieldset disabled={busy || !online}>
        <section className="wa-form-section"><h3>主题与文案</h3>
        <label>计划名称<input aria-label="发布计划名称" maxLength={80} value={editor.settings.name} onChange={e => update({ name: e.target.value })} /></label>
        <label>内容方向（可留空，每行一个）<textarea aria-label="发布主题" rows={3} maxLength={6030} value={themesText} onChange={e => setThemesText(e.target.value)} placeholder="留空时自主选题，也可以写最近想关注的方向。" /></label>
        <label className="wa-wb-check"><input aria-label="使用朋友圈素材库" type="checkbox" checked={!!editor.settings.useMaterials} onChange={e => update({ useMaterials: e.target.checked })} />结合朋友圈素材库里的内容与想法</label>
        <p className="wa-wb-note">在“素材库”里添加文字和图片，在“设置 → 自动功能”中设置聊天整理范围。这里只使用已保存的素材。</p>
        <label>写作风格<input aria-label="发布写作风格" maxLength={1000} value={editor.settings.style} onChange={e => update({ style: e.target.value })} /></label>
        <label>内容要求<textarea aria-label="发布内容要求" maxLength={4000} rows={3} value={editor.settings.instructions} onChange={e => update({ instructions: e.target.value })} placeholder="比如：不要介绍功能，不虚构自己的真实经历。" /></label>
        <div className="wa-wb-generator"><label>正文最多字数<input aria-label="发布正文最多字数" type="number" min={30} max={2000} value={editor.settings.maxChars} onChange={e => update({ maxChars: Number(e.target.value) })} /><small>仅限制上限；按内容自然选择长短，几个字、一句话或几段都可以。</small></label>
          <label>发布方式<select aria-label="自动发布方式" value={editor.settings.reviewRequired ? 'review' : 'direct'} onChange={e => update({ reviewRequired: e.target.value === 'review' })}><option value="direct">按时直接发布</option><option value="review">先生成草稿，由我审核发布</option></select></label></div>
        </section>
        <section className="wa-form-section"><h3>发布节奏</h3>
        <div className="wa-wb-generator"><label>计划周期<select aria-label="发布计划周期" disabled={!!editor.automatic} value={editor.settings.schedule.type} onChange={e => schedule({ type: e.target.value })}><option value="daily">每天</option><option value="weekly">每周</option><option value="once">仅一次</option></select>{editor.automatic && <small>此次修改只影响这一个自动时段；循环计划可手动新增。</small>}</label>
          <label>时区<input aria-label="发布时区" value={editor.settings.schedule.timezone} maxLength={80} onChange={e => schedule({ timezone: e.target.value })} placeholder="Asia/Shanghai" /></label></div>
        {editor.settings.schedule.type === 'once' ? <label>单次发布时间<input aria-label="单次发布时间" type="datetime-local" value={editor.settings.schedule.onceAt} onChange={e => schedule({ onceAt: e.target.value })} /></label> : <label>每天的发布时间（每行一个 HH:mm，最多 8 个）<textarea aria-label="每天发布时间" rows={2} value={timesText} maxLength={48} onChange={e => setTimesText(e.target.value)} /></label>}
        {editor.settings.schedule.type === 'weekly' && <div className="wa-row wa-moments-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((label, index) => <label className="wa-wb-check" key={label}><input type="checkbox" aria-label={'发布星期' + label} checked={editor.settings.schedule.weekdays.includes(index + 1)} onChange={e => schedule({ weekdays: e.target.checked ? [...editor.settings.schedule.weekdays, index + 1] : editor.settings.schedule.weekdays.filter(day => day !== index + 1) })} />周{label}</label>)}</div>}
        <p className="wa-wb-note">允许延迟发布的时限统一在“设置 → 时间设置”中修改。按所选时区执行；应用须保持运行且微信在线。超过等待时间不补发，避免恢复连接后集中刷屏。</p>
        </section>
        <section className="wa-form-section"><h3>取材与配图</h3>
        <label className="wa-wb-check"><input aria-label="发布联网取材" type="checkbox" checked={editor.settings.research} onChange={e => update({ research: e.target.checked })} />生成前联网取材</label>
        {editor.settings.research && <label>公开搜索主题（可选）<input aria-label="发布搜索主题" maxLength={240} value={editor.settings.researchQuery} onChange={e => update({ researchQuery: e.target.value })} /><small>留空时按内容主题搜索；取材失败会改写不依赖实时资料的纯文字。</small></label>}
        <label>配图<select aria-label="发布配图方式" value={editor.settings.image.mode} onChange={e => picture({ mode: e.target.value })}><option value="none">不配图，纯文字</option><option value="library">从素材库选图，合适时配图</option><option value="ai">由 AI 生成一张配图</option></select></label>
        {editor.settings.image.mode === 'ai' && <>
          <p className="wa-wb-note">使用已有生图设置；默认接口为 {providers.find(row => row.id === imageSettings?.defaultProviderId)?.name ?? '当前默认接口'}。图片失败会保留正文改用纯文字，不重复生图。</p>
          {!imageSettings?.enabled && <p className="wa-wb-note">生图尚未启用，本次将使用纯文字；需要配图时可在模型设置中配置。</p>}
          <div className="wa-wb-generator"><label>生图接口<select aria-label="发布生图接口" value={editor.settings.image.providerId} onChange={e => picture({ providerId: e.target.value, model: '', size: '' })}><option value="">跟随默认接口</option>{providers.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
            <label>生图模型<select aria-label="发布生图模型" value={editor.settings.image.model} onChange={e => picture({ model: e.target.value })}><option value="">接口默认模型</option>{(selectedProvider?.models ?? []).map(model => <option key={model} value={model}>{model}</option>)}</select></label>
            <label>配图尺寸<input aria-label="发布配图尺寸" maxLength={40} placeholder={selectedProvider?.size ?? '跟随接口默认尺寸'} value={editor.settings.image.size} onChange={e => picture({ size: e.target.value })} /></label></div>
          <label>配图要求<textarea aria-label="发布配图要求" rows={2} maxLength={2000} value={editor.settings.image.instructions} onChange={e => picture({ instructions: e.target.value })} /></label>
        </>}
        </section>
        <label className="wa-wb-check"><input aria-label="使用默认屏蔽名单" type="checkbox" checked={!!editor.settings.useDefaultAudience}
          onChange={e => update({ useDefaultAudience: e.target.checked })} />使用默认屏蔽名单（在发朋友圈页维护）</label>
        {editor.settings.useDefaultAudience
          ? <p className="wa-wb-note">当前默认名单：{defaults.blockedLabelIds.length} 个标签、{defaults.blockedUserIds.length} 位联系人。{defaultCount ? '' : '名单为空，发布时不会额外屏蔽任何人。'}在“朋友圈 → 发朋友圈”里勾选后保存为默认名单。</p>
          : <AudiencePicker data={audience} error={audienceError} labelIds={editor.settings.blockedLabelIds} userIds={editor.settings.blockedUserIds} onChange={update} onRead={loadAudience} busy={busy} online={online} />}
        <label className="wa-wb-check"><input aria-label="保存并开启发布计划" type="checkbox" checked={editor.settings.enabled} onChange={e => update({ enabled: e.target.checked })} />保存后开启此计划（仍受总开关控制）</label>
      </fieldset>
      {error && <p role="alert" className="wa-alert is-error">{error}</p>}
      <div className="wa-wb-actions wa-editor-actions"><Button disabled={busy || !online || !editor.settings.useDefaultAudience &&
        (selection.missing || audienceError && (editor.settings.blockedLabelIds.length + editor.settings.blockedUserIds.length > 0))} onClick={async () => {
        const settings = validated(); if (!settings) return;
        if (await execute('moments.plans.save', { settings, ...(editor.id ? { id: editor.id } : {}) })) { setEditor(null); state.setNotice('发布计划已保存，按总开关和计划开关执行。'); }
      }}>保存发布计划</Button><Button quiet disabled={busy || !online} onClick={async () => { const settings = validated(); if (!settings) return;
        await generatePreview(settings);
      }}>生成预览（不发布）</Button><Button quiet disabled={state.busy} onClick={() => { setEditor(null); setError(''); }}>关闭编辑</Button></div>
    </div>}
    <section className="wa-moments-records"><header className="wa-section-heading"><h2>草稿与发布记录<span className="wa-section-count">{runs.length}</span></h2><CleanupControl key={status.account?.id} state={state} kind="moments.publishing" label="清空发布记录" onDone={() => setSelectedRuns([])} /></header>
      {!!selectedRuns.length && <CleanupControl state={state} kind="moments.publishing" ids={selectedRuns} label={`删除选中 ${selectedRuns.length} 条`} onDone={() => setSelectedRuns([])} />}
      <p className="wa-wb-note">展示最近 100 条记录。生成失败不会再次自动调用 AI；状态核对会读取微信动态和已保存回执，不会重新发布。文字和配图保留在本机。</p>
      {runs.length ? <div className="wa-wb-split"><div className="wa-wb-list">{runs.map(row => <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', alignItems: 'center', gap: 8 }}><input type="checkbox" aria-label={`选择发布记录 ${row.settings.name}`} checked={selectedRuns.includes(row.id)} onChange={event => setSelectedRuns(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} /><button type="button" className={'wa-wb-list-item' + (runId === row.id ? ' is-selected' : '')} aria-current={runId === row.id ? 'true' : undefined} key={row.id} disabled={state.busy} onClick={() => showRun(row)}>
        <small>{formatTime(row.createdAt)} · {labels[row.state]}</small><strong>{row.settings.name}</strong><p>{row.text?.slice(0, 90) ?? row.error ?? '正在生成内容'}</p>
      </button></div>)}</div><div className="wa-moments-draft-detail">{run ? <>
        <Tag state={run.state === 'published-unverified' ? 'unknown' : run.state === 'deleted' ? 'disabled' : run.state}>{labels[run.state]}</Tag><CleanupControl state={state} kind="moments.publishing" ids={[run.id]} label="删除这条记录" onDone={() => { setRunId(null); setImage(null); setSelectedRuns(ids => ids.filter(id => id !== run.id)); }} /><p className="wa-wb-note">{run.theme ?? run.settings.themes.join('、')} · {run.origin === 'schedule' ? '定时计划' : '手动预览'}</p>
        {['draft', 'failed'].includes(run.state) ? <label>草稿正文<textarea aria-label="自动发布草稿正文" rows={7} maxLength={run.settings.maxChars} disabled={busy} value={draftText} onChange={e => setDraftText(e.target.value)} /></label> : <p style={{ whiteSpace: 'pre-wrap' }}>{run.text}</p>}
        {image?.id === run.id && <div className="wa-moments-photos"><img src={image.url} alt="本条朋友圈的配图" /></div>}
        {run.image && <p className="wa-wb-note">{run.image.providerName} · {run.image.model}</p>}
        {!!run.sources?.length && <details><summary>取材来源</summary>{run.sources.map(source => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></p>)}</details>}
        {run.error && <p role="alert" className="wa-alert is-error">{run.error}</p>}
        {run.fallbacks?.map(item => <p key={item.kind} className="wa-wb-note">{item.message}</p>)}
        {!!run.selectedMaterials?.length && <p className="wa-wb-note">选用素材：{run.selectedMaterials.map(item => item.title).join('、')}</p>}
        {run.materialsWarning && <p className="wa-alert is-error">{run.materialsWarning}</p>}
        {run.audienceWarning && <p className="wa-wb-note">{run.audienceWarning}</p>}
        {run.postId && <p className="wa-wb-note">已确认动态编号：{run.postId}</p>}
        <div className="wa-wb-actions">
          {['draft', 'failed'].includes(run.state) && <><Button quiet disabled={busy || !online || !draftText.trim() || draftText === run.text} onClick={async () => { if (await state.execute('moments.drafts.edit', { id: run.id, text: draftText })) { setDraftText(draftText.trim()); state.setNotice('草稿修改已保存，尚未发布。'); } }}>保存草稿修改</Button>
            <Button disabled={busy || !online || !run.text || draftText !== run.text} onClick={async () => { if (await state.execute('moments.drafts.publish', { id: run.id })) state.setNotice('微信已确认发布这份草稿。'); else await state.refresh(true); }}>{run.textOnly || run.settings.image.mode === 'ai' && !run.hasImage ? '按纯文字发布' : '发布这份草稿'}</Button>
            <Button quiet danger disabled={busy || !online} onClick={() => state.execute('moments.drafts.discard', { id: run.id })}>放弃这份草稿</Button></>}
          {['draft', 'failed', 'discarded'].includes(run.state) && <Button quiet disabled={busy || !online} onClick={() => generatePreview(run.settings)}>重新生成预览（不发布）</Button>}
          {['unknown', 'published-unverified'].includes(run.state) && <Button quiet disabled={busy || !online} onClick={async () => { const value = await state.execute('moments.drafts.reconcile', { id: run.id }); if (value) state.setNotice(value.message || (value.confirmed ? '已完成微信回执核对。' : '当前状态仍未确认，原记录已保留。')); }}>核对微信发布状态</Button>}
        </div>
      </> : <Empty title="选择一条记录">查看正文、配图、取材来源和实际发布状态。</Empty>}</div></div> : <Empty title="尚无发布记录">可以先生成预览，或保存并开启一个发布计划。</Empty>}
    </section>
  </div>;
}
