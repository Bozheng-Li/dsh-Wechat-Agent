import { useEffect, useRef } from 'react';
import { TRACE_KINDS, TRACE_STATES, traceDuration } from '../../../shared/execution-traces.mjs';
import { Glyph } from '../../components/glyph.jsx';
import { TracePayload } from './payload.jsx';
import { graphIcons } from './graph-node.jsx';

const time = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
export function TraceInspector({ rpc, accountId, traceId, step, steps, onSelect, onClose }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step.id]);
  const payload = (reference, inline, title) => <TracePayload rpc={rpc} accountId={accountId} traceId={traceId} reference={reference} inline={inline} title={title} />;
  const parent = steps.find(item => item.id === step.parentId);
  return <aside className="wa-trace-inspector" aria-label="步骤详情" data-kind={step.kind} data-state={step.state} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div className="wa-trace-inspector-head"><span><Glyph name={graphIcons[step.kind] || 'folder'} size={14} />{TRACE_KINDS[step.kind] || '处理步骤'}<small>#{step.seq}</small></span>
      <button type="button" aria-label="关闭步骤详情" onClick={onClose}><Glyph name="close" size={17} /></button></div>
    <div className="wa-trace-inspector-body">
      <h3 ref={heading} tabIndex={-1}>{step.title}</h3>
      <div className="wa-trace-inspector-meta"><span className="wa-trace-badge" data-state={step.state}>{TRACE_STATES[step.state] || step.state}</span>
        <span>耗时 {traceDuration(step.elapsedMs ?? (step.state === 'running' ? Date.now() - step.startedAt : null))}</span>
        <span>{time(step.startedAt)} 开始</span>{step.finishedAt && <span>{time(step.finishedAt)} 结束</span>}</div>
      {parent && <p className="wa-trace-note">来源步骤：{parent.title}（{parent.seq}）</p>}
      {step.kind === 'model' && <p className="wa-trace-note">{step.metadata?.provider} / {step.metadata?.model}<br />输入文本 {step.metadata?.totalTextChars ?? '未记录'} 字符 · 可用工具 {step.metadata?.toolsCount ?? '未记录'} 个</p>}
      {step.metadata?.usage && <details className="wa-trace-usage"><summary>模型用量</summary><pre>{JSON.stringify(step.metadata.usage, null, 2)}</pre></details>}
      {step.metadata?.traceId && <button type="button" className="wa-trace-text-button" onClick={() => onSelect(step.metadata.traceId)}>查看关联任务：{step.metadata.title || step.metadata.traceId}</button>}
      {payload(step.input, step.inputValue, step.kind === 'tool' ? '调用参数' : '输入详情')}
      {payload(step.output, step.outputValue, '返回结果')}{payload(step.error, undefined, '错误详情')}
      {!step.input && !step.output && !step.outputValue && !step.error && <p className="wa-trace-note">此步骤只记录了状态与时间。</p>}
    </div>
  </aside>;
}
