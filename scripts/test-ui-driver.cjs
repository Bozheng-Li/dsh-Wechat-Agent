const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const expectedVersion = require('../package.json').version;

const origin = process.env.WECHAT_UI_TEST_ORIGIN || process.argv[2], out = path.resolve(process.argv[3] || '');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '') || !process.argv[3]) throw new Error('Pass an isolated localhost fixture and a report directory');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(out, 'browser-profile'), { recursive: true });
app.setPath('userData', path.join(out, 'browser-profile'));
app.disableHardwareAcceleration();
const report = { ok: false, assertions: [], errors: [], screenshots: [], at: new Date().toISOString() };
let window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => window.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
async function waitFor(fn, args = [], timeout = 16000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await window.webContents.executeJavaScript('Promise.resolve((' + fn.toString() + ')(...' + JSON.stringify(args) + ')).then(Boolean)')) return;
    await pause(70);
  }
  throw new Error('UI wait timed out: ' + fn.toString().slice(0, 220));
}
async function click(selector) {
  await waitFor(s => { const el = document.querySelector(s); return el && !el.disabled; }, [selector]);
  await evaluate(s => { const el = document.querySelector(s); el.scrollIntoView({ block: 'center' }); el.click(); }, selector);
}
async function clickText(text, scope = '.wa-workspace') {
  await waitFor((text, scope) => Array.from(document.querySelector(scope)?.querySelectorAll('button') || []).some(el => (el.textContent.trim() === text || el.getAttribute('role') === 'tab' && el.textContent.trim().startsWith(text)) && !el.disabled), [text, scope]);
  await evaluate((text, scope) => { const el = Array.from(document.querySelector(scope).querySelectorAll('button')).find(el => (el.textContent.trim() === text || el.getAttribute('role') === 'tab' && el.textContent.trim().startsWith(text)) && !el.disabled); el.scrollIntoView({ block: 'center' }); el.click(); }, text, scope);
}
async function input(selector, value) {
  await waitFor(s => { const el = document.querySelector(s); return el && !el.disabled; }, [selector]);
  await evaluate((selector, value) => {
    const el = document.querySelector(selector);
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}
const fixture = (command, payload = {}) => evaluate((command, payload) => window.__uiFixture(command, payload), command, payload);
const value = selector => evaluate(selector => document.querySelector(selector)?.value, selector);
async function stateMatches(fn, ...args) {
  await waitFor(async (source, args) => (0, eval)('(' + source + ')')(await window.__uiFixture('state'), ...args), [fn.toString(), args]);
}
async function theme(name) {
  await evaluate(name => { document.documentElement.dataset.theme = name; document.documentElement.classList.toggle('dark', name === 'dark'); }, name);
  await pause(100);
}
async function screenshot(name, selectedTheme = 'dark') {
  await theme(selectedTheme);
  await evaluate(() => document.querySelector('.wa-workspace')?.scrollTo({ top: 0, left: 0 }));
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  await pause(150);
  fs.writeFileSync(path.join(out, name + '.png'), (await window.webContents.capturePage()).toPNG());
  report.screenshots.push(name + '.png');
}
async function assertLayout(label) {
  const result = await evaluate(() => {
    const panel = document.querySelector('.wa-panel'), shell = document.querySelector('.wa-shell'), workspace = document.querySelector('.wa-workspace');
    return { viewport: window.innerWidth, document: document.documentElement.scrollWidth, panel: [panel.clientWidth, panel.scrollWidth], shell: [shell.clientWidth, shell.scrollWidth], workspace: [workspace.clientWidth, workspace.scrollWidth] };
  });
  assert(result.document <= result.viewport + 1 && [result.panel, result.shell, result.workspace].every(([client, scroll]) => scroll <= client + 1), label + ' has horizontal overflow: ' + JSON.stringify(result));
}
function check(name) { report.assertions.push(name); }
const peer = (state, id) => state.conversations.find(item => item.peerId === id);

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1280, height: 940, useContentSize: true, autoHideMenuBar: true, backgroundColor: '#1b1d22',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  window.setMenu(null);
  window.webContents.on('console-message', event => {
    const severity = event.level, text = String(event.message ?? '');
    if ((severity === 'error' || severity === 3) && !text.includes('favicon.ico')) report.errors.push(text.slice(0, 600));
  });
  window.webContents.on('render-process-gone', (_event, details) => report.errors.push('Renderer exited: ' + details.reason));
  const watchdog = setTimeout(() => { report.failure = 'UI verification exceeded 210 seconds'; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); app.exit(1); }, 210000);
  try {
    await window.loadURL(origin);
    await waitFor(() => typeof window.__uiFixture === 'function' && document.querySelector('.wa-account-name')?.textContent.includes('界面测试'));
    assert.equal((await fixture('state')).account.id, 'wxid_ui_fixture', 'Refuse to operate outside the synthetic fixture');
    await assertLayout('desktop overview');
    await screenshot('overview-desktop-dark'); await screenshot('overview-desktop-light', 'light');
    check('real React page with real isolated StateStore/RPC service');

    await click('[data-testid="nav-settings"]');
    assert.equal(await evaluate(() => !!document.querySelector('#wa-persona-name')), false);
    await click('[data-testid="open-changelog"]');
    await waitFor(version => document.querySelector('[data-testid="changelog-content"]')?.textContent.includes(version), [expectedVersion]);
    assert.equal(await evaluate(() => document.querySelector('[data-testid="nav-settings"]').getAttribute('aria-current')), 'page');
    await screenshot('changelog-desktop-dark');
    await clickText('返回设置');
    check('dedicated changelog page reads shared CHANGELOG.md through read-only RPC');
    await click('[data-testid="open-model"]');
    await waitFor(() => document.querySelector('#wa-model'));
    assert.equal(await evaluate(() => !!document.querySelector('#wa-persona-name')), false);
    await clickText('配置人设');
    const originalPersona = (await fixture('state')).persona;
    const customPrompt = '你是小胖，喜欢有依据的讨论，性格温和、有一点幽默。用自然短句接话，不机械复述。';
    await input('#wa-persona-prompt', customPrompt);
    await click('details.wa-subsection summary');
    await input('#wa-persona-name', '小胖'); await input('#wa-persona-aliases', '胖胖\n小胖同学');
    await pause(2300); assert.equal(await value('#wa-persona-prompt'), customPrompt);
    assert.equal(await evaluate(() => !!document.querySelector('#wa-persona-background')), false);
    await click('[data-testid="browse-persona-presets"]');
    await waitFor(() => document.querySelectorAll('.wa-persona-card').length === 18);
    assert.equal(await evaluate(() => document.querySelectorAll('.wa-persona-filter').length), 7);
    await assertLayout('desktop persona library'); await screenshot('persona-library-desktop-dark'); await screenshot('persona-library-desktop-light', 'light');
    await input('[data-testid="persona-search"]', '没有这样的角色');
    await waitFor(() => document.querySelectorAll('.wa-persona-card').length === 0);
    await clickText('查看全部人设');
    await input('[data-testid="persona-search"]', '傲娇');
    await waitFor(() => document.querySelectorAll('.wa-persona-card').length === 1);
    await click('.wa-persona-card[data-preset-id="xingli"]');
    await waitFor(() => document.querySelector('[data-testid="persona-preset-preview"]'));
    assert.equal(await evaluate(() => document.querySelectorAll('.wa-persona-example').length), 2);
    await assertLayout('desktop persona preview'); await screenshot('persona-preview-desktop-dark'); await screenshot('persona-preview-desktop-light', 'light');
    await click('.wa-back'); assert.equal(await value('[data-testid="persona-search"]'), '傲娇');
    await input('[data-testid="persona-search"]', ''); await click('[data-category="social"]');
    await waitFor(() => document.querySelectorAll('.wa-persona-card').length === 3);
    await click('.wa-persona-card[data-preset-id="aci"]');
    assert.equal(await evaluate(() => document.querySelector('#wa-preset-keep-identity').checked), true);
    await click('[data-testid="load-persona-preset"]');
    await waitFor(() => document.querySelector('[data-testid="preset-loaded-notice"]'));
    const loadedPrompt = await value('#wa-persona-prompt'); assert(loadedPrompt.includes('语气示例'));
    assert.equal(await value('#wa-persona-name'), '小胖');
    assert.deepEqual((await fixture('state')).persona, originalPersona, 'loading is not saving');
    await pause(2300); assert.equal(await value('#wa-persona-prompt'), loadedPrompt);
    await clickText('撤销载入'); assert.equal(await value('#wa-persona-prompt'), customPrompt);
    check('single persona textarea, 18 rich presets, category/search/preview, draft-only load and undo preserve existing edits');
    assert(await evaluate(() => document.querySelector('.wa-panel').textContent.includes('全局自然聊天规则 · 始终生效')));
    await click('[data-testid="browse-persona-presets"]'); await click('.wa-persona-card[data-preset-id="luoshu"]');
    await click('#wa-preset-keep-identity'); await click('[data-testid="load-persona-preset"]');
    await waitFor(() => document.querySelector('#wa-persona-name')?.value === '洛书');
    const expectedPrompt = await value('#wa-persona-prompt');
    await fixture('failNext', { endpoint: 'persona.save' }); await clickText('保存人设');
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await value('#wa-persona-prompt'), expectedPrompt); assert.deepEqual((await fixture('state')).persona, originalPersona);
    await clickText('保存人设'); await stateMatches((state, prompt) => state.persona.name === '洛书' && state.persona.prompt === prompt, expectedPrompt);
    await waitFor(() => !document.querySelector('[data-testid="preset-loaded-notice"]'));
    await screenshot('persona-desktop-dark'); await screenshot('persona-desktop-light', 'light');
    check('loading can replace identity explicitly; failed save preserves rich draft; retry saves complete persona');

    await clickText('返回模型设置');
    await input('#wa-model', JSON.stringify(['fixture', 'beta']));
    await stateMatches(s => s.modelChoice?.model === 'beta');
    await input('#wa-max-tokens', '2048'); await input('#wa-temperature', '0.7');
    await clickText('保存生成参数');
    await stateMatches(s => s.modelConfig.maxTokens === 2048 && s.modelConfig.temperature === 0.7);
    await click('[data-testid="model-advanced"] summary');
    await click('[aria-label="启用图像理解"]'); await click('[aria-label="启用联网搜索"]'); await clickText('保存生成参数');
    await stateMatches(state => state.modelConfig.vision === false && state.modelConfig.webSearch === true);
    await click('[aria-label="启用图像理解"]'); await clickText('保存生成参数');
    await stateMatches(state => state.modelConfig.vision === true && state.modelConfig.webSearch === true);
    check('model advanced settings persist real vision and web search switches');
    await input('#wa-vision-model', JSON.stringify(['fixture', 'alpha'])); await clickText('保存生成参数');
    await stateMatches(state => state.modelConfig.visionModel?.provider === 'fixture' && state.modelConfig.visionModel?.model === 'alpha' && state.modelChoice?.model === 'beta');
    await assertLayout('desktop model advanced settings'); await screenshot('model-advanced-desktop-dark'); await screenshot('model-advanced-desktop-light', 'light');
    check('an independent visual model saves without changing the reply model');
    await input('#wa-prompt', '适当追问，避免太长。');
    await clickText('保存补充要求');
    await stateMatches(s => s.settings.prompt === '适当追问，避免太长。');
    check('model choice, generation parameters and account-specific instructions persist');

    await click('[data-testid="nav-authorization"]');
    await waitFor(() => document.querySelector('[data-peer-id="group_alpha@chatroom"]'));
    await input('[data-testid="add-conversation-name"]', '李');
    await waitFor(() => document.querySelectorAll('.wa-name-suggestions .wa-session-row').length === 2);
    await clickText('授权', '.wa-name-suggestions [data-peer-id="wxid_li_ming"]');
    await stateMatches(state => state.settings.privatePeers.includes('wxid_li_ming'));
    await input('[data-testid="add-conversation-name"]', '');
    check('adding by partial WeChat name lists all matches and grants only the selected contact');
    await input('[data-testid="conversation-search"]', '产品');
    await waitFor(() => document.querySelectorAll('.wa-session-row').length === 2);
    await input('[data-testid="conversation-search"]', '产品负责人');
    await waitFor(() => document.querySelectorAll('.wa-session-row').length === 1 && document.querySelector('.wa-session-row').dataset.peerId === 'wxid_alice');
    await input('[data-testid="conversation-search"]', 'GROUP_ALPHA@CHATROOM');
    await waitFor(() => document.querySelectorAll('.wa-session-row').length === 1 && document.querySelector('.wa-session-row').dataset.peerId === 'group_alpha@chatroom');
    check('authorization search supports names, distinct remarks, IDs and case folding');
    await clickText('设置', '.wa-session-row[data-peer-id="group_alpha@chatroom"]');
    await click('input[name="wa-group-mode"][value="nickname"]');
    await clickText('保存会话设置');
    await stateMatches(s => s.conversations.find(c => c.peerId === 'group_alpha@chatroom')?.config.mode === 'nickname');
    await click('input[name="wa-group-mode"][value="participate"]');
    await input('[aria-label="主动参与最少消息数"]', '7');
    await input('[aria-label="主动参与最多消息数"]', '12');
    await clickText('保存会话设置');
    await stateMatches(s => { const c = s.conversations.find(c => c.peerId === 'group_alpha@chatroom')?.config; return c?.mode === 'participate' && c.minMessages === 7 && c.maxMessages === 12; });
    assert.equal(peer(await fixture('state'), 'group_beta@chatroom').config.mode, 'default');
    const paths = await fixture('paths');
    await input('[aria-label="主动参与间隔模式"]', 'fixed'); await input('[aria-label="主动参与固定消息数"]', '100');
    await clickText('保存会话设置'); await stateMatches(state => state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config.fixedMessages === 100);
    await input('[aria-label="主动参与间隔模式"]', 'random'); await input('[aria-label="主动参与最少消息数"]', '1'); await input('[aria-label="主动参与最多消息数"]', '100');
    await input('#wa-memory-window', '24000'); await clickText('保存会话设置');
    await stateMatches(state => { const config = state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config; return config.intervalMode === 'random' && config.minMessages === 1 && config.maxMessages === 100 && config.memoryWindowChars === 24000; });
    assert(await evaluate(() => document.querySelector('.wa-radio-list').textContent.includes('立即回应')));
    check('progressive mode explanation, 1–100 random/fixed interval and per-room memory window are usable');
    await click('details.wa-subsection summary');
    await input('#wa-conversation-path', paths.conversationPath);
    await clickText('保存会话设置');
    await stateMatches((s, target) => s.conversations.find(c => c.peerId === 'group_alpha@chatroom')?.config.recordsPath === target, paths.conversationPath);
    let current = await fixture('state');
    assert.equal(peer(current, 'group_alpha@chatroom').recordCount, 63);
    assert(fs.existsSync(peer(current, 'group_alpha@chatroom').recordsPath));
    check('per-group modes, random bounds and dedicated history directory save independently');

    await click('[data-testid="nav-authorization"]');
    await input('[data-testid="conversation-search"]', '');
    await clickText('发现会话');
    await input('[data-testid="conversation-search"]', '视觉设计');
    await waitFor(() => document.querySelector('.wa-session-row')?.dataset.peerId === 'wxid_bob');
    await clickText('授权', '.wa-session-row[data-peer-id="wxid_bob"]');
    await stateMatches(s => s.settings.privatePeers.includes('wxid_bob'));
    await click('[aria-label="撤销 Bob·设计同事 的授权"]');
    await stateMatches(s => !s.settings.privatePeers.includes('wxid_bob'));
    await input('[data-testid="conversation-search"]', 'group_gamma@chatroom');
    await clickText('授权', '.wa-session-row[data-peer-id="group_gamma@chatroom"]');
    await stateMatches(s => s.settings.groups.includes('group_gamma@chatroom'));
    assert.equal(peer(await fixture('state'), 'group_gamma@chatroom').config.mode, 'default');
    await input('[data-testid="conversation-search"]', '');
    await clickText('已授权');
    await screenshot('authorization-desktop-dark'); await screenshot('authorization-desktop-light', 'light');
    check('grant/revoke private authorization and new groups retain default reply mode');

    await click('[data-testid="nav-records"]');
    await click('.wa-records-peer[data-peer-id="group_alpha@chatroom"]');
    await waitFor(() => document.querySelectorAll('.wa-record').length === 50);
    assert(await evaluate(() => Array.from(document.querySelectorAll('.wa-record-question')).every(el => el.textContent.includes('ALPHA'))));
    assert.equal(await evaluate(() => document.querySelector('.wa-records-location').open), false);
    await click('.wa-records-location summary');
    assert.equal(await evaluate(() => document.querySelector('.wa-records-location .wa-path-value').textContent), peer(await fixture('state'), 'group_alpha@chatroom').recordsPath);
    await click('.wa-records-location summary');
    check('record storage path expands on demand instead of crowding out messages');
    const firstPageKeys = await evaluate(() => Array.from(document.querySelectorAll('.wa-record')).map(el => el.dataset.recordKey));
    await click('.wa-record summary');
    await waitFor(async () => !!(await window.__uiFixture('stats')).lastHistoryRequest?.anchor);
    await fixture('appendRecords', { count: 2 });
    await waitFor(() => document.querySelector('[data-testid="new-records-notice"]')?.textContent.includes('有 2 条'));
    assert.deepEqual(await evaluate(() => Array.from(document.querySelectorAll('.wa-record')).map(el => el.dataset.recordKey)), firstPageKeys);
    assert(await evaluate(() => !!document.querySelector('.wa-record[open]')));
    await clickText('下一页');
    await waitFor(() => document.querySelectorAll('.wa-record').length === 13);
    assert(await evaluate(() => Array.from(document.querySelectorAll('.wa-record-question')).every(el => el.textContent.includes('ALPHA'))));
    const secondPageKeys = await evaluate(() => Array.from(document.querySelectorAll('.wa-record')).map(el => el.dataset.recordKey));
    assert.equal(new Set([...firstPageKeys, ...secondPageKeys]).size, 63);
    const latest = await fixture('appendRecords', { count: 2 });
    await waitFor(() => document.querySelector('[data-testid="new-records-notice"]')?.textContent.includes('有 4 条'));
    assert.deepEqual(await evaluate(() => Array.from(document.querySelectorAll('.wa-record')).map(el => el.dataset.recordKey)), secondPageKeys);
    await clickText('查看最新记录');
    await waitFor(key => document.querySelector('.wa-record')?.dataset.recordKey === key, [latest.keys.at(-1)]);
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="new-records-notice"]')), false);
    assert(await evaluate(() => document.querySelector('.wa-pagination').textContent.includes('共 67 条')));
    check('expanded records and older pages keep their position as new records arrive; explicit refresh returns to newest');
    await click('.wa-records-peer[data-peer-id="group_beta@chatroom"]');
    await waitFor(() => document.querySelectorAll('.wa-record').length === 3);
    assert(await evaluate(() => Array.from(document.querySelectorAll('.wa-record-question')).every(el => el.textContent.includes('BETA'))));
    await input('[data-testid="records-conversation-search"]', '产品讨论组');
    await waitFor(() => document.querySelectorAll('.wa-records-peer').length === 1);
    await click('.wa-records-peer[data-peer-id="group_alpha@chatroom"]');
    await waitFor(() => document.querySelectorAll('.wa-record').length === 50);
    await input('[data-testid="records-conversation-search"]', '');
    await assertLayout('desktop records');
    await screenshot('records-desktop-dark'); await screenshot('records-desktop-light', 'light');
    check('conversation-specific history, 50/13 pagination and switching to 3 BETA records without mixing');

    await click('[data-testid="nav-settings"]'); await click('[data-testid="open-storage"]');
    await input('#wa-workspace-path', paths.workspacePath); await input('#wa-records-path', paths.recordsPath);
    await clickText('保存路径并应用');
    await stateMatches((s, p) => s.storage.workspacePath === p.workspacePath && s.storage.recordsPath === p.recordsPath, paths);
    current = await fixture('state');
    assert(fs.existsSync(paths.workspacePath)); assert(fs.existsSync(paths.recordsPath));
    assert.equal(peer(current, 'group_alpha@chatroom').config.recordsPath, paths.conversationPath);
    assert.equal(peer(current, 'group_alpha@chatroom').recordCount, 67);
    assert.equal(peer(current, 'group_beta@chatroom').recordCount, 3);
    assert(peer(current, 'group_beta@chatroom').recordsPath.startsWith(paths.recordsPath + path.sep));
    check('global workspace/history migration preserves overrides and records on disk');

    await click('[data-testid="nav-memory"]');
    const chooseAlpha = await evaluate(() => Array.from(document.querySelector('[aria-label="选择会话"]').options).find(option => option.textContent.includes('产品讨论组')).value);
    await input('[aria-label="选择会话"]', chooseAlpha);
    await waitFor(() => document.querySelector('[data-testid="memory-document"]')?.textContent.includes('产品讨论组'));
    await input('[aria-label="记忆摘要"]', '这是一份用于界面验证的长期记忆：群里约定周五讨论产品。');
    await clickText('保存记忆'); await waitFor(() => document.querySelector('[role="status"]')?.textContent.includes('已保存'));
    await assertLayout('desktop memory'); await screenshot('memory-desktop-dark'); await screenshot('memory-desktop-light', 'light');
    assert(await evaluate(() => document.querySelector('.wa-memory-preview').textContent.includes('ALPHA')));
    assert.equal(await evaluate(() => document.querySelector('.wa-memory-preview').textContent.includes('BETA')), false);
    const localSummary = await value('[aria-label="记忆摘要"]'), globalNotes = '共同约定：默认用中文；周五下午留出时间讨论产品方案。';
    await clickText('全局长期记忆'); await waitFor(() => document.querySelector('[data-testid="global-memory-document"]'));
    await input('[aria-label="全局通用备注"]', globalNotes);
    await clickText('会话记忆窗口'); assert.equal(await value('[aria-label="记忆摘要"]'), localSummary);
    await clickText('全局长期记忆'); assert.equal(await value('[aria-label="全局通用备注"]'), globalNotes);
    await fixture('failNext', { endpoint: 'memory.global.edit' }); await clickText('保存全局备注');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(el => el.textContent.includes('模拟保存失败')));
    assert.equal(await value('[aria-label="全局通用备注"]'), globalNotes); assert.equal((await fixture('globalMemory')).globalNotes, '');
    await clickText('保存全局备注');
    await waitFor(async notes => (await window.__uiFixture('globalMemory')).globalNotes === notes, [globalNotes]);
    const globalDocument = await fixture('globalMemory'); assert(fs.readFileSync(globalDocument.path, 'utf8').includes(globalNotes));
    await assertLayout('desktop global memory'); await screenshot('global-memory-desktop-dark'); await screenshot('global-memory-desktop-light', 'light');
    await clickText('会话记忆窗口'); assert.equal(await value('[aria-label="记忆摘要"]'), localSummary);
    await clickText('清空当前记忆'); await clickText('确认清空这份记忆');
    await waitFor(() => document.querySelector('[data-testid="memory-document"]')?.textContent.includes('0 条近期消息'));
    assert.equal(peer(await fixture('state'), 'group_alpha@chatroom').recordCount, 67);
    check('separate memory menu shows selected room, saves corrections, and clears memory without deleting chat history');
    assert.equal((await fixture('globalMemory')).globalNotes, globalNotes);
    await clickText('全局长期记忆'); assert.equal(await value('[aria-label="全局通用备注"]'), globalNotes);
    check('global Markdown notes keep drafts across tabs, survive failed save/retry and remain after clearing the conversation window');
    await click('[data-testid="nav-tasks"]');
    const taskAlpha = await evaluate(() => Array.from(document.querySelector('[aria-label="选择会话"]').options).find(option => option.textContent.includes('产品讨论组')).value);
    await input('[aria-label="选择会话"]', taskAlpha);
    await input('[aria-label="定时任务内容"]', '合成提醒：吃饭；此测试不会启动调度或发送微信。');
    await clickText('保存定时任务'); await waitFor(() => document.querySelectorAll('.wa-task').length === 1);
    let task = (await fixture('stats')).tasks[0]; assert.equal(task.peerId, 'group_alpha@chatroom'); assert.equal(task.state, 'pending');
    await clickText('暂停', '.wa-task'); await waitFor(async () => (await window.__uiFixture('stats')).tasks[0].state === 'paused');
    await clickText('恢复', '.wa-task'); await waitFor(async () => (await window.__uiFixture('stats')).tasks[0].state === 'pending');
    await assertLayout('desktop tasks'); await screenshot('tasks-desktop-dark'); await screenshot('tasks-desktop-light', 'light');
    await clickText('取消任务', '.wa-task'); await waitFor(async () => (await window.__uiFixture('stats')).tasks[0].state === 'cancelled');
    check('task form saves durable room-bound schedule; list pause/resume/cancel reflects actual saved states');

    await click('[data-testid="nav-assets"]'); await waitFor(() => document.querySelector('[data-testid="asset-upload-input"]'));
    await evaluate(async () => {
      const fixture = await window.__uiFixture('assetZip'), binary = atob(fixture.data), bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], fixture.name, { type: 'application/zip' }));
      const input = document.querySelector('[data-testid="asset-upload-input"]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 2 && document.querySelector('[role="status"]')?.textContent.includes('已导入 2 张'));
    const uploads = (await fixture('stats')).assetUploadRequests;
    assert.deepEqual(uploads.map(item => item.endpoint), ['assets.upload.start', 'assets.upload.chunk', 'assets.upload.chunk', 'assets.upload.finish']);
    assert(uploads.every(item => item.accountId === 'wxid_ui_fixture'));
    assert.deepEqual(uploads.filter(item => item.endpoint === 'assets.upload.chunk').map(item => item.offset), [0, 262144]);
    assert.equal((await fixture('assets')).total, 2);
    await click('[aria-label="预览并编辑 红色方块"]');
    await waitFor(() => { const image = document.querySelector('.wa-assets-large-preview img'); return image?.complete && image.naturalWidth === 2; });
    assert((await evaluate(() => document.querySelector('.wa-assets-large-preview img').src)).startsWith('data:image/png;base64,'));
    await clickText('关闭', '[role="dialog"]');
    check('the real file input imports a ZIP across two 256 KiB chunks and previews the original PNG');

    await clickText('理解未填写含义的素材');
    await waitFor(async () => (await window.__uiFixture('assets')).counts.described === 2);
    assert.deepEqual((await fixture('stats')).assetAnalysisRequests, [2]);
    await waitFor(() => document.querySelector('[role="status"]')?.textContent.includes('已理解 2 张'));
    await click('[data-testid="asset-settings"] summary');
    await input('[aria-label="素材自动使用概率"]', '35'); await input('[aria-label="素材最少消息间隔"]', '5'); await clickText('保存使用设置');
    await waitFor(async () => { const settings = (await window.__uiFixture('assets')).settings; return settings.enabled && settings.probability === 35 && settings.minGapMessages === 5; });
    await click('[aria-label="预览并编辑 红色方块"]');
    await input('[aria-label="素材名称"]', '讨论赞同'); await input('[aria-label="素材含义"]', '红色方块，用于熟人讨论中的肯定；安慰难过的人时不用。'); await input('[aria-label="素材标签"]', '赞同，讨论');
    await click('[aria-label="启用这张素材"]');
    await fixture('failNext', { endpoint: 'assets.edit' }); await clickText('保存素材', '[role="dialog"]');
    await waitFor(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await value('[aria-label="素材名称"]'), '讨论赞同'); assert((await fixture('assets')).items.find(item => item.name === '红色方块')?.enabled);
    await clickText('保存素材', '[role="dialog"]'); await waitFor(() => !document.querySelector('[role="dialog"]'));
    const editedAsset = (await fixture('assets')).items.find(item => item.name === '讨论赞同'); assert(editedAsset && !editedAsset.enabled && editedAsset.tags.includes('讨论'));
    await input('[aria-label="搜索表情或图片"]', '安慰'); await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 1);
    assert.equal(await evaluate(() => document.querySelector('.wa-asset-card').dataset.assetId), editedAsset.id);
    await input('[aria-label="搜索表情或图片"]', ''); await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 2);
    await assertLayout('desktop media library'); await screenshot('assets-desktop-dark'); await screenshot('assets-desktop-light', 'light');
    await click('[aria-label="预览并编辑 讨论赞同"]'); await waitFor(() => document.querySelector('.wa-assets-large-preview img')?.complete);
    await assertLayout('desktop media editor'); await screenshot('assets-editor-desktop-dark'); await screenshot('assets-editor-desktop-light', 'light');
    await clickText('关闭', '[role="dialog"]');
    check('synthetic image descriptions, probability/gap settings, metadata search and disable/edit retry persist through real RPC');
    await click('[aria-label="选择 讨论赞同"]'); await clickText('删除选中'); await clickText('确认删除素材');
    await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 1 && !document.querySelector('.wa-assets-delete'));
    assert.equal((await fixture('assets')).items[0].name, '绿色方块');
    check('confirmed asset deletion removes only the selected image and leaves the other available');

    window.setContentSize(430, 900);
    await assertLayout('narrow media library'); await screenshot('assets-narrow-dark'); await screenshot('assets-narrow-light', 'light');
    await click('[aria-label="预览并编辑 绿色方块"]'); await waitFor(() => document.querySelector('.wa-assets-large-preview img')?.complete);
    await assertLayout('narrow media editor'); await screenshot('assets-editor-narrow-dark'); await screenshot('assets-editor-narrow-light', 'light');
    const editorLayout = await evaluate(() => { const dialog = document.querySelector('[role="dialog"]'); return { width: dialog.clientWidth, scroll: dialog.scrollWidth, left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right, viewport: innerWidth }; });
    assert(editorLayout.scroll <= editorLayout.width + 1 && editorLayout.left >= 0 && editorLayout.right <= editorLayout.viewport);
    await clickText('关闭', '[role="dialog"]');
    await click('[data-testid="nav-memory"]'); await clickText('全局长期记忆'); await waitFor(() => document.querySelector('[data-testid="global-memory-document"]'));
    assert.equal(await value('[aria-label="全局通用备注"]'), globalNotes); await assertLayout('narrow global memory'); await screenshot('global-memory-narrow-dark'); await screenshot('global-memory-narrow-light', 'light');
    await click('[data-testid="nav-tasks"]');
    await assertLayout('narrow tasks'); await screenshot('tasks-narrow-dark');
    await click('[data-testid="nav-memory"]'); await waitFor(() => document.querySelector('[data-testid="memory-document"]')); await assertLayout('narrow memory'); await screenshot('memory-narrow-light', 'light');
    await click('[data-testid="nav-overview"]'); await assertLayout('narrow overview'); await screenshot('overview-narrow-dark');
    await click('[data-testid="nav-authorization"]'); await assertLayout('narrow authorization'); await screenshot('authorization-narrow-light', 'light');
    await click('[data-testid="nav-settings"]'); await click('[data-testid="open-persona"]'); await assertLayout('narrow persona'); await screenshot('persona-narrow-dark');
    await click('[data-testid="browse-persona-presets"]'); await assertLayout('narrow persona library'); await screenshot('persona-library-narrow-dark');
    await click('.wa-persona-card[data-preset-id="aci"]'); await assertLayout('narrow persona preview'); await screenshot('persona-preview-narrow-light', 'light');
    await click('[data-testid="nav-records"]'); await click('.wa-records-peer[data-peer-id="group_beta@chatroom"]');
    await waitFor(() => document.querySelectorAll('.wa-record').length === 3);
    await assertLayout('narrow records'); await screenshot('records-narrow-dark'); await screenshot('records-narrow-light', 'light');
    check('1280×940 and 430×900 layouts have no horizontal overflow; light/dark screenshots captured');

    await fixture('queueTasks');
    await click('.wa-records-peer[data-peer-id="group_alpha@chatroom"]');
    await waitFor(() => !document.querySelector('[data-testid="cancel-conversation"]')?.disabled);
    await click('[data-testid="cancel-conversation"]');
    await stateMatches(s => s.conversations.find(c => c.peerId === 'group_alpha@chatroom')?.processing.queued === 0);
    current = await fixture('state');
    assert.equal(peer(current, 'group_beta@chatroom').processing.queued, 1);
    assert.equal(current.processing.queued, 1);
    assert.deepEqual((await fixture('stats')).cancelRequests.at(-1), { accountId: current.account.id, chatType: 'group', peerId: 'group_alpha@chatroom' });
    await waitFor(() => document.querySelector('[data-testid="cancel-conversation"]')?.disabled);
    await click('.wa-records-peer[data-peer-id="group_beta@chatroom"]');
    await waitFor(() => !document.querySelector('[data-testid="cancel-conversation"]')?.disabled);
    await assertLayout('narrow records with selected pending tasks');
    await clickText('取消全部回复任务');
    await stateMatches(s => s.processing.queued === 0);
    check('selected conversation cancellation sends an account-bound selector and preserves other queued tasks; global cancel stays explicit');

    await fixture('switchAccount');
    await waitFor(() => !document.querySelector('.wa-records-peer') && !document.querySelector('.wa-record'));
    assert.equal(await evaluate(() => /ALPHA|BETA/.test(document.querySelector('.wa-records-main').textContent)), false);
    assert.equal((await fixture('state')).account.id, 'wxid_ui_other');
    check('account switch clears previous conversation selection, records and authorization');
    assert.equal((await fixture('assets')).total, 0); assert.equal((await fixture('globalMemory')).globalNotes, '');
    check('the next account cannot see the previous account image library or global notes');
    assert.deepEqual(report.errors, [], 'Browser errors must be resolved');
    report.ok = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    try { fs.writeFileSync(path.join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
  } finally {
    clearTimeout(watchdog);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, assertions: report.assertions.length, screenshots: report.screenshots.length, errors: report.errors, failure: report.failure, report: path.join(out, 'report.json') }, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error.message); app.exit(1); });
