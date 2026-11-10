import test from 'node:test';
import assert from 'node:assert/strict';
import { taskViews } from "../shared/task-history.mjs";

test('a completed task and its execution produce one history row at the actual completion time', () => {
  const task = { id: 'done', state: 'completed', nextRunAt: 1000, updatedAt: 7000, lastState: 'sent', runId: 'run' };
  const run = { id: 'run', taskId: 'done', state: 'sent', scheduledAt: 1000, startedAt: 2200, finishedAt: 6000, acknowledgedMessageIds: ['ack'] };
  const result = taskViews([task], [run]);
  assert.equal(result.current.length, 0); assert.equal(result.history.length, 1);
  assert.equal(result.history[0].timestamp, 6000); assert.equal(result.history[0].state, 'completed');
  assert.deepEqual(result.history[0].runs, [run]);
});

test('recurring task history stays one row without losing separate executions or another planned run', () => {
  const task = { id: 'daily', state: 'pending', nextRunAt: 10000, lastState: 'sent' };
  const runs = [1, 2, 3].map(index => ({ id: String(index), taskId: 'daily', state: 'sent', finishedAt: index * 1000 }));
  const result = taskViews([task], runs);
  assert.equal(result.current[0], task); assert.equal(result.history.length, 1);
  assert.deepEqual(result.history[0].runs.map(run => run.id), ['3', '2', '1']);
  assert.equal(result.history[0].timestamp, 3000);
});

test('cancellation pending reconciliation is distinct from cancelled delivery and retains a late ACK', () => {
  const task = { id: 'cancel', state: 'cancelled', updatedAt: 4000, runId: 'inflight', lastState: 'sent' };
  const run = { id: 'inflight', taskId: 'cancel', state: 'queued', startedAt: 3000 };
  assert.equal(taskViews([task], [run]).history[0].state, 'settling');
  const reconciled = taskViews([task], [{ ...run, state: 'sent', finishedAt: 5000, acknowledgedMessageIds: ['late-ack'] }]).history[0];
  assert.equal(reconciled.state, 'cancelled'); assert.equal(reconciled.result, 'sent');
  assert.deepEqual(reconciled.latest.acknowledgedMessageIds, ['late-ack']);
});

test('expired tasks without executions remain visible and filtered tasks never include another room execution', () => {
  const expired = { id: 'expired', state: 'expired', lastState: 'expired', updatedAt: 5000 };
  const unknown = { id: 'unknown', state: 'paused', lastState: 'unknown', updatedAt: 6000 };
  const result = taskViews([expired, unknown], [{ id: 'other-room', taskId: 'not-in-filter', state: 'sent', finishedAt: 9999 }]);
  assert.equal(result.current.length, 1); assert.equal(result.current[0].id, 'unknown');
  assert.equal(result.history.length, 2); assert(result.history.every(entry => !entry.runs.length));
  assert.equal(result.history.find(entry => entry.task.id === expired.id).state, 'expired');
});
