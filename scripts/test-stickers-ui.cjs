const assert = require('node:assert/strict');

module.exports = async function verifyStickers({ evaluate, waitFor, click, clickText, input, fixture, screenshot, assertLayout, check, resize }) {
  const dialog = '[role="dialog"][aria-label="编辑素材"]';
  const card = id => '.wa-asset-card[data-asset-id="' + id + '"]';
  const open = async asset => {
    await click(card(asset.id) + ' .wa-asset-open');
    await waitFor(selector => { const image = document.querySelector(selector + ' .wa-assets-large-preview img'); return image?.complete && image.naturalWidth > 0; }, [dialog]);
  };
  await click('[data-testid="nav-assets"]');
  await waitFor(async () => { const data = await window.__uiFixture('assets'); return data.total === 3 && data.items.every(asset => asset.bytes > 0 && asset.usage); });
  await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 3 && [...document.querySelectorAll('.wa-asset-card img')].every(img => img.complete && img.naturalWidth > 0));
  await waitFor(() => [...document.querySelectorAll('.wa-asset-card')].every(card => card.textContent.includes('适合轻松回应')));
  let data = await fixture('assets'); assert.equal(data.counts.favorites, 2); assert.equal(data.counts.collected, 1);
  assert.equal(await evaluate(() => !!document.querySelector('[data-testid="builtin-sticker-packs"]')), false);
  check('native favorites and an authorized chat sticker automatically persist with real PNG/GIF previews and scenario descriptions');
  await assertLayout('stickers desktop'); await screenshot('stickers-desktop-light', 'light'); await screenshot('stickers-desktop-dark');

  await clickText('微信收藏', '.wa-sticker-sources'); await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 2);
  await clickText('聊天收集', '.wa-sticker-sources'); await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 1);
  const collected = data.items.find(asset => asset.sourceMessage); await open(collected);
  await input('[aria-label="素材名称"]', '自己的聊天表情');
  await input('[aria-label="素材含义"]', '我核对过的表情含义'); await input('[aria-label="表情适用情景"]', '朋友分享好消息时表达开心，避免严肃讨论。');
  await fixture('failNext', { endpoint: 'assets.edit' }); await clickText('保存素材', dialog);
  await waitFor(selector => document.querySelector(selector + ' [role="alert"]')?.textContent.includes('模拟保存失败'), [dialog]);
  assert.equal(await evaluate(() => document.querySelector('[aria-label="表情适用情景"]').value), '朋友分享好消息时表达开心，避免严肃讨论。');
  await clickText('保存素材', dialog); await waitFor(selector => !document.querySelector(selector), [dialog]);
  await open({ id: collected.id }); await clickText('收藏到微信', dialog); await waitFor(selector => !document.querySelector(selector), [dialog]);
  assert.equal((await fixture('assets')).counts.favorites, 3);
  assert.equal((await fixture('assets')).items.find(asset => asset.id === collected.id).usage, '朋友分享好消息时表达开心，避免严肃讨论。');
  await clickText('全部素材', '.wa-sticker-sources');
  await input('[aria-label="搜索表情或图片"]', '分享好消息'); await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 1);
  await input('[aria-label="搜索表情或图片"]', ''); await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 3);
  check('source filters, scenario search, persistent manual edits, save failure recovery and confirmed native collection work through owner RPC');

  await clickText('随机试发'); await waitFor(async () => (await window.__uiFixture('stickerState')).sends.length === 1);
  await waitFor(() => document.querySelector('.wa-assets-notice')?.textContent.includes('已收到微信确认') || document.body.textContent.includes('已收到微信确认'));
  const first = await fixture('stickerState'); assert.equal(first.sends[0].peerId, 'filehelper'); assert.equal(first.sends[0].native, true);
  await fixture('stickerFailure', { send: true }); await clickText('随机试发');
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('结果不明'));
  assert.equal((await fixture('stickerState')).sends.length, 2); assert.equal((await fixture('stickerState')).records.at(-1).state, 'unknown');
  await fixture('stickerFailure', { read: true }); await clickText('同步微信收藏');
  await waitFor(() => document.body.textContent.includes('合成微信收藏暂不可用'));
  assert.equal((await fixture('assets')).total, 3);
  await fixture('stickerFailure', {}); await clickText('同步微信收藏');
  await waitFor(() => document.body.textContent.includes('已同步 3 张'));
  check('random test sends target filehelper with native metadata; unknown ACKs are not retried and failed sync retains saved stickers');

  data = await fixture('assets'); const gif = data.items.find(asset => asset.mediaType === 'image/gif'); assert(gif);
  await open(gif); await waitFor(selector => { const image = document.querySelector(selector + ' .wa-assets-large-preview img'); return image?.complete && image.src.startsWith('data:image/gif;base64,'); }, [dialog]);
  await assertLayout('sticker GIF editor desktop'); await screenshot('sticker-editor-desktop-light', 'light'); await clickText('关闭', dialog);
  await click('[data-testid="asset-settings"] summary');
  assert.equal(await evaluate(() => !!document.querySelector('[aria-label="素材自动使用概率"]')), false);
  await input('[aria-label="素材最少消息间隔"]', '5'); await clickText('保存使用设置');
  await waitFor(async () => (await window.__uiFixture('assets')).settings.minGapMessages === 5);
  for (const [width, height, theme] of [[430, 900, 'light'], [320, 850, 'dark']]) {
    resize(width, height); await waitFor(width => innerWidth === width, [width]);
    await assertLayout('sticker library ' + width); await screenshot('stickers-' + width + '-' + theme, theme);
    await open({ id: collected.id }); await assertLayout('sticker editor ' + width); await screenshot('sticker-editor-' + width + '-' + theme, theme); await clickText('关闭', dialog);
  }
  check('native GIF originals remain animated in the editor, model decides usage without probability controls, and 320/430px layouts fit');

  await click(card(gif.id) + ' input[type="checkbox"]'); await clickText('删除选中'); await clickText('确认删除素材');
  await waitFor(() => document.querySelectorAll('.wa-asset-card').length === 2); await clickText('同步微信收藏');
  await waitFor(() => document.body.textContent.includes('本机已移除的表情保持移除'));
  assert(!(await fixture('assets')).items.some(asset => asset.id === gif.id));
  await open({ id: collected.id }); await fixture('switchAccount');
  await waitFor(selector => !document.querySelector(selector) && document.querySelectorAll('.wa-asset-card').length === 0, [dialog]);
  assert.equal((await fixture('assets')).total, 0);
  check('deleted favorites are not resurrected by sync and account switches clear the library and open editor');
};
