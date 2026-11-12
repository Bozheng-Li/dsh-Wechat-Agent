const assert = require('node:assert/strict');

module.exports = async function verifyAutomation({ evaluate, waitFor, click, clickText, input, fixture, screenshot, assertLayout, check, resize }) {
  const snapshot = () => fixture('automationState');
  const checked = label => evaluate(label => document.querySelector('[aria-label="' + label + '"]')?.checked, label);
  const usable = label => waitFor(label => {
    const node = document.querySelector('[aria-label="' + label + '"]'); return !!node && !node.disabled && !node.closest('fieldset:disabled');
  }, [label]);
  const flip = async label => { await usable(label); await click('[aria-label="' + label + '"]'); };
  const expand = async id => {
    const selector = '[data-testid="automation-group-' + id + '"]';
    if (!await evaluate(selector => document.querySelector(selector).open, selector)) await click(selector + ' > summary');
    await waitFor(selector => !!document.querySelector(selector + ' .wa-automation-group-body'), [selector]);
  };
  const open = async () => {
    await click('[data-testid="nav-settings"]'); await click('[data-testid="open-automation"]');
    await usable('启用自动回复');
    assert.equal(await evaluate(() => document.querySelector('[data-testid="nav-settings"]').getAttribute('aria-current')), 'page');
  };
  const unchanged = (before, after, changed = []) => {
    for (const [key, value] of Object.entries(before)) if (!changed.includes(key)) assert.deepEqual(after[key], value, 'Preserve ' + key);
  };
  const before = await snapshot();
  await open();
  for (const id of ['moments-replies', 'moments-likes', 'moments-interactions', 'moments-publishing', 'moments-materials', 'media', 'roles', 'images']) await expand(id);
  for (const label of ['回复自己朋友圈里的评论', '自动接续好友朋友圈对话', '开启定时点赞', '启用自动朋友圈互动', '开启朋友圈自动发布',
    '按每天次数自动生成发布计划', '自动整理朋友圈素材', '允许图片和表情回复', '自动收集聊天表情', '自动整理表情含义与情景',
    '自动整理角色卡', '保存此会话的图片', '保存此会话的生成图片']) await usable(label);
  assert.equal(await checked('回复自己朋友圈里的评论'), before.moments.settings.enabled);
  assert.equal(await checked('开启定时点赞'), before.likes.settings.enabled);
  assert.equal(await checked('启用自动朋友圈互动'), before.interactions.automation.settings.enabled);
  assert.equal(await checked('开启朋友圈自动发布'), before.moments.publishing.settings.enabled);
  assert.equal(await checked('自动整理朋友圈素材'), before.materials.settings.enabled);
  assert.equal(await checked('自动整理角色卡'), before.role.settings.enabled);
  const loaded = await snapshot();
  for (const key of ['media', 'role']) assert.deepEqual(loaded[key], before[key]);
  for (const key of ['moments', 'likes', 'materials']) assert.deepEqual(loaded[key].settings, before[key].settings);
  check('all automatic controls load existing settings without enabling defaults');
  await screenshot('automation-desktop-light', 'light'); await assertLayout('automation desktop');

  await flip('启用自动回复'); await waitFor(() => !document.querySelector('[aria-label="启用自动回复"]').checked);
  const paused = (await snapshot()).status;
  assert.equal(paused.settings.enabled, false); unchanged(before.status.settings, paused.settings, ['enabled']);
  await flip('启用自动回复'); await waitFor(() => document.querySelector('[aria-label="启用自动回复"]').checked && !document.querySelector('[aria-label="启用自动回复"]').disabled);
  assert.equal((await snapshot()).status.settings.enabled, true);
  check('the master switch saves without changing authorized conversations');

  await flip('自动整理角色卡'); await input('#wa-role-message-threshold', '21');
  await fixture('failNext', { endpoint: 'memory.role.configure' }); await clickText('保存角色卡总设置');
  await waitFor(() => document.querySelector('[data-testid="role-card-settings"] [role="alert"]')?.textContent.includes('模拟保存失败'));
  assert.equal(await checked('自动整理角色卡'), false); assert.equal((await snapshot()).role.settings.enabled, true);
  await clickText('保存角色卡总设置');
  await waitFor(() => document.querySelector('[data-testid="role-card-settings"] [role="status"]')?.textContent.includes('已关闭'));
  let saved = await snapshot(); assert.equal(saved.role.settings.enabled, false); assert.equal(saved.role.settings.messageThreshold, 21);
  unchanged(before.role.settings, saved.role.settings, ['enabled', 'messageThreshold']);
  check('failed saves keep drafts and retry persists role settings while preserving intervals');

  for (const label of ['允许图片和表情回复', '优先发送微信原生表情', '自动收集聊天表情', '自动整理表情含义与情景']) await flip(label);
  await input('[aria-label="素材最少消息间隔"]', '7'); await clickText('保存使用设置');
  await waitFor(() => document.querySelector('[data-testid="asset-settings"] [role="status"]')?.textContent.includes('已保存'));
  saved = await snapshot();
  for (const key of ['enabled', 'preferNative', 'captureIncoming', 'autoDescribe']) assert.equal(saved.media[key], !before.media[key]);
  assert.equal(saved.media.minGapMessages, 7); unchanged(before.media, saved.media, ['enabled', 'preferNative', 'captureIncoming', 'autoDescribe', 'minGapMessages']);
  await open(); await expand('media'); await usable('自动收集聊天表情'); assert.equal(await checked('自动收集聊天表情'), false);
  check('media controls save together and retain their values after leaving and reopening settings');

  await expand('moments-replies'); await flip('回复自己朋友圈里的评论'); await flip('自动接续好友朋友圈对话');
  await input('[aria-label="自己朋友圈每轮最多尝试回复"]', '3'); await input('[aria-label="好友对话每轮最多尝试回复"]', '2');
  await input('[aria-label="定时评论回复要求"]', '简短自然，保留当前话题。'); await clickText('保存定时设置');
  await waitFor(() => document.querySelector('[data-testid="moments-reply-settings"] [role="status"]')?.textContent.includes('已保存'));
  saved = await snapshot(); assert.equal(saved.moments.settings.enabled, true); assert.equal(saved.moments.settings.friendRepliesEnabled, true);
  unchanged(before.moments.settings, saved.moments.settings, ['enabled', 'friendRepliesEnabled', 'maxRepliesPerRun', 'maxFriendRepliesPerRun', 'replyInstructions']);
  check('own and friend comment replies save independently from time settings');

  await expand('moments-likes'); await usable('开启定时点赞');
  await click('[aria-label="自动点赞好友 Alice·产品同事 wxid_alice"]'); await flip('开启定时点赞'); await flip('响应聊天点赞请求'); await clickText('保存点赞设置');
  await waitFor(() => document.querySelector('[data-testid="moments-likes-settings"] [role="status"]')?.textContent.includes('已保存'));
  saved = await snapshot(); assert.equal(saved.likes.settings.enabled, true); assert.deepEqual(saved.likes.settings.userIds, ['wxid_alice']); assert.equal(saved.likes.settings.respondToRequests, false);
  unchanged(before.likes.settings, saved.likes.settings, ['enabled', 'userIds', 'respondToRequests']);
  check('selected-friend automatic likes preserve quotas and separate chat requests');

  await expand('moments-interactions'); await flip('启用自动朋友圈互动');
  await input('[aria-label="自动每轮点赞条数"]', '2'); await input('[aria-label="自动每轮评论条数"]', '0'); await clickText('保存自动设置');
  await waitFor(() => document.querySelector('[data-testid="moments-interaction-automation"] [role="status"]')?.textContent.includes('已保存'));
  saved = await snapshot(); assert.equal(saved.interactions.automation.settings.enabled, true);
  assert.equal(saved.interactions.automation.settings.likeCount, 2); assert.equal(saved.interactions.automation.settings.commentCount, 0);
  unchanged(before.interactions.automation.settings, saved.interactions.automation.settings, ['enabled', 'likeCount', 'commentCount', 'poolSize']);
  check('automatic interactions save through their existing revision checks');

  await expand('moments-publishing'); await flip('开启朋友圈自动发布'); await flip('按每天次数自动生成发布计划');
  await input('[aria-label="每天自动安排条数"]', '1'); await clickText('保存自动发布设置');
  await waitFor(() => document.querySelector('[data-testid="moments-publishing-settings"] [role="status"]')?.textContent.includes('已保存'));
  saved = await snapshot(); assert.equal(saved.moments.publishing.settings.enabled, true); assert.equal(saved.moments.publishing.settings.automatic.enabled, true);
  unchanged(before.moments.publishing.settings, saved.moments.publishing.settings, ['enabled', 'automatic']);
  unchanged(before.moments.publishing.settings.automatic, saved.moments.publishing.settings.automatic, ['enabled', 'dailyCount']);
  check('publishing controls generate plans and keep automatic time and content values');

  await expand('moments-materials'); await flip('自动整理朋友圈素材'); await flip('允许素材按需联网取图'); await flip('允许素材按需生图');
  await click('[aria-label="素材取材 产品讨论组"]'); await clickText('保存取材设置');
  await waitFor(() => document.querySelector('[data-testid="moments-material-settings"] [role="status"]')?.textContent.includes('已保存'));
  saved = await snapshot(); assert.equal(saved.materials.settings.enabled, true); assert.equal(saved.materials.settings.webImagesEnabled, true); assert.equal(saved.materials.settings.generatedImagesEnabled, true);
  assert.deepEqual(saved.materials.settings.sources, [{ chatType: 'group', peerId: 'group_alpha@chatroom' }]);
  unchanged(before.materials.settings, saved.materials.settings, ['enabled', 'webImagesEnabled', 'generatedImagesEnabled', 'sources']);
  check('material automation, image tools and source selection save without changing time limits');

  await expand('images'); await input('#wa-automation-image-conversation', 'group:group_beta@chatroom'); await usable('保存此会话的图片');
  await flip('保存此会话的图片'); await clickText('保存图片记忆设置', '[data-testid="image-memory-settings-conversation"]');
  await waitFor(() => document.querySelector('[data-testid="image-memory-settings-conversation"] [role="status"]')?.textContent.includes('已保存'));
  assert.equal((await fixture('imageMemory', { peerId: 'group_beta@chatroom' })).settings.enabled, false);
  assert.equal((await fixture('imageMemory', { peerId: 'group_alpha@chatroom' })).settings.enabled, true);
  assert.equal((await fixture('imageMemory', { peerId: 'group_beta@chatroom', collection: 'generated' })).settings.enabled, true);
  check('image-save switches isolate received images, generated images and selected conversations');

  await click('[data-testid="nav-authorization"]');
  assert.equal(await evaluate(() => !!document.querySelector('[aria-label="启用自动回复"]')), false);
  await clickText('自动功能设置'); await usable('启用自动回复'); await clickText('返回会话授权');
  await click('[data-testid="nav-moments"]');
  for (const [tab, label] of [['好友动态', '开启定时点赞'], ['点赞评论', '启用自动朋友圈互动'], ['自动发布', '开启朋友圈自动发布'], ['定时回复', '回复自己朋友圈里的评论'], ['素材库', '自动整理朋友圈素材']]) {
    await clickText(tab, '[aria-label="朋友圈功能"]');
    assert.equal(await evaluate(label => !!document.querySelector('[aria-label="' + label + '"]'), label), false);
  }
  await clickText('取材与自动整理设置'); await waitFor(() => document.querySelector('[data-testid="automation-group-moments-materials"]')?.open);
  await click('[data-testid="nav-assets"]'); await waitFor(() => !!document.querySelector('.wa-library-page .wa-subsection'));
  assert.equal(await evaluate(() => !!document.querySelector('[aria-label="自动收集聊天表情"]')), false);
  await clickText('素材自动设置'); await usable('自动收集聊天表情');
  await click('[data-testid="nav-memory"]'); await clickText('会话图片记忆');
  await input('#wa-memory-panel-images [aria-label="选择会话"]', 'group:group_beta@chatroom');
  await waitFor(() => !!document.querySelector('#wa-memory-panel-images .wa-image-settings'));
  assert.equal(await evaluate(() => !!document.querySelector('#wa-memory-panel-images [aria-label="保存此会话的图片"]')), false);
  await clickText('图片自动保存设置', '#wa-memory-panel-images'); await usable('保存此会话的图片');
  assert.equal(await evaluate(() => document.querySelector('#wa-automation-image-conversation').value), 'group:group_beta@chatroom');
  assert.equal(await checked('保存此会话的图片'), false);
  check('old pages retain status and shortcuts; the image shortcut carries the selected conversation');

  await open(); for (const id of ['moments-replies', 'moments-likes', 'moments-interactions', 'moments-publishing', 'moments-materials', 'media', 'roles', 'images']) await expand(id);
  for (const [width, theme] of [[430, 'light'], [430, 'dark'], [320, 'light']]) {
    resize(width, 900); await screenshot('automation-' + width + '-' + theme, theme); await assertLayout('automation ' + width + ' ' + theme);
  }
  check('expanded automation groups fit desktop, 430px and 320px layouts in both themes');
  await fixture('switchAccount'); await waitFor(() => !document.querySelector('[aria-label="启用自动回复"]').checked);
  const other = await snapshot(); assert.equal(other.status.account.id, 'wxid_ui_other'); assert.equal(other.media.enabled, true); assert.equal(other.moments.settings.enabled, false);
  await expand('roles'); await usable('自动整理角色卡'); assert.equal(await checked('自动整理角色卡'), false);
  await expand('images'); assert.equal(await evaluate(() => document.querySelector('#wa-automation-image-conversation').value), '');
  assert.equal(await evaluate(() => !!document.querySelector('[aria-label="保存此会话的图片"]')), false);
  assert.deepEqual(await fixture('momentWrites'), []);
  check('account changes clear previous account and conversation settings, preserve globals and send no WeChat messages');
};
