const groups = [
  ['stage', '处理与状态', ['stage', 'lifecycle']], ['model', '模型调用', ['model']],
  ['tool', '工具调用', ['tool']], ['transport', '微信接口', ['transport']], ['child', '关联任务', ['child']],
];
export const GRAPH_PAGE_SIZE = 8;
export function executionGraph(steps, { expanded, page = 0, compact = false } = {}) {
  const known = new Set(groups.flatMap(([, , kinds]) => kinds));
  const buckets = groups.map(([id, title, kinds]) => ({ id, title, steps: steps.filter(step => kinds.includes(step.kind) || id === 'stage' && !known.has(step.kind)) })).filter(group => group.steps.length);
  const selected = buckets.find(group => group.id === expanded), shown = selected ? [selected] : buckets;
  const pageSize = compact ? 4 : GRAPH_PAGE_SIZE;
  const height = selected ? 390 : compact ? Math.max(350, (shown.length + 1) * 82 + 38) : 380, middle = height / 2;
  const positions = { stage: [24, 45], model: [600, 22], tool: [600, 144], transport: [600, 266], child: [24, 245] };
  const nodes = selected ? [] : [{ id: 'task', role: 'task', x: compact ? 26 : 312, y: middle - 49, width: compact ? 180 : 212, height: 98 }], edges = [];
  for (const [index, group] of shown.entries()) {
    const [x, y] = selected ? [26, middle - 35] : compact ? [278, 22 + index * 82] : positions[group.id];
    nodes.push({ ...group, id: 'group-' + group.id, groupId: group.id, role: 'group', kind: group.id, x, y, width: selected && compact ? 180 : 212, height: 70 });
    if (!selected) edges.push({ from: 'task', to: 'group-' + group.id });
  }
  if (!selected) {
    nodes.push({ id: 'result', role: 'result', x: compact ? 278 : 312, y: compact ? 22 + shown.length * 82 : 286, width: 212, height: 70 });
    edges.push({ from: 'task', to: 'result' });
  } else {
    const count = Math.ceil(selected.steps.length / pageSize), current = Math.max(0, Math.min(page, count - 1));
    const visible = selected.steps.slice(current * pageSize, (current + 1) * pageSize);
    const columns = compact ? 1 : 2, rows = Math.ceil(visible.length / columns), startY = middle - rows * 86 / 2;
    for (const [index, step] of visible.entries()) {
      const column = index % columns, row = Math.floor(index / columns);
      nodes.push({ id: step.id, role: 'step', step, kind: step.kind, x: (compact ? 278 : 334) + column * 268, y: startY + row * 86, width: 232, height: 78 });
      edges.push({ from: 'group-' + selected.id, to: step.id });
    }
    selected.page = current; selected.pages = count;
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  return { nodes, edges: edges.map(edge => ({ ...edge, source: byId.get(edge.from), target: byId.get(edge.to) })),
    width: selected ? compact ? 534 : 860 : compact ? 522 : 836, height, groups: buckets, selected };
}

export function groupState(steps) {
  if (steps.some(step => step.state === 'running' || step.state === 'queued')) return 'running';
  if (steps.some(step => ['unknown', 'interrupted'].includes(step.state))) return 'unknown';
  if (steps.some(step => ['failed', 'partial'].includes(step.state))) return steps.every(step => step.state === 'failed') ? 'failed' : 'partial';
  if (steps.length && steps.every(step => step.state === 'cancelled')) return 'cancelled';
  if (steps.length && steps.every(step => step.state === 'skipped')) return 'skipped';
  if (steps.some(step => step.state === 'cancelled')) return 'partial';
  return 'completed';
}
