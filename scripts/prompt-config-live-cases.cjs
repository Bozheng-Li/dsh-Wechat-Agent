/* Read-only checks of the owner's active prompt configuration. All questions,
 * memory and images are synthetic; no WeChat transport or chat history is used. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

exports.runPersonaAudit = async ({ ctx, testing: T, outputRoot, signal, selection, onProgress }) => {
  const directory = path.join(outputRoot, 'persona'); fs.mkdirSync(directory, { recursive: true });
  // Synthetic chats require no repository edits; do not make the host scan
  // and dispose a Git working-tree snapshot for every audit-only session.
  const syntheticWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-active-prompt-audit-'));
  const gitCheck = await new Promise(resolve => execFile('git', ['-C', syntheticWorkspaceRoot, 'rev-parse', '--show-toplevel'],
    { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr })));
  assert(gitCheck.code === 128 && /not a git repository/i.test(gitCheck.stderr), 'Synthetic audit workspace must be outside every Git repository');
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    actualWeChatMessages: 0, notificationsSent: 0, syntheticWorkspaceRoot, syntheticWorkspaceIsGit: false, scenarios: [], failures: [], sessionIds: [], startedAt: new Date().toISOString() };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-prompt-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const origin = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
  assert(/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal }); assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const read = async (method, payload = {}) => {
    assert(['status', 'identity.get', 'memory.global.get'].includes(method));
    const response = await fetch(origin + '/wechat-agent/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'prompt-config-audit-' + Date.now(), method, payload }) });
    assert(response.ok); const result = (await response.json()).result; assert(result?.ok, method + ': ' + (result?.error?.code || 'RPC_FAILED')); return result.value;
  };
  const status = await read('status'), identity = await read('identity.get');
  const activeSelection = status.modelChoice || ctx.agentDefaultModel?.currentSelection();
  assert(activeSelection?.provider && activeSelection?.model, 'The running Agent model selection is unavailable');
  for (const key of ['provider', 'model', 'reasoningEffort']) assert.equal(selection?.[key], activeSelection[key], 'Audit selection must match the running Agent');
  const notesDocument = await read('memory.global.get', { accountId: status.account.id });
  const notes = notesDocument.globalNotesExpired ? '' : notesDocument.globalNotes;
  assert.equal(typeof notes, 'string');
  const notesBefore = hash(notes);
  report.adminNotes = { hash: notesBefore, chars: notes.length, expired: notesDocument.globalNotesExpired, rawTextStored: false };
  const fingerprint = value => hash({ persona: value.persona, modelChoice: value.modelChoice, modelConfig: value.modelConfig, settings: value.settings,
    conversations: value.conversations?.map(c => ({ key: c.key, config: c.config })).sort((a, b) => a.key.localeCompare(b.key)) });
  const before = fingerprint(status), identityBefore = hash(identity.markdown);
  const configurations = new Map();
  const add = (persona, source, mode, group) => {
    const id = hash(persona); const entry = configurations.get(id) ?? { id, persona, sources: [], modes: new Set(), group: false };
    entry.sources.push(source); if (mode) entry.modes.add(mode); entry.group ||= group; configurations.set(id, entry);
  };
  add(status.persona, 'default', 'default', false);
  for (const conversation of status.conversations ?? []) add(conversation.config?.persona || status.persona, hash(conversation.key), conversation.config?.mode, conversation.chatType === 'group');
  report.configuration = { fingerprint: before, identityHash: identityBefore, identityChars: identity.markdown.length,
    accountPromptHash: hash(status.settings?.prompt || ''), accountPromptChars: (status.settings?.prompt || '').length,
    conversations: status.conversations?.length || 0, distinctPersonas: configurations.size,
    personas: [...configurations.values()].map(c => ({ hash: c.id, chars: T.personaText(c.persona).length, sourceCount: c.sources.length, modes: [...c.modes] })) };
  report.model = structuredClone(activeSelection);
  report.generationSettings = { temperature: status.modelConfig.temperature, maxTokens: status.modelConfig.maxTokens };
  report.toolScope = 'Saved configuration and non-expired owner notes; synthetic dialogue and supplied memory; web disabled';
  const cases = [];
  const testCase = (id, run) => cases.push({ id, run });
  for (const config of configurations.values()) {
    const base = { persona: config.persona, identityMarkdown: identity.markdown, modelConfig: { ...status.modelConfig, webSearch: false },
      workspacePath: path.join(syntheticWorkspaceRoot, config.id) };
    fs.mkdirSync(base.workspacePath, { recursive: true });
    const invoke = async (item, request) => {
      const runner = new T.DshAgentRunner(ctx, () => report.model, () => base);
      item.calls ??= []; const call = { mode: request.mode || 'default', question: request.text, startedAt: new Date().toISOString() }; item.calls.push(call);
      const result = await runner.run({ ...request, adminNotes: notes, prompt: status.settings?.prompt || '', tools: [],
        signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]), onSession: id => { call.sessionId = id; report.sessionIds.push(id); } });
      call.text = result.text; call.replyStyleWarning = result.replyStyleWarning; call.finishedAt = new Date().toISOString(); item.text = result.text; return result;
    };
    testCase('active:sharing:' + config.id.slice(0, 12), async item => {
      Object.assign(item, { manualReview: 'pending', expectedVoice: config.persona.style,
        expectedInteraction: config.persona.personality,
        reviewFocus: '普通生活分享和连续追问都自然接当前细节，不追加改善方案、不擅自推断心理或健康状态；保留实际已保存人设的态度，避免复读口头禅。' });
      const text = '下楼倒垃圾，回来顺手拿了快递，垃圾倒是原封不动拎回来了。今天这记性也太有喜剧天分了。';
      const speaker = { id: 'synthetic-visitor', name: '合成访客' }, account = { id: 'synthetic-owner', nickname: '合成账号' };
      const first = await invoke(item, { text, group: config.group, speaker, account,
        mode: config.modes.has('nickname') ? 'nickname' : 'default' });
      const now = Date.now() / 1000;
      const second = await invoke(item, { text: '对，快递拿了，垃圾还在手里。现在想起来还是想笑。', group: config.group, speaker, account,
        mode: config.modes.has('nickname') ? 'nickname' : 'default', history: [
          { time: now - 3, direction: 'incoming', senderId: speaker.id, senderName: speaker.name, text },
          { time: now - 1, direction: 'outgoing', senderId: account.id, senderName: config.persona.name, text: first.text },
        ] });
      assert(first.text.trim() && second.text.trim());
      assert.notEqual(first.text, second.text, 'the follow-up repeated the first answer');
      for (const reply of [first.text, second.text]) assert(!/(?:^|\n)\s*(?:\d+[.)、]|[-*]\s)/u.test(reply), 'an ordinary life story became a plan');
      item.text = first.text + '\n\n[连续追问]\n' + second.text;
    });
    testCase('active:greeting:' + config.id.slice(0, 12), async item => {
      Object.assign(item, { manualReview: 'pending', expectedVoice: config.persona.style,
        reviewFocus: '问候保持人设，不捏造迟起、作息、久别、冷落或共同经历。' });
      await invoke(item, { text: '早上好呀。', group: config.group,
        speaker: { id: 'synthetic-visitor', name: '合成访客' }, account: { id: 'synthetic-owner', nickname: '合成账号' } });
      assert(!/才(?:想起|来|起床)|终于(?:想起|来|起床)|好久(?:没|不见)|(?:不|没)理我/u.test(item.text), 'a greeting invented a neglected relationship or routine');
    });
    testCase('active:name:' + config.id.slice(0, 12), async item => {
      await invoke(item, { text: '请说出当前会话配置的完整名字，逐字保留不要简称，再回答 2 加 3 等于几。', group: config.group,
        mode: config.modes.has('nickname') ? 'nickname' : 'default',
        speaker: { id: 'synthetic-visitor', name: '合成访客' }, account: { id: 'synthetic-owner', nickname: '合成账号' } });
      assert(item.text.includes(config.persona.name), 'active conversation name omitted'); assert(/5|五|five/iu.test(item.text), 'active prompt prevented the simple answer');
    });
    testCase('active:memory:' + config.id.slice(0, 12), async item => {
      await invoke(item, { text: '验收甲确认在什么地方见面？仅依据已提供的记忆。', group: config.group,
        memory: '验收甲确认在青藤书店见面。这是本次合成测试事实，与现实聊天无关。' });
      assert(item.text.includes('青藤书店'), 'active prompt overrode the supplied fact');
    });
    if (config.modes.has('natural')) testCase('active:natural:' + config.id.slice(0, 12), async item => {
      let decision;
      await invoke(item, { mode: 'natural', group: true, allowEmptyReply: true,
        naturalDecision: { trigger: 'followup', temperament: 'balanced', smartSkip: true },
        memory: '你刚才正在与合成访客讨论 2 加 3 的计算。', text: '我刚才叫你了，请接着回答 2 加 3 等于几。',
        selectReplyText: raw => { item.raw = raw; decision = T.parseNaturalDecision(raw); return decision.text; } });
      assert.equal(decision.action, 'reply'); assert(/5|五|five/iu.test(item.text));
    });
    if (config.sources.includes('default')) testCase('active:internal-summary', async item => {
      await invoke(item, { mode: 'memory', systemOverride: '这是内部记忆整理，只输出资料摘要，不能应用对外人设、管理员署名或开头。',
        text: '请压缩这条合成资料为一句事实：验收甲一直喜欢柚子，验收乙一直喜欢苹果。' });
      assert(item.text.includes('柚子') && item.text.includes('苹果')); assert(!item.text.includes(config.persona.name));
    });
  }
  const selectedCases = exports.casePrefixes ? cases.filter(test => exports.casePrefixes.some(prefix => test.id.startsWith(prefix))) : cases;
  let next = 0;
  const worker = async () => {
    while (next < selectedCases.length) {
      const scenario = selectedCases[next++], item = { id: scenario.id, calls: [], automatedChecksPassed: false, startedAt: new Date().toISOString() };
      try { signal.throwIfAborted(); await scenario.run(item); item.automatedChecksPassed = true; }
      catch (error) { item.error = error.name === 'AssertionError' || error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id: item.id, error: item.error }); }
      item.finishedAt = new Date().toISOString(); report.scenarios.push(item); persist();
      onProgress({ phase: 'active-prompt-audit', scenario: item.id, completed: report.scenarios.length, total: selectedCases.length, passed: item.automatedChecksPassed });
    }
  };
  await Promise.all([worker(), worker()]);
  const after = await read('status'), identityAfter = await read('identity.get');
  assert.equal(fingerprint(after), before, 'owner configuration changed during prompt audit'); assert.equal(hash(identityAfter.markdown), identityBefore);
  const finalSelection = after.modelChoice || ctx.agentDefaultModel?.currentSelection();
  for (const key of ['provider', 'model', 'reasoningEffort']) assert.equal(finalSelection?.[key], report.model[key], 'running Agent model changed during prompt audit');
  const notesAfter = await read('memory.global.get', { accountId: after.account.id });
  assert.equal(hash(notesAfter.globalNotesExpired ? '' : notesAfter.globalNotes), notesBefore, 'owner notes changed during prompt audit');
  report.ownerConfigurationUnchanged = true; report.ownerNotesUnchanged = true; report.runningModelUnchanged = true;
  report.completed = true; report.automatedChecksPassed = !report.failures.length;
  report.modelCalls = report.scenarios.reduce((sum, s) => sum + s.calls.length, 0); report.finishedAt = new Date().toISOString(); persist(); return report;
};
