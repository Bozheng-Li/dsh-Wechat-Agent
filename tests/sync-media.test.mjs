import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../backend/storage/state-store.mjs';
import { MediaLibrary } from '../modules/media/library.mjs';
import { selectStickerCandidates } from '../modules/media/sticker-candidates.mjs';

test('library returns ranked pre-read stickers only from enabled packs and items', () => {
  const store = Object.create(StateStore.prototype);
  const library = Object.create(MediaLibrary.prototype);
  library.store = store;
  library.data = { accounts: { owner: { settings: { enabled: true }, packs: { active: { enabled: true }, paused: { enabled: false } }, assets: [
    { id: 'favorite', kind: 'sticker', name: '感谢', description: '点头', usage: '谢谢', tags: ['工作'], enabled: true, packId: 'active', nativeSticker: { favorite: true } },
    { id: 'disabled', kind: 'sticker', name: '谢谢', description: '点头', usage: '谢谢', tags: [], enabled: false, packId: 'active' },
    { id: 'paused-pack', kind: 'sticker', name: '谢谢', description: '点头', usage: '谢谢', tags: [], enabled: true, packId: 'paused' },
    { id: 'undescribed', kind: 'sticker', name: 'unknown', description: '', usage: '', tags: [], enabled: true, packId: 'active' },
  ] } } };
  assert.deepEqual(library.replyStickerCandidates('owner', { text: '谢谢你，辛苦了', limit: 4 }).candidates.map(row => row.id), ['favorite']);
  assert.deepEqual(library.replyStickerCandidates('owner', { explicitRequest: true, text: '未知', limit: 4 }).candidates.map(row => row.id).sort(), ['favorite', 'undescribed'].sort());
  library.data.accounts.owner.settings.enabled = false;
  assert.equal(library.replyStickerCandidates('owner').eligibleCount, 0);
});

test('candidate ranking favors current use and usage metadata without sending an asset', () => {
  const assets = [
    { id: 'context', kind: 'sticker', name: '点头', description: '', usage: '工作时表示收到', tags: [], nativeSticker: { favorite: true } },
    { id: 'current', kind: 'sticker', name: '谢谢', description: '感谢', usage: '适合感谢', tags: [] },
  ];
  const result = selectStickerCandidates(assets, { text: '谢谢辛苦了', history: [{ text: '这个工作已经收到' }], limit: 2, random: () => 0 });
  assert.equal(result.candidates[0].id, 'context', 'a favorite is preferred when the two candidates have equal relevance');
  assert.equal(result.candidates[1].id, 'current');
  assert.equal(result.relevantCount, 2);
});
