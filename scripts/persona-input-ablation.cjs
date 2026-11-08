/* Input-only diagnostic on synthetic sessions. No WeChat transport or writes to
 * production settings. Keep every output, including semantic failures. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text || '').join('\n');
const safeError = error => error?.name === 'AssertionError' ? error.message : error?.code || error?.name || 'AUDIT_FAILED';
const ARMS = ['full', 'minimal-raw', 'minimal-wrapped', 'minimal-persona', 'no-examples', 'role-last'];

function section(text, name) {
  const opening = `【${name}】\n`, closing = `【${name}结束】`;
  const start = text.indexOf(opening), end = text.indexOf(closing, start);
  assert(start >= 0 && end > start && text.indexOf(opening, start + opening.length) === -1);
  assert.equal(text.indexOf(closing, end + closing.length), -1);
  return { start, end: end + closing.length, text: text.slice(start, end + closing.length) };
}

function removeSection(text, part) {
  if (text.slice(part.end, part.end + 2) === '\n\n') return text.slice(0, part.start) + text.slice(part.end + 2);
  if (text.slice(part.start - 2, part.start) === '\n\n') return text.slice(0, part.start - 2) + text.slice(part.end);
  return text.slice(0, part.start) + text.slice(part.end);
}

exports.makeInputVariants = function makeInputVariants(messages, { name, memberName, question }) {
  assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
  assert(messages.every(message => message.content.every(block => block.type === 'text')));
  const fullSystem = textOf(messages[0]), fullUser = textOf(messages[1]);
  const role = section(fullSystem, '当前会话角色'), examples = section(fullSystem, '角色语气示例');
  assert(examples.start > role.start && examples.end < role.end);
  assert(fullUser.endsWith(question));
  const minimum = `你在微信里直接与对方聊天，只输出要发给对方的正文。你的角色完整名字是${JSON.stringify(name)}，当前发言者的名字是${JSON.stringify(memberName)}，两者分别使用。\n回答当前消息，按原话保留人物、物品、数量、单位及事件先后，未说的信息保持未知。可以自然打趣；对方只想聊天时，陪他接话，不附加建议。`;
  const pair = (system, user) => messages.map((message, index) => ({ ...structuredClone(message), content: [{ type: 'text', text: index ? user : system }] }));
  const variants = {
    full: structuredClone(messages),
    'minimal-raw': pair(minimum, question),
    'minimal-wrapped': pair(minimum, fullUser),
    'minimal-persona': pair(minimum + '\n\n' + role.text, fullUser),
    'no-examples': pair(removeSection(fullSystem, examples), fullUser),
    'role-last': pair(removeSection(fullSystem, role) + '\n\n' + role.text, fullUser),
  };
  for (const [arm, value] of Object.entries(variants)) {
    assert.equal(textOf(value[1]), arm === 'minimal-raw' ? question : fullUser);
    assert(textOf(value[0]).includes(name));
  }
  assert.equal(section(textOf(variants['role-last'][0]), '当前会话角色').text, role.text);
  assert.equal(textOf(variants['role-last'][0]).split(role.text).join(''), removeSection(fullSystem, role) + '\n\n');
  assert(!textOf(variants['no-examples'][0]).includes(examples.text));
  return variants;
};

exports.runPersonaAudit = async ({ ctx, testing: T, sourceRoot, outputRoot, signal, selection, productionModelConfig, onProgress = () => {} }) => {
  const { personaFromPreset } = await import(pathToFileURL(path.join(sourceRoot, 'src/shared/persona-presets.mjs')).href);
  const { personaFields } = await import(pathToFileURL(path.join(sourceRoot, 'src/features/agent/persona-input.mjs')).href);
  const directory = path.join(outputRoot, 'persona'); fs.mkdirSync(directory, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-input-ablation-'));
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    model: structuredClone(selection), generationSettings: structuredClone(productionModelConfig),
    actualWeChatMessages: 0, notificationsSent: 0, modelCalls: 0, actualApiCalls: 0, sessionIds: [], scenarios: [],
    phase: 'input-ablation', repetitions: 2, startedAt: new Date().toISOString() };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-prompt-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const origin = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
  assert(/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal }); assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const read = async (method, payload = {}) => {
    assert(['status', 'identity.get', 'memory.global.get'].includes(method));
    const response = await fetch(origin + '/wechat-agent/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'input-ablation-' + crypto.randomUUID(), method, payload }) });
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
  const member = { id: 'section-ahe', name: '阿禾' }, account = { id: 'section-owner', nickname: '合成账号' };
  const row = (text, outgoing = false) => ({ time: Date.now() / 1000 - 10,
    senderId: outgoing ? account.id : member.id, senderName: outgoing ? '旧回复' : member.name, direction: outgoing ? 'outgoing' : 'incoming', text });
  const cases = [
    { id: 'inventory:tea', preset: 'mobai', text: '我买了两杯奶茶，自己拿走一杯，另一杯忘在店里了。怎么感觉脑子今天没开机。只聊聊，别给建议。',
      focus: '拿走一杯、店里留一杯，目的地未知；无行动建议。' },
    { id: 'waiting:duration', preset: 'mobai', text: '等了三十七分钟，刚坐下叫号就到了。椅子大概以为我只是来打个招呼的。只聊两句。',
      focus: '三十七分钟是等待时间，刚坐下即叫号；不补未给的地点、身体状态或原因。' },
    { id: 'identity:current-name', preset: 'xingli', name: '新名字星璃', text: '现在你叫什么名字？接着叫我一声就好。', history: [row('你叫什么名字？'), row('旧名。', true)],
      focus: '角色完整新名字优先于旧助手回答，称呼当前成员阿禾。' },
  ];
  for (const item of cases) {
    const preset = personaFromPreset(item.preset);
    item.persona = structuredClone(status.conversations.find(room => room.config.persona?.name === preset.name)?.config.persona);
    assert(typeof item.persona?.prompt === 'string' && personaFields(item.persona), 'Use the actual canonical saved persona');
    if (item.name) item.persona.name = item.name;
  }
  const adapter = ctx.llm.registration(selection.provider).adapter;
  assert.equal(typeof adapter.streamWithSnapshot, 'function');
  const snapshot = adapter.current();
  const liveModel = adapter.modelOf(snapshot, selection.provider, selection.model);
  assert.equal(liveModel.api, 'openai-completions');
  report.liveModel = { provider: liveModel.provider, id: liveModel.id, api: liveModel.api };
  report.plan = cases.map(item => ({ id: item.id, question: item.text, focus: item.focus, arms: ARMS, repetitions: report.repetitions }));
  const frozen = new Map(), expectedApiSettings = new Map();
  persist();
  let stopped = false;
  for (let repetition = 1; repetition <= report.repetitions && !stopped; repetition++) {
    for (const [index, item] of cases.entries()) {
      if (stopped || signal.aborted) break;
      const shift = (index + repetition - 1) % ARMS.length;
      const arms = ARMS.slice(shift).concat(ARMS.slice(0, shift));
      for (const arm of arms) {
        const call = { question: item.text, wireRequests: [], apiRequests: [], startedAt: new Date().toISOString() };
        const scenario = { id: item.id, arm, repetition, personaName: item.persona.name, personaHash: hash(item.persona),
          reviewFocus: item.focus, calls: [call], manualReview: 'pending' };
        report.scenarios.push(scenario); report.modelCalls++;
        onProgress({ phase: item.id + ':' + arm + ':' + repetition, started: report.scenarios.length, total: cases.length * ARMS.length * report.repetitions, modelCalls: report.modelCalls });
        persist();
        const scopedContext = Object.create(ctx);
        const observe = method => async options => ctx.agents[method]({ ...options, setup(scoped) {
          options.setup(scoped);
          // This callback must return an AsyncIterable synchronously.
          scoped.on('llm/stream', (wire, next) => {
            if (wire.sessionId !== call.sessionId) return next();
            assert.equal(wire.provider, selection.provider); assert.equal(wire.model, selection.model);
            assert.equal(wire.reasoningEffort, selection.reasoningEffort);
            assert(!wire.system); assert.equal((wire.tools || []).length, 0);
            assert.deepEqual(wire.messages.map(message => message.role), ['system', 'user']);
            const system = textOf(wire.messages[0]);
            for (const name of ['角色背景', '性格与互动', '表达方式', '角色语气示例']) assert(system.includes(`【${name}】\n遵守原则：`));
            if (!frozen.has(item.id)) {
              frozen.set(item.id, exports.makeInputVariants(wire.messages, { name: item.persona.name, memberName: member.name, question: item.text }));
              report.inputs ||= {};
              report.inputs[item.id] = Object.fromEntries(Object.entries(frozen.get(item.id)).map(([key, value]) => [key, { hash: hash(value.map(textOf)), messages: value.map(message => ({ role: message.role, text: textOf(message) })) }]));
            }
            const messages = structuredClone(frozen.get(item.id)[arm]);
            call.inputHash = hash(messages.map(textOf));
            call.wireRequests.push({ provider: wire.provider, model: wire.model, reasoningEffort: wire.reasoningEffort,
              temperature: wire.temperature, maxTokens: wire.maxTokens, inputHash: call.inputHash });
            const privateModels = { getModel: snapshot.models.getModel.bind(snapshot.models) };
            privateModels.streamSimple = (model, context, options) => {
              assert.equal(model.provider, selection.provider); assert.equal(model.id, selection.model);
              return snapshot.models.streamSimple(model, context, { ...options,
                onPayload(params) {
                  const flatten = content => typeof content === 'string' ? content : content.map(block => block.text || '').join('\n');
                  const apiMessages = params.messages.map(message => ({ role: message.role, text: flatten(message.content) }));
                  const settings = { model: params.model, roles: apiMessages.map(message => message.role),
                    thinking: params.thinking ?? null, reasoningEffort: params.reasoning_effort ?? null,
                    temperature: params.temperature ?? null, maxTokens: params.max_tokens ?? null, maxCompletionTokens: params.max_completion_tokens ?? null };
                  assert(['system', 'developer'].includes(settings.roles[0]));
                  assert.deepEqual(settings.roles.slice(1), ['user']);
                  assert.deepEqual(apiMessages.map(message => message.text), messages.map(textOf), 'The actual API must carry the exact selected arm');
                  assert.equal(settings.reasoningEffort, selection.reasoningEffort ?? null);
                  if (!expectedApiSettings.has(item.id)) expectedApiSettings.set(item.id, settings);
                  else assert.deepEqual(settings, expectedApiSettings.get(item.id), 'Only input text may differ between arms and repetitions');
                  report.actualApiCalls++;
                  call.apiRequests.push({ ...settings, inputHash: hash(apiMessages.map(message => message.text)) });
                  persist();
                },
              });
            };
            const unused = next(); if (typeof unused.return === 'function') void unused.return();
            const stream = adapter.streamWithSnapshot({ ...wire, messages }, { ...snapshot, models: privateModels });
            return (async function* () {
              for await (const chunk of stream) {
                if (chunk.type === 'block-start' && /thinking|reasoning/.test(chunk.blockType || '')) call.reasoningObserved = true;
                yield chunk;
              }
            })();
          }, { prepend: true });
        } });
        Object.defineProperty(scopedContext, 'agents', { value: { create: observe('create'), resume: observe('resume') } });
        const runner = new T.DshAgentRunner(scopedContext, () => selection, () => ({ persona: item.persona, identityMarkdown: identity.markdown,
          workspacePath: workspace, modelConfig: { ...productionModelConfig, webSearch: false, vision: false } }));
        try {
          const result = await runner.run({ text: item.text, history: item.history || [], group: true, prompt: status.settings.prompt || '', adminNotes: notes,
            speaker: member, account, tools: [], signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
            onSession: id => { call.sessionId = id; report.sessionIds.push(id); persist(); } });
          call.text = result.text; call.state = 'completed'; call.finishedAt = new Date().toISOString();
          assert(result.text.trim() && call.apiRequests.length > 0);
          scenario.transportChecksPassed = true;
          scenario.nameCheck = item.name ? result.text.includes(item.name) && result.text.includes(member.name) && !result.text.includes('旧名') : null;
          scenario.automatedChecksPassed = scenario.nameCheck !== false;
        } catch (error) {
          stopped = true; call.state = 'failed'; call.error = safeError(error);
          report.stopReason = { scenarioId: item.id, arm, repetition, error: call.error };
        }
        persist(); if (stopped) break;
      }
    }
  }
  const after = await read('status'), afterIdentity = await read('identity.get'), afterNotes = await read('memory.global.get', { accountId: status.account.id });
  assert.equal(fingerprint(after), report.configuration.before);
  assert.equal(hash(afterIdentity.markdown), report.configuration.identityHash);
  assert.equal(hash(afterNotes.globalNotesExpired ? '' : afterNotes.globalNotes), report.configuration.notesHash);
  report.configuration.unchanged = true;
  report.completed = !stopped && report.scenarios.length === cases.length * ARMS.length * report.repetitions;
  report.automatedChecksPassed = report.completed && report.scenarios.every(scenario => scenario.automatedChecksPassed);
  report.finishedAt = new Date().toISOString(); persist(); return report;
};
