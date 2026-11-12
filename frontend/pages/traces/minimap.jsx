import { Glyph } from '../../components/glyph.jsx';

export function GraphMiniMap({ graph, camera, viewport, onNavigate, onClose }) {
  return <div className="wa-trace-minimap" data-graph-control="true" aria-label="图谱导航缩略图">
    <div><span>视野导航</span><button type="button" aria-label="隐藏图谱导航" onClick={onClose}><Glyph name="close" size={11} /></button></div>
    <button type="button" className="wa-trace-minimap-canvas" aria-label="点击缩略图定位画布"
      onClick={event => {
        const svg = event.currentTarget.querySelector('svg');
        if (!event.detail) { onNavigate(graph.width / 2, graph.height / 2); return; }
        const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
        const location = point.matrixTransform(svg.getScreenCTM().inverse()); onNavigate(location.x, location.y);
      }}>
      <svg viewBox={`0 0 ${graph.width} ${graph.height}`} aria-hidden="true">
        {graph.edges.map(edge => <line key={edge.from + ':' + edge.to} x1={edge.source.x + edge.source.width / 2} y1={edge.source.y + edge.source.height / 2}
          x2={edge.target.x + edge.target.width / 2} y2={edge.target.y + edge.target.height / 2} />)}
        {graph.nodes.map(node => <rect key={node.id} data-kind={node.kind || node.role} x={node.x} y={node.y} width={node.width} height={node.height} rx={12} />)}
        <rect className="wa-trace-minimap-viewport" x={-camera.x / camera.scale} y={-camera.y / camera.scale} width={viewport.width / camera.scale} height={viewport.height / camera.scale} rx={8} />
      </svg>
    </button>
  </div>;
}
