import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { filterAuthorizedMomentsImages, readMomentsWithMemory } from '../modules/moments/read.mjs';
import { readMomentsImageContext } from '../modules/moments/image-context.mjs';
import { stickerPng } from './fixtures/stickers.mjs';

function fixture() {
  const accountId = 'image-owner', bytes = stickerPng(), params = { accountId, query: { postId: '1' } };
  const post = { id: '1', author: { userId: 'alice' }, text: '咖啡', createdAt: 100, contentAvailable: true, deleted: false,
    imageCount: 1, media: [{ type: 'image', id: 'photo-1' }],
    comments: [{ id: '11', userId: 'outsider', text: '未授权原文' }, { id: '12', userId: 'bob', text: '已授权原文' }],
    likes: [{ userId: 'outsider' }, { userId: accountId }] };
  const result = { accountId, postId: '1', source: 'wechat-sns-images-live', post, imageCount: 1, complete: true,
    items: [{ index: 1, mediaId: 'photo-1', data: bytes.toString('base64'), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' }] };
  const captured = [], models = [], data = { authorizationEpochs: { [accountId]: 0 } };
  const channel = { now: () => 100000, store: { data, settings: () => ({ enabled: true, privatePeers: ['alice', 'bob'], groups: [] }) },
    transport: { readMomentsImages: async () => structuredClone(result) },
    personMemory: { captureMoments: (_accountId, page) => captured.push(page) },
    runner: { run: async input => { models.push(input); return { text: '{"images":[{"index":1,"readable":true,"description":"一杯咖啡"}]}' }; } } };
  const read = () => readMomentsImageContext(channel, { ...params, postId: '1', scopeKey: 'test' }, undefined, () => {});
  return { channel, params, result, captured, models, data, read };
}

test('a requested friend page rejects wrong authors and response targets before filtering or capturing any records', async () => {
  const f = fixture(), post = structuredClone(f.result.post);
  const page = { accountId: f.params.accountId, action: 'user', userId: 'alice', source: 'wechat-sns-live', items: [post] };
  for (const mutate of [value => { value.userId = 'bob'; }, value => { value.action = 'timeline'; },
    value => { value.items.push({ ...post, id: '2', author: { userId: 'outsider' } }); },
    value => { value.items.push({ ...post, id: '2', author: { userId: 'bob' } }); }]) {
    const response = structuredClone(page); mutate(response);
    f.channel.transport.readMoments = async () => response;
    await assert.rejects(readMomentsWithMemory(f.channel, { accountId: f.params.accountId,
      query: { action: 'user', userId: 'alice' } }), { code: 'MOMENTS_AUTHORIZATION_UNVERIFIED' });
    assert.equal(f.captured.length, 0); assert.equal(f.channel.momentOwners, undefined);
  }
  f.channel.transport.readMoments = async () => page;
  assert.equal((await readMomentsWithMemory(f.channel, { accountId: f.params.accountId,
    query: { action: 'user', userId: 'alice' } })).items.length, 1);
  assert.equal(f.captured.length, 1);
});

test('image post metadata excludes unauthorised comments and likes without mutating the original response', () => {
  const f = fixture(), value = filterAuthorizedMomentsImages(f.channel, f.params, f.result);
  assert.deepEqual(value.post.comments.map(row => row.id), ['12']);
  assert.deepEqual(value.post.likes.map(row => row.userId), ['image-owner']);
  assert.equal(f.result.post.comments.length, 2);
  assert.equal(value.items, f.result.items, 'verified image bytes are preserved');
});

test('image results must match the requested account, post and currently authorised author', () => {
  const f = fixture();
  for (const mutate of [value => { value.accountId = 'other'; }, value => { value.postId = '2'; },
    value => { value.post.id = '2'; }, value => { value.source = 'cache'; }, value => { delete value.post.author; }]) {
    const result = structuredClone(f.result); mutate(result);
    assert.throws(() => filterAuthorizedMomentsImages(f.channel, f.params, result), { code: 'MOMENTS_AUTHORIZATION_UNVERIFIED' });
  }
  f.result.post.author.userId = 'outsider';
  assert.throws(() => filterAuthorizedMomentsImages(f.channel, f.params, f.result), { code: 'OBJECT_NOT_AUTHORIZED' });
  f.result.post.author.userId = 'image-owner';
  assert.equal(filterAuthorizedMomentsImages(f.channel, f.params, f.result).post.author.userId, 'image-owner');
});

test('image understanding captures only authorised post metadata and never sees an unauthorised author', async () => {
  const f = fixture();
  assert.equal((await f.read()).readableImageCount, 1);
  assert.deepEqual(f.captured[0].items[0].comments.map(row => row.id), ['12']);
  assert(!JSON.stringify(f.captured).includes('未授权原文'));
  f.result.post.author.userId = 'outsider';
  await assert.rejects(f.read(), { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(f.models.length, 1); assert.equal(f.captured.length, 1);
});

test('an authorisation change during an uncancellable image download discards its late result before capture or vision', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.channel.transport.readMomentsImages = async () => { entered.resolve(); await release.promise; return structuredClone(f.result); };
  const pending = f.read(), rejected = assert.rejects(pending, { code: 'AUTHORIZATION_CHANGED' });
  await entered.promise; f.data.authorizationEpochs['image-owner']++; release.resolve(); await rejected;
  assert.equal(f.models.length, 0); assert.equal(f.captured.length, 0);
});

test('an authorisation change during uncancellable vision cannot return the late description', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.channel.runner.run = async () => { entered.resolve(); await release.promise; return { text: '{"images":[{"index":1,"readable":true,"description":"旧结果"}]}' }; };
  const pending = f.read(), rejected = assert.rejects(pending, { code: 'AUTHORIZATION_CHANGED' });
  await entered.promise; f.data.authorizationEpochs['image-owner']++; release.resolve(); await rejected;
});
