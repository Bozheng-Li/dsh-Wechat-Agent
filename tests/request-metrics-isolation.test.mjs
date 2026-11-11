import test from 'node:test';
import assert from 'node:assert/strict';
import { observeModelRequests } from '../modules/agent/request-metrics.mjs';

function host() {
  const listeners = [];
  return { on(name, callback) { assert.equal(name, 'llm/stream'); listeners.push(callback); },
    async stream(request, terminal = { type: 'finish', reason: { kind: 'stop' } }) {
      let index = 0;
      const next = () => index < listeners.length ? listeners[index++](request, next) : (async function* () { yield terminal; })();
      const values = []; for await (const value of next()) values.push(value); return values;
    } };
}
const request = (sessionId, text) => ({ sessionId, messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [] });

test('concurrent native sessions do not count each other as extra model calls', async () => {
  const ctx = host(), a = [], b = [], updates = [];
  observeModelRequests(ctx, { sessionId: 'session-a', mode: 'work-routing', rows: a, onUpdate: value => updates.push(value) });
  observeModelRequests(ctx, { sessionId: 'session-b', mode: 'default', rows: b });
  await Promise.all([ctx.stream(request('session-a', 'A')), ctx.stream(request('session-b', 'BBBB'))]);
  assert.equal(a.length, 1); assert.equal(b.length, 1); assert.equal(updates.length, 1);
  assert.equal(a[0].userChars, 1); assert.equal(b[0].userChars, 4);
  assert.equal(a[0].mode, 'work-routing'); assert.equal(b[0].mode, 'default');
  assert.equal(a[0].state, 'completed');
});

test('nested or unattributed streams stay out of the parent response metrics', async () => {
  const ctx = host(), rows = [];
  observeModelRequests(ctx, { sessionId: 'parent', rows });
  await ctx.stream(request('nested-vision', 'PRIVATE_CHILD'));
  await ctx.stream(request(undefined, 'UNATTRIBUTED'));
  assert.deepEqual(rows, []);
});

test('the matching session still records an adapter failure and preserves stream output', async () => {
  const ctx = host(), rows = [], terminal = { type: 'finish', reason: { kind: 'error' } };
  observeModelRequests(ctx, { sessionId: 'own', rows });
  const result = await ctx.stream(request('own', 'test'), terminal);
  assert.deepEqual(result, [terminal]); assert.equal(rows.length, 1); assert.equal(rows[0].state, 'failed');
});
