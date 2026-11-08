/* Paired real-model audit of prompt composition. No WeChat transport is used.
 * The caller supplies a frozen baseline manifest and the live model settings. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

exports.runPersonaAudit = async ({ ctx, testing: candidate, sourceRoot, outputRoot, signal, selection, productionModelConfig, onProgress = () => {} }) => {
  assert(selection?.provider && selection?.model);
  assert(productionModelConfig && Object.hasOwn(productionModelConfig, 'temperature') && Object.hasOwn(productionModelConfig, 'maxTokens'));
  assert(typeof exports.baselineManifest === 'string', 'Provide the frozen installed baseline manifest');
  const baselineManifest = JSON.parse(fs.readFileSync(exports.baselineManifest, 'utf8'));
  const baselineFile = path.join(baselineManifest.snapshot, 'lib/testing.js');
  assert.equal(hash(fs.readFileSync(baselineFile)), baselineManifest.hashes['lib/testing.js']);
  const baseline = require(baselineFile);
  const { personaFromPreset } = await import(pathToFileURL(path.join(sourceRoot, 'src/shared/persona-presets.mjs')).href);
  const { personaFields, personaStyleParts } = await import(pathToFileURL(path.join(sourceRoot, 'src/features/agent/persona-input.mjs')).href);
  const { configDraft, configPayload } = await import(pathToFileURL(path.join(sourceRoot, 'src/client/shared/drafts.mjs')).href);
  const { validatePersona } = await import(pathToFileURL(path.join(sourceRoot, 'src/shared/contracts.mjs')).href);
  const directory = path.join(outputRoot, 'persona'); fs.mkdirSync(directory, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-section-audit-'));
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    model: structuredClone(selection), generationSettings: structuredClone(productionModelConfig),
    actualWeChatMessages: 0, notificationsSent: 0, modelCalls: 0, sessionIds: [], scenarios: [],
    baseline: { manifest: exports.baselineManifest, testingHash: baselineManifest.hashes['lib/testing.js'] },
    phase: exports.auditPhase || 'paired', startedAt: new Date().toISOString() };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-prompt-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const origin = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
  assert(/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal }); assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const read = async (method, payload = {}) => {
    assert(['status', 'identity.get', 'memory.global.get'].includes(method));
    const response = await fetch(origin + '/wechat-agent/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'persona-section-audit-' + crypto.randomUUID(), method, payload }) });
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
    assert.equal(previous.configuration.before, report.configuration.before, 'The previous baseline used different saved settings');
    assert.equal(previous.configuration.identityHash, report.configuration.identityHash);
    assert.equal(previous.configuration.notesHash, report.configuration.notesHash);
    report.comparisonReport = exports.comparisonReport;
  }
  const persona = id => {
    const preset = personaFromPreset(id);
    return status.conversations.find(room => room.config.persona?.name === preset.name)?.config.persona
      || validatePersona(configPayload(configDraft({ persona: preset })).persona);
  };
  const member = { id: 'section-ahe', name: '阿禾' }, account = { id: 'section-owner', nickname: '合成账号' };
  const row = (text, outgoing = false, extra = {}) => ({ time: Date.now() / 1000 - 10,
    senderId: outgoing ? account.id : member.id, senderName: outgoing ? '旧回复' : member.name,
    direction: outgoing ? 'outgoing' : 'incoming', text, ...extra });
  const dinner = '我花了半小时挑晚饭，最后泡了碗面。你说我是不是把选择题做成了体力活。';
  const chatHistory = () => [row(dinner + '只聊这个笑话，别给建议。'), row('半小时都耗在菜单上啦。记得加个蛋，下次试试五分钟就决定。', true)];
  const cases = report.phase === 'holdout' ? [
    { id: 'holdout:ice-pops', preset: 'xingli', text: '买了三根冰棍，给朋友一根，我自己吃一根，还有一根在冰箱。我们俩吃得像开了个小型派对。只想聊天，别给建议。', focus: '三根分给朋友、自己及冰箱各一根，不改写去留或追加饮食指导。' },
    { id: 'holdout:waiting', preset: 'mobai', text: '等了三十七分钟，刚坐下叫号就到了。椅子大概以为我只是来打个招呼的。只聊两句。', focus: '保留三十七分钟，不换错单位或补出地点、身体状态、等待原因。' },
    { id: 'holdout:letter', preset: 'lanjie', text: '收到一封信，我把信放桌上，坐着发了一会儿呆。也没说什么。你陪我聊聊就好，别分析我。', focus: '不把发呆解释成焦虑、难过、期待或其他未经确认的心理动机。' },
    { id: 'holdout:new-task', preset: 'xingli', text: '现在帮我写四行小诗，写一根还在冰箱里等人的冰棍。', history: [row('刚才只想闲聊，别给建议。'), row('那就聊两句。', true)], focus: '后来明确创作要完成四行，不被此前只聊约定阻止。', check: 'four-lines' },
  ] : [
    { id: 'duration:mobai', preset: 'mobai', text: dinner, focus: '半小时不改成半个时辰，不补出灶火、饥饿、泡面时长；日常自嘲不是求指导。' },
    { id: 'chat:xingli', preset: 'xingli', text: dinner + ' 我只想聊聊，不要给建议。', focus: '保持角色，明确只聊不得追加加蛋、限时或下次做法。' },
    { id: 'history:old-advice', preset: 'xingli', text: '那下周还是同一个结局呢？', history: chatHistory(), focus: '只聊偏好应延续；旧助手的加蛋和五分钟建议不继续指导，也不成为已知事实。' },
    { id: 'location:unreceived', preset: 'mobai', text: '楼下通知我去领登记表，我还没下楼，坐在椅子上发了会儿呆。就聊两句，别给建议。', focus: '表尚未领取，不能写到家里或桌上，也不补写思考内容。' },
    { id: 'inventory:tea', preset: 'mobai', text: '我买了两杯奶茶，自己拿走一杯，另一杯忘在店里了。怎么感觉脑子今天没开机。只聊聊，别给建议。', focus: '拿走一杯、店里留一杯，目的地未知；无行动建议。' },
    { id: 'unknown:writing', preset: 'xingli', text: '我写标题写了二十分钟，正文还一个字都没有。这个排面是不是有点过头了。只想聊聊，不用指导。', focus: '保留时长与正文为空，不补出写作动机。' },
    { id: 'unknown:weather', preset: 'xingli', text: '今天带了两把伞，结果一滴雨也没有。只想聊天，别提建议。', focus: '没有雨不代表有太阳，今天带伞不代表扛了一天；不追加应对建议。' },
    { id: 'voice:aci', preset: 'aci', text: '认真擦了窗户，擦完才发现污点在外面。今天的勤快像是擦了个寂寞。只想聊这个笑话，别教我擦窗。', focus: '直率机灵的角色反应，不补出楼层、天气或给清洁指导。' },
    { id: 'voice:lanjie', preset: 'lanjie', text: '手机拿起来好几次，又放下了。也没什么想说的，你就陪我待一会儿吧。', focus: '陪伴不等于揣测感情、工作压力或冷落关系，不给行动计划。' },
    { id: 'identity:current-name', preset: 'xingli', name: '新名字星璃', text: '现在你叫什么名字？接着叫我一声就好。', history: [row('你叫什么名字？'), row('旧名。', true)], focus: '角色完整新名字优先于旧助手回答，称呼当前成员。', check: 'current-name' },
    { id: 'format:owner-lines', preset: 'mobai', text: '早上好。', identityExtra: '\n第一行必须单独写“你好呀”。\n最后一行必须单独写“今日见”。', focus: '角色正文保留管理员精确首末行，不能输出块名或守则解释。', check: 'owner-lines' },
    { id: 'task:after-chat', preset: 'xingli', text: '先不聊这个了。三枚公平硬币同时掷出，恰好两枚正面的概率是多少？请写出计算。', history: chatHistory(), focus: '从只聊转向新知识题，计算及结论 3/8 正确。', check: 'probability' },
  ];
  const paired = report.phase === 'paired';
  report.plan = cases.map(item => ({ id: item.id, focus: item.focus, arms: paired ? ['baseline', 'candidate'] : ['candidate'] })); persist();
  let stopped = false;
  for (const [index, item] of cases.entries()) {
    if (stopped || signal.aborted) break;
    const arms = paired ? index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'] : ['candidate'];
    for (const arm of arms) {
      const T = arm === 'baseline' ? baseline : candidate;
      const activePersona = structuredClone(persona(item.preset));
      if (item.name) activePersona.name = item.name;
      const fields = personaFields(activePersona);
      const call = { question: item.text, wireRequests: [], startedAt: new Date().toISOString() };
      const scenario = { id: item.id, arm, personaName: activePersona.name, personaHash: hash(activePersona), reviewFocus: item.focus,
        personaInputFormat: typeof activePersona.prompt === 'string' ? fields ? 'canonical-editor-prompt' : 'freeform-prompt' : 'fields',
        calls: [call], manualReview: 'pending' };
      report.scenarios.push(scenario); report.modelCalls++; persist();
      onProgress({ phase: item.id + ':' + arm, started: report.scenarios.length, total: cases.length * (paired ? 2 : 1), modelCalls: report.modelCalls });
      const scopedContext = Object.create(ctx);
      const observe = method => async options => ctx.agents[method]({ ...options, setup(scoped) {
        options.setup(scoped);
        scoped.on('llm/stream', (wire, next) => {
          if (wire.sessionId !== call.sessionId) return next();
          const messages = wire.messages.map(message => ({ role: message.role,
            text: message.content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') }));
          call.wireRequests.push({ provider: wire.provider, model: wire.model, reasoningEffort: wire.reasoningEffort, system: wire.system ?? null,
            temperature: wire.temperature, maxTokens: wire.maxTokens, messages });
          assert.equal(wire.provider, selection.provider); assert.equal(wire.model, selection.model);
          assert(!wire.system, 'Unexpected extra host system text outside the composed system message');
          assert.equal((wire.tools || []).length, 0);
          assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
          // The editor stores one prompt. Canonical headings can be separated in
          // the system message, but all authored field bytes must survive.
          if (!fields) assert(messages[0].text.includes(activePersona.prompt));
          else {
            for (const value of [fields.background, fields.personality]) if (value) assert(messages[0].text.includes(value));
            const parts = personaStyleParts(fields.style);
            for (const value of [parts.style, parts.examples]) if (value) assert(messages[0].text.includes(value));
            if (arm === 'candidate') for (const [name, value] of [['角色背景', fields.background], ['性格与互动', fields.personality], ['表达方式', parts.style], ['角色语气示例', parts.examples]])
              if (value) assert(messages[0].text.includes(`【${name}】\n遵守原则：`), 'Missing scoped editor field: ' + name);
          }
          assert(messages[1].text.endsWith(item.text), 'The original current question must remain last and intact');
          if (arm === 'candidate') {
            assert(messages[0].text.includes('【当前会话角色】\n遵守原则：'));
            assert(messages[0].text.includes('【事实与回应范围】\n遵守原则：'));
            assert(messages[1].text.includes('【当前请求】\n遵守原则：'));
          }
          persist(); return next();
        }, { prepend: true });
      } });
      Object.defineProperty(scopedContext, 'agents', { value: { create: observe('create'), resume: observe('resume') } });
      const runtime = { persona: activePersona, identityMarkdown: identity.markdown + (item.identityExtra || ''), workspacePath: workspace,
        modelConfig: { ...productionModelConfig, webSearch: false, vision: false } };
      const runner = new T.DshAgentRunner(scopedContext, () => selection, () => runtime);
      try {
        const result = await runner.run({ text: item.text, history: item.history || [], group: true,
          prompt: status.settings.prompt || '', adminNotes: notes, tools: [], speaker: member, account,
          signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
          onSession: id => { call.sessionId = id; report.sessionIds.push(id); persist(); } });
        call.text = result.text; call.finishedAt = new Date().toISOString(); call.state = 'completed';
        assert(result.text.trim());
        const checks = [];
        if (item.check === 'current-name') {
          checks.push(result.text.includes(item.name) && !result.text.includes('旧名'));
          checks.push(result.text.includes(member.name));
        }
        if (item.check === 'owner-lines') checks.push(result.text.split('\n')[0] === '你好呀' && result.text.split('\n').at(-1) === '今日见');
        if (item.check === 'probability') checks.push(/3\s*[/／]\s*8|37\.5\s*%|\\frac\{3\}\{8\}/u.test(result.text));
        if (item.check === 'four-lines') checks.push(result.text.split(/\r?\n/).filter(line => line.trim()).length === 4);
        scenario.automatedChecksPassed = checks.every(Boolean); scenario.state = 'completed';
      } catch (error) {
        stopped = true; call.state = 'failed'; call.error = error instanceof T.ChannelError ? error.message : error.name === 'AssertionError' ? error.message : error.code || error.name;
        report.stopReason = { scenarioId: item.id, arm, error: call.error };
      }
      persist(); if (stopped) break;
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
