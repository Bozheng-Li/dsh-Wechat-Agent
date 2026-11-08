import test from 'node:test';
import assert from 'node:assert/strict';
import { resetWechatSessionContext } from '../src/features/agent/request-context.mjs';

test('resume shadows prior native dialogue while preserving the system head and audit events', () => {
  const nodes = Object.freeze([2, 5, 8, 12, 15]), writes = [];
  const audit = Object.freeze(['OLD_REQUEST', 'OLD_REASONING', 'OLD_REPLY', 'OLD_TOOL_RESULT']);
  const session = { surface: { nodes }, deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'CURRENT_PERSONA' }] },
    ...audit.map(text => ({ role: 'user', content: [{ type: 'text', text }] })),
  ], append: (...args) => writes.push(args) };
  resetWechatSessionContext(session, { turn: 2, step: 1 });
  assert.equal(writes.length, 1);
  const [type, data, options] = writes[0];
  assert.equal(type, 'system/message');
  assert.equal(data.turn, 2);
  assert.equal(data.step, 1);
  assert.equal(data.message.role, 'system');
  assert(data.message.id);
  assert.deepEqual(data.message.content, []);
  assert.deepEqual(options, { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 15 }, sourceEventSeqs: [5, 8, 12, 15] });
  assert.deepEqual(session.surface.nodes, [2, 5, 8, 12, 15], 'the plugin never mutates the native surface directly');
  assert.deepEqual(audit, ['OLD_REQUEST', 'OLD_REASONING', 'OLD_REPLY', 'OLD_TOOL_RESULT']);
});

test('a session without prior dialogue needs no surface rewrite', () => {
  for (const nodes of [[], [2]]) resetWechatSessionContext({ surface: { nodes }, deriveMessages: () => [],
    append() { assert.fail('no previous dialogue'); } });
});

test('unsupported or invalid native context fails before admitting another request', () => {
  for (const session of [{}, { surface: { nodes: [] } }, { surface: { nodes: [2, 4] },
    deriveMessages: () => [{ role: 'user' }], append() { assert.fail('invalid system head'); } }]) {
    assert.throws(() => resetWechatSessionContext(session), error => error.code === 'MODEL_CONTEXT_INVALID');
  }
});
