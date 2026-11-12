import test from 'node:test';
import assert from 'node:assert/strict';
import { workSettings, observeWorkProgress, polishWorkResult } from '../lib/testing.js';

test('old positive work timeouts load as unlimited while command deadlines remain explicit', () => {
  assert.deepEqual(workSettings({ timeoutSeconds: 600, commandTimeoutSeconds: 60 }), { timeoutSeconds: 0, commandTimeoutSeconds: 60, maxConcurrent: 2 });
  assert.equal(workSettings({}).timeoutSeconds, 0);
  assert.throws(() => workSettings({ timeoutSeconds: -1 }), { code: 'INVALID_WORK_SETTINGS' });
});

test('optional native observation stays within the selected session and excludes reasoning and tool output', () => {
  const listeners = new Map(), events = [], session = {}, agent = { session };
  const ctx = { on: (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } };
  const dispose = observeWorkProgress(ctx, agent, event => events.push(event));
  listeners.get('session/event')({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'other session' }] } } });
  listeners.get('session/event')(session, { type: 'assistant/message', time: 2, data: { message: { content: [
    { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: '正在查看最后一页' },
    { type: 'tool-call', id: 'read-1', name: 'read_image', arguments: 'PRIVATE_ARGUMENTS' },
  ] } } });
  listeners.get('session/event')(session, { type: 'tool/result', time: 3,
    data: { message: { toolCallId: 'read-1', isError: true, content: 'PRIVATE_IMAGE' } } });
  assert.equal(events.length, 2); assert(!JSON.stringify(events).includes('PRIVATE'));
  assert.equal(events[1].tool, 'read_image'); assert.equal(events[1].failed, true);
  dispose(); assert.equal(listeners.size, 0);
});

test('final reports retain current persona without changing delivery facts', async () => {
  const presentation = { persona: { name: '小胖', aliases: [], prompt: '熟悉直接，叫对方老郑。' } };
  const runner = { run: async input => {
    assert(input.systemOverride.includes('叫对方老郑')); assert.deepEqual(input.tools, []);
    return { text: '老郑，42 项检查通过，文件还没确认送达。' };
  } };
  const result = await polishWorkResult(runner, '42 项检查通过，文件还没确认送达。', '核对结果', new AbortController().signal, presentation);
  assert.equal(result.polish.state, 'applied'); assert.equal(result.text, '老郑，42 项检查通过，文件还没确认送达。');
});
