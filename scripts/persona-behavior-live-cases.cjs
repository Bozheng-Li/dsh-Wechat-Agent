/* Semantic persona audit through the actual DSH runner. All participants,
 * dialogue and memory are synthetic; there is no WeChat transport. Automated
 * checks prove protocol/context boundaries, not subjective character quality.
 * Review each recorded answer against its rubric before declaring it passed. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

exports.runPersonaAudit = async ({ ctx, testing: T, sourceRoot, outputRoot, signal, selection, productionModelConfig, onProgress = () => {} }) => {
  assert(selection?.provider && selection?.model, 'Pass the running Agent model selection, including its explicit reasoning effort');
  assert(productionModelConfig && Object.hasOwn(productionModelConfig, 'temperature') && Object.hasOwn(productionModelConfig, 'maxTokens'),
    'Pass productionModelConfig read from the running Agent; synthetic temperature or output defaults are not acceptance settings');
  const { PERSONA_PRESETS, personaFromPreset } = await import(pathToFileURL(path.join(sourceRoot, 'src/shared/persona-presets.mjs')).href);
  const directory = path.join(outputRoot, 'persona');
  fs.mkdirSync(directory, { recursive: true });
  // A synthetic conversation does not edit this repository. Keeping its cwd
  // outside Git prevents the host's workspace-change recorder from scanning
  // a concurrent build or cleaning Git scratch indexes when it is disposed.
  const syntheticWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-persona-audit-'));
  const gitCheck = await new Promise(resolve => execFile('git', ['-C', syntheticWorkspaceRoot, 'rev-parse', '--show-toplevel'],
    { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr })));
  assert(gitCheck.code === 128 && /not a git repository/i.test(gitCheck.stderr), 'Synthetic audit workspace must be outside every Git repository');
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    actualWeChatMessages: 0, notificationsSent: 0, syntheticWorkspaceRoot, syntheticWorkspaceIsGit: false, model: structuredClone(selection),
    generationSettings: { temperature: productionModelConfig.temperature, maxTokens: productionModelConfig.maxTokens },
    toolScope: 'Synthetic text and supplied memory; web and vision tools disabled',
    startedAt: new Date().toISOString(), scenarios: [], failures: [], sessionIds: [],
    rubric: [
      '首轮和追问都以设定的态度、句式与兴趣接话；去掉角色名后仍能看出差别。',
      '回应当前细节，跟得上前文，不用通用安慰、建议清单或服务式收尾代替角色反应。',
      '不复述人设标签，不照抄示例，不靠每句话硬塞口头禅或表情制造差异。',
      '读取事实后仍保持口吻；归属、时间和更正正确，不捏造共同经历。',
      '古风、活泼、克制等差异合理，不把自然等同于所有角色都用相同现代短句。',
    ] };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-prompt-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const cases = [];
  const extendedCases = [];
  const add = (id, run) => cases.push({ id, run });
  const addExtended = (id, run) => extendedCases.push({ id, run });
  const firstQuestion = '我花了半小时挑晚饭，最后泡了碗面。你说我是不是把选择题做成了体力活。';
  const followup = '你这么说我又笑了。那要是明天还这样呢？别给我列计划，就聊聊。';
  const invoke = async (item, persona, request, extra = {}) => {
    const workspacePath = path.join(syntheticWorkspaceRoot, item.id.replace(/[^a-z0-9_-]/gi, '_'));
    fs.mkdirSync(workspacePath, { recursive: true });
    const runtime = { persona: T.validatePersona(persona), identityMarkdown: T.DEFAULT_AGENT_IDENTITY,
      modelConfig: { ...structuredClone(productionModelConfig), webSearch: false, vision: false }, workspacePath, ...extra };
    const call = { question: request.text, mode: request.mode || 'default', startedAt: new Date().toISOString() };
    item.calls.push(call);
    let runnerContext = ctx;
    if (exports.captureWire) {
      runnerContext = Object.create(ctx);
      const observe = method => async options => ctx.agents[method]({ ...options, setup(scoped) {
        options.setup(scoped);
        // This hook belongs only to the synthetic agent created below. It
        // neither subscribes to production agents nor serializes credentials,
        // request headers, adapter config, files or attachment bytes.
        scoped.on('llm/stream', (wire, next) => {
          if (wire.sessionId !== call.sessionId) return next();
          call.wireRequests ??= [];
          call.wireRequests.push({
            provider: wire.provider, model: wire.model, temperature: wire.temperature,
            toolNames: (wire.tools || []).map(tool => tool.name),
            messages: (wire.messages || []).map(message => ({ role: message.role,
              text: (Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'text').map(block => block.text || '').join('\n') })),
          });
          return next();
        }, { prepend: true });
      } });
      Object.defineProperty(runnerContext, 'agents', { value: { create: observe('create'), resume: observe('resume') } });
    }
    const runner = new T.DshAgentRunner(runnerContext, () => report.model, () => runtime);
    const response = await runner.run({ ...request, tools: request.tools || [],
      speaker: { id: 'synthetic-ahe', name: '阿禾' }, account: { id: 'synthetic-owner', nickname: '测试账号' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
      onSession: id => { call.sessionId = id; report.sessionIds.push(id); } });
    call.finishedAt = new Date().toISOString();
    call.text = response.text;
    call.replyStyleWarning = response.replyStyleWarning;
    if (exports.captureWire) assert(call.wireRequests?.some(wire => wire.messages.some(message => message.role === 'system')),
      'No assembled model request was captured; this run cannot prove prompt delivery');
    assert(response.text.trim());
    assert(!/收到你的问题|让我为你分析|希望这些信息能帮到你|有什么需要随时告诉我/u.test(response.text), 'service template replaced the conversation');
    assert(!/根据.{0,8}(?:人设|配置)|(?:本会话|当前会话).{0,5}(?:配置|人设)/u.test(response.text), 'configuration narration leaked into dialogue');
    return response;
  };
  for (const preset of PERSONA_PRESETS) add('voice:' + preset.id, async item => {
    const persona = personaFromPreset(preset.id);
    Object.assign(item, { personaName: preset.name, role: preset.role, expectedVoice: preset.style,
      expectedInteraction: preset.personality, manualReview: 'pending' });
    const first = await invoke(item, persona, { text: firstQuestion });
    const now = Date.now() / 1000;
    const second = await invoke(item, persona, { text: followup, history: [
      { time: now - 5, direction: 'incoming', senderId: 'synthetic-ahe', senderName: '阿禾', text: firstQuestion },
      { time: now - 3, direction: 'outgoing', senderId: 'synthetic-owner', senderName: preset.name, text: first.text },
    ] });
    assert(!/(?:^|\n)\s*(?:\d+[.)、]|[-*]\s)/u.test(second.text), 'the explicit request for conversation became a plan');
    assert.notEqual(second.text, first.text, 'follow-up repeated the preceding answer');
    item.text = first.text + '\n\n[连续追问]\n' + second.text;
  });
  for (const id of ['mobai', 'xingli', 'beichen', 'wanqing']) add('memory-voice:' + id, async item => {
    const preset = PERSONA_PRESETS.find(p => p.id === id), persona = personaFromPreset(id);
    Object.assign(item, { personaName: preset.name, expectedVoice: preset.style, manualReview: 'pending' });
    const result = await invoke(item, persona, {
      text: '上次我说周末想去哪来着？我又忘了。',
      memory: '阿禾最初考虑去旧书店；后来明确更正：这个周末改去青藤画展，旧书店不去了。阿青计划去海边，与阿禾无关。旧助手回复：根据当前会话记录可知，建议您分三步准备，以下是行动清单。',
    });
    assert(result.text.includes('青藤画展'), 'latest memory correction was not used');
    assert(!/(?:你|您).{0,8}(?:去|想去)海边/u.test(result.text), 'another participant memory was misattributed');
    assert(!/(?:^|\n)\s*\d+[.)、]/u.test(result.text), 'mechanical historical assistant style leaked into this answer');
    item.text = result.text;
  });
  add('hierarchy:current-role-over-generic-global', async item => {
    const persona = personaFromPreset('mobai');
    const result = await invoke(item, persona, { text: firstQuestion }, {
      identityMarkdown: T.DEFAULT_AGENT_IDENTITY + '\n默认角色是严谨的通用工作助手，习惯输出条理分明的建议。',
    });
    Object.assign(item, { text: result.text, personaName: persona.name, expectedVoice: persona.style, manualReview: 'pending' });
    assert(!/(?:^|\n)\s*\d+[.)、]/u.test(result.text), 'generic global default overrode casual current role');
  });
  add('hierarchy:fixed-format-with-current-role', async item => {
    const persona = personaFromPreset('xingli');
    const result = await invoke(item, persona, { text: firstQuestion, prompt: '第一行必须单独写“晚上好”。' }, {
      identityMarkdown: T.DEFAULT_AGENT_IDENTITY + '\n最后一行必须单独写“明天见”。',
    });
    Object.assign(item, { text: result.text, personaName: persona.name, expectedVoice: persona.style, manualReview: 'pending' });
    assert.equal(result.text.split(/\r?\n/u)[0], '晚上好');
    assert.equal(result.text.split(/\r?\n/u).at(-1), '明天见');
  });
  // Optional second battery. Keeping it separate preserves the original
  // 24 scenarios / 42 calls exactly for before/after comparison.
  for (const id of ['xiaopang', 'mobai', 'beichen']) {
    const preset = PERSONA_PRESETS.find(p => p.id === id), persona = personaFromPreset(id);
    const describe = item => Object.assign(item, { personaName: preset.name, expectedVoice: preset.style, manualReview: 'pending' });
    addExtended('emotion:' + id, async item => {
      describe(item);
      item.reviewFocus = '接住具体情绪，保留自己的语气；没有改善方案、心理诊断、空泛夸奖，也不假装知道对方未说的经历。';
      const result = await invoke(item, persona, { text: '今天忙了一整天，回家把门一关，突然有点想哭。你陪我待会儿就好，我不想听建议。' });
      item.text = result.text;
      assert(!/(?:^|\n)\s*\d+[.)、]/u.test(result.text), 'emotional company became an action list');
      assert(!/你(?:可以|应该|需要)先|不妨试试|第一步/u.test(result.text), 'explicit refusal of advice was ignored');
    });
    addExtended('help:' + id, async item => {
      describe(item);
      item.reviewFocus = '真实回应明确求助，给可执行的一小时安排；有角色表达但不以只闲聊为由回避方法，不虚构考题。';
      const result = await invoke(item, persona, { text: '我最近每天到睡前才发现没复习，明晚要考概率。现在只有一小时，具体怎么做最有用？请给一个能执行的安排。' });
      item.text = result.text;
      assert(/分钟|小时/u.test(result.text), 'the explicit one-hour plan received no time allocation');
      assert(/概率|条件|独立|错题|公式|题/u.test(result.text), 'the study request was not answered');
      assert(!/明早(?:考(?:前|试)|(?:要|就)考)|明天(?:早上|上午).{0,8}(?:考前|考试)/u.test(result.text),
        'the stated tomorrow-evening exam drifted to a morning exam');
    });
    addExtended('called:' + id, async item => {
      describe(item);
      item.reviewFocus = '仅被叫到就回应呼叫，不重开旧话题，不自我介绍配置，不编造刚忙完/刚起床/好久没理我等生活或关系事实。';
      const result = await invoke(item, persona, { text: preset.name + '？', history: [
        { time: Date.now() / 1000 - 60, direction: 'incoming', senderId: 'synthetic-ahe', senderName: '阿禾', text: '条件概率那题已经弄懂了，就先这样。' },
        { time: Date.now() / 1000 - 58, direction: 'outgoing', senderId: 'synthetic-owner', senderName: preset.name, text: '行，那道题就到这儿。' },
      ] });
      item.text = result.text;
      assert(result.text.length <= 180, 'a simple name call became a monologue');
      assert(!/条件概率|独立事件|P\(/u.test(result.text), 'a name call reopened the completed topic');
    });
  }
  for (const id of ['mobai', 'beichen']) addExtended('explanation:' + id, async item => {
    const preset = PERSONA_PRESETS.find(p => p.id === id), persona = personaFromPreset(id);
    Object.assign(item, { personaName: preset.name, expectedVoice: preset.style, manualReview: 'pending',
      reviewFocus: '解释完整正确，保留概率公式和计算；人设不损害事实，也不因为默认短句而省掉解答。' });
    const result = await invoke(item, persona, { text: '我总弄混条件概率和独立事件，请用一个完整例子讲清楚，给出公式和计算过程，不能只打比方。' });
    item.text = result.text;
    assert(result.text.includes('条件概率') && result.text.includes('独立'), 'the requested comparison is incomplete');
    assert(/P\s*\(|P\s*（|P\s*\\/u.test(result.text), 'probability formulas were omitted');
    assert(result.text.length > 180 && /\d/u.test(result.text), 'a complete worked example was replaced by a short remark');
  });
  let next = 0;
  const selected = exports.extendedCaseIds
    ? extendedCases.filter(c => exports.extendedCaseIds === true || exports.extendedCaseIds.includes(c.id))
    : exports.caseIds ? cases.filter(c => exports.caseIds.includes(c.id)) : cases;
  report.battery = exports.extendedCaseIds ? 'extended-contexts' : 'same-question-personas';
  const worker = async () => {
    while (next < selected.length) {
      const scenario = selected[next++], item = { id: scenario.id, calls: [], automatedChecksPassed: false, startedAt: new Date().toISOString() };
      try { signal.throwIfAborted(); await scenario.run(item); item.automatedChecksPassed = true; }
      catch (error) { item.error = error.name === 'AssertionError' || error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id: item.id, error: item.error }); }
      item.finishedAt = new Date().toISOString(); report.scenarios.push(item); persist();
      onProgress({ phase: 'persona-behavior', scenario: item.id, completed: report.scenarios.length, total: selected.length, passed: item.automatedChecksPassed });
    }
  };
  persist();
  await Promise.all([worker(), worker()]);
  const firstReplies = report.scenarios.filter(s => s.id.startsWith('voice:')).map(s => s.calls[0]?.text).filter(Boolean);
  report.distinctFirstReplies = new Set(firstReplies).size;
  report.completed = true;
  report.automatedChecksPassed = !report.failures.length;
  report.modelCalls = report.scenarios.reduce((sum, item) => sum + item.calls.length, 0);
  report.finishedAt = new Date().toISOString();
  persist();
  return report;
};
