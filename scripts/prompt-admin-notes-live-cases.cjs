/* Read the active owner settings; ask only synthetic questions. No real
 * WeChat transport, history, configuration edits or notifications. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
exports.runPersonaAudit = async ({ ctx, testing: T, outputRoot, signal, selection, onProgress }) => {
  const origin = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
  assert(/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal }); assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  fs.writeFileSync(path.join(outputRoot, 'owner-access.json'), JSON.stringify({ origin, cookie }), { mode: 0o600 });
  const read = async (method, payload = {}) => {
    assert(['status', 'identity.get', 'memory.global.get'].includes(method));
    const response = await fetch(origin + '/wechat-agent/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'admin-notes-audit-' + Date.now(), method, payload }) });
    assert(response.ok); const result = (await response.json()).result; assert(result?.ok, 'Owner settings could not be read'); return result.value;
  };
  const status = await read('status'), identity = await read('identity.get'), doc = await read('memory.global.get', { accountId: status.account.id });
  const persona = status.conversations.find(c => c.config?.persona?.name === '小胖')?.config.persona || status.persona;
  const fingerprint = value => hash({ persona: value.persona, modelConfig: value.modelConfig, settings: value.settings,
    conversations: value.conversations.map(c => ({ key: c.key, config: c.config })).sort((a, b) => a.key.localeCompare(b.key)) });
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending', actualWeChatMessages: 0, notificationsSent: 0,
    configuration: { hash: fingerprint(status), identityHash: hash(identity.markdown), notesHash: hash(doc.globalNotes), notesChars: doc.globalNotes.length },
    scenarios: [], failures: [], modelCalls: 0, startedAt: new Date().toISOString() };
  const persist = () => fs.writeFileSync(path.join(outputRoot, 'admin-notes-actual-responses.json'), JSON.stringify(report, null, 2));
  const notes = doc.globalNotes;
  assert(notes.includes('李有点胖') && /爹|爸爸/u.test(notes), 'The owner relationship note from the reported issue is not saved in the active account');
  const runner = new T.DshAgentRunner(ctx, () => ({ provider: selection.provider, model: selection.model }), () => ({ persona, identityMarkdown: identity.markdown,
    modelConfig: { ...status.modelConfig, webSearch: false }, workspacePath: path.join(outputRoot, 'synthetic-workspace') }));
  fs.mkdirSync(path.join(outputRoot, 'synthetic-workspace'), { recursive: true });
  const relation = text => { assert(text.includes('李有点胖') && /爹|爸爸|父亲/u.test(text), 'Saved owner relationship omitted'); assert(!/没(?:有)?爹|没有爸爸|东东倒/u.test(text), 'Old refusal overrode owner relationship'); };
  const cases = [];
  for (let repeat = 0; repeat < 3; repeat++) cases.push({ id: 'owner-relationship-' + repeat, request: { text: '你爹是谁？', mode: 'nickname', memory: '你之前答过一次：没爹，东东倒是有一个。' }, verify: relation });
  cases.push({ id: 'bare-name-current-message', request: { text: persona.name, mode: 'nickname', memory: '此前用户问你爹是谁，你回答没爹。当前只是再次呼叫名字，没有提出问题。' }, verify: text => { assert(!/爹|爸爸|父亲/u.test(text), 'Bare name resurrected the old question'); assert(text.trim()); } });
  cases.push({ id: 'natural-owner-relationship', request: { text: '你再说你爹是谁？', mode: 'natural', group: true,
    naturalDecision: { trigger: 'followup', temperament: 'balanced', smartSkip: true }, memory: '此前你曾回答没爹。' }, verify: relation });
  const now = Date.now();
  cases.push({ id: 'scheduled-current-time', request: { text: '现在提醒核对会议材料。', mode: 'scheduled', group: true,
    scheduledTask: { id: 'synthetic-saved-task', createdAt: now - 3600000, nextRunAt: now, schedule: { kind: 'once', at: now } }, memory: '' },
    verify: text => { assert(/会议材料/u.test(text)); assert(!/(?:到时候|到那天|稍后|明天|下周|再过).{0,8}(?:再提醒|提醒你)/u.test(text)); } });
  for (const scenario of cases) {
    const item = { id: scenario.id, automatedChecksPassed: false };
    try {
      let decision;
      const result = await runner.run({ ...scenario.request, adminNotes: notes, prompt: status.settings.prompt, group: true, tools: [], signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
        ...(scenario.request.mode === 'natural' ? { selectReplyText: raw => { item.raw = raw; decision = T.parseNaturalDecision(raw); return decision.text; } } : {}) });
      report.modelCalls++; item.text = result.text; if (decision) assert.equal(decision.action, 'reply'); scenario.verify(item.text); item.automatedChecksPassed = true;
    } catch (error) { item.error = error.name === 'AssertionError' || error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id: item.id, error: item.error }); }
    report.scenarios.push(item); persist(); onProgress({ phase: 'admin-notes-audit', completed: report.scenarios.length, total: cases.length, passed: item.automatedChecksPassed });
  }
  assert.equal(fingerprint(await read('status')), report.configuration.hash); assert.equal(hash((await read('identity.get')).markdown), report.configuration.identityHash);
  assert.equal(hash((await read('memory.global.get', { accountId: status.account.id })).globalNotes), report.configuration.notesHash);
  report.ownerConfigurationUnchanged = true; report.completed = true; report.automatedChecksPassed = !report.failures.length; report.finishedAt = new Date().toISOString(); persist(); return report;
};
