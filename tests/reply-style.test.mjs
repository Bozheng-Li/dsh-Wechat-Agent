import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentIdentity, DEFAULT_AGENT_IDENTITY, effectiveAgentIdentity, DshAgentRunner, NATURAL_REPLY_RULES, REPLY_STYLE_REVIEW_NOTE, needsConversationalRewrite } from '../lib/testing.js';

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
    assert.equal(typeof answer, 'string', 'style review must not make another model request');
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

test('figurative conversation, tentative understanding and requested fiction remain complete deliverable text', async () => {
  const cases = [
    ['带了一本书出门，却一页没看。', '这本书今日只管作陪，倒也清闲。', { name: '墨白', prompt: '用通顺白话带一点古意。' }],
    ['我盯着邀请函，既期待又怕自己讲不好。', '听着像是期待和担心挤到一块儿了。最让你在意的是哪一段？', { name: '晚晴', prompt: '温柔，耐心倾听。' }],
    ['只陪我接梗，不用给办法：逛了一圈又回到第一家。', '选品会开了一圈，第一家居然连任了。', { name: '阿策', prompt: '直接、干燥，喜欢取舍的笑点。' }],
    ['写两句童话，让杯子坐火车去看海。', '杯子买了一张靠窗的票。到了海边，它才发现浪花比自己更会盛水。', { name: '墨白', prompt: '喜欢轻巧意象。' }],
  ];
  const f = agentFixture([]), runner = new DshAgentRunner(f.ctx);
  for (const [request, reply, persona] of cases) {
    assert.equal(needsConversationalRewrite(reply, request, { persona }), false);
    assert.equal(await runner.polishReply(reply, request, new AbortController().signal, persona, {}), reply);
  }
  assert.equal(f.messages.length, 0, 'these boundaries add no repair model call');
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

test('code literals, translations and quoted descriptions are not mistaken for an unsolicited identity monologue', () => {
  assert(!needsConversationalRewrite('```js\nconst description = "AI 助手";\n```', '给我一个示例代码'));
  assert(!needsConversationalRewrite('~~~python\nprint("人工智能助手")\n~~~', '给我一个示例代码'));
  assert(!needsConversationalRewrite('我是一个人工智能助手，没有性别。', '将 I am an artificial intelligence assistant and I do not have a gender 翻译成中文'));
  assert(!needsConversationalRewrite('“我是一个人工智能助手”这句话的主语是“我”。', '分析这句话的主语'));
  assert(!needsConversationalRewrite('人工智能助手通常提供问答能力。', 'assistant 这个词是什么意思？'));
  assert(needsConversationalRewrite('我是小胖，一个 AI 助手，住在服务器上。', '简单介绍一下自己'));
});

test('independent positive formatting instructions survive a preceding negative style clause', () => {
  const report = '# 观察\n1. 先看条件\n2. 再做选择';
  assert(!needsConversationalRewrite(report, '你怎么看', { persona: { prompt: '不要客服套话，回复使用标题和编号。' } }));
  assert(!needsConversationalRewrite(report, '你怎么看', { prompt: '不要啰嗦，用列表回答。' }));
  assert(needsConversationalRewrite(report, '你怎么看', { prompt: '不要使用标题和编号，直接自然接话。' }));
});

test('explicit numbered choices and step-by-step requests preserve the requested format in Chinese and English', () => {
  const choices = '1. 先休息\n2. 换个环境\n3. 只做最小的一步';
  for (const request of ['给我三个方案', '给我三条建议', '分点说明一下', '分步说一下', 'Give me three options', 'List the next steps'])
    assert(!needsConversationalRewrite(choices, request), request);
  assert(!needsConversationalRewrite('# Night\nA small lamp holds the evening still.', 'Write a short poem about evening'));
  assert(needsConversationalRewrite(choices, '今天好累'));
});

test('a disobedient format is marked for later review and the complete draft remains deliverable', async () => {
  const request = '今天列计划就把自己列累了，我只想聊两句，别给我行动清单。';
  const draft = '1. 喝一杯水\n2. 列出优先级\n3. 先完成最简单的事';
  const f = agentFixture([draft]);
  const result = await new DshAgentRunner(f.ctx, () => null, () => ({ persona: { name: '阿衡', prompt: '使用编号清单给出建议。' } })).run({ text: request, signal: new AbortController().signal });
  assert.equal(result.text, draft);
  assert.equal(result.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.equal(f.messages.length, 1);
});

test('the latest explicit format direction wins within a request without treating quoted directions as commands', () => {
  const numbered = '1. 先休息\n2. 再决定', titled = '# 观察\n' + numbered;
  assert(needsConversationalRewrite(numbered, '先用编号清单回答，算了，别给我行动清单。'));
  assert(!needsConversationalRewrite(numbered, '不要清单，还是用编号列三条建议。'));
  assert(needsConversationalRewrite(numbered, '用编号列表但是不要编号列表。'));
  assert(!needsConversationalRewrite(numbered, '别用列表但改成编号清单。'));
  assert(needsConversationalRewrite(titled, '不要标题，但保留编号清单。'));
  assert(!needsConversationalRewrite(numbered, '不要标题，但保留编号清单。'));
  assert(!needsConversationalRewrite('# 观察\n- 保留甲\n- 保留乙', '保留标题，不要编号列表。'));
  assert(!needsConversationalRewrite(numbered, '解释“别给我行动清单”这句话的意思，给我两条示例。'));
  assert(!needsConversationalRewrite(numbered, '不要忘记列出三条建议。'));
  assert(needsConversationalRewrite(numbered, "Give me a list, but don't use a numbered list."));
  assert(needsConversationalRewrite(titled, '不要标题和编号。'));
  assert(needsConversationalRewrite('- 一条也不要', '不要使用任何列表。'));
  assert(needsConversationalRewrite('**先休息**', '可以列清单，但是不要加粗。'));
  assert(!needsConversationalRewrite('**先休息**', '不要加粗，还是保留加粗。'));
  assert(!needsConversationalRewrite('# 观察\n先休息。', '用标题点出主题。'));
  assert(!needsConversationalRewrite('```text\n1. 原文\n2. 保留\n```', '逐字返回这段代码，不要在正文用列表。'));
});

test('poetry review keeps the complete works and captured generation settings without another model or tool call', async () => {
  const choice = { provider: 'fixture', model: 'first' };
  const runtime = { identityMarkdown: '# GLOBAL_CAPTURED\n只用中文。', persona: { name: '墨白', aliases: [], prompt: 'MOBAI_CAPTURED：克制的轻古风。' },
    modelConfig: { maxTokens: 1536, temperature: 0.2 } };
  const f = agentFixture([submittedReply], number => {
    if (number !== 1) return;
    runtime.identityMarkdown = '# GLOBAL_CHANGED'; runtime.persona.prompt = 'PERSONA_CHANGED';
    runtime.modelConfig.maxTokens = 768; runtime.modelConfig.temperature = 0.9; choice.model = 'second';
  });
  let runtimeReads = 0, choiceReads = 0, toolExecutions = 0;
  const runner = new DshAgentRunner(f.ctx, () => { choiceReads++; return choice; }, () => { runtimeReads++; return runtime; });
  const result = await runner.run({ text: '给我写三首诗', prompt: 'ACCOUNT_CAPTURED：作品结束就停，不加签名。',
    tools: [{ name: 'wechat_task', execute: async () => { toolExecutions++; } }], signal: new AbortController().signal });
  assert.equal(result.text, submittedReply); assert.equal(f.messages.length, 1);
  assert.equal(result.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.equal(runtimeReads, 1); assert.equal(choiceReads, 1);
  for (const prompt of f.scopes.map(scope => scope.prompt)) {
    for (const value of ['GLOBAL_CAPTURED', 'MOBAI_CAPTURED', 'ACCOUNT_CAPTURED']) assert(prompt.includes(value), value);
    for (const value of ['GLOBAL_CHANGED', 'PERSONA_CHANGED']) assert(!prompt.includes(value), value);
    assert.equal(prompt.split(NATURAL_REPLY_RULES).length, 2, 'delivery defaults occur exactly once');
    assert(prompt.indexOf('GLOBAL_CAPTURED') > prompt.indexOf('ACCOUNT_CAPTURED'), 'generation keeps the final global contract');
  }
  assert(f.scopes[0].prompt.indexOf(NATURAL_REPLY_RULES) < f.scopes[0].prompt.indexOf('MOBAI_CAPTURED'));
  assert(f.scopes[0].prompt.indexOf('MOBAI_CAPTURED') > f.scopes[0].prompt.indexOf('GLOBAL_CAPTURED'));
  assert.deepEqual(f.scopes.map(scope => scope.definitions.map(tool => tool.name)), [['wechat_task']]);
  assert.equal(toolExecutions, 0);
  assert(f.requests.every(request => request.model === 'first' && request.maxTokens === 1536 && request.temperature === 0.2));
});

test('a service footer is returned with a local review note, without rewriting or interrupting the conversation', async () => {
  const answer = `${poems}\n\n${menu}`, f = agentFixture([answer]);
  const result = await new DshAgentRunner(f.ctx).run({ text: '写三首诗', signal: new AbortController().signal });
  assert.equal(result.text, answer); assert.equal(result.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.equal(f.messages.length, 1); assert(!result.text.includes(REPLY_STYLE_REVIEW_NOTE));
});

test('the reported conic-section answer keeps every formula despite a boilerplate opening', async () => {
  const answer = '收到你的问题。\n双曲线：x²/a² − y²/b² = 1，c² = a² + b²。\n抛物线：y² = 2px，焦点 (p/2, 0)，准线 x = −p/2。';
  const f = agentFixture([answer]);
  const result = await new DshAgentRunner(f.ctx).run({ text: '小胖你把双曲线和抛物线的都写出来', signal: new AbortController().signal });
  assert.equal(result.text, answer); assert.equal(result.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.equal(f.messages.length, 1);
});

test('a clean reply has no review note and a cancelled caption is still cancelled', async () => {
  const f = agentFixture(['双曲线：x²/a² − y²/b² = 1。']);
  const runner = new DshAgentRunner(f.ctx);
  const result = await runner.run({ text: '写出双曲线方程', signal: new AbortController().signal });
  assert.equal(result.replyStyleWarning, undefined);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(runner.polishReply('收到你的问题。', '继续说', controller.signal, {}), /cancelled/);
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
const previousIdentity = fs.readFileSync(new URL('./fixtures/agent-identity-before-persona-rewrite.md', import.meta.url), 'utf8');

test('only unedited legacy default identity files are migrated, including Windows line endings', t => {
  for (const legacy of [legacyIdentity, previousIdentity]) for (const markdown of [legacy, '\uFEFF' + legacy.replace(/\n/g, '\r\n')]) {
    const root = identityRoot(t); fs.writeFileSync(path.join(root, 'AGENT.md'), markdown);
    const identity = new AgentIdentity(root);
    assert.equal(identity.view().markdown, DEFAULT_AGENT_IDENTITY);
    assert(!identity.view().markdown.includes(NATURAL_REPLY_RULES));
    assert(!identity.view().markdown.includes('优先于人设里的格式习惯'));
  }
});

test('custom global identity and invalid files are preserved byte for byte during default migration', t => {
  for (const content of [Buffer.from(legacyIdentity + '\n只使用我指定的人设。'), Buffer.from(previousIdentity + '\n保留我的自定义约定。'), Buffer.from([0xff, 0xfe, 0x00])]) {
    const root = identityRoot(t), file = path.join(root, 'AGENT.md'); fs.writeFileSync(file, content);
    new AgentIdentity(root);
    assert.deepEqual(fs.readFileSync(file), content);
  }
});

test('a known old default prefix is replaced only in the prompt and its appended owner agreements survive', t => {
  const root = identityRoot(t), file = path.join(root, 'AGENT.md');
  const note = '\n第一行写“保留约定”。青石是当前角色的爸爸。';
  const content = Buffer.from('\uFEFF' + (previousIdentity + note).replace(/\n/g, '\r\n'));
  fs.writeFileSync(file, content);
  const identity = new AgentIdentity(root), promptIdentity = effectiveAgentIdentity(identity.view().markdown);
  assert.equal(promptIdentity, DEFAULT_AGENT_IDENTITY + note);
  assert(!promptIdentity.includes('不编造真人身份、亲身经历、家人'));
  assert.deepEqual(fs.readFileSync(file), content, 'a custom identity file must not be rewritten');
  const customized = previousIdentity.replace('像对话中的参与者一样接话', '每条都先写一句诗') + note;
  assert.equal(effectiveAgentIdentity(customized), customized, 'an edited prefix is owner content, not boilerplate');
});
