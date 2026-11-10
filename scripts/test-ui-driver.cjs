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
const report = { ok: false, runId: process.env.WECHAT_UI_TEST_RUN_ID || null, assertions: [], errors: [], screenshots: [], at: new Date().toISOString() };
let window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// These helpers are declared inside each browser evaluation so reloads cannot
// remove them. A hidden tab or a closed details body is never usable evidence.
function browserVisible(el) {
  if (!el?.isConnected || !el.getClientRects().length) return false;
  for (let node = el; node; node = node.parentElement) {
    if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    if (node.tagName === 'DETAILS' && !node.open && node !== el) {
      const summary = Array.from(node.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(el)) return false;
    }
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function browserUsable(el, editing = false) {
  return isVisible(el) && !el.matches(':disabled') && !el.closest('[aria-disabled="true"]') &&
    getComputedStyle(el).pointerEvents !== 'none' && (!editing || !el.readOnly);
}
const evaluate = (fn, ...args) => window.webContents.executeJavaScript('(() => { const isVisible = ' + browserVisible.toString() + '; const isUsable = ' + browserUsable.toString() + '; return (' + fn.toString() + ')(...' + JSON.stringify(args) + '); })()');
async function waitFor(fn, args = [], timeout = 16000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate((source, args) => Promise.resolve(eval('(' + source + ')')(...args)).then(Boolean), fn.toString(), args)) return;
    await pause(70);
  }
  throw new Error('UI wait timed out: ' + fn.toString().slice(0, 220));
}
async function click(selector) {
  await waitFor(s => Array.from(document.querySelectorAll(s)).some(el => isUsable(el)), [selector]);
  await evaluate(s => { const el = Array.from(document.querySelectorAll(s)).find(el => isUsable(el)); el.scrollIntoView({ block: 'center' }); el.click(); }, selector);
}
async function clickText(text, scope = '.wa-workspace') {
  await waitFor((text, scope) => Array.from(document.querySelector(scope)?.querySelectorAll('button') || []).some(el => (el.textContent.trim() === text || el.getAttribute('role') === 'tab' && el.textContent.trim().startsWith(text)) && isUsable(el)), [text, scope]);
  await evaluate((text, scope) => { const el = Array.from(document.querySelector(scope).querySelectorAll('button')).find(el => (el.textContent.trim() === text || el.getAttribute('role') === 'tab' && el.textContent.trim().startsWith(text)) && isUsable(el)); el.scrollIntoView({ block: 'center' }); el.click(); }, text, scope);
}
async function input(selector, value) {
  await waitFor(s => Array.from(document.querySelectorAll(s)).some(el => isUsable(el, true)), [selector]);
  await evaluate((selector, value) => {
    const el = Array.from(document.querySelectorAll(selector)).find(el => isUsable(el, true));
    el.scrollIntoView({ block: 'center' }); el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}
const fixture = (command, payload = {}) => evaluate((command, payload) => window.__uiFixture(command, payload), command, payload);
const value = selector => evaluate(selector => Array.from(document.querySelectorAll(selector)).find(el => isVisible(el))?.value, selector);
async function stateMatches(fn, ...args) {
  await waitFor(async (source, args) => (0, eval)('(' + source + ')')(await window.__uiFixture('state'), ...args), [fn.toString(), args]);
}
async function theme(name) {
  await evaluate(name => { document.documentElement.dataset.theme = name; document.documentElement.classList.toggle('dark', name === 'dark'); }, name);
  await pause(100);
}
async function screenshot(name, selectedTheme = 'dark', focusSelector) {
  await theme(selectedTheme);
  await evaluate(() => document.querySelector('.wa-workspace')?.scrollTo({ top: 0, left: 0 }));
  if (focusSelector) {
    await waitFor(selector => isVisible(document.querySelector(selector)), [focusSelector]);
    await evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'start', behavior: 'instant' }), focusSelector);
  }
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

async function waitForReasoning(expectedValue = '') {
  await waitFor(expected => {
    const select = document.querySelector('#wa-reasoning-effort');
    return isUsable(select) && select.value === expected && [...select.options].some(option => option.value === 'high' && !option.disabled);
  }, [expectedValue]);
}

async function verifyModelReasoning() {
  await waitFor(() => isUsable(document.querySelector('#wa-model')));
  const originalDefault = (await fixture('state')).defaultModel;
  assert.equal(await value('#wa-model'), '');
  assert.equal(await evaluate(() => !!document.querySelector('#wa-reasoning-effort')), false);
  assert((await fixture('modelCatalog', { mode: 'full' })).models.every(model => !model.reasoning), 'Shared catalog must omit reasoning to exercise detail discovery');
  await input('#wa-model', JSON.stringify(['fixture', 'beta']));
  await stateMatches(state => state.modelChoice?.model === 'beta' && !Object.hasOwn(state.modelChoice, 'reasoningEffort'));
  await waitForReasoning();
  assert.deepEqual(await evaluate(() => [...document.querySelector('#wa-reasoning-effort').options].map(option => option.value)), ['', 'low', 'high']);
  assert.equal(await evaluate(() => document.querySelector('#wa-reasoning-effort').selectedOptions[0].textContent.trim()), '使用模型默认（高）');
  await input('#wa-reasoning-effort', 'low');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'low');
  await waitFor(() => document.querySelector('#wa-reasoning-effort-help')?.textContent.includes('适合简单问答'));
  await click('[data-testid="nav-overview"]'); await click('[data-testid="nav-settings"]'); await click('[data-testid="open-model"]');
  await waitForReasoning('low');
  await fixture('failNext', { endpoint: 'model.select' }); await input('#wa-reasoning-effort', 'high');
  await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes('模拟保存失败')));
  assert.equal((await fixture('state')).modelChoice.reasoningEffort, 'low');
  assert.equal(await value('#wa-reasoning-effort'), 'low');
  await input('#wa-reasoning-effort', 'high');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'high');
  await input('#wa-model', JSON.stringify(['fixture', 'alpha']));
  await stateMatches(state => state.modelChoice?.model === 'alpha' && !Object.hasOwn(state.modelChoice, 'reasoningEffort'));
  await waitFor(() => !document.querySelector('#wa-reasoning-effort'));
  await input('#wa-model', JSON.stringify(['fixture', 'beta']));
  await waitForReasoning();
  assert(!Object.hasOwn((await fixture('state')).modelChoice, 'reasoningEffort'));
  check('reasoning options are resolved for the selected model despite absent list metadata; explicit values save, survive navigation and failed saves, and clear when changing models');

  await input('#wa-reasoning-effort', 'low');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'low');
  await fixture('modelCatalog', { mode: 'without-low' });
  await waitFor(() => document.querySelector('#wa-reasoning-effort')?.getAttribute('aria-invalid') === 'true');
  assert.equal(await value('#wa-reasoning-effort'), 'low');
  assert(await evaluate(() => document.querySelector('#wa-reasoning-effort').selectedOptions[0].textContent.includes('暂不可用')));
  assert.equal((await fixture('state')).modelChoice.reasoningEffort, 'low');
  await input('#wa-reasoning-effort', 'high');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'high');
  await waitFor(() => !document.querySelector('#wa-reasoning-effort-warning'));
  await fixture('modelCatalog', { mode: 'empty' });
  await waitFor(() => document.querySelector('#wa-reasoning-effort')?.getAttribute('aria-invalid') === 'true');
  assert.equal(await value('#wa-reasoning-effort'), 'high');
  assert.deepEqual(await evaluate(() => [...document.querySelector('#wa-reasoning-effort').options].filter(option => !option.disabled).map(option => option.value)), ['']);
  assert.equal((await fixture('state')).modelChoice.reasoningEffort, 'high');
  await input('#wa-reasoning-effort', '');
  await stateMatches(state => state.modelChoice?.model === 'beta' && !Object.hasOwn(state.modelChoice, 'reasoningEffort'));
  await waitFor(() => !document.querySelector('#wa-reasoning-effort'));
  await fixture('modelCatalog', { mode: 'full' });
  await waitForReasoning();
  await input('#wa-reasoning-effort', 'low');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'low');
  await input('#wa-model', '');
  await stateMatches(state => state.modelChoice === null);
  await waitFor(() => !document.querySelector('#wa-reasoning-effort'));
  assert.deepEqual((await fixture('state')).defaultModel, originalDefault);
  await input('#wa-model', JSON.stringify(['fixture', 'beta']));
  await waitForReasoning();
  check('catalog changes retain and mark unavailable saved efforts, allow correction or default reset, and never change the host default selection');
  await verifyModelReasoningLookups();
}

async function verifyModelReasoningLookups() {
  await input('#wa-reasoning-effort', 'low');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'low');
  const before = (await fixture('state')).modelChoice;
  await fixture('modelInfoFailure', { enabled: true });
  await clickText('刷新模型列表');
  await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes('暂时无法读取所选模型的推理强度')));
  assert.deepEqual((await fixture('state')).modelChoice, before);
  assert.equal(await value('#wa-reasoning-effort'), 'low');
  assert.equal(await evaluate(() => document.querySelector('#wa-reasoning-effort').getAttribute('aria-invalid')), null);
  assert(!await evaluate(() => document.querySelector('.wa-workspace').textContent.includes('未为此模型提供可选推理强度')));
  assert(!await evaluate(() => document.body.textContent.includes('SYNTHETIC_PRIVATE_MODEL_LOOKUP_FAILURE')));
  await screenshot('model-reasoning-read-error-dark', 'dark', '#wa-reasoning-effort');
  await fixture('modelInfoFailure', { enabled: false });
  await clickText('重试读取强度');
  await waitForReasoning('low');
  check('detail lookup failures retain the saved effort, report a readable error, and retry without exposing private provider diagnostics');

  await fixture('modelInfoFailure', { enabled: true });
  await clickText('刷新模型列表');
  await waitFor(() => [...document.querySelectorAll('button')].some(el => el.textContent.trim() === '重试读取强度'));
  await input('#wa-reasoning-effort', '');
  await stateMatches(state => state.modelChoice?.model === 'beta' && !Object.hasOwn(state.modelChoice, 'reasoningEffort'));
  await fixture('modelInfoFailure', { enabled: false });
  await clickText('重试读取强度');
  await waitForReasoning();
  check('resetting an effort to the model default remains available during a metadata outage');

  await fixture('modelCatalog', { mode: 'expanded' });
  await waitFor(() => document.querySelector('#wa-reasoning-effort')?.options.length === 6);
  assert.deepEqual(await evaluate(() => [...document.querySelector('#wa-reasoning-effort').options].map(option => option.value)), ['', 'off', 'low', 'medium', 'high', 'adaptive/custom']);
  assert.equal(await evaluate(() => document.querySelector('#wa-reasoning-effort').selectedOptions[0].textContent.trim()), '使用模型默认');
  assert(await evaluate(() => document.querySelector('#wa-reasoning-effort-help').textContent.includes('DSH 未提供默认档位信息')));
  await input('#wa-reasoning-effort', 'adaptive/custom');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'adaptive/custom');
  await input('#wa-reasoning-effort', 'medium');
  await stateMatches(state => state.modelChoice?.reasoningEffort === 'medium');
  await screenshot('model-reasoning-expanded-light', 'light', '#wa-reasoning-effort');
  check('effort options follow live metadata including off, medium and provider-defined IDs; absent defaults are never invented');

  await input('#wa-model', JSON.stringify(['fixture', 'alpha']));
  await stateMatches(state => state.modelChoice?.model === 'alpha');
  await waitFor(() => !document.querySelector('#wa-reasoning-effort'));
  await evaluate(() => { window.__uiIgnoreModelInfoAbort = true; });
  await fixture('holdNext', { endpoint: 'model.info' });
  await input('#wa-model', JSON.stringify(['fixture', 'beta']));
  await waitFor(async () => (await window.__uiFixture('heldRequest', { endpoint: 'model.info' })).started);
  const pendingIndex = (await fixture('stats')).modelInfoRequests.length - 1;
  await waitFor(() => document.querySelector('.wa-workspace').textContent.includes('正在向 DSH 查询该模型的推理强度'));
  assert.equal(await evaluate(() => document.querySelector('#wa-reasoning-effort').disabled), true);
  await input('#wa-model', JSON.stringify(['fixture', 'alpha']));
  await stateMatches(state => state.modelChoice?.model === 'alpha');
  await waitFor(() => !document.querySelector('#wa-reasoning-effort'));
  assert(await evaluate(() => document.querySelector('.wa-workspace').textContent.includes('未为此模型提供可选推理强度')));
  await fixture('releaseRequest', { endpoint: 'model.info' });
  await waitFor(async index => (await window.__uiFixture('stats')).modelInfoRequests[index]?.completed, [pendingIndex]);
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  assert.equal(await evaluate(() => !!document.querySelector('#wa-reasoning-effort')), false, 'Late beta capabilities must not appear for alpha even if the transport ignored abort');
  assert.equal((await fixture('state')).modelChoice.model, 'alpha');
  await evaluate(() => { window.__uiIgnoreModelInfoAbort = false; });
  await fixture('modelCatalog', { mode: 'full' });
  await input('#wa-model', JSON.stringify(['fixture', 'beta']));
  await waitForReasoning();
  check('loading capabilities remain distinct from unsupported models; switching models discards late results even when the transport ignores cancellation');
}

async function captureNaturalChat() {
  for (const [size, width, height] of [['desktop', 1280, 1100], ['narrow', 430, 900]]) {
    window.setContentSize(width, height);
    await assertLayout(size + ' natural chat');
    for (const selectedTheme of ['dark', 'light']) {
      await screenshot('natural-chat-' + size + '-' + selectedTheme, selectedTheme, '[data-testid="natural-chat-settings"]');
      const controlsInFrame = await evaluate(() => ['#wa-natural-temperament', '#wa-natural-interval', '#wa-natural-start', '#wa-natural-end'].every(selector => {
        const control = document.querySelector(selector), rect = control?.getBoundingClientRect();
        return isVisible(control) && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
      }));
      assert(controlsInFrame, size + ' natural chat controls must be visible in the screenshot');
      await screenshot('natural-chat-' + size + '-followup-' + selectedTheme, selectedTheme, '[data-testid="natural-chat-settings"] details');
    }
  }
  window.setContentSize(1280, 940);
}

async function verifyVisualDesign() {
  const originalSettings = (await fixture('state')).settings;
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await waitFor(() => document.querySelector('.wa-panel').dataset.motion === 'off');
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="visual-motion-toggle"]') || !!document.querySelector('[data-testid="conversation-sculpture"]')), false);
    assert.deepEqual((await fixture('state')).settings, originalSettings);
    check('simplified overview removes decorative sculpture and motion control; system reduced motion leaves account settings intact');
    await clickText('断开连接');
    await waitFor(() => document.querySelector('.wa-login-state')?.textContent === '微信离线');
    assert.equal((await fixture('state')).online, false);
    assert.equal(await evaluate(() => !!document.querySelector('.wa-login-state .is-online')), false);
    await screenshot('overview-disconnected-dark');
    await clickText('重新连接');
    await waitFor(() => document.querySelector('.wa-login-state')?.textContent.includes('已连接，正在同步新消息'));
    check('disconnect clears stale live status; reconnect restores the confirmed connection label');
    window.setContentSize(1280, 1100);
    for (const selectedTheme of ['dark', 'light']) {
      await theme(selectedTheme);
      const colors = await evaluate(() => {
        const panel = getComputedStyle(document.querySelector('.wa-panel'));
        const muted = getComputedStyle(document.querySelector('.wa-page-head .wa-muted'));
        const luminance = color => { const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => { const s = Number(value) / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }); return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722; };
        const contrast = foreground => { const values = [luminance(foreground), luminance(panel.backgroundColor)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
        return { background: panel.backgroundColor, text: contrast(panel.color), muted: contrast(muted.color) };
      });
      assert(colors.text >= 4.5 && colors.muted >= 4.5, selectedTheme + ' text contrast: ' + JSON.stringify(colors));
      await screenshot('overview-desktop-' + selectedTheme, selectedTheme);
      await click('[data-testid="nav-settings"]'); await screenshot('settings-desktop-' + selectedTheme, selectedTheme);
      await click('[data-testid="open-persona"]');
      await waitFor(() => !!document.querySelector('[data-testid="global-persona-editor"]'));
      assert.equal(await evaluate(() => !!document.querySelector('[data-testid="browse-persona-presets"]') || !!document.querySelector('.wa-persona-card')), false);
      await assertLayout('desktop global persona editor'); await screenshot('personas-desktop-' + selectedTheme, selectedTheme);
      await click('[data-testid="nav-assets"]'); await waitFor(() => document.querySelectorAll('.wa-pack-card').length === 3);
      await screenshot('stickers-desktop-' + selectedTheme, selectedTheme);
      await click('[data-testid="nav-overview"]');
    }
    check('light and dark surfaces meet 4.5:1 contrast for primary and explanatory text; single global persona editor stays direct');
    const pages = await evaluate(() => [...document.querySelectorAll('.wa-nav-button[data-testid]')].map(button => button.dataset.testid.slice(4)));
    for (const width of [1024, 768, 430, 360, 320]) {
      window.setContentSize(width, 900);
      for (const page of pages) {
        await click('[data-testid="nav-' + page + '"]');
        await waitFor(page => document.querySelector('.wa-panel').dataset.page === page, [page]);
        await pause(100); await assertLayout(width + 'px ' + page);
        const navigation = await evaluate(() => Array.from(document.querySelectorAll('.wa-nav-button')).every(button => { button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); const r = button.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
        assert(navigation, 'All navigation controls must remain reachable at ' + width + 'px');
        if (page === 'overview' || width === 430 && ['settings', 'assets', 'authorization'].includes(page)) await screenshot(page + '-' + width + '-dark');
      }
    }
    check('all current pages and navigation fit 1024, 768, 430, 360 and 320px widths without horizontal overflow');
    for (const width of [1280, 430]) {
      window.setContentSize(width, 940);
      for (const selectedTheme of ['light', 'dark']) {
        for (const page of pages) {
          await click('[data-testid="nav-' + page + '"]');
          await waitFor(page => document.querySelector('.wa-panel').dataset.page === page, [page]);
          await assertLayout('studio ' + width + '/' + selectedTheme + '/' + page);
          await screenshot('studio-' + page + '-' + width + '-' + selectedTheme, selectedTheme);
          if (page === 'memory') {
            for (const tab of ['conversation', 'global', 'images', 'review']) {
              await click('[data-testid="memory-tab-' + tab + '"]');
              await waitFor(tab => document.querySelector('#wa-memory-panel-' + tab)?.hidden === false, [tab]);
              await assertLayout('studio memory ' + tab + '/' + width + '/' + selectedTheme);
              await screenshot('studio-memory-' + tab + '-' + width + '-' + selectedTheme, selectedTheme);
            }
          }
          if (page === 'settings') {
            const details = await evaluate(() => [...document.querySelectorAll('[data-testid^="open-"]')].map(button => button.dataset.testid.slice(5)));
            for (const detail of details) {
              await click('[data-testid="open-' + detail + '"]');
              await waitFor(detail => document.querySelector('.wa-panel').dataset.page === detail, [detail]);
              await assertLayout('studio settings ' + detail + '/' + width + '/' + selectedTheme);
              await screenshot('studio-settings-' + detail + '-' + width + '-' + selectedTheme, selectedTheme);
              await click('[data-testid="nav-settings"]');
            }
          }
        }
      }
    }
    check('every current navigation page, memory tab and settings editor renders at desktop and narrow widths in both themes');
  } finally { window.webContents.debugger.detach(); }
}

async function verifyLongMemorySources() {
  const sourceSelect = '[aria-label="长期记忆来源会话"]', panel = '#wa-memory-panel-global';
  const doc = await fixture('seedLongMemorySources'), originalBytes = fs.readFileSync(doc.path);
  const visibleFacts = () => evaluate(() => Array.from(document.querySelectorAll('#wa-memory-panel-global .wa-long-collected [data-long-fact-id]'))
    .filter(el => isVisible(el)).map(el => el.dataset.longFactId));
  const activeIds = sections => sections.flatMap(section => section.facts.filter(fact => fact.state === 'active').map(fact => fact.id));
  await clickText('重新读取', panel); await input(sourceSelect, '');
  await waitFor(ids => {
    const rendered = Array.from(document.querySelectorAll('#wa-memory-panel-global .wa-long-collected [data-long-fact-id]'))
      .filter(el => isVisible(el)).map(el => el.dataset.longFactId);
    return JSON.stringify(rendered) === JSON.stringify(ids);
  }, [activeIds(doc.sections)]);
  assert.equal((await visibleFacts()).length, 3);
  for (const section of doc.sections) {
    const choice = `${section.chatType}:${section.peerId}`;
    assert.notEqual(section.key, choice, 'fixture must use the real backend storage key');
    await input(sourceSelect, choice);
    assert.deepEqual(await visibleFacts(), activeIds([section]), 'selected source must show exactly its own facts');
    assert(await evaluate(name => {
      const headings = Array.from(document.querySelectorAll('#wa-memory-panel-global .wa-long-source-head h3')).filter(el => isVisible(el));
      return headings.length === 1 && headings[0].textContent === name;
    }, section.name));
    assert(await evaluate(() => Array.from(document.querySelectorAll('#wa-memory-panel-global button'))
      .some(el => el.textContent.trim() === '整理这个会话的重要信息' && isUsable(el))));
  }
  await input(sourceSelect, 'group:group_gamma@chatroom');
  assert.deepEqual(await visibleFacts(), []);
  assert(await evaluate(() => Array.from(document.querySelectorAll('#wa-memory-panel-global .wa-long-collected p'))
    .some(el => isVisible(el) && el.textContent.includes('还没有匹配的长期事实'))));
  await input(sourceSelect, ''); assert.deepEqual(await visibleFacts(), activeIds(doc.sections));
  await input(sourceSelect, 'group:group_alpha@chatroom'); await clickText('重新读取', panel);
  await waitFor(() => document.querySelector('[aria-label="长期记忆来源会话"]')?.value === 'group:group_alpha@chatroom');
  assert.deepEqual(await visibleFacts(), activeIds(doc.sections.filter(section => section.peerId === 'group_alpha@chatroom')));
  assert.deepEqual(fs.readFileSync(doc.path), originalBytes, 'changing source filters and rereading must preserve stored facts');
  await screenshot('long-memory-source-group-dark'); await screenshot('long-memory-source-group-light', 'light');
  await input(sourceSelect, '');
  check('real extracted long-memory facts remain visible when selecting either group or a private chat; empty sources stay empty, reread keeps the selection, and filtering preserves Markdown bytes');
}

async function verifyManualCompression() {
  const before = await fixture('manualCompressionSeed'), other = await fixture('localMemory', { peerId: 'group_beta@chatroom' });
  assert(before.chars > 0 && before.chars < before.windowChars);
  await click('[data-testid="nav-memory"]');
  const key = await evaluate(() => Array.from(document.querySelector('[aria-label="选择会话"]').options).find(option => option.textContent.includes('产品讨论组')).value);
  await input('[aria-label="选择会话"]', key);
  await waitFor(() => document.querySelector('[data-testid="memory-document"]')?.textContent.includes('产品讨论组'));
  await clickText('立即压缩', '#wa-memory-panel-conversation');
  await waitFor(() => document.querySelector('#wa-memory-panel-conversation [role="status"]')?.textContent.includes('记忆已压缩'));
  const after = await fixture('localMemory');
  assert.equal(after.compressions, before.compressions + 1); assert(after.chars < before.chars);
  assert(after.entries.some(entry => entry.key === 'manual-compression-5'));
  assert.deepEqual(await fixture('localMemory', { peerId: 'group_beta@chatroom' }), other);
  check('clicking manual compression below the window runs the actual owner RPC, reduces memory, and preserves another conversation');
  await screenshot('manual-compression-under-window');
  await fixture('failNext', { endpoint: 'memory.compress' }); await clickText('立即压缩', '#wa-memory-panel-conversation');
  await waitFor(() => document.querySelector('#wa-memory-panel-conversation [role="alert"]')?.textContent.includes('模拟保存失败'));
  assert.deepEqual(await fixture('localMemory'), after);
  await fixture('holdNext', { endpoint: 'memory.compress' }); await clickText('立即压缩', '#wa-memory-panel-conversation');
  await waitFor(async () => (await window.__uiFixture('heldRequest', { endpoint: 'memory.compress' })).started);
  assert(await evaluate(() => Array.from(document.querySelectorAll('#wa-memory-panel-conversation button')).some(button => button.textContent.trim() === '等待压缩…' && button.disabled)),
    'an RPC held before acceptance must show waiting, not claim the model is already running');
  await fixture('releaseRequest', { endpoint: 'memory.compress' });
  await waitFor(() => document.querySelector('#wa-memory-panel-conversation [role="status"]')?.textContent.includes('记忆已压缩'));
  assert.equal((await fixture('localMemory')).compressions, after.compressions + 1);
  check('manual compression failures preserve memory; retry succeeds and the pending button blocks duplicate clicks');
  await clickText('清空当前记忆', '#wa-memory-panel-conversation'); await clickText('确认清空这份记忆', '#wa-memory-panel-conversation');
  await waitFor(() => document.querySelector('#wa-memory-panel-conversation [role="status"]')?.textContent.includes('当前记忆已清空'));
  assert(await evaluate(() => Array.from(document.querySelectorAll('#wa-memory-panel-conversation button')).some(button => button.textContent.trim() === '立即压缩' && button.disabled)));
  check('empty memory disables manual compression without requiring a character threshold');
  await screenshot('manual-compression-empty');
}

async function verifyMemory() {
  const localPanel = '#wa-memory-panel-conversation', globalPanel = '#wa-memory-panel-global';
  const globalNotes = '共同约定：默认用中文；周五下午留出时间讨论产品方案。';
  const localSummary = '这是一份用于界面验证的记忆：群里约定周五讨论产品。';
  const selectedKey = name => evaluate(name => Array.from(document.querySelector('[aria-label="选择会话"]').options).find(option => option.textContent.includes(name)).value, name);
  const assertPanel = async id => {
    assert(await evaluate(id => {
      return document.querySelector('#wa-memory-tab-' + id).getAttribute('aria-selected') === 'true' &&
        ['conversation', 'global', 'images', 'review'].every(tab => isVisible(document.querySelector('#wa-memory-panel-' + tab)) === (tab === id));
    }, id), id + ' must be the only visible memory panel');
  };
  const overview = async memoryDoc => {
    assert(await evaluate(memoryDoc => {
      const area = document.querySelector('[aria-label="当前会话记忆概况"]');
      return isVisible(area) && JSON.stringify(Array.from(area.querySelectorAll('dd')).map(el => el.textContent)) ===
        JSON.stringify([String(memoryDoc.entries.length), memoryDoc.chars.toLocaleString(), memoryDoc.compressions + ' 次']) &&
        area.querySelector('.wa-memory-capacity').textContent.includes(memoryDoc.chars.toLocaleString() + ' / ' + memoryDoc.windowChars.toLocaleString() + ' 字') &&
        area.querySelector('.wa-memory-meter > span').style.width === Math.max(0, Math.min(100, Math.round(memoryDoc.chars / memoryDoc.windowChars * 100))) + '%';
    }, memoryDoc), 'Memory metrics and capacity must match the selected durable document');
  };
  await click('[data-testid="nav-memory"]'); await assertPanel('conversation');
  const chooseAlpha = await selectedKey('产品讨论组'), chooseBeta = await selectedKey('周末出游');
  await input('[aria-label="选择会话"]', chooseAlpha);
  await waitFor(() => isVisible(document.querySelector('[data-testid="memory-document"]')) && document.querySelector('[data-testid="memory-document"]').textContent.includes('产品讨论组'));
  assert.equal(await evaluate(() => document.querySelector('[data-testid="memory-preferences"]').open), false);
  assert.equal(await evaluate(() => isUsable(document.querySelector('[aria-label="默认记忆窗口字符数"]'), true)), false);
  await click('[data-testid="memory-preferences"] > summary');
  assert.equal(await value('[aria-label="默认记忆窗口字符数"]'), '100000');
  assert.equal(await evaluate(() => document.querySelector('[aria-label="默认记忆窗口字符数"]').hasAttribute('max')), false);
  await input('[aria-label="默认记忆窗口字符数"]', '1000000'); await clickText('保存窗口');
  await stateMatches(state => state.memory.windowChars === 1000000);
  check('custom million-character memory window saves through the real owner RPC without the old 200000-character limit');
  await input('[aria-label="默认记忆窗口字符数"]', '48000'); await clickText('保存窗口', localPanel);
  await stateMatches(state => state.memory.windowChars === 48000);
  await waitFor(() => document.querySelector('[data-testid="memory-preferences"] > summary').textContent.includes('48000'));
  await click('[data-testid="memory-preferences"] > summary');
  const alphaBefore = await fixture('localMemory'), betaBefore = await fixture('localMemory', { peerId: 'group_beta@chatroom' });
  assert.equal(alphaBefore.windowChars, 24000); assert.equal(betaBefore.windowChars, 48000);
  await overview(alphaBefore);
  await input('[aria-label="选择会话"]', chooseBeta);
  await waitFor(() => document.querySelector('[data-testid="memory-document"]')?.textContent.includes('周末出游'));
  await overview(betaBefore);
  await input('[aria-label="选择会话"]', chooseAlpha);
  await waitFor(() => document.querySelector('[data-testid="memory-document"]')?.textContent.includes('产品讨论组'));
  check('memory overview reads actual room metrics and capacity; preferences start collapsed, save the default, and preserve the room override');
  await fixture('seedImageFailures');
  await waitFor(() => document.querySelector('[data-testid="image-failure-reasons"]')?.textContent.includes('2 张：图片资源地址不是可读取的微信媒体地址'));
  await clickText('重试图片理解', localPanel);
  await waitFor(() => document.querySelector('#wa-memory-panel-conversation [role="status"]')?.textContent.includes('仍有 2 张普通图片未理解'));
  assert.equal((await fixture('localMemory')).failedImages, 2);
  await fixture('fixImageReads'); await clickText('重试图片理解', localPanel);
  await waitFor(() => document.querySelector('#wa-memory-panel-conversation [role="status"]')?.textContent.includes('仍有 1 张图片的清晰度未核实'));
  assert.equal((await fixture('localMemory')).failedImages, 0);
  assert.equal(await evaluate(() => !!document.querySelector('[data-testid="image-failure-reasons"]')), false);
  check('image failures show grouped causes; unsuccessful retry reports remaining failures; success clears stale errors and keeps thumbnail limits');

  await evaluate(() => document.querySelector('#wa-memory-tab-conversation').focus());
  for (const [keyCode, tab] of [['Right', 'global'], ['Left', 'conversation'], ['Left', 'review'], ['Right', 'conversation'], ['End', 'review'], ['Left', 'images'], ['Home', 'conversation']]) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await waitFor(tab => document.activeElement?.id === 'wa-memory-tab-' + tab && document.activeElement.getAttribute('aria-selected') === 'true', [tab]);
    await assertPanel(tab);
  }
  await input('[aria-label="记忆摘要"]', localSummary);
  await clickText('长期记忆'); await assertPanel('global');
  await waitFor(() => isUsable(document.querySelector('[aria-label="全局通用备注"]'), true));
  assert.equal(await value('[aria-label="记忆摘要"]'), undefined, 'Hidden local content cannot be used as a visible value');
  await input('[aria-label="全局通用备注"]', globalNotes);
  await clickText('会话记忆'); await assertPanel('conversation'); assert.equal(await value('[aria-label="记忆摘要"]'), localSummary);
  await clickText('撤销修改', localPanel); assert.equal(await value('[aria-label="记忆摘要"]'), alphaBefore.summary);
  await input('[aria-label="记忆摘要"]', localSummary);
  await clickText('长期记忆'); assert.equal(await value('[aria-label="全局通用备注"]'), globalNotes);
  await clickText('撤销修改', globalPanel); assert.equal(await value('[aria-label="全局通用备注"]'), '');
  await input('[aria-label="全局通用备注"]', globalNotes);
  await clickText('会话记忆'); assert.equal(await value('[aria-label="记忆摘要"]'), localSummary);
  check('real arrow/Home/End keys select and focus all four memory tabs including review; unsaved local/global drafts survive switching and undo restores each saved value');

  await fixture('holdNext', { endpoint: 'memory.edit' }); await clickText('保存记忆', localPanel);
  await waitFor(async () => (await window.__uiFixture('heldRequest', { endpoint: 'memory.edit' })).started);
  const held = await fixture('heldRequest', { endpoint: 'memory.edit' });
  assert.equal(held.payload.peerId, 'group_alpha@chatroom'); assert.equal(held.payload.summary, localSummary);
  assert(await evaluate(() => ['选择会话', '按名字筛选会话', '记忆摘要'].every(label => { const el = document.querySelector('[aria-label="' + label + '"]'); return isVisible(el) && el.disabled && !isUsable(el, true); })));
  assert.equal(await value('[aria-label="选择会话"]'), chooseAlpha);
  assert.equal((await fixture('localMemory')).summary, alphaBefore.summary, 'Held save cannot appear in the saved document before completion');
  await fixture('releaseRequest', { endpoint: 'memory.edit' });
  await waitFor(() => isUsable(document.querySelector('[aria-label="选择会话"]')) && document.querySelector('#wa-memory-panel-conversation [role="status"]')?.textContent.includes('已保存'));
  assert.equal((await fixture('localMemory')).summary, localSummary);
  assert.equal((await fixture('localMemory', { peerId: 'group_beta@chatroom' })).summary, betaBefore.summary);
  assert.equal(await value('[aria-label="选择会话"]'), chooseAlpha);
  await overview(await fixture('localMemory'));
  assert.equal(await evaluate(() => isVisible(document.querySelector('.wa-memory-preview'))), false);
  await click('[data-testid="memory-document"] details:has(.wa-memory-preview) > summary');
  assert(await evaluate(() => isVisible(document.querySelector('.wa-memory-preview')) && document.querySelector('.wa-memory-preview').textContent.includes('ALPHA')));
  assert.equal(await evaluate(() => document.querySelector('.wa-memory-preview').textContent.includes('BETA')), false);
  await click('[data-testid="memory-document"] details:has(.wa-memory-preview) > summary');
  await assertLayout('desktop memory'); await screenshot('memory-desktop-dark'); await screenshot('memory-desktop-light', 'light');
  check('held memory save disables room search/selection and editing, writes only the original room after release, and the explicitly opened preview contains only that room');

  await clickText('长期记忆'); await assertPanel('global');
  await fixture('failNext', { endpoint: 'memory.global.edit' }); await clickText('保存全局备注', globalPanel);
  await waitFor(() => Array.from(document.querySelectorAll('#wa-memory-panel-global [role="alert"]')).some(el => isVisible(el) && el.textContent.includes('模拟保存失败')));
  assert.equal(await value('[aria-label="全局通用备注"]'), globalNotes); assert.equal((await fixture('globalMemory')).globalNotes, '');
  await clickText('保存全局备注', globalPanel);
  await waitFor(async notes => (await window.__uiFixture('globalMemory')).globalNotes === notes, [globalNotes]);
  await waitFor(notes => isVisible(document.querySelector('[data-testid="saved-global-notes"]')) && document.querySelector('[data-testid="saved-global-notes"] p').textContent === notes && !document.querySelector('[aria-label="全局通用备注"]'), [globalNotes]);
  await clickText('编辑全局备注', globalPanel); assert.equal(await value('[aria-label="全局通用备注"]'), globalNotes);
  await input('[aria-label="全局通用备注"]', '未保存的角色约定'); await clickText('取消编辑备注', globalPanel);
  assert.equal(await evaluate(() => document.querySelector('[data-testid="saved-global-notes"] p').textContent), globalNotes);
  assert.equal((await fixture('globalMemory')).globalNotes, globalNotes);
  check('saved owner notes leave the input and display as saved content; edit restores their exact text and cancel preserves the saved document');
  await verifyLongMemorySources();
  const globalDocument = await fixture('globalMemory'), originalBytes = fs.readFileSync(globalDocument.path);
  assert(originalBytes.toString('utf8').includes(globalNotes));
  assert(await evaluate(doc => {
    const area = document.querySelector('[aria-label="长期记忆概况"]');
    return isVisible(area) && JSON.stringify(Array.from(area.querySelectorAll('dd')).map(el => Number(el.textContent))) ===
      JSON.stringify([doc.factCount, doc.sections.filter(section => section.facts.some(fact => fact.state === 'active')).length, doc.pendingCount]);
  }, globalDocument));
  await assertLayout('desktop global memory'); await screenshot('global-memory-desktop-dark'); await screenshot('global-memory-desktop-light', 'light');
  const unreadable = await fixture('unreadableGlobalMemory'); assert.equal(unreadable.readOnly, true);
  assert.equal(fs.statSync(globalDocument.path).size, 8000001);
  try {
    await clickText('重新读取', globalPanel);
    await waitFor(() => isVisible(document.querySelector('[data-testid="memory-read-only"]')));
    assert(await evaluate(() => {
      const panel = document.querySelector('#wa-memory-panel-global');
      const writeButtons = ['保存全局备注', '修复完整 Markdown', '清空这个账号的长期记忆'];
      return panel.querySelector('[aria-label="全局通用备注"]').disabled && writeButtons.every(text => {
        const button = Array.from(panel.querySelectorAll('button')).find(el => el.textContent.trim() === text);
        return isVisible(button) && button.disabled;
      });
    }));
    await input('[aria-label="长期记忆来源会话"]', chooseAlpha);
    assert(await evaluate(() => Array.from(document.querySelectorAll('#wa-memory-panel-global button')).some(el => el.textContent.trim() === '整理这个会话的重要信息' && isVisible(el) && el.disabled)));
    await screenshot('global-memory-read-only-dark');
  } finally { await fixture('repairGlobalMemory'); }
  await clickText('重新读取', globalPanel);
  await waitFor(notes => !document.querySelector('[data-testid="memory-read-only"]') && isVisible(document.querySelector('[data-testid="saved-global-notes"]')) && document.querySelector('[data-testid="saved-global-notes"] p').textContent === notes, [globalNotes]);
  assert.deepEqual(fs.readFileSync(globalDocument.path), originalBytes);
  check('an actual oversized fixture Markdown file exposes read-only state, blocks editing/clearing/extraction, and reload restores the exact original notes after repair');

  await clickText('会话记忆'); await assertPanel('conversation'); assert.equal(await value('[aria-label="记忆摘要"]'), localSummary);
  const recordsBeforeMemoryClear = peer(await fixture('state'), 'group_alpha@chatroom').recordCount;
  await clickText('清空当前记忆', localPanel); await clickText('确认清空这份记忆', localPanel);
  await waitFor(() => isVisible(document.querySelector('[data-testid="memory-entry-count"]')) && document.querySelector('[data-testid="memory-entry-count"]').textContent === '0');
  assert.equal(peer(await fixture('state'), 'group_alpha@chatroom').recordCount, recordsBeforeMemoryClear);
  assert.equal((await fixture('globalMemory')).globalNotes, globalNotes);
  await clickText('长期记忆'); await assertPanel('global'); assert.equal(await evaluate(() => document.querySelector('[data-testid="saved-global-notes"] p').textContent), globalNotes);
  check('global notes survive failed save/retry and local memory clearing; clearing the visible local panel leaves chat records and global notes intact');
  return globalNotes;
}

async function verifyImageMemory() {
  const panel = '#wa-memory-panel-images';
  await click('[data-testid="nav-memory"]'); await clickText('图片记忆');
  const samples = await fixture('seedImageMemory');
  const alpha = samples.find(item => item.scope.peerId === 'group_alpha@chatroom'), beta = samples.find(item => item.scope.peerId === 'group_beta@chatroom'), privateImage = samples.find(item => item.scope.chatType === 'private');
  const choose = choice => input(panel + ' [aria-label="选择会话"]', choice);
  const findCard = id => waitFor(id => Array.from(document.querySelectorAll('#wa-memory-panel-images [data-image-memory-id]')).some(el => isVisible(el) && el.dataset.imageMemoryId === id), [id]);
  await choose('group:group_alpha@chatroom'); await clickText('重新读取图片记忆', panel); await findCard(alpha.id);
  await input('[aria-label="搜索图片记忆"]', 'ALPHA_IMAGE_NOTE');
  await waitFor(() => document.querySelectorAll('#wa-memory-panel-images [data-image-memory-id]').length === 1);
  await waitFor(() => document.querySelector('#wa-memory-panel-images .wa-image-open img')?.complete);
  await click(`[data-image-memory-id="${alpha.id}"] .wa-image-open`);
  await waitFor(() => document.querySelector('[role="dialog"][aria-label="图片记忆预览"] .wa-image-preview')?.complete);
  assert((await evaluate(() => document.querySelector('[role="dialog"][aria-label="图片记忆预览"]').textContent)).includes('原图'));
  await screenshot('image-memory-preview-desktop-dark'); await screenshot('image-memory-preview-desktop-light', 'light');
  await clickText('关闭图片预览', '[aria-label="图片记忆预览"]');
  for (const [choice, sample] of [['group:group_beta@chatroom', beta], ['private:wxid_alice', privateImage]]) {
    await choose(choice); await findCard(sample.id);
    assert.equal(await evaluate(id => !!document.querySelector(`#wa-memory-panel-images [data-image-memory-id="${id}"]`), alpha.id), false);
  }
  await choose('group:group_alpha@chatroom'); await findCard(alpha.id);
  await input('[aria-label="图片记忆保留天数"]', '7'); await clickText('保存图片记忆设置', panel);
  await waitFor(async () => (await window.__uiFixture('imageMemory')).settings.retentionDays === 7);
  await input('[aria-label="图片记忆保留天数"]', ''); await clickText('保存图片记忆设置', panel);
  await waitFor(async () => (await window.__uiFixture('imageMemory')).settings.retentionDays === null);
  await input('[aria-label="图片记忆保留天数"]', '0');
  assert(await evaluate(() => Array.from(document.querySelectorAll('#wa-memory-panel-images button')).find(button => button.textContent === '保存图片记忆设置').disabled));
  await input('[aria-label="图片记忆保留天数"]', '');
  await screenshot('image-memory-desktop-dark'); await screenshot('image-memory-desktop-light', 'light');
  window.setContentSize(430, 900); await assertLayout('narrow image memory'); await screenshot('image-memory-narrow-dark'); await screenshot('image-memory-narrow-light', 'light');
  await click(`[data-image-memory-id="${alpha.id}"] .wa-image-open`); await waitFor(() => document.querySelector('.wa-image-preview')?.complete);
  await assertLayout('narrow image preview'); await screenshot('image-memory-preview-narrow-light', 'light');
  await clickText('删除这张图片记忆', '[aria-label="图片记忆预览"]');
  await fixture('failNext', { endpoint: 'memory.images.delete' }); await clickText('确认删除图片记忆', '[aria-label="图片记忆预览"]');
  await waitFor(() => document.querySelector('#wa-memory-panel-images [role="alert"]')?.textContent.includes('模拟保存失败'));
  assert((await fixture('imageMemory')).items.some(item => item.id === alpha.id));
  await clickText('确认删除图片记忆', '[aria-label="图片记忆预览"]');
  await waitFor(() => !document.querySelector('[aria-label="图片记忆预览"]'));
  assert(!(await fixture('imageMemory')).items.some(item => item.id === alpha.id));
  assert((await fixture('imageMemory', { peerId: 'group_beta@chatroom' })).items.some(item => item.id === beta.id));
  await clickText('保存已有图片', panel);
  await waitFor(() => document.querySelector('#wa-memory-panel-images [role="status"]')?.textContent.includes('保存已结束'));
  assert(!(await fixture('imageMemory')).items.some(item => item.id === alpha.id));
  window.setContentSize(1280, 940);
  check('image memory renders real original and thumbnail previews, scopes group/private search, saves or clears retention, fits narrow screens, and preserves a failed deletion until retry without resurrecting it');
}

async function verifyTasks() {
    await click('[data-testid="nav-tasks"]');
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="task-create-form"]')), false);
    await click('[data-testid="task-create-toggle"]');
    const taskAlpha = await evaluate(() => Array.from(document.querySelector('[aria-label="选择会话"]').options).find(option => option.textContent.includes('产品讨论组')).value);
    await input('[aria-label="选择会话"]', taskAlpha);
    await waitFor(() => document.querySelectorAll('[data-testid="task-recipients"] [data-member-id]').length === 4);
    await input('[aria-label="按名称查找提醒对象"]', '李明');
    await waitFor(() => document.querySelectorAll('[data-testid="task-recipients"] [data-member-id]').length === 2);
    assert(await evaluate(() => ['wxid_li_ming_a', 'wxid_li_ming_b'].every(id => document.querySelector('[data-member-id="' + id + '"]').textContent.includes('成员标识：' + id))));
    await input('[aria-label="按名称查找提醒对象"]', '产品'); await click('[data-member-id="wxid_alice"] input');
    await input('[aria-label="按名称查找提醒对象"]', '视觉'); await click('[data-member-id="wxid_bob"] input');
    assert(await evaluate(() => document.querySelector('[data-testid="task-recipients"]').textContent.includes('2 / 20 位')));
    await click('[aria-label="移除提醒对象 Bob·设计同事"]');
    assert(await evaluate(() => document.querySelector('[data-testid="task-recipients"]').textContent.includes('1 / 20 位')));
    const taskBeta = await evaluate(() => Array.from(document.querySelector('[aria-label="选择会话"]').options).find(option => option.textContent.includes('周末出游')).value);
    await input('[aria-label="选择会话"]', taskBeta);
    await waitFor(() => document.querySelector('[data-member-id="wxid_weekend"]'));
    assert.equal(await evaluate(() => document.querySelectorAll('[data-testid="task-recipients"] input:checked').length), 0);
    assert.equal(await evaluate(() => !!document.querySelector('[data-member-id="wxid_alice"]')), false);
    await input('[aria-label="选择会话"]', taskAlpha);
    await waitFor(() => document.querySelectorAll('[data-testid="task-recipients"] [data-member-id]').length === 4);
    await click('[data-member-id="wxid_alice"] input'); await click('[data-member-id="wxid_bob"] input');
    await input('[aria-label="定时任务内容"]', '合成提醒：吃饭；此测试不会启动调度或发送微信。');
    await clickText('保存定时任务'); await waitFor(() => document.querySelectorAll('.wa-task').length === 1);
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="task-create-form"]')), false);
    let task = (await fixture('stats')).tasks[0]; assert.equal(task.peerId, 'group_alpha@chatroom'); assert.equal(task.state, 'pending');
    assert.deepEqual(task.targets, [{ id: 'wxid_alice', name: 'Alice·产品同事' }, { id: 'wxid_bob', name: 'Bob·设计同事' }]);
    assert((await fixture('stats')).memberRequests.every(request => request.accountId === 'wxid_ui_fixture' && ['group_alpha@chatroom', 'group_beta@chatroom'].includes(request.peerId)));
    check('task recipients search by names/remarks, distinguish duplicates, support removal and multi-select, clear on group switch, and persist scoped targets');
    await clickText('暂停', '.wa-task'); await waitFor(async () => (await window.__uiFixture('stats')).tasks[0].state === 'paused');
    await clickText('恢复', '.wa-task'); await waitFor(async () => (await window.__uiFixture('stats')).tasks[0].state === 'pending');
    await assertLayout('desktop tasks'); await screenshot('tasks-desktop-dark'); await screenshot('tasks-desktop-light', 'light');
    await clickText('取消任务', '.wa-task'); await waitFor(async () => (await window.__uiFixture('stats')).tasks[0].state === 'cancelled');
    await waitFor(() => !document.querySelector('.wa-task'));
    check('task form saves durable room-bound schedule; list pause/resume/cancel reflects actual saved states');

    const taskHistory = await fixture('taskHistory');
    await waitFor(() => document.querySelectorAll('.wa-task').length === 3);
    assert.equal(await evaluate(() => !!document.querySelector('.wa-task[data-task-id="ui-history-completed-0"]')), false);
    assert.equal(await evaluate(() => [...document.querySelector('[data-task-id="ui-history-unknown"]').querySelectorAll('button')].some(button => button.textContent === '恢复')), false);
    await screenshot('tasks-current-desktop-dark'); await screenshot('tasks-current-desktop-light', 'light');
    await click('[data-testid="task-tab-history"]');
    await waitFor(() => document.querySelectorAll('.wa-task-history-row').length === 20);
    assert.equal(await evaluate(() => document.querySelectorAll('.wa-task-history-row[data-task-id="ui-history-completed-0"]').length), 1);
    assert.equal(await evaluate(() => !!document.querySelector('.wa-task')), false);
    const completionShown = await evaluate(stamp => document.querySelector('[data-task-id="ui-history-completed-0"] summary time').textContent === new Date(stamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }), taskHistory.completedAt);
    assert(completionShown, 'history must show completion time, not the planned hour');
    await click('[data-task-id="ui-history-completed-0"] summary');
    await waitFor(() => document.querySelector('[data-task-id="ui-history-completed-0"]').open);
    assert((await evaluate(() => document.querySelector('[data-task-id="ui-history-completed-0"]').textContent)).includes('fixture-history-ack-0'));
    await pause(2300); assert.equal(await evaluate(() => document.querySelector('[data-task-id="ui-history-completed-0"]').open), true);
    await click('[data-task-id="ui-history-completed-0"] summary');
    await click('[data-task-id="ui-history-daily"] summary');
    assert.equal(await evaluate(() => document.querySelectorAll('[data-task-id="ui-history-daily"] .wa-task-execution').length), 3);
    await click('[data-task-id="ui-history-daily"] summary');
    assert((await evaluate(() => document.querySelector('[data-task-id="ui-history-late-ack"] summary').textContent)).includes('已有微信确认'));
    await assertLayout('desktop compact task history'); await screenshot('tasks-history-desktop-dark'); await screenshot('tasks-history-desktop-light', 'light');
    await clickText('下一页', '.wa-task-pagination'); await waitFor(() => document.querySelectorAll('.wa-task-history-row').length === 9);
    await input('[aria-label="定时任务筛选"]', 'group:group_beta@chatroom');
    await waitFor(() => document.querySelectorAll('.wa-task-history-row').length === 12);
    assert.equal(await evaluate(() => [...document.querySelectorAll('.wa-task-history-row summary')].some(row => row.textContent.includes('产品讨论组'))), false);
    await input('[aria-label="搜索定时任务"]', '不存在的任务'); await waitFor(() => document.querySelectorAll('.wa-task-history-row').length === 0);
    await input('[aria-label="定时任务筛选"]', 'all'); await input('[aria-label="搜索定时任务"]', '取消后的合成提醒'); await waitFor(() => document.querySelectorAll('.wa-task-history-row').length === 1);
    await input('[aria-label="搜索定时任务"]', ''); await input('[aria-label="定时任务筛选"]', 'all');
    await click('[data-testid="task-tab-current"]'); await click('[data-testid="task-create-toggle"]');
    await input('[aria-label="定时任务内容"]', '布局测试草稿'); await click('[data-testid="task-create-toggle"]'); await click('[data-testid="task-create-toggle"]');
    assert.equal(await value('[aria-label="定时任务内容"]'), '布局测试草稿'); await click('[data-testid="task-create-toggle"]');
    check('completed tasks become one compact history row; real timestamps, late ACKs, recurring executions, pagination, room filtering and form drafts stay intact');
}

async function verifyAdministrators() {
  await click('[data-testid="nav-settings"]'); await click('[data-testid="open-administrators"]');
  await waitFor(() => document.querySelector('[data-admin-id="wxid_alice"]'));
  assert(await evaluate(() => document.body.textContent.includes('直接用文字查询') && document.body.textContent.includes('DSH 任务跑到哪了') && document.body.textContent.includes('保存管理员后，还需要')));
  await input('[aria-label="搜索全局管理员"]', '产品负责人');
  assert.equal(await evaluate(() => document.querySelectorAll('[data-admin-id]').length), 1);
  await click('[data-admin-id="wxid_alice"] input');
  await input('[aria-label="搜索全局管理员"]', 'wxid_bob'); await click('[data-admin-id="wxid_bob"] input');
  await pause(2300); assert(await evaluate(() => document.querySelector('[aria-label="移除管理员 wxid_alice"]') && document.querySelector('[aria-label="移除管理员 wxid_bob"]')));
  await fixture('failNext', { endpoint: 'administrators.configure' }); await clickText('保存全局管理员');
  await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes('模拟保存失败')));
  assert.deepEqual((await fixture('state')).remote.globalAdminIds, []);
  assert(await evaluate(() => !!document.querySelector('[aria-label="移除管理员 wxid_bob"]')));
  await clickText('保存全局管理员'); await stateMatches(s => s.remote.globalAdminIds.length === 2);
  await input('[aria-label="管理员候选来源"]', 'group_alpha@chatroom'); await input('[aria-label="搜索全局管理员"]', '李明');
  await waitFor(() => document.querySelectorAll('[data-admin-id]').length === 2);
  assert(await evaluate(() => [...document.querySelectorAll('[data-admin-id]')].every(el => el.textContent.includes(el.dataset.adminId))));
  await click('[data-admin-id="wxid_li_ming_a"] input'); await clickText('保存全局管理员'); await stateMatches(s => s.remote.globalAdminIds.length === 3);
  await assertLayout('global administrators desktop'); await screenshot('administrators-global-dark'); await screenshot('administrators-global-light', 'light');
  check('global administrator search covers names, remarks and exact IDs, supports multiple selections and disambiguates same-name group members; polling and failed saves preserve drafts');

  await click('[data-testid="nav-authorization"]'); await clickText('设置', '.wa-session-row[data-peer-id="group_alpha@chatroom"]');
  await waitFor(() => document.querySelector('[data-admin-id="wxid_li_ming_b"]'));
  assert(await evaluate(() => document.body.textContent.includes('已选管理员，但此会话的远程查询仍关闭')));
  await input('[aria-label="搜索会话管理员"]', '李明'); await click('[data-admin-id="wxid_li_ming_a"] input'); await click('[data-admin-id="wxid_li_ming_b"] input');
  await click('#wa-remote-enabled'); await clickText('保存会话设置');
  await stateMatches(s => s.conversations.find(p => p.peerId === 'group_alpha@chatroom').config.adminIds.length === 2 && s.conversations.find(p => p.peerId === 'group_alpha@chatroom').config.remoteEnabled);
  assert(await evaluate(() => !document.body.textContent.includes('已选管理员，但此会话的远程查询仍关闭')));
  const saved = await fixture('state'); assert.equal(saved.conversations.find(p => p.peerId === 'group_beta@chatroom').config.remoteEnabled, false);
  assert.deepEqual(saved.conversations.find(p => p.peerId === 'group_beta@chatroom').config.adminIds, []);
  await click('[aria-label="移除管理员 wxid_li_ming_b"]'); await fixture('failNext', { endpoint: 'conversation.configure' }); await clickText('保存会话设置');
  await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes('模拟保存失败')));
  assert.equal((await fixture('state')).conversations.find(p => p.peerId === 'group_alpha@chatroom').config.adminIds.length, 2);
  assert.equal(await evaluate(() => !!document.querySelector('[aria-label="移除管理员 wxid_li_ming_b"]')), false);
  await clickText('保存会话设置'); await stateMatches(s => s.conversations.find(p => p.peerId === 'group_alpha@chatroom').config.adminIds.length === 1);
  await assertLayout('conversation administrators desktop'); await screenshot('administrators-conversation-dark');
  check('conversation administrators and remote enabling save only the selected conversation; removals preserve their failed-save draft and succeed on retry');
  await clickText('返回会话授权'); await clickText('设置', '.wa-session-row[data-peer-id="group_beta@chatroom"]');
  await waitFor(() => document.querySelector('[data-admin-id="wxid_weekend"]'));
  assert.equal(await evaluate(() => !!document.querySelector('[data-admin-id="wxid_li_ming_a"]')), false);
  assert.equal(await evaluate(() => document.querySelector('#wa-remote-enabled').checked), false);
  window.setSize(460, 900); await pause(250); await assertLayout('conversation administrators narrow'); await screenshot('administrators-conversation-narrow'); window.setSize(1280, 900);
  check('switching conversations replaces candidate member scope and selected administrators; narrow screens remain usable');
  await click('[data-testid="nav-settings"]'); await click('[data-testid="open-administrators"]');
  await waitFor(() => document.querySelector('[aria-label="移除管理员 wxid_bob"]')); await click('[aria-label="移除管理员 wxid_bob"]');
  await clickText('保存全局管理员'); await stateMatches(s => !s.remote.globalAdminIds.includes('wxid_bob'));
  check('removing a global administrator persists without altering conversation-specific administrators');
}

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

    if (process.env.WECHAT_UI_TEST_PERSONA_ONLY === '1') {
      const initial = await fixture('state');
      await click('[data-testid="nav-settings"]'); await click('[data-testid="open-persona"]');
      await waitFor(() => document.querySelector('[data-testid="global-persona-editor"]'));
      assert.equal(await evaluate(() => !!document.querySelector('[data-testid="browse-persona-presets"]') || !!document.querySelector('.wa-persona-card')), false);
      await click('details:has(#wa-persona-name) > summary');
      await input('#wa-persona-name', '全局小助'); await input('#wa-persona-aliases', '小助\n助手同学');
      const custom = '全局自定义：日常简短一点，技术问题保留必要细节。';
      await input('#wa-persona-prompt', custom);
      await fixture('failNext', { endpoint: 'persona.save' }); await clickText('保存全局助手设定');
      await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(el => el.textContent.includes('模拟保存失败')));
      assert.equal(await value('#wa-persona-prompt'), custom); assert.deepEqual((await fixture('state')).persona, initial.persona);
      await clickText('保存全局助手设定');
      await stateMatches((state,prompt) => state.persona.name === '全局小助' && state.persona.prompt === prompt,custom);
      const saved = (await fixture('state')).persona;
      check('global custom text, name and wake words save together; failed save preserves the draft');
      await click('[data-testid="restore-default-persona"]');
      const defaults = await value('#wa-persona-prompt');
      assert(defaults.includes('默认助手') && defaults.includes('语气示例'));
      assert.deepEqual((await fixture('state')).persona,saved);
      assert.equal(await value('#wa-persona-name'),'全局小助');
      assert.equal(await value('#wa-persona-aliases'),'小助\n助手同学');
      await assertLayout('single assistant desktop'); await screenshot('global-assistant-desktop-dark'); await screenshot('global-assistant-desktop-light','light');
      window.setContentSize(430,900); await pause(150);
      await assertLayout('single assistant narrow'); await screenshot('global-assistant-narrow-light','light');
      window.setContentSize(1280,940); await pause(150);
      check('default restore stays a draft and keeps wake words; desktop and narrow layouts have no overflow');
      await clickText('保存全局助手设定');
      await stateMatches((state,prompt) => state.persona.prompt === prompt,defaults);
      await click('[data-testid="nav-authorization"]');
      await input('[data-testid="conversation-search"]','GROUP_ALPHA@CHATROOM');
      await waitFor(() => document.querySelector('.wa-session-row[data-peer-id="group_alpha@chatroom"]'));
      await clickText('设置','.wa-session-row[data-peer-id="group_alpha@chatroom"]');
      assert.equal(await evaluate(() => !!document.querySelector('[data-testid="conversation-global-persona"]')),true);
      assert.equal(await evaluate(() => !!document.querySelector('input[name="wa-conversation-persona-mode"]') || !!document.querySelector('#wa-conversation-persona-prompt')),false);
      await click('[data-testid="edit-global-persona"]');
      await waitFor(() => document.querySelector('[data-testid="global-persona-editor"]'));
      assert.equal(await value('#wa-persona-prompt'),defaults);
      const after=await fixture('state');
      assert.deepEqual(after.settings,initial.settings);
      assert.equal(after.conversations.length,initial.conversations.length);
      assert(after.conversations.every(peer=>peer.config.persona===null));
      check('conversation links open the same global editor; authorizations and conversation count remain intact');
      assert.deepEqual(report.errors,[]); report.ok=true; return;
    }
    if (process.env.WECHAT_UI_TEST_MOMENTS_ONLY === '1') {
      await click('[data-testid="nav-moments"]'); await waitFor(() => !!document.querySelector('[data-testid="moments-page"]'));
      await clickText('定时回复', '[role="tablist"]');
      assert.equal((await fixture('state')).moments.settings.enabled, false); check('moments automation defaults disabled');
      await input('[aria-label="抓取间隔（分钟）"]', '15'); await input('[aria-label="每轮最多尝试回复"]', '3'); await clickText('保存定时设置');
      await stateMatches(state => state.moments.settings.intervalMinutes === 15 && state.moments.settings.maxRepliesPerRun === 3 && !state.moments.settings.enabled);
      check('polling interval and attempt cap save through owner RPC'); await assertLayout('moments settings desktop'); await screenshot('moments-settings-desktop-dark');
      await clickText('我的动态', '[role="tablist"]'); await clickText('拉取我的动态'); await waitFor(() => document.querySelector('.wa-wb-list-item')?.textContent.includes('合成朋友圈'));
      await click('.wa-wb-list-item'); await clickText('拉取评论区'); await waitFor(() => document.querySelector('[data-testid="moments-page"]')?.textContent.includes('这个笑话有点冷'));
      check('live own posts and comment relationships render'); await clickText('回复这条评论'); await input('[aria-label="评论回复正文"]', '窗户关好，笑话就暖了。'); await clickText('发送回复');
      await waitFor(() => document.querySelector('[data-testid="moments-page"]')?.textContent.includes('窗户关好，笑话就暖了'));
      await waitFor(() => !document.querySelector('[aria-label="评论回复正文"]') && Array.from(document.querySelectorAll('button')).some(button => button.textContent === '拉取评论' && !button.disabled));
      check('specific reply returns verified text to comments'); await screenshot('moments-comments-desktop-light', 'light');
      await clickText('发朋友圈', '[role="tablist"]'); await input('[aria-label="朋友圈正文"]', '合成界面测试朋友圈，仅本地验证。');
      await clickText('读取微信标签与联系人'); await waitFor(() => !!document.querySelector('[aria-label="屏蔽标签 产品同事"]'));
      await click('[aria-label="屏蔽标签 产品同事"]'); await input('[aria-label="搜索屏蔽联系人"]', 'Alice'); await click('[aria-label="屏蔽联系人 Alice wxid_alice"]');
      await waitFor(() => document.querySelector('[data-testid="moments-audience-summary"]')?.textContent.includes('合并后屏蔽 2 人'));
      check('real label IDs and searchable contacts merge overlapping blocked members');
      await fixture('failNext', { endpoint: 'moments.audience' }); await clickText('刷新微信标签与联系人');
      await waitFor(() => document.querySelector('[data-testid="moments-audience"]')?.textContent.includes('读取失败'));
      assert.equal(await evaluate(() => [...document.querySelectorAll('button')].find(x=>x.textContent === '发布到我的朋友圈').disabled), true);
      assert.equal(await value('[aria-label="朋友圈正文"]'), '合成界面测试朋友圈，仅本地验证。');
      assert.equal(await evaluate(() => document.querySelector('[aria-label="屏蔽标签 产品同事"]').checked), true);
      check('failed audience refresh retains draft and selections and prevents publishing');
      await clickText('刷新微信标签与联系人'); await waitFor(() => !document.querySelector('[data-testid="moments-audience"]')?.textContent.includes('读取失败'));
      window.setContentSize(430, 900); await assertLayout('moments privacy narrow'); await screenshot('moments-privacy-narrow-light', 'light');
      window.setContentSize(1280, 940); await assertLayout('moments privacy desktop'); await screenshot('moments-privacy-desktop-dark');
      await clickText('发布到我的朋友圈');
      await waitFor(() => document.querySelector('.wa-wb-list')?.textContent.includes('合成界面测试朋友圈'));
      const publish = (await fixture('momentWrites')).find(row => row.action === 'publish');
      assert.deepEqual(publish.blockedLabelIds, ['1']); assert.deepEqual(publish.blockedUserIds, ['wxid_alice']);
      check('selected label and user IDs reach publication through owner RPC');
      check('publishing uses one stable UI operation and shows confirmed post'); await clickText('删除这条朋友圈'); await clickText('确认删除');
      await waitFor(() => document.querySelector('.wa-wb-list')?.textContent.includes('已删除')); check('own post deletion requires explicit selection and confirmation');
      await clickText('定时回复', '[role="tablist"]'); window.setContentSize(430, 900); await pause(150); await assertLayout('moments settings narrow');
      await screenshot('moments-settings-narrow-light', 'light'); check('moments menu fits desktop and narrow layouts');
        window.setContentSize(1280, 940); await clickText('自动发布', '[role="tablist"]');
        await waitFor(() => !!document.querySelector('[data-testid="moments-publishing"]'));
        assert.equal((await fixture('state')).moments.publishing.settings.enabled, false); check('AI publishing defaults disabled');
        await clickText('新增发布计划'); await input('[aria-label="发布计划名称"]', '午间小笑话'); await input('[aria-label="发布主题"]', '小笑话\n日常心情');
        await input('[aria-label="发布计划周期"]', 'weekly'); await input('[aria-label="每天发布时间"]', '12:00\n18:30');
        await input('[aria-label="自动发布方式"]', 'review');
        await clickText('刷新微信标签与联系人'); await waitFor(() => !!document.querySelector('[aria-label="屏蔽标签 产品同事"]'));
        await click('[aria-label="屏蔽标签 产品同事"]'); await clickText('保存发布计划');
        await stateMatches(state => state.moments.publishing.plans.length === 1);
        const plan = (await fixture('state')).moments.publishing.plans[0]; assert.deepEqual(plan.settings.themes, ['小笑话', '日常心情']);
        assert.deepEqual(plan.settings.schedule.times, ['12:00','18:30']); assert.equal(plan.settings.schedule.type,'weekly'); assert.equal(plan.settings.reviewRequired,true); assert.deepEqual(plan.settings.blockedLabelIds,['1']);
        assert.equal(plan.settings.enabled,false); check('themes, multiple times, weekly schedule, review and audience save through owner RPC');
        await clickText('编辑计划'); await clickText('生成预览（不发布）');
        await stateMatches(state => state.moments.publishing.runs.some(row => row.state === 'draft'));
        await waitFor(() => !!document.querySelector('[aria-label="自动发布草稿正文"]'));
        assert.equal((await fixture('momentWrites')).filter(row=>row.action === 'publish').length,1); check('AI preview creates a durable draft without posting');
        await input('[aria-label="自动发布草稿正文"]','修改过的 AI 测试草稿。'); await clickText('保存草稿修改');
        await stateMatches(state => state.moments.publishing.runs[0].text === '修改过的 AI 测试草稿。');
        await clickText('发布这份草稿'); await stateMatches(state => state.moments.publishing.runs[0].state === 'published');
        check('edited draft posts only on explicit click and displays verified receipt');
        await clickText('关闭编辑'); await clickText('开启计划');
        await stateMatches(state => state.moments.publishing.plans[0].settings.enabled);
        assert.equal((await fixture('state')).moments.publishing.settings.enabled,false); await clickText('暂停计划');
        await stateMatches(state => !state.moments.publishing.plans[0].settings.enabled); check('plan switches remain independent of the global switch');
        await assertLayout('AI publishing desktop'); await screenshot('moments-publishing-desktop-dark');
        window.setContentSize(430, 900); await assertLayout('AI publishing narrow'); await screenshot('moments-publishing-narrow-light','light');
        await clickText('删除计划'); await clickText('确认删除计划'); await stateMatches(state => state.moments.publishing.plans.length === 0 && state.moments.publishing.runs.length === 1);
        check('deleting a plan preserves published content and history');
      assert.deepEqual(report.errors, []); report.ok = true; return;
    }
    if (process.env.WECHAT_UI_TEST_MEMORY_ONLY === '1') {
      await verifyManualCompression();
      assert.deepEqual(report.errors, [], 'Browser errors must be resolved'); report.ok = true; return;
    }
    if (process.env.WECHAT_UI_TEST_MODEL_ONLY === '1') {
      await click('[data-testid="nav-settings"]'); await click('[data-testid="open-model"]');
      await verifyModelReasoning();
      for (const [size, width, height] of [['desktop', 1280, 940], ['narrow', 430, 900]]) {
        window.setContentSize(width, height);
        await assertLayout(size + ' model reasoning');
        await screenshot('model-reasoning-' + size + '-dark', 'dark', '.wa-model-card');
        await screenshot('model-reasoning-' + size + '-light', 'light', '.wa-model-card');
      }
      assert.deepEqual(report.errors, [], 'Browser errors must be resolved'); report.ok = true; return;
    }
    if (process.env.WECHAT_UI_TEST_NATURAL_ONLY === '1') {
      await click('[data-testid="nav-authorization"]');
      await clickText('设置', '.wa-session-row[data-peer-id="group_alpha@chatroom"]');
      await click('input[name="wa-group-mode"][value="natural"]');
      await click('[data-testid="natural-chat-settings"] summary');
      await clickText('保存会话设置');
      await stateMatches(state => state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config.mode === 'natural');
      await waitFor(() => !!document.querySelector('[data-testid="natural-chat-status"]'));
      await captureNaturalChat();
      check('natural-chat primary controls, followup controls and real status fit desktop/narrow and light/dark screenshots');
      assert.deepEqual(report.errors, [], 'Browser errors must be resolved'); report.ok = true; return;
    }
    if (process.env.WECHAT_UI_TEST_VISUALS_ONLY === '1') {
      await verifyVisualDesign();
      assert.deepEqual(report.errors, [], 'Browser errors must be resolved'); report.ok = true; return;
    }
    if (process.env.WECHAT_UI_TEST_TASKS_ONLY === '1') {
      await verifyTasks();
      await evaluate(() => document.querySelector('[data-testid="task-tab-current"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      await waitFor(() => document.querySelector('[data-testid="task-tab-history"]').getAttribute('aria-selected') === 'true');
      await evaluate(() => document.querySelector('[data-testid="task-tab-history"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
      await waitFor(() => document.querySelector('[data-testid="task-tab-current"]').getAttribute('aria-selected') === 'true');
      window.setContentSize(430, 900);
      await assertLayout('narrow current tasks'); await screenshot('tasks-current-narrow-dark'); await screenshot('tasks-current-narrow-light', 'light');
      await click('[data-testid="task-tab-history"]'); await waitFor(() => document.querySelectorAll('.wa-task-history-row').length === 20);
      await assertLayout('narrow history'); await screenshot('tasks-history-narrow-dark'); await screenshot('tasks-history-narrow-light', 'light');
      await click('[data-task-id="ui-history-completed-0"] summary');
      await assertLayout('narrow expanded history'); await screenshot('tasks-history-expanded-narrow-dark');
      await fixture('switchAccount');
      await waitFor(() => document.querySelector('[data-testid="task-tab-current"]')?.textContent.includes('0') && !document.querySelector('.wa-task'));
      await click('[data-testid="task-tab-history"]'); await waitFor(() => !document.querySelector('.wa-task-history-row'));
      check('current tasks and compact history fit narrow/light/dark layouts; account switch clears the previous task history');
      assert.deepEqual(report.errors, [], 'Browser errors must be resolved'); report.ok = true; return;
    }
    await assertLayout('desktop overview');
    if (process.env.WECHAT_UI_TEST_ADMIN_ONLY === '1') {
      await verifyAdministrators(); assert.deepEqual(report.errors, []); report.ok = true; return;
    }
    if (process.env.WECHAT_UI_TEST_WORK_ONLY === '1' || process.env.WECHAT_UI_TEST_IMAGE_ONLY === '1') {
      await click('[data-testid="nav-settings"]'); await click('[data-testid="open-image-generation"]');
      if (!await evaluate(() => !!document.querySelector('#wa-image-endpoint'))) await click('[data-testid="image-provider-add"]');
      await input('#wa-image-provider-name', '测试接口 A');
      await input('#wa-image-endpoint', 'https://image-fixture.invalid/v1'); await input('#wa-image-models', 'owner-image-model\nowner-image-alt');
      await input('#wa-image-model', 'owner-image-model'); const firstImageProvider = await value('#wa-image-provider');
      await click('[aria-label="启用生图 API"]'); await clickText('保存生图设置');
      await stateMatches(state => state.imageGeneration.enabled && state.imageGeneration.model === 'owner-image-model' && state.imageGeneration.endpoint.endsWith('/v1/images/generations'));
      await input('#wa-image-key', 'synthetic-image-key'); await clickText('保存生图密钥');
      await stateMatches(state => state.imageGeneration.credentialConfigured);
      assert.equal(await value('#wa-image-key'), ''); assert.equal(await evaluate(() => document.querySelector('#wa-image-key').type), 'password');
      await input('#wa-image-key', 'unsaved-first-interface-key'); await click('[data-testid="image-provider-add"]');
      assert.equal(await value('#wa-image-key'), '');
      await input('#wa-image-provider-name', '测试接口 B'); await input('#wa-image-endpoint', 'https://second-image-fixture.invalid/v1');
      await input('#wa-image-models', 'owner-image-model\nother-image-model'); await input('#wa-image-model', 'other-image-model');
      const secondImageProvider = await value('#wa-image-provider'); await clickText('保存生图设置');
      await stateMatches((state, first, second) => state.imageGeneration.providers.find(item => item.id === first)?.credentialConfigured && !state.imageGeneration.providers.find(item => item.id === second)?.credentialConfigured, firstImageProvider, secondImageProvider);
      await input('#wa-image-key', 'synthetic-second-image-key'); await clickText('保存生图密钥');
      await stateMatches(state => state.imageGeneration.providers.length === 2 && state.imageGeneration.providers.every(item => item.credentialConfigured && item.models.length === 2));
      await input('#wa-image-default-provider', secondImageProvider); await clickText('保存生图设置');
      await stateMatches((state, id) => state.imageGeneration.defaultProviderId === id && state.imageGeneration.model === 'other-image-model', secondImageProvider);
      check('two interfaces independently save keys and model lists; choosing the default interface updates its actual default model');
      await input('#wa-image-provider', firstImageProvider); assert.equal(await value('#wa-image-model'), 'owner-image-model'); assert.equal(await value('#wa-image-key'), '');
      await input('#wa-image-models', 'owner-image-model\nunsaved-image-draft'); await pause(2300); assert.equal(await value('#wa-image-models'), 'owner-image-model\nunsaved-image-draft');
      await input('#wa-image-provider', secondImageProvider); await input('#wa-image-provider', firstImageProvider);
      assert.equal(await value('#wa-image-models'), 'owner-image-model\nunsaved-image-draft'); await clickText('取消更改');
      assert.equal(await value('#wa-image-provider'), secondImageProvider); assert.equal(await value('#wa-image-model'), 'other-image-model');
      await click('[data-testid="image-provider-remove"]'); await clickText('取消更改');
      assert.equal(await evaluate(() => document.querySelector('#wa-image-provider').options.length), 2);
      await input('#wa-image-endpoint', 'https://changed-image-fixture.invalid/v1'); await clickText('保存生图设置');
      await stateMatches((state, id) => !state.imageGeneration.providers.find(item => item.id === id)?.credentialConfigured && state.imageGeneration.providers.some(item => item.id !== id && item.credentialConfigured), secondImageProvider);
      await input('#wa-image-endpoint', 'https://second-image-fixture.invalid/v1'); await clickText('保存生图设置');
      await stateMatches(state => state.imageGeneration.providers.every(item => item.credentialConfigured));
      check('switching interfaces clears the key input, drafts survive polling and switching, removal can be cancelled, and changed endpoints do not reuse old keys');
      await assertLayout('image API settings desktop'); await screenshot('image-api-desktop-dark');
      window.setContentSize(430, 900); await pause(150); await assertLayout('image API settings narrow'); await screenshot('image-api-narrow-dark');
      window.setContentSize(1280, 940); await pause(150);
      check('compatible image API settings and separate masked credentials save via owner RPC without losing an unsaved draft');
      if (process.env.WECHAT_UI_TEST_IMAGE_ONLY === '1') { assert.deepEqual(report.errors, []); report.ok = true; return; }
      await click('[data-testid="nav-settings"]'); await click('[data-testid="open-storage"]');
      await click('[data-testid="storage-derived-paths"] summary');
      const workStorage = (await fixture('state')).storage;
      assert.equal(await evaluate(() => document.querySelector('[data-storage-path="agentWorkspacePath"]').textContent), path.join(workStorage.workspacePath, '微信agent'));
      check('storage settings show the named internal workspace beneath the unchanged global work root');
      await click('[data-testid="nav-authorization"]'); await clickText('设置', '.wa-session-row[data-peer-id="group_alpha@chatroom"]');
      await input('#wa-execution-mode', 'work'); await clickText('保存会话设置');
      await stateMatches(state => state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config.executionMode === 'work');
      assert(await evaluate(() => { const text = document.querySelector('.wa-workspace').textContent; return text.includes('工作模式只对已授权管理员生效') && text.includes('其他成员继续聊天') && text.includes('模型先根据当前消息和工作上下文判断') && text.includes('实际工作只读取工作上下文，聊天才读取聊天记录与人设') && text.includes('已有任务不强制后续消息工作') && text.includes('独立会话按容量并行处理') && text.includes('DSH 工作会话按实际任务目录留档') && text.includes('完成后回传文字、文件和图片') && text.includes('管理员可以查询和切换模式') && text.includes('/mode work、/mode chat、/mode status') && !document.querySelector('#wa-work-senders'); }));
      check('work settings explain model routing, isolated work context and other members nickname chat');
      check('work mode saves through real owner RPC');
      await fixture('seedWork'); await click('[data-testid="nav-work"]'); await waitFor(() => document.querySelector('#wa-work-job')?.options.length === 2);
      assert.equal(await value('#wa-work-concurrency'), '2');
      await input('#wa-work-concurrency', '3'); await clickText('保存');
      await waitFor(() => document.querySelector('#wa-work-concurrency')?.value === '3' && Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '保存')?.disabled);
      await click('[data-testid="nav-settings"]'); await click('[data-testid="nav-work"]');
      await waitFor(() => document.querySelector('#wa-work-concurrency')?.value === '3');
      check('owner can change parallel capacity and the work page retains it after navigation');
      await input('#wa-work-job', 'aaaaaaaaaaaa');
      assert(await evaluate(() => document.querySelector('.wa-workspace details')?.open === false));
      await screenshot('work-result-collapsed-dark');
      await click('.wa-workspace details > summary');
      assert(await evaluate(() => document.querySelector('.wa-workspace details')?.open === true));
      check('work results keep the full operation record collapsed until the owner opens it');
      assert(await evaluate(() => { const text = document.querySelector('.wa-workspace').textContent; return text.includes('执行命令 · 完成') && text.includes('回传结果不明') && text.includes('退出码：0') && text.includes('平台报告部分保护') && text.includes('请求 VS Code 连接 · 请求已提交') && text.includes('SSH 认证与远端探测：已通过') && text.includes('检查 Remote - SSH 扩展：已通过') && text.includes('尚未确认编辑器连接就绪'); }));
      assert(await evaluate(() => { const text = document.querySelector('.wa-workspace').textContent; return text.includes('执行远端命令 · 完成') && text.includes('scut2') && text.includes('八卡实验 reward=1.25') && text.includes('查询实际状态 · 完成') && text.includes('实际 DSH 状态：合成任务正在执行') && text.includes('输出已截短'); }));
      check('remote command details show the alias, actual metrics, status facts and truncation notice');
      assert(await evaluate(() => { const text = document.querySelector('[data-testid="work-artifacts"]').textContent; return text.includes('report.pdf') && text.includes('文件附件') && text.includes('微信已确认') && text.includes('9007199254740997') && text.includes('picture.png') && text.includes('回传结果不明') && text.includes('data.xlsx') && text.includes('未发送'); }));
      check('DSH files and images show individual confirmed, unknown and unattempted delivery states');
      assert(await evaluate(() => { const text = document.querySelector('[data-testid="work-image-archives"]').textContent; return text.includes('微信agent/generated-images/aaaaaaaaaaaa/picture.png') && text.includes('已保存') && text.includes('unsaved.png') && text.includes('测试图片保存失败，原任务文件保留'); }));
      check('work image archives display the real main-directory path and separate saved and failed states');
      await assertLayout('work final desktop'); await screenshot('work-final-desktop-dark'); await screenshot('work-final-desktop-light', 'light');
      window.setContentSize(430, 900); await pause(150); await assertLayout('work final narrow'); await screenshot('work-final-narrow-dark');
      check('final work details show readable operations and distinct delivery with no layout overflow');
      window.setContentSize(1280, 940); await pause(150); await input('#wa-work-job', 'bbbbbbbbbbbb'); await clickText('取消任务');
      await waitFor(() => document.querySelector('#wa-work-job')?.selectedOptions[0]?.textContent.includes('已取消'));
      check('work cancellation persists and refreshes its true state');
      assert.deepEqual(report.errors, []); report.ok = true; return;
    }
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
    await click('[data-testid="open-identity"]');
    await waitFor(() => document.querySelector('#wa-identity-markdown') && !document.querySelector('#wa-identity-markdown').disabled);
    const originalIdentity = await fixture('identity');
    assert.equal(await value('#wa-identity-markdown'), originalIdentity.markdown);
    assert.equal(await evaluate(() => document.querySelector('[data-testid="agent-identity-path"]').textContent), originalIdentity.path);
    assert(await evaluate(() => document.querySelector('[data-testid="agent-identity-editor"]').textContent.includes('先应用全局身份，再应用默认助手的表达偏好')));
    const identityDraft = originalIdentity.markdown + '\n## 界面验证规则\n认真理解当前会话，先回答正在讨论的问题。\n';
    await click('.wa-identity-file > summary');
    await input('#wa-identity-markdown', identityDraft);
    await pause(2300); assert.equal(await value('#wa-identity-markdown'), identityDraft);
    assert(await evaluate(() => Array.from(document.querySelector('[data-testid="agent-identity-editor"]').querySelectorAll('button')).find(button => button.textContent.trim() === '重新读取文件').disabled));
    await fixture('failNext', { endpoint: 'identity.save' }); await clickText('保存全局身份');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(el => el.textContent.includes('模拟保存失败')));
    assert.equal(await value('#wa-identity-markdown'), identityDraft); assert.equal((await fixture('identity')).markdown, originalIdentity.markdown);
    assert.deepEqual((await fixture('stats')).identityRequests.at(-1), { markdown: identityDraft, revision: originalIdentity.revision });
    await clickText('保存全局身份');
    await waitFor(async expected => (await window.__uiFixture('identity')).markdown === expected && !document.querySelector('#wa-identity-markdown')?.disabled, [identityDraft]);
    const savedIdentity = await fixture('identity'), conflictingDraft = identityDraft + '\n待保存的页面草稿。\n', externalIdentity = identityDraft + '\n外部编辑器已经保存的修改。\n';
    await input('#wa-identity-markdown', conflictingDraft); await fixture('editIdentityExternally', { markdown: externalIdentity });
    await pause(2300); assert.equal(await value('#wa-identity-markdown'), conflictingDraft);
    await clickText('保存全局身份');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(el => el.textContent.includes('全局身份文件已被修改')));
    assert.equal(await value('#wa-identity-markdown'), conflictingDraft); assert.equal((await fixture('identity')).markdown, externalIdentity);
    assert.equal((await fixture('stats')).identityRequests.at(-1).revision, savedIdentity.revision);
    await clickText('取消更改', '[data-testid="agent-identity-editor"]'); await clickText('重新读取文件');
    await waitFor(expected => document.querySelector('#wa-identity-markdown')?.value === expected && !document.querySelector('#wa-identity-markdown').disabled, [externalIdentity]);
    const expectedIdentityMarkdown = externalIdentity + '\n已核对外部版本后继续编辑。\n';
    await input('#wa-identity-markdown', expectedIdentityMarkdown); await clickText('保存全局身份');
    await waitFor(async expected => (await window.__uiFixture('identity')).markdown === expected && !document.querySelector('#wa-identity-markdown')?.disabled, [expectedIdentityMarkdown]);
    await assertLayout('desktop global identity'); await screenshot('identity-desktop-dark'); await screenshot('identity-desktop-light', 'light');
    check('global identity has an independent Markdown editor; polling and failed saves preserve drafts; external edits reject stale revisions and explicit reread enables a safe retry');
    await clickText('返回设置');
    await click('[data-testid="open-model"]');
    await waitFor(() => document.querySelector('#wa-model'));
    assert.equal(await evaluate(() => !!document.querySelector('#wa-persona-name')), false);
    await click('[data-testid="nav-settings"]'); await click('[data-testid="open-persona"]');
    const originalPersona = (await fixture('state')).persona;
    const customPrompt = '你是小胖，喜欢有依据的讨论，性格温和、有一点幽默。用自然短句接话，不机械复述。';
    await input('#wa-persona-prompt', customPrompt);
    await click('details.wa-subsection summary');
    await input('#wa-persona-name', '小胖'); await input('#wa-persona-aliases', '胖胖\n小胖同学');
    await pause(2300); assert.equal(await value('#wa-persona-prompt'), customPrompt);
    assert.equal(await evaluate(() => !!document.querySelector('#wa-persona-background')), false);

    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="global-persona-editor"]')), true);
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="browse-persona-presets"]') || !!document.querySelector('.wa-persona-card')), false);
    await assertLayout('desktop global assistant');
    await click('[data-testid="restore-default-persona"]');
    const loadedPrompt = await value('#wa-persona-prompt');
    assert(loadedPrompt.includes('默认助手') && loadedPrompt.includes('语气示例'));
    assert.deepEqual((await fixture('state')).persona, originalPersona, 'restoring default only changes the draft');
    assert.equal(await value('#wa-persona-name'), '小胖');
    assert.equal(await value('#wa-persona-aliases'), '胖胖\n小胖同学');
    await pause(2300); assert.equal(await value('#wa-persona-prompt'), loadedPrompt);
    const expectedPrompt = loadedPrompt + '\n全局偏好：技术问题保留必要细节。';
    await input('#wa-persona-prompt', expectedPrompt);
    await fixture('failNext', { endpoint: 'persona.save' }); await clickText('保存全局助手设定');
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await value('#wa-persona-prompt'), expectedPrompt);
    assert.deepEqual((await fixture('state')).persona, originalPersona);
    await clickText('保存全局助手设定');
    await stateMatches((state, prompt) => state.persona.name === '小胖' && state.persona.prompt === prompt, expectedPrompt);
    await screenshot('persona-desktop-dark'); await screenshot('persona-desktop-light', 'light');
    check('one global assistant editor preserves name and wake words; default restore is draft-only; failed saves retain complete custom text');

    await click('[data-testid="nav-settings"]'); await click('[data-testid="open-model"]');
    await verifyModelReasoning();
    assert.equal(await value('#wa-max-tokens'), '', 'new configuration must show automatic model output');
    assert.equal(await evaluate(() => document.querySelector('#wa-max-tokens').hasAttribute('max')), false);
    await input('#wa-max-tokens', '131072'); await clickText('保存生成参数');
    await stateMatches(s => s.modelConfig.maxTokens === 131072);
    await input('#wa-max-tokens', ''); await clickText('保存生成参数');
    await stateMatches(s => s.modelConfig.maxTokens === null);
    await input('#wa-max-tokens', '0');
    assert(await evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '保存生成参数').disabled));
    check('automatic output saves as null; 131072 saves unchanged; no fixed HTML upper bound; zero is rejected');
    await input('#wa-max-tokens', '2048'); await input('#wa-temperature', '0.7');
    await clickText('保存生成参数');
    await stateMatches(s => s.modelConfig.maxTokens === 2048 && s.modelConfig.temperature === 0.7);
    await click('[data-testid="model-advanced"] summary');
    await click('[aria-label="启用图像理解"]'); await click('[aria-label="启用联网搜索"]'); await clickText('保存生成参数');
    await stateMatches(state => state.modelConfig.vision === false && state.modelConfig.webSearch === true);
    await click('[aria-label="启用图像理解"]'); await clickText('保存生成参数');
    await stateMatches(state => state.modelConfig.vision === true && state.modelConfig.webSearch === true);
    check('model advanced settings persist real vision and web search switches');
    assert.equal(await value('#wa-search-provider'), 'tavily');
    await input('#wa-tavily-url', 'https://search.fixture.invalid/api/tavily');
    await fixture('failNext', { endpoint: 'model.configure' }); await clickText('保存生成参数');
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await value('#wa-tavily-url'), 'https://search.fixture.invalid/api/tavily');
    await clickText('保存生成参数');
    await stateMatches(state => state.modelConfig.searchProvider === 'tavily' && state.modelConfig.tavilyBaseURL === 'https://search.fixture.invalid/api/tavily');
    await input('#wa-search-provider', 'dsh'); await clickText('保存生成参数');
    await stateMatches(state => state.modelConfig.searchProvider === 'dsh');
    await input('#wa-search-provider', 'tavily'); await clickText('保存生成参数');
    await fixture('searchFailure'); await waitFor(() => document.querySelector('[data-testid="search-status"]')?.textContent.includes('HTTP 401'));
    check('search provider selection defaults to Tavily, preserves failed drafts and endpoint, and displays the actual error reason');
    await click('[data-testid="search-credentials"] summary');
    await input('#wa-search-key-tavily', 'fixture-tavily-key');
    await fixture('failNext', { endpoint: 'search.credentials' }); await clickText('保存Tavily密钥');
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await value('#wa-search-key-tavily'), 'fixture-tavily-key');
    await clickText('保存Tavily密钥');
    await waitFor(() => document.querySelector('#wa-search-key-tavily')?.value === '');
    await stateMatches(state => state.search.credentials.tavily === true);
    await input('#wa-search-key-dsh', 'fixture-deepseek-key'); await clickText('保存DeepSeek 原生密钥');
    await waitFor(() => document.querySelector('#wa-search-key-dsh')?.value === '');
    await stateMatches(state => state.search.credentials.dsh === true && state.search.credentials.tavily === true);
    assert.equal(await evaluate(() => [...document.querySelectorAll('[data-testid="search-credentials"] input')].every(input => input.type === 'password' && !input.value)), true);
    await click('[data-testid="search-credentials"] summary');
    check('both search keys save through owner RPC, failed saves preserve drafts, and successful saves clear password fields');
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

    const globalPersonaBeforeRoom = (await fixture('state')).persona;
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="conversation-global-persona"]')), true);
    assert.equal(await evaluate(() => !!document.querySelector('input[name="wa-conversation-persona-mode"]') || !!document.querySelector('#wa-conversation-persona-prompt')), false);
    await click('[data-testid="edit-global-persona"]');
    await waitFor(() => document.querySelector('[data-testid="global-persona-editor"]'));
    assert.equal(await value('#wa-persona-prompt'), globalPersonaBeforeRoom.prompt);
    await clickText('返回会话设置');
    await waitFor(() => document.querySelector('#wa-memory-mode'));
    await input('#wa-memory-mode', 'on-demand');
    await fixture('failNext', { endpoint: 'conversation.configure' }); await clickText('保存会话设置');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(el => el.textContent.includes('模拟保存失败')));
    await pause(2300); assert.equal(await value('#wa-memory-mode'), 'on-demand');
    assert.equal(peer(await fixture('state'), 'group_alpha@chatroom').config.persona, null);
    await clickText('保存会话设置');
    await stateMatches(state => { const config = state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config; return config.persona === null && config.memoryMode === 'on-demand'; });
    assert.equal(peer(await fixture('state'), 'group_beta@chatroom').config.persona, null);
    assert.equal(peer(await fixture('state'), 'wxid_alice').config.persona, null);
    assert.equal(peer(await fixture('state'), 'group_beta@chatroom').config.memoryMode, 'always');
    assert.deepEqual((await fixture('state')).persona, globalPersonaBeforeRoom);
    check('conversation settings link to the same global assistant and preserve independent memory settings and failed-save drafts');
    assert.equal(await value('#wa-execution-mode'), 'chat');
    const previousWorkSenderIds = peer(await fixture('state'), 'group_alpha@chatroom').config.workSenderIds;
    await input('#wa-execution-mode', 'work');
    await fixture('failNext', { endpoint: 'conversation.configure' }); await clickText('保存会话设置');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(el => el.textContent.includes('模拟保存失败')));
    assert.equal(await value('#wa-execution-mode'), 'work'); assert.equal(await evaluate(() => !!document.querySelector('#wa-work-senders')), false);
    assert.equal(peer(await fixture('state'), 'group_alpha@chatroom').config.executionMode, 'chat');
    await clickText('保存会话设置');
    await stateMatches((state, ids) => { const config = state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config; return config.executionMode === 'work' && JSON.stringify(config.workSenderIds) === JSON.stringify(ids); }, previousWorkSenderIds);
    await screenshot('work-settings-desktop-dark'); await screenshot('work-settings-desktop-light', 'light');
    check('administrator work mode preserves existing settings and failed saves retain the draft');
    await fixture('seedWork'); await click('[data-testid="nav-work"]');
    await waitFor(() => document.querySelector('#wa-work-job')?.options.length === 2);
    await input('#wa-work-job', 'aaaaaaaaaaaa');
    assert(await evaluate(() => { const text = document.querySelector('.wa-workspace').textContent; return text.includes('本轮执行已结束') && text.includes('回传结果不明') && text.includes('退出码：0') && text.includes('平台报告部分保护'); }));
    await assertLayout('desktop work task'); await screenshot('work-result-desktop-dark'); await screenshot('work-result-desktop-light', 'light');
    window.setContentSize(430, 900); await pause(150); await assertLayout('narrow work task'); await screenshot('work-result-narrow-dark');
    window.setContentSize(1280, 940); await pause(150);
    await input('#wa-work-job', 'bbbbbbbbbbbb'); await clickText('取消任务');
    await waitFor(() => document.querySelector('#wa-work-job')?.selectedOptions[0]?.textContent.includes('已取消'));
    check('work task UI distinguishes execution and delivery, shows real exit and sandbox facts, and cancels through owner RPC');
    await click('[data-testid="nav-authorization"]'); await clickText('设置', '.wa-session-row[data-peer-id="group_alpha@chatroom"]');
    await input('#wa-execution-mode', 'chat'); await clickText('保存会话设置');
    await stateMatches(state => state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config.executionMode === 'chat');
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
    assert.equal(await evaluate(() => document.querySelector('#wa-memory-window').hasAttribute('max')), false);
    await input('#wa-memory-window', '1000000'); await clickText('保存会话设置');
    await stateMatches(state => state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config.memoryWindowChars === 1000000);
    await input('#wa-memory-window', '24000'); await clickText('保存会话设置');
    await stateMatches(state => { const config = state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config; return config.intervalMode === 'random' && config.minMessages === 1 && config.maxMessages === 100 && config.memoryWindowChars === 24000; });
    assert(await evaluate(() => document.querySelector('[aria-label="群聊回复模式"]').textContent.includes('立即回应')));
    check('progressive mode explanation, 1–100 random/fixed interval and per-room memory window are usable');
    await click('input[name="wa-group-mode"][value="natural"]');
    await waitFor(() => !!document.querySelector('[data-testid="natural-chat-settings"]'));
    assert.equal(await value('#wa-natural-temperament'), 'balanced');
    assert.equal(await value('[aria-label="自然陪聊最少分钟数"]'), '30');
    assert.equal(await value('[aria-label="自然陪聊最多分钟数"]'), '60');
    assert.equal(await evaluate(() => document.querySelector('[aria-label="自然陪聊智能跳过"]').checked), true);
    assert.equal(await value('#wa-natural-start'), '09:00'); assert.equal(await value('#wa-natural-end'), '23:00');
    await input('#wa-natural-temperament', 'lively'); await input('#wa-natural-interval', 'fixed');
    await input('[aria-label="自然陪聊固定分钟数"]', '0');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(element => element.textContent.includes('主动间隔应为')));
    assert.equal(await evaluate(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '保存会话设置').disabled), true);
    await input('[aria-label="自然陪聊固定分钟数"]', '17');
    await click('[data-testid="natural-chat-settings"] summary');
    assert.equal(await value('#wa-natural-followup'), '120');
    await input('#wa-natural-followup', '90'); await input('#wa-natural-unanswered', '3'); await input('#wa-natural-gap', '4');
    await fixture('failNext', { endpoint: 'conversation.configure' }); await clickText('保存会话设置');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(element => element.textContent.includes('模拟保存失败')));
    assert.equal(peer(await fixture('state'), 'group_alpha@chatroom').config.mode, 'participate');
    assert.equal(await value('[aria-label="自然陪聊固定分钟数"]'), '17');
    await clickText('保存会话设置');
    await stateMatches(state => { const config = state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config;
      return config.mode === 'natural' && config.natural.temperament === 'lively' && config.natural.fixedMinutes === 17 &&
        config.natural.followupSeconds === 90 && config.natural.maxUnanswered === 3 && config.natural.minGapMinutes === 4 && config.minMessages === 1 && config.maxMessages === 100; });
    await waitFor(() => !!document.querySelector('[data-testid="natural-chat-status"]'));
    assert.equal(peer(await fixture('state'), 'group_beta@chatroom').config.mode, 'default');
    await captureNaturalChat();
    check('natural-chat fourth mode preserves quantity settings, validates minutes, retains failed-save drafts and saves temperament, followup, response limit and hours per room');
    await click('input[name="wa-group-mode"][value="participate"]'); await clickText('保存会话设置');
    await stateMatches(state => state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').config.mode === 'participate');
    await click('details.wa-subsection summary');
    assert.equal(await evaluate(() => !!document.querySelector('#wa-conversation-path')), false);
    let current = await fixture('state');
    assert.equal(peer(current, 'group_alpha@chatroom').config.recordsPath, paths.conversationPath, 'legacy path stays compatible when saving other conversation settings');
    assert.equal(await evaluate(() => document.querySelector('details.wa-subsection .wa-path-value').textContent), peer(current, 'group_alpha@chatroom').recordsPath);
    assert.equal(peer(current, 'group_alpha@chatroom').recordCount, 63);
    assert(fs.existsSync(peer(current, 'group_alpha@chatroom').recordsPath));
    check('per-group modes and memory settings save independently; record location is read-only while legacy paths and records remain intact');

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
    const flagged = await fixture('flagRecordStyle', { recordKey: latest.keys.at(-1) });
    await click('.wa-record summary');
    await waitFor(() => document.querySelector('.wa-record[open] [data-testid="reply-style-review"]')?.textContent.includes('表达待优化'));
    assert.equal(await evaluate(() => document.querySelector('.wa-record[open] .wa-record-reply').textContent), flagged.reply);
    assert(await evaluate(() => document.querySelector('.wa-record[open]').textContent.includes('微信服务端已确认 1 条消息')));
    assert(await evaluate(() => document.querySelector('.wa-record[open] [data-testid="reply-style-review"]').textContent.includes('此标记不影响发送')));
    await screenshot('records-style-review-light', 'light');
    check('a pending style review remains a local note beside the original reply and true WeChat acknowledgement');
    await fixture('recordMemoryContext', { recordKey: flagged.key, mode: 'always' });
    await waitFor(() => document.querySelector('.wa-record[open] [data-testid="record-memory-context"]')?.textContent.includes('预载旧记忆 128 字'));
    assert(await evaluate(() => document.querySelector('.wa-record[open] [data-testid="record-memory-context"]').textContent.includes('关联线索：喝茶、偏好')));
    assert(await evaluate(() => document.querySelector('.wa-record[open] [data-testid="record-memory-context"]').textContent.includes('近期对话 4 条')));
    await screenshot('records-memory-automatic-light', 'light');
    await fixture('recordMemoryContext', { recordKey: flagged.key, mode: 'on-demand' });
    await waitFor(() => document.querySelector('.wa-record[open] [data-testid="record-memory-context"]')?.textContent.includes('预载旧记忆 0 字'));
    assert(await evaluate(() => document.querySelector('.wa-record[open] [data-testid="record-memory-context"]').textContent.includes('不代表已经调用查询')));
    assert.equal(await evaluate(() => document.querySelector('.wa-record[open] .wa-record-reply').textContent), flagged.reply);
    assert(await evaluate(() => document.querySelector('.wa-record[open]').textContent.includes('微信服务端已确认 1 条消息')));
    await screenshot('records-memory-on-demand-dark', 'dark');
    check('persisted memory context reports recent messages and bounded references, distinguishes preload from on-demand lookup, and preserves reply and acknowledgement');
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
    const beforeMigration = await fixture('state'), beforeMigrationStats = await fixture('stats');
    assert.equal(await value('#wa-base-path'), paths.bootstrap);
    assert.equal(await evaluate(() => document.querySelectorAll('.wa-content-narrow form input').length), 1);
    assert.equal(await evaluate(() => !!document.querySelector('#wa-workspace-path, #wa-records-path')), false);
    assert.equal(await evaluate(() => document.querySelector('[data-testid="storage-derived-paths"]').open), false);
    await click('[data-testid="storage-derived-paths"] summary');
    const directoryKeys = ['workspacePath', 'recordsPath', 'memoryPath', 'assetsPath', 'tasksPath', 'loginPath', 'cachePath'];
    for (const key of directoryKeys) assert.equal(await evaluate(key => document.querySelector('[data-storage-path="' + key + '"]').textContent, key), beforeMigration.storage[key]);
    assert.equal(await evaluate(() => document.querySelectorAll('[data-testid="storage-derived-paths"] input').length), 0);
    assert(beforeMigration.storage.legacyPaths.includes(paths.conversationPath));
    await input('#wa-base-path', paths.basePath);
    await fixture('failNext', { endpoint: 'storage.save' }); await clickText('保存目录并应用');
    await waitFor(() => Array.from(document.querySelectorAll('[role="alert"]')).some(el => el.textContent.includes('模拟保存失败')));
    await pause(2300); assert.equal(await value('#wa-base-path'), paths.basePath);
    assert.equal((await fixture('state')).storage.basePath, paths.bootstrap);
    assert.equal((await fixture('stats')).migrations.length, 0);
    assert.deepEqual((await fixture('stats')).storageRequests.at(-1), { storage: { basePath: paths.basePath } });
    await clickText('保存目录并应用');
    await stateMatches((state, target) => state.storage.basePath === target && !state.storage.relocating, paths.basePath);
    current = await fixture('state');
    assert.equal(await value('#wa-base-path'), paths.basePath);
    assert.deepEqual(current.storage.legacyPaths, []);
    for (const key of directoryKeys) {
      assert(current.storage[key].startsWith(paths.basePath + path.sep), key + ' must derive from the global directory');
      assert.equal(fs.readFileSync(path.join(current.storage[key], 'ui-preserved.txt'), 'utf8'), beforeMigrationStats.preservedFiles[key].content);
      assert.equal(fs.readFileSync(beforeMigrationStats.preservedFiles[key].file, 'utf8'), beforeMigrationStats.preservedFiles[key].content, 'the old directory remains available');
    }
    assert.equal(peer(current, 'group_alpha@chatroom').config.recordsPath, '');
    assert.deepEqual(peer(current, 'group_alpha@chatroom').config.persona, peer(beforeMigration, 'group_alpha@chatroom').config.persona);
    assert.equal(peer(current, 'group_alpha@chatroom').config.memoryMode, 'on-demand');
    assert.deepEqual(current.persona, globalPersonaBeforeRoom);
    assert.equal(peer(current, 'group_alpha@chatroom').recordCount, 67);
    assert.equal(peer(current, 'group_beta@chatroom').recordCount, 3);
    assert(peer(current, 'group_beta@chatroom').recordsPath.startsWith(current.storage.recordsPath + path.sep));
    assert.deepEqual(current.settings, beforeMigration.settings); assert.equal(current.online, true);
    const migratedIdentity = await fixture('identity');
    assert.equal(migratedIdentity.path, path.join(paths.basePath, 'prompts/AGENT.md')); assert.equal(migratedIdentity.markdown, expectedIdentityMarkdown);
    assert.equal(fs.readFileSync(path.join(paths.bootstrap, 'prompts/AGENT.md'), 'utf8'), expectedIdentityMarkdown);
    assert.deepEqual((await fixture('stats')).migrations, [{ from: paths.bootstrap, to: paths.basePath }]);
    const oldStateBytes = fs.readFileSync(beforeMigrationStats.storeFile), oldAlphaFile = path.join(peer(beforeMigration, 'group_alpha@chatroom').recordsPath, 'conversation.json'), oldAlphaBytes = fs.readFileSync(oldAlphaFile);
    await fixture('appendRecords', { count: 1 });
    await stateMatches(state => state.conversations.find(peer => peer.peerId === 'group_alpha@chatroom').recordCount === 68);
    assert.deepEqual(fs.readFileSync(beforeMigrationStats.storeFile), oldStateBytes, 'post-migration fixture mutations must not write the old store');
    assert.deepEqual(fs.readFileSync(oldAlphaFile), oldAlphaBytes, 'the retained conversation backup must not receive new records');
    assert.equal((await fixture('stats')).activeRoot, paths.basePath);
    await assertLayout('desktop global work directory'); await screenshot('storage-desktop-dark'); await screenshot('storage-desktop-light', 'light');
    check('one global path preserves failed-save drafts and migrates all seven plugin data areas, identity, personas and records; legacy overrides consolidate and later writes use only the replacement runtime');

    const globalNotes = await verifyMemory();
    await verifyImageMemory();
    await verifyTasks();

    await click('[data-testid="nav-assets"]'); await waitFor(() => document.querySelector('[data-testid="asset-upload-input"]'));
    await waitFor(() => document.querySelectorAll('.wa-pack-card').length === 3 && document.querySelectorAll('.wa-pack-previews img').length === 9 && [...document.querySelectorAll('.wa-pack-previews img')].every(image => image.complete && image.naturalWidth === 256));
    assert.equal((await fixture('assets')).total, 0);
    assert((await fixture('assets')).packs.every(pack => !pack.enabled));
    await fixture('failNext', { endpoint: 'assets.packs.configure' }); await click('[aria-label="启用分组 猫咪心情"]');
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('模拟保存失败'));
    assert.equal(await evaluate(() => document.querySelector('[aria-label="启用分组 猫咪心情"]').checked), false);
    assert.equal((await fixture('assets')).total, 0);
    check('three built-in packs load nine real offline previews; failed enable retains the saved switch and imports no assets');
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
    const zipPack = (await fixture('assets')).packs.find(pack => !pack.builtin);
    assert.equal(zipPack.name, '界面测试表情');
    await click('[aria-label="启用分组 界面测试表情"]');
    await waitFor(() => document.querySelectorAll('.wa-asset-card.is-disabled').length === 2);
    assert.equal((await fixture('assets')).counts.enabled, 0);
    await click('[aria-label="启用分组 界面测试表情"]');
    await waitFor(() => document.querySelectorAll('.wa-asset-card.is-disabled').length === 0);
    check('ZIP imports create a named group whose switch disables and restores all its members');
    await click('[aria-label="预览并编辑 红色方块"]');
    await waitFor(() => { const image = document.querySelector('.wa-assets-large-preview img'); return image?.complete && image.naturalWidth === 2; });
    assert((await evaluate(() => document.querySelector('.wa-assets-large-preview img').src)).startsWith('data:image/png;base64,'));
    await clickText('关闭', '[role="dialog"]');
    check('the real file input imports a ZIP across two 256 KiB chunks and previews the original PNG');

    await clickText('理解未填写含义的图片');
    await waitFor(() => document.querySelector('[role="status"]')?.textContent.includes('2 张表情包跳过'));
    assert.equal((await fixture('assets')).counts.described, 0);
    assert.deepEqual((await fixture('stats')).assetAnalysisRequests, []);
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

    await click('[aria-label="启用分组 猫咪心情"]');
    await waitFor(async () => (await window.__uiFixture('assets')).total === 10);
    await input('[aria-label="素材分组筛选"]', 'builtin-fluent-cats');
    await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 9);
    await click('[aria-label="预览并编辑 猫猫开心"]');
    await waitFor(() => document.querySelector('.wa-assets-large-preview img')?.naturalWidth === 256);
    await click('[aria-label="启用这张素材"]'); await clickText('保存素材', '[role="dialog"]');
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    await click('[aria-label="启用分组 猫咪心情"]');
    await waitFor(() => document.querySelectorAll('.wa-asset-card.is-disabled').length === 9);
    assert.equal((await fixture('assets')).counts.enabled, 1);
    await click('[aria-label="启用分组 猫咪心情"]');
    await waitFor(() => document.querySelectorAll('.wa-asset-card.is-disabled').length === 1);
    assert.equal((await fixture('assets')).total, 10);
    await assertLayout('desktop built-in sticker groups'); await screenshot('builtin-sticker-packs-desktop-dark'); await screenshot('builtin-sticker-packs-desktop-light', 'light');
    await click('[data-testid="nav-overview"]'); await click('[data-testid="nav-assets"]');
    await waitFor(() => document.querySelector('[aria-label="启用分组 猫咪心情"]')?.checked && document.querySelectorAll('.wa-asset-card').length === 10);
    check('built-in enable imports nine captioned PNGs, filtering and group disable work, and re-enable/navigation preserve a per-image opt-out');

    window.setContentSize(430, 900);
    await assertLayout('narrow media library'); await screenshot('assets-narrow-dark'); await screenshot('assets-narrow-light', 'light');
    await click('[aria-label="预览并编辑 绿色方块"]'); await waitFor(() => document.querySelector('.wa-assets-large-preview img')?.complete);
    await assertLayout('narrow media editor'); await screenshot('assets-editor-narrow-dark'); await screenshot('assets-editor-narrow-light', 'light');
    const editorLayout = await evaluate(() => { const dialog = document.querySelector('[role="dialog"]'); return { width: dialog.clientWidth, scroll: dialog.scrollWidth, left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right, viewport: innerWidth }; });
    assert(editorLayout.scroll <= editorLayout.width + 1 && editorLayout.left >= 0 && editorLayout.right <= editorLayout.viewport);
    await clickText('关闭', '[role="dialog"]');
    await click('[data-testid="nav-memory"]'); await clickText('长期记忆'); await waitFor(() => isVisible(document.querySelector('[data-testid="global-memory-document"]')));
    assert.equal(await evaluate(() => document.querySelector('[data-testid="saved-global-notes"] p').textContent), globalNotes); await assertLayout('narrow global memory'); await screenshot('global-memory-narrow-dark'); await screenshot('global-memory-narrow-light', 'light');
    await click('[data-testid="nav-tasks"]');
    await assertLayout('narrow tasks'); await screenshot('tasks-narrow-dark');
    await click('[data-testid="task-tab-history"]'); await waitFor(() => document.querySelectorAll('.wa-task-history-row').length === 20);
    await assertLayout('narrow task history'); await screenshot('tasks-history-narrow-dark'); await screenshot('tasks-history-narrow-light', 'light');
    await click('[data-task-id="ui-history-completed-0"] summary'); await assertLayout('narrow expanded task history'); await screenshot('tasks-history-expanded-narrow-dark');
    await click('[data-testid="nav-memory"]'); await clickText('会话记忆'); await waitFor(() => isVisible(document.querySelector('[data-testid="memory-document"]'))); await assertLayout('narrow memory'); await screenshot('memory-narrow-light', 'light');
    await click('[data-testid="nav-overview"]'); await assertLayout('narrow overview'); await screenshot('overview-narrow-dark');
    await click('[data-testid="nav-authorization"]'); await assertLayout('narrow authorization'); await screenshot('authorization-narrow-light', 'light');
    await click('[data-testid="nav-settings"]'); await click('[data-testid="open-persona"]'); await assertLayout('narrow persona'); await screenshot('persona-narrow-dark');

    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="global-persona-editor"]')), true);
    assert.equal(await evaluate(() => !!document.querySelector('.wa-persona-library')), false);
    await screenshot('global-persona-narrow-light', 'light');
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
    await click('[data-testid="nav-assets"]');
    await waitFor(() => document.querySelectorAll('.wa-pack-card').length === 3 && !document.querySelector('[aria-label="启用分组 猫咪心情"]')?.checked);
    assert((await fixture('assets')).packs.every(pack => !pack.enabled));
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
