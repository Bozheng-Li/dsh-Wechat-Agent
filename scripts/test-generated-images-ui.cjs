const assert = require('node:assert/strict');

module.exports = async function verifyGeneratedImages({ evaluate, waitFor, click, clickText, input, fixture,
  screenshot, assertLayout, check, resize }) {
  const received = '#wa-memory-panel-images', generated = '#wa-memory-panel-generated-images',
    dialog = '[role="dialog"][aria-label="生成图片记忆预览"]',
    search = generated + ' [aria-label="搜索生成图片记忆"]',
    retention = generated + ' [aria-label="生成图片记忆保留天数"]',
    enabled = generated + ' [aria-label="保存此会话的生成图片"]';
  const memory = (collection = 'generated', peerId = 'group_alpha@chatroom', chatType = 'group') => fixture('imageMemory', { collection, peerId, chatType });
  const choose = async (panel, choice) => {
    const selector = panel + ' [aria-label="选择会话"]';
    await waitFor(selector => isUsable(document.querySelector(selector)), [selector]);
    if (await evaluate(selector => document.querySelector(selector).value, selector) !== choice) await input(selector, choice);
  };
  const count = (panel, expected) => waitFor((panel, expected) => isVisible(document.querySelector(panel)) &&
    document.querySelectorAll(panel + ' [data-image-memory-id]').length === expected, [panel, expected]);
  const card = (panel, id) => panel + ' [data-image-memory-id="' + id + '"]';
  const rendered = selector => waitFor(selector => { const image = document.querySelector(selector); return isVisible(image) && image.complete && image.naturalWidth > 0; }, [selector]);
  const save = () => clickText('保存图片记忆设置', generated);
  const receivedSamples = await fixture('seedImageMemory'), generatedSamples = await fixture('seedGeneratedImageMemory');
  const alphaReceived = receivedSamples.find(item => item.scope.peerId === 'group_alpha@chatroom');
  assert.equal((await memory()).storedCount, 0, 'seeding tasks must leave backfill to the actual owner RPC');

  await click('[data-testid="nav-memory"]'); await clickText('会话图片记忆');
  await choose(received, 'group:group_alpha@chatroom'); await count(received, 1);
  assert(await evaluate(selector => isVisible(document.querySelector(selector)), card(received, alphaReceived.id)));
  await clickText('生成图片记忆'); await choose(generated, 'group:group_alpha@chatroom'); await count(generated, 2);
  let doc = await memory();
  assert(doc.items.every(item => item.generation && !item.description));
  assert(!doc.items.some(item => item.id === alphaReceived.id));
  assert.notEqual(doc.path, (await memory('conversation')).path);
  const alpha = doc.items.find(item => item.generation.fileName === 'ALPHA_PORTRAIT.png');
  await rendered(card(generated, alpha.id) + ' img');
  const sourceText = await evaluate(panel => document.querySelector(panel).textContent, generated);
  assert(sourceText.includes('生成要求：') && sourceText.includes('fixture-image-v1'));
  assert(sourceText.includes('微信已确认发送') && sourceText.includes('尚未确认发送'));
  check('separate tabs use actual owner RPC backfill and show generated provenance without inventing a visual description');

  const quotes = await fixture('seedQuotedRecords');
  await click('[data-testid="nav-records"]'); await click('.wa-records-peer[data-peer-id="group_alpha@chatroom"]');
  for (const key of quotes.keys) {
    const selector = '[data-record-key="' + key + '"]';
    await waitFor(selector => isVisible(document.querySelector(selector)), [selector]);
    await click(selector + ' > summary');
    await waitFor(selector => isVisible(document.querySelector(selector + ' [data-testid="record-message-references"]')), [selector]);
  }
  const quoteText = await evaluate(() => [...document.querySelectorAll('[data-testid="record-message-references"]')].map(element => element.textContent).join('\n'));
  assert(quoteText.includes('明天 14:30 在 A203')); assert(quoteText.includes('9007199254740999'));
  assert(quoteText.includes('image-memory://conversation/' + quotes.receivedId));
  assert(quoteText.includes('image-memory://generated/' + quotes.generatedId)); assert(quoteText.includes('实际为蓝色方块'));
  assert(!quoteText.includes('wechat_generated_image_memory') && !quoteText.includes('resourceId'));
  await assertLayout('quoted records desktop'); await screenshot('quoted-message-records-desktop-light', 'light');
  resize(320, 850); await waitFor(() => window.innerWidth === 320);
  await assertLayout('quoted records 320px'); await screenshot('quoted-message-records-320-light', 'light');
  resize(1280, 900); await waitFor(() => window.innerWidth === 1280);
  check('record details retain quoted text, exact original IDs, both image locations and updated descriptions at desktop and 320px widths');
  await click('[data-testid="nav-memory"]'); await clickText('生成图片记忆');
  await choose(generated, 'group:group_alpha@chatroom'); await count(generated, 2);

  await input(search, 'ALPHA_PORTRAIT.png'); await count(generated, 1);
  await input(search, 'fixture-image-v1'); await count(generated, 2);
  await input(search, '不存在的生成图片'); await count(generated, 0);
  await waitFor(panel => document.querySelector(panel).textContent.includes('没有匹配的图片'), [generated]);
  await input(search, ''); await count(generated, 2);
  await assertLayout('generated images desktop'); await screenshot('generated-images-desktop-dark'); await screenshot('generated-images-desktop-light', 'light');
  check('generated image search handles filenames, model metadata and empty matches');

  await evaluate(selector => document.querySelector(selector).focus(), card(generated, alpha.id) + ' .wa-image-open');
  await click(card(generated, alpha.id) + ' .wa-image-open'); await rendered(dialog + ' .wa-image-preview');
  const pixel = await evaluate(selector => {
    const img = document.querySelector(selector), canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  }, dialog + ' .wa-image-preview');
  assert.deepEqual(pixel, [36, 120, 220, 255]);
  await waitFor(() => document.activeElement?.textContent.trim() === '关闭图片预览');
  await screenshot('generated-image-preview-desktop-light', 'light');
  await clickText('关闭图片预览', dialog);
  await waitFor(selector => document.activeElement === document.querySelector(selector), [card(generated, alpha.id) + ' .wa-image-open']);
  check('preview decodes the saved generated PNG pixels and returns focus to the original card');

  await input(retention, '7'); await fixture('failNext', { endpoint: 'memory.images.configure' }); await save();
  await waitFor(panel => document.querySelector(panel)?.textContent.includes('模拟保存失败'), [generated]);
  assert.equal((await memory()).settings.retentionDays, 30); await save();
  await waitFor(async () => (await window.__uiFixture('imageMemory', { collection: 'generated' })).settings.retentionDays === 7);
  assert.deepEqual((await memory('conversation')).settings, { enabled: true, retentionDays: 30 });
  await click(enabled); await save();
  await waitFor(async () => !(await window.__uiFixture('imageMemory', { collection: 'generated' })).settings.enabled);
  await fixture('seedGeneratedImageMemory', { additional: true });
  await clickText('重新读取图片记忆', generated); await count(generated, 2);
  assert.equal((await memory()).storedCount, 2);
  assert.equal(await evaluate(panel => [...document.querySelectorAll(panel + ' button')].find(button => button.textContent.trim() === '补充已有生成图片').disabled, generated), true);
  await click(enabled); await save(); await count(generated, 3);
  await clickText('补充已有生成图片', generated);
  await waitFor(panel => document.querySelector(panel).textContent.includes('保存已结束：新增 0 张'), [generated]);
  check('generated settings are independent, save failures preserve stored settings, disabled saving stops backfill and repeats deduplicate');

  for (const [choice, peerId, chatType, label] of [['group:group_beta@chatroom', 'group_beta@chatroom', 'group', 'BETA_GENERATED'],
    ['private:wxid_alice', 'wxid_alice', 'private', 'PRIVATE_GENERATED']]) {
    await choose(generated, choice); await count(generated, 1);
    doc = await memory('generated', peerId, chatType);
    assert.equal(doc.items[0].generation.fileName, label + '.png');
    assert.equal(doc.settings.retentionDays, 30);
    assert(!await evaluate(selector => !!document.querySelector(selector), card(generated, alpha.id)));
  }
  await choose(generated, 'group:group_alpha@chatroom'); await count(generated, 3);
  check('group and private-chat libraries keep their own images and retention settings');

  for (const [width, height, theme] of [[430, 900, 'light'], [320, 850, 'dark']]) {
    resize(width, height); await waitFor(width => window.innerWidth === width, [width]);
    await assertLayout('generated images ' + width); await screenshot('generated-images-' + width + '-' + theme, theme);
    await click(card(generated, alpha.id) + ' .wa-image-open'); await rendered(dialog + ' .wa-image-preview');
    await assertLayout('generated preview ' + width); await screenshot('generated-image-preview-' + width + '-' + theme, theme);
    await clickText('关闭图片预览', dialog);
  }
  check('320px and 430px generated lists and previews remain usable without horizontal overflow');

  await click(card(generated, alpha.id) + ' .wa-image-open'); await rendered(dialog + ' .wa-image-preview');
  await clickText('删除这张图片记忆', dialog); await fixture('failNext', { endpoint: 'memory.images.delete' });
  await clickText('确认删除图片记忆', dialog);
  await waitFor(selector => document.querySelector(selector + ' .wa-image-delete [role="alert"]')?.textContent.includes('模拟保存失败'), [dialog]);
  assert((await memory()).items.some(item => item.id === alpha.id));
  await clickText('确认删除图片记忆', dialog); await count(generated, 2);
  await clickText('补充已有生成图片', generated); await count(generated, 2);
  assert(!(await memory()).items.some(item => item.id === alpha.id));
  assert.equal((await memory('conversation')).storedCount, 1);
  assert((await fixture('generatedImageFiles')).every(item => item.originalExists && item.archiveExists));
  check('failed deletion stays visible; successful deletion removes only the memory copy and backfill cannot resurrect it');

  await click(generated + ' details summary'); await clickText('清空此会话的生成图片记忆', generated);
  await clickText('确认清空图片记忆', generated); await count(generated, 0);
  await clickText('补充已有生成图片', generated); await count(generated, 0);
  assert.equal((await memory()).storedCount, 0);
  assert.equal((await memory('generated', 'group_beta@chatroom')).storedCount, 1);
  assert.equal((await memory('conversation')).storedCount, 1);
  await clickText('会话图片记忆'); await count(received, 1);
  assert(await evaluate(selector => isVisible(document.querySelector(selector)), card(received, alphaReceived.id)));
  check('clearing generated memory keeps received images, other conversations and original task files');

  await clickText('生成图片记忆'); await choose(generated, 'group:group_beta@chatroom'); await count(generated, 1);
  const beta = (await memory('generated', 'group_beta@chatroom')).items[0];
  await click(card(generated, beta.id) + ' .wa-image-open'); await rendered(dialog + ' .wa-image-preview');
  await fixture('switchAccount');
  await waitFor(selector => document.querySelector('#wa-memory-tab-conversation')?.getAttribute('aria-selected') === 'true' &&
    !document.querySelector(selector) && document.querySelectorAll('[data-image-memory-id]').length === 0, [dialog]);
  assert.equal(await evaluate(() => document.body.textContent.includes('ALPHA_PORTRAIT') || document.body.textContent.includes('BETA_GENERATED')), false);
  await click('[data-testid="nav-overview"]');
  await waitFor(() => document.querySelector('.wa-account-name')?.textContent.includes('另一账号'));
  assert.equal(generatedSamples.length, 4);
  check('switching accounts clears both image collections, drafts and the open preview');
};
