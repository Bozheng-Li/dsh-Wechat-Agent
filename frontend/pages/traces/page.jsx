import { useEffect, useRef, useState } from 'react';
import { TRACE_TYPES, TRACE_STATES, traceDuration, traceTypeLabel } from '../../../shared/execution-traces.mjs';
import { PageHead } from '../../components/page-ui.jsx';
import { WorkspaceTabs, WorkspacePanels } from '../../components/workspace-tabs.jsx';
import { Button } from '../../components/button.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { TraceDetail, traceTime } from './detail.jsx';
import { TraceNetworkMark } from './graph-node.jsx';
import { traceActivity, traceElapsed, traceListModel, traceRelativeTime,
  traceSecondary, traceStateLabel, traceZeroWork } from './trace-rows.mjs';

const dateInput = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const categoryIcons = { all: 'grid', conversation: 'chat', work: 'work', scheduled: 'clock', moments: 'moments', memory: 'memory', media: 'image', digest: 'digest', maintenance: 'shield' };
const pageSize = 30;

/** One list row: task type + what happened, then the message preview. */
export function TraceRow({ row, selected, now, onSelect }) {
  const zero = traceZeroWork(row), elapsed = traceElapsed(row);
  // A no-op row that spent no measurable time shows a dash instead of “0 毫秒”.
  const duration = zero && !(elapsed >= 1000) ? '—' : traceDuration(elapsed);
  return <button type="button" className={'wa-trace-list-item' + (selected ? ' is-selected' : '')} data-zero={zero || undefined}
    data-trace-id={row.id} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(row.id)}>
    <span className="wa-trace-row-head">
      <span className="wa-trace-row-lead"><span className="wa-trace-row-type">{traceTypeLabel(row.type)}</span>
        <span className="wa-trace-row-sep" aria-hidden="true">·</span><strong>{traceActivity(row)}</strong></span>
      <span className="wa-trace-row-side"><b title={duration === '—' ? '没有执行模型或工具' : '本次执行耗时'}>{duration}</b>
        <i className="wa-trace-state-dot" data-state={row.state || 'unknown'} title={traceStateLabel(row.state)} />
        <span className="wa-sr-only">{'状态：' + traceStateLabel(row.state)}</span></span>
    </span>
    <span className="wa-trace-row-sub"><span className="wa-trace-row-preview">{traceSecondary(row) || '没有摘要'}</span>
      <span className="wa-trace-row-when" title={traceTime(row.createdAt)}>{traceRelativeTime(row.createdAt, now)}</span></span>
  </button>;
}

/** Collapsed background (media / memory / maintenance) rows on the 全部任务 tab. */
export function TraceGroupRow({ rows, open, onToggle }) {
  const counts = [];
  for (const row of rows) { const entry = counts.find(item => item.type === row.type); if (entry) entry.count += 1; else counts.push({ type: row.type, count: 1 }); }
  const summary = counts.sort((a, b) => b.count - a.count).slice(0, 3).map(item => traceTypeLabel(item.type) + ' ' + item.count).join(' · ');
  return <button type="button" className="wa-trace-list-item wa-trace-group-row" data-group="background" aria-expanded={open} onClick={onToggle}>
    <span className="wa-trace-row-head"><span className="wa-trace-row-lead"><strong>后台任务</strong>
      <span className="wa-trace-group-count">本页 {rows.length} 条</span></span>
      <span className="wa-trace-row-side"><span className="wa-trace-group-caret">{open ? '收起' : '展开'}</span></span></span>
    <span className="wa-trace-row-sub"><span className="wa-trace-row-preview">{summary || '表情、记忆与诊断类后台任务'}</span></span>
  </button>;
}

/** 「已跳过 N 条」 + 显示/隐藏, the only way in or out of preset 'all'. */
export function TraceSkipChip({ count, preset, local, onToggle }) {
  if (!count && preset !== 'all') return null;
  return <span className="wa-trace-skip-chip" data-source={local ? 'page' : 'range'}>
    <span>已跳过 <b>{count}</b> 条</span>
    <button type="button" aria-pressed={preset === 'all'} onClick={onToggle}
      title={preset === 'all' ? '当前筛选范围内已跳过的任务数' : local ? '当前页中被隐藏的任务数' : '当前筛选范围内被隐藏的任务数'}>{preset === 'all' ? '隐藏' : '显示'}</button>
  </span>;
}

export function TracesEmpty({ filtered, skipped, preset, onShowAll }) {
  const hidden = preset === 'all' ? 0 : skipped;
  if (filtered) return <div className="wa-trace-empty"><h3>没有匹配的执行记录</h3>
    <p>换一个关键词、状态或时间范围试试。{hidden > 0 && '另有 ' + hidden + ' 条已跳过的任务默认不显示。'}</p>
    {hidden > 0 && <Button onClick={onShowAll}>显示这 {hidden} 条</Button>}</div>;
  if (hidden > 0) return <div className="wa-trace-empty"><h3>这段时间的记录都已跳过</h3>
    <p>{hidden} 条任务没有调用模型或工具，所以默认不显示。</p>
    <Button onClick={onShowAll}>显示这 {hidden} 条</Button></div>;
  return <div className="wa-trace-empty"><h3>这段时间还没有执行记录</h3><p>任务执行后会自动出现在这里，也可以调整分类和日期查看历史。</p></div>;
}

export function ExecutionTracesPage({ rpc, status }) {
  const accountId = status.account?.id, rpcRef = useRef(rpc); rpcRef.current = rpc;
  const [type, setType] = useState('all'), [state, setState] = useState('all'), [query, setQuery] = useState('');
  const [preset, setPreset] = useState('meaningful'), [background, setBackground] = useState(false);
  const [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [from, setFrom] = useState(() => dateInput(new Date(Date.now() - 6 * 86400000))), [to, setTo] = useState(() => dateInput(new Date()));
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [selected, setSelected] = useState(null);
  const [focused, setFocused] = useState(false), [counts, setCounts] = useState({});
  // Older builds only accept 'problems'; start with the documented 'problem' and fall back once.
  const stateAlias = useRef('problem');
  const filters = JSON.stringify({ type, state, search, from, to, accountId, preset });
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setOffset(0); setSelected(null); }, [filters]);
  useEffect(() => { setCounts({}); setFocused(false); }, [accountId]);
  useEffect(() => {
    if (!accountId) { setData(null); return; }
    const controller = new AbortController(); let pending = false;
    setData(null); setError(''); setLoading(true);
    const read = async () => {
      if (pending) return; pending = true;
      try {
        const startAt = new Date(from + 'T00:00:00').getTime(), endAt = new Date(to + 'T23:59:59.999').getTime();
        let value;
        for (let attempt = 0; ; attempt += 1) {
          try {
            value = await rpcRef.current('traces.list', { accountId, type, state: state === 'problem' ? stateAlias.current : state,
              preset: state === 'skipped' ? 'all' : preset, query: search, from, to, startAt, endAt, offset, limit: pageSize }, controller.signal);
            break;
          } catch (failure) {
            if (attempt || state !== 'problem' || stateAlias.current === 'problems') throw failure;
            if (failure?.code !== 'TRACE_FILTER_INVALID' && !/筛选/.test(failure?.message || '')) throw failure;
            stateAlias.current = 'problems';
          }
        }
        if (!controller.signal.aborted) { setData(value); setCounts(value.counts || {}); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void read(); const timer = setInterval(() => { if (offset === 0) void read(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [filters, offset, refresh]);
  const changeType = value => { setType(value); setSelected(null); setOffset(0); };
  const [, title] = TRACE_TYPES.find(row => row[0] === type) || TRACE_TYPES[0];
  const categories = TRACE_TYPES.map(([id, label]) => [id, <><Glyph name={categoryIcons[id]} size={15} /><span>{label}</span><small>{counts[id] ?? '—'}</small></>]);

  // hidden.skipped / summary.skipped when the backend knows; otherwise the current page.
  const includeSkipped = state === 'skipped';
  const { rows, skipped, localCount, averageMs, backgroundRows, entries } = traceListModel({ data, preset, type, background, includeSkipped });
  const now = Date.now(), filtered = !!search || state !== 'all', showAll = () => setPreset('all'), toggleSkip = () => setPreset(value => value === 'all' ? 'meaningful' : 'all');
  const selectTrace = id => { setSelected(id); setFocused(false); };
  const problemView = state === 'problem';
  return <section className="wa-traces-page" data-testid="execution-traces-page" data-account-id={accountId || ''} data-show-detail={!!selected} data-focused={focused && !!selected} data-preset={preset}>
    <PageHead title="任务执行轨迹" description="从一次任务出发，看清每个调用与结果。" className="wa-trace-page-head">
      <div className="wa-trace-capture-mark" aria-hidden="true"><TraceNetworkMark /><span><strong>看见任务的来龙去脉</strong><small>模型 · 工具 · 微信回执</small></span></div>
    </PageHead>
    <WorkspaceTabs name="traces" label="任务轨迹分类" tabs={categories} active={type} onChange={changeType} className="wa-trace-type-tabs" />
    <WorkspacePanels name="traces" tabs={TRACE_TYPES.map(row => row[0])} active={type}>
      {!accountId ? <div className="wa-trace-empty"><h3>登录后查看此账号的执行轨迹</h3><p>不同微信账号的记录分别保存。</p></div> : <>
        <div className="wa-trace-filters">
          <label className="wa-trace-search"><Glyph name="search" size={16} /><input className="wa-input" type="search" aria-label="搜索执行轨迹" value={query} placeholder="搜索任务、会话或错误…" onChange={event => setQuery(event.target.value)} /></label>
          <label><span className="wa-sr-only">执行状态</span><select className="wa-select" aria-label="轨迹执行状态" value={state} onChange={event => setState(event.target.value)}>
            <option value="all">全部状态</option><option value="problem">仅看异常</option><option value="skipped">已跳过</option>
            {Object.entries(TRACE_STATES).filter(([id]) => id !== 'skipped').map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          <details className="wa-trace-date-filter"><summary><Glyph name="clock" size={14} /><span>{from.slice(5)} — {to.slice(5)}</span></summary><div>
            <label>开始日期<input className="wa-input" type="date" aria-label="轨迹开始日期" value={from} onChange={event => setFrom(event.target.value)} /></label>
            <label>结束日期<input className="wa-input" type="date" aria-label="轨迹结束日期" value={to} onChange={event => setTo(event.target.value)} /></label>
          </div></details>
          <Button disabled={loading} onClick={() => setRefresh(value => value + 1)}><Glyph name="refresh" size={14} /><span>刷新轨迹</span></Button>
        </div>
        <div className="wa-trace-quick">
          <button type="button" className="wa-trace-quick-button" aria-pressed={problemView} onClick={() => setState(problemView ? 'all' : 'problem')}><Glyph name="shield" size={12} /><span>仅看异常</span></button>
          {problemView && <button type="button" className="wa-trace-text-button" onClick={() => setState('all')}>查看全部状态</button>}
          {!includeSkipped && <TraceSkipChip count={skipped} preset={preset} local={localCount} onToggle={toggleSkip} />}
        </div>
        <div className="wa-trace-stats" aria-label="当前筛选统计">
          <strong>{title}<span>{data?.total ?? '—'} 条</span></strong>
          <div><span><i data-state="running" />执行中 <b>{data?.summary?.active ?? '—'}</b></span><span><i data-state="problem" />异常 <b>{data?.summary?.problems ?? '—'}</b></span>
            <span title="只统计实际调用了模型或工具的任务">实际执行任务平均耗时 <b>{traceDuration(averageMs)}</b></span></div>
        </div>
        {error && <p className="wa-trace-warning" role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>重试读取</button></p>}
        {data?.warning && <p className="wa-trace-warning" role="alert">{data.warning.message}</p>}
        <div className={'wa-traces-split' + (selected ? ' has-selection' : '')}>
          <div className="wa-traces-list" aria-label={title + '列表'}>
            <div className="wa-traces-list-title"><strong>执行记录</strong><span>{preset === 'meaningful' && skipped && !includeSkipped ? '已隐藏 ' + skipped + ' 条跳过' : '最近执行优先'}</span></div>
            <div className="wa-traces-list-scroll">
            {loading && !data ? <p className="wa-trace-note" role="status">正在读取记录…</p>
              : !rows.length ? <TracesEmpty filtered={filtered} skipped={skipped} preset={preset} onShowAll={showAll} />
              : entries.map(item => item.group
                ? <TraceGroupRow key="background" rows={backgroundRows} open={background} onToggle={() => setBackground(value => !value)} />
                : <TraceRow key={item.row.id} row={item.row} selected={selected === item.row.id} now={now} onSelect={selectTrace} />)}
            </div>
            <div className="wa-trace-pagination"><Button disabled={loading || !offset} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>上一页</Button>
              <span>{data?.total ? Math.floor(offset / pageSize) + 1 : 0} / {Math.ceil((data?.total || 0) / pageSize)}</span>
              <Button disabled={loading || offset + pageSize >= (data?.total || 0)} onClick={() => setOffset(value => value + pageSize)}>下一页</Button></div>
          </div>
          {selected ? <TraceDetail key={accountId + ':' + selected} rpc={rpc} accountId={accountId} traceId={selected} onSelect={selectTrace} onBack={() => setSelected(null)}
            focused={focused} onFocus={() => setFocused(value => !value)} />
            : <div className="wa-trace-unselected"><div className="wa-trace-empty-graph" aria-hidden="true"><span><Glyph name="spark" size={22} /></span><i /><div><span><Glyph name="model" size={16} />模型</span><span><Glyph name="work" size={16} />工具</span><span><Glyph name="check" size={16} />结果</span></div></div>
              <h3>从一次任务，展开整个过程</h3><p>选择左侧记录，在关系图中探索模型调用、工具执行和微信回执。</p><small>新任务自动记录 · 历史任务保留已有摘要</small></div>}
        </div>
      </>}
    </WorkspacePanels>
  </section>;
}
