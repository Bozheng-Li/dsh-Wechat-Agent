const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

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
  const watchdog = setTimeout(() => { report.failure = 'UI verification exceeded 150 seconds'; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); app.exit(1); }, 150000);
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
    await waitFor(() => document.querySelector('[data-testid="changelog-content"]')?.textContent.includes('0.2.0-preview.1'));
    assert.equal(await evaluate(() => document.querySelector('[data-testid="nav-settings"]').getAttribute('aria-current')), 'page');
    await screenshot('changelog-desktop-dark');
    await clickText('返回设置');
    check('dedicated changelog page reads shared CHANGELOG.md through read-only RPC');
    await click('[data-testid="open-model"]');
    await waitFor(() => document.querySelector('#wa-model'));
    assert.equal(await evaluate(() => !!document.querySelector('#wa-persona-name')), false);
    await clickText('配置人设');
    await input('#wa-persona-name', '小胖');
    await input('#wa-persona-aliases', '胖胖\n小胖同学');
    await input('#wa-persona-background', '群里的产品与设计爱好者，喜欢一起讨论新想法。');
    await input('#wa-persona-personality', '性格温和，幽默，喜欢有依据的讨论。不确定时直说。');
    await input('#wa-persona-style', '使用自然中文短句，不机械复述。');
    await pause(2300);
    assert.equal(await value('#wa-persona-personality'), '性格温和，幽默，喜欢有依据的讨论。不确定时直说。');
    check('separate settings pages and unsaved persona survives polling');
    await fixture('failNext', { endpoint: 'persona.save' });
    await clickText('保存人设');
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await value('#wa-persona-personality'), '性格温和，幽默，喜欢有依据的讨论。不确定时直说。');
    assert.notEqual((await fixture('state')).persona.personality, '性格温和，幽默，喜欢有依据的讨论。不确定时直说。');
    await clickText('保存人设');
    await stateMatches(s => s.persona.personality === '性格温和，幽默，喜欢有依据的讨论。不确定时直说。');
    assert.deepEqual((await fixture('state')).persona.aliases, ['胖胖', '小胖同学']);
    await screenshot('persona-desktop-dark'); await screenshot('persona-desktop-light', 'light');
    check('failed save retains draft and persisted persona; retry saves all persona fields');

    await clickText('返回模型设置');
    await input('#wa-model', JSON.stringify(['fixture', 'beta']));
    await stateMatches(s => s.modelChoice?.model === 'beta');
    await input('#wa-max-tokens', '2048'); await input('#wa-temperature', '0.7');
    await clickText('保存生成参数');
    await stateMatches(s => s.modelConfig.maxTokens === 2048 && s.modelConfig.temperature === 0.7);
    await input('#wa-prompt', '适当追问，避免太长。');
    await clickText('保存补充要求');
    await stateMatches(s => s.settings.prompt === '适当追问，避免太长。');
    check('model choice, generation parameters and account-specific instructions persist');

    await click('[data-testid="nav-authorization"]');
    await waitFor(() => document.querySelector('[data-peer-id="group_alpha@chatroom"]'));
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

    window.setContentSize(430, 900);
    await click('[data-testid="nav-overview"]'); await assertLayout('narrow overview'); await screenshot('overview-narrow-dark');
    await click('[data-testid="nav-authorization"]'); await assertLayout('narrow authorization'); await screenshot('authorization-narrow-light', 'light');
    await click('[data-testid="nav-settings"]'); await click('[data-testid="open-persona"]'); await assertLayout('narrow persona'); await screenshot('persona-narrow-dark');
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
