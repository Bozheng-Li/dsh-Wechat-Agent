const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const origin = process.env.WECHAT_UI_TEST_ORIGIN, out = path.resolve(process.argv[3] || '');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '') || !process.argv[3]) throw Error('Only the isolated localhost fixture may be used');
fs.mkdirSync(path.join(out, 'browser-profile'), { recursive: true }); app.setPath('userData', path.join(out, 'browser-profile')); app.disableHardwareAcceleration();
const report = { ok: false, runId: process.env.WECHAT_UI_TEST_RUN_ID, assertions: [], screenshots: [], errors: [] };
let window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function visible(el) { return !!el?.getClientRects().length && !el.closest('[hidden]') && !el.matches(':disabled'); }
const evaluate = (fn, ...args) => window.webContents.executeJavaScript('(() => { const visible = ' + visible.toString() + '; return (' + fn.toString() + ')(...' + JSON.stringify(args) + '); })()');
async function waitFor(fn, args = [], timeout = 16000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await evaluate(fn, ...args)) return; await pause(70); }
  throw Error('UI wait timed out: ' + fn.toString().slice(0, 220));
}
async function click(selector) {
  if (selector.includes('nav-')) await evaluate(selector => { const target = document.querySelector(selector), toggle = document.querySelector('[data-testid="mobile-navigation"]'); if (!visible(target) && visible(toggle)) toggle.click(); }, selector);
  await waitFor(selector => [...document.querySelectorAll(selector)].some(visible), [selector]);
  await evaluate(selector => { const el = [...document.querySelectorAll(selector)].find(visible); el.scrollIntoView({ block: 'center' }); el.click(); }, selector);
}
async function clickText(text) {
  await waitFor(text => [...document.querySelectorAll('button')].some(el => visible(el) && el.textContent.trim() === text), [text]);
  await evaluate(text => { const el = [...document.querySelectorAll('button')].find(el => visible(el) && el.textContent.trim() === text); el.scrollIntoView({ block: 'center' }); el.click(); }, text);
}
async function input(label, value) {
  const selector = '[aria-label=' + JSON.stringify(label) + ']'; await waitFor(selector => visible(document.querySelector(selector)), [selector]);
  await evaluate((selector, value) => { const el = document.querySelector(selector), proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, selector, value);
}
const fixture = (command, payload = {}) => evaluate((command, payload) => window.__uiFixture(command, payload), command, payload);
const latest = async () => (await fixture('momentInteractions')).list.runs[0];
const check = text => report.assertions.push(text);
async function preview() {
  const before = (await latest())?.id;
  await evaluate(() => { const button = [...document.querySelectorAll('button')].find(el => visible(el) && /^(重新)?读取并预览$/.test(el.textContent.trim())); assertButton(button); function assertButton(button) { if (!button) throw Error('Preview is not usable'); button.click(); } });
  await waitFor(async before => { const run = (await window.__uiFixture('momentInteractions')).list.runs[0]; return run && run.id !== before && visible(document.querySelector('[data-interaction-post]')); }, [before]);
  return latest();
}
async function waitState(id, state) { await waitFor(async (id, state) => (await window.__uiFixture('momentInteractions', { id })).list.current.state === state, [id, state]); }
async function layout(label) {
  const dimensions = await evaluate(() => [document.documentElement, ...document.querySelectorAll('.wa-panel,.wa-shell,.wa-workspace,.wa-interactions')].map(el => ({ client: el.clientWidth, scroll: el.scrollWidth })));
  assert(dimensions.every(row => row.scroll <= row.client + 1), label + ': ' + JSON.stringify(dimensions));
}
async function screenshot(name, theme = 'light', focus) {
  await evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); }, theme);
  await evaluate(focus => { document.querySelector('.wa-workspace')?.scrollTo(0, 0); if (focus) document.querySelector(focus)?.scrollIntoView({ block: 'start' }); }, focus);
  await pause(140); fs.writeFileSync(path.join(out, name + '.png'), (await window.webContents.capturePage()).toPNG()); report.screenshots.push(name + '.png');
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1440, height: 1060, useContentSize: true, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  window.setMenu(null); window.webContents.on('console-message', event => { if (['error', 3].includes(event.level) && !String(event.message).includes('favicon.ico')) report.errors.push(String(event.message)); });
  window.webContents.on('render-process-gone', (_event, details) => report.errors.push(details.reason));
  const watchdog = setTimeout(() => { report.failure = 'Timed out after 150 seconds'; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); app.exit(1); }, 150000);
  try {
    await window.loadURL(origin); await waitFor(() => typeof window.__uiFixture === 'function' && document.querySelector('.wa-account-name')?.textContent.includes('界面测试'));
    assert.equal((await fixture('state')).account.id, 'wxid_ui_fixture');
    await click('[data-testid="nav-moments"]'); await click('[data-testid="moments-tab-interactions"]');
    await waitFor(() => visible(document.querySelector('[aria-label="本轮互动条数"]')));
    await waitFor(() => visible(document.querySelector('[aria-label="自动检查间隔分钟"]')));
    assert(await evaluate(() => !document.querySelector('[aria-label="启用自动朋友圈互动"]').checked &&
      document.querySelector('[aria-label="自动跳过已点赞"]').checked && document.querySelector('[aria-label="自动跳过已评论"]').checked));
    assert.equal((await fixture('momentWrites')).length, 0); assert.equal((await fixture('momentInteractions')).generations, 0);
    await input('本轮互动条数', 21); assert(await evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent === '读取并预览').disabled));
    await input('本轮互动条数', 3); await input('互动间隔秒数', 0); let round = await preview();
    assert.equal(round.counts.selected, 3); assert.equal(await evaluate(() => document.querySelectorAll('[data-interaction-post]').length), 3);
    assert.equal((await fixture('momentInteractions')).imageReads.length, 0);
    check('new menu enforces limits and previews actual authors and text without image reads or writes');
    await clickText('生成逐条评论'); await waitFor(() => document.querySelector('[aria-label="互动评论 72001"]')?.value.includes('燕麦'));
    assert.deepEqual((await fixture('momentInteractions')).imageReads, ['72002', '72003']);
    assert(await evaluate(() => document.querySelector('.wa-interaction-preview').textContent.includes('已读取 2 张配图') && document.querySelector('.wa-interaction-preview').textContent.includes('图片读取失败')));
    check('comment generation shows per-photo evidence and an explicit image failure skip');
    await input('互动评论 72001', '少糖的燕麦拿铁，我也喜欢。'); assert.equal((await fixture('momentWrites')).length, 0);
    await layout('desktop editor'); await screenshot('moments-interactions-desktop-light', 'light', '.wa-interaction-manual-heading'); await screenshot('moments-interactions-desktop-dark', 'dark', '.wa-interaction-manual-heading');
    check('per-post generation is read-only and comments remain individually editable');
    await fixture('interactionMode', { mode: 'hold' }); await clickText('执行 3 条 · 点赞并评论');
    await waitFor(async () => (await window.__uiFixture('interactionMode')).started);
    await click('[data-testid="nav-overview"]'); await fixture('interactionMode', { mode: 'release' }); await waitState(round.id, 'completed');
    await click('[data-testid="nav-moments"]'); await click('[data-testid="moments-tab-interactions"]');
    await waitFor(() => document.querySelector('.wa-interaction-counts')?.textContent.includes('新增评论 2'));
    let current = (await fixture('momentInteractions', { id: round.id })).list.current;
    assert.equal(current.counts.liked, 3); assert.equal(current.counts.commented, 2); assert.equal(current.counts.skippedComments, 1);
    assert((await fixture('momentWrites')).some(row => row.text === '少糖的燕麦拿铁，我也喜欢。'));
    const writeCount = (await fixture('momentWrites')).length; await clickText('刷新本轮状态'); assert.equal((await fixture('momentWrites')).length, writeCount);
    assert(await evaluate(() => document.querySelector('[data-interaction-post="72001"]').textContent.includes('7 个赞')));
    check('accepted execution survives navigation, keeps edited comments and reports real receipts without incrementing visible totals');
    await clickText('只点赞'); await clickText('随机挑选'); await input('本轮互动条数', 2); await input('互动候选数量', 4); round = await preview();
    current = (await fixture('momentInteractions', { id: round.id })).list.current;
    assert.equal(current.rows.length, 2); assert.equal(new Set(current.rows.map(row => row.userId)).size, 2);
    const randomIds = current.rows.map(row => row.postId); await pause(2700);
    assert.deepEqual((await fixture('momentInteractions', { id: round.id })).list.current.rows.map(row => row.postId), randomIds);
    window.setContentSize(430, 920); await layout('narrow setup'); await screenshot('moments-interactions-narrow-setup', 'light', '.wa-interaction-manual-heading');
    await screenshot('moments-interactions-narrow-preview', 'light', '.wa-interaction-preview');
    check('random selection is fixed and both narrow editor and preview fit without horizontal overflow');
    window.setContentSize(1280, 940); await clickText('手动勾选'); await clickText('只评论'); await input('互动评论方式', 'manual'); await input('互动候选数量', 6); round = await preview();
    assert.equal(round.counts.selected, 0); await click('[aria-label="选择互动动态 72005"]'); await input('互动评论 72005', '仅合成异常测试');
    await fixture('interactionMode', { mode: 'unknown' }); await clickText('执行 1 条 · 只评论'); await waitState(round.id, 'partial');
    await waitFor(() => document.querySelector('.wa-interaction-preview').textContent.includes('结果不明，未重发'));
    const afterUnknown = (await fixture('momentWrites')).length; await clickText('刷新本轮状态'); assert.equal((await fixture('momentWrites')).length, afterUnknown);
    check('manual selection sends only selected content and unknown acknowledgements remain visible without retries');
    await click('[data-testid="moments-tab-friends"]'); await click('[aria-label="评论动态 72004"]');
    await waitFor(() => visible(document.querySelector('[data-interaction-post="72004"]')) && document.querySelectorAll('[data-interaction-post]').length === 1);
    assert.equal(await evaluate(() => document.querySelector('[aria-label="互动动态来源"]').value), 'selected');
    await input('互动评论 72004', '读到喜欢的结尾真好。'); await clickText('执行 1 条 · 只评论'); round = await latest(); await waitState(round.id, 'completed');
    await click('[data-testid="moments-tab-friends"]'); await click('[aria-label="查看动态评论 72004"]');
    await waitFor(() => document.querySelector('.wa-moments-comments')?.textContent.includes('读到喜欢的结尾真好。'));
    check('friend rows open a single-post comment editor and its real returned comment list');
    await click('[data-testid="moments-tab-interactions"]'); await waitFor(() => !!document.querySelector('.wa-interaction-counts'));
    await input('互动动态来源', 'timeline'); await clickText('只点赞'); await clickText('手动勾选'); await input('互动候选数量', 6); await input('互动间隔秒数', 60); round = await preview();
    await click('[aria-label="选择互动动态 72004"]'); await click('[aria-label="选择互动动态 72006"]');
    const beforeCancel = (await fixture('momentWrites')).length; await clickText('执行 2 条 · 只点赞');
    await waitFor(async () => (await window.__uiFixture('momentWrites')).some(row => row.action === 'like' && row.postId === '72004'));
    await clickText('停止本轮互动'); await waitState(round.id, 'cancelled');
    assert.equal((await fixture('momentWrites')).length, beforeCancel + 1);
    check('stop control preserves the first confirmed action and cancels remaining posts');
    const beforeAuto = (await fixture('momentWrites')).length;
    await input('自动检查间隔分钟', 4); assert(await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '保存自动设置').disabled));
    await input('自动检查间隔分钟', 120); await input('自动读取最近天数', 2); await input('自动每轮点赞条数', 2); await input('自动每轮评论条数', 1);
    await input('自动互动挑选方式', 'random'); await pause(2700);
    assert.equal(await evaluate(() => document.querySelector('[aria-label="自动检查间隔分钟"]').value), '120');
    await input('自动互动挑选方式', 'latest'); await click('.wa-interaction-auto-details>summary'); await input('自动逐条间隔秒数', 0);
    await click('[aria-label="启用自动朋友圈互动"]'); await clickText('保存自动设置');
    await waitFor(async () => (await window.__uiFixture('interactionAutomation')).settings.enabled);
    let automatic = await fixture('interactionAutomation'); assert.equal(automatic.settings.intervalMinutes, 120); assert.equal(automatic.settings.lookbackDays, 2);
    assert.equal(automatic.settings.likeCount, 2); assert.equal(automatic.settings.commentCount, 1); assert(automatic.nextRunAt > Date.now() + 119 * 60000);
    assert.equal((await fixture('momentWrites')).length, beforeAuto);
    await click('[data-testid="nav-overview"]'); await click('[data-testid="nav-moments"]'); await click('[data-testid="moments-tab-interactions"]');
    await waitFor(() => document.querySelector('[aria-label="自动检查间隔分钟"]')?.value === '120');
    await layout('automatic desktop'); await screenshot('moments-interactions-automatic-light', 'light'); await screenshot('moments-interactions-automatic-dark', 'dark');
    check('automatic settings validate ranges, retain unsaved edits during polling, persist through navigation and wait for the next interval');
    await fixture('interactionAutomation', { mode: 'due' });
    await waitFor(async () => { const value = await window.__uiFixture('interactionAutomation'); return value.lastRun && !value.running; });
    automatic = await fixture('interactionAutomation'); assert.equal(automatic.lastRun.counts.liked, 2); assert.equal(automatic.lastRun.counts.commented, 1);
    assert.equal((await fixture('momentWrites')).length, beforeAuto + 3); await clickText('查看自动互动记录');
    await waitFor(() => document.querySelector('.wa-interaction-preview')?.textContent.includes('自动轮次 · 计划点赞 2 条、评论 1 条'));
    assert.equal(await evaluate(() => document.querySelectorAll('[data-interaction-post]').length), 2);
    const previousCycle = automatic.lastRun.id; await fixture('interactionAutomation', { mode: 'due' });
    await waitFor(async previousCycle => { const value = await window.__uiFixture('interactionAutomation'); return value.lastRun?.id !== previousCycle && !value.running; }, [previousCycle]);
    assert.equal((await fixture('momentWrites')).length, beforeAuto + 3);
    check('the automatic timer skips previously handled posts and unknown comments, fills separate quotas and exposes durable per-post results');
    await fixture('interactionAutomation', { mode: 'add' }); await fixture('interactionMode', { mode: 'hold-generation' }); await fixture('interactionAutomation', { mode: 'due' });
    await waitFor(async () => (await window.__uiFixture('interactionMode')).generating); await clickText('停止本轮自动互动');
    await fixture('interactionMode', { mode: 'release-generation' });
    await waitFor(async () => { const value = await window.__uiFixture('interactionAutomation'); return !value.running && value.lastRun?.state === 'cancelled'; });
    assert.equal((await fixture('momentWrites')).length, beforeAuto + 3); assert.equal((await fixture('interactionAutomation')).settings.enabled, true);
    check('stop-current cancels automatic generation without a social write and retains the future schedule');
    await input('自动检查间隔分钟', 60); await fixture('interactionAutomation', { mode: 'change', settings: { intervalMinutes: 180 } });
    await clickText('载入最新自动设置'); assert.equal(await evaluate(() => document.querySelector('[aria-label="自动检查间隔分钟"]').value), '180');
    await click('[aria-label="自动跳过已点赞"]'); await click('[aria-label="自动跳过已评论"]'); await clickText('保存自动设置');
    await waitFor(async () => !(await window.__uiFixture('interactionAutomation')).settings.skipLiked);
    assert.equal((await fixture('interactionAutomation')).settings.skipCommented, false);
    window.setContentSize(430, 920); await layout('automatic narrow'); await screenshot('moments-interactions-automatic-narrow', 'light', '.wa-interaction-auto');
    await screenshot('moments-interactions-automatic-narrow-options', 'light', '.wa-interaction-auto-fields');
    await clickText('关闭自动互动'); await waitFor(async () => !(await window.__uiFixture('interactionAutomation')).settings.enabled);
    assert.equal((await fixture('interactionAutomation')).nextRunAt, 0); assert.equal((await fixture('momentWrites')).length, beforeAuto + 3);
    check('automatic settings detect external revisions, persist both skip switches, fit narrow screens and turn off independently of stop-current');
    window.setContentSize(1280, 940);
    await fixture('holdNext', { endpoint: 'moments.interactions.preview' });
    await clickText('重新读取并预览'); await waitFor(async () => (await window.__uiFixture('heldRequest', { endpoint: 'moments.interactions.preview' })).started);
    await fixture('switchAccount'); await waitFor(() => document.querySelector('[data-testid="moments-tab-posts"]')?.getAttribute('aria-selected') === 'true');
    assert.equal((await fixture('state')).account.id, 'wxid_ui_other');
    await fixture('releaseRequest', { endpoint: 'moments.interactions.preview' });
    await click('[data-testid="moments-tab-interactions"]'); await waitFor(() => document.querySelector('[data-testid="moments-interactions"]')?.dataset.accountId === 'wxid_ui_other');
    assert.equal(await evaluate(() => document.querySelectorAll('[data-interaction-post]').length), 0); assert.equal((await fixture('momentInteractions')).list.runs.length, 0);
    assert.equal((await fixture('interactionAutomation')).settings.enabled, false);
    check('account switches discard in-flight previews, drafts and history from the previous account');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.failure = error.stack || String(error); try { fs.writeFileSync(path.join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {} }
  finally { clearTimeout(watchdog); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, assertions: report.assertions.length, screenshots: report.screenshots.length, errors: report.errors, failure: report.failure, report: path.join(out, 'report.json') })); app.exit(report.ok ? 0 : 1); }
}).catch(error => { console.error(error.stack); app.exit(1); });
