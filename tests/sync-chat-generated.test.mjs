import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../backend/storage/state-store.mjs';
import { ImageMemory } from '../modules/memory/images/store.mjs';
import { captureChatGeneratedImage, acknowledgeChatGeneratedImage } from '../modules/memory/images/chat-generated.mjs';
import { recentGeneratedImageContext } from '../modules/memory/images/recent.mjs';
import { stickerPng } from './fixtures/stickers.mjs';

const owner = 'chat-generated-owner', scope = { accountId: owner, chatType: 'group', peerId: 'chat-generated@chatroom' };
const png = stickerPng();
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-chat-generated-'));
  const store = new StateStore(root);
  store.configure(owner, { enabled: true, privatePeers: ['alice'], groups: [scope.peerId], prompt: '' });
  const now = Date.parse('2026-11-21T08:00:00Z'), images = new ImageMemory(store, { now: () => now, thumbnailMaker: async () => png });
  images.configure({ ...scope, collection: 'generated' }, { enabled: true, retentionDays: 30 });
  const record = { key: 'request-key', createdAt: now - 5000, senderId: 'alice' };
  const generated = { bytes: png, mediaType: 'image/png', generatedAt: now - 1000, fileName: 'AI-test.png',
    prompt: '一张红色方块测试图', providerName: 'fixture-provider', model: 'fixture-image' };
  const authorize = () => {};
  t.after(() => {
    images.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert(path.basename(resolved).startsWith('wechat-chat-generated-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, images, record, generated, authorize, now };
}

test('chat generated image stays requester-only until its exact media ACK is attached', async t => {
  const f = fixture(t), capture = await captureChatGeneratedImage(f.images, scope, f.record, f.generated, f.authorize);
  assert(capture);
  const requester = { ...scope, senderId: 'alice', collection: 'generated' };
  const other = { ...scope, senderId: 'bob', collection: 'generated' };
  const pending = f.images.list(requester);
  assert.equal(pending.storedCount, 1);
  assert.equal(pending.items[0].generation.deliveryState, 'not-confirmed');
  assert.equal(f.images.list(other).total, 0);
  assert(!recentGeneratedImageContext({ imageMemory: f.images, store: f.store }, scope, f.now).includes('本会话最近确认发出的图片'));
  assert.equal(acknowledgeChatGeneratedImage(f.images, capture, {
    planIndex: 1, sentAt: f.now, serverMessageIds: ['generated-ack'],
    deliveryParts: [{ planIndex: 1, type: 'image', state: 'acknowledged', serverMessageId: 'generated-ack' }],
  }), true);
  const delivered = f.images.list(other);
  assert.equal(delivered.total, 1);
  assert.equal(delivered.items[0].generation.deliveryState, 'sent');
  assert.deepEqual(delivered.items[0].generation.serverMessageIds, ['generated-ack']);
  const context = recentGeneratedImageContext({ imageMemory: f.images, store: f.store }, scope, f.now);
  assert(context.includes('AI-test.png'));
  assert(context.includes('wechat_generated_image_memory'));
  assert.equal(f.images.content(other, capture.id).data, png.toString('base64'));
});

test('disabling, clearing or tombstoning generated memory never gets undone by a late ACK', async t => {
  const f = fixture(t), capture = await captureChatGeneratedImage(f.images, scope, f.record, f.generated, f.authorize);
  assert(capture);
  const collection = { ...scope, collection: 'generated' };
  f.images.remove(collection, [capture.id]);
  assert.equal(acknowledgeChatGeneratedImage(f.images, capture, {
    planIndex: 0, sentAt: f.now, serverMessageIds: ['late-ack'],
    deliveryParts: [{ planIndex: 0, type: 'image', state: 'acknowledged', serverMessageId: 'late-ack' }],
  }), false);
  assert.equal(f.images.list({ ...collection, senderId: 'alice' }).storedCount, 0);
});
