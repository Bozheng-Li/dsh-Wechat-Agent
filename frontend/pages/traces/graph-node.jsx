import { TRACE_STATES, traceDuration } from '../../../shared/execution-traces.mjs';
import { Glyph } from '../../components/glyph.jsx';
import { groupState } from './graph-layout.mjs';

export const graphIcons = { stage: 'folder', model: 'model', tool: 'work', transport: 'chat', child: 'grid' };
export const graphStateIcon = state => ({ completed: 'check', failed: 'close', cancelled: 'pause', skipped: 'arrow', running: 'clock', queued: 'clock' })[state] || 'shield';
export function TraceNetworkMark({ className = '' }) {
  return <svg className={'wa-trace-network-mark ' + className} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M12 11 27 9M12 11l7 18m8-20-8 20M12 11l18 15M19 29l11-3" stroke="currentColor" strokeWidth="1.2" opacity=".5" />
    <circle cx="12" cy="11" r="4" fill="currentColor" /><circle cx="27" cy="9" r="3" fill="currentColor" opacity=".7" />
    <circle cx="19" cy="29" r="4" fill="currentColor" opacity=".8" /><circle cx="30" cy="26" r="2.5" fill="currentColor" opacity=".5" />
  </svg>;
}
export function GraphNode({ node, trace, scale, selected, active, related, onHover, onFocus, onActivate }) {
  const state = node.role === 'step' ? node.step.state : node.role === 'group' ? groupState(node.steps) : trace.state;
  const title = node.role === 'task' ? trace.title : node.role === 'result' ? TRACE_STATES[trace.state] || '执行结果' : node.role === 'step' ? node.step.title : node.title;
  const failures = node.steps?.filter(step => ['failed', 'partial', 'unknown', 'interrupted'].includes(step.state)).length || 0;
  const duration = node.step?.elapsedMs ?? (state === 'running' && node.step?.startedAt ? Date.now() - node.step.startedAt : null);
  return <foreignObject x={node.x} y={node.y} width={node.width} height={node.height} className="wa-graph-node-wrap"
    data-node-id={node.id} data-muted={!!active && !related} data-active={active === node.id}>
    <button type="button" className={'wa-graph-node wa-graph-node-' + node.role + (selected ? ' is-selected' : '')}
      data-kind={node.kind || node.role} data-state={state} data-compact={scale < .6} data-step-id={node.role === 'step' ? node.id : undefined} data-group-id={node.groupId}
      aria-label={(node.role === 'group' ? '展开' : '查看') + title + (node.steps ? '，' + node.steps.length + ' 个步骤' : '')}
      aria-expanded={node.role === 'group' ? selected : undefined} title={title}
      style={{ '--graph-font': Math.max(14, 10 / scale) + 'px', '--graph-small': Math.max(11, 8 / scale) + 'px' }}
      onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)} onFocus={() => onFocus(node.id)} onBlur={() => onFocus(null)} onClick={onActivate}>
      <span className="wa-graph-node-symbol">{node.role === 'task' ? <TraceNetworkMark /> : <Glyph name={node.role === 'result' ? graphStateIcon(state) : graphIcons[node.kind] || 'folder'} size={18} />}</span>
      <span className="wa-graph-node-copy">
        {node.role === 'task' && <small className="wa-graph-node-kicker"><i className="wa-graph-state-dot" />本次任务 · {TRACE_STATES[state]}</small>}
        {node.role === 'step' && <small className="wa-graph-node-kicker"><i className="wa-graph-state-dot" />#{node.step.seq || '—'} · {TRACE_STATES[state]}</small>}
        <strong>{title}</strong>
        <small>{node.role === 'group' ? failures ? failures + ' 项异常 · 展开查看' : state === 'running' ? '正在执行 · 展开查看' : '展开查看节点'
          : node.role === 'step' ? traceDuration(duration) : node.role === 'result' ? '查看输入与结果' : '探索每个调用与结果'}</small>
      </span>
      {node.role === 'group' && <span className="wa-graph-node-count" aria-hidden="true">{node.steps.length}<Glyph name={selected ? 'back' : 'arrow'} size={11} /></span>}
    </button>
  </foreignObject>;
}
