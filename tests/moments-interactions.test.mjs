import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MomentsInteractions, MomentsService, interactionOptions, readableInteractionText, momentsInteractionTool, planProgressiveTools, ChannelError, momentsLikeRequestArgs, readMomentsImageContext, momentsImagesTool
} from '../lib/testing.js';







import { createHash } from 'node:crypto';



function enableImageReading(f, { count = 2 } = {}) {
  const files = fs.readdirSync(path.join(import.meta.dirname, '../assets/stickers'), { recursive: true });
  const bytes = fs.readFileSync(path.join(import.meta.dirname, '../assets/stickers', files.find(file => file.endsWith('.png'))));
  const calls = [], visions = [], run = f.channel.runner.run;
  f.channel.transport.readMomentsImages = async ({ accountId, scopeKey, query }) => {
    calls.push({ accountId, scopeKey, postId: query.postId }); const post = structuredClone(f.posts.find(row => row.id === query.postId));
    return { accountId, postId: post.id, post, source: 'wechat-sns-images-live', imageCount: post.imageCount, complete: true,
      items: post.media.map((item, index) => ({ index: index + 1, mediaId: item.id, data: bytes.toString('base64'), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' })) };
  };
  f.channel.runner.run = async input => {
    if (input.mode !== 'moments-image-read') return run(input);
    visions.push(input); return { text: JSON.stringify({ images: input.images.map((_image, index) => ({ index: index + 1, readable: true, description: `第 ${index + 1} 张实际图片中有一杯咖啡。` })) }) };
  };
  return { calls, visions, photo: { imageCount: count, media: Array.from({ length: count }, (_, index) => ({ id: 'image-' + index, type: 'image' })) } };
}

test('pure likes and explicit comment text never download photos or invoke vision', async t => {
  for (const options of [{ action: 'like' }, { action: 'both', commentMode: 'fixed', commentText: '周末快乐' }]) {
    const f = fixture(t), media = enableImageReading(f); f.add(1, media.photo);
    const round = await f.preview(options); await f.run(round);
    assert.equal(media.calls.length, 0); assert.equal(media.visions.length, 0); assert.equal(f.models.length, 0);
  }
});

test('generated comments read each selected post image first, including posts without text', async t => {
  const f = fixture(t), media = enableImageReading(f); f.add(1, { ...media.photo, text: '' }); f.add(2, { ...media.photo, text: '拿铁日常' });
  const round = await f.preview({ action: 'both' }); assert.equal(media.calls.length, 0);
  const generated = await f.manager.generate(f.accountId, round.id, round.revision);
  assert.deepEqual(media.calls.map(row => row.postId), ['1', '2']); assert.equal(media.visions.length, 2);
  assert(media.visions.every(input => input.images.length === 2 && input.tools.length === 0));
  const input = JSON.parse(f.models[0].text);
  assert(input.posts.every(post => post.imageContext.length === 2 && post.imageContext[0].description.includes('咖啡')));
  assert(generated.rows.every(row => row.imageContext.complete)); assert.equal(f.writes.length, 0);
  const done = await f.run(generated); assert.equal(done.counts.commented, 2); assert.equal(done.counts.liked, 2);
  assert.equal(media.calls.length, 2, 'submitting reviewed comments must not read photos again');
});

test('already-commented image posts do not consume image understanding', async t => {
  const f = fixture(t), media = enableImageReading(f); f.add(1, { ...media.photo, comments: [{ userId: f.accountId, id: '99' }], visibleCommentEntries: 1 });
  const round = await f.preview({ action: 'both' }), generated = await f.manager.generate(f.accountId, round.id, round.revision);
  assert.equal(media.calls.length, 0); assert.equal(media.visions.length, 0); assert.equal(f.models.length, 0);
  assert.match(generated.rows[0].commentSkipReason, /已有/);
});

test('disabled vision is respected and cancellation discards a late image description', async t => {
  const f = fixture(t), media = enableImageReading(f); f.add(1, media.photo);
  f.channel.store.modelConfig = () => ({ vision: false });
  await assert.rejects(readMomentsImageContext(f.channel, { accountId: f.accountId, scopeKey: 'owner', postId: '1' }, new AbortController().signal, () => {}), { code: 'MOMENTS_IMAGE_VISION_DISABLED' });
  assert.equal(media.calls.length, 0);
  f.channel.store.modelConfig = () => ({ vision: true });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = f.channel.runner.run; t.after(() => release.resolve());
  f.channel.runner.run = async input => { if (input.mode === 'moments-image-read') { entered.resolve(); await release.promise; } return original(input); };
  const round = await f.preview({ action: 'comment' }), pending = f.manager.generate(f.accountId, round.id, round.revision);
  const rejected = assert.rejects(pending); await entered.promise; f.manager.cancel(f.accountId, round.id); release.resolve(); await rejected;
  assert.equal(f.manager.list(f.accountId, round.id).current.rows[0].commentText, ''); assert.equal(f.writes.length, 0);
});

test('failed image reading skips only the generated comment and still allows its requested like', async t => {
  const f = fixture(t), media = enableImageReading(f); f.add(1, media.photo);
  f.channel.transport.readMomentsImages = async () => { throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '图片已过期'); };
  const round = await f.preview({ action: 'both' }), generated = await f.manager.generate(f.accountId, round.id, round.revision);
  assert.equal(f.models.length, 0); assert.equal(generated.rows[0].commentText, ''); assert.match(generated.rows[0].commentSkipReason, /过期/);
  const done = await f.run(generated); assert.equal(done.counts.liked, 1); assert.equal(done.counts.commented, 0);
});

test('image reading rejects wrong account, changed author, missing photos and corrupted bytes before vision', async t => {
  for (const mutate of [result => { result.accountId = 'another'; }, result => { result.post.author.userId = 'someone-else'; },
    result => { result.items.pop(); }, result => { result.items[0].sha256 = 'a'.repeat(64); }, result => { result.items[0].mediaId = 'wrong'; }]) {
    const f = fixture(t), media = enableImageReading(f); f.add(1, media.photo); const original = f.channel.transport.readMomentsImages;
    f.channel.transport.readMomentsImages = async input => { const result = await original(input); mutate(result); return result; };
    const round = await f.preview({ action: 'comment' }), generated = await f.manager.generate(f.accountId, round.id, round.revision);
    assert.equal(media.visions.length, 0); assert.equal(f.models.length, 0); assert.equal(generated.rows[0].commentText, ''); assert(generated.rows[0].commentSkipReason);
  }
});

test('an old image comment without image evidence is blocked before a social write', async t => {
  const f = fixture(t), media = enableImageReading(f); f.add(1, media.photo);
  const round = await f.preview({ action: 'comment' }); f.manager.data.runs[round.id].rows[0].commentText = '之前只看张数夸的评论'; f.manager.save();
  const done = await f.run(round); assert.equal(done.counts.commented, 0); assert.match(done.rows[0].comment.message, /真实图片/); assert.equal(f.writes.length, 0);
});

test('image tools are read-only, validate IDs, enforce permission and expose no pixels or CDN links', async t => {
  const f = fixture(t), media = enableImageReading(f); f.add(1, media.photo);
  const tool = momentsImagesTool({ readImages: (query, signal) => f.channel.moments.readImages(query, f.scope, signal) });
  const exec = { signal: new AbortController().signal };
  const value = JSON.parse(await tool.execute({ postId: '1' }, exec)); assert.equal(value.ok, true); assert.equal(value.images.length, 2);
  assert.equal(value.mediaContentIncluded, true); assert(!JSON.stringify(value).includes('base64')); assert(!JSON.stringify(value).includes('https://'));
  assert.equal(f.writes.length, 0); assert.equal(planProgressiveTools([tool], '').deferredGroups[0].id, 'moments-read');
  assert.equal(JSON.parse(await tool.execute({ postId: '1', url: 'https://example.com/a' }, exec)).ok, false);
  assert.equal(media.calls.length, 1);
  await assert.rejects(f.channel.moments.readImages({ postId: '1' }, { ...f.scope, peerId: 'ordinary', senderId: 'ordinary' }, exec.signal));
  assert.equal(media.calls.length, 1);
});

function fixture(t, dependencies = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-interactions-')), accountId = 'interaction-owner';
  const now = Date.parse('2026-11-10T04:00:00Z'), reads = [], writes = [], models = [], posts = [], sleeps = [], managers = [];
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const scope = { accountId, chatType: 'private', peerId: 'admin', senderId: 'admin' }, admins = ['admin', 'admin-b'];
  const channel = { now: () => now, store: { root, data: { storeId: 'interactions-fixture' }, persona: () => ({ name: '合成测试' }),
    settings: () => ({ enabled: true, privatePeers: ['admin', 'admin-b', 'ordinary'], groups: [] }),
    conversationSettings: () => ({ remoteEnabled: true, adminIds: admins }), config: { assertCurrent() {}, section: () => ({ globalAdminIds: [] }) } },
    runner: { run: async input => { models.push(input); return { text: JSON.stringify({ comments: JSON.parse(input.text).posts.map(post => ({ postId: post.postId, text: '回应：' + post.text, skipReason: '' })) }) }; } },
    transport: { status: () => status, call: async () => ({ privatePeers: ['friend-a', 'friend-b', accountId, ...admins].map(id => ({ id, name: id === 'friend-a' ? '朋友甲' : id })) }),
      readMoments: async (args, signal) => {
        signal?.throwIfAborted(); reads.push(structuredClone(args));
        const query = args.query, selected = posts.filter(post => query.action === 'detail' ? post.id === query.postId : query.action !== 'user' || post.author.userId === query.userId);
        if (query.action === 'comments') return { accountId: args.accountId, source: 'wechat-sns-live', action: 'comments', postId: query.postId,
          items: structuredClone(posts.find(post => post.id === query.postId)?.comments ?? []), nextCursor: null };
        const offset = Number(query.cursor ?? 0), limit = query.limit ?? 20;
        return { accountId: args.accountId, source: 'wechat-sns-live', action: query.action, items: structuredClone(selected.slice(offset, offset + limit)),
          nextCursor: selected.length > offset + limit ? String(offset + limit) : null };
      },
      writeMoments: async (args, signal) => {
        signal?.throwIfAborted(); writes.push(structuredClone(args)); const { query } = args, post = posts.find(post => post.id === query.postId);
        if (query.action === 'like') post.likedByCurrentAccount = true;
        else { post.comments.push({ userId: accountId, text: query.text, id: String(400 + writes.length) }); post.visibleCommentEntries = post.comments.length; post.commentCount = post.comments.length; }
        return { accountId: args.accountId, action: query.action, postId: query.postId, delivery: 'server-ack',
          ...(query.action === 'like' ? { liked: true } : { commentId: String(400 + writes.length), text: query.text }) };
      } } };
  channel.moments = new MomentsService(channel);
  const create = () => { const value = new MomentsInteractions(channel, { sleep: async ms => { sleeps.push(ms); }, ...dependencies }); managers.push(value); return value; };
  const manager = create(); channel.momentsAutomation = { interactions: manager, recordReceipt() {} };
  const add = (id, extra = {}) => { const post = { id: String(id), author: { userId: 'friend-a', nickname: '朋友甲' }, text: '今天试了新的咖啡。', createdAt: now / 1000 - Number(id),
    deleted: false, contentAvailable: true, likedByCurrentAccount: false, imageCount: 0, media: [], comments: [], visibleCommentEntries: 0, commentCount: 0, likeCount: 2, ...extra }; posts.push(post); return post; };
  const preview = (options = {}, id = 'round-one', remote) => manager.preview(accountId, { action: 'like', intervalSeconds: 0, ...options }, id, undefined, undefined, remote);
  const run = async (round, remote) => { manager.start(accountId, round.id, round.revision, undefined, undefined, remote); return manager.wait(accountId, round.id, remote); };
  t.after(async () => {
    await Promise.all(managers.map(value => value.close()));
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-interactions-/); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, accountId, manager, channel, create, status, scope, admins, reads, writes, models, posts, sleeps, add, preview, run, now };
}

test('interaction options bound counts, sources, intervals and explicit fixed comments', () => {
  assert.equal(interactionOptions().commentMode, 'generated');
  assert.equal(interactionOptions({ source: 'selected', postIds: ['1', '1', '2'] }).count, 2);
  for (const input of [null, [], { arbitrary: true }, { source: 'user' }, { source: 'selected' }, { postIds: ['1'] }, { source: 'selected', postIds: ['18446744073709551616'] },
    { count: 0 }, { count: 21 }, { poolSize: 101 }, { count: 5, poolSize: 4 }, { lookbackDays: -1 }, { intervalSeconds: 61 }, { commentMode: 'fixed', commentText: ' ' }, { skipCommented: 'yes' }])
    assert.throws(() => interactionOptions(input), { code: 'MOMENTS_INTERACTION_INVALID' });
});

test('the latest-like shortcut cannot silently reinterpret a random selection request', () => {
  for (const request of ['给我的朋友圈随机点赞三条', '从朋友圈里抽取两条点赞', 'please like my moments at random'])
    assert.throws(() => momentsLikeRequestArgs({ subject: 'speaker' }, request), { code: 'MOMENTS_LIKE_SELECTION_UNSUPPORTED' });
  assert.equal(momentsLikeRequestArgs({ subject: 'speaker' }, '给我最新两条朋友圈点赞').count, 2);
});

test('latest previews exclude self, invisible, deleted and out-of-range posts; they never write', async t => {
  const f = fixture(t); f.add(1, { author: { userId: f.accountId } }); f.add(2, { contentAvailable: false }); f.add(3, { deleted: true }); f.add(4); f.add(5); f.add(6);
  f.add(7, { createdAt: f.now / 1000 - 9 * 86400 });
  const round = await f.preview({ count: 2 });
  assert.deepEqual(round.rows.map(row => row.postId), ['4', '5']); assert.equal(round.scan.scanned, 5); assert.equal(f.writes.length, 0);
  assert.equal(round.state, 'draft'); round.rows[0].text = 'cannot mutate manager'; assert.notEqual(f.manager.list(f.accountId, round.id).current.rows[0].text, round.rows[0].text);
});

test('random candidates and friend caps are frozen across concurrent requests and restart', async t => {
  let randomCalls = 0; const f = fixture(t, { random: maximum => { randomCalls++; return maximum - 1; } });
  f.add(1); f.add(2); f.add(3, { author: { userId: 'friend-b', nickname: '朋友乙' } }); f.add(4, { author: { userId: 'friend-c' } });
  const options = { mode: 'random', count: 3, poolSize: 4, perFriendLimit: 1 };
  const [round, repeat] = await Promise.all([f.preview(options), f.preview(options)]);
  assert.deepEqual(round.rows.map(row => row.postId), ['1', '3', '4']); assert.equal(round.id, repeat.id); assert.equal(randomCalls, 3);
  const readCount = f.reads.length; const again = await f.create().preview(f.accountId, { action: 'like', intervalSeconds: 0, ...options }, 'round-one');
  assert.deepEqual(again.rows, round.rows); assert.equal(f.reads.length, readCount); assert.equal(randomCalls, 3);
  assert.throws(() => f.preview({ ...options, count: 2 }), { code: 'MOMENTS_INTERACTION_CHANGED' });
});

test('manual candidates start unselected; edits cannot add IDs, cross revisions or exceed 20 targets', async t => {
  const f = fixture(t); for (let i = 1; i <= 25; i++) f.add(i);
  const round = await f.preview({ mode: 'manual', poolSize: 25 }); assert.equal(round.rows.length, 25); assert.equal(round.counts.selected, 0);
  assert.throws(() => f.manager.start(f.accountId, round.id, round.revision), { code: 'MOMENTS_INTERACTION_INVALID' });
  assert.throws(() => f.manager.edit(f.accountId, round.id, round.revision, [{ postId: '26', selected: true, commentText: '' }]), { code: 'MOMENTS_INTERACTION_INVALID' });
  assert.throws(() => f.manager.edit(f.accountId, round.id, round.revision, round.rows.map(row => ({ postId: row.postId, selected: true, commentText: '' }))), { code: 'MOMENTS_INTERACTION_INVALID' });
  const edited = f.manager.edit(f.accountId, round.id, round.revision, [{ postId: '2', selected: true, commentText: '' }]);
  assert.throws(() => f.manager.start(f.accountId, round.id, round.revision), { code: 'MOMENTS_INTERACTION_CHANGED' });
  assert.equal((await f.run(edited)).counts.liked, 1); assert.equal(f.writes[0].query.postId, '2');
});

test('specific friends use exact contact resolution and reject pronouns, self and wrong authors', async t => {
  const f = fixture(t); f.add(1); f.add(2, { author: { userId: 'friend-b' } });
  const round = await f.preview({ source: 'user', user: '朋友甲' }); assert.equal(round.targetUserId, 'friend-a'); assert.deepEqual(round.rows.map(row => row.postId), ['1']);
  assert.equal(f.reads[0].query.action, 'user'); assert.equal(f.reads[0].query.userId, 'friend-a');
  for (const user of ['我', '你', '他']) await assert.rejects(f.preview({ source: 'user', user }, user), { code: 'MOMENTS_SUBJECT_INVALID' });
  await assert.rejects(f.preview({ source: 'user', user: f.accountId }, 'self'), { code: 'MOMENTS_INTERACTION_TARGET' });
  f.channel.transport.readMoments = async () => ({ accountId: f.accountId, action: 'user', source: 'wechat-sns-live', items: [f.posts[1]] });
  await assert.rejects(f.preview({ source: 'user', user: '朋友甲' }, 'wrong-author'), { code: 'MOMENTS_INTERACTION_READ' }); assert.equal(f.writes.length, 0);
});

test('empty reconciliation pages continue but repeated cursors and untrusted responses fail', async t => {
  const f = fixture(t), post = f.add(1); let count = 0;
  f.channel.transport.readMoments = async args => ({ accountId: f.accountId, source: 'wechat-sns-live', action: args.query.action, items: ++count === 1 ? [] : [post], nextCursor: count === 1 ? 'continue' : null });
  assert.equal((await f.preview()).rows[0].postId, '1'); assert.equal(count, 2);
  f.channel.transport.readMoments = async () => ({ accountId: f.accountId, source: 'wechat-sns-live', action: 'timeline', items: [], nextCursor: 'repeat' });
  await assert.rejects(f.preview({}, 'repeat'), { code: 'MOMENTS_INTERACTION_READ' });
  for (const patch of [{ accountId: 'other' }, { source: 'cache' }, { action: 'user' }, { items: [{ ...post, likedByCurrentAccount: undefined }] }]) {
    f.channel.transport.readMoments = async () => ({ accountId: f.accountId, source: 'wechat-sns-live', action: 'timeline', items: [post], ...patch });
    await assert.rejects(f.preview({}, JSON.stringify(patch)), { code: 'MOMENTS_INTERACTION_READ' });
  }
});

test('bounded candidate reads report incomplete coverage without manufacturing old posts', async t => {
  const f = fixture(t); let calls = 0;
  f.channel.transport.readMoments = async () => ({ accountId: f.accountId, source: 'wechat-sns-live', action: 'timeline', items: [], nextCursor: 'cursor-' + ++calls });
  const round = await f.preview(); assert.equal(calls, 10); assert.equal(round.scan.complete, false); assert.deepEqual(round.rows, []); assert.equal(f.writes.length, 0);
});

test('selected menu targets read details, normalize count and reject self or vanished posts', async t => {
  const f = fixture(t); f.add(1, { createdAt: f.now / 1000 - 90 * 86400 }); f.add(2, { author: { userId: f.accountId } });
  const round = await f.preview({ source: 'selected', postIds: ['1'] }); assert.equal(round.options.count, 1); assert.equal(f.reads[0].query.action, 'detail');
  await assert.rejects(f.preview({ source: 'selected', postIds: ['2'] }, 'self'), { code: 'MOMENTS_INTERACTION_TARGET' });
  await assert.rejects(f.preview({ source: 'selected', postIds: ['3'] }, 'gone'), { code: 'MOMENTS_INTERACTION_READ' });
});

test('generated comments use actual post text, no tools, and require an explicit execution', async t => {
  const f = fixture(t); f.add(1); f.add(2, { text: '周末去了公园散步。' });
  const round = await f.preview({ action: 'both' });
  assert.throws(() => f.manager.start(f.accountId, round.id, round.revision), { code: 'MOMENTS_INTERACTION_CONTENT' });
  const generated = await f.manager.generate(f.accountId, round.id, round.revision); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.models[0].tools, []); assert.equal(f.models[0].mode, 'moments-interaction');
  assert.deepEqual(JSON.parse(f.models[0].text).posts.map(row => row.text), f.posts.map(row => row.text));
  const result = await f.run(generated); assert.equal(result.counts.liked, 2); assert.equal(result.counts.commented, 2); assert.equal(result.state, 'completed');
  assert.deepEqual(f.writes.map(row => [row.query.action, row.query.postId]), [['like', '1'], ['comment', '1'], ['like', '2'], ['comment', '2']]);
  assert.equal(f.create().list(f.accountId, round.id).current.counts.commented, 2);
});

test('unavailable photo reading and empty posts skip generation, but explicit manual text is allowed', async t => {
  const f = fixture(t);
  for (const text of ['', '[呲牙][强]', '/:strong', '👍👍', 'https://example.com/image']) assert.equal(readableInteractionText(text), false, text);
  assert.equal(readableInteractionText('新咖啡 [微笑]'), true);
  f.add(1, { text: '[强]', imageCount: 9 }); f.add(2, { text: '' });
  const round = await f.preview({ action: 'both' }); assert.equal(round.rows[0].commentSkipReason, ''); assert(round.rows[1].commentSkipReason);
  const generated = await f.manager.generate(f.accountId, round.id, round.revision); assert.equal(f.models.length, 0); assert(generated.rows.every(row => row.commentSkipReason));
  const edited = f.manager.edit(f.accountId, generated.id, generated.revision, [{ postId: '1', selected: true, commentText: '周末快乐！' }]);
  const result = await f.run(edited); assert.equal(result.counts.liked, 2); assert.equal(result.counts.commented, 1); assert.equal(result.counts.skippedComments, 1);
});

test('generation preserves manual edits and validates every model ID before saving any comment', async t => {
  const f = fixture(t); f.add(1); f.add(2);
  let round = await f.preview({ action: 'comment' }); round = f.manager.edit(f.accountId, round.id, round.revision, [{ postId: '1', selected: true, commentText: '手工评论' }]);
  round = await f.manager.generate(f.accountId, round.id, round.revision); assert.equal(JSON.parse(f.models[0].text).posts.length, 1); assert.equal(round.rows[0].commentText, '手工评论');
  const malformed = [null, { comments: [] }, { comments: [{ postId: '99', text: '猜的', skipReason: '' }] },
    { comments: [{ postId: '2', text: '有内容', skipReason: '同时跳过' }] }, { comments: [{ postId: '2', text: 'x'.repeat(501), skipReason: '' }] }];
  for (const response of malformed) {
    f.channel.runner.run = async () => ({ text: JSON.stringify(response) });
    await assert.rejects(f.manager.generate(f.accountId, round.id, round.revision), { code: 'MOMENTS_INTERACTION_CONTENT' });
    round = f.manager.list(f.accountId, round.id).current; assert.equal(round.state, 'draft'); assert.equal(round.rows[0].commentText, '手工评论'); assert.equal(f.writes.length, 0);
  }
});

test('deleted, modified or swapped targets are skipped after the final live detail check', async t => {
  const f = fixture(t); const posts = [f.add(1), f.add(2), f.add(3)];
  const round = await f.preview({ action: 'both', commentMode: 'fixed', commentText: '你好' });
  posts[0].text = '新内容'; posts[1].author.userId = 'someone-else'; posts[2].deleted = true;
  const result = await f.run(round); assert.equal(result.state, 'completed'); assert(result.rows.every(row => row.like.state === 'skipped' && row.comment.state === 'skipped')); assert.equal(f.writes.length, 0);
});

test('existing likes and own comments keep their slots; truncated comments are verified by paging', async t => {
  const f = fixture(t); f.add(1, { likedByCurrentAccount: true, comments: [{ userId: f.accountId, text: '先前评论' }], visibleCommentEntries: 1, commentCount: 1 });
  f.add(2, { visibleCommentEntries: 51, commentCount: 51, interactionsTruncated: true }); f.add(3);
  const read = f.channel.transport.readMoments;
  f.channel.transport.readMoments = async (args, signal) => args.query.action === 'comments' ? { accountId: f.accountId, source: 'wechat-sns-live', action: 'comments', postId: '2',
    items: args.query.cursor ? [{ userId: f.accountId }] : [{ userId: 'friend-b' }], nextCursor: args.query.cursor ? null : 'next-comments' } : read(args, signal);
  const result = await f.run(await f.preview({ action: 'both', count: 2, commentMode: 'fixed', commentText: '你好' }));
  assert.equal(result.counts.alreadyLiked, 1); assert.equal(result.counts.skippedComments, 2); assert.deepEqual(f.writes.map(row => row.query.postId), ['2']);
});

test('unreadable comments stop the round instead of assuming that no previous comment exists', async t => {
  const f = fixture(t); f.add(1, { visibleCommentEntries: 51, commentCount: 51, interactionsTruncated: true });
  const read = f.channel.transport.readMoments;
  f.channel.transport.readMoments = async (args, signal) => args.query.action === 'comments' ? { accountId: f.accountId, source: 'wechat-sns-live', action: 'comments', postId: '1', items: [], nextCursor: 'repeated' } : read(args, signal);
  const result = await f.run(await f.preview({ action: 'comment', commentMode: 'fixed', commentText: '你好' }));
  assert.equal(result.state, 'failed'); assert.equal(f.writes.length, 0); assert.equal(result.error.code, 'MOMENTS_INTERACTION_READ');
});

test('an explicit no-skip round can add a new comment after an existing one', async t => {
  const f = fixture(t); f.add(1, { comments: [{ userId: f.accountId }], visibleCommentEntries: 1 });
  const result = await f.run(await f.preview({ action: 'comment', commentMode: 'fixed', commentText: '新的评论', skipCommented: false }));
  assert.equal(result.counts.commented, 1);
});

test('a confirmed like followed by a rejected comment records a partial result and does not send the next post', async t => {
  const f = fixture(t); f.add(1); f.add(2); const write = f.channel.transport.writeMoments;
  f.channel.transport.writeMoments = async (args, signal) => {
    if (args.query.action === 'comment') { f.writes.push(args); throw new ChannelError('COMMENT_REJECTED', '微信拒绝', { snsDelivery: 'rejected' }); }
    return write(args, signal);
  };
  const result = await f.run(await f.preview({ action: 'both', commentMode: 'fixed', commentText: '你好' }));
  assert.equal(result.state, 'partial'); assert.equal(result.counts.liked, 1); assert.equal(result.rows[0].comment.state, 'rejected'); assert.equal(f.writes.length, 2);
  assert.equal((await f.run(result)).state, 'partial'); assert.equal(f.writes.length, 2);
});

test('unknown receipts stop remaining posts and are not resubmitted in another round or after restart', async t => {
  const f = fixture(t); f.add(1); f.add(2);
  f.channel.transport.writeMoments = async args => { f.writes.push(args); throw new ChannelError('NETWORK_GONE', '结果不明'); };
  const round = await f.preview({ action: 'comment', commentMode: 'fixed', commentText: '你好' });
  const result = await f.run(round); assert.equal(result.state, 'partial'); assert.equal(result.counts.unknown, 1); assert.equal(f.writes.length, 1);
  const restarted = f.create(); assert.equal(restarted.start(f.accountId, round.id, round.revision).state, 'partial');
  const next = await restarted.preview(f.accountId, { source: 'selected', postIds: ['1'], action: 'comment', commentMode: 'fixed', commentText: '再试一次', skipCommented: false }, 'different-round');
  restarted.start(f.accountId, next.id, next.revision); const final = await restarted.wait(f.accountId, next.id);
  assert.equal(final.rows[0].comment.state, 'skipped'); assert.equal(f.writes.length, 1);
});

test('receipt mismatches never become success', async t => {
  const f = fixture(t); f.add(1); f.channel.transport.writeMoments = async args => { f.writes.push(args); return { accountId: f.accountId, action: 'comment', postId: '2', text: '错的目标', commentId: '42', delivery: 'server-ack' }; };
  const result = await f.run(await f.preview({ action: 'comment', commentMode: 'fixed', commentText: '你好' }));
  assert.equal(result.counts.commented, 0); assert.equal(result.counts.unknown, 1);
});

test('cancelling after one receipt preserves it and prevents the next submission', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  const f = fixture(t, { sleep: async (_ms, signal) => { entered.resolve(); await release.promise; signal.throwIfAborted(); } }); f.add(1); f.add(2);
  const round = await f.preview({ intervalSeconds: 3 }); f.manager.start(f.accountId, round.id, round.revision); await entered.promise;
  f.manager.cancel(f.accountId, round.id); release.resolve(); const result = await f.manager.wait(f.accountId, round.id);
  assert.equal(result.state, 'cancelled'); assert.equal(result.counts.liked, 1); assert.equal(f.writes.length, 1); assert.equal(f.create().list(f.accountId, round.id).current.counts.liked, 1);
});

test('a late acknowledgement is kept by the durable writer even when the round must report unknown', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve()); f.add(1); f.add(2);
  f.channel.transport.writeMoments = async args => { f.writes.push(args); entered.resolve(); await release.promise; return { accountId: f.accountId, action: 'like', postId: args.query.postId, liked: true, delivery: 'server-ack' }; };
  const round = await f.preview(); f.manager.start(f.accountId, round.id, round.revision); await entered.promise; f.manager.cancel(f.accountId, round.id); release.resolve();
  const result = await f.manager.wait(f.accountId, round.id); assert.equal(result.rows[0].like.state, 'unknown'); assert.equal(f.writes.length, 1);
  const receipts = path.join(f.root, 'storage/moments/actions'); assert.equal(JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts)[0]), 'utf8')).state, 'succeeded');
});

test('account changes, authorization revocation and plugin shutdown during reads prevent all writes', async t => {
  for (const mode of ['account', 'authorization', 'close']) {
    const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve()); f.add(1);
    const round = await f.preview({}, mode, f.scope), read = f.channel.transport.readMoments;
    f.channel.transport.readMoments = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
    f.manager.start(f.accountId, round.id, round.revision, undefined, undefined, f.scope); await entered.promise;
    if (mode === 'account') f.status.account.id = 'another';
    if (mode === 'authorization') f.admins.splice(0);
    const closing = mode === 'close' ? f.manager.close() : null;
    release.resolve(); await f.manager.whenIdle(); await closing; assert.equal(f.writes.length, 0, mode);
  }
});

test('rounds are isolated by account and initiator, including tool management and history', async t => {
  const f = fixture(t); f.add(1);
  const owner = await f.preview(), remote = await f.preview({}, 'admin-round', f.scope), other = { ...f.scope, peerId: 'admin-b', senderId: 'admin-b' };
  assert.equal(f.manager.list(f.accountId).runs.length, 2); assert.equal(f.manager.list(f.accountId, undefined, f.scope).runs.length, 1);
  assert.throws(() => f.manager.list('other', owner.id), { code: 'MOMENTS_INTERACTION_NOT_FOUND' });
  assert.throws(() => f.manager.list(f.accountId, owner.id, f.scope), { code: 'MOMENTS_INTERACTION_NOT_FOUND' });
  assert.throws(() => f.manager.cancel(f.accountId, remote.id, other), { code: 'MOMENTS_INTERACTION_NOT_FOUND' });
  await assert.rejects(f.channel.moments.manageInteractions({ action: 'run', id: owner.id, revision: owner.revision }, f.scope, 'message'), { code: 'MOMENTS_INTERACTION_NOT_FOUND' });
  await assert.rejects(f.channel.moments.manageInteractions({ action: 'preview' }, { ...f.scope, peerId: 'ordinary', senderId: 'ordinary' }, 'message'), { code: 'REMOTE_NOT_AUTHORIZED' });
});

test('a busy generator cannot launch another round and cancellation returns an editable draft', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve()); f.add(1);
  const first = await f.preview({ action: 'comment' }), second = await f.preview({}, 'other');
  f.channel.runner.run = async input => { entered.resolve(); await release.promise; input.signal.throwIfAborted(); };
  const pending = f.manager.generate(f.accountId, first.id, first.revision); void pending.catch(() => {}); await entered.promise;
  assert.throws(() => f.manager.start(f.accountId, second.id, second.revision), { code: 'MOMENTS_INTERACTION_BUSY' });
  f.manager.cancel(f.accountId, first.id); release.resolve(); await assert.rejects(pending);
  assert.equal(f.manager.list(f.accountId, first.id).current.state, 'draft'); assert.equal(f.manager.list(f.accountId).running, false); assert.equal(f.writes.length, 0);
});

test('interrupted persisted submissions do not replay and invalid files remain untouched', async t => {
  const f = fixture(t); f.add(1); const round = await f.preview();
  const stored = JSON.parse(fs.readFileSync(f.manager.file(), 'utf8')); stored.runs[round.id].state = 'running'; stored.runs[round.id].rows[0].like.state = 'sending'; fs.writeFileSync(f.manager.file(), JSON.stringify(stored));
  const restarted = f.create(), interrupted = restarted.list(f.accountId, round.id).current;
  assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.rows[0].like.state, 'unknown'); restarted.start(f.accountId, round.id, round.revision); assert.equal(f.writes.length, 0);
  for (const content of ['{broken', JSON.stringify({ ...stored, ownerStoreId: 'wrong-owner' }), JSON.stringify({ ...stored, runs: { [round.id]: { ...stored.runs[round.id], scopeKey: 'tampered' } } })]) {
    fs.writeFileSync(f.manager.file(), content); const invalid = f.create(); assert(invalid.list(f.accountId).error); assert.throws(() => invalid.preview(f.accountId, {}, 'new'), { code: 'MOMENTS_INTERACTION_STATE' }); assert.equal(fs.readFileSync(f.manager.file(), 'utf8'), content);
  }
});

test('progress persistence failure clears active state and prevents the first write', async t => {
  const f = fixture(t); f.add(1); const round = await f.preview();
  // A directory at the expected file location causes the atomic rename to fail.
  const originalFile = f.manager.file(); f.manager.file = () => path.dirname(originalFile);
  assert.throws(() => f.manager.start(f.accountId, round.id, round.revision), { code: 'STATE_WRITE_FAILED' });
  assert.equal(f.manager.list(f.accountId).running, false); assert.equal(f.writes.length, 0); assert(f.manager.error);
});

test('tool reports previews as drafts, validates actions and is discoverable for batch commands', async t => {
  const f = fixture(t); f.add(1); const observed = [], tool = momentsInteractionTool({ manage: (args, signal) => f.channel.moments.manageInteractions(args, f.scope, 'tool-message', signal), onOperation: value => observed.push(value) });
  const exec = { signal: new AbortController().signal };
  const draft = JSON.parse(await tool.execute({ action: 'preview', options: { action: 'both', commentMode: 'fixed', commentText: '你好' } }, exec));
  assert(draft.ok); assert.equal(draft.state, 'draft'); assert.equal(f.writes.length, 0);
  const finished = JSON.parse(await tool.execute({ action: 'run', id: draft.id, revision: draft.revision }, exec));
  assert(finished.ok); assert.equal(finished.counts.commented, 1); assert.equal(observed[1].tool, 'wechat_moments_interact');
  for (const args of [{ action: 'invent' }, { action: 'run', id: draft.id }, { action: 'list', options: {} }, { action: 'preview', options: { count: 21 } }]) assert.equal(JSON.parse(await tool.execute(args, exec)).ok, false);
  assert(planProgressiveTools([tool], '给朋友圈随机点赞评论三条').initial.includes(tool));
  assert.equal(planProgressiveTools([tool], '你好').deferredGroups[0].id, 'moments-interact');
});
