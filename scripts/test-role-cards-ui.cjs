const assert = require('node:assert/strict');

module.exports = async function verifyRoleCards({ evaluate, waitFor, click, clickText, input, fixture, screenshot, assertLayout, check, resize, press }) {
  const search = '[aria-label="搜索人物角色卡"]', style = '[aria-label="交流偏好"]';
  const card = personId => '[data-person-id="' + personId + '"] .wa-role-card-open';
  const dialog = '[data-testid="role-card-dialog"]';
  const openSettings = async () => {
    if (await evaluate(() => !!document.querySelector('.wa-role-settings'))) {
      if (!await evaluate(() => document.querySelector('.wa-role-settings').open)) await click('.wa-role-settings > summary');
    } else {
      await clickText('自动整理设置');
      await waitFor(() => document.querySelector('[data-testid="role-card-settings"]'));
    }
  };
  const person = { personId: 'wxid_role_alice' }, groupOnly = { personId: 'wxid_role_group_only' };
  const original = (await fixture('seedLongMemorySources')).markdown;
  await fixture('seedPersonCards');
  await fixture('seedRoleCardGallery');
  await click('[data-testid="nav-memory"]'); await clickText('人物角色卡');
  await waitFor(() => document.querySelectorAll('.wa-role-card').length >= 6);
  await waitFor(() => document.querySelector('[data-label-id="1"] h3')?.textContent === '计实一班');
  const grouped = await evaluate(() => [...document.querySelectorAll('[data-testid="role-card-group"]')].map(group => ({
    name: group.querySelector('.wa-role-tag-head h3').textContent,
    ids: [...group.querySelectorAll('.wa-role-card')].map(card => card.dataset.personId),
    counts: [...group.querySelectorAll('.wa-role-card-meta>span:first-child')].map(node => Number.parseInt(node.textContent)),
  })));
  assert.deepEqual(grouped.map(group => group.name), ['计实一班', '摄影朋友', '未标签']);
  assert(grouped[0].ids.includes('wxid_role_alice'));
  assert(grouped[0].ids.includes('wxid_gallery_long') && grouped[1].ids.includes('wxid_gallery_long'));
  assert.deepEqual(grouped[2].ids, ['wxid_role_group_only', 'wxid_gallery_riley']);
  for (const group of grouped) assert.deepEqual(group.counts, [...group.counts].sort((a, b) => b - a));
  assert(!await evaluate(() => document.querySelector('[data-person-id="wxid_gallery_empty"], [data-person-id="wxid_gallery_name_only"]')));
  assert.equal(await evaluate(() => document.querySelector('.wa-role-gallery-head h2>span').textContent), '6 张角色卡');
  check('only real person details create visible cards, actual WeChat tags group shared cards, and each group sorts by detail count');
  await input(search, '计实一班');
  await waitFor(() => document.querySelector('.wa-role-search-result')?.textContent === '找到 3 张角色卡');
  await input(search, '');
  await fixture('failNext', { endpoint: 'moments.audience' }); await click('[aria-label="刷新微信标签"]');
  await waitFor(() => document.querySelector('[data-testid="role-cards-page"] [role="alert"]')?.textContent.includes('微信标签读取失败'));
  assert.equal(await evaluate(() => document.querySelector('[data-label-id="1"] h3').textContent), '计实一班');
  await click('[aria-label="刷新微信标签"]');
  await waitFor(() => !document.querySelector('[data-testid="role-cards-page"] [role="alert"]'));
  check('label search finds unique cards and a failed tag refresh preserves the previous groups for retry');
  assert(!await evaluate(() => document.querySelector('.wa-role-settings')?.open));
  assert(!await evaluate(() => document.querySelector('[data-testid="role-card-dialog"]')));
  await screenshot('person-role-gallery-desktop-light', 'light', '[data-testid="role-cards-page"]');
  await screenshot('person-role-gallery-desktop-dark', 'dark', '[data-testid="role-cards-page"]');
  await input(search, '红茶');
  await waitFor(() => document.querySelectorAll('.wa-role-card').length === 1);
  assert.equal(await evaluate(() => document.querySelector('.wa-role-card').dataset.personId), person.personId);
  await input(search, '林间');
  await waitFor(() => document.querySelectorAll('.wa-role-card').length === 2);
  assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.wa-role-card-id')].map(node => node.textContent).sort()), ['wxid_gallery_books', 'wxid_gallery_photo']);
  await input(search, '没有这样一个人物');
  await waitFor(() => document.querySelector('[data-testid="role-cards-page"]').textContent.includes('没有找到这个人物'));
  await clickText('显示全部人物');
  await waitFor(() => document.querySelectorAll('.wa-role-card').length >= 6);
  check('the page opens as separate person cards and searches names, preferences and distinct same-name identities');
  await evaluate(selector => document.querySelector(selector).focus(), card(person.personId));
  await press('Enter');
  await waitFor(() => document.querySelector('[data-testid="role-card-dialog"]')?.open);
  await press('Escape');
  await waitFor(() => !document.querySelector('[data-testid="role-card-dialog"]'));
  assert.equal(await evaluate(selector => document.activeElement === document.querySelector(selector), card(person.personId)), true);
  check('cards open with the keyboard and Escape returns focus to the same card');
  const settingsPanel = '[data-testid="role-card-settings"]', trigger = '#wa-role-trigger', threshold = '#wa-role-message-threshold';
  await openSettings();
  await waitFor(() => document.querySelector('#wa-role-message-threshold')?.value === '20');
  assert.equal(await evaluate(() => document.querySelector('[aria-label="自动整理角色卡"]').checked), true);
  assert.equal(await evaluate(selector => document.querySelector(selector).value, trigger), 'messages');
  check('global role-card settings default to enabled and 20 messages');
  const initialSettings = (await fixture('roleCardSettings')).settings;
  await input(trigger, 'time');
  await waitFor(() => document.querySelector('#wa-role-trigger')?.value === 'time');
  await fixture('failNext', { endpoint: 'memory.role.configure' }); await clickText('保存角色卡总设置', settingsPanel);
  await waitFor(() => document.querySelector('[data-testid="role-card-settings"] [role="alert"]')?.textContent.includes('模拟保存失败'));
  assert.equal(await evaluate(selector => document.querySelector(selector).value, trigger), 'time');
  assert.equal((await fixture('roleCardSettings')).settings.trigger, 'messages');
  check('failed settings saves retain the selected update mode');
  await clickText('保存角色卡总设置', settingsPanel);
  await waitFor(async () => (await window.__uiFixture('roleCardSettings')).settings.trigger === 'time');
  await click('[data-testid="nav-memory"]'); await clickText('人物角色卡');
  await openSettings();
  await waitFor(() => document.querySelector('#wa-role-trigger')?.value === 'time');
  await input(trigger, 'messages');
  await waitFor(() => document.querySelector('#wa-role-message-threshold')?.value === '20');
  assert.equal(await evaluate(selector => document.querySelector(selector).value, threshold), '20');
  await input(threshold, '30'); await clickText('保存角色卡总设置', settingsPanel);
  await waitFor(async () => (await window.__uiFixture('roleCardSettings')).settings.messageThreshold === 30);
  await click('[aria-label="自动整理角色卡"]'); await clickText('保存角色卡总设置', settingsPanel);
  await waitFor(async () => (await window.__uiFixture('roleCardSettings')).settings.enabled === false);
  assert.equal((await fixture('roleCardSettings')).settings.intervalMinutes, initialSettings.intervalMinutes);
  check('settings survive remount, preserve the time interval and support the global off switch');
  if (await evaluate(() => !!document.querySelector('.wa-role-settings'))) await click('.wa-role-settings > summary');
  else { await click('[data-testid="nav-memory"]'); await clickText('人物角色卡'); }
  await click(card(person.personId));
  await waitFor(() => document.querySelector('#role-preferences')?.textContent === '喜欢红茶');
  assert(!await evaluate(() => document.querySelector('#wa-memory-panel-roles textarea')));
  const saved = await fixture('roleCard', person);
  assert.equal(saved.encounters.length, 2);
  assert.equal(saved.roleId, (await fixture('roleCard', { chatType: 'group', peerId: 'group_alpha@chatroom', senderId: person.personId })).roleId);
  check('the page shows automatically summarized person memory with one identity across private and group chat');

  await clickText('根据来源更新');
  await waitFor(() => [...document.querySelectorAll('#wa-memory-panel-roles [role="status"]')].some(node => node.textContent.includes('已安排后台更新')));
  check('refresh acknowledges background work without waiting for a conversation reply');
  await waitFor(async () => !(await window.__uiFixture('roleCard', { personId: 'wxid_role_alice' })).manualPending);
  await waitFor(() => document.querySelector('.wa-role-detail-status .wa-role-state')?.dataset.state === 'disabled');

  await clickText('纠正资料');
  await input('[aria-label="人物名称"]', '聊得来的同事');
  await input(style, '自然简短，讨论方案时先说结论。');
  assert.equal(await evaluate(() => document.querySelector('[aria-label="人物名称"]').value), '聊得来的同事');
  await evaluate(selector => document.querySelector(selector).focus(), card(groupOnly.personId));
  assert.equal(await evaluate(() => document.querySelector('[data-testid="role-card-dialog"]').contains(document.activeElement)), true);
  await press('Escape');
  assert.equal(await evaluate(() => document.querySelector('[data-testid="role-card-dialog"]').open), true);
  assert.equal(await evaluate(selector => document.querySelector(selector).value, style), '自然简短，讨论方案时先说结论。');
  await fixture('failNext', { endpoint: 'memory.role.save' }); await clickText('保存纠正');
  await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(node => node.textContent.includes('模拟保存失败')));
  assert.equal((await fixture('roleCard', person)).card.label, '');
  assert.equal(await evaluate(selector => document.querySelector(selector).value, style), '自然简短，讨论方案时先说结论。');
  check('failed corrections keep both the automatic card and the editable draft');
  await clickText('保存纠正');
  await waitFor(async () => (await window.__uiFixture('roleCard', { personId: 'wxid_role_alice' })).card.label === '聊得来的同事');
  await waitFor(() => document.querySelector('#role-label')?.tagName === 'P' && document.querySelector('#role-label').textContent === '聊得来的同事');
  await click('[aria-label="关闭人物角色卡"]');
  await waitFor(() => document.querySelector('[data-person-id="wxid_role_alice"] h3')?.textContent === '聊得来的同事');
  await clickText('长期记忆'); await clickText('人物角色卡');
  await click(card(person.personId));
  await waitFor(() => document.querySelector('#role-label')?.textContent === '聊得来的同事');
  assert.equal((await fixture('globalMemory')).markdown, original);
  check('corrections survive remount and do not rewrite the source conversation facts');
  await click('[aria-label="关闭人物角色卡"]');

  for (const [width, theme] of [[1280, 'light'], [430, 'dark'], [320, 'light']]) {
    resize(width, 1000); await assertLayout('person role card width ' + width);
    await screenshot('person-role-gallery-' + width + '-' + theme, theme, '[data-testid="role-cards-page"]');
    await click(card(person.personId));
    await waitFor(() => document.querySelector('#role-label')?.textContent === '聊得来的同事');
    assert.equal(await evaluate(() => {
      const node = document.querySelector('[data-testid="role-card-dialog"]');
      return node.scrollWidth <= node.clientWidth + 1 && node.getBoundingClientRect().right <= window.innerWidth;
    }), true);
    await screenshot('person-role-detail-' + width + '-' + theme, theme, dialog);
    await click('[aria-label="关闭人物角色卡"]');
  }
  check('card galleries and full profiles fit desktop, 430px dark and 320px light layouts');
  resize(1280, 940);
  await click(card(groupOnly.personId));
  await waitFor(() => document.querySelector('#role-preferences')?.textContent === '喜欢骑行');
  assert.equal((await fixture('roleCard', groupOnly)).encounters[0].chatType, 'group');
  assert(!await evaluate(() => document.querySelector('[data-testid="role-card-dialog"]').textContent.includes('喜欢红茶')));
  check('group-only people open their own card with separate preferences');
  await click('[aria-label="关闭人物角色卡"]');

  await fixture('holdNext', { endpoint: 'memory.role.get' }); await click(card(person.personId));
  await waitFor(async () => (await window.__uiFixture('heldRequest', { endpoint: 'memory.role.get' })).started);
  await fixture('switchAccount');
  await waitFor(() => document.querySelector('#wa-memory-tab-conversation')?.getAttribute('aria-selected') === 'true');
  await fixture('releaseRequest', { endpoint: 'memory.role.get' }); await clickText('人物角色卡');
  await waitFor(() => document.querySelector('#wa-memory-panel-roles')?.textContent.includes('正在从聊天中认识人物'));
  assert(!await evaluate(() => document.querySelector('[data-testid="role-card-group"]')));
  assert(!await evaluate(() => document.querySelector('#wa-memory-panel-roles').textContent.includes('聊得来的同事')));
  assert(!await evaluate(() => document.querySelector('[data-testid="role-card-dialog"]')));
  check('account changes discard old selection and late profile responses');
  await openSettings();
  assert.equal(await evaluate(() => document.querySelector('[aria-label="自动整理角色卡"]').checked), false);
  if (!await evaluate(() => !!document.querySelector('.wa-role-settings'))) {
    await click('[data-testid="nav-memory"]'); await clickText('人物角色卡');
  }
  await fixture('roleCardsOffline');
  await waitFor(() => document.querySelector('#wa-memory-tab-conversation')?.getAttribute('aria-selected') === 'true');
  await clickText('人物角色卡');
  await waitFor(() => document.querySelector('#wa-memory-panel-roles')?.textContent.includes('先连接微信账号'));
  await openSettings();
  await waitFor(() => document.querySelector('#wa-role-message-threshold')?.value === '30');
  await input(threshold, '20'); await clickText('保存角色卡总设置', settingsPanel);
  await waitFor(async () => (await window.__uiFixture('roleCardSettings')).settings.messageThreshold === 20);
  check('global settings are shared across accounts and can be saved without a connected account');
};
