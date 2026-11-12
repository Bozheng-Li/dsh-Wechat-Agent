const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { inspectVisualState } = require('./visual-inspection.cjs');

const origin = process.env.WECHAT_UI_TEST_ORIGIN;
const focusedPages = (process.env.WECHAT_UI_VISUAL_PAGES || '').split(',').filter(Boolean);
const probe = process.env.WECHAT_UI_VISUAL_PROBE;
assert(!probe || ['assets', 'details'].includes(probe), 'Unknown visual probe');
const widths = (process.env.WECHAT_UI_VISUAL_WIDTHS || '1280,768,430,375,320').split(',').map(Number);
assert(widths.length && widths.every(width => Number.isSafeInteger(width) && width >= 320 && width <= 2560));
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
  if (selector.includes('nav-')) {
    await evaluate(selector => {
      const target = document.querySelector(selector), toggle = document.querySelector('[data-testid=mobile-navigation]');
      if (target && !target.getClientRects().length && toggle?.getClientRects().length) toggle.click();
    }, selector);
  }
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
async function setValue(selector, value) {
  await waitFor(selector => !!document.querySelector(selector), [selector]);
  await evaluate((selector, value) => {
    const el = document.querySelector(selector);
    const prototype = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }, selector, value);
  await pause(180);
}
async function audit(label, width, theme) {
  window.setContentSize(width, 940);
  await evaluate(theme => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.querySelector('.wa-workspace')?.scrollTo({ top: 0, left: 0 });
  }, theme);
  // Let theme and hover transitions finish before measuring their final colors.
  await pause(320);
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const metrics = await evaluate(inspectVisualState);
  const name = `${label}-${width}-${theme}`;
  report.layouts.push({ name, ...metrics });
  if (metrics.document > metrics.viewport + 1 || metrics.roots.some(el => el.scroll > el.client + 1))
    report.errors.push(`Horizontal overflow at ${name}: ${JSON.stringify(metrics.roots)}`);
  if (metrics.heights.document.scroll > metrics.heights.document.client + 1)
    report.errors.push(`Document vertical overflow outside the workspace at ${name}: ${JSON.stringify(metrics.heights)}`);
  if (metrics.duplicateIds.length) report.errors.push('Duplicate element IDs at ' + name + ': ' + metrics.duplicateIds.join(', '));
  if (metrics.nameless.length) report.errors.push('Unnamed visible buttons at ' + name + ': ' + metrics.nameless.join('; '));
  if (metrics.tabs.some(tab => !tab.target || !tab.labeled)) report.errors.push('Tab controls missing a labeled panel at ' + name);
  if (metrics.unlabeled.length) report.errors.push('Unlabeled form controls at ' + name + ': ' + JSON.stringify(metrics.unlabeled));
  if (metrics.overflow.length) report.errors.push('Elements outside viewport at ' + name + ': ' + JSON.stringify(metrics.overflow));
  if (metrics.contrast.length) report.errors.push('Text contrast below WCAG AA at ' + name + ': ' + JSON.stringify(metrics.contrast));
  fs.writeFileSync(path.join(out, name + '.png'), (await window.webContents.capturePage()).toPNG());
  report.screenshots.push(name + '.png');
  // Scroll through long forms and details so visual review covers their
  // content and footer actions, rather than only the first viewport.
  const extent = await evaluate(() => {
    const el = document.querySelector('.wa-workspace');
    return { height: el.clientHeight, scroll: el.scrollHeight };
  });
  if ([1280, 430].includes(width) && extent.scroll > extent.height + 8) {
    let frame = 1;
    const scrollStops = metrics.page === 'changelog'
      ? [extent.height * .8, (extent.scroll - extent.height) / 2, extent.scroll - extent.height]
      : Array.from({ length: Math.ceil(extent.scroll / (extent.height * .8)) }, (_, i) => (i + 1) * extent.height * .8);
    for (const top of scrollStops) {
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
  for (const width of widths) for (const theme of ['light', 'dark']) await audit(label, width, theme);
  report.assertions.push(label + ': light/dark at ' + widths.join('/') + 'px; layout, control names and solid-background text contrast audited');
  fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ page: label, screenshots: report.screenshots.length,
    layouts: report.layouts, errors: report.errors }, null, 2));
}
async function auditKeyboardTabs(label) {
  const lists = await evaluate(() => [...document.querySelectorAll('.wa-workspace [role=tablist]')]
    .filter(el => el.getClientRects().length).map(el => ({ label: el.getAttribute('aria-label'),
      ids: [...el.querySelectorAll('[role=tab]')].map(tab => tab.id), selected: el.querySelector('[aria-selected=true]')?.id })));
  for (const list of lists) {
    if (!list.ids.length || list.ids.some(id => !id)) { report.errors.push(`Tabs lack stable IDs at ${label}: ${list.label}`); continue; }
    for (const [key, expected] of [['End', list.ids.at(-1)], ['Home', list.ids[0]]]) {
      await evaluate((key, ids) => {
        const selected = ids.map(id => document.getElementById(id)).find(el => el?.getAttribute('aria-selected') === 'true');
        selected.focus(); selected.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }, key, list.ids);
      await pause(80);
      if (!await evaluate(id => document.activeElement?.id === id && document.activeElement?.getAttribute('aria-selected') === 'true', expected))
        report.errors.push(`Keyboard ${key} did not select and focus its tab at ${label}: ${list.label}`);
    }
    if (list.selected) await click('#' + list.selected);
    report.assertions.push(`${label}: ${list.label} keyboard Home/End audited`);
  }
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
  const watchdog = setTimeout(() => { report.failure = 'Visual audit exceeded 900 seconds';
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); app.exit(1); }, 900000);
  try {
    await window.loadURL(origin);
    await waitFor(() => typeof window.__uiFixture === 'function' && !!document.querySelector('.wa-account-name'));
    assert.equal((await fixture('state')).account.id, 'wxid_ui_fixture');
    await fixture('seedWork'); await fixture('taskHistory');
    await fixture('seedLongMemorySources'); await fixture('seedImageMemory');
    await fixture('seedRecovery');
    await fixture('seedMemoryConflict');
    const navigation = await evaluate(() => [...document.querySelectorAll('.wa-nav-button[data-testid]')].map(el => el.dataset.testid));
    assert(navigation.includes('nav-settings') && navigation.includes('nav-authorization'), 'Essential navigation is present');
    for (const id of navigation.filter(id => !probe && (!focusedPages.length || focusedPages.includes(id.slice(4))))) {
      await click(`[data-testid="${id}"]`);
      await capturePage(id.slice(4));
      await auditKeyboardTabs(id.slice(4));
      if (id === 'nav-authorization') {
        await click('#wa-authorization-tab-discovered'); await capturePage('authorization-discovered');
        await setValue('[data-testid="add-conversation-name"]', '李'); await capturePage('authorization-name-results');
        await setValue('[data-testid="add-conversation-name"]', '');
        await setValue('[data-testid="conversation-search"]', '不存在的合成会话'); await capturePage('authorization-search-empty');
        await setValue('[data-testid="conversation-search"]', ''); await click('#wa-authorization-tab-authorized');
      }
      if (id === 'nav-records') {
        await click('.wa-record > summary'); await capturePage('record-detail');
        await click('.wa-record[data-state="sent"] > summary'); await capturePage('record-confirmed-detail');
        await click('[data-testid="records-tab-recovery"]'); await capturePage('recovery');
        await click('[aria-label="可恢复记录"] .wa-wb-list-item');
        await clickText('准备原回复'); await capturePage('recovery-send-preview');
        await click('.wa-recovery-options > summary'); await capturePage('recovery-options');
        await click('[data-testid="records-tab-history"]');
      }
      if (id === 'nav-tasks') {
        await click('.wa-task-details > summary'); await capturePage('task-current-detail');
        await click('[data-testid="task-tab-history"]'); await capturePage('task-history');
        await click('.wa-task-history-row > summary'); await capturePage('task-history-detail');
        await clickText('新增任务'); await capturePage('task-create');
        await setValue('[aria-label="任务执行方式"]', 'daily'); await capturePage('task-create-daily');
        await setValue('[aria-label="任务执行方式"]', 'interval'); await capturePage('task-create-interval');
        await clickText('收起新增');
      }
      if (id === 'nav-digests') {
        await clickText('生成简报草稿');
        await waitFor(() => !!document.querySelector('.wa-wb-digest'));
        await capturePage('digest-generated');
        await click('.wa-wb-source-list > summary'); await capturePage('digest-sources');
      }
      if (id === 'nav-assets') {
        await fixture('seedAssets');
        await waitFor(() => !!document.querySelector('.wa-asset-open'));
        await capturePage('assets-enabled-group');
        await click('[data-testid="asset-settings"] > summary'); await capturePage('assets-reply-settings');
        await click('.wa-asset-open'); await capturePage('asset-editor');
        assert(await evaluate(() => document.querySelector('[role=dialog]').contains(document.activeElement)), 'Asset editor takes keyboard focus');
        await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await waitFor(() => !document.querySelector('[role=dialog]'));
        report.assertions.push('Asset dialog opens with focus and closes with Escape');
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
        for (const tab of tabs) {
          await click(`[data-testid="${tab}"]`); await capturePage(tab);
          if (tab === 'memory-tab-conversation') {
            await click('[data-testid="memory-preferences"] > summary'); await capturePage('memory-preferences');
          }
          if (tab === 'memory-tab-global') {
            await click('.wa-long-fact .wa-button'); await capturePage('memory-fact-editor'); await clickText('取消编辑');
            await fixture('unreadableGlobalMemory');
            await waitFor(() => !!document.querySelector('[data-testid="memory-read-only"]'));
            await capturePage('memory-read-only-error');
            await fixture('repairGlobalMemory');
            await waitFor(() => !document.querySelector('[data-testid="memory-read-only"]'));
          }
          if (tab === 'memory-tab-images') {
            await click('.wa-image-open'); await capturePage('memory-image-preview'); await clickText('关闭图片预览');
          }
          if (tab === 'memory-tab-review') {
            await clickText('有效记忆'); await capturePage('memory-review-active');
            await clickText('调整有效期'); await capturePage('memory-expiry-editor');
            await click('.wa-wb-inline-form .is-quiet');
            await click('[data-testid="memory-delete-fact"]'); await capturePage('memory-delete-confirmation');
            await click('[aria-label="确认删除记忆"] .is-quiet');
          }
        }
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
          await click('[data-testid="nav-settings"]');
          if (detail === 'open-model') await fixture('holdNext', { endpoint: 'model.info' });
          await click(`[data-testid="${detail}"]`);
          if (detail === 'open-model') {
            await setValue('#wa-model', JSON.stringify(['fixture', 'beta']));
            await waitFor(async () => (await window.__uiFixture('heldRequest', { endpoint: 'model.info' })).started);
            await capturePage('model-info-loading');
            await fixture('releaseRequest', { endpoint: 'model.info' });
            await waitFor(() => !!document.querySelector('#wa-reasoning-effort option[value=high]'));
          }
          await capturePage(detail.slice(5));
          if (detail === 'open-persona') {
            await click('.wa-persona-manuscript details > summary'); await capturePage('persona-names');
          }
          if (detail === 'open-model') {
            await click('[data-testid="model-advanced"] > summary'); await capturePage('model-advanced-settings');
            await click('[data-testid="search-credentials"] > summary'); await capturePage('model-search-credentials');
            await fixture('modelInfoFailure', { enabled: true }); await clickText('刷新模型列表');
            await waitFor(() => [...document.querySelectorAll('button')].some(el => el.textContent.includes('重试读取强度')));
            await capturePage('model-info-error');
            await fixture('modelInfoFailure', { enabled: false }); await clickText('重试读取强度');
            await waitFor(() => !!document.querySelector('#wa-reasoning-effort option[value=high]'));
          }
          if (detail === 'open-image-generation') {
            await click('[data-testid="image-provider-add"]');
            await click('[data-testid="image-generation-settings"] details > summary');
            await capturePage('image-generation-provider-editor');
          }
          if (detail === 'open-identity') {
            await click('.wa-identity-file > summary'); await capturePage('identity-file-details');
          }
          if (detail === 'open-storage') {
            await click('[data-testid="storage-derived-paths"] > summary');
            await click('.wa-storage-settings > .wa-data-details > summary');
            await capturePage('storage-directory-details');
          }
          if (detail === 'open-administrators') {
            await setValue('[aria-label="管理员候选来源"]', 'group_alpha@chatroom');
            await waitFor(() => document.querySelectorAll('[data-admin-id]').length > 0);
            await click('[data-admin-id="wxid_alice"] input'); await capturePage('administrator-selection');
            await fixture('failNext', { endpoint: 'administrators.candidates' }); await clickText('刷新名单');
            await waitFor(() => !!document.querySelector('[data-testid="admin-picker"] [role=alert]'));
            await capturePage('administrator-read-error'); await clickText('刷新名单');
          }
        }
      }
    }
    if (probe === 'assets') {
      await click('[data-testid="nav-assets"]'); await capturePage('assets-page-probe');
      await fixture('seedAssets');
      await waitFor(() => !!document.querySelector('.wa-asset-open'));
      await click('.wa-asset-open'); await capturePage('assets-dialog-probe'); await clickText('关闭');
    }
    if (probe === 'details') {
      await click('[data-testid="nav-settings"]'); await click('[data-testid="open-administrators"]');
      const longId = 'wxid_visual_long_identifier_' + 'x'.repeat(92);
      await setValue('[aria-label="搜索全局管理员"]', longId);
      await clickText('按微信 ID 添加：' + longId); await capturePage('administrator-long-selection');
      await setValue('[aria-label="搜索全局管理员"]', '没有匹配的合成联系人'); await capturePage('administrator-search-empty');
      await click('[data-testid="nav-moments"]'); await click('[data-testid="moments-tab-publish"]');
      await clickText('读取微信标签与联系人');
      await click('[aria-label="屏蔽标签 产品同事"]'); await click('[aria-label="屏蔽联系人 Bob wxid_bob"]');
      await capturePage('moments-audience-selected');
      await setValue('[aria-label="搜索屏蔽联系人"]', '无匹配'); await capturePage('moments-audience-empty');
      await click('[data-testid="moments-tab-publishing"]'); await clickText('新增发布计划');
      await setValue('[aria-label="发布计划名称"]', '周末小记');
      await setValue('[aria-label="发布主题"]', '轻松的周末见闻');
      await setValue('[aria-label="自动发布方式"]', 'review');
      await clickText('生成预览（不发布）');
      await waitFor(() => !!document.querySelector('[aria-label="自动发布草稿正文"]'));
      await clickText('关闭编辑'); await capturePage('moments-generated-draft');
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
    if (!focusedPages.length || focusedPages.includes('overview')) {
      for (const loginState of ['offline', 'logged-out', 'qrcode', 'scanned', 'error', 'online']) {
        await fixture('visualLogin', { state: loginState });
        // Reload follows the normal status bootstrap instead of mutating React state.
        await window.loadURL(origin);
        await waitFor(() => !!document.querySelector('.wa-account-name'));
        await capturePage('login-' + loginState);
      }
      await fixture('holdNext', { endpoint: 'status' });
      await window.loadURL(origin);
      await waitFor(() => !!document.querySelector('.wa-loading-block'));
      await capturePage('workspace-loading');
      await fixture('releaseRequest', { endpoint: 'status' });
      await waitFor(() => !!document.querySelector('.wa-account-name'));
    }
    window.setContentSize(430, 940);
    const pressNavigationKey = async keyCode => {
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      // Enter requires its character event to perform native button activation.
      if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await pause(100);
    };
    await evaluate(() => document.querySelector('[data-testid="mobile-navigation"]').focus());
    await pressNavigationKey('Enter');
    await waitFor(() => document.querySelector('[data-testid="mobile-navigation"]').getAttribute('aria-expanded') === 'true');
    assert.equal(await evaluate(() => document.activeElement.dataset.testid), 'nav-overview');
    await audit('mobile-navigation-open', 430, 'light');
    await audit('mobile-navigation-open', 320, 'dark');
    await pressNavigationKey('Tab');
    assert.equal(await evaluate(() => document.activeElement.dataset.testid), 'nav-authorization');
    await pressNavigationKey('Escape');
    await waitFor(() => document.querySelector('[data-testid="mobile-navigation"]').getAttribute('aria-expanded') === 'false' && document.activeElement.dataset.testid === 'mobile-navigation');
    report.assertions.push('Compact navigation opens, exposes every page, closes on Escape and restores focus');
    await pressNavigationKey('Enter'); await pressNavigationKey('Tab'); await pressNavigationKey('Enter');
    await waitFor(() => document.querySelector('.wa-panel').dataset.page === 'authorization');
    assert.equal(await evaluate(() => document.querySelector('[data-testid="mobile-navigation"]').getAttribute('aria-expanded')), 'false');
    await click('[data-testid="nav-overview"]');
    report.assertions.push('Compact navigation selects a page and closes after selection');
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
    if (report.errors.length) throw new Error(`Visual audit found ${report.errors.length} issues; see report.json for exact elements and ratios`);
    report.ok = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    try { fs.writeFileSync(path.join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
  } finally {
    clearTimeout(watchdog);
    report.requests = { count: report.requests.length, external: report.errors.filter(message => message.startsWith('Unexpected external browser request:')).length };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, assertions: report.assertions.length, screenshots: report.screenshots.length,
      errors: report.errors.length, failure: report.failure, report: path.join(out, 'report.json') }));
    app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error.stack); app.exit(1); });
