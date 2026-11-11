import test from 'node:test';
import assert from 'node:assert/strict';
import { registerModelTools } from '../modules/tools/registry.mjs';
import { planProgressiveTools } from '../modules/tools/progressive.mjs';
import { measureModelRequest, numericUsage, observeModelRequests } from '../modules/agent/request-metrics.mjs';
import { validateModelConfig } from '../shared/contracts.mjs';
import { modelDraft } from '../frontend/shared/drafts.mjs';
import { replyMemoryContext } from '../modules/conversation/reply-context.mjs';

const definition = (name, execute = async () => '{}') => ({ name, description: 'Scoped tool', parameters: { type: 'object', properties: {} }, execute });
function scope() {
  const registered = new Map(), guards = [];
  return { registered, guards, tools: { restrict() {}, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
    guard(fn) { guards.push(fn); }, presentAs() {} } };
}

test('capability discovery loads exact scoped definitions without invoking them or repeating registration', async () => {
  let calls = 0;
  const ctx = scope(), tools = [definition('wechat_memory', async () => { calls++; }), definition('wechat_task')];
  const plan = planProgressiveTools(tools, '你好');
  assert.equal(plan.initial.length, 0);
  registerModelTools(ctx, plan.initial, { deferredGroups: plan.deferredGroups });
  assert.deepEqual([...ctx.registered.keys()], ['wechat_capabilities']);
  assert(ctx.guards[0]({ name: 'wechat_memory' }));
  const load = ctx.registered.get('wechat_capabilities').execute;
  assert.equal(JSON.parse(await load({ modules: ['other-account'] })).ok, false);
  assert.equal(JSON.parse(await load({ modules: ['memory'] })).ok, true);
  assert.equal(calls, 0);
  assert(ctx.registered.has('wechat_memory')); assert(!ctx.registered.has('wechat_task'));
  assert.equal(ctx.guards[0]({ name: 'wechat_memory' }), undefined);
  assert(ctx.guards[0]({ name: 'host_shell' }));
  await load({ modules: ['memory'] }); assert.equal(ctx.registered.size, 2);
  const nextTurn = scope(); registerModelTools(nextTurn, plan.initial, { deferredGroups: plan.deferredGroups });
  assert.deepEqual([...nextTurn.registered.keys()], ['wechat_capabilities']);
});

test('revocation and cancellation still stop discovery, and disposed layers release loaded tools', async () => {
  const ctx = scope(), disposers = []; let permitted = true;
  registerModelTools(ctx, [], { deferredGroups: [{ id: 'memory', summary: 'Memory', tools: [definition('wechat_memory')] }],
    onDispose: fn => disposers.push(fn), assertAllowed() { if (!permitted) throw Error('Revoked'); } });
  const load = ctx.registered.get('wechat_capabilities').execute;
  permitted = false; await assert.rejects(load({ modules: ['memory'] }), /Revoked/);
  permitted = true; const controller = new AbortController(); controller.abort();
  await assert.rejects(load({ modules: ['memory'] }, { signal: controller.signal }));
  await load({ modules: ['memory'] });
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(ctx.registered.size, 0);
});

test('obvious requests preload relevant tools but cannot manufacture unavailable capabilities', () => {
  const input = [definition('wechat_memory'), definition('wechat_task'), definition('custom_tool')];
  const plan = planProgressiveTools(input, '上次约定的事项，五分钟后提醒我');
  assert.deepEqual(plan.initial.map(tool => tool.name), input.map(tool => tool.name));
  assert.equal(plan.deferredGroups.length, 0);
  assert.deepEqual(planProgressiveTools([], '发布朋友圈'), { initial: [], deferredGroups: [] });
});

test('request measurements include schemas, tool results and call arguments without retaining private content', async () => {
  const request = { tools: [definition('sample')], messages: [
    { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
    { role: 'user', content: [{ type: 'text', text: 'PRIVATE' }, { type: 'image', data: 'PIXELS' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'sample', arguments: '{"secret":"ARG"}' }] },
    { role: 'tool', content: [{ type: 'text', text: 'RESULT' }] },
  ] };
  const result = measureModelRequest(request);
  assert.equal(result.systemChars, 3); assert.equal(result.userChars, 7); assert.equal(result.toolResultChars, 6); assert.equal(result.imageCount, 1);
  assert(result.toolCallChars > 0 && result.toolSchemaChars > 20);
  assert(!/PRIVATE|PIXELS|secret|RESULT/.test(JSON.stringify(result)));
  assert.deepEqual(numericUsage({ inputTokens: 30, outputTokens: 4, text: 'secret' }), { inputTokens: 30, outputTokens: 4 });
  let hook, updated;
  const rows = []; observeModelRequests({ on: (_event, fn) => { hook = fn; } }, { rows, onUpdate: value => { updated = value; } });
  const output = [];
  for await (const chunk of hook(request, () => (async function* () { yield { type: 'usage', inputTokens: 30, outputTokens: 4 }; })())) output.push(chunk);
  assert.equal(output.length, 1); assert.equal(updated[0].state, 'completed'); assert.equal(updated[0].usage.inputTokens, 30);
  await assert.rejects(async () => { for await (const _chunk of hook(request, () => { throw Error('sync failure'); })) {} }, /sync failure/);
  assert.equal(updated[1].state, 'failed'); assert.equal(typeof updated[1].elapsedMs, 'number');
});

test('terminal provider failures retain usage and pass every stream chunk through unchanged', async () => {
  for (const kind of ['error', 'aborted', 'stop', 'tool-calls']) {
    let hook, updated;
    const rows = [];
    observeModelRequests({ on: (_event, fn) => { hook = fn; } }, { rows, onUpdate: value => { updated = value; } });
    const chunks = [
      { type: 'usage', usage: { inputTokens: 42, outputTokens: 3 } },
      { type: 'finish', reason: { kind, ...(['error', 'aborted'].includes(kind) ? { failure: { code: 'SYNTHETIC_FAILURE' } } : {}) } },
    ];
    const observed = [];
    for await (const chunk of hook({ messages: [] }, () => (async function* () { yield* chunks; })())) observed.push(chunk);
    assert.deepEqual(observed, chunks);
    assert(observed.every((chunk, index) => chunk === chunks[index]), 'diagnostics must forward the original chunks');
    assert.equal(updated[0].state, ['error', 'aborted'].includes(kind) ? 'failed' : 'completed');
    assert.deepEqual(updated[0].usage, { inputTokens: 42, outputTokens: 3 });
    assert.equal(typeof updated[0].elapsedMs, 'number');
    assert(!JSON.stringify(updated).includes('SYNTHETIC_FAILURE'), 'provider failure payloads are not diagnostic metrics');
  }
});

test('progressive budgets recent and recalled material without changing saved history or losing latest correction', () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({ key: String(index), text: `采购预算暂定${index + 100}元。` + '讨论。'.repeat(100), senderId: 'a', direction: 'incoming', time: index + 1 }));
  entries.push({ key: 'correct', text: '采购预算更正为980元，之前数字作废。', senderId: 'a', direction: 'incoming', time: 100 });
  const before = structuredClone(entries);
  const context = replyMemoryContext({ snapshot: { entries, summary: '' }, text: '采购预算是多少？', promptStrategy: 'progressive-v1' });
  assert(context.history.length <= 12); assert(context.referenceChars <= 3000);
  assert(context.history.at(-1).text.includes('980元')); assert.deepEqual(entries, before);
});

test('strategy survives validation and editing while unknown values fail explicitly', () => {
  const config = validateModelConfig({ temperature: null, promptStrategy: 'progressive-v1' });
  assert.equal(config.promptStrategy, 'progressive-v1'); assert.equal(modelDraft(config).promptStrategy, 'progressive-v1');
  assert.equal(validateModelConfig({ temperature: null }).promptStrategy, 'legacy');
  assert.throws(() => validateModelConfig({ temperature: null, promptStrategy: 'oops' }), { code: 'INVALID_MODEL_CONFIG' });
});
