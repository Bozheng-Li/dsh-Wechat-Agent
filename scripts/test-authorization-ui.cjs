const assert = require('node:assert/strict');

module.exports = async function verifyBatchAuthorization({ evaluate, waitFor, click, clickText, input, fixture,
  stateMatches, screenshot, assertLayout, check, resize }) {
  const main = '[data-selection-scope="main"]', suggestions = '[data-selection-scope="suggestions"]',
    grantSelected = main + ' [data-testid="authorization-grant-selected"]',
    revokeSelected = main + ' [data-testid="authorization-revoke-selected"]',
    selectAll = main + ' input[type="checkbox"]',
    search = '[data-testid="conversation-search"]',
    selectedCount = main + ' [data-testid="authorization-selection-count"]',
    row = id => '.wa-session-list .wa-session-row[data-peer-id="' + id + '"]',
    checkbox = id => row(id) + ' input[type="checkbox"]';
  const idle = () => waitFor(() => isUsable(document.querySelector('[aria-label="启用自动回复"]')));
  const requests = async () => (await fixture('stats')).settingsRequests;
  const expectSelection = async count => waitFor(count => document.querySelector('[data-selection-scope="main"] [data-testid="authorization-selection-count"]')?.textContent.trim().startsWith('已选 ' + count + ' 个'), [count]);
  const original = await fixture('state');
  const retained = original.conversations.filter(item => item.recordCount).map(item => ({ peerId: item.peerId, config: item.config, recordCount: item.recordCount }));
  const discoveredPrivate = ['wxid_alice', 'wxid_bob', 'wxid_li_ming', 'wxid_xiao_li'].sort(),
    discoveredGroups = ['group_alpha@chatroom', 'group_beta@chatroom', 'group_gamma@chatroom'].sort();

  await click('[data-testid="nav-authorization"]');
  await waitFor(selector => document.querySelector(selector), [selectAll]);
  await idle(); await expectSelection(0);
  assert.equal(await evaluate(() => !!document.querySelector('[data-testid="authorization-grant-all"], [data-testid="authorization-revoke-all"]')), false);
  for (const selector of [grantSelected, revokeSelected]) assert.equal(await evaluate(selector => document.querySelector(selector).disabled, selector), true);
  assert.equal(await evaluate(() => document.querySelectorAll('.wa-session-list .wa-session-row').length), 5);
  await click(checkbox('group_alpha@chatroom')); await click(checkbox('wxid_alice'));
  await expectSelection(2);
  assert.equal(await evaluate(selector => document.querySelector(selector).indeterminate, selectAll), true);
  assert.deepEqual((await fixture('state')).settings, original.settings);
  check('both batch actions require explicit selections; mixed group/private checkbox selection makes no settings request');

  await input(search, '周末');
  await waitFor(() => document.querySelectorAll('.wa-session-list .wa-session-row').length === 1);
  assert((await evaluate(selector => document.querySelector(selector).textContent, selectedCount)).includes('其中 2 个不在当前列表'));
  await click(selectAll); await expectSelection(3);
  assert.equal(await evaluate(selector => document.querySelector(selector).checked, selectAll), true);
  await click(selectAll); await expectSelection(2);
  await input(search, ''); await clickText('发现会话'); await clickText('私聊', '.wa-filters');
  await waitFor(() => document.querySelectorAll('.wa-session-list .wa-session-row').length === 4);
  assert.equal(await evaluate(selector => document.querySelector(selector).disabled, checkbox('wxid_bob')), false);
  assert.equal(await evaluate(selector => document.querySelector(selector).indeterminate, selectAll), true);
  check('select-all touches only the current filtered list; explicit hidden selections are counted and unauthorized rows remain selectable');

  await fixture('failNext', { endpoint: 'settings' }); await click(revokeSelected);
  await waitFor(() => document.querySelector('.wa-alert.is-error')?.textContent.includes('模拟保存失败'));
  await idle(); await expectSelection(2);
  assert.deepEqual((await fixture('state')).settings, original.settings);
  assert.equal(await evaluate(() => !!document.querySelector('.wa-alert.is-success')), false);
  check('failed selected revocation preserves authorization and selection without a success notice');

  const beforeMixed = (await requests()).length;
  await fixture('holdNext', { endpoint: 'settings' }); await click(revokeSelected);
  await waitFor(async () => (await window.__uiFixture('heldRequest', { endpoint: 'settings' })).started);
  assert.equal(await evaluate(() => [...document.querySelectorAll('.wa-authorization-selection button, .wa-authorization-selection input, .wa-session-select input')].every(element => element.disabled)), true);
  await evaluate(selector => document.querySelector(selector).click(), revokeSelected);
  assert.equal((await requests()).length, beforeMixed + 1);
  assert.deepEqual((await fixture('state')).settings, original.settings);
  await fixture('releaseRequest', { endpoint: 'settings' });
  await stateMatches(state => !state.settings.groups.includes('group_alpha@chatroom') && !state.settings.privatePeers.includes('wxid_alice'));
  await idle(); await expectSelection(0);
  let saved = (await fixture('state')).settings;
  assert.deepEqual(saved.groups, ['group_authorized_only@chatroom', 'group_beta@chatroom']);
  assert.deepEqual(saved.privatePeers, ['wxid_authorized_only']);
  assert.equal(saved.enabled, original.settings.enabled); assert.equal(saved.prompt, original.settings.prompt);
  assert.equal((await requests()).length, beforeMixed + 1);
  check('one request revokes exactly the selected group and private peer, blocks duplicate clicks, and retains all unselected authorizations');

  await input(search, '没有这个会话');
  await waitFor(() => !document.querySelector('.wa-session-list .wa-session-row'));
  const beforeEmpty = (await requests()).length;
  for (const selector of [selectAll, grantSelected, revokeSelected]) assert.equal(await evaluate(selector => document.querySelector(selector).disabled, selector), true);
  await evaluate(() => document.querySelectorAll('[data-selection-scope="main"] button').forEach(button => button.click()));
  assert.equal((await requests()).length, beforeEmpty);
  assert.deepEqual((await fixture('state')).settings, saved);
  check('an empty filtered list and zero selection can never grant or revoke the whole account');

  await input(search, '');
  await click(checkbox('wxid_bob')); await click(checkbox('wxid_alice')); await expectSelection(2);
  assert.equal(await evaluate(selector => document.querySelector(selector).disabled, revokeSelected), true);
  await fixture('failNext', { endpoint: 'settings' }); await click(grantSelected);
  await waitFor(() => document.querySelector('.wa-alert.is-error')?.textContent.includes('模拟保存失败'));
  await idle(); await expectSelection(2);
  assert.deepEqual((await fixture('state')).settings, saved);
  check('unauthorized peers can be individually selected and a failed grant retains the selection for retry');

  const beforeGrant = (await requests()).length;
  await click(grantSelected);
  await stateMatches(state => state.settings.privatePeers.includes('wxid_bob') && state.settings.privatePeers.includes('wxid_alice'));
  await idle(); await expectSelection(0);
  saved = (await fixture('state')).settings;
  assert.deepEqual(saved.privatePeers, ['wxid_alice','wxid_authorized_only','wxid_bob']);
  assert.deepEqual(saved.groups, ['group_authorized_only@chatroom','group_beta@chatroom']);
  assert.equal((await requests()).length, beforeGrant + 1);
  check('selected grant authorizes only the two checked private peers and leaves unchecked contacts and groups untouched');

  await click(checkbox('wxid_alice')); await click(checkbox('wxid_li_ming')); await expectSelection(2);
  await click(grantSelected);
  await stateMatches(state => state.settings.privatePeers.includes('wxid_li_ming'));
  await idle(); await expectSelection(0);
  assert.deepEqual((await fixture('state')).settings.privatePeers, ['wxid_alice','wxid_authorized_only','wxid_bob','wxid_li_ming']);
  await click(checkbox('wxid_bob')); await click(checkbox('wxid_xiao_li')); await expectSelection(2);
  await click(revokeSelected);
  await stateMatches(state => !state.settings.privatePeers.includes('wxid_bob'));
  await idle(); await expectSelection(0);
  assert.deepEqual((await fixture('state')).settings.privatePeers, ['wxid_alice','wxid_authorized_only','wxid_li_ming']);
  check('mixed authorized/unauthorized selections support both actions; already-matching rows are harmless and unchecked rows stay unchanged');

  const beforeAllPrivate = (await requests()).length;
  await click(selectAll); await expectSelection(4);
  assert.equal((await requests()).length, beforeAllPrivate);
  assert.equal(await evaluate(selector => document.querySelector(selector).checked, selectAll), true);
  await click(grantSelected);
  await stateMatches(state => state.settings.privatePeers.length === 5);
  await idle(); await expectSelection(0);
  assert.deepEqual((await fixture('state')).settings.privatePeers, [...discoveredPrivate,'wxid_authorized_only'].sort());
  assert.deepEqual((await fixture('state')).settings.groups, ['group_authorized_only@chatroom','group_beta@chatroom']);
  assert.equal((await requests()).length, beforeAllPrivate + 1);
  await input(search, '李');
  await waitFor(() => document.querySelectorAll('.wa-session-list .wa-session-row').length === 2);
  await click(selectAll); await expectSelection(2); await click(revokeSelected);
  await stateMatches(state => state.settings.privatePeers.length === 3);
  await idle(); await expectSelection(0);
  assert.deepEqual((await fixture('state')).settings.privatePeers, ['wxid_alice','wxid_authorized_only','wxid_bob']);
  assert.deepEqual((await fixture('state')).settings.groups, ['group_authorized_only@chatroom','group_beta@chatroom']);
  check('discovery select-all grants only visible private peers; filtered select-all revocation excludes unmatched peers and groups');

  await input(search, ''); await clickText('全部', '.wa-filters'); await clickText('已授权');
  await click(selectAll); await expectSelection(5); await click(revokeSelected);
  await stateMatches(state => !state.settings.privatePeers.length && !state.settings.groups.length);
  await idle(); await expectSelection(0);
  assert.equal(await evaluate(selector => document.querySelector(selector).disabled, selectAll), true);
  assert.deepEqual((await fixture('state')).settings, {...original.settings,groups:[],privatePeers:[]});
  await clickText('发现会话'); await click(selectAll); await expectSelection(7); await click(grantSelected);
  await stateMatches(state => state.settings.privatePeers.length === 4 && state.settings.groups.length === 3);
  await idle(); await expectSelection(0);
  const restored = await fixture('state');
  assert.deepEqual(restored.settings.privatePeers, discoveredPrivate); assert.deepEqual(restored.settings.groups, discoveredGroups);
  assert.deepEqual(restored.conversations.filter(item => item.recordCount).map(item => ({ peerId:item.peerId,config:item.config,recordCount:item.recordCount })), retained);
  check('each tab supports explicit select-all before its batch action; undiscovered unselected peers, reply settings, records and conversation settings are preserved');

  await input('[data-testid="add-conversation-name"]', '李');
  await waitFor(() => document.querySelectorAll('.wa-name-suggestions .wa-session-row').length === 2);
  await click(suggestions + ' input[type="checkbox"]'); await expectSelection(2);
  await click(suggestions + ' [data-testid="authorization-revoke-selected"]');
  await stateMatches(state => !state.settings.privatePeers.includes('wxid_li_ming') && !state.settings.privatePeers.includes('wxid_xiao_li'));
  await idle(); await expectSelection(0);
  await click('.wa-name-suggestions [data-peer-id="wxid_li_ming"] input[type="checkbox"]'); await expectSelection(1);
  assert.equal(await evaluate(selector => document.querySelector(selector).indeterminate, suggestions + ' input[type="checkbox"]'), true);
  await click(suggestions + ' input[type="checkbox"]'); await expectSelection(2);
  await click(suggestions + ' [data-testid="authorization-grant-selected"]');
  await stateMatches(state => state.settings.privatePeers.length === 4);
  await idle(); await expectSelection(0);
  await assertLayout('supplementary search with selected authorization');
  await screenshot('authorization-selection-search-light', 'light');
  await input('[data-testid="add-conversation-name"]', '');
  check('supplementary search offers individual checkboxes, its own select-all, and both actions limited to explicit selections');

  await click(checkbox('group_alpha@chatroom')); await expectSelection(1);
  await click(row('group_alpha@chatroom') + ' [aria-label="撤销 产品讨论组 的授权"]');
  await stateMatches(state => !state.settings.groups.includes('group_alpha@chatroom'));
  await idle(); await expectSelection(0);
  await clickText('授权', row('group_alpha@chatroom'));
  await stateMatches(state => state.settings.groups.includes('group_alpha@chatroom'));
  await idle();
  assert.equal(await evaluate(selector => document.querySelector(selector).checked, checkbox('group_alpha@chatroom')), false);
  check('single-row actions remain usable and clear only their own selection after success');

  await click(selectAll); await expectSelection(7);
  await clickText('清空选择', main); await expectSelection(0);
  await click(row('wxid_bob') + ' [aria-label="撤销 Bob·设计同事 的授权"]');
  await stateMatches(state => !state.settings.privatePeers.includes('wxid_bob')); await idle();
  await click(checkbox('group_alpha@chatroom')); await click(checkbox('wxid_bob')); await expectSelection(2);
  await assertLayout('desktop authorization with selected-only actions');
  await screenshot('authorization-batch-desktop-light', 'light');
  await screenshot('authorization-batch-desktop-dark', 'dark');
  for (const width of [430,320]) {
    resize(width,940); await waitFor(width => window.innerWidth === width,[width]);
    await assertLayout('authorization selected-only controls at '+width);
    await screenshot('authorization-batch-'+width+'-light','light');
  }
  check('clear selection and all selection/actions fit desktop, 430px and 320px screens with no horizontal overflow');
  resize(1280,940);

  const firstAccountSettings = (await fixture('state')).settings;
  await fixture('holdNext',{endpoint:'settings'}); await click(revokeSelected);
  await waitFor(async () => (await window.__uiFixture('heldRequest',{endpoint:'settings'})).started);
  await fixture('switchAccount'); await fixture('releaseRequest',{endpoint:'settings'});
  await waitFor(() => document.querySelector('[aria-label="启用自动回复"]')?.checked === false && document.querySelector('#wa-authorization-tab-authorized .wa-tab-count')?.textContent === '2');
  await idle(); await expectSelection(0);
  assert.equal(await evaluate(() => document.querySelectorAll('.wa-session-select input:checked').length),0);
  assert.deepEqual((await fixture('stats')).firstAccountSettings,firstAccountSettings);
  assert.deepEqual((await fixture('state')).settings,{enabled:false,groups:['group_alpha@chatroom'],privatePeers:['wxid_alice'],prompt:'另一个账号的回复要求。'});
  check('switching accounts rejects an in-flight old-account change and clears selections even for shared peer IDs');

  await clickText('发现会话'); await clickText('私聊','.wa-filters');
  await waitFor(() => document.querySelectorAll('.wa-session-list .wa-session-row').length === 4);
  await click(checkbox('wxid_bob')); await click(grantSelected);
  await stateMatches(state => state.settings.privatePeers.length === 2); await idle(); await expectSelection(0);
  assert.equal((await requests()).at(-1).accountId,'wxid_ui_other');
  assert.deepEqual((await fixture('state')).settings.privatePeers,['wxid_alice','wxid_bob']);
  await click(selectAll); await expectSelection(4); await click(revokeSelected);
  await stateMatches(state => !state.settings.privatePeers.length); await idle(); await expectSelection(0);
  assert.deepEqual((await fixture('state')).settings,{enabled:false,groups:['group_alpha@chatroom'],privatePeers:[],prompt:'另一个账号的回复要求。'});
  assert.deepEqual((await fixture('stats')).firstAccountSettings,firstAccountSettings);
  check('subsequent grant and select-all revocation use only the current account and selected list, retaining its group authorization and paused reply state');
};
