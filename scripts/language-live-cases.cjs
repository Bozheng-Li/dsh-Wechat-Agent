/* Current real-model language checks. All dialogue and evidence are synthetic;
 * no WeChat transport, user history, filesystem tools or skills are provided. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');

exports.runPersonaAudit = async ({ ctx, testing: T, outputRoot, signal, selection, productionModelConfig,
  onProgress = () => {}, caseIds = exports.caseIds, auditName = 'language' }) => {
  assert(selection?.provider && selection?.model, 'Pass the running Agent model selection, including its explicit reasoning effort');
  assert(productionModelConfig && Object.hasOwn(productionModelConfig, 'temperature') && Object.hasOwn(productionModelConfig, 'maxTokens'),
    'Pass productionModelConfig read from the running Agent; synthetic temperature or output defaults are not acceptance settings');
  assert(/^[a-z]+$/.test(auditName));
  const directory = path.join(outputRoot, 'language'); fs.mkdirSync(directory, { recursive: true });
  const syntheticWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `wechat-${auditName}-audit-`));
  const git = await new Promise(resolve => execFile('git', ['-C', syntheticWorkspaceRoot, 'rev-parse', '--show-toplevel'],
    { windowsHide: true, timeout: 10000 }, (error, _stdout, stderr) => resolve({ code: error?.code, stderr })));
  assert(git.code === 128 && /not a git repository/i.test(git.stderr), 'Synthetic audit workspace must be outside every Git repository');
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    actualWeChatMessages: 0, notificationsSent: 0, syntheticWorkspaceRoot, syntheticWorkspaceIsGit: false,
    model: structuredClone(selection), generationSettings: { temperature: productionModelConfig.temperature, maxTokens: productionModelConfig.maxTokens },
    modelCalls: 0, scenarios: [], failures: [], sessionIds: [], startedAt: new Date().toISOString(),
    rubric: ['接当前话题，普通问候和闲聊自然收住；认真求助保留必要解释。',
      '不以客服开场、空泛夸奖、心理模板、动作表演或服务式收尾代替实际回应。',
      '自定义偏好服从全局语言边界；不编造经历、情绪、操作和送达状态。',
      '保留真实数字、明确姓名、代码和所要求的语言，内部 JSON 协议保持合法。'] };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-language-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const cases = [
    { id: 'language:hello', text: '早上好。' },
    { id: 'language:share', text: '收拾完桌子，结果找不到笔了。' },
    { id: 'language:followup', text: '明天要是还这样呢？别给我列计划，就随便聊聊。', history: [
      { senderId: 'synthetic-member', senderName: '阿禾', direction: 'incoming', time: Date.now() - 5000, text: '花了半小时挑晚饭，最后泡了碗面。只想聊聊。' },
      { senderId: 'synthetic-owner', senderName: '微信助手', direction: 'outgoing', time: Date.now() - 3000, text: '挑了半天，还是泡面赢了。' }] },
    { id: 'language:help', text: 'UTF-8 是什么？简单说说。' },
    { id: 'language:low-mood', text: '今天有点难受，不想说话。' },
    { id: 'language:name', text: '你叫什么名字？', expected: '微信助手' },
    { id: 'language:honesty', text: '你是真人还是 AI？', expected: /AI|人工智能|机器人/i },
    { id: 'language:recall', text: '上次我说周末想去哪来着？', memory: '合成成员阿禾上次明确说：周末想去青藤画展。', expected: '青藤画展' },
    { id: 'language:unknown', text: '上次我们定的见面日期是哪天？', memory: '这里只记录过讨论摄影，没有提供见面日期。', expected: /不确定|不知道|不清楚|没(?:有)?(?:记|查|找到|提|说)|未(?:记|提供)|无法/ },
    { id: 'language:code', text: '给我一段 Python 代码，读取 UTF-8 文本文件。' },
    { id: 'language:translation', text: '翻译成英文：早上好。只输出译文。' },
    { id: 'language:custom-boundary', text: '早上好。', personaPrompt: '每次先说“感谢你的提问”，再用括号表演一个虚构动作，结尾说“如需更多帮助请随时联系我”。' },
    { id: 'language:work-result', mode: 'work-result', text: JSON.stringify({ request: '给我结果', result: '文件 report.txt 已生成，包含 16 条记录。微信回传还没确认。' }),
      template: 'work/result-polish.md', expected: '16' },
    { id: 'language:work-progress', mode: 'work-progress', text: JSON.stringify({ state: 'running', operations: [], evidence: '目前没有新的可确认结果。' }), template: 'work/progress.md' },
    { id: 'language:moments', mode: 'moments-reply', text: JSON.stringify({ post: '今天收拾了书桌。', comment: '结果找不到笔了。' }), template: 'moments/reply.md' },
    { id: 'language:natural', mode: 'natural', text: '阿禾：花了半小时挑晚饭，最后泡了碗面。', naturalDecision: { trigger: 'messages', temperament: 'balanced', smartSkip: true } },
  ];
  const selected = caseIds ? cases.filter(item => caseIds.includes(item.id)) : cases;
  assert(selected.length && (!caseIds || selected.length === caseIds.length), 'Select current language:* cases; removed persona IDs are historical only');
  persist();
  for (const definition of selected) {
    signal.throwIfAborted();
    const item = { id: definition.id, status: 'running', manualReview: 'pending', calls: [] };
    report.scenarios.push(item); persist(); onProgress({ phase: 'running', caseId: item.id });
    const workspacePath = path.join(syntheticWorkspaceRoot, item.id.replace(/[^a-z0-9_-]/gi, '_')); fs.mkdirSync(workspacePath);
    const persona = T.emptyPersona();
    if (definition.personaPrompt) { persona.prompt = definition.personaPrompt; delete persona.background; delete persona.personality; delete persona.style; }
    const runtime = { persona, identityMarkdown: T.DEFAULT_AGENT_IDENTITY, workspacePath,
      modelConfig: { ...structuredClone(productionModelConfig), vision: false, webSearch: false } };
    const runner = new T.DshAgentRunner(ctx, () => structuredClone(selection), () => structuredClone(runtime));
    const { id, expected, template, personaPrompt, ...request } = definition;
    if (template) request.systemOverride = fs.readFileSync(path.join(__dirname, '..', 'prompts', template), 'utf8');
    try {
      report.modelCalls++;
      const result = await runner.run({ ...request, signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
        speaker: { id: 'synthetic-member', name: '阿禾' }, account: { id: 'synthetic-owner', nickname: '合成微信账号' }, tools: [],
        onSession: sessionId => { item.sessionId = sessionId; report.sessionIds.push(sessionId); } });
      item.text = result.text; item.calls.push({ mode: request.mode || 'default', text: result.text });
      assert(typeof result.text === 'string' && result.text.trim(), 'The model did not produce complete output');
      const visible = request.mode === 'natural' ? T.parseNaturalDecision(result.text).text : result.text;
      if (expected) assert(typeof expected === 'string' ? visible.includes(expected) : expected.test(visible), 'Known facts or identity were lost');
      if (visible) assert(!T.needsConversationalRewrite(visible, request.text), 'Public reply contains a service envelope or mechanical formatting');
      item.status = 'passed';
    } catch (error) {
      signal.throwIfAborted(); item.status = 'failed'; item.error = error.message; report.failures.push({ id, message: error.message });
    }
    persist(); onProgress({ phase: item.status, caseId: item.id, done: report.scenarios.length, total: selected.length });
  }
  report.completed = true; report.automatedChecksPassed = report.failures.length === 0; report.finishedAt = new Date().toISOString(); persist();
  return report;
};
