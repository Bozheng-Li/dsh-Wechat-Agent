/* Real-model regression for saved personas and native session resume.
 * Only synthetic dialogue is generated; this helper has no WeChat transport.
 * Automatic assertions are followed by review of the recorded actual text. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

exports.runPersonaAudit = async ({ ctx, testing: T, sourceRoot, outputRoot, signal, selection, productionModelConfig, onProgress = () => {} }) => {
  assert(selection?.provider && selection?.model, 'Supply the running Agent selection');
  assert(productionModelConfig && Object.hasOwn(productionModelConfig, 'temperature') && Object.hasOwn(productionModelConfig, 'maxTokens'));
  const { personaFromPreset } = await import(pathToFileURL(path.join(sourceRoot, 'src/shared/persona-presets.mjs')).href);
  const directory = path.join(outputRoot, 'persona'); fs.mkdirSync(directory, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-persona-resume-'));
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    model: structuredClone(selection), generationSettings: structuredClone(productionModelConfig),
    actualWeChatMessages: 0, notificationsSent: 0, modelCalls: 0, sessionIds: [], scenarios: [], failures: [], startedAt: new Date().toISOString() };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-prompt-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const origin = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
  assert(/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal }); assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const read = async (method, payload = {}) => {
    assert(['status', 'identity.get', 'memory.global.get'].includes(method));
    const response = await fetch(origin + '/wechat-agent/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'persona-resume-audit-' + Date.now(), method, payload }) });
    assert(response.ok); const result = (await response.json()).result; assert(result?.ok); return result.value;
  };
  const status = await read('status'), identity = await read('identity.get');
  const actualSelection = status.modelChoice || ctx.agentDefaultModel.currentSelection();
  for (const key of ['provider', 'model', 'reasoningEffort']) assert.equal(selection[key], actualSelection[key]);
  for (const key of ['temperature', 'maxTokens']) assert.equal(productionModelConfig[key], status.modelConfig[key]);
  const notesDocument = await read('memory.global.get', { accountId: status.account.id });
  const notes = notesDocument.globalNotesExpired ? '' : notesDocument.globalNotes;
  const fingerprint = value => hash({ persona: value.persona, modelChoice: value.modelChoice, modelConfig: value.modelConfig,
    settings: value.settings, conversations: value.conversations?.map(c => ({ key: c.key, config: c.config })).sort((a, b) => a.key.localeCompare(b.key)) });
  report.configuration = { before: fingerprint(status), identityHash: hash(identity.markdown), notesHash: hash(notes) };
  report.configuration.proposedBuiltinUpdates = exports.savedPresetUpdates || null;
  const configs = [], seen = new Set();
  for (const room of status.conversations || []) {
    let persona = room.config?.persona;
    const previousHash = persona && hash(persona);
    if (persona && !seen.has(previousHash)) {
      const presetId = exports.savedPresetUpdates?.[previousHash];
      if (presetId) persona = T.validatePersona({ name: persona.name, aliases: persona.aliases,
        prompt: T.personaText(personaFromPreset(presetId, persona)) });
      seen.add(previousHash); configs.push({ persona, previousHash, mode: room.config.mode, group: room.chatType === 'group' });
    }
  }
  configs.sort((a, b) => a.previousHash.localeCompare(b.previousHash));
  report.savedPersonas = configs.map(c => ({ name: c.persona.name, hash: hash(c.persona), previousHash: c.previousHash, mode: c.mode }));
  let stopped = false;
  const invoke = async (item, persona, request, extra = {}) => {
    assert(!stopped, 'An earlier request failed; do not dispatch more model calls');
    const call = { question: request.text, resumed: !!request.sessionId, startedAt: new Date().toISOString(), wireRequests: [] };
    item.calls.push(call); report.modelCalls++; persist();
    const runnerContext = Object.create(ctx);
    const observe = method => async options => ctx.agents[method]({ ...options, setup(scoped) {
      options.setup(scoped);
      scoped.on('llm/stream', (wire, next) => {
        if (wire.sessionId !== call.sessionId) return next();
        assert(!stopped);
        const messages = wire.messages.map(message => ({ role: message.role,
          text: message.content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') }));
        call.wireRequests.push({ provider: wire.provider, model: wire.model,
          reasoningEffort: wire.reasoningEffort, temperature: wire.temperature, messages });
        assert.equal(wire.provider, selection.provider); assert.equal(wire.model, selection.model);
        assert.equal((wire.tools || []).length, 0);
        assert.deepEqual(messages.map(m => m.role), ['system', 'user'], 'old native dialogue bypassed the reviewed WeChat context');
        assert.equal(messages[1].text.split(request.text).length, 2, 'the current question must occur once');
        assert(messages[0].text.includes(T.personaText(persona)));
        persist(); return next();
      }, { prepend: true });
    } });
    Object.defineProperty(runnerContext, 'agents', { value: { create: observe('create'), resume: observe('resume') } });
    const runtime = { persona, identityMarkdown: identity.markdown, workspacePath: workspace,
      modelConfig: { ...productionModelConfig, webSearch: false, vision: false }, ...extra };
    const runner = new T.DshAgentRunner(runnerContext, () => selection, () => runtime);
    try {
      const result = await runner.run({ ...request, group: true, tools: [], adminNotes: notes, prompt: status.settings?.prompt || '',
        speaker: { id: 'synthetic-ahe', name: '阿禾' }, account: { id: 'synthetic-owner', nickname: '测试账号' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
        onSession: id => { call.sessionId = id; report.sessionIds.push(id); persist(); } });
      call.text = result.text; call.finishedAt = new Date().toISOString(); call.state = 'completed'; persist();
      assert(result.text.trim());
      assert(!/收到你的问题|让我为你分析|希望这些信息能帮到你|有什么需要随时告诉我/u.test(result.text));
      return result;
    } catch (error) {
      stopped = true; call.state = 'failed'; call.error = error instanceof T.ChannelError ? error.message : error.name === 'AssertionError' ? error.message : error.code || error.name;
      report.stopReason = { scenarioId: item.id, error: call.error }; persist(); throw error;
    }
  };
  const historyRow = (text, outgoing, name) => ({ time: Date.now() / 1000 - 1, direction: outgoing ? 'outgoing' : 'incoming',
    senderId: outgoing ? 'synthetic-owner' : 'synthetic-ahe', senderName: outgoing ? name : '阿禾', text });
  const cases = [], add = (id, run) => cases.push({ id, run });
  const firstQuestion = '我花了半小时挑晚饭，最后泡了碗面。你说我是不是把选择题做成了体力活。';
  const directChat = '你这么说我又笑了。那要是明天还这样呢？别给我列计划，就聊聊。';
  const continuation = '那下周还是同一个结局呢？';
  const knowledge = '先不聊这个了。三枚公平硬币同时掷出，恰好两枚正面的概率是多少？请写出计算。';
  for (const config of configs) add('saved:' + config.previousHash.slice(0, 12) + ':resume', async item => {
    item.personaName = config.persona.name; item.personaHash = hash(config.persona);
    item.reviewFocus = '同一原生会话中保持角色口吻；只聊约定在追问中继承；半小时单位正确；后来明确求解给出 3/8，旧上下文不重复进入请求。';
    const history = []; let sessionId;
    for (const text of [firstQuestion, directChat, continuation, knowledge]) {
      const result = await invoke(item, config.persona, { text, history, sessionId, mode: config.mode === 'nickname' ? 'nickname' : 'default' });
      sessionId = result.sessionId;
      history.push(historyRow(text, false), historyRow(result.text, true, config.persona.name));
    }
    assert(item.calls[2].wireRequests[0].messages[0].text.includes('当前发言者在刚才这段对话中明确选择了只聊天'));
    assert(!item.calls[3].wireRequests[0].messages[0].text.includes('当前发言者在刚才这段对话中明确选择了只聊天'));
    assert(/3\s*[/／]\s*8|37\.5\s*%|\\frac\{3\}\{8\}/u.test(item.calls[3].text));
  });
  for (const id of ['aci', 'lanjie']) add('voice:' + id + ':resume', async item => {
    const persona = personaFromPreset(id); item.personaName = persona.name;
    item.reviewFocus = '首轮与延续闲聊都体现不同角色态度，明确只聊不变为建议，不捏造心理动机。';
    const text = firstQuestion + ' 我只想聊这个笑话，不要建议。';
    const first = await invoke(item, persona, { text });
    await invoke(item, persona, { text: continuation, sessionId: first.sessionId,
      history: [historyRow(text, false), historyRow(first.text, true, persona.name)] });
  });
  for (const [id, text, expected] of [
    ['duration', '今天等车等了四十五分钟，结果车到站时我正忙着收伞。就聊聊这点小狼狈，别提建议。', /四十五分钟|45\s*分钟/u],
    ['inventory', '我买了两杯奶茶，自己拿走一杯，另一杯忘在店里了。怎么感觉脑子今天没开机。只聊聊，别给建议。', null],
    ['location', '楼下通知我去领登记表，我还没下楼，坐在椅子上发了会儿呆。就聊两句，别给建议。', null],
    ['help', '明晚考概率，我还有一小时复习。请给一个能执行的安排。', /分钟/u],
  ]) add('fidelity:' + id, async item => {
    const persona = configs.find(c => c.persona.name === '墨白')?.persona || personaFromPreset('mobai');
    item.personaName = persona.name; item.reviewFocus = '保留人物、数量、单位、地点和已发生/未发生边界；明确求助时完整帮助。';
    const result = await invoke(item, persona, { text });
    if (expected && id === 'help') assert(expected.test(result.text));
  });
  add('persona:change-in-session', async item => {
    const first = await invoke(item, { name: '旧名', aliases: [], prompt: '用普通短句回答。' }, { text: '你叫什么名字？' });
    const persona = personaFromPreset('xingli', { name: '新名字星璃', aliases: ['小星'] });
    const next = await invoke(item, persona, { text: '现在你叫什么名字？接着叫我一声就好。', sessionId: first.sessionId });
    assert(next.text.includes('新名字星璃'));
    assert(!next.text.includes('旧名'));
  });
  add('persona:fixed-format', async item => {
    const result = await invoke(item, personaFromPreset('mobai'), { text: '早上好。' }, {
      identityMarkdown: identity.markdown + '\n第一行必须单独写“你好呀”。\n最后一行必须单独写“今日见”。',
    });
    assert.equal(result.text.split('\n')[0], '你好呀'); assert.equal(result.text.split('\n').at(-1), '今日见');
  });
  if (exports.includeHoldout) {
    for (const [id, preset, text, focus] of [
      ['book-count', 'mobai', '借了四本书，今天还了一本，另外三本还在桌上。感觉我这还书进度像乌龟。只聊两句，不要给建议。', '四本借书只还了一本，三本仍在桌上；不改写去留或加行动指导。'],
      ['writing-time', 'xingli', '我写标题写了二十分钟，正文还一个字都没有。这个排面是不是有点过头了。只想聊聊，不用指导。', '二十分钟全花在标题，正文为空；不补出未说的耗时和动机。'],
      ['unknown-destination', 'mobai', '拿着刚买的面包走出了店，还没决定往哪走。面包都比我有主意似的。只聊聊这个笑话。', '人只走出店，去向未知；不写成回家、上车或到达具体目的地。'],
    ]) add('holdout:' + id, async item => {
      const persona = personaFromPreset(preset); item.personaName = persona.name; item.reviewFocus = focus;
      await invoke(item, persona, { text });
    });
    add('holdout:creative-after-chat', async item => {
      const persona = personaFromPreset('xingli'); item.personaName = persona.name;
      const text = '今天带了两把伞，结果一滴雨也没有。只想聊天，别提建议。';
      const first = await invoke(item, persona, { text });
      const result = await invoke(item, persona, { text: '现在帮我写四行小诗，就写这两把没派上用场的伞。', sessionId: first.sessionId,
        history: [historyRow(text, false), historyRow(first.text, true, persona.name)] });
      item.reviewFocus = '先接闲聊；后续明确创作应完成四行小诗，不被只聊偏好阻止。';
      assert(result.text.split(/\r?\n/).filter(line => line.trim()).length >= 4);
    });
  }
  report.plan = cases.map(c => c.id); persist();
  for (const scenario of cases) {
    if (stopped || signal.aborted) break;
    const item = { id: scenario.id, calls: [], state: 'running', manualReview: 'pending' }; report.scenarios.push(item); persist();
    onProgress({ phase: scenario.id, started: report.scenarios.length, total: cases.length, modelCalls: report.modelCalls });
    try { await scenario.run(item); item.state = 'passed'; item.automatedChecksPassed = true; }
    catch (error) { item.state = 'failed'; item.error = error.name === 'AssertionError' ? error.message : error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id: item.id, error: item.error }); }
    persist();
  }
  const after = await read('status'), afterIdentity = await read('identity.get'), afterNotes = await read('memory.global.get', { accountId: status.account.id });
  assert.equal(fingerprint(after), report.configuration.before);
  assert.equal(hash(afterIdentity.markdown), report.configuration.identityHash);
  assert.equal(hash(afterNotes.globalNotesExpired ? '' : afterNotes.globalNotes), report.configuration.notesHash);
  report.configuration.unchanged = true;
  report.completed = !stopped && report.scenarios.length === cases.length;
  report.automatedChecksPassed = report.completed && report.failures.length === 0;
  report.finishedAt = new Date().toISOString(); persist(); return report;
};
