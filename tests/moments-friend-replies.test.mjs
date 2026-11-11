import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { MomentsAutomation, MomentsService, momentsSettings, momentsPublishingTools, OwnerCleanup, ChannelError } from '../lib/testing.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-friend-replies-')), accountId = 'reply-owner';
  let now = Date.parse('2026-11-10T04:00:00Z'), serial = 9000, manager;
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const settings = { enabled: true }, posts = [], reads = [], writes = [], models = [], imageReads = [], managers = [], hidden = new Set();
  const channel = { now: () => now, store: { root, data: { storeId: 'friend-replies-test' }, settings: () => settings,
    persona: () => ({ name: '合成测试' }), modelConfig: () => ({ vision: true }) },
    transport: { status: () => status, readMoments: async (args, signal) => {
      signal?.throwIfAborted(); reads.push(structuredClone(args)); const { query } = args;
      const items = query.action === 'comments' ? posts.find(post => post.id === query.postId)?.comments ?? []
        : query.action === 'detail' ? posts.filter(post => post.id === query.postId) : posts.filter(post => !hidden.has(post.id));
      const offset = Number(query.cursor ?? 0), limit = query.limit ?? 20;
      return { accountId, action: query.action, source: 'wechat-sns-live', items: structuredClone(items.slice(offset, offset + limit)),
        ...(query.action === 'comments' ? { postId: query.postId, visibleCommentEntries: items.length } : {}),
        nextCursor: offset + limit < items.length ? String(offset + limit) : null };
    }, writeMoments: async (args, signal) => {
      signal?.throwIfAborted(); writes.push(structuredClone(args)); const { query } = args;
      assert.equal(query.action, 'comment'); const post = posts.find(row => row.id === query.postId), target = post.comments.find(row => row.id === query.replyToCommentId);
      if (query.replyToCommentId) assert(target && !target.deleted);
      const commentId = String(++serial), relation = query.replyToCommentId ? { replyToCommentId: target.id, replyToUserId: target.userId } : {};
      post.comments.push({ id: commentId, userId: accountId, text: query.text, createdAt: Math.floor(now / 1000), deleted: false, ...relation });
      return { accountId, action: 'comment', postId: post.id, text: query.text, commentId, ...relation, delivery: 'server-ack' };
    } }, runner: { run: async input => {
      input.signal?.throwIfAborted(); models.push(input);
      return { text: input.mode === 'moments-image-read' ? '{"images":[{"index":1,"readable":true,"description":"桌上有一只白色茶杯"}]}'
        : JSON.parse(input.text).incomingReply ? '{"text":"嗯，我也觉得这个细节挺有意思。","skipReason":""}' : '接住自己动态的评论。' };
    } } };
  channel.moments = new MomentsService(channel);
  const create = () => { manager = new MomentsAutomation(channel); managers.push(manager); channel.momentsAutomation = manager; manager.stopped = false; return manager; };
  create();
  const comment = (id, extra = {}) => ({ id: String(id), userId: 'friend-a', nickname: '朋友甲', text: '你也是这么想的吗？', createdAt: now / 1000 + 1, deleted: false, ...extra });
  const add = (id = '70001', extra = {}) => {
    const post = { id: String(id), author: { userId: 'friend-a', nickname: '朋友甲' }, text: '今天的咖啡有点惊喜。', createdAt: now / 1000 - 120,
      imageCount: 0, media: [], contentAvailable: true, deleted: false, likedByCurrentAccount: false, ...extra,
      comments: extra.comments ?? [comment(101, { userId: accountId, text: '这杯看着就很香。', createdAt: now / 1000 - 10 }), comment(102, { replyToCommentId: '101', replyToUserId: accountId })] };
    posts.push(post); return post;
  };
  const configure = patch => manager.configure(accountId, patch);
  const enable = patch => configure({ friendRepliesEnabled: true, intervalMinutes: 1, ...patch });
  const due = () => { now = Math.max(now, manager.rule(accountId).nextRunAt); return manager.tick(); };
  t.after(async () => {
    await Promise.all(managers.map(value => value.close())); const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); assert.match(path.basename(target), /^wechat-friend-replies-/); fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, accountId, channel, status, settings, posts, reads, writes, models, imageReads, hidden, create, comment, add, configure, enable, due,
    get manager() { return manager; }, get now() { return now; }, advance: ms => { now += ms; } };
}
const gate = t => { const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve()); return { entered, release }; };
const reply = f => f.manager.list(f.accountId).replies[0];
const counts = f => f.manager.rule(f.accountId).lastRun.friend;

test('reply switches default off, accept independent patches and never run immediately on save', async t => {
  const f = fixture(t); f.add(); await f.manager.tick(); assert.equal(f.reads.length, 0);
  assert.equal(f.manager.rule(f.accountId).settings.friendRepliesEnabled, false);
  f.configure({ enabled: true, intervalMinutes: 30, maxRepliesPerRun: 8 }); f.configure({ friendRepliesEnabled: true });
  assert.equal(f.manager.rule(f.accountId).settings.enabled, true); assert.equal(f.manager.rule(f.accountId).settings.intervalMinutes, 30);
  f.configure({ enabled: false }); assert.equal(f.manager.rule(f.accountId).settings.friendRepliesEnabled, true);
  await f.manager.tick(); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
  for (const patch of [null, [], { extra: true }, { friendRepliesEnabled: 'yes' }, { maxFriendRepliesPerRun: 0 }, { maxFriendRepliesPerRun: 51 }, { maxFriendRepliesPerRun: 1.5 }])
    assert.throws(() => f.configure(patch), { code: 'MOMENTS_SETTINGS_INVALID' });
  assert.equal(momentsSettings({ maxFriendRepliesPerRun: 50 }).maxFriendRepliesPerRun, 50);
});

test('friend-only mode follows three real reply turns with correct subjects, without own-post replies or likes', async t => {
  const f = fixture(t), post = f.add(); f.add('70002', { author: { userId: f.accountId }, comments: [f.comment(103)] }); f.enable();
  for (let turn = 0; turn < 3; turn++) {
    await Promise.all([f.due(), f.manager.tick()]); assert.equal(f.writes.length, turn + 1); assert.equal(counts(f).replied, 1);
    const request = JSON.parse(f.models.at(-1).text), receipt = reply(f);
    assert.equal(request.currentAccountId, f.accountId); assert.equal(request.post.author.userId, 'friend-a'); assert.equal(request.ourComment.userId, f.accountId);
    assert.equal(receipt.state, 'sent'); assert.equal(receipt.replyToUserId, 'friend-a'); assert.equal(receipt.origin, 'friend');
    assert.equal(f.writes.at(-1).query.replyToCommentId, request.incomingReply.id); assert.equal(f.writes.at(-1).query.postId, post.id);
    assert.deepEqual(f.models.at(-1).tools, []); assert.match(f.models.at(-1).systemOverride, /外部资料|引用资料/);
    if (turn < 2) post.comments.push(f.comment(201 + turn, { replyToCommentId: receipt.replyId, replyToUserId: f.accountId }));
  }
  await f.due(); assert.equal(f.writes.length, 3); assert.equal(f.manager.rule(f.accountId).lastRun.replied, 0);
});

test('own and friend switches share a timer but use independent quotas and own selection', async t => {
  const f = fixture(t); f.add(); const own = f.add('70002', { author: { userId: f.accountId }, comments: [f.comment(103), f.comment(104)] });
  f.manager.remember(f.accountId, [own]); f.enable({ enabled: true, scope: 'selected', selectedPostIds: [own.id], maxRepliesPerRun: 1, maxFriendRepliesPerRun: 2 });
  await f.due(); assert.equal(f.writes.filter(row => row.query.postId === own.id).length, 1); assert.equal(f.writes.filter(row => row.query.postId === '70001').length, 1);
  assert.equal(f.manager.rule(f.accountId).lastRun.replied, 1); assert.equal(counts(f).replied, 1);
  f.configure({ friendRepliesEnabled: false }); await f.due(); assert.equal(f.writes.at(-1).query.postId, own.id);
  assert.equal(f.manager.rule(f.accountId).settings.enabled, true); assert.equal(f.manager.rule(f.accountId).lastRun.friend, undefined);
});

test('a failed own-post read does not starve the independently enabled friend pass', async t => {
  const f = fixture(t); f.add(); const own = f.add('70002', { author: { userId: f.accountId }, comments: [f.comment(103)] });
  f.manager.remember(f.accountId, [own]); f.enable({ enabled: true, scope: 'selected', selectedPostIds: [own.id] });
  const read = f.channel.transport.readMoments;
  f.channel.transport.readMoments = async (...args) => { if (args[0].query.postId === own.id) throw new ChannelError('ERR_MOMENTS_REJECTED', '自己的旧动态暂不可读'); return read(...args); };
  await f.due(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.postId, '70001');
  assert.equal(counts(f).replied, 1); assert.match(f.manager.rule(f.accountId).lastError, /暂不可读/); assert.equal(f.manager.rule(f.accountId).lastRun.state, 'partial');
});

test('an unknown submission stops the remaining friend replies for that round', async t => {
  const f = fixture(t), post = f.add(); post.comments.push(f.comment(103, { replyToCommentId: '101' })); f.enable();
  f.channel.transport.writeMoments = async args => { f.writes.push(args); throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '合成结果不明'); };
  await f.due(); assert.equal(f.writes.length, 1); assert.equal(f.models.length, 1); assert.equal(counts(f).unknown, 1);
});

test('a reply must point to a current-account parent, never a nickname, mention, nearby comment or another recipient', async t => {
  const f = fixture(t), post = f.add(); post.comments = [f.comment(101, { userId: f.accountId }), f.comment(202, { userId: 'third-party' }),
    f.comment(102, { text: '@合成测试 你也来看看' }), f.comment(103, { replyToCommentId: '202', replyToUserId: 'third-party' }),
    f.comment(104, { replyToCommentId: '101', replyToUserId: 'third-party' }), f.comment(105, { replyToCommentId: '999', replyToUserId: f.accountId }),
    f.comment(106, { userId: f.accountId, replyToCommentId: '101' }), f.comment(107, { deleted: true, replyToCommentId: '101' }),
    f.comment(108, { replyToCommentId: '109' }), f.comment(109, { userId: f.accountId, deleted: true })];
  f.enable(); await f.due(); assert.equal(f.models.length, 0); assert.equal(f.writes.length, 0);
  post.comments.push(f.comment(110, { userId: 'third-party', replyToCommentId: '101' })); await f.due();
  assert.equal(f.writes.length, 1); assert.equal(reply(f).replyToUserId, 'third-party', 'a real participant can reply to us even when not the post author');
});

test('each switch has its own activation time; old replies need explicit includeExisting', async t => {
  const f = fixture(t), post = f.add(); f.configure({ enabled: true, intervalMinutes: 1 }); f.advance(120000); f.enable();
  const firstEnabledAt = f.manager.rule(f.accountId).friendEnabledAt; await f.due(); assert.equal(f.writes.length, 0);
  f.configure({ includeExisting: true }); await f.due(); assert.equal(f.writes.length, 1);
  f.configure({ friendRepliesEnabled: false, includeExisting: false }); post.comments.push(f.comment(203, { replyToCommentId: reply(f).replyId }));
  f.advance(120000); f.configure({ friendRepliesEnabled: true }); assert(f.manager.rule(f.accountId).friendEnabledAt > firstEnabledAt);
  await f.due(); assert.equal(f.writes.length, 1, 'replies while disabled are excluded by default');
});

test('already commented posts remain watched after leaving the timeline and after restart', async t => {
  const f = fixture(t), post = f.add(); f.enable(); await f.due(); const parent = reply(f).replyId;
  f.hidden.add(post.id); post.comments.push(f.comment(203, { replyToCommentId: parent, replyToUserId: f.accountId }));
  f.create(); assert.equal(f.manager.error, undefined); await f.due(); assert.equal(f.writes.length, 2); assert.equal(f.writes.at(-1).query.replyToCommentId, '203');
});

test('manual top-level comment receipts enroll a post even before automatic replies are enabled', async t => {
  const f = fixture(t), post = f.add('70001', { comments: [] });
  const receipt = await f.channel.moments.writeOwner({ action: 'comment', postId: post.id, text: '手动评论' }, f.accountId, 'manual-top-level', new AbortController().signal);
  f.hidden.add(post.id); post.comments.push(f.comment(203, { replyToCommentId: receipt.commentId, replyToUserId: f.accountId })); f.enable();
  await f.due(); assert.equal(f.writes.length, 2); assert.equal(f.writes.at(-1).query.replyToCommentId, '203');
});

test('comments after the first 50 are included and failed generations consume the per-round limit', async t => {
  const f = fixture(t), post = f.add(); post.comments = [post.comments[0], ...Array.from({ length: 50 }, (_, index) => f.comment(index + 300)),
    ...[102, 103, 104].map(id => f.comment(id, { replyToCommentId: '101' }))];
  f.enable({ maxFriendRepliesPerRun: 2 }); f.channel.runner.run = async input => { f.models.push(input); throw new Error('合成模型故障'); };
  await f.due(); assert.equal(counts(f).attempted, 2); assert.equal(f.models.length, 2); assert.equal(f.writes.length, 0);
  assert.equal(f.reads.filter(row => row.query.action === 'comments').length, 2);
});

for (const invalid of ['account', 'post', 'source', 'repeated-cursor', 'duplicate-id', 'missing-page', 'changed-total', 'malformed-relationship'])
  test('incomplete or mismatched comment reads fail closed: ' + invalid, async t => {
    const f = fixture(t); f.add(); f.enable(); const read = f.channel.transport.readMoments;
    f.channel.transport.readMoments = async (...args) => {
      const result = await read(...args); if (args[0].query.action !== 'comments') return result;
      if (invalid === 'account') result.accountId = 'another-account';
      if (invalid === 'post') result.postId = '70099';
      if (invalid === 'source') result.source = 'cached';
      if (invalid === 'duplicate-id') result.items[1].id = result.items[0].id;
      if (invalid === 'missing-page') result.visibleCommentEntries = 200;
      if (invalid === 'malformed-relationship') result.items[1].replyToUserId = 123;
      if (invalid === 'repeated-cursor') { result.nextCursor = 'same'; result.items = []; }
      if (invalid === 'changed-total') { result.visibleCommentEntries = args[0].query.cursor ? 3 : 2; result.nextCursor = args[0].query.cursor ? null : '2'; }
      return result;
    };
    await f.due(); assert.equal(f.models.length, 0); assert.equal(f.writes.length, 0); assert.equal(counts(f).readFailed, 1); assert(counts(f).lastError);
  });

test('a stale, deleted, invisible or differently authored post is never answered', async t => {
  for (const reason of ['own', 'deleted', 'hidden', 'old', 'changed-author']) await t.test(reason, async t => {
    const f = fixture(t); f.add(); f.enable(); const read = f.channel.transport.readMoments;
    f.channel.transport.readMoments = async (...args) => {
      const result = await read(...args); if (args[0].query.action === 'detail') {
        if (reason === 'own') result.items[0].author.userId = f.accountId;
        if (reason === 'deleted') result.items[0].deleted = true;
        if (reason === 'hidden') result.items[0].contentAvailable = false;
        if (reason === 'old') result.items[0].createdAt -= 30 * 86400;
        if (reason === 'changed-author') result.items[0].author.userId = 'different-friend';
      } return result;
    };
    await f.due(); assert.equal(f.models.length, 0); assert.equal(f.writes.length, 0);
  });
});

test('a model may end a finished conversation without repeated generation', async t => {
  const f = fixture(t); f.add(); f.enable(); f.channel.runner.run = async input => { f.models.push(input); return { text: '{"text":"","skipReason":"对方已道谢并结束话题"}' }; };
  await f.due(); assert.equal(reply(f).state, 'skipped'); assert.equal(f.writes.length, 0); await f.due(); assert.equal(f.models.length, 1);
});

test('invalid generated content is not sent and a later successful generation can retry', async t => {
  const f = fixture(t); f.add(); f.enable(); const model = f.channel.runner.run; f.channel.runner.run = async () => ({ text: '没有 JSON 的无效内容' });
  await f.due(); assert.equal(reply(f).state, 'failed'); assert.equal(f.writes.length, 0);
  f.channel.runner.run = model; await f.due(); assert.equal(f.writes.length, 1); assert.equal(reply(f).state, 'sent');
});

for (const change of ['friend-off', 'global-off', 'offline', 'account', 'settings', 'close'])
  test('configuration or connection changes cancel a generated reply before submission: ' + change, async t => {
    const f = fixture(t), g = gate(t); f.add(); f.enable(); f.channel.runner.run = async () => { g.entered.resolve(); await g.release.promise; return { text: '{"text":"旧回复","skipReason":""}' }; };
    const pending = f.due(); await g.entered.promise;
    let closed;
    if (change === 'friend-off') f.configure({ friendRepliesEnabled: false });
    if (change === 'global-off') f.settings.enabled = false;
    if (change === 'offline') f.status.online = false;
    if (change === 'account') f.status.account = { id: 'changed-account' };
    if (change === 'settings') f.configure({ replyInstructions: '新的风格' });
    if (change === 'close') closed = f.manager.close();
    g.release.resolve(); await pending; await closed; assert.equal(f.writes.length, 0);
    if (change === 'friend-off') assert.equal(f.manager.rule(f.accountId).nextRunAt, 0);
  });

test('phone replies found in the final refresh prevent an automatic duplicate', async t => {
  const f = fixture(t), post = f.add(); f.enable(); const model = f.channel.runner.run;
  f.channel.runner.run = async input => { post.comments.push(f.comment(300, { userId: f.accountId, text: '已在手机回复', replyToCommentId: '102', replyToUserId: 'friend-a' })); return model(input); };
  await f.due(); assert.equal(f.writes.length, 0); assert.equal(reply(f).state, 'existing'); assert.equal(reply(f).text, '已在手机回复');
  post.comments.pop(); await f.due(); assert.equal(f.models.length, 1, 'the observed reply is remembered even if a later page lags');
});

test('a manual plugin reply during generation keeps its exact confirmed receipt', async t => {
  const f = fixture(t), post = f.add(), g = gate(t); f.enable(); const model = f.channel.runner.run;
  f.channel.runner.run = async input => { g.entered.resolve(); await g.release.promise; return model(input); };
  const pending = f.due(); await g.entered.promise;
  const manual = await f.channel.moments.writeOwner({ action: 'comment', postId: post.id, replyToCommentId: '102', text: '手动接话' }, f.accountId, 'manual-reply', new AbortController().signal);
  g.release.resolve(); await pending; assert.equal(f.writes.length, 1); assert.equal(reply(f).state, 'sent');
  assert.equal(reply(f).replyId, manual.commentId); assert.equal(reply(f).text, '手动接话'); assert.equal(reply(f).delivery, 'server-ack');
});

test('edits to the post or parent during generation discard the stale draft', async t => {
  const f = fixture(t), post = f.add(); f.enable(); const model = f.channel.runner.run;
  f.channel.runner.run = async input => { const result = await model(input); post.comments[0].text = '前文已修改'; return result; };
  await f.due(); assert.equal(f.writes.length, 0); assert.equal(reply(f).state, 'skipped'); assert.match(reply(f).error, /变化/);
});

for (const delivery of ['unknown', 'rejected', 'wrong-recipient']) test('uncertain or rejected replies remain blocked after restart: ' + delivery, async t => {
  const f = fixture(t); f.add(); f.enable(); const write = f.channel.transport.writeMoments;
  f.channel.transport.writeMoments = async (...args) => {
    if (delivery === 'wrong-recipient') return { ...await write(...args), replyToUserId: 'different-recipient' };
    f.writes.push(args[0]); throw new ChannelError('SYNTHETIC_DELIVERY', '合成未确认', delivery === 'rejected' ? { snsDelivery: 'rejected' } : {});
  };
  await f.due(); assert.equal(reply(f).state, delivery === 'rejected' ? 'rejected' : 'unknown');
  f.create(); assert.equal(f.manager.error, undefined); await f.due(); assert.equal(f.writes.length, 1); assert.equal(f.models.length, 1);
});

test('cancellation just after a confirmed write preserves success and its count', async t => {
  const f = fixture(t); f.add(); f.enable(); const write = f.channel.transport.writeMoments;
  f.channel.transport.writeMoments = async (...args) => { const result = await write(...args); f.configure({ friendRepliesEnabled: false }); return result; };
  await f.due(); assert.equal(reply(f).state, 'sent'); assert.equal(counts(f).replied, 1); assert.equal(f.writes.length, 1);
  f.create(); assert.equal(f.manager.error, undefined); assert.equal(reply(f).state, 'sent');
});

test('sending records become unknown on restart and cleared history keeps reply deduplication', async t => {
  const f = fixture(t), post = f.add(); f.enable(); await f.due();
  const cleanup = new OwnerCleanup(f.channel); cleanup.remove(f.accountId, cleanup.preview(f.accountId, { kind: 'moments.replies' }));
  assert.equal(f.manager.list(f.accountId).replies.length, 0); post.comments.pop(); f.create(); await f.due(); assert.equal(f.writes.length, 1);
  const stored = Object.values(f.manager.data.replies)[0]; stored.state = 'sending'; f.manager.save(); f.create();
  assert.equal(Object.values(f.manager.data.replies)[0].state, 'unknown'); await f.due(); assert.equal(f.writes.length, 1);
});

test('old settings migrate with the new switch off and every prior setting preserved', async t => {
  const f = fixture(t); f.configure({ enabled: true, intervalMinutes: 27, maxRepliesPerRun: 13, replyInstructions: '保留这个风格' });
  const data = structuredClone(f.manager.data), rule = data.accounts[f.accountId];
  delete rule.friendEnabledAt; delete rule.settings.friendRepliesEnabled; delete rule.settings.maxFriendRepliesPerRun; delete data.friendPosts;
  fs.writeFileSync(f.manager.file(), JSON.stringify(data)); f.create(); assert.equal(f.manager.error, undefined);
  const migrated = f.manager.rule(f.accountId); assert.equal(migrated.settings.enabled, true); assert.equal(migrated.settings.intervalMinutes, 27);
  assert.equal(migrated.settings.friendRepliesEnabled, false); assert.equal(migrated.settings.maxFriendRepliesPerRun, 5); assert.equal(migrated.friendEnabledAt, 0);
  assert.equal(migrated.settings.replyInstructions, '保留这个风格'); assert.equal(f.writes.length, 0);
});

for (const corruption of ['parent', 'recipient', 'tracked-account', 'activation-time']) test('invalid persisted friend state is preserved and stops this subsystem: ' + corruption, async t => {
  const f = fixture(t); f.add(); f.enable(); await f.due(); const data = structuredClone(f.manager.data), row = Object.values(data.replies)[0];
  if (corruption === 'parent') row.ourComment.userId = 'not-me';
  if (corruption === 'recipient') row.incomingReply.replyToUserId = 'not-me';
  if (corruption === 'tracked-account') Object.values(data.friendPosts)[0].accountId = 'not-me';
  if (corruption === 'activation-time') data.accounts[f.accountId].friendEnabledAt = 0;
  const content = JSON.stringify(data); fs.writeFileSync(f.manager.file(), content); f.create();
  assert(f.manager.error); await f.due(); assert.equal(f.writes.length, 1); assert.equal(fs.readFileSync(f.manager.file(), 'utf8'), content);
});

test('friend reply generation receives actual photo evidence, and image-read failures never invent a comment', async t => {
  for (const mode of ['complete', 'unreadable', 'unavailable', 'vision-off']) await t.test(mode, async t => {
    const f = fixture(t), post = f.add('70001', { imageCount: 1, media: [{ id: 'photo', type: 'image' }] }); f.enable();
    const stickers = path.join(import.meta.dirname, '../assets/stickers');
    const bytes = fs.readFileSync(path.join(stickers, fs.readdirSync(stickers, { recursive: true }).find(file => file.endsWith('.png'))));
    f.channel.transport.readMomentsImages = async ({ accountId, query }) => {
      f.imageReads.push(query.postId); if (mode === 'unavailable') throw Error('合成读图失败');
      return { accountId, postId: post.id, post: structuredClone(post), source: 'wechat-sns-images-live', complete: true, imageCount: 1,
        items: [{ index: 1, mediaId: 'photo', bytes: bytes.length, data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' }] };
    };
    if (mode === 'vision-off') f.channel.store.modelConfig = () => ({ vision: false });
    if (mode === 'unreadable') f.channel.runner.run = async input => { f.models.push(input); return { text: '{"images":[{"index":1,"readable":false,"description":"图片内容看不清"}]}' }; };
    await f.due();
    if (mode === 'complete') {
      assert.equal(f.writes.length, 1); assert.equal(f.models[0].mode, 'moments-image-read'); assert.equal(f.models[0].images.length, 1);
      assert.equal(JSON.parse(f.models[1].text).imageContext[0].description, '桌上有一只白色茶杯'); assert.equal(reply(f).imageContext.postId, post.id);
    } else { assert.equal(f.writes.length, 0); assert.equal(f.models.filter(row => row.mode === 'moments-reply').length, 0); assert.equal(reply(f).state, 'failed'); }
  });
});

test('the existing schedule tool exposes both independent switches and preserves partial configuration', async t => {
  const f = fixture(t); f.configure({ enabled: true, intervalMinutes: 18 });
  const calls = [], tool = momentsPublishingTools({ manage: async query => { calls.push(query); return query.action === 'reply-list' ? f.manager.list(f.accountId) : f.configure(query.settings); } })
    .find(row => row.name === 'wechat_moments_reply_schedule');
  assert.equal(tool.parameters.properties.settings.properties.friendRepliesEnabled.type, 'boolean');
  assert.equal(tool.parameters.properties.settings.properties.maxFriendRepliesPerRun.maximum, 50);
  const result = JSON.parse(await tool.execute({ action: 'configure', settings: { friendRepliesEnabled: true, maxFriendRepliesPerRun: 3 } }, { signal: new AbortController().signal }));
  assert.equal(result.ok, true); assert.equal(result.settings.enabled, true); assert.equal(result.settings.intervalMinutes, 18);
  assert.equal(result.settings.friendRepliesEnabled, true); assert.equal(calls[0].action, 'reply-configure'); assert.equal(f.writes.length, 0);
  const invalid = JSON.parse(await tool.execute({ action: 'configure', settings: { maxFriendRepliesPerRun: -1 } }, { signal: new AbortController().signal }));
  assert.equal(invalid.ok, false); assert.equal(calls.length, 1);
});
