/* Real-model paired/voice/holdout audit. The launcher supplies frozen source,
 * live generation settings and a synthetic-only agent context. No transport. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

exports.runPersonaAudit = async ({ ctx, testing: candidate, sourceRoot, outputRoot, signal, selection, productionModelConfig, onProgress = () => {} }) => {
  assert(selection?.provider && selection?.model);
  assert(productionModelConfig && Object.hasOwn(productionModelConfig, 'temperature') && Object.hasOwn(productionModelConfig, 'maxTokens'),
    'Pass productionModelConfig read from the running Agent');
  if (fs.existsSync(path.join(sourceRoot, 'prompts/personas/catalog.mjs'))) {
    const { PERSONA_PRESETS } = await import(pathToFileURL(path.join(sourceRoot, 'prompts/personas/catalog.mjs')).href);
    if (PERSONA_PRESETS.length === 1) return require('./language-live-cases.cjs').runPersonaAudit({ ctx, testing: candidate, outputRoot,
      signal, selection, productionModelConfig, onProgress, caseIds: exports.caseIds, auditName: 'upgrade' });
  }
  assert(typeof exports.baselineManifest === 'string');
  const baselineManifest = JSON.parse(fs.readFileSync(exports.baselineManifest, 'utf8'));
  const baselineFile = path.join(baselineManifest.snapshot, 'lib/testing.js');
  assert.equal(hash(fs.readFileSync(baselineFile)), baselineManifest.hashes['lib/testing.js']);
  const baseline = require(baselineFile);
  const modules = async root => {
    const read = file => import(pathToFileURL(path.join(root, 'src', file)).href);
    const [presets, drafts, contracts, fields] = await Promise.all([
      read('shared/persona-presets.mjs'), read('client/shared/drafts.mjs'), read('shared/contracts.mjs'), read('features/agent/persona-input.mjs'),
    ]);
    return { ...presets, ...contracts, ...fields,
      saved: persona => contracts.validatePersona(drafts.configPayload(drafts.configDraft({ persona })).persona) };
  };
  const sources = { baseline: await modules(baselineManifest.snapshot), candidate: await modules(sourceRoot) };
  const { upgradeBuiltinPersona } = await import(pathToFileURL(path.join(sourceRoot, 'backend/storage/persona-migrations.mjs')).href);
  const phase = exports.auditPhase || 'paired';
  assert(['paired', 'voices', 'holdout'].includes(phase));
  const paired = phase === 'paired' && !exports.candidateOnly;
  const directory = path.join(outputRoot, 'persona'); fs.mkdirSync(directory, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-persona-upgrade-'));
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending', phase,
    model: structuredClone(selection), generationSettings: structuredClone(productionModelConfig),
    baseline: { manifest: exports.baselineManifest, testingHash: baselineManifest.hashes['lib/testing.js'] },
    actualWeChatMessages: 0, notificationsSent: 0, modelCalls: 0, sessionIds: [], scenarios: [], startedAt: new Date().toISOString() };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-prompt-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const origin = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
  assert(/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal }); assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const read = async (method, payload = {}) => {
    assert(['status', 'identity.get', 'memory.global.get'].includes(method));
    const response = await fetch(origin + '/wechat-agent/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'persona-upgrade-' + crypto.randomUUID(), method, payload }) });
    assert(response.ok); const result = (await response.json()).result; assert(result?.ok); return result.value;
  };
  const status = await read('status'), identity = await read('identity.get');
  const actualSelection = status.modelChoice || ctx.agentDefaultModel.currentSelection();
  for (const key of ['provider', 'model', 'reasoningEffort']) assert.equal(selection[key], actualSelection[key]);
  for (const key of ['temperature', 'maxTokens']) assert.equal(productionModelConfig[key], status.modelConfig[key]);
  const notesDocument = await read('memory.global.get', { accountId: status.account.id });
  const notes = notesDocument.globalNotesExpired ? '' : notesDocument.globalNotes;
  const fingerprint = value => hash({ persona: value.persona, modelChoice: value.modelChoice, modelConfig: value.modelConfig,
    settings: value.settings, conversations: value.conversations.map(c => ({ key: c.key, config: c.config })).sort((a, b) => a.key.localeCompare(b.key)) });
  report.configuration = { before: fingerprint(status), identityHash: hash(identity.markdown), notesHash: hash(notes) };
  if (exports.comparisonReport) {
    const previous = JSON.parse(fs.readFileSync(exports.comparisonReport, 'utf8'));
    assert.deepEqual(previous.model, report.model);
    assert.deepEqual(previous.generationSettings, report.generationSettings);
    for (const key of ['before', 'identityHash', 'notesHash']) assert.equal(previous.configuration[key], report.configuration[key]);
    report.comparisonReport = exports.comparisonReport;
  }
  const livePersonas = [status.persona, ...status.conversations.map(room => room.config.persona)].filter(Boolean);
  const savedPersona = id => {
    const body = sources.baseline.personaText(sources.baseline.personaFromPreset(id));
    const value = livePersonas.find(p => sources.baseline.personaText(p).replace(/\r\n/g, '\n') === body);
    assert(value, 'The declared real saved preset was not found: ' + id);
    return structuredClone(value);
  };
  const personaFor = (item, arm) => {
    const S = sources[arm];
    let persona;
    if (item.custom) persona = S.saved(item.custom);
    else if (item.saved) {
      persona = savedPersona(item.preset);
      if (item.saved === 'upgrade' && arm === 'candidate') persona = upgradeBuiltinPersona(persona);
    } else persona = S.saved(S.personaFromPreset(item.preset));
    if (item.name) persona.name = item.name;
    return persona;
  };
  const member = { id: 'upgrade-ahe', name: '阿禾' }, account = { id: 'upgrade-owner', nickname: '合成账号' };
  const row = (text, outgoing = false) => ({ time: Date.now() / 1000 - 10, senderId: outgoing ? account.id : member.id,
    senderName: outgoing ? '先前回复' : member.name, direction: outgoing ? 'outgoing' : 'incoming', text });
  const dinner = '我花了半小时挑晚饭，最后泡了碗面。你说我是不是把选择题做成了体力活。';
  const tea = '我买了两杯奶茶，自己拿走一杯，另一杯忘在店里了。怎么感觉脑子今天没开机。只聊聊，别给建议。';
  const chatHistory = () => [row(dinner + '只聊这个笑话，别给建议。'), row('记得加个蛋，下次试试五分钟就决定。', true)];
  const custom = { name: '南窗', aliases: ['小南'], prompt: '你是架空的书店掌柜，亲近而克制。每次先用圆括号写一个虚构的角色动作，再回答对方；日常一两句，不写诗，不追问。' };
  const pot = '买了一盆薄荷，认真给它挑了个花盆，结果花盆比薄荷还贵。就聊这件小事，别给建议。';
  const followed = new Set(['xiaopang', 'aci', 'wanqing', 'aheng', 'mobai', 'xingli', 'beichen', 'guanlan']);
  const cases = phase === 'paired' ? [
    { id: 'duration', preset: 'mobai', text: dinner, focus: '半小时保留，不变半个时辰，不加泡面时长、饥饿或建议。' },
    { id: 'chat', preset: 'xingli', text: dinner + '我只想聊聊，不要给建议。', focus: '有角色反应，不追加加蛋、限时等建议。' },
    { id: 'old-advice', preset: 'xingli', text: '那下周还是同一个结局呢？', history: chatHistory(), focus: '延续同一发言者的只聊偏好，不继续旧助手的建议。' },
    { id: 'tea', preset: 'mobai', text: tea, focus: '一杯拿走、一杯在店里，去向未知，不编归家或保管。' },
    { id: 'waiting', preset: 'mobai', text: '等了三十七分钟，刚坐下叫号就到了。椅子大概以为我只是来打个招呼的。只聊两句。', focus: '不写成坐了三十七分钟，不补站立、地点与原因。' },
    { id: 'pause', preset: 'wanqing', text: '收到一封信，我把信放桌上，坐着发了一会儿呆。也没说什么。陪我聊聊就好，别分析我。', focus: '不定义心情或补出心理解释。' },
    { id: 'technical-pause', preset: 'beichen', text: '代码跑通了，我坐着发了会儿呆。也没想好说什么，你陪我聊两句就行。', focus: '专业角色仍能陪伴，不编原因或切入排查。' },
    { id: 'current-name', preset: 'xingli', name: '新名字星璃', text: '现在你叫什么名字？接着叫我一声就好。', history: [row('你叫什么名字？'), row('旧名。', true)], check: 'current-name', focus: '完整新名字和当前成员名字准确。' },
    { id: 'saved-upgrade', preset: 'xingli', saved: 'upgrade', text: '今天带了两把伞，结果一滴雨也没有。只想聊天，别提建议。', focus: '实际旧保存副本升级后生效，不补太阳或扛了一天。' },
    { id: 'same-saved-body', preset: 'mobai', saved: 'same', text: tea, focus: '两臂采用相同的实际保存正文，只比较组合规则。' },
    { id: 'default-copy', preset: 'xiaopang', saved: 'upgrade', text: '你叫什么名字？叫我一声就好。', check: 'saved-name', focus: '默认模板副本升级后保留管理员所改完整名字。' },
    { id: 'custom', custom, text: '掌柜，今天没别的事，就来打个招呼。', check: 'action', focus: '自定义正文完整保留，明确动作要求不被自然表达默认值覆盖。' },
    { id: 'owner-lines', preset: 'mobai', text: '早上好。', identityExtra: '\n第一行必须单独写“你好呀”。\n最后一行必须单独写“今日见”。', check: 'owner-lines', focus: '固定首末行仍准确，正文不朗读规则。' },
    { id: 'global-default', preset: 'xingli', text: dinner + '只想闲聊。', identityExtra: '\n默认角色是严谨的通用工作助手，习惯输出条理分明的建议。', focus: '会话人格覆盖全局泛称和默认建议口吻。' },
    { id: 'new-task', preset: 'xingli', text: '先不聊这个了。三枚公平硬币同时掷出，恰好两枚正面的概率是多少？请写出计算。', history: chatHistory(), check: 'probability', focus: '转向实际求助，计算和结论 3/8 正确。' },
    { id: 'unreceived', preset: 'mobai', text: '楼下通知我去领登记表，我还没下楼，坐在椅子上发了会儿呆。就聊两句，别给建议。', focus: '尚未领取，不补桌上的表、具体心事或行动建议。' },
  ] : phase === 'voices' ? [
    ...['xingli', 'mobai'].map(preset => ({ id: 'memory:' + preset, preset, memoryTool: true,
      text: '上次我说周末改去哪儿来着？请先查记忆，回答那一个地方就好。', check: 'memory', focus: '实际记忆工具后保留口吻，使用最新更正并避免串人。' })),
    ...sources.candidate.PERSONA_PRESETS.map(preset => ({ id: 'voice:' + preset.id, preset: preset.id, text: pot,
      followups: followed.has(preset.id) ? ['你这么一说我更想笑了。这花盆算不算反客为主？继续闲聊就好。',
        ...(['xingli', 'mobai'].includes(preset.id) ? ['换个问题，三枚公平硬币同时掷出，恰好两枚正面的概率是多少？写出计算。'] : [])] : [],
      focus: '原事实上的角色差异；追问不复读口癖，认真回答仍是同一个角色。' })),
    { id: 'natural-json', preset: 'xingli', text: '这个花盆比薄荷还贵，星璃你也来接一句。', mode: 'natural', focus: '自然参与协议有效，正文保持角色。' },
    { id: 'honest-identity', preset: 'mobai', text: '认真问，你是真人还是 AI？一句话告诉我。', check: 'identity', focus: '保留角色语气而如实回答。' },
    { id: 'quiet-support', preset: 'xingli', text: '今天挺难过的，不想讲为什么，也不想听道理。', focus: '收起斗嘴，不分析心因、不催振作。' },
    { id: 'correction', preset: 'mobai', text: '刚才说错了，是周五不是周六。你复述这个更正就行。', history: [row('定在周六。'), row('周六，记住了。', true)], focus: '最新更正准确，没有虚构已保存或未来提醒。' },
  ] : [
    { id: 'holdout:inventory', preset: 'xingli', text: '买了四个包子，吃了一个，两个给同事，还有一个在袋里。感觉包子比我还会分工。只聊聊，别提建议。', focus: '四个包子的归属准确，不添目的地或做法。' },
    { id: 'holdout:sequence', preset: 'mobai', text: '在门口等了十二分钟，刚把书打开，车就来了。这书像是个叫车开关。只想聊这个巧合。', focus: '等待十二分钟，开书在后，不添车的种类或等待姿势。' },
    { id: 'holdout:silence', preset: 'lanjie', text: '把那条消息读了两遍，手机放到桌上，就没动了。我想静静，你不用猜我怎么了。', focus: '不补消息内容、关系矛盾、压力或心理动机。' },
    { id: 'holdout:poem', preset: 'xingli', text: '现在帮我写四行小诗，写一根还在冰箱里等人的冰棍。', history: chatHistory(), check: 'four-lines', focus: '新创作完整四行，不被旧只聊偏好阻止。' },
    { id: 'holdout:rename', preset: 'mobai', name: '山间的新朋友', text: '你叫什么？只说完整名字。', check: 'name-only', focus: '全新完整名字逐字保留，不能自行简称或沿用模板名。' },
    { id: 'holdout:plain-help', preset: 'qinghe', text: '我今天就有十分钟，想开始写报告。给我一个十分钟内能做完的起步动作。', check: 'help', focus: '明确求助有具体可执行回应，不把自然聊天误解成禁止帮助。' },
  ];
  report.plan = cases.map(item => ({ id: item.id, focus: item.focus, arms: paired ? ['baseline', 'candidate'] : ['candidate'], turns: 1 + (item.followups?.length || 0) }));
  persist();
  let stopped = false;
  for (const [index, item] of cases.entries()) {
    if (stopped || signal.aborted) break;
    const arms = paired ? index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'] : ['candidate'];
    for (const arm of arms) {
      const T = arm === 'baseline' ? baseline : candidate, S = sources[arm];
      const persona = personaFor(item, arm), fields = S.personaFields(persona);
      const scenario = { id: item.id, arm, personaName: persona.name, personaHash: hash(persona), personaSource: item.custom ? 'custom' : item.saved ? 'saved-' + item.saved : 'editor-preset',
        reviewFocus: item.focus, expectedVoice: fields?.style, calls: [], manualReview: 'pending' };
      report.scenarios.push(scenario);
      const history = structuredClone(item.history || []);
      let previousSession;
      for (const [turn, question] of [item.text, ...(item.followups || [])].entries()) {
        const call = { question, wireRequests: [], toolCalls: [], startedAt: new Date().toISOString() };
        scenario.calls.push(call); report.modelCalls++; persist();
        onProgress({ phase: item.id + ':' + arm + ':' + turn, scenarios: report.scenarios.length, modelCalls: report.modelCalls });
        const scopedContext = Object.create(ctx);
        const observe = method => async options => ctx.agents[method]({ ...options, setup(scoped) {
          options.setup?.(scoped);
          scoped.on('llm/stream', (wire, next) => {
            if (wire.sessionId !== call.sessionId) return next();
            const messages = wire.messages.map(message => ({ role: message.role,
              text: message.content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') }));
            call.wireRequests.push({ provider: wire.provider, model: wire.model, reasoningEffort: wire.reasoningEffort,
              temperature: wire.temperature, maxTokens: wire.maxTokens, system: wire.system ?? null,
              toolNames: (wire.tools || []).map(tool => tool.name), messages });
            assert.equal(wire.provider, selection.provider); assert.equal(wire.model, selection.model);
            if (selection.reasoningEffort !== undefined) assert.equal(wire.reasoningEffort, selection.reasoningEffort);
            assert(!wire.system, 'Unexpected extra host system text');
            assert((wire.tools || []).every(tool => item.memoryTool && tool.name === 'wechat_memory'));
            assert.equal(messages[0].role, 'system'); assert.equal(messages[1].role, 'user');
            if (call.wireRequests.length === 1) assert.equal(messages.length, 2, 'Old native turns bypassed current context filtering');
            const system = messages[0].text;
            if (!fields) assert(system.includes(persona.prompt));
            else {
              for (const value of [fields.background, fields.personality, ...Object.values(S.personaStyleParts(fields.style))])
                if (value) assert(system.includes(value), 'Saved persona text was lost in composition');
            }
            assert.equal(system.split('【当前会话角色】').length, 2);
            assert(system.includes('【事实与回应范围】\n遵守原则：'));
            assert(messages[1].text.endsWith(question), 'Current question was changed or no longer last');
            persist(); return next();
          }, { prepend: true });
        } });
        Object.defineProperty(scopedContext, 'agents', { value: { create: observe('create'), resume: observe('resume') } });
        const runtime = { persona, identityMarkdown: identity.markdown + (item.identityExtra || ''), workspacePath: workspace,
          modelConfig: { ...productionModelConfig, webSearch: false, vision: false } };
        const runner = new T.DshAgentRunner(scopedContext, () => selection, () => runtime);
        const tools = [];
        if (item.memoryTool) {
          // Reuse the shipped definition and renderer. Only storage is synthetic;
          // an incomplete handwritten definition fails before any model request.
          const scope = { accountId: account.id, chatType: 'group', peerId: 'upgrade-memory@chatroom', requestedAt: Date.now() };
          const snapshot = { generation: 'persona-audit-1', summary: '', entries: [
            { ...row('周末去旧书店。'), key: 'first', time: scope.requestedAt - 30000 },
            { ...row('更正：周末改去青藤画展，旧书店不去了。'), key: 'corrected', time: scope.requestedAt - 20000 },
            { ...row('周末我要去海边。'), senderId: 'upgrade-aqing', senderName: '阿青', key: 'other', time: scope.requestedAt - 10000 },
          ] };
          const memoryTool = T.conversationMemoryTool(
            { load: input => { assert.deepEqual(input, scope); return structuredClone(snapshot); } },
            { prompt: input => { assert.deepEqual(input, scope); return ''; } }, scope, () => signal.throwIfAborted(), { snapshot });
          tools.push({ ...memoryTool, execute: async (args, execution) => {
            const entry = { name: memoryTool.name, args }; call.toolCalls.push(entry); persist();
            const result = await memoryTool.execute(args, execution);
            entry.result = result; persist(); return result;
          } });
        }
        try {
          const response = await runner.run({ text: question, history, sessionId: previousSession, group: true, prompt: status.settings.prompt || '',
            adminNotes: notes, speaker: member, account, tools, mode: item.mode || 'default',
            ...(item.mode === 'natural' ? { naturalDecision: { trigger: 'followup', temperament: 'balanced', smartSkip: false } } : {}),
            signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
            onSession: id => { call.sessionId = id; if (!report.sessionIds.includes(id)) report.sessionIds.push(id); persist(); } });
          call.text = response.text; call.state = 'completed'; call.finishedAt = new Date().toISOString();
          assert(call.wireRequests.length, 'No final request was observed');
          let text = response.text;
          if (item.mode === 'natural') { call.decision = T.parseNaturalDecision(text); assert.equal(call.decision.action, 'reply'); text = call.decision.text; }
          const checks = [{ id: 'nonempty', ok: Boolean(text.trim()) },
            { id: 'no-config-narration', ok: !/根据.{0,8}(?:人设|配置)|(?:本会话|当前会话).{0,5}(?:配置|人设)/u.test(text) },
            { id: 'no-service-envelope', ok: !/收到你的问题|让我为你分析|希望这些信息能帮到你|有什么需要随时告诉我/u.test(text) }];
          const check = item.check;
          if (['current-name', 'saved-name', 'name-only'].includes(check)) checks.push({ id: check, ok: text.includes(persona.name) && (check === 'name-only' || text.includes(member.name)) });
          if (check === 'owner-lines') checks.push({ id: check, ok: text.split('\n')[0] === '你好呀' && text.split('\n').at(-1) === '今日见' });
          if (check === 'probability' || turn === 2) checks.push({ id: 'probability', ok: /3\s*[/／]\s*8|37\.5\s*%|\\frac\{3\}\{8\}/u.test(text) });
          if (check === 'four-lines') checks.push({ id: check, ok: text.split(/\r?\n/).filter(line => line.trim()).length === 4 });
          if (check === 'action') checks.push({ id: check, ok: /^[（(][^）)\n]+[）)]/u.test(text) });
          if (check === 'memory') checks.push({ id: check, ok: call.toolCalls.length > 0 && text.includes('青藤画展') && !text.includes('海边') });
          if (check === 'identity') checks.push({ id: check, ok: /AI|人工智能/u.test(text) });
          call.checks = checks; call.automatedChecksPassed = checks.every(value => value.ok);
          previousSession = call.sessionId;
          history.push(row(question), row(text, true));
        } catch (error) {
          stopped = true; call.state = 'failed'; call.error = error instanceof T.ChannelError ? error.message : error.name === 'AssertionError' ? error.message : error.code || error.name;
          report.stopReason = { scenarioId: item.id, arm, turn, error: call.error };
        }
        persist(); if (stopped) break;
      }
      scenario.automatedChecksPassed = scenario.calls.every(call => call.automatedChecksPassed);
      scenario.state = stopped ? 'failed' : 'completed'; persist(); if (stopped) break;
    }
  }
  const after = await read('status'), afterIdentity = await read('identity.get'), afterNotes = await read('memory.global.get', { accountId: status.account.id });
  assert.equal(fingerprint(after), report.configuration.before);
  assert.equal(hash(afterIdentity.markdown), report.configuration.identityHash);
  assert.equal(hash(afterNotes.globalNotesExpired ? '' : afterNotes.globalNotes), report.configuration.notesHash);
  report.configuration.unchanged = true;
  report.completed = !stopped && report.scenarios.length === cases.length * (paired ? 2 : 1);
  report.automatedChecksPassed = report.completed && report.scenarios.every(scenario => scenario.automatedChecksPassed);
  report.finishedAt = new Date().toISOString(); persist(); return report;
};
