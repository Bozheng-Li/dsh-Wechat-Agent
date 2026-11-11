const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const origin = process.env.WECHAT_UI_TEST_ORIGIN, out = path.resolve(process.argv[3] || '');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '') || !process.argv[3]) throw Error('Only the isolated localhost fixture may be used');
fs.mkdirSync(path.join(out, 'browser-profile'), { recursive: true }); app.setPath('userData', path.join(out, 'browser-profile'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('force-device-scale-factor', '1');
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
  if (selector.includes('nav-')) await evaluate(selector => { const el = document.querySelector(selector), toggle = document.querySelector('[data-testid="mobile-navigation"]'); if (!visible(el) && visible(toggle)) toggle.click(); }, selector);
  await waitFor(selector => [...document.querySelectorAll(selector)].some(visible), [selector]);
  await evaluate(selector => { const el = [...document.querySelectorAll(selector)].find(visible); el.scrollIntoView({ block: 'center' }); el.click(); }, selector);
}
async function clickText(text) {
  await waitFor(text => [...document.querySelectorAll('button')].some(el => visible(el) && el.textContent.trim() === text), [text]);
  await evaluate(text => { const el = [...document.querySelectorAll('button')].find(el => visible(el) && el.textContent.trim() === text); el.scrollIntoView({ block: 'center' }); el.click(); }, text);
}
async function input(label, value) {
  const selector = '[aria-label=' + JSON.stringify(label) + ']'; await waitFor(selector => visible(document.querySelector(selector)), [selector]);
  await evaluate((selector, value) => {
    const el = document.querySelector(selector), prototype = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}
const fixture = (command, payload = {}) => evaluate((command, payload) => window.__uiFixture(command, payload), command, payload);
const current = async () => (await fixture('momentReplies')).list;
const check = text => report.assertions.push(text);
async function refresh() { await clickText('刷新状态'); await waitFor(() => !document.querySelector('[data-testid="moments-reply-schedule"] fieldset')?.disabled); }
async function finishRound() { await waitFor(async () => !(await window.__uiFixture('momentReplies')).list.running); await refresh(); }
async function screenshot(name, theme = 'light', focus) {
  await evaluate((theme, focus) => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark');
    document.querySelector('.wa-workspace')?.scrollTo(0, 0); if (focus) document.querySelector(focus)?.scrollIntoView({ block: 'start' }); }, theme, focus);
  await pause(140);
  const dimensions = await evaluate(() => [document.documentElement, ...document.querySelectorAll('.wa-panel,.wa-shell,.wa-workspace,.wa-moments-schedule')].map(el => [el.clientWidth, el.scrollWidth]));
  assert(dimensions.every(([client, scroll]) => scroll <= client + 1), name + ': horizontal overflow ' + JSON.stringify(dimensions));
  fs.writeFileSync(path.join(out, name + '.png'), (await window.webContents.capturePage()).toPNG()); report.screenshots.push(name + '.png');
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1440, height: 1080, useContentSize: true, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  window.setMenu(null); window.webContents.on('console-message', event => { if (['error', 3].includes(event.level) && !String(event.message).includes('favicon.ico')) report.errors.push(String(event.message)); });
  const watchdog = setTimeout(() => { report.failure = 'Timed out after 150 seconds'; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); app.exit(1); }, 150000);
  try {
    await window.loadURL(origin); await waitFor(() => typeof window.__uiFixture === 'function' && document.querySelector('.wa-account-name')?.textContent.includes('界面测试'));
    assert.equal((await fixture('state')).account.id, 'wxid_ui_fixture');
    await click('[data-testid="nav-moments"]'); await click('[data-testid="moments-tab-schedule"]');
    await waitFor(() => visible(document.querySelector('[aria-label="自动接续好友朋友圈对话"]')));
    assert(await evaluate(() => !document.querySelector('[aria-label="回复自己朋友圈里的评论"]').checked && !document.querySelector('[aria-label="自动接续好友朋友圈对话"]').checked));
    assert.equal((await fixture('momentWrites')).length, 0);
    check('both switches default off in the existing scheduled-reply menu');
    await click('[data-testid="moments-tab-interactions"]'); await waitFor(() => visible(document.querySelector('[data-testid="moments-interactions"]')));
    assert.equal(await evaluate(() => !!document.querySelector('[aria-label="自动接续好友朋友圈对话"]')), false);
    await click('[data-testid="moments-tab-schedule"]');
    check('friend conversation continuation is not misplaced in the like/comment automation editor');
    await input('好友对话每轮最多尝试回复', 0);
    assert(await evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent === '保存定时设置').disabled));
    await input('好友对话每轮最多尝试回复', 2); await input('自己朋友圈每轮最多尝试回复', 3);
    await input('抓取间隔（分钟）', 17); await input('处理近几天动态', 9); await input('定时回复范围', 'selected');
    await click('[aria-label="自动接续好友朋友圈对话"]');
    await evaluate(() => [...document.querySelectorAll('label')].find(el => el.textContent.trim() === '也回复开启前已存在、尚未回复的评论').click());
    await clickText('保存定时设置'); await waitFor(async () => (await window.__uiFixture('momentReplies')).list.settings.friendRepliesEnabled);
    let saved = await current(); assert.equal(saved.settings.enabled, false); assert.equal(saved.settings.intervalMinutes, 17);
    assert.equal(saved.settings.maxFriendRepliesPerRun, 2); assert.equal(saved.settings.maxRepliesPerRun, 3); assert.equal(saved.settings.scope, 'selected');
    assert(saved.nextRunAt > Date.now() + 16 * 60000); assert.equal((await fixture('momentWrites')).length, 0);
    check('validated settings save through owner RPC; own selection does not block friend-only mode and saving does not send');
    await click('[data-testid="nav-overview"]'); await click('[data-testid="nav-moments"]'); await click('[data-testid="moments-tab-schedule"]');
    await waitFor(() => document.querySelector('[aria-label="抓取间隔（分钟）"]')?.value === '17');
    assert(await evaluate(() => document.querySelector('[aria-label="自动接续好友朋友圈对话"]').checked && document.querySelector('.wa-moments-schedule>.wa-wb-between').textContent.includes('已开启')));
    await screenshot('reply-schedule-desktop-light'); await screenshot('reply-schedule-desktop-dark', 'dark');
    window.setContentSize(430, 920); await screenshot('reply-schedule-narrow-light', 'light');
    await screenshot('reply-schedule-narrow-friend', 'light', '[aria-label="好友朋友圈接续回复设置"]');
    window.setContentSize(320, 900); await screenshot('reply-schedule-320-dark', 'dark', '[aria-label="好友朋友圈接续回复设置"]');
    window.setContentSize(1440, 1080);
    check('settings persist through navigation and fit desktop, 430px and 320px screens in light and dark themes');
    await fixture('momentReplies', { mode: 'due' }); await finishRound(); saved = await current();
    assert.equal(saved.lastRun.friend.replied, 1); assert.equal(saved.lastRun.replied, 0); assert.equal((await fixture('momentWrites')).length, 1);
    await waitFor(() => document.querySelector('.wa-moments-replies').textContent.includes('对方回复我'));
    assert(await evaluate(() => ['我之前说', '这杯拿铁看起来不错', '你也喜欢少糖吗', '我的回复', '微信已确认'].every(text => document.querySelector('.wa-moments-replies').textContent.includes(text))));
    await screenshot('reply-schedule-thread-light', 'light', '.wa-moments-replies');
    check('friend-only timer replies to the actual incoming comment and history labels every participant clearly');
    await fixture('momentReplies', { mode: 'add' }); await fixture('momentReplies', { mode: 'due' }); await finishRound();
    assert.equal((await fixture('momentWrites')).length, 2); assert.equal((await current()).lastRun.friend.replied, 1);
    check('a subsequent response to our new comment is picked up in the next round');
    await click('[aria-label="自动接续好友朋友圈对话"]'); await input('定时回复范围', 'own'); await click('[aria-label="回复自己朋友圈里的评论"]');
    await clickText('保存定时设置'); await waitFor(async () => !(await window.__uiFixture('momentReplies')).list.settings.friendRepliesEnabled);
    await fixture('momentReplies', { mode: 'add' }); await fixture('momentReplies', { mode: 'due' }); await finishRound();
    assert.equal((await fixture('momentWrites')).length, 3); assert.equal((await current()).lastRun.replied, 1); assert.equal((await current()).lastRun.friend, undefined);
    check('turning friend replies off leaves own-post replies running on the shared timer');
    await click('[aria-label="回复自己朋友圈里的评论"]'); await click('[aria-label="自动接续好友朋友圈对话"]'); await clickText('保存定时设置');
    await waitFor(async () => (await window.__uiFixture('momentReplies')).list.settings.friendRepliesEnabled);
    await fixture('momentReplies', { mode: 'hold' }); await fixture('momentReplies', { mode: 'due' });
    await waitFor(async () => (await window.__uiFixture('momentReplies')).generating); await refresh();
    await click('[aria-label="自动接续好友朋友圈对话"]'); await clickText('保存定时设置'); await fixture('momentReplies', { mode: 'release' }); await finishRound();
    assert.equal((await fixture('momentWrites')).length, 3); assert.equal((await current()).nextRunAt, 0);
    check('the friend switch cancels an in-flight generated response and removes the next check when both switches are off');
    await click('[aria-label="自动接续好友朋友圈对话"]'); await clickText('保存定时设置');
    await waitFor(async () => (await window.__uiFixture('momentReplies')).list.settings.friendRepliesEnabled);
    await fixture('momentReplies', { mode: 'read-failure', enabled: true }); await fixture('momentReplies', { mode: 'due' }); await finishRound();
    assert((await current()).lastRun.friend.readFailed > 0);
    await waitFor(() => document.querySelector('[aria-label="定时回复运行状态"]').textContent.includes('合成评论区读取失败'));
    await screenshot('reply-schedule-read-failure-light', 'light', '[aria-label="定时回复运行状态"]');
    check('partial comment-read failures are visible beside the last-run counts');
    await click('[aria-label="自动接续好友朋友圈对话"]'); await clickText('保存定时设置');
    await waitFor(async () => !(await window.__uiFixture('momentReplies')).list.settings.friendRepliesEnabled);
    await fixture('switchAccount'); await waitFor(() => document.querySelector('[data-testid="moments-tab-posts"]')?.getAttribute('aria-selected') === 'true');
    await click('[data-testid="moments-tab-schedule"]'); await waitFor(() => visible(document.querySelector('[aria-label="自动接续好友朋友圈对话"]')));
    assert.equal((await current()).settings.friendRepliesEnabled, false); assert.equal((await current()).replies.length, 0);
    check('account changes show independent disabled defaults and no previous-account reply history');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.failure = error.stack || String(error); try { fs.writeFileSync(path.join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {} }
  finally { clearTimeout(watchdog); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, assertions: report.assertions.length, screenshots: report.screenshots.length, errors: report.errors, failure: report.failure, report: path.join(out, 'report.json') })); app.exit(report.ok ? 0 : 1); }
}).catch(error => { console.error(error.stack); app.exit(1); });
