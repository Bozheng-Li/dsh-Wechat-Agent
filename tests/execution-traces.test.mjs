import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionTraces } from '../modules/traces/store.mjs';
import { tracePayload } from '../modules/traces/sanitize.mjs';
import { currentTrace, traceStep, withTrace } from '../modules/traces/context.mjs';
import { observeExecutionSession } from '../modules/traces/model.mjs';
import { traceQuery } from '../modules/traces/api.mjs';

const at = Date.parse('2026-11-11T02:00:00.000Z');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-traces-test-'));
  let time = at;
  const source = { root, data: { storeId: 'test-owner-store' } };
  const store = new ExecutionTraces(source, { now: () => time });
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert(path.basename(root).startsWith('wechat-traces-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, store, advance: ms => time += ms };
}
const spec = (key = 'first', accountId = 'owner-a') => ({ key, accountId, type: 'work', title: '整理工作文档', input: { request: '生成一份计划', apiKey: 'hidden-key' } });

test('trace records complete nested work, real payloads, timing, failure recovery and export', async t => {
  const { store, advance } = setup(t);
  await store.run(spec(), async () => {
    assert(currentTrace());
    await traceStep('读取资料', async () => { advance(30); return { ok: false, message: '服务暂不可用' }; }, { kind: 'tool', input: { query: '资料' } });
    await traceStep('再次读取', async () => { advance(40); return { ok: true, text: '实际工具结果' }; }, { kind: 'tool' });
    return { state: 'completed', text: '最终计划' };
  });
  const list = await store.list('owner-a');
  assert.equal(list.total, 1); assert.equal(list.items[0].state, 'completed');
  assert.equal(list.summary.problems, 1); assert.equal(list.items[0].toolCalls, 2);
  const detail = await store.get('owner-a', list.items[0].id);
  const tool = detail.steps.find(step => step.title === '读取资料');
  assert.equal(tool.state, 'failed'); assert.equal(tool.elapsedMs, 30);
  const output = await store.content('owner-a', list.items[0].id, detail.trace.output.id);
  assert.equal(output.value.text, '最终计划');
  const exported = await traceQuery(store, 'traces.export', 'owner-a', { traceId: detail.trace.id });
  assert.equal(exported.data.steps.length, detail.total);
  assert(!JSON.stringify(exported).includes('hidden-key'));
  assert.equal(exported.data.changedDuringExport, false);
});

test('read pagination, account isolation and content references cannot cross task boundaries', async t => {
  const { store } = setup(t);
  const first = store.task(spec('a')), second = store.task(spec('b', 'owner-b'));
  store.update(first, { state: 'completed', output: 'account a' }); store.update(second, { state: 'completed', output: 'account b' });
  for (let i = 0; i < 210; i++) store.event(first, '步骤 ' + i, { i });
  const page = await store.get('owner-a', first.row.id, { offset: 200, limit: 20 });
  assert(page.steps.length > 0 && page.steps.length < 20);
  assert.equal((await store.list('owner-a')).total, 1);
  await assert.rejects(store.get('owner-b', first.row.id), { code: 'TRACE_NOT_FOUND' });
  await assert.rejects(store.content('owner-a', first.row.id, second.row.output.id));
  await assert.rejects(store.content('owner-a', first.row.id, '../index'), { code: 'TRACE_CONTENT_INVALID' });
  await assert.rejects(store.get('owner-a', '../../secret'), { code: 'TRACE_NOT_FOUND' });
});

test('same account concurrent tasks keep their model and tool sessions separate', async t => {
  const { store, advance } = setup(t), handlers = new Map();
  const ctx = { on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); return () => list.splice(list.indexOf(fn), 1); } };
  const contexts = [store.task(spec('one')), store.task(spec('two'))], agents = [{}, {}];
  const stop = contexts.map((context, index) => withTrace(context, () => observeExecutionSession(ctx, { sessionId: 'session-' + index, agent: agents[index], mode: 'work', selection: { provider: 'fixture', model: 'demo' } })));
  const stream = request => {
    let next = () => (async function* () { advance(10); yield { type: 'text-delta', index: 0, text: request.sessionId }; yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 12, outputTokens: 3 } }; })();
    for (const handler of handlers.get('llm/stream')) { const previous = next; next = () => handler(request, previous); }
    return next();
  };
  await Promise.all(['session-0', 'session-1', 'foreign-session'].map(async sessionId => {
    for await (const chunk of stream({ sessionId, system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: sessionId }] }], tools: [] })) assert(chunk);
  }));
  let next = () => Promise.resolve(JSON.stringify({ ok: false, message: 'failed tool' }));
  for (const handler of handlers.get('tools/execute')) { const previous = next; next = () => handler({ agent: agents[0], name: 'fixture_tool', arguments: '{"q":"only one"}' }, previous); }
  assert.equal(await next(), '{"ok":false,"message":"failed tool"}');
  for (const [index, context] of contexts.entries()) {
    store.update(context, { state: 'completed' });
    const detail = await store.get('owner-a', context.row.id);
    assert.equal(detail.trace.modelCalls, 1); assert.equal(detail.trace.toolCalls, index === 0 ? 1 : 0);
    const model = detail.steps.find(step => step.kind === 'model');
    assert.equal(model.metadata.sessionId, 'session-' + index); assert.equal(model.metadata.usage.outputTokens, 3);
    assert.equal((await store.content('owner-a', context.row.id, model.output.id)).value.content[0].text, 'session-' + index);
  }
  stop.forEach(dispose => dispose());
});

test('restart preserves completed history and marks unfinished capture without re-executing', async t => {
  const { store, source } = setup(t);
  const running = store.task(spec('unfinished')); store.event(running, '等待服务', 'in progress');
  await store.run(spec('finished'), () => 'done'); await store.flush();
  const reloaded = new ExecutionTraces(source, { now: () => at + 10000 });
  t.after(() => reloaded.close());
  const list = await reloaded.list('owner-a');
  assert.equal(list.items.find(row => row.id === running.row.id).state, 'interrupted');
  assert.equal(list.items.filter(row => row.state === 'completed').length, 1);
  assert((await reloaded.get('owner-a', running.row.id)).trace.incomplete);
});

test('recording keeps sync return values, promise identity and original errors', async t => {
  const { store } = setup(t);
  const value = { field: 1 }; assert.equal(store.run(spec('sync'), () => value), value);
  const promise = Promise.resolve(value); assert.equal(store.run(spec('async'), () => promise), promise); await promise;
  const failure = Object.assign(new Error('caller cancelled'), { name: 'AbortError' });
  assert.throws(() => store.run(spec('throws'), () => { throw failure; }), error => error === failure);
  const list = await store.list('owner-a'); assert.equal(list.items.find(row => row.sourceKey === 'throws').state, 'cancelled');
});

test('redaction removes credentials, signed media secrets, bytes and reasoning while keeping usable text', () => {
  const prepared = tracePayload({ apiKey: 'private1', authorization: 'private2', secret: 'private3', userText: 'Bearer private4',
    url: 'https://name:pass@example.test/image?token=private5&label=cat', command: 'API_KEY=private6 node app.mjs',
    image: { type: 'image', data: 'private7', mediaType: 'image/png', width: 2 }, reasoning: { type: 'reasoning', text: 'private8' },
    usage: { inputTokens: 120, outputTokens: 5 }, tool: { context: 'legitimate tool context', query: 'what happened' } });
  const text = JSON.stringify(prepared);
  for (let i = 1; i <= 8; i++) assert(!text.includes('private' + i));
  assert(!text.includes('name:pass')); assert(text.includes('label=cat'));
  assert.equal(prepared.value.usage.inputTokens, 120); assert.equal(prepared.value.tool.context, 'legitimate tool context');
  assert.equal(prepared.value.image.mediaType, 'image/png'); assert.equal(prepared.binaryOmitted, 1);
  assert.equal(prepared.reasoningOmitted, 1); assert(!prepared.limited);
  assert(tracePayload('long content', { maxChars: 5 }).limited);
});

test('local date boundaries include midnight executions from the adjacent UTC day', async t => {
  const { store } = setup(t);
  await store.run({ ...spec('midnight'), createdAt: Date.parse('2026-11-10T16:01:00Z') }, () => 'done');
  const list = await store.list('owner-a', { from: '2026-11-11', to: '2026-11-11', startAt: Date.parse('2026-11-10T16:00:00Z'), endAt: Date.parse('2026-11-11T15:59:59.999Z') });
  assert.equal(list.total, 1);
  await assert.rejects(store.list('owner-a', { from: '2026-02-30', to: '2026-03-03' }), { code: 'TRACE_DATE_INVALID' });
});

test('tampered content is not returned as a verified trace payload', async t => {
  const { store } = setup(t), context = store.task(spec());
  store.update(context, { state: 'completed', output: 'verified' }); await store.flush();
  fs.writeFileSync(path.join(context.day.directory, context.row.id, 'content', context.row.output.id + '.json'), '{}');
  await assert.rejects(store.content('owner-a', context.row.id, context.row.output.id), { code: 'TRACE_CONTENT_INVALID' });
});

test('live details and exports do not wait for an unrelated slow disk writer', async t => {
  const { store } = setup(t), gate = Promise.withResolvers();
  const context = store.task(spec('slow-save'));
  store.writer = gate.promise;
  store.event(context, '已观察到的结果', { text: '可立即查看' }); store.update(context, { state: 'completed', output: 'done' });
  try {
    const detail = await Promise.race([store.get('owner-a', context.row.id), new Promise((_, reject) => setTimeout(() => reject(Error('Reading waited for the writer')), 1000))]);
    assert(detail.trace.pendingSave); assert.equal(detail.trace.state, 'completed');
    const exported = await traceQuery(store, 'traces.export', 'owner-a', { traceId: context.row.id });
    assert(exported.data.steps.some(step => step.title === '已观察到的结果'));
    assert.equal((await store.content('owner-a', context.row.id, context.row.output.id)).value, 'done');
  } finally { gate.resolve(); await store.flush(); }
  const saved = await store.get('owner-a', context.row.id);
  assert.equal(saved.trace.pendingSave, false); assert.equal(saved.trace.incomplete, false);
  assert.equal(store.liveEvents.has(context.row.id), false); assert.equal(store.contentCache.size, 0);
});

test('new steps arriving during a disk read do not falsely mark a consistent snapshot as incomplete', async t => {
  const { store } = setup(t), context = store.task(spec('concurrent-read'));
  store.update(context, { state: 'completed', output: 'saved' }); await store.flush();
  const count = context.row.stepCount, entered = Promise.withResolvers(), release = Promise.withResolvers();
  const original = fs.promises.readFile;
  fs.promises.readFile = async function(file, ...args) {
    const value = await original.call(this, file, ...args);
    if (String(file).endsWith('events.jsonl')) { entered.resolve(); await release.promise; }
    return value;
  };
  try {
    const pending = store.get('owner-a', context.row.id);
    await entered.promise;
    store.event(context, '迟到的工具回执', { ok: true }); release.resolve();
    const snapshot = await pending;
    assert.equal(snapshot.trace.stepCount, count); assert.equal(snapshot.total, count); assert.equal(snapshot.trace.incomplete, false);
    const next = await store.get('owner-a', context.row.id);
    assert.equal(next.total, count + 1); assert.equal(next.trace.incomplete, false);
  } finally { release.resolve(); fs.promises.readFile = original; }
});
