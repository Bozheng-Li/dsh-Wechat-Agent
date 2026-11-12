import { useEffect, useRef, useState } from 'react';
import { TRACE_TYPES, TRACE_STATES, traceDuration, traceTypeLabel } from '../../../shared/execution-traces.mjs';
import { PageHead } from '../../components/page-ui.jsx';
import { WorkspaceTabs, WorkspacePanels } from '../../components/workspace-tabs.jsx';
import { Button } from '../../components/button.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { TraceDetail, TraceBadge, traceTime } from './detail.jsx';
import { TraceNetworkMark } from './graph-node.jsx';

const dateInput = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const categoryIcons = { all: 'grid', conversation: 'chat', work: 'work', scheduled: 'clock', moments: 'moments', memory: 'memory', media: 'image', digest: 'digest', maintenance: 'shield' };
export function ExecutionTracesPage({ rpc, status }) {
  const accountId = status.account?.id, rpcRef = useRef(rpc); rpcRef.current = rpc;
  const [type, setType] = useState('all'), [state, setState] = useState('all'), [query, setQuery] = useState('');
  const [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [from, setFrom] = useState(() => dateInput(new Date(Date.now() - 6 * 86400000))), [to, setTo] = useState(() => dateInput(new Date()));
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [selected, setSelected] = useState(null);
  const [focused, setFocused] = useState(false), [counts, setCounts] = useState({});
  const filters = JSON.stringify({ type, state, search, from, to, accountId });
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
        const value = await rpcRef.current('traces.list', { accountId, type, state, query: search, from, to, startAt, endAt, offset, limit: 30 }, controller.signal);
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
  return <section className="wa-traces-page" data-testid="execution-traces-page" data-account-id={accountId || ''} data-show-detail={!!selected} data-focused={focused && !!selected}>
    <PageHead title="任务执行轨迹" description="从一次任务出发，看清每个调用与结果。" className="wa-trace-page-head">
      <div className="wa-trace-capture-mark" aria-hidden="true"><TraceNetworkMark /><span><strong>看见任务的来龙去脉</strong><small>模型 · 工具 · 微信回执</small></span></div>
    </PageHead>
    <WorkspaceTabs name="traces" label="任务轨迹分类" tabs={categories} active={type} onChange={changeType} className="wa-trace-type-tabs" />
    <WorkspacePanels name="traces" tabs={TRACE_TYPES.map(row => row[0])} active={type}>
      {!accountId ? <div className="wa-trace-empty"><h3>登录后查看此账号的执行轨迹</h3><p>不同微信账号的记录分别保存。</p></div> : <>
        <div className="wa-trace-filters">
          <label className="wa-trace-search"><Glyph name="search" size={16} /><input className="wa-input" type="search" aria-label="搜索执行轨迹" value={query} placeholder="搜索任务、会话或错误…" onChange={event => setQuery(event.target.value)} /></label>
          <label><span className="wa-sr-only">执行状态</span><select className="wa-select" aria-label="轨迹执行状态" value={state} onChange={event => setState(event.target.value)}>
            <option value="all">全部状态</option><option value="problems">异常记录</option>{Object.entries(TRACE_STATES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          <details className="wa-trace-date-filter"><summary><Glyph name="clock" size={14} /><span>{from.slice(5)} — {to.slice(5)}</span></summary><div>
            <label>开始日期<input className="wa-input" type="date" aria-label="轨迹开始日期" value={from} onChange={event => setFrom(event.target.value)} /></label>
            <label>结束日期<input className="wa-input" type="date" aria-label="轨迹结束日期" value={to} onChange={event => setTo(event.target.value)} /></label>
          </div></details>
          <Button disabled={loading} onClick={() => setRefresh(value => value + 1)}><Glyph name="refresh" size={14} /><span>刷新轨迹</span></Button>
        </div>
        <div className="wa-trace-stats" aria-label="当前筛选统计">
          <strong>{title}<span>{data?.total ?? '—'} 条</span></strong>
          <div><span><i data-state="running" />执行中 <b>{data?.summary?.active ?? '—'}</b></span><span><i data-state="problem" />异常 <b>{data?.summary?.problems ?? '—'}</b></span>
            <span>平均耗时 <b>{traceDuration(data?.summary?.averageMs)}</b></span></div>
        </div>
        {error && <p className="wa-trace-warning" role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>重试读取</button></p>}
        {data?.warning && <p className="wa-trace-warning" role="alert">{data.warning.message}</p>}
        <div className={'wa-traces-split' + (selected ? ' has-selection' : '')}>
          <div className="wa-traces-list" aria-label={title + '列表'}>
            <div className="wa-traces-list-title"><strong>执行记录</strong><span>最近执行优先</span></div>
            <div className="wa-traces-list-scroll">
            {loading && !data ? <p className="wa-trace-note" role="status">正在读取记录…</p> : !data?.items?.length ? <div className="wa-trace-empty"><h3>{search || state !== 'all' ? '没有匹配的执行记录' : '这段时间还没有执行记录'}</h3><p>任务执行后会自动出现在这里，也可以调整分类和日期查看历史。</p></div> :
              data.items.map(row => <button type="button" key={row.id} className={'wa-trace-list-item' + (selected === row.id ? ' is-selected' : '')}
                data-trace-id={row.id} aria-current={selected === row.id ? 'true' : undefined} onClick={() => setSelected(row.id)}>
                <span className="wa-trace-list-top"><small><Glyph name={categoryIcons[row.type] || 'grid'} size={12} />{traceTypeLabel(row.type)}</small><TraceBadge state={row.state} /></span>
                <strong>{row.title}</strong><span className="wa-trace-list-meta">{traceTime(row.createdAt)}</span>
                <span className="wa-trace-list-bottom"><small>{row.coverage === 'historical' ? '历史摘要' : row.coverage === 'partial' ? '部分步骤记录' : row.incomplete ? '记录不完整' : (row.modelCalls || 0) + ' 次模型 · ' + (row.toolCalls || 0) + ' 次工具'}</small>
                  <small>{traceDuration(row.startedAt && row.finishedAt ? row.finishedAt - row.startedAt : null)}</small></span>
              </button>)}
            </div>
            <div className="wa-trace-pagination"><Button disabled={loading || !offset} onClick={() => setOffset(value => Math.max(0, value - 30))}>上一页</Button>
              <span>{data?.total ? Math.floor(offset / 30) + 1 : 0} / {Math.ceil((data?.total || 0) / 30)}</span>
              <Button disabled={loading || offset + 30 >= (data?.total || 0)} onClick={() => setOffset(value => value + 30)}>下一页</Button></div>
          </div>
          {selected ? <TraceDetail key={accountId + ':' + selected} rpc={rpc} accountId={accountId} traceId={selected} onSelect={setSelected} onBack={() => setSelected(null)}
            focused={focused} onFocus={() => setFocused(value => !value)} />
            : <div className="wa-trace-unselected"><div className="wa-trace-empty-graph" aria-hidden="true"><span><Glyph name="spark" size={22} /></span><i /><div><span><Glyph name="model" size={16} />模型</span><span><Glyph name="work" size={16} />工具</span><span><Glyph name="check" size={16} />结果</span></div></div>
              <h3>从一次任务，展开整个过程</h3><p>选择左侧记录，在关系图中探索模型调用、工具执行和微信回执。</p><small>新任务自动记录 · 历史任务保留已有摘要</small></div>}
        </div>
      </>}
    </WorkspacePanels>
  </section>;
}
