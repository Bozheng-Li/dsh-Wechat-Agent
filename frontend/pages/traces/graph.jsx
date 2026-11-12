import { useEffect, useMemo, useRef, useState } from 'react';
import { TRACE_ACTIVE } from '../../../shared/execution-traces.mjs';
import { Glyph } from '../../components/glyph.jsx';
import { executionGraph, groupState } from './graph-layout.mjs';
import { GraphNode } from './graph-node.jsx';
import { GraphMiniMap } from './minimap.jsx';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function ExecutionGraph({ trace, steps, selectedStep, onStep, onTask, onResult }) {
  const [expanded, setExpanded] = useState(null), [page, setPage] = useState(0), [kind, setKind] = useState('all');
  const [hovered, setHovered] = useState(null), [focusedNode, setFocusedNode] = useState(null), [mapMode, setMapMode] = useState('auto');
  const [motion, setMotion] = useState(true), [dragging, setDragging] = useState(false);
  const surface = useRef(null), drag = useRef(null), [size, setSize] = useState({ width: 700, height: 450 });
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const compact = size.width < 480;
  const graph = useMemo(() => executionGraph(steps.filter(step => kind === 'all' || step.kind === kind || kind === 'stage' && step.kind === 'lifecycle'), { expanded, page, compact }), [steps, expanded, page, kind, compact]);
  const focused = hovered || selectedStep || focusedNode, active = graph.nodes.some(node => node.id === focused) ? focused : null;
  const related = new Set([active]);
  for (const edge of graph.edges) if (edge.from === active || edge.to === active) { related.add(edge.from); related.add(edge.to); }
  const homeScale = clamp(Math.min((size.width - 28) / graph.width, (size.height - 50) / graph.height), .23, 1.08);
  const exploring = Math.abs(camera.scale - homeScale) > .025 || Math.abs(camera.x - (size.width - graph.width * homeScale) / 2) > 25 || Math.abs(camera.y - (size.height - graph.height * homeScale) / 2) > 25;
  const canShowMap = size.width >= 580 && size.height >= 220, showMap = canShowMap && (mapMode === 'open' || mapMode === 'auto' && exploring);
  const bounds = useRef({ graph, size }); bounds.current = { graph, size };
  const fit = () => {
    const { graph: layout, size: viewport } = bounds.current;
    const scale = clamp(Math.min((viewport.width - 28) / layout.width, (viewport.height - 50) / layout.height), .23, 1.08);
    setMotion(true);
    setCamera({ scale, x: (viewport.width - layout.width * scale) / 2, y: (viewport.height - layout.height * scale) / 2 });
  };
  const zoom = (factor, point) => { setMotion(true); setCamera(current => {
    const scale = clamp(current.scale * factor, .2, 2.2), center = point || { x: size.width / 2, y: size.height / 2 };
    return { scale, x: center.x - (center.x - current.x) * scale / current.scale, y: center.y - (center.y - current.y) * scale / current.scale };
  }); };
  useEffect(() => {
    const element = surface.current, observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect; if (width && height) setSize({ width, height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { fit(); }, [size.width, size.height, graph.width, graph.height, expanded, kind]);
  useEffect(() => { setHovered(null); setFocusedNode(null); }, [expanded, kind, page]);
  useEffect(() => {
    const element = surface.current;
    const wheel = event => {
      if (event.target.closest('[data-graph-control]')) return;
      event.preventDefault(); const rect = element.getBoundingClientRect();
      setMotion(false);
      const current = cameraRef.current, scale = clamp(current.scale * Math.exp(-event.deltaY * .0015), .2, 2.2);
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      setCamera({ scale, x: x - (x - current.x) * scale / current.scale, y: y - (y - current.y) * scale / current.scale });
    };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, []);
  const openGroup = group => { setExpanded(value => value === group ? null : group); setPage(0); onStep(null); };
  const returnToGraph = () => { setExpanded(null); setPage(0); onStep(null); };
  return <div className="wa-trace-graph" data-testid="execution-graph" data-motion={motion} data-focusing={!!active}>
    <div className="wa-trace-graph-toolbar">
      <div className="wa-trace-graph-breadcrumb"><span className="wa-trace-view-symbol"><Glyph name="grid" size={13} /></span><button type="button" onClick={returnToGraph} disabled={!expanded}>本次执行</button>
        {graph.selected && <><Glyph name="arrow" size={13} /><strong>{graph.selected.title}</strong></>}</div>
      <label className="wa-trace-graph-filter"><span className="wa-sr-only">节点类型</span><select className="wa-select" aria-label="筛选轨迹步骤" value={kind}
        onChange={event => { setKind(event.target.value); setExpanded(null); setPage(0); onStep(null); }}>
        <option value="all">全部节点</option>{[['stage', '处理与状态'], ['model', '模型调用'], ['tool', '工具调用'], ['transport', '微信接口'], ['child', '关联任务']].map(([id, title]) => <option value={id} key={id}>{title}</option>)}
      </select></label>
    </div>
    <div className="wa-trace-graph-surface" ref={surface} tabIndex={0} role="region" aria-label="可拖动和缩放的执行关系图"
      data-scale={camera.scale.toFixed(3)} data-camera-x={camera.x.toFixed(1)} data-camera-y={camera.y.toFixed(1)} data-dragging={dragging} onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (['+', '=', '-', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
        if (event.key === '+' || event.key === '=') zoom(1.2); else if (event.key === '-') zoom(1 / 1.2); else if (event.key === 'Home') fit();
        else if (event.key.startsWith('Arrow')) { setMotion(false); setCamera(value => ({ ...value, x: value.x + (event.key === 'ArrowLeft' ? 50 : event.key === 'ArrowRight' ? -50 : 0), y: value.y + (event.key === 'ArrowUp' ? 50 : event.key === 'ArrowDown' ? -50 : 0) })); }
      }} onPointerDown={event => {
        if (event.button !== 0 || event.target.closest('button,select,[data-graph-control]')) return;
        setMotion(false); setDragging(true); setHovered(null); setFocusedNode(null);
        drag.current = { x: event.clientX, y: event.clientY, camera: cameraRef.current }; event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => { if (drag.current) setCamera({ ...drag.current.camera, x: drag.current.camera.x + event.clientX - drag.current.x, y: drag.current.camera.y + event.clientY - drag.current.y }); }}
      onPointerUp={event => { drag.current = null; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }} onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={event => { if (!event.target.closest('button,select,[data-graph-control]')) fit(); }}>
      <div className="wa-trace-canvas-label" aria-hidden="true"><i />{graph.selected ? graph.selected.title : '执行关系'}<span>{graph.nodes.length} 个节点</span></div>
      <svg className="wa-trace-graph-svg" width="100%" height="100%" aria-label="任务、调用类型与执行步骤之间的关联">
        <g className="wa-trace-graph-scene" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
          {graph.edges.map(edge => {
            const { source, target } = edge;
            const left = target.x < source.x, vertical = Math.abs(target.x - source.x) < 50;
            const startX = vertical ? source.x + source.width / 2 : source.x + (left ? 0 : source.width), startY = vertical ? source.y + source.height : source.y + source.height / 2;
            let endX = vertical ? target.x + target.width / 2 : target.x + (left ? target.width : 0), endY = vertical ? target.y : target.y + target.height / 2;
            const middle = startX + (endX - startX) * .5;
            let path = vertical ? `M${startX},${startY} L${endX},${endY}` : `M${startX},${startY} C${middle},${startY} ${middle},${endY} ${endX},${endY}`;
            if (target.role === 'step' && target.x - startX > 300) {
              // Route the far column above its row so links do not imply step-to-step causality.
              endX = target.x + target.width / 2; endY = target.y;
              path = `M${startX},${startY} C${startX + 35},${startY} ${startX + 35},${endY - 5} ${startX + 65},${endY - 5} L${endX - 5},${endY - 5} Q${endX},${endY - 5} ${endX},${endY}`;
            }
            const lit = !!active && related.has(edge.from) && related.has(edge.to);
            const running = TRACE_ACTIVE.has(target.role === 'step' ? target.step.state : target.role === 'group' ? groupState(target.steps) : trace.state);
            return <g key={edge.from + ':' + edge.to} className="wa-graph-connection" data-kind={edge.target.kind || 'result'} data-highlighted={lit} data-muted={!!active && !lit} data-running={running}>
              <path className="wa-graph-connection-base" d={path} />
              {(lit || running) && <path className="wa-graph-connection-signal" d={path} />}
              <circle cx={endX} cy={endY} r={3} />
            </g>;
          })}
          {graph.nodes.map(node => <GraphNode key={node.id} node={node} trace={trace} scale={camera.scale} selected={node.role === 'group' ? expanded === node.groupId : selectedStep === node.id}
            active={active} related={related.has(node.id)} onHover={setHovered} onFocus={setFocusedNode}
            onActivate={() => node.role === 'task' ? onTask() : node.role === 'result' ? onResult() : node.role === 'group' ? openGroup(node.groupId) : onStep(node.step)} />)}
        </g>
      </svg>
      <div className="wa-trace-graph-controls" data-graph-control="true" aria-label="执行图视图控制">
        <button type="button" aria-label="缩小执行图" onClick={() => zoom(1 / 1.2)}>−</button><span>{Math.round(camera.scale * 100)}%</span>
        <button type="button" aria-label="放大执行图" onClick={() => zoom(1.2)}>+</button><button type="button" className="wa-graph-fit" onClick={fit}>适应画布</button>
        {canShowMap && <button type="button" className="wa-graph-map-toggle" aria-label="切换图谱导航" title="图谱导航" aria-pressed={showMap} onClick={() => setMapMode(showMap ? 'closed' : 'open')}><Glyph name="grid" size={13} /></button>}
      </div>
      {showMap && <GraphMiniMap graph={graph} camera={camera} viewport={size} onClose={() => setMapMode('closed')} onNavigate={(x, y) => { setMotion(true); setCamera(value => ({ ...value, x: size.width / 2 - x * value.scale, y: size.height / 2 - y * value.scale })); }} />}
    </div>
    <div className="wa-trace-graph-foot"><span>拖动 · 滚轮缩放 · 连线表示归属关系</span>
      {graph.selected ? <div className="wa-trace-branch-pages"><button type="button" disabled={graph.selected.page === 0} onClick={() => { setPage(value => value - 1); onStep(null); }}>上一组</button>
        <span>{graph.selected.page + 1} / {graph.selected.pages}</span><button type="button" disabled={graph.selected.page + 1 >= graph.selected.pages} onClick={() => { setPage(value => value + 1); onStep(null); }}>下一组</button></div>
        : <span>点击分支展开，点击节点看详情</span>}
    </div>
  </div>;
}
