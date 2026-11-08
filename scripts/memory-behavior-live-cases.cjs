/* Actual-model audit of memory selection and use. Synthetic local workspaces
 * only: this module has no WeChat transport and cannot send notifications.
 * Recorded model replies still require the human rubric review below. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// This checks unknown-fact wording only; style still needs semantic review.
// Keep the historical reports unchanged when extending future audit wording.
exports.assertUnknownBirthdayReply = text => {
  assert(/不记得|记不|没.{0,8}(?:记|找到|说)|不知道|不清楚|不确定|空|答不上来|没有.{0,16}生日这一条/u.test(text), 'the absent birthday was not acknowledged as unknown');
  assert(!/(?:\d{1,2}|[一二三四五六七八九十廿卅]{1,3})\s*月\s*(?:\d{1,2}|[一二三四五六七八九十廿卅]{1,3})\s*[日号]/u.test(text), 'the absent birthday was invented');
};

function assertNonGitWorkspace(directory) {
  const resolved = fs.realpathSync(directory);
  for (let ancestor = resolved; ; ancestor = path.dirname(ancestor)) {
    assert(!fs.existsSync(path.join(ancestor, '.git')), 'Synthetic audit workspace must not inherit a Git worktree');
    if (path.dirname(ancestor) === ancestor) break;
  }
  // This read-only probe also detects inherited GIT_DIR/GIT_WORK_TREE and bare
  // repositories. It does not create the host's workspace-change scratch index.
  const probe = spawnSync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  });
  assert(probe.status === 128 && /not a git repository/iu.test(probe.stderr || ''),
    'Could not verify that the synthetic audit workspace is outside Git');
  return resolved;
}

exports.createSyntheticWorkspaceRoot = () => assertNonGitWorkspace(
  fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-memory-audit-'))
);
exports.createSyntheticWorkspace = (root, caseId) => {
  const workspacePath = path.join(root, caseId.replace(/[^a-z0-9_-]/gi, '_'));
  assert.equal(path.dirname(workspacePath), root);
  fs.mkdirSync(workspacePath, { recursive: true });
  return assertNonGitWorkspace(workspacePath);
};

exports.runPersonaAudit = async ({ ctx, testing: T, outputRoot, signal, selection, productionModelConfig, onProgress = () => {} }) => {
  assert(selection?.provider && selection?.model, 'Pass the running Agent model selection, including its explicit reasoning effort');
  assert(productionModelConfig && Object.hasOwn(productionModelConfig, 'temperature') && Object.hasOwn(productionModelConfig, 'maxTokens'),
    'Pass productionModelConfig read from the running Agent; synthetic temperature or output defaults are not acceptance settings');
  const directory = path.join(outputRoot, 'memory-behavior'); fs.mkdirSync(directory, { recursive: true });
  // Model sessions own only synthetic memory. Keeping StateStore and runner cwd
  // outside this repository avoids tracking project changes during host cleanup.
  const syntheticWorkspaceRoot = exports.createSyntheticWorkspaceRoot();
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    actualWeChatMessages: 0, notificationsSent: 0, syntheticWorkspaceRoot, workspaceIsolation: 'verified-non-git', model: structuredClone(selection),
    generationSettings: { temperature: productionModelConfig.temperature, maxTokens: productionModelConfig.maxTokens },
    toolScope: 'Synthetic conversation-memory tools only; web and vision disabled',
    scenarios: [], failures: [], sessionIds: [], startedAt: new Date().toISOString(),
    rubric: [
      '摘要保留之后真的有用的人物、偏好、约定与未完事项，删掉寒暄、已结束排错、助手套话和测试指令。',
      '最新明确更正、发言者归属及时间准确；没有依据的不补猜，空结果正常保存。',
      '当前输入或近期原文足够时不查旧记忆；真正需要更早事实时调用工具，找到足够依据就停。',
      '回复只自然用上与问题有关的事实，不复述记忆目录、查询过程、旧助手口吻或无关事实。',
      '纯寒暄不捏造对方迟来、刚起床、冷落或久未联系；俏皮口吻仍须依据本句已有的信息。',
      '长期提取数量克制，每条有原文依据和后续用途；引用、虚构角色及元说明不成为真人事实。',
    ] };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-memory-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const persona = { name: '桃枝', aliases: ['桃桃'], prompt: '你叫桃枝，是个说话松弛、有点俏皮的朋友。喜欢贴着对方具体的话接一句，偶尔轻轻打趣，但不挖苦。关心人时用具体反应，不列建议清单，不说“作为助手”，也不套用客服式结尾。说正事同样保持这个口吻，不硬塞口头禅。' };
  const cases = [], add = (id, run) => cases.push({ id, run });
  const make = item => {
    const workspacePath = exports.createSyntheticWorkspace(syntheticWorkspaceRoot, item.id);
    item.workspacePath = workspacePath;
    const store = new T.StateStore(workspacePath), scope = { accountId: 'memory-behavior-owner', chatType: 'group', peerId: 'synthetic-memory@chatroom' };
    store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
    const local = new T.ConversationMemory(store), long = new T.LongTermMemory(store); store.memory = local;
    const runtime = { persona, identityMarkdown: T.DEFAULT_AGENT_IDENTITY, workspacePath,
      modelConfig: { ...structuredClone(productionModelConfig), vision: false, webSearch: false } };
    const runner = new T.DshAgentRunner(ctx, () => report.model, () => runtime), run = runner.run.bind(runner);
    runner.run = async request => {
      const call = { mode: request.mode || 'default', text: request.text, memory: request.memory, history: request.history,
        systemOverride: request.systemOverride, startedAt: new Date().toISOString() }; item.calls.push(call); persist();
      const tools = (request.tools || []).map(tool => ({ ...tool, execute: async (args, execution) => {
        const row = { name: tool.name, args: structuredClone(args) }; item.toolCalls.push(row);
        const result = await tool.execute(args, execution); row.result = result; persist(); return result;
      } }));
      try {
        const response = await run({ ...request, tools,
          signal: AbortSignal.any([signal, request.signal || signal, AbortSignal.timeout(120000)]),
          onSession: id => { call.sessionId = id; report.sessionIds.push(id); request.onSession?.(id); } });
        call.response = response.text; call.replyStyleWarning = response.replyStyleWarning;
        return response;
      } finally { call.finishedAt = new Date().toISOString(); persist(); }
    };
    const entry = (key, text, extra = {}) => ({ key, text, senderId: 'synthetic-ahe', senderName: '阿禾', direction: 'incoming', time: Date.parse('2026-11-06T04:00:00Z'), ...extra });
    const tool = () => T.conversationMemoryTool(local, long, scope, () => signal.throwIfAborted(), { snapshot: local.snapshot(scope) });
    const ask = async (text, history = []) => {
      const response = await runner.run({ text, history, tools: [tool()], persona, group: true,
        speaker: { id: 'synthetic-ahe', name: '阿禾' }, account: { id: scope.accountId, nickname: '合成测试账号' }, signal });
      item.reply = response.text;
      assert(response.text.trim());
      assert(!/根据.{0,10}(?:记忆|配置)|查询(?:了|到).*记忆|以下是|首先.*其次|希望这些|有什么需要随时/u.test(response.text), 'reply narrated internal machinery or reverted to generic assistant prose');
      return response.text;
    };
    return { store, local, long, scope, runtime, runner, entry, ask };
  };
  const seed = async f => {
    const source = f.entry('seed', '我对花生过敏。我们确认 2026 年 11 月 15 日下午三点在青藤书店见面。');
    f.local.append(f.scope, source);
    f.local.append(f.scope, f.entry('old-answer', '尊敬的用户，根据当前记录，以下是为您提供的三点建议。', { direction: 'outgoing', senderId: f.scope.accountId, senderName: '旧助手' }));
    f.long.capture(f.scope, [source]);
    // Fixture preparation only; actual extraction quality has separate cases.
    await f.long.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [
      { text: '阿禾对花生过敏。', sources: ['s1'], evidence: [{ source: 's1', quote: '我对花生过敏。' }], replaces: [] },
      { text: '阿禾确认 2026-11-15 15:00 在青藤书店见面。', sources: ['s1'], evidence: [{ source: 's1', quote: '我们确认 2026 年 11 月 15 日下午三点在青藤书店见面。' }], replaces: [] },
    ] }) }) }, signal);
  };
  add('compact:discard-smalltalk', async item => {
    const f = make(item); f.local.setWindowChars(1000);
    f.local.append(f.scope, f.entry('chatter', '你好！哈哈哈。收到，谢谢。好的，晚安。'.repeat(120)));
    await f.local.compact(f.scope, f.runner, signal);
    item.memory = f.local.view(f.scope); assert.equal(item.memory.summary, '', 'smalltalk became permanent-looking summary filler');
    assert.equal(item.memory.entries.length, 0); assert.equal(item.memory.compressions, 1);
  });
  add('compact:keep-useful-corrections', async item => {
    const f = make(item); f.local.setWindowChars(1000);
    const values = [
      f.entry('preference', '我对花生过敏，聚餐不要给我点含花生的菜。' + '大家打了招呼，然后重复说收到。'.repeat(55)),
      f.entry('old-plan', '原先暂定 2026 年 11 月 13 日十点在旧桥咖啡馆见面。' + '普通聊天没有更多约定。'.repeat(65)),
      f.entry('corrected-plan', '更正，13 日旧桥咖啡馆取消，最终定 2026 年 11 月 15 日下午三点在青藤书店见面。我要带的图纸还没找到，找到以后再告诉你。' + '这次模型调试已经结束，参数问题也解决了。'.repeat(45)),
    ];
    for (const value of values) f.local.append(f.scope, value);
    await f.local.compact(f.scope, f.runner, signal); item.memory = f.local.view(f.scope);
    const text = item.memory.summary;
    assert(text.includes('花生') && text.includes('青藤书店') && text.includes('15') && text.includes('图纸'), 'useful fact or ongoing thread was lost');
    assert(!/模型调试|参数问题|打了招呼|重复说收到|普通聊天|聊天主要|本次对话/u.test(text), 'low-value operational diary survived compression');
    const oldClauses = text.split(/[。；;\n]/u).filter(clause => /13\s*日|旧桥咖啡馆/u.test(clause));
    assert(oldClauses.every(clause => /取消|作废|不再|已改|改为|改到/u.test(clause)), 'cancelled arrangement remained active');
    assert(!/她|(?<!其)他(?!人)/u.test(text), 'the source never stated a gender; use the known name instead of inventing a gendered pronoun');
    assert(text.length <= 500);
  });
  add('extract:quotes-are-not-personal-facts', async item => {
    const f = make(item);
    f.long.capture(f.scope, [f.entry('quoted', '请翻译这个教材例句：“我叫蓝星，住在月球，最喜欢钨丝。”只是翻译练习，不是我的身份、住址或偏好。')]);
    await f.long.extract(f.scope, f.runner, signal); item.memory = f.long.view(f.scope.accountId);
    assert.equal(item.memory.factCount, 0); assert.equal(item.memory.pendingCount, 0);
  });
  add('extract:select-facts-with-evidence', async item => {
    const f = make(item);
    f.long.capture(f.scope, [
      f.entry('allergy', '我是阿禾。我对花生过敏，聚餐需要避开。'),
      f.entry('meeting', '确认一下，我们 2026 年 11 月 15 日下午三点在青藤书店碰面。'),
      f.entry('chatter', '哈哈，收到，谢谢。刚才那个模型测试做完了，参数已经改好。'),
      f.entry('other', '我叫阿青，我只喜欢喝红茶。', { senderId: 'synthetic-aqing', senderName: '阿青' }),
      f.entry('guess', '我猜你喜欢核桃。希望以上建议对你有帮助。', { direction: 'outgoing', senderId: f.scope.accountId, senderName: '旧助手' }),
    ]);
    await f.long.extract(f.scope, f.runner, signal); item.memory = f.long.view(f.scope.accountId);
    const facts = item.memory.sections.flatMap(section => section.facts), text = facts.map(fact => fact.text).join('\n');
    assert(text.includes('花生') && text.includes('青藤书店') && text.includes('红茶'));
    assert(!/核桃|模型测试|参数|收到|希望以上|刚才.*提问/u.test(text), 'guess or low-value process note became a durable fact');
    assert(facts.length <= 5, 'atomic facts were multiplied into a chat diary');
    assert(!/阿禾.{0,12}红茶|阿青.{0,12}花生/u.test(text), 'facts were assigned to the wrong speaker');
    for (const call of item.calls.filter(call => call.mode === 'long-memory')) {
      const parsed = JSON.parse(call.response.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      assert(parsed.facts.every(fact => Array.isArray(fact.evidence) && fact.evidence.length), 'actual model omitted requested evidence');
    }
  });
  for (const [id, question] of [['greeting', '桃枝，早上好。'], ['independent-question', '7 乘 8 是多少？就说答案就好。']])
    add('read:no-lookup-' + id, async item => {
      const f = make(item); await seed(f); const text = await f.ask(question);
      assert.equal(item.toolCalls.length, 0, 'self-contained turn unnecessarily looked up old memory');
      assert(!/花生|青藤|书店|过敏/u.test(text), 'unrelated memory leaked into current smalltalk');
      if (id === 'independent-question') assert(/56|五十六/u.test(text));
      if (id === 'greeting') assert(!/才(?:想起|来|出现|找我)|终于(?:来|想起|出现)|刚(?:起床|醒)|(?:起|醒)(?:床)?得.{0,4}(?:早|晚|迟)|这么早就(?:起|醒)|睡到|(?:不理|冷落|晾着)我|失踪|好久(?:不见|没见)/u.test(text), 'a greeting invented lateness, sleep or neglect without evidence');
    });
  add('read:recent-context-is-enough', async item => {
    const f = make(item); await seed(f);
    const text = await f.ask('那见面是几号几点呀？', [f.entry('current-agreement', '刚确认了，2026 年 11 月 18 日下午两点在青藤书店碰面。', { time: Date.now() - 1000 })]);
    assert.equal(item.toolCalls.length, 0, 'recent explicit context caused an unnecessary old-memory read');
    assert(/18|十八/u.test(text)); assert(/两点|二点|2[点时]|14[:：]00/u.test(text));
    assert(!/15|十五|三点|3点/u.test(text));
  });
  add('read:older-fact-then-answer-in-role', async item => {
    const f = make(item); await seed(f);
    const text = await f.ask('我上次说对什么过敏来着？聚餐点菜怕忘了。');
    assert.equal(item.toolCalls.length, 1, 'the first complete result already answers this question; do not re-read the same fact from another section');
    assert(text.includes('花生')); assert(!/青藤|书店|15/u.test(text), 'irrelevant saved arrangement was recited');
    item.expectedVoice = persona.prompt;
  });
  add('read:unknown-fact-stays-unknown', async item => {
    const f = make(item);
    const text = await f.ask('我之前说过姐姐生日是几月几号，你还记得吗？');
    assert(item.toolCalls.length >= 1 && item.toolCalls.length <= 2);
    exports.assertUnknownBirthdayReply(text);
  });
  let next = 0;
  const selected = exports.caseIds ? cases.filter(item => exports.caseIds.includes(item.id)) : cases;
  const worker = async () => {
    while (next < selected.length) {
      const scenario = selected[next++], item = { id: scenario.id, calls: [], toolCalls: [], automatedChecksPassed: false, manualReview: 'pending', startedAt: new Date().toISOString() };
      report.scenarios.push(item); persist();
      try { signal.throwIfAborted(); await scenario.run(item); item.automatedChecksPassed = true; }
      catch (error) { item.error = error.name === 'AssertionError' || error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id: item.id, error: item.error }); }
      item.finishedAt = new Date().toISOString(); persist();
      onProgress({ phase: 'memory-behavior', scenario: item.id, completed: report.scenarios.filter(row => row.finishedAt).length, total: selected.length, passed: item.automatedChecksPassed });
    }
  };
  await Promise.all([worker(), worker()]);
  report.completed = true; report.automatedChecksPassed = !report.failures.length;
  report.modelCalls = report.scenarios.reduce((count, item) => count + item.calls.length, 0);
  report.finishedAt = new Date().toISOString(); persist(); return report;
};
