import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaLibrary } from '../modules/media/library.mjs';
import { stickerReplyTools } from '../modules/media/sticker-tools.mjs';
import { stickerDescriptions } from '../modules/media/description.mjs';
import { planProgressiveTools } from '../modules/tools/progressive.mjs';
import { stickerPng as png, stickerDigest as md5 } from './fixtures/stickers.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sticker-tool-'));
  const store = { root, data: { storeId: 'fixture' } }, library = new MediaLibrary(store), accountId = 'sticker-tool-owner';
  const asset = library.saveWechatSticker(accountId, { md5: md5(png()), source: 'chat', content: png(),
    message: { peerId: 'private-source-never-return', chatType: 'private', id: 'private-message' } }).asset;
  library.edit(accountId, asset.id, { name: '点头', description: '点头表示赞同。', usage: '感谢别人帮忙、表示收到。', tags: ['赞同'] });
  const selected = [], guard = { allowed: true };
  const tools = stickerReplyTools(library, { accountId }, () => { if (!guard.allowed) throw Error('revoked'); }, value => selected.push(value), options);
  t.after(() => { library.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^wechat-sticker-tool-/); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (index, args) => JSON.parse(await tools[index].execute(args, { signal: new AbortController().signal }));
  return { library, accountId, asset, selected, tools, call, guard };
}

test('daily chat can read by scenario and stage one sticker without leaking chat identifiers or native resources', async t => {
  const f = fixture(t), result = await f.call(0, { action: 'search', query: '感谢' });
  assert.equal(result.assets.length, 1); assert.equal(result.assets[0].usage, '感谢别人帮忙、表示收到。');
  const raw = JSON.stringify(result); assert(!raw.includes('private-source')); assert(!raw.includes('private-message')); assert(!raw.includes(md5(png())));
  assert.equal(f.selected.length, 0);
  assert.equal((await f.call(1, { assetId: result.assets[0].id, caption: '谢谢啦' })).sent, false);
  assert.equal(f.selected[0].caption, '谢谢啦');
  await f.call(1, { assetId: result.assets[0].id }); assert.equal(f.selected.length, 1);
  const plan = planProgressiveTools(f.tools, '谢谢你，今天很开心');
  assert.deepEqual(plan.initial.map(tool => tool.name), ['wechat_sticker_read', 'wechat_sticker_send']);
});
test('send requires an actually read asset and rechecks enabled state and account ownership', async t => {
  const f = fixture(t);
  assert.equal((await f.call(1, { assetId: f.asset.id })).code, 'STICKER_READ_REQUIRED');
  await f.call(0, { action: 'read', assetId: f.asset.id });
  f.library.edit(f.accountId, f.asset.id, { enabled: false });
  assert.equal((await f.call(1, { assetId: f.asset.id })).ok, false); assert.equal(f.selected.length, 0);
  const foreign = stickerReplyTools(f.library, { accountId: 'other' }, () => {}, () => assert.fail('must not select'));
  assert.equal(JSON.parse(await foreign[0].execute({ action: 'read', assetId: f.asset.id }, {})).ok, false);
});
test('cooldown permits lookup but blocks spontaneous sending, while explicit requests can ask for random stickers', async t => {
  const f = fixture(t, { cooldown: true });
  assert.equal((await f.call(0, { action: 'random' })).canSend, false);
  assert.equal((await f.call(1, { assetId: f.asset.id })).code, 'STICKER_COOLDOWN');
  const explicit = fixture(t, { cooldown: true, explicitRequest: true });
  await explicit.call(0, { action: 'random' }); assert.equal((await explicit.call(1, { assetId: explicit.asset.id })).ok, true);
});
test('unlabeled stickers cannot be used spontaneously and revoked tools cannot stage a message', async t => {
  const f = fixture(t); f.library.edit(f.accountId, f.asset.id, { description: '', usage: '' });
  assert.equal((await f.call(0, { action: 'read', assetId: f.asset.id })).assets[0].understood, false);
  assert.equal((await f.call(1, { assetId: f.asset.id })).code, 'STICKER_UNDERSTANDING_REQUIRED');
  f.guard.allowed = false; assert.equal((await f.call(0, { action: 'search' })).ok, false); assert.equal(f.selected.length, 0);
});
test('sticker description protocol rejects swapped counts, empty usage and invalid labels instead of saving guessed metadata', () => {
  const valid = { name: '方块', description: '红色方块', usage: '颜色话题', tags: ['红'] };
  assert.deepEqual(stickerDescriptions(JSON.stringify([valid]), 1), [valid]);
  for (const value of [[], [valid, valid], [{ ...valid, usage: '' }], [{ ...valid, tags: ['x'.repeat(41)] }], ['猜测']])
    assert.throws(() => stickerDescriptions(JSON.stringify(value), 1), { code: 'STICKER_DESCRIPTION_INVALID' });
});
