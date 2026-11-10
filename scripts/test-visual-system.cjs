const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

const origin = process.env.WECHAT_UI_TEST_ORIGIN;
const focusedPages = (process.env.WECHAT_UI_VISUAL_PAGES || '').split(',').filter(Boolean);
const out = path.resolve(process.argv[3] || '');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '') || !process.argv[3])
  throw new Error('Visual audit requires the isolated localhost fixture');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'browser-profile'));
app.disableHardwareAcceleration();
const report = { ok: false, runId: process.env.WECHAT_UI_TEST_RUN_ID, at: new Date().toISOString(),
  assertions: [], errors: [], screenshots: [], layouts: [], accessibility: [], requests: [] };
let window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function waitFor(fn, args = [], timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(fn, ...args)) return;
    await pause(60);
  }
  throw new Error('Wait timed out: ' + fn.toString().slice(0, 150));
}
async function click(selector) {
  await waitFor(selector => Array.from(document.querySelectorAll(selector)).some(el => el.getClientRects().length && !el.disabled), [selector]);
  await evaluate(selector => {
    const el = Array.from(document.querySelectorAll(selector)).find(el => el.getClientRects().length && !el.disabled);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); el.click();
  }, selector);
  await pause(160);
}
const fixture = (command, payload = {}) => evaluate((command, payload) => window.__uiFixture(command, payload), command, payload);
async function clickText(text) {
  await waitFor(text => [...document.querySelectorAll('.wa-workspace button')].some(el => el.getClientRects().length && !el.disabled && el.textContent.trim() === text), [text]);
  await evaluate(text => [...document.querySelectorAll('.wa-workspace button')].find(el => el.getClientRects().length && !el.disabled && el.textContent.trim() === text).click(), text);
  await pause(160);
}
async function audit(label, width, theme) {
  window.setContentSize(width, 940);
  await evaluate(theme => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.querySelector('.wa-workspace')?.scrollTo({ top: 0, left: 0 });
  }, theme);
  await pause(130);
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const metrics = await evaluate(() => {
    const roots = ['.wa-panel', '.wa-shell', '.wa-workspace'].map(selector => {
      const el = document.querySelector(selector); return { selector, client: el?.clientWidth, scroll: el?.scrollWidth };
    });
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const nameless = [...document.querySelectorAll('button')].filter(visible).filter(el =>
      !el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title)
      .map(el => el.outerHTML.slice(0, 250));
    const tabs = [...document.querySelectorAll('[role=tab][aria-controls]')].filter(visible)
      .map(el => ({ id: el.id, target: !!document.getElementById(el.getAttribute('aria-controls')) }));
    return { page: document.querySelector('.wa-panel')?.dataset.page, viewport: innerWidth,
      document: document.documentElement.scrollWidth, roots, duplicateIds: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
      nameless, tabs, foreground: getComputedStyle(document.querySelector('.wa-panel')).color,
      background: getComputedStyle(document.querySelector('.wa-panel')).backgroundColor };
  });
  const name = `${label}-${width}-${theme}`;
  report.layouts.push({ name, ...metrics });
  if (metrics.document > metrics.viewport + 1 || metrics.roots.some(el => el.scroll > el.client + 1))
    report.errors.push(`Horizontal overflow at ${name}: ${JSON.stringify(metrics.roots)}`);
  if (metrics.duplicateIds.length) report.errors.push('Duplicate element IDs at ' + name + ': ' + metrics.duplicateIds.join(', '));
  if (metrics.nameless.length) report.errors.push('Unnamed visible buttons at ' + name + ': ' + metrics.nameless.join('; '));
  if (metrics.tabs.some(tab => !tab.target)) report.errors.push('Tab controls missing a panel at ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), (await window.webContents.capturePage()).toPNG());
  report.screenshots.push(name + '.png');
  // Scroll through long forms and details so visual review covers their
  // content and footer actions, rather than only the first viewport.
  const extent = await evaluate(() => {
    const el = document.querySelector('.wa-workspace');
    return { height: el.clientHeight, scroll: el.scrollHeight };
  });
  if (extent.scroll > extent.height + 8) {
    let frame = 1;
    for (let top = extent.height * .8; top < extent.scroll; top += extent.height * .8) {
      await evaluate(top => document.querySelector('.wa-workspace').scrollTo({ top, behavior: 'instant' }), top);
      await pause(65);
      const filename = `${name}-scroll-${frame++}.png`;
      fs.writeFileSync(path.join(out, filename), (await window.webContents.capturePage()).toPNG());
      report.screenshots.push(filename);
      if (top + extent.height >= extent.scroll) break;
    }
    await evaluate(() => document.querySelector('.wa-workspace').scrollTo({ top: 0, behavior: 'instant' }));
  }
}
async function capturePage(label) {
  for (const width of [1280, 430]) for (const theme of ['light', 'dark']) await audit(label, width, theme);
  report.assertions.push(label + ': light/dark at desktop/narrow; layout and accessible button names verified');
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1280, height: 940, useContentSize: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  window.setMenu(null);
  window.webContents.on('console-message', event => {
    if ((event.level === 'error' || event.level === 3) && !String(event.message).includes('favicon.ico')) report.errors.push(event.message);
  });
  window.webContents.on('render-process-gone', (_event, details) => report.errors.push('Renderer exited: ' + details.reason));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith(origin + '/') && !details.url.startsWith('data:')) {
      report.errors.push('Unexpected external browser request: ' + details.url); callback({ cancel: true }); return;
    }
    report.requests.push(details.url); callback({});
  });
  const watchdog = setTimeout(() => { report.failure = 'Visual audit exceeded 180 seconds';
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); app.exit(1); }, 180000);
  try {
    await window.loadURL(origin);
    await waitFor(() => typeof window.__uiFixture === 'function' && !!document.querySelector('.wa-account-name'));
    assert.equal((await fixture('state')).account.id, 'wxid_ui_fixture');
    await fixture('seedWork'); await fixture('taskHistory');
    await fixture('seedLongMemorySources'); await fixture('seedImageMemory');
    const navigation = await evaluate(() => [...document.querySelectorAll('.wa-nav-button[data-testid]')].map(el => el.dataset.testid));
    assert(navigation.includes('nav-settings') && navigation.includes('nav-authorization'), 'Essential navigation is present');
    for (const id of navigation.filter(id => !focusedPages.length || focusedPages.includes(id.slice(4)))) {
      await click(`[data-testid="${id}"]`);
      await capturePage(id.slice(4));
      if (id === 'nav-records') {
        await click('[data-testid="records-tab-recovery"]'); await capturePage('recovery');
        await click('[data-testid="records-tab-history"]');
      }
      if (id === 'nav-tasks') {
        await clickText('新增任务'); await capturePage('task-create'); await clickText('收起新增');
      }
      if (id === 'nav-work') {
        await evaluate(() => {
          const select = document.getElementById('wa-work-job');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'aaaaaaaaaaaa');
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await waitFor(() => !!document.querySelector('[data-testid="work-artifacts"]'));
        await capturePage('work-results');
        await click('.wa-work-metadata > summary');
        await click('.wa-work-log > summary');
        await click('.wa-work-files > summary');
        await capturePage('work-execution-details');
      }
      if (id === 'nav-moments') {
        await clickText('拉取我的动态');
        await waitFor(() => !!document.querySelector('.wa-wb-list-item'));
        await click('.wa-wb-list-item'); await capturePage('moments-post-detail');
        await clickText('拉取评论区'); await capturePage('moments-comments');
        const momentTabs = await evaluate(() => [...document.querySelectorAll('[data-testid^="moments-tab-"]')]
          .map(el => el.dataset.testid.slice('moments-tab-'.length)).filter(tab => !['posts', 'comments'].includes(tab)));
        for (const tab of momentTabs) {
          await click(`[data-testid="moments-tab-${tab}"]`); await capturePage('moments-' + tab);
          if (tab === 'publishing') {
            await clickText('新增发布计划'); await capturePage('moments-publishing-editor'); await clickText('关闭编辑');
          }
        }
      }
      if (id === 'nav-memory') {
        const tabs = await evaluate(() => [...document.querySelectorAll('[role=tablist] [role=tab][data-testid]')].map(el => el.dataset.testid));
        for (const tab of tabs) { await click(`[data-testid="${tab}"]`); await capturePage(tab); }
        if (tabs.length > 1) {
          await evaluate(() => {
            const first = document.querySelector('[role=tablist] [role=tab]'); first.focus();
            first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
          });
          await pause(80);
          assert(await evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'), 'Keyboard tab navigation selects its focused tab');
          report.assertions.push('Memory tabs support keyboard navigation');
        }
      }
      if (id === 'nav-settings') {
        const details = await evaluate(() => [...document.querySelectorAll('[data-testid^="open-"]')].map(el => el.dataset.testid));
        for (const detail of details) {
          await click('[data-testid="nav-settings"]'); await click(`[data-testid="${detail}"]`);
          await capturePage(detail.slice(5));
          if (detail === 'open-persona') {
            await click('.wa-persona-manuscript details > summary'); await capturePage('persona-names');
          }
          if (detail === 'open-image-generation') {
            await click('[data-testid="image-provider-add"]');
            await click('[data-testid="image-generation-settings"] details > summary');
            await capturePage('image-generation-provider-editor');
          }
        }
      }
    }
    if (!focusedPages.length || focusedPages.includes('authorization')) {
    await click('[data-testid="nav-authorization"]');
    await waitFor(() => !!document.querySelector('.wa-session-row[data-peer-id="group_alpha@chatroom"]'));
    await evaluate(() => [...document.querySelector('.wa-session-row[data-peer-id="group_alpha@chatroom"]').querySelectorAll('button')]
      .find(button => button.textContent.trim() === '设置')?.click());
    await waitFor(() => document.querySelector('.wa-panel').dataset.page === 'conversation');
    await capturePage('conversation-settings');
    }
    await click('[data-testid="nav-overview"]');
    await window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(100);
    assert(await evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'Reduced motion emulation is active');
    assert(await evaluate(() => document.querySelector('.wa-panel').dataset.motion === 'off'), 'The panel follows reduced motion');
    await audit('reduced-motion', 760, 'light');
    await window.webContents.debugger.detach();
    report.assertions.push('Reduced motion layout verified at compact width');
    assert.equal((await fixture('momentWrites')).length, 0, 'Visual audit must not publish, comment or send moments');
    report.assertions.push('All browser requests stayed inside the isolated synthetic fixture; no moments were sent');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    try { fs.writeFileSync(path.join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
  } finally {
    clearTimeout(watchdog);
    report.requests = { count: report.requests.length, external: report.errors.filter(message => message.startsWith('Unexpected external browser request:')).length };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, assertions: report.assertions.length, screenshots: report.screenshots.length,
      errors: report.errors, failure: report.failure, report: path.join(out, 'report.json') }));
    app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error.stack); app.exit(1); });
