const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const origin = process.env.WECHAT_UI_TEST_ORIGIN, out = path.resolve(process.argv[3]);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
fs.mkdirSync(path.join(out, 'browser-profile'), { recursive: true });
app.setPath('userData', path.join(out, 'browser-profile')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = { ok: false, runId: process.env.WECHAT_UI_TEST_RUN_ID, assertions: [], screenshots: [], errors: [] };
let window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => window.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
async function wait(fn, ...args) { const until = Date.now() + 16000; while (!await evaluate(fn, ...args)) { assert(Date.now() < until, fn.toString()); await pause(80); } }
async function click(selector) {
  await wait(selector => { const node = document.querySelector(selector); return !!node && !node.disabled; }, selector);
  await evaluate(selector => { const node = document.querySelector(selector); node.scrollIntoView({ block: 'center' }); node.click(); }, selector); await pause(80);
}
async function input(selector, value) {
  await evaluate((selector, value) => { const node = document.querySelector(selector);
    const proto = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }, selector, value); await pause(80);
}
const fixture = (command, payload) => evaluate((command, payload) => window.__uiFixture(command, payload), command, payload ?? {});
const value = selector => evaluate(selector => document.querySelector(selector)?.value, selector);
const openTime = async () => {
  await click('[data-testid="nav-settings"]'); await click('[data-testid="open-time"]');
  await wait(() => !!document.querySelector('[data-testid="time-group-runtime"]'));
};
const expand = id => evaluate(id => { document.querySelector('[data-testid="time-group-' + id + '"]').closest('details').open = true; }, id);
const submit = id => click('[data-testid="time-group-' + id + '"] button[type="submit"]');
const screen = async (name, theme = 'light') => {
  await evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); document.querySelector('.wa-workspace')?.scrollTo({ top: 0, left: 0 }); }, theme);
  await pause(500);
  const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG()); report.screenshots.push(file);
};
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1280, height: 960, useContentSize: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  window.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  const watchdog = setTimeout(() => { report.failure = 'UI watchdog expired'; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report)); app.exit(1); }, 120000);
  try {
    await window.loadURL(origin); await openTime();
    assert.equal(await evaluate(() => document.querySelector('[data-testid="nav-settings"]').getAttribute('aria-current')), 'page');
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="time-group-runtime"]').closest('.wa-time-group').querySelector('.wa-countdown')), false);
    assert.equal(await evaluate(() => document.querySelector('[data-testid="time-group-replies"]').closest('.wa-time-group').querySelector('.wa-countdown')?.dataset.state), 'disabled');
    assert.equal(await evaluate(() => document.querySelector('[data-testid="time-group-likes"]').closest('.wa-time-group').querySelector('.wa-countdown')?.dataset.state), 'disabled');
    report.assertions.push('scheduled time groups show saved enablement while timeout settings have no countdown');
    await screen('time-settings-desktop-light');
    report.assertions.push('the unified time page opens from Settings and keeps Settings selected');
    await expand('role'); await input('#wa-time-role-intervalMinutes', '120');
    await fixture('failNext', { endpoint: 'time.configure' }); await submit('role');
    await wait(() => document.querySelector('[data-testid="time-group-role"] [role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await value('#wa-time-role-intervalMinutes'), '120');
    assert.equal((await fixture('roleCardSettings')).settings.intervalMinutes, 60);
    await submit('role'); await wait(() => document.querySelector('[data-testid="time-group-role"] [role="status"]')?.textContent.includes('已保存'));
    assert.equal((await fixture('roleCardSettings')).settings.intervalMinutes, 120);
    report.assertions.push('failed saves keep drafts; successful saves persist role-card intervals');
    await input('#wa-time-runtime-conversationTimeoutSeconds', '0');
    assert.equal(await evaluate(() => document.querySelector('[data-testid="time-group-runtime"] button[type="submit"]').disabled), true);
    await input('#wa-time-runtime-conversationTimeoutSeconds', '240'); await submit('runtime');
    await wait(() => document.querySelector('[data-testid="time-group-runtime"] [role="status"]')?.textContent.includes('已保存'));
    const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await reloaded;
    await wait(() => !!document.querySelector('[data-testid="nav-settings"]')); await openTime();
    assert.equal(await value('#wa-time-runtime-conversationTimeoutSeconds'), '240');
    await expand('role'); assert.equal(await value('#wa-time-role-intervalMinutes'), '120');
    report.assertions.push('invalid time values block saves and configured values survive reload');
    await input('#wa-time-search', '生图接口');
    assert(await evaluate(() => [...document.querySelectorAll('.wa-time-group summary')].every(node => node.textContent.includes('生图接口'))));
    await input('#wa-time-search', '');
    const roomKey = await evaluate(() => [...document.querySelector('#wa-time-conversation').options].find(node => node.textContent.includes('群聊'))?.value);
    assert(roomKey); await input('#wa-time-conversation', roomKey);
    await wait(() => !!document.querySelector('[data-testid="time-group-natural"]'));
    await expand('natural'); await input('#wa-time-natural-intervalMode', 'fixed');
    await input('#wa-time-natural-fixedMinutes', '17'); await submit('natural');
    await wait(() => document.querySelector('[data-testid="time-group-natural"] [role="status"]')?.textContent.includes('已保存'));
    await expand('images:generated'); await input('#wa-time-images-generated-retentionDays', ''); await submit('images:generated');
    await wait(() => document.querySelector('[data-testid="time-group-images:generated"] [role="status"]')?.textContent.includes('已保存'));
    report.assertions.push('search filters time groups and selected conversation settings save independently');
    for (const [width, theme] of [[430, 'light'], [430, 'dark'], [320, 'light']]) {
      window.setContentSize(width, 900);
      await screen('time-settings-' + width + '-' + theme, theme);
      assert.equal(await evaluate(() => [...document.querySelectorAll('body,.wa-panel,.wa-workspace,.wa-content')].every(node => node.scrollWidth <= node.clientWidth + 2)), true);
    }
    report.assertions.push('the unified settings page fits 430px and 320px in light and dark themes');
    await fixture('switchAccount'); await wait(() => !document.querySelector('[data-testid="time-group-natural"]'));
    assert.equal(await value('#wa-time-runtime-conversationTimeoutSeconds'), '240');
    assert.equal(await value('#wa-time-conversation'), '');
    report.assertions.push('account changes clear the previous conversation while preserving global time values');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.failure = error.stack || String(error); try { await screen('time-settings-failure'); } catch {} }
  finally {
    clearTimeout(watchdog); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, assertions: report.assertions.length, screenshots: report.screenshots.length, errors: report.errors, failure: report.failure })); app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
