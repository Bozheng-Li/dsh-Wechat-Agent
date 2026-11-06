import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentIdentity, DEFAULT_AGENT_IDENTITY, DshAgentRunner, NATURAL_REPLY_RULES, needsConversationalRewrite } from '../lib/testing.js';

const poems = `灯下翻书久，
页中落旧尘。
不知窗外雨，
已替我留人。

（夜读）

一碗热汤钱不多，
市桥灯火正婆娑。
人间至味寻常事，
何必青山换酒喝。

（街边）

山不送人行，
溪声自会远。
你欲问归期，
云在松梢缓。

（别友人）`;
const menu = '想往哪个方向写？要清一点的、热闹一点的，还是给谁题一句，你给个意思，我照着改。';
const signature = `再有短句两行，若你喜欢就拿去当签名：

我把旧书翻到折角处，
像把去年的话，重新说给你听。`;
const submittedReply = `好，随手写几首，不成体统，算给你解个闷。\n\n${poems}\n\n${signature}\n\n${menu}`;

function agentFixture(answers, onMessage = () => {}) {
  const scopes = [], requests = [], messages = [];
  const create = async options => {
    const scope = { definitions: [], hooks: [],
      tools: { restrict() {}, guard() {}, register: tool => scope.definitions.push(tool) },
      systemPrompt: { suppressRuntimeContext() {}, section: section => { scope.prompt = section.text; } },
      on: (_event, hook) => scope.hooks.push(hook)
    };
    scopes.push(scope); options.setup(scope);
    requests.push(await scope.hooks.reduceRight((next, hook) => () => hook({}, next), async () => options.agentOptions)());
    const answer = answers.shift();
    assert.equal(typeof answer, 'string', 'a rewrite must use at most one additional model request');
    return { agent: {
      session: { seq: 0, snapshotEvents: () => [
        { type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: answer }] } } },
        { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } }
      ] },
      followup: message => { messages.push(message); onMessage(messages.length); }, whenIdle: async () => {}, cancel() {}
    }, dispose: async () => {} };
  };
  return { scopes, requests, messages, ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'first' }) },
    llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'first' }, { id: 'second' }] },
    agents: { create, resume: create }
  } };
}

test('the reported poetry reply catches the extra signature and service menu while keeping literary formatting valid', () => {
  assert(needsConversationalRewrite(submittedReply, '给我写三首诗'));
  assert(needsConversationalRewrite(`${poems}\n\n${menu}`, '给我写三首诗'));
  assert(needsConversationalRewrite(`${poems}\n\n${signature}`, '给我写三首诗'));
  assert(!needsConversationalRewrite(poems, '给我写三首诗'));
  assert(!needsConversationalRewrite(`# 夜读\n${poems}`, '给我写三首诗'));
});

test('necessary questions and explicitly requested choices or signatures do not cause a rewrite', () => {
  assert(!needsConversationalRewrite('想往哪个方向写？', '想请你写点东西'));
  assert(!needsConversationalRewrite(`${poems}\n\n${menu}`, '写三首诗，结尾问我想往哪个方向改'));
  assert(!needsConversationalRewrite(`${poems}\n\n${signature}`, '写三首诗，再给两行签名'));
  assert(!needsConversationalRewrite(`${poems}\n\n${menu}`, '写三首诗', { prompt: '结尾问我想往哪个方向修改。' }));
  assert(!needsConversationalRewrite(`${poems}\n\n${signature}`, '写三首诗', { identityMarkdown: '每次写诗后给两行签名。' }));
  assert(needsConversationalRewrite(`${poems}\n\n${menu}`, '写三首诗', { prompt: '结尾不要问风格选项。' }));
  assert(!needsConversationalRewrite('你现在用的是哪个版本？', '这个软件打不开'));
});

test('code and quoted boilerplate stay intact, but an unsolicited prose footer is checked even for technical requests', () => {
  assert(!needsConversationalRewrite('```js\nconsole.log("有什么需要随时告诉我");\n```', '给我示例代码'));
  assert(!needsConversationalRewrite('“收到你的问题”会让开场显得像客服。', '分析这句话的语气'));
  assert(!needsConversationalRewrite('有什么需要随时告诉我。', '逐字引用原文：有什么需要随时告诉我。'));
  assert(!needsConversationalRewrite('收到你的问题，我会核对订单。', '写一段客服自动回复'));
  assert(needsConversationalRewrite('1. 打开设置\n2. 保存配置\n\n希望这些信息能帮到你。', '怎么配置这个软件'));
});

test('an explicit persona or account format is honored without treating negative format instructions as permission', () => {
  const report = '# 观察\n1. 先看条件\n2. 再做选择';
  assert(!needsConversationalRewrite(report, '你怎么看', { persona: { prompt: '回复写成带标题的简短报告。' } }));
  assert(!needsConversationalRewrite(report, '你怎么看', { prompt: '使用标题和编号。' }));
  assert(needsConversationalRewrite(report, '你怎么看', { persona: { prompt: '不要使用标题和编号。' } }));
  assert(needsConversationalRewrite(report, '你怎么看', { prompt: '不要把回复写成带标题的报告。' }));
});

test('poetry polishing keeps the original persona, global identity, account requirements and model controls without tools', async () => {
  const choice = { provider: 'fixture', model: 'first' };
  const runtime = { identityMarkdown: '# GLOBAL_CAPTURED\n只用中文。', persona: { name: '墨白', aliases: [], prompt: 'MOBAI_CAPTURED：克制的轻古风。' },
    modelConfig: { maxTokens: 1536, temperature: 0.2 } };
  const f = agentFixture([submittedReply, poems], number => {
    if (number !== 1) return;
    runtime.identityMarkdown = '# GLOBAL_CHANGED'; runtime.persona.prompt = 'PERSONA_CHANGED';
    runtime.modelConfig.maxTokens = 768; runtime.modelConfig.temperature = 0.9; choice.model = 'second';
  });
  let runtimeReads = 0, choiceReads = 0, toolExecutions = 0;
  const runner = new DshAgentRunner(f.ctx, () => { choiceReads++; return choice; }, () => { runtimeReads++; return runtime; });
  const result = await runner.run({ text: '给我写三首诗', prompt: 'ACCOUNT_CAPTURED：作品结束就停，不加签名。',
    tools: [{ name: 'wechat_task', execute: async () => { toolExecutions++; } }], signal: new AbortController().signal });
  assert.equal(result.text, poems); assert.equal(f.messages.length, 2);
  assert.equal(runtimeReads, 1); assert.equal(choiceReads, 1);
  for (const prompt of f.scopes.map(scope => scope.prompt)) {
    for (const value of ['GLOBAL_CAPTURED', 'MOBAI_CAPTURED', 'ACCOUNT_CAPTURED']) assert(prompt.includes(value), value);
    for (const value of ['GLOBAL_CHANGED', 'PERSONA_CHANGED']) assert(!prompt.includes(value), value);
    assert.equal(prompt.split(NATURAL_REPLY_RULES).length, 2, 'delivery defaults occur exactly once');
  }
  assert(f.scopes[0].prompt.indexOf(NATURAL_REPLY_RULES) < f.scopes[0].prompt.indexOf('MOBAI_CAPTURED'));
  assert(f.scopes[0].prompt.indexOf('MOBAI_CAPTURED') < f.scopes[0].prompt.indexOf('ACCOUNT_CAPTURED'));
  assert.deepEqual(f.scopes.map(scope => scope.definitions.map(tool => tool.name)), [['wechat_task'], []]);
  assert.equal(toolExecutions, 0);
  assert(f.requests.every(request => request.model === 'first' && request.maxTokens === 1536 && request.temperature === 0.2));
  assert(f.messages[1].content[0].text.includes(poems), 'the rewrite receives the complete original works');
});

test('an unresolved service footer is reported after one rewrite and never returned as a deliverable', async () => {
  const f = agentFixture([`${poems}\n\n${menu}`, `${poems}\n\n${menu}`]);
  await assert.rejects(new DshAgentRunner(f.ctx).run({ text: '写三首诗', signal: new AbortController().signal }), { code: 'REPLY_STYLE_FAILED' });
  assert.equal(f.messages.length, 2);
});

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
function identityRoot(t) {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'reply-identity-'));
  t.after(() => {
    assert.equal(path.dirname(root), base); assert(path.basename(root).startsWith('reply-identity-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const legacyIdentity = fs.readFileSync(new URL('./fixtures/agent-identity-preview2.md', import.meta.url), 'utf8');

test('only unedited legacy default identity files are migrated, including Windows line endings', t => {
  for (const markdown of [legacyIdentity, '\uFEFF' + legacyIdentity.replace(/\n/g, '\r\n')]) {
    const root = identityRoot(t); fs.writeFileSync(path.join(root, 'AGENT.md'), markdown);
    const identity = new AgentIdentity(root);
    assert.equal(identity.view().markdown, DEFAULT_AGENT_IDENTITY);
    assert(!identity.view().markdown.includes(NATURAL_REPLY_RULES));
    assert(!identity.view().markdown.includes('优先于人设里的格式习惯'));
  }
});

test('custom global identity and invalid files are preserved byte for byte during default migration', t => {
  for (const content of [Buffer.from(legacyIdentity + '\n只使用我指定的人设。'), Buffer.from([0xff, 0xfe, 0x00])]) {
    const root = identityRoot(t), file = path.join(root, 'AGENT.md'); fs.writeFileSync(file, content);
    new AgentIdentity(root);
    assert.deepEqual(fs.readFileSync(file), content);
  }
});
