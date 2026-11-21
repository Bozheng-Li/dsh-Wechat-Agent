import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAgentRunner } from '../modules/agent/runner.mjs';
import { summarizeStyle } from '../modules/agent/style-summary.mjs';
import { styleProfile } from '../modules/agent/style-profile.mjs';
import { previewPersonaChat } from '../modules/agent/persona-chat.mjs';
import { ChannelError } from '../shared/contracts.mjs';

const persona = { name: '小满', aliases: [], prompt: '表达保持自然，正文中有 PERSONA_VOICE。', personaMode: 'high-precision' };
const planning = JSON.stringify({ request: '回应当前请求', facts: ['有来源的事实'], constraints: [], unknown: ['不明部分'] });
function fixture(respond) {
  const calls = [];
  const state = { choice: { provider: 'fixture', model: 'one', reasoningEffort: 'low' },
    runtime: { persona: structuredClone(persona), modelConfig: { promptStrategy: 'legacy', webSearch: false }, identityMarkdown: 'GLOBAL_RULE' } };
  const create = async options => {
    const hooks = new Map(), tools = new Map(), sections = [], restrictions = [];
    const call = { options, tools, sections, restrictions, messages: [], events: [] };
    calls.push(call);
    let pending;
    const agent = { session: { seq: 0, surface: { nodes: [] }, deriveMessages: () => [], append() {},
      snapshotEvents: () => call.events }, cancel() {},
      followup(message) {
        call.messages.push(message);
        pending = (async () => {
          let request = { ...options.agentOptions, sessionId: options.sessionId ?? options.resumeSessionId,
            messages: [{ role: 'user', content: message.content }], tools: [...tools.values()] };
          request = await (hooks.get('agent/request') || []).reduceRight((next, hook) => () => hook({ turn: 1, step: 1 }, next), async () => request)();
          const result = await respond(call, calls.length - 1, { request, agent });
          const value = typeof result === 'string' ? { text: result } : result;
          const stream = () => (async function* () { yield { type: 'text-delta', text: value.text };
            yield { type: 'finish', reason: { kind: value.reason || 'completed' }, usage: { inputTokens: 10, outputTokens: 5 } }; })();
          const observed = (hooks.get('llm/stream') || []).reduceRight((next, hook) => () => hook(request, next), stream)();
          for await (const ignored of observed) { /* exercise real request metrics */ }
          call.events = [{ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: value.text }] } } },
            { type: 'turn/end', data: { turn: 1, reason: { kind: value.reason || 'completed' } } }];
          agent.session.seq += call.events.length;
        })();
      }, async whenIdle() { await pending; } };
    const scoped = { tools: { modeFor: () => 'native', presentAs() {}, restrict(value) { restrictions.push(value); },
      register(tool) { tools.set(tool.name, tool); }, guard(check) { call.guard = check; } },
      systemPrompt: { suppressRuntimeContext() {}, context() {}, section(value) { sections.push(value); } },
      on(name, hook) { const list = hooks.get(name) || []; list.push(hook); hooks.set(name, list); return () => {}; } };
    options.setup(scoped, agent);
    return { agent, async dispose() { call.disposed = true; } };
  };
  const ctx = { agentDefaultModel: { currentSelection: () => state.choice },
    llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'one' }, { id: 'two' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }) },
    agents: { create, resume: create } };
  return { state, calls, runner: new DshAgentRunner(ctx, () => state.choice, () => state.runtime) };
}
const request = extra => ({ text: '现在怎么接？', signal: new AbortController().signal, ...extra });
const system = call => call.sections.filter(item => item.name === 'wechat-agent').map(item => item.text).join('\n');
const user = call => call.messages[0].content.filter(block => block.type === 'text').map(block => block.text).join('\n');

test('native high precision uses exactly two isolated sessions and freezes selection, clock and history', async () => {
  const history = [{ text: '原始上文', direction: 'incoming', senderId: 'alice', senderName: '甲', time: 1795276790 }];
  const f = fixture((call, index) => {
    if (!index) { f.state.choice.model = 'two'; f.state.runtime.persona.prompt = 'MUTATED_STYLE'; history[0].text = 'MUTATED_HISTORY'; return planning; }
    return '完整的人设回复';
  });
  const result = await f.runner.run(request({ history, now: () => Date.parse('2026-11-21T00:00:02+08:00'), messageTime: 1795190390, timeZone: 'Asia/Shanghai' }));
  assert.equal(result.text, '完整的人设回复'); assert.equal(result.personaPasses, 2); assert.equal(result.personaApplied, true);
  assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0].options.sessionId, f.calls[1].options.sessionId);
  assert.equal(f.calls[1].options.agentOptions.model, 'one');
  assert(!system(f.calls[0]).includes('PERSONA_VOICE')); assert(system(f.calls[1]).includes('PERSONA_VOICE'));
  assert(!system(f.calls[1]).includes('不扮演聊天角色'), 'expression must not inherit the generic extraction-only task');
  assert(!system(f.calls[1]).includes('MUTATED_STYLE')); assert(user(f.calls[1]).includes('原始上文')); assert(!user(f.calls[1]).includes('MUTATED_HISTORY'));
  assert(system(f.calls[0]).includes('2026-11-21T00:00:02+08:00')); assert(system(f.calls[1]).includes('2026-11-21T00:00:02+08:00'));
  assert.equal(f.calls[1].tools.size, 0); assert.deepEqual(f.calls[1].restrictions, [{ allow: [] }]);
  assert.equal(result.requestMetrics.length, 2); assert.deepEqual(result.requestMetrics.map(row => row.personaPass), ['planning', 'expression']);
  assert(f.calls.every(call => call.disposed));
});

test('expression receives actual completed tool evidence and cannot execute that tool again', async () => {
  const f = fixture(async (call, index) => {
    if (!index) { await call.tools.get('wechat_memory').execute({}, { id: 'read-1', signal: new AbortController().signal }); return planning; }
    assert(user(call).includes('EXACT_TOOL_EVIDENCE')); assert(user(call).includes('read-1'));
    return '按真实资料回应';
  });
  let executions = 0;
  const result = await f.runner.run(request({ tools: [{ name: 'wechat_memory', parameters: { type: 'object' },
    execute: async () => { executions++; return { fact: 'EXACT_TOOL_EVIDENCE' }; } }] }));
  assert.equal(result.text, '按真实资料回应'); assert.equal(executions, 1); assert.equal(f.calls[1].tools.size, 0);
});

test('natural skip runs one planning session and keeps the direct selector decision', async () => {
  const f = fixture(() => '{"action":"skip","reason":"no_topic","text":""}');
  let decision;
  const result = await f.runner.run(request({ mode: 'natural', naturalDecision: { trigger: 'count', allowColdOpening: false }, allowEmptyReply: true,
    selectReplyText: raw => { decision = JSON.parse(raw); return decision.text; } }));
  assert.equal(result.text, ''); assert.equal(result.personaApplied, false); assert.equal(f.calls.length, 1); assert.equal(decision.action, 'skip');
  assert(system(f.calls[0]).includes('未授权冷场主动开题')); assert(system(f.calls[0]).includes('packet'));
});

test('natural reply uses independent expression and allows only role and sticker planning tools', async () => {
  const f = fixture((call, index) => index ? '自然接上这句话' : JSON.stringify({ action: 'reply', text: '适合接话', packet: JSON.parse(planning) }));
  const tools = ['wechat_role_card', 'wechat_sticker_read', 'wechat_sticker_send', 'run_command', 'wechat_web_search'].map(name => ({ name, parameters: {}, execute() {} }));
  const result = await f.runner.run(request({ mode: 'participate', naturalDecision: { trigger: 'count' }, tools,
    selectReplyText: raw => JSON.parse(raw).text }));
  assert.equal(result.text, '自然接上这句话'); assert.equal(f.calls.length, 2);
  assert.deepEqual([...f.calls[0].tools.keys()], ['wechat_role_card', 'wechat_sticker_read', 'wechat_sticker_send']);
});

test('selected media caption is expressed from evidence, intentional media-only skips expression', async () => {
  for (const caption of ['图上的配文', '']) {
    const f = fixture((call, index) => index ? '按人设写的图片配文' : planning);
    const result = await f.runner.run(request({ selectedReply: () => ({ id: 'image', text: caption }), allowEmptyReply: true,
      selectReplyText: () => caption }));
    assert.equal(f.calls.length, caption ? 2 : 1);
    assert.equal(result.text, caption ? '按人设写的图片配文' : '');
    if (caption) assert(user(f.calls[1]).includes('图上的配文'));
  }
});

test('ordinary max-token planning can pass labelled partial notes; expression max-tokens never sends', async () => {
  const f = fixture((call, index) => index ? '仍可回答的内容' : { text: '部分事实草稿', reason: 'max-tokens' });
  const result = await f.runner.run(request()); assert.equal(result.planningIncomplete, true); assert.equal(result.text, '仍可回答的内容');
  assert(user(f.calls[1]).includes('"incomplete":true'));
  const bad = fixture((call, index) => index ? { text: '未完正文', reason: 'max-tokens' } : planning);
  await assert.rejects(bad.runner.run(request()), { code: 'MODEL_INCOMPLETE' });
});

test('standard native mode remains one pass and native resume still uses the supplied session id', async () => {
  const f = fixture(() => '普通回复');
  f.state.runtime.persona.personaMode = 'standard';
  const result = await f.runner.run(request({ sessionId: 'existing-native-session', history: [{ text: '原文', direction: 'incoming' }] }));
  assert.equal(result.text, '普通回复'); assert.equal(result.personaPasses, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.resumeSessionId, 'existing-native-session'); assert.equal(f.calls[0].messages[0].content.length, 1);
  assert(user(f.calls[0]).indexOf('原文') < user(f.calls[0]).indexOf('现在怎么接？'));
});

test('an empty response after a completed tool never replays the tool in a retry', async () => {
  let executions = 0;
  const f = fixture(async call => {
    await call.tools.get('wechat_memory').execute({}, { id: 'once', signal: new AbortController().signal });
    return '';
  });
  await assert.rejects(f.runner.run(request({ tools: [{ name: 'wechat_memory', parameters: {}, execute() { executions++; return '证据'; } }] })), { code: 'MODEL_EMPTY' });
  assert.equal(executions, 1); assert.equal(f.calls.length, 1);
});

test('authorization failure after planning prevents expression and no internal packet is returned', async () => {
  let allowed = true;
  const f = fixture(() => { allowed = false; return planning; });
  await assert.rejects(f.runner.run(request({ assertAllowed() { if (!allowed) throw new ChannelError('AUTH_CHANGED', '已撤权'); } })), { code: 'AUTH_CHANGED' });
  assert.equal(f.calls.length, 1);
});

test('work dialogue and internal image/memory tasks retain single native mode and original tool boundary', async () => {
  for (const mode of ['work-dialogue', 'work-result', 'work-routing', 'memory', 'vision', 'role-memory']) {
    const f = fixture(() => '原有专用结果');
    const result = await f.runner.run(request({ mode, tools: [{ name: 'work_test_tool', parameters: {}, execute() {} }],
      workContext: { pending: 'WORK_CONTEXT' } }));
    assert.equal(f.calls.length, 1); assert.equal(result.personaPasses, 1);
    assert.equal(f.calls[0].tools.size, mode === 'work-dialogue' ? 1 : 0);
    if (mode === 'work-dialogue') assert(system(f.calls[0]).includes('WORK_CONTEXT'));
  }
});

test('persona summary goes through internal native runner without persona, tools or search', async () => {
  const f = fixture(() => '# 人物语言档案\n简练自然。');
  const summary = await summarizeStyle({ runner: f.runner, samples: [{ text: '晚上再说吧', chatType: 'private' }],
    profile: styleProfile([{ text: '晚上再说吧' }]), signal: new AbortController().signal });
  assert(summary.text.includes('人物语言档案')); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].tools.size, 0);
  assert(!system(f.calls[0]).includes('PERSONA_VOICE')); assert.equal(f.calls[0].options.agentOptions.maxTokens, 6000);
});

test('draft persona preview uses native runner with supplied draft and quoted local history only', async () => {
  const f = fixture(() => '试聊回复');
  const result = await previewPersonaChat(f.runner, { text: '你好', persona: { ...persona, personaMode: 'standard', prompt: 'DRAFT_PERSONA' },
    messages: [{ role: 'user', content: '前一句' }, { role: 'assistant', content: '旧口气' }] }, new AbortController().signal);
  assert.equal(result.text, '试聊回复'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].tools.size, 0);
  assert(system(f.calls[0]).includes('DRAFT_PERSONA')); assert(user(f.calls[0]).includes('旧口气'));
  assert(user(f.calls[0]).includes('历史本账号发言'));
});
