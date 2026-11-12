import test from 'node:test';
import assert from 'node:assert/strict';
import { executionGraph, groupState } from '../frontend/pages/traces/graph-layout.mjs';

test('long executions keep bounded geometry and every step is accessible exactly once through its branch pages', () => {
  const kinds = ['stage', 'lifecycle', 'model', 'tool', 'transport', 'child', 'future-kind'];
  const steps = Array.from({ length: 607 }, (_, index) => ({ id: 'step-' + index, seq: index + 1, kind: kinds[index % kinds.length], state: 'completed' }));
  for (const compact of [false, true]) {
    const overview = executionGraph(steps, { compact });
    assert.equal(overview.nodes.length, 7);
    assert(overview.height <= 540 && overview.width <= 900);
    assert(overview.edges.every(edge => edge.source.id === 'task'), 'overview lines express membership, never invented execution order');
    const visited = [];
    for (const group of overview.groups) {
      const first = executionGraph(steps, { expanded: group.id, compact });
      for (let page = 0; page < first.selected.pages; page++) {
        const graph = executionGraph(steps, { expanded: group.id, page, compact });
        assert(graph.nodes.length <= (compact ? 5 : 9));
        assert.equal(graph.height, first.height);
        for (const node of graph.nodes) {
          assert(node.x >= 0 && node.y >= 0 && node.x + node.width <= graph.width && node.y + node.height <= graph.height);
          if (node.role === 'step') visited.push(node.step.id);
        }
        assert(graph.edges.every(edge => edge.source.groupId === group.id && edge.target.role === 'step'));
      }
      const clamped = executionGraph(steps, { expanded: group.id, page: 999, compact });
      assert.equal(clamped.selected.page, first.selected.pages - 1);
    }
    assert.deepEqual(visited.sort(), steps.map(step => step.id).sort());
    assert.equal(new Set(visited).size, steps.length);
  }
});

test('empty and filtered views stay navigable and unfinished or uncertain branches are not shown as successful', () => {
  const empty = executionGraph([], { expanded: 'model' });
  assert.deepEqual(empty.nodes.map(node => node.id), ['task', 'result']);
  assert.equal(empty.selected, undefined);
  assert.equal(groupState([{ state: 'completed' }, { state: 'running' }]), 'running');
  assert.equal(groupState([{ state: 'unknown' }, { state: 'completed' }]), 'unknown');
  assert.equal(groupState([{ state: 'failed' }, { state: 'completed' }]), 'partial');
  assert.equal(groupState([{ state: 'cancelled' }]), 'cancelled');
  assert.equal(groupState([{ state: 'failed' }, { state: 'failed' }]), 'failed');
  assert.equal(groupState([{ state: 'skipped' }, { state: 'skipped' }]), 'skipped');
  assert.equal(groupState([{ state: 'completed' }, { state: 'cancelled' }]), 'partial');
});
