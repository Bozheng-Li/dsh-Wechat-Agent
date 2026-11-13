import { useEffect, useRef, useState } from 'react';
import { TRACE_STATES, TRACE_ACTIVE, traceDuration, traceTypeLabel } from '../../../shared/execution-traces.mjs';
import { TracePayload } from './payload.jsx';
import { ExecutionGraph } from './graph.jsx';
import { TraceInspector } from './inspector.jsx';
import { Button } from '../../components/button.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { traceHasWork, traceQuietNote, traceZeroWork } from './trace-rows.mjs';

export const traceTime = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
export function TraceBadge({ state }) { return <span className="wa-trace-badge" data-state={state}>{TRACE_STATES[state] || state}</span>; }
export function TraceQuietNote({ trace }) { return <p className="wa-trace-quiet-note">{traceQuietNote(trace)}</p>; }

export function TraceDetail({ rpc, accountId, traceId, onSelect, onBack, focused, onFocus }) {
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const [data, setData] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [pages, setPages] = useState(1), [tab, setTab] = useState(''), [selectedStep, setSelectedStep] = useState(null);
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('');
  const latest = useRef(null), detail = useRef(null), exportController = useRef(null);
  useEffect(() => () => exportController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    const read = async () => {
      if (pending) return; pending = true;
      try {
        const first = await rpcRef.current('traces.get', { accountId, traceId, limit: 100 }, controller.signal);
        const steps = [...first.steps];
        for (let offset = 100; offset < Math.min(pages * 100, first.total); offset += 100) {
          const page = await rpcRef.current('traces.get', { accountId, traceId, offset, limit: 100 }, controller.signal);
          steps.push(...page.steps);
        }
        if (!controller.signal.aborted) { latest.current = first; setData({ ...first, steps }); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
      finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => { if (TRACE_ACTIVE.has(latest.current?.trace.state) || latest.current?.trace.pendingSave) void read(); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [accountId, traceId, pages, refresh]);
  async function exportTrace() {
    setExporting(true); setExportError('');
    const controller = new AbortController(); exportController.current = controller;
    try {
      const value = await rpcRef.current('traces.export', { accountId, traceId }, AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(value.data, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = value.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!controller.signal.aborted) setExportError(failure.message); }
    finally { if (!controller.signal.aborted) setExporting(false); }
  }
  const showTab = id => { setTab(id); setSelectedStep(null); };
  const closeInspector = () => {
    const id = selectedStep; setSelectedStep(null);
    requestAnimationFrame(() => detail.current?.querySelector('[data-step-id="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true }));
  };
  if (!data) return <section className="wa-trace-detail" aria-label="执行轨迹详情">
    <button type="button" className="wa-trace-text-button" onClick={onBack}>返回任务列表</button>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>重试读取</button></p> : <p role="status">正在读取执行轨迹…</p>}
  </section>;
  const { trace } = data, step = data.steps.find(item => item.id === selectedStep);
  // A trace that never called the model or a tool does not deserve a canvas.
  const quiet = !traceHasWork(trace, data.steps), zeroWork = traceZeroWork(trace), activeTab = tab || (quiet ? 'content' : 'graph');
  const tabs = [['graph', '执行关系图'], ['content', '任务输入与结果'], ['configuration', '本次配置']];
  const payload = (reference, inline, title) => <TracePayload rpc={rpc} accountId={accountId} traceId={traceId} reference={reference} inline={inline} title={title} />;
  return <section className="wa-trace-detail" aria-label="执行轨迹详情" data-testid="trace-detail" data-state={trace.state} data-quiet={quiet || undefined} ref={detail}>
    <header className="wa-trace-detail-header">
      <div className="wa-trace-detail-actions">
        <button type="button" className="wa-trace-text-button" onClick={onBack}><Glyph name="back" size={13} />返回任务列表</button>
        {!quiet && <div><button type="button" className="wa-trace-text-button wa-trace-focus-button" onClick={onFocus} aria-pressed={focused}><Glyph name="grid" size={14} />{focused ? '收起画布' : '展开画布'}</button>
          <Button disabled={exporting} onClick={exportTrace}>{exporting ? '正在导出…' : '导出本次轨迹'}</Button></div>}
      </div>
      <div className="wa-trace-eyebrow"><span className="wa-trace-category-tag">{traceTypeLabel(trace.type)}</span><span>·</span>{traceTime(trace.createdAt)}</div>
      <h2 title={trace.title}>{trace.title}</h2>
      <div className="wa-trace-detail-summary"><TraceBadge state={trace.state} /><span><Glyph name="clock" size={12} />{traceDuration(trace.startedAt ? (trace.finishedAt || Date.now()) - trace.startedAt : null)}</span>
        {zeroWork ? <span>未调用模型与工具</span>
          : <><span>{trace.modelCalls || 0} 次模型</span><span>{trace.toolCalls || 0} 次工具</span></>}</div>
      <div className="wa-trace-alerts">
        {trace.coverage === 'historical' && <p className="wa-trace-note">{trace.note}</p>}
        {trace.coverage === 'partial' && <p className="wa-trace-warning">此任务在轨迹记录接入前已开始，仅展示接入后观察到的步骤和配置。</p>}
        {trace.pendingSave && <p className="wa-trace-note" role="status">最新步骤正在保存，当前可直接查看已有记录。</p>}
        {trace.incomplete && <p className="wa-trace-warning">这次轨迹有未完整保存的步骤，不能据此判断缺失步骤是否成功。{trace.note}</p>}
        {trace.limited && <p className="wa-trace-note">个别详情达到记录上限，已标明省略位置。</p>}
        {error && <p role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></p>}
        {exportError && <p role="alert">{exportError}</p>}
      </div>
    </header>
    <div className="wa-trace-detail-tabs" role="tablist" aria-label="轨迹详情分类" onKeyDown={event => {
      const ids = tabs.map(row => row[0]);
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const id = event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(ids.indexOf(activeTab) + (event.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      showTab(id); document.getElementById('trace-detail-tab-' + id)?.focus();
    }}>
      {tabs.map(([id, title]) =>
        <button type="button" role="tab" key={id} id={'trace-detail-tab-' + id} aria-controls={'trace-detail-panel-' + id}
          aria-selected={activeTab === id} tabIndex={activeTab === id ? 0 : -1} onClick={() => showTab(id)}>{title}</button>)}
    </div>
    <div className={'wa-trace-detail-panel' + (activeTab === 'graph' && !quiet ? ' is-graph' : '')} role="tabpanel" id={'trace-detail-panel-' + activeTab} aria-labelledby={'trace-detail-tab-' + activeTab}>
      {activeTab === 'content' ? <>
        {(trace.actor || trace.peerId) && <p className="wa-trace-context">{trace.actor && <span>发起人：{trace.actor}</span>}{trace.peerId && <span>会话：{trace.peerId}</span>}</p>}
        {trace.parentTraceId && <button type="button" className="wa-trace-text-button" onClick={() => onSelect(trace.parentTraceId)}>查看来源任务</button>}
        {payload(trace.input, trace.inputValue, '任务输入')}{payload(trace.output, trace.outputValue, '执行结果')}
      </> : activeTab === 'configuration' ? <>{payload(trace.configuration, undefined, '本次执行配置')}
        {!trace.configuration && <p className="wa-trace-note">这条历史记录没有保存当时的配置。</p>}
        {trace.historicalMetrics && payload(undefined, trace.historicalMetrics, '已有模型调用统计')}</>
        : quiet ? <TraceQuietNote trace={trace} />
        : <>
          <div className="wa-trace-graph-frame">
            <ExecutionGraph trace={trace} steps={data.steps} selectedStep={selectedStep} onStep={value => setSelectedStep(value?.id || null)} onTask={() => showTab('content')} onResult={() => showTab('content')} />
            {step && <TraceInspector rpc={rpc} accountId={accountId} traceId={traceId} step={step} steps={data.steps} onSelect={onSelect} onClose={closeInspector} />}
          </div>
          <div className="wa-trace-loaded"><span>{trace.coverage === 'historical' ? '历史摘要 · 当时未记录逐步执行过程' : '已载入 ' + data.steps.length + ' / ' + data.total + ' 个步骤'}</span>
            {data.steps.length < data.total && <button type="button" className="wa-trace-text-button" onClick={() => setPages(value => value + 1)}>继续加载步骤</button>}</div>
        </>}
    </div>
  </section>;
}
