const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const origin = process.env.WECHAT_UI_TEST_ORIGIN || process.argv[2], output = path.resolve(process.argv[3]);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)); fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.join(output, 'browser-profile'), { recursive: true });
app.setPath('userData', path.join(output, 'browser-profile')); app.disableHardwareAcceleration();
const report = { ok: false, checks: [], errors: [], screenshots: [], actualMessages: 0, actualModelRequests: 0, startedAt: new Date().toISOString() };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let window;
const evaluate = (fn, ...args) => window.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
async function wait(fn, ...args) { const until = Date.now() + 12000; while (!await evaluate(fn, ...args)) { assert(Date.now() < until, 'UI condition timed out: ' + fn.toString().slice(0, 160)); await sleep(80); } }
function visible(element) { if (!element || !element.getClientRects().length) return false; for (let node = element; node; node = node.parentElement) { const style = getComputedStyle(node); if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || node.tagName === 'DETAILS' && !node.open && node !== element && !node.querySelector('summary')?.contains(element)) return false; } return true; }
async function click(selector, text) {
  const usable = (selector, text, source) => Array.from(document.querySelectorAll(selector)).some(el => eval('(' + source + ')')(el) && !el.disabled && (!text || el.textContent.trim() === text));
  await wait(usable, selector, text, visible.toString());
  await evaluate((selector, text, source) => { const el = Array.from(document.querySelectorAll(selector)).find(el => eval('(' + source + ')')(el) && !el.disabled && (!text || el.textContent.trim() === text)); el.scrollIntoView({ block: 'center' }); el.click(); }, selector, text, visible.toString()); await sleep(70);
}
async function input(selector, value) { await wait(selector => !!document.querySelector(selector) && !document.querySelector(selector).disabled, selector); await evaluate((selector, value) => { const el = document.querySelector(selector); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }, selector, value); }
const nav = async id => {
  if (id === 'recovery') { await click('[data-testid="nav-records"]'); await click('[data-testid="records-tab-recovery"]'); }
  else if (id === 'memory-review') { await click('[data-testid="nav-memory"]'); await click('[data-testid="memory-tab-review"]'); }
  else await click('[data-testid="nav-' + id + '"]');
};
const fixtureSummary = () => evaluate(async () => (await fetch('/fixture', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-key': window.__UI_FIXTURE_KEY__ }, body: JSON.stringify({ command: 'summary' }) })).json());
async function verifyContrast(page, theme) {
  const samples = await evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = css => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((n, i) => i === 3 ? n / 255 : n); };
    const over = (fg, bg) => fg.slice(0, 3).map((value, i) => value * fg[3] + bg[i] * (1 - fg[3])).concat(1);
    const luminance = color => color.slice(0, 3).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    return [...document.querySelectorAll('.wa-wb-card h2,.wa-wb-library-card h2,.wa-wb-card>p,.wa-wb-button:not(:disabled),.wa-wb-knowledge-flow span,.wa-wb-knowledge-flow strong,.wa-wb-knowledge-flow small,.wa-wb-switch:not(:disabled) strong,.wa-wb-index strong,.wa-wb-index p,.wa-wb-index small')].filter(el => {
      if (!el.getClientRects().length) return false;
      for (let parent = el; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector('summary')?.contains(el)) return false;
      return true;
    }).map(el => {
      const lineage = []; for (let parent = el; parent; parent = parent.parentElement) lineage.unshift(parent);
      let background = [255, 255, 255, 1], opacity = 1;
      for (const parent of lineage) { const style = getComputedStyle(parent); background = over(rgba(style.backgroundColor), background); opacity *= Number(style.opacity); }
      const ink = rgba(getComputedStyle(el).color); ink[3] *= opacity;
      const foreground = over(ink, background), a = luminance(foreground), b = luminance(background);
      return { text: el.textContent.trim().slice(0, 36), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  });
  assert(samples.length > 0, page + ' must include readable controls');
  assert.deepEqual(samples.filter(sample => sample.ratio < 4.5), [], theme + '/' + page + ' text contrast must reach 4.5:1');
  (report.contrast ||= []).push({ page, theme, samples: samples.length, minimum: Math.min(...samples.map(sample => sample.ratio)) });
}
async function capture(name, focusSelector) {
  await evaluate(() => { document.querySelector('.wa-panel').scrollTo(0, 0); document.querySelector('.wa-workspace').scrollTo(0, 0); });
  if (focusSelector) await evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), focusSelector);
  await sleep(450); await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(name + '.png');
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1280, height: 950, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 3 || event.level === 'error') report.errors.push(String(event.message).slice(0, 500)); });
  const watchdog = setTimeout(() => { report.error = 'UI verification timed out'; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); app.exit(1); }, 300000);
  try {
    await window.loadURL(origin); await wait(() => document.querySelectorAll('.wa-nav-group').length === 3); await click('[data-testid="visual-motion-toggle"]');
    assert.equal(await evaluate(() => !!document.querySelector('[data-testid="nav-recovery"],[data-testid="nav-memory-review"]')), false);
    report.checks.push('three menu groups retain the workbench pages with recovery nested under records and review nested under memory');
    await nav('knowledge'); await wait(() => document.querySelectorAll('.wa-wb-library-card').length === 2); await click('.wa-wb-library-card'); await capture('knowledge-light');
    await input('[aria-label="知识库问题"]', '退款期限');
    assert.equal(await evaluate(() => document.querySelector('[role=switch][aria-label="知识库查询总开关"]').getAttribute('aria-checked')), 'false');
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].filter(el => ['检索原文', '依据资料回答'].includes(el.textContent)).every(el => el.disabled)), true);
    const initialKnowledge = await fixtureSummary(); assert.equal(initialKnowledge.knowledge.index.state, 'pending'); assert.equal(initialKnowledge.simulated.modelRequests, 0);
    await click('.wa-wb-document button'); await wait(() => !!document.querySelector('[aria-label="知识文档预览"]')); await click('button', '收起预览');
    report.checks.push('query switch defaults off, blocks search and answer, and retains original-document reading without model usage');
    await click('[aria-label="知识库查询总开关"]'); await wait(() => document.querySelector('[aria-label="知识库查询总开关"]').getAttribute('aria-checked') === 'true');
    await click('button', '检索原文'); await wait(() => document.querySelector('.wa-wb-search-results')?.textContent.includes('七天'));
    await wait(() => document.querySelector('[aria-label="本地索引状态"]')?.textContent.includes('已就绪'));
    assert.equal((await fixtureSummary()).simulated.modelRequests, 0); report.checks.push('explicit retrieval lazily builds local FTS5 and returns cited text with no model usage');
    await click('button', '重建本地索引'); await wait(() => document.querySelector('[role=status]')?.textContent.includes('已重建')); assert.equal((await fixtureSummary()).simulated.modelRequests, 0);
    report.checks.push('manual index rebuild reports completion without enabling any model call');
    await click('button', '依据资料回答'); await wait(() => document.querySelector('.wa-wb-search-results .wa-wb-paper')?.textContent.includes('来源'));
    assert.equal((await fixtureSummary()).simulated.modelRequests, 1); report.checks.push('knowledge answer uses one bounded retrieval and one model request, with visible usage');
    await input('[aria-label="知识库问题"]', 'missinglookupzxq'); await click('button', '依据资料回答'); await wait(() => document.querySelector('.wa-wb-search-results .wa-wb-paper')?.textContent.includes('没有'));
    assert.equal((await fixtureSummary()).simulated.modelRequests, 1);
    await click('[aria-label="知识库查询总开关"]'); await wait(() => document.querySelector('[aria-label="知识库查询总开关"]').getAttribute('aria-checked') === 'false'); assert.equal(await evaluate(() => !!document.querySelector('.wa-wb-search-results')), false);
    await click('[aria-label="知识库查询总开关"]'); report.checks.push('no-match answer makes zero additional model requests and disabling clears prior results');
    await evaluate(() => window.__uiFixture('hold-next-knowledge')); await input('[aria-label="知识库问题"]', '退款期限'); await click('button', '依据资料回答');
    await wait(async () => (await window.__uiFixture('summary')).controls.heldKnowledge === 1);
    assert.equal(await evaluate(() => document.querySelector('[aria-label="知识库查询总开关"]').disabled), false, 'the stop switch stays available during a paid query');
    await click('[aria-label="知识库查询总开关"]'); await wait(() => document.querySelector('[aria-label="知识库查询总开关"]').getAttribute('aria-checked') === 'false');
    await wait(async () => (await window.__uiFixture('summary')).controls.abortedKnowledge === 1);
    await click('[aria-label="知识库查询总开关"]'); await evaluate(() => window.__uiFixture('hold-next-knowledge')); await click('button', '依据资料回答');
    await wait(async () => (await window.__uiFixture('summary')).controls.heldKnowledge === 2);
    await evaluate(() => window.__uiFixture('release-first-knowledge')); await wait(async () => (await window.__uiFixture('summary')).controls.heldKnowledge === 1);
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent === '依据资料回答').disabled), true, 'a late cancelled response cannot clear the next query busy state');
    assert.equal(await evaluate(() => !!document.querySelector('.wa-wb-search-results')), false);
    await evaluate(() => window.__uiFixture('release-first-knowledge')); await wait(() => document.querySelector('.wa-wb-search-results .wa-wb-paper')?.textContent.includes('来源'));
    assert.equal(await evaluate(() => !!document.querySelector('.wa-alert.is-error')), false);
    report.checks.push('switching off cancels an in-flight query and a late result cannot overwrite the next query or its busy state');
    await click('button', '新建知识库'); await input('[aria-label="知识库名称"]', '验收知识库'); await input('[aria-label="知识库说明"]', '验证真实导入、检索与删除。'); await click('button', '保存知识库'); await wait(() => document.querySelectorAll('.wa-wb-library-card').length === 3);
    await evaluate(() => { const file = new File(['退款测试口令是松石三号。'], '验收资料.md', { type: 'text/markdown' }), data = new DataTransfer(); data.items.add(file); const input = document.querySelector('[aria-label="导入知识文档"]'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(() => document.querySelector('.wa-wb-document-list')?.textContent.includes('验收资料.md')); assert.equal((await fixtureSummary()).knowledge.index.state, 'pending'); await input('[aria-label="知识库问题"]', '松石三号'); await click('button', '检索原文'); await wait(() => document.querySelector('.wa-wb-search-results')?.textContent.includes('松石三号')); report.checks.push('file upload saves original bytes and defers index rebuilding until explicit retrieval');
    await click('.wa-wb-document button'); await wait(() => document.querySelector('[aria-label="知识文档预览"]')?.textContent.includes('松石三号')); await click('button', '收起预览'); await click('.wa-wb-document button', '删除'); await click('button', '确认删除'); await wait(() => !document.querySelector('.wa-wb-document-list')?.textContent.includes('验收资料.md')); report.checks.push('document preview and confirmed deletion operate on the durable knowledge store');
    await nav('memory-review'); await wait(() => document.querySelector('.wa-wb-fact')?.textContent.includes('980')); await capture('memory-conflict-light'); await click('.wa-wb-tabs button', '有效记忆'); assert.equal(await evaluate(() => [...document.querySelectorAll('.wa-wb-fact')].some(el => el.textContent.includes('800') || el.textContent.includes('980'))), false); await click('.wa-wb-tabs button', '冲突待确认'); await click('button', '采用新事实'); await wait(() => !document.querySelector('.wa-wb-fact')); await click('.wa-wb-tabs button', '有效记忆'); await wait(() => document.querySelector('.wa-wb-fact')?.textContent.includes('980')); await click('button', '调整有效期'); const later = new Date(Date.now() + 86400000); const local = new Date(later - later.getTimezoneOffset() * 60000).toISOString().slice(0, 16); await input('[aria-label="记忆到期时间"]', local); await click('button', '保存有效期'); await wait(() => document.querySelector('.wa-wb-expiry')?.textContent.includes('有效至')); report.checks.push('conflict acceptance and expiry save update memory cards and effective facts');
    await nav('digests'); await click('button', '生成简报草稿'); await wait(() => document.querySelector('.wa-wb-todo')); await capture('digest-light'); await click('button', '确认待办'); await wait(() => document.querySelector('.wa-wb-todo')?.textContent.includes('已确认')); await click('button', '设为定时提醒'); await click('button', '确认创建提醒'); await wait(() => document.querySelector('.wa-wb-todo')?.textContent.includes('已创建提醒')); report.checks.push('group digest cites source messages and only creates a reminder after explicit todo confirmation');
    const savedReminder = (await fixtureSummary()).workbench.summaries[0].todos[0].reminder;
    assert.equal(savedReminder.state, 'pending');
    assert(await evaluate(at => { const shown = new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); return document.querySelector('.wa-wb-todo').textContent.includes(shown) && document.querySelector('[role=status]').textContent.includes(shown); }, savedReminder.at));
    await evaluate(() => window.__uiFixture('cancel-first-reminder')); await nav('knowledge'); await nav('digests');
    await wait(() => document.querySelector('.wa-wb-todo')?.textContent.includes('提醒已取消'));
    report.checks.push('digest cards show the persisted reminder time and reload its cancelled scheduler state');
    await nav('memory-review'); await click('.wa-wb-tabs button', '有效记忆');
    assert.equal(await evaluate(() => document.querySelector('[data-testid="nav-memory"]').getAttribute('aria-current')), 'page');
    await click('button', '调整有效期');
    const expiryDate = new Date(Date.now() + 2 * 86400000), expiryDraft = new Date(expiryDate - expiryDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await input('[aria-label="记忆到期时间"]', expiryDraft);
    const memoryBeforeDelete = (await fixtureSummary()).memory.markdown;
    await evaluate(() => window.__uiFixture('fail-next-delete', { endpoint: 'memory.fact.delete' }));
    await click('[data-testid="memory-delete-fact"]'); await capture('memory-delete-confirmation-light', '[aria-label="确认删除记忆"]'); await verifyContrast('memory-review-with-delete', 'light');
    await click('[aria-label="确认删除记忆"] button', '确认删除');
    await wait(() => document.querySelector('[data-testid="memory-review-page"] .wa-alert.is-error')?.textContent.includes('删除保存失败'));
    assert.equal((await fixtureSummary()).memory.markdown, memoryBeforeDelete);
    assert.equal(await evaluate(() => document.querySelector('[aria-label="记忆到期时间"]').value), expiryDraft);
    assert.equal(await evaluate(() => !!document.querySelector('[aria-label="确认删除记忆"]')), true);
    report.checks.push('failed fact deletion preserves the authoritative Markdown, confirmation target and unsaved expiry draft');
    await click('[aria-label="确认删除记忆"] button', '取消'); await click('.wa-wb-inline-form button', '取消');
    await click('[data-testid="memory-delete-fact"]'); await click('[aria-label="确认删除记忆"] button', '确认删除');
    await wait(() => document.querySelector('[data-testid="memory-review-page"] [role=status]')?.textContent.includes('已删除 1 条'));
    assert.equal((await fixtureSummary()).memory.markdown.includes('980'), false);
    await click('[data-testid="memory-tab-global"]');
    await wait(() => document.querySelector('[data-testid="global-memory-document"]') && !document.querySelector('[data-testid="global-memory-document"]').textContent.includes('980'));
    await click('[data-testid="memory-tab-review"]'); await click('.wa-wb-tabs button', '全部与历史');
    await click('[data-testid="memory-clear-facts"]'); await click('[aria-label="确认删除记忆"] button', '确认删除');
    await wait(() => document.querySelector('[data-testid="memory-review-page"] [role=status]')?.textContent.includes('已删除 2 条'));
    assert.equal((await fixtureSummary()).memory.sections.flatMap(section => section.facts).length, 0);
    assert.equal(await evaluate(() => document.querySelector('[data-testid="memory-clear-facts"]').disabled), true);
    report.checks.push('single and category fact deletion update the same global memory, including historical facts, without redundant stored copies');
    await nav('digests');
    await nav('recovery'); await click('.wa-wb-list-item'); await click('button', '仅恢复文字'); await wait(() => document.querySelector('[aria-label="发送前预览"]')); assert.equal(await evaluate(() => Array.from(document.querySelectorAll('button')).find(el => el.textContent === '发送并核对回执').disabled), true); await capture('recovery-light'); await click('[aria-label="发送前预览"] input[type=checkbox]'); await click('button', '发送并核对回执'); await wait(() => document.querySelector('[role=status]')?.textContent.includes('微信服务端已确认')); report.checks.push('recovery preserves the original reply, requires confirmation and records a simulated server ACK');
    await nav('diagnostics'); await click('button', '检查现在能做什么'); await wait(() => document.querySelectorAll('.wa-wb-capability').length === 5 && !Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('检查现在能做什么'))?.disabled); await capture('diagnostics-light'); report.checks.push('diagnostics render five actual probe results with separate image-readiness status');
    await nav('recovery');
    assert.equal(await evaluate(() => document.querySelector('[data-testid="nav-records"]').getAttribute('aria-current')), 'page');
    assert.equal(await evaluate(() => document.querySelectorAll('.wa-wb-recovery-row button button').length), 0);
    await click('.wa-wb-history summary'); await click('[data-testid="recovery-delete-history"]'); await capture('recovery-history-delete-light', '[aria-label="确认删除恢复记录"]'); await verifyContrast('recovery-with-delete', 'light');
    await click('[aria-label="确认删除恢复记录"] button', '确认删除');
    await wait(() => !document.querySelector('.wa-wb-history-row'));
    let deletionSummary = await fixtureSummary();
    assert.equal(deletionSummary.records.draftCount, 0); assert.equal(deletionSummary.records.counts.all, 2);
    assert(deletionSummary.archives.some(record => record.state === 'sent' && record.acknowledgedMessageIds?.length));
    await click('.wa-wb-list-item'); await click('button', '仅恢复文字'); await click('button', '仅恢复文字');
    assert.equal((await fixtureSummary()).records.draftCount, 2);
    await click('[data-testid="recovery-clear-history"]'); await click('[aria-label="确认删除恢复记录"] button', '确认删除');
    await wait(() => !document.querySelector('[aria-label="发送前预览"]') && !document.querySelector('.wa-wb-history-row'));
    assert.equal((await fixtureSummary()).records.draftCount, 0);
    report.checks.push('single and full recovery-history cleanup clear prepared previews while retaining original entries, server ACKs and sent records');
    await evaluate(() => window.__uiFixture('fail-next-delete', { endpoint: 'recovery.delete' }));
    await click('[data-testid="recovery-delete-record"]'); await click('[aria-label="确认删除恢复记录"] button', '确认删除');
    await wait(() => document.querySelector('[data-testid="recovery-page"] .wa-alert.is-error')?.textContent.includes('删除保存失败'));
    assert.equal((await fixtureSummary()).records.counts.all, 2);
    assert.equal(await evaluate(() => !!document.querySelector('[aria-label="确认删除恢复记录"]') && !!document.querySelector('.wa-wb-recovery-row.is-selected')), true);
    await click('[aria-label="确认删除恢复记录"] button', '取消');
    await click('.wa-wb-tabs button', '结果不明'); await click('[data-testid="recovery-delete-record"]');
    await click('[aria-label="确认删除恢复记录"] button', '确认删除'); await wait(() => !document.querySelector('.wa-wb-recovery-row'));
    deletionSummary = await fixtureSummary(); assert.equal(deletionSummary.records.counts.unknown, 0);
    assert(deletionSummary.archives.some(record => record.key === 'preview-unknown' && record.state === 'unknown'));
    await click('.wa-wb-tabs button', '全部待处理'); await click('[data-testid="recovery-clear-records"]');
    await evaluate(() => window.__uiFixture('add-recovery')); await click('[aria-label="确认删除恢复记录"] button', '确认删除');
    await wait(() => document.querySelector('[data-testid="recovery-page"] .wa-alert.is-error')?.textContent.includes('待处理记录已更新'));
    assert.equal((await fixtureSummary()).records.counts.all, 2);
    assert.equal(await evaluate(() => !!document.querySelector('[aria-label="确认删除恢复记录"]')), true);
    await click('button', '重新读取'); await click('[aria-label="确认删除恢复记录"] button', '确认删除');
    await wait(() => document.querySelector('[data-testid="recovery-page"] .wa-alert.is-error')?.textContent.includes('待处理记录已更新'));
    assert.equal((await fixtureSummary()).records.counts.all, 2, 'refresh cannot silently change the captured confirmation scope');
    await capture('recovery-stale-delete-light', '[aria-label="确认删除恢复记录"]'); await click('[aria-label="确认删除恢复记录"] button', '取消');
    await click('[data-testid="recovery-clear-records"]'); await click('[aria-label="确认删除恢复记录"] button', '确认删除');
    await wait(() => !document.querySelector('.wa-wb-recovery-row'));
    assert.equal((await fixtureSummary()).records.counts.all, 0);
    report.checks.push('record deletion preserves failed and uncertain archives; failed and stale confirmations keep their targets and never silently expand after refresh');
    for (const theme of ['dark', 'light']) {
      await evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.className = theme; }, theme);
      for (const page of ['knowledge', 'memory-review', 'digests', 'recovery', 'diagnostics']) { await nav(page); if (page === 'knowledge') { await wait(() => document.querySelector('.wa-wb-library-card')); await click('.wa-wb-library-card'); } await capture(page + '-' + theme + '-desktop'); await verifyContrast(page, theme); }
    }
    report.checks.push('card headings, explanations and enabled buttons meet 4.5:1 contrast in both themes');
    await nav('digests'); await click('button', '删除简报'); await wait(() => document.querySelector('[aria-label="确认删除简报"]')?.textContent.includes('独立保留')); await click('button', '确认删除简报'); await wait(() => !document.querySelector('.wa-wb-digest')); report.checks.push('confirmed digest deletion removes its cards with a clear reminder-retention notice');
    for (const width of [768, 430, 320]) {
      window.setContentSize(width, 920);
      for (const page of ['knowledge', 'memory-review', 'digests', 'recovery', 'diagnostics']) { await nav(page); await sleep(100); const overflow = await evaluate(() => [...document.querySelectorAll('.wa-panel,.wa-shell,.wa-workspace,.wa-wb-page')].filter(el => el.scrollWidth > el.clientWidth + 2).map(el => ({ className: el.className, width: el.clientWidth, scroll: el.scrollWidth }))); assert.deepEqual(overflow, [], page + ' must fit at ' + width); if (width === 320) await capture(page + '-320'); }
    }
    report.checks.push('five pages fit 768, 430 and 320 pixel windows with reachable grouped navigation');
    window.setContentSize(1280, 1000);
    await evaluate(() => window.__uiFixture('seed-blocked-natural'));
    await nav('authorization'); await click('.wa-session-row[data-peer-id="studio-team@chatroom"] button', '设置');
    await wait(() => document.querySelector('[data-testid="natural-chat-status"]')?.textContent.includes('主动参与已暂停'));
    const beforeResume = (await fixtureSummary()).simulated;
    await input('#wa-natural-temperament', 'quiet'); await click('button', '保存会话设置');
    await wait(() => document.querySelector('[data-testid="natural-chat-status"]')?.textContent.includes('主动参与已暂停') && !document.querySelector('#wa-natural-temperament').disabled);
    await click('[data-testid="natural-resume-review"] summary');
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '恢复主动参与').disabled), true);
    await capture('natural-resume-review-light', '[data-testid="natural-resume-review"]');
    await click('[aria-label="已核对自然陪聊发送结果"]'); await click('button', '恢复主动参与');
    await wait(() => document.querySelector('[data-testid="natural-chat-status"]')?.textContent.includes('等待下一次参与机会') && !document.querySelector('[data-testid="natural-resume-review"]'));
    const afterResume = await fixtureSummary(); assert.deepEqual(afterResume.simulated, beforeResume);
    assert(afterResume.archives.some(record => record.key === 'preview-unknown' && record.state === 'unknown'));
    report.checks.push('changing character keeps uncertain delivery paused; the resume control requires explicit review and schedules a new opportunity without replaying the original or calling the model');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.error = error.message; report.stack = error.stack; if (window && !window.isDestroyed()) await capture('failure'); }
  finally { clearTimeout(watchdog); report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); window.destroy(); app.exit(report.ok ? 0 : 1); }
});
