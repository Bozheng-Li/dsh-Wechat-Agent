import test from 'node:test';
import assert from 'node:assert/strict';
import { WORK_PROGRESS_INTERVAL_MS, summarizeWorkProgress, WorkProgressReporter, ChannelError } from '../lib/testing.js';

test('periodic progress has a three-minute interval and a tool-free factual request', async () => {
  assert.equal(WORK_PROGRESS_INTERVAL_MS, 180000);
  const evidence = { request: '核对文档', state: 'running', observations: [], operations: [] };
  const runner = { run: async input => {
    assert.equal(input.mode, 'work-progress'); assert.deepEqual(input.tools, []);
    assert.deepEqual(JSON.parse(input.text), evidence);
    for (const key of ['history', 'memory', 'sessionId', 'onBeforeTool']) assert.equal(input[key], undefined);
    assert(input.systemOverride.includes('没有新的可确认结果时如实说明'));
    return { text: '还在核对文档，目前没有新的可确认结果。' };
  } };
  const result = await summarizeWorkProgress(runner, evidence, new AbortController().signal);
  assert.equal(result.review.state, 'summarized'); assert.equal(result.text, '还在核对文档，目前没有新的可确认结果。');
});

for (const text of ['', '进度已经完成 50%。', '```原始日志```', '长'.repeat(161)]) {
  test('invalid periodic text uses a short fallback: ' + JSON.stringify(text.slice(0, 20)), async () => {
    const result = await summarizeWorkProgress({ run: async () => ({ text }) }, {}, new AbortController().signal);
    assert.equal(result.review.state, 'fallback'); assert(result.text.length <= 160);
    assert(result.text.includes('新的可确认进展'));
  });
}

test('a pending review is shared and revocation before sending suppresses its message', async () => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), sends = [], patches = [], controller = new AbortController();
  const job = { id: 'abcdef123456', accountId: 'self', chatType: 'private', peerId: 'alice', senderId: 'alice',
    request: '核对文档', state: 'running', startedAt: 0, operations: [] };
  let allowed = true, calls = 0;
  const service = { store: { get: () => structuredClone(job), update: (_id, patch) => { patches.push(patch); Object.assign(job, patch); } },
    assertAllowed(_job, signal) { signal.throwIfAborted(); if (!allowed) throw new ChannelError('WORK_NOT_AUTHORIZED', '权限已撤销'); },
    channel: { now: () => 180000, fail: error => assert.fail(error.message),
      store: { conversationPersona: () => ({ name: '小胖', aliases: [], prompt: '' }), settings: () => ({ prompt: '' }) },
      runner: { run: async () => { calls++; entered.resolve(); return gate.promise; } },
      submitScheduled: async value => { sends.push(value); return { state: 'sent' }; } } };
  const reporter = new WorkProgressReporter(service, job.id, controller.signal);
  try {
    for (let at = 1; at <= 30; at++) reporter.observe({ kind: 'tool-start', tool: 'read_file', at });
    reporter.observe({ kind: 'model-active', at: 31 });
    assert.equal(reporter.events.length, 12); assert.equal(reporter.lastActivityAt, 31);
    const pending = reporter.tick(); await entered.promise;
    assert.equal(reporter.tick(), pending); assert.equal(calls, 1);
    allowed = false; gate.resolve({ text: '正在核对文档。' }); await pending;
    assert.equal(sends.length, 0); assert.equal(patches.at(-1).progress.state, 'failed');
    assert.equal(patches.at(-1).progress.error.code, 'WORK_NOT_AUTHORIZED');
  } finally { gate.resolve({ text: '正在核对文档。' }); await reporter.stop(); }
});
