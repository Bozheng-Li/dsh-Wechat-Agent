/* Read-only checks of the owner's active prompt configuration. All questions,
 * memory and images are synthetic; no WeChat transport or chat history is used. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

exports.runPersonaAudit = async ({ ctx, testing: T, outputRoot, signal, selection, onProgress }) => {
  const directory = path.join(outputRoot, 'persona'); fs.mkdirSync(directory, { recursive: true });
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending',
    actualWeChatMessages: 0, notificationsSent: 0, scenarios: [], failures: [], sessionIds: [], startedAt: new Date().toISOString() };
  const persist = () => fs.writeFileSync(path.join(directory, 'actual-prompt-responses.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const origin = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
  assert(/^https?:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal }); assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const read = async method => {
    assert(['status', 'identity.get'].includes(method));
    const response = await fetch(origin + '/wechat-agent/' + method, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'prompt-config-audit-' + Date.now(), method, payload: {} }) });
    assert(response.ok); const result = (await response.json()).result; assert(result?.ok, method + ': ' + (result?.error?.code || 'RPC_FAILED')); return result.value;
  };
  const status = await read('status'), identity = await read('identity.get');
  const fingerprint = value => hash({ persona: value.persona, modelConfig: value.modelConfig, settings: value.settings,
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
  report.model = { provider: selection.provider, model: selection.model };
  const cases = [];
  const testCase = (id, run) => cases.push({ id, run });
  for (const config of configurations.values()) {
    const base = { persona: config.persona, identityMarkdown: identity.markdown, modelConfig: { ...status.modelConfig, webSearch: false },
      workspacePath: path.join(directory, 'synthetic-workspaces', config.id) };
    fs.mkdirSync(base.workspacePath, { recursive: true });
    const invoke = async (item, request) => {
      const runner = new T.DshAgentRunner(ctx, () => report.model, () => base);
      item.calls ??= []; const call = { mode: request.mode || 'default' }; item.calls.push(call);
      const result = await runner.run({ ...request, prompt: status.settings?.prompt || '', tools: [],
        signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]), onSession: id => { call.sessionId = id; report.sessionIds.push(id); } });
      call.text = result.text; call.replyStyleWarning = result.replyStyleWarning; item.text = result.text; return result;
    };
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
  // Probe the exact FTS transaction in the running Electron process, retaining
  // only runtime/SQL errors from this isolated file, never owner prompt text.
  const sqliteProbe = { versions: { node: process.versions.node, electron: process.versions.electron, sqlite: process.versions.sqlite } };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(path.join(directory, 'synthetic-fts-probe.sqlite'));
    db.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA max_page_count = 65536; CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE VIRTUAL TABLE lookup USING fts5(title_tokens, body_tokens, document_id UNINDEXED, library_id UNINDEXED, chunk_id UNINDEXED, label UNINDEXED, title UNINDEXED, text UNINDEXED, tokenize='porter unicode61 remove_diacritics 2'); BEGIN IMMEDIATE;");
    db.prepare('INSERT INTO lookup(title_tokens, body_tokens, document_id, library_id, chunk_id, label, title, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('政策', '退款 期限 七天', 'doc', 'lib', 'chunk', 'label', '政策', '退款期限七天');
    db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('identity', '{}'); db.exec('COMMIT;'); sqliteProbe.ok = true;
  } catch (error) { sqliteProbe.error = { code: error.code, message: error.message }; }
  finally { db?.close(); }
  report.sqliteProbe = sqliteProbe;
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const scenario = cases[next++], item = { id: scenario.id, calls: [], automatedChecksPassed: false, startedAt: new Date().toISOString() };
      try { signal.throwIfAborted(); await scenario.run(item); item.automatedChecksPassed = true; }
      catch (error) { item.error = error.name === 'AssertionError' || error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id: item.id, error: item.error }); }
      item.finishedAt = new Date().toISOString(); report.scenarios.push(item); persist();
      onProgress({ phase: 'active-prompt-audit', scenario: item.id, completed: report.scenarios.length, total: cases.length, passed: item.automatedChecksPassed });
    }
  };
  await Promise.all([worker(), worker()]);
  const after = await read('status'), identityAfter = await read('identity.get');
  assert.equal(fingerprint(after), before, 'owner configuration changed during prompt audit'); assert.equal(hash(identityAfter.markdown), identityBefore);
  report.ownerConfigurationUnchanged = true; report.completed = true; report.automatedChecksPassed = !report.failures.length;
  report.modelCalls = report.scenarios.reduce((sum, s) => sum + s.calls.length, 0); report.finishedAt = new Date().toISOString(); persist(); return report;
};
