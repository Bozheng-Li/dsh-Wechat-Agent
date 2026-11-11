import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MomentsInteractions, MomentsService, interactionAutomationSettings, momentsInteractionTool, ChannelError
} from '../lib/testing.js';




import { createHash } from 'node:crypto';

function fixture(t, dependencies = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-interaction-auto-')), accountId = 'auto-owner';
  let now = Date.parse('2026-11-10T04:00:00Z');
  const posts = [], reads = [], writes = [], models = [], managers = [], admins = ['admin'];
  const settings = { enabled: true, privatePeers: ['admin', 'ordinary'], groups: [] };
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const scope = { accountId, chatType: 'private', peerId: 'admin', senderId: 'admin' };
  const channel = { now: () => now, store: { root, data: { storeId: 'auto-interaction-fixture' }, persona: () => ({ name: '本地测试' }),
    settings: () => settings, conversationSettings: () => ({ remoteEnabled: true, adminIds: admins }), config: { assertCurrent() {}, section: () => ({ globalAdminIds: [] }) } },
    transport: { status: () => status, call: async () => ({ privatePeers: [{ id: 'friend-a', name: '朋友甲' }, { id: accountId, name: '本账号' }] }),
      readMoments: async (args, signal) => {
        signal?.throwIfAborted(); reads.push(structuredClone(args)); const { query } = args;
        const filtered = posts.filter(post => query.action === 'detail' ? post.id === query.postId : query.action !== 'user' || post.author.userId === query.userId);
        if (query.action === 'comments') return { accountId: args.accountId, action: 'comments', postId: query.postId, source: 'wechat-sns-live',
          items: structuredClone(posts.find(post => post.id === query.postId)?.comments ?? []), nextCursor: null };
        const offset = Number(query.cursor ?? 0), limit = query.limit ?? 20;
        return { accountId: args.accountId, action: query.action, source: 'wechat-sns-live', items: structuredClone(filtered.slice(offset, offset + limit)),
          nextCursor: filtered.length > offset + limit ? String(offset + limit) : null };
      },
      writeMoments: async (args, signal) => {
        signal?.throwIfAborted(); writes.push(structuredClone(args)); const { query } = args, post = posts.find(row => row.id === query.postId);
        if (query.action === 'like') post.likedByCurrentAccount = true;
        else { post.comments.push({ userId: args.accountId, id: String(900 + writes.length), text: query.text }); post.visibleCommentEntries = post.comments.length; }
        return { accountId: args.accountId, action: query.action, postId: query.postId, delivery: 'server-ack',
          ...(query.action === 'like' ? { liked: true } : { commentId: String(900 + writes.length), text: query.text }) };
      } },
    runner: { run: async input => { models.push(input); return { text: JSON.stringify({ comments: JSON.parse(input.text).posts.map(post => ({ postId: post.postId, text: '回应：' + post.text, skipReason: '' })) }) }; } } };
  channel.moments = new MomentsService(channel);
  const create = () => { const manager = new MomentsInteractions(channel, { sleep: async (_ms, signal) => signal?.throwIfAborted(), ...dependencies });
    managers.push(manager); channel.momentsAutomation = { interactions: manager, recordReceipt() {} }; return manager; };
  const manager = create(), auto = manager.automation;
  const add = (id, extra = {}) => { const post = { id: String(id), author: { userId: 'friend-a', nickname: '朋友甲' }, text: '今天试了新的咖啡。',
    createdAt: Math.floor(now / 1000) - Number(id), deleted: false, contentAvailable: true, likedByCurrentAccount: false,
    imageCount: 0, media: [], comments: [], visibleCommentEntries: 0, commentCount: 0, likeCount: 0, ...extra }; posts.push(post); return post; };
  const configure = (patch = {}, actor) => auto.configure(accountId, patch, auto.list(accountId).revision, undefined, undefined, actor);
  const enable = async (patch = {}, actor) => { auto.start(); return configure({ enabled: true, intervalMinutes: 5, intervalSeconds: 0, perFriendLimit: 20, ...patch }, actor); };
  const due = () => { now = Math.max(now, auto.list(accountId).nextRunAt); return auto.tick(); };
  t.after(async () => { await Promise.all(managers.map(value => value.close())); const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); assert.match(path.basename(target), /^wechat-interaction-auto-/); fs.rmSync(target, { recursive: true, force: true }); });
  return { root, accountId, manager, auto, create, channel, status, scope, admins, settings, posts, reads, writes, models, add, configure, enable, due,
    get now() { return now; }, advance: ms => { now += ms; } };
}
const gate = t => { const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve()); return { entered, release }; };

test('automatic comments read photos only after skip rules and reuse their evidence during generation', async t => {
  const f = fixture(t), imageReads = [], vision = [], original = f.channel.runner.run;
  const bytes = fs.readFileSync(path.join(import.meta.dirname, '../assets/stickers', fs.readdirSync(path.join(import.meta.dirname, '../assets/stickers'), { recursive: true }).find(file => file.endsWith('.png'))));
  const photo = { imageCount: 1, media: [{ id: 'photo', type: 'image' }] };
  f.add(1, { ...photo, comments: [{ userId: f.accountId, id: '99' }], visibleCommentEntries: 1 });
  f.add(2, { ...photo, text: '' }); f.add(3, photo);
  f.channel.transport.readMomentsImages = async ({ accountId, query }) => {
    imageReads.push(query.postId); const post = structuredClone(f.posts.find(row => row.id === query.postId));
    return { accountId, postId: post.id, post, source: 'wechat-sns-images-live', complete: true, imageCount: 1,
      items: [{ index: 1, mediaId: 'photo', data: bytes.toString('base64'), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' }] };
  };
  f.channel.runner.run = async input => {
    if (input.mode !== 'moments-image-read') return original(input);
    vision.push(input); return { text: '{"images":[{"index":1,"readable":true,"description":"一只茶杯放在桌上"}]}' };
  };
  await f.enable({ likeCount: 2, commentCount: 0 }); await f.due(); assert.deepEqual(imageReads, []); assert.equal(f.models.length, 0);
  await f.configure({ commentCount: 1 }); const result = await f.due();
  assert.deepEqual(imageReads, ['2']); assert.equal(vision.length, 1); assert.equal(result.counts.commented, 1);
  assert.equal(JSON.parse(f.models[0].text).posts[0].imageContext[0].description, '一只茶杯放在桌上');
});

test('automatic interaction defaults stay off and reject invalid schedules, quotas and skip flags', () => {
  const value = interactionAutomationSettings(); assert.equal(value.enabled, false); assert.equal(value.skipLiked, true); assert.equal(value.skipCommented, true);
  for (const input of [null, [], { arbitrary: true }, { enabled: 'yes' }, { intervalMinutes: 4 }, { intervalMinutes: 1441 }, { lookbackDays: 0 },
    { lookbackDays: 31 }, { likeCount: -1 }, { commentCount: 21 }, { likeCount: 1.5 }, { enabled: true, likeCount: 0, commentCount: 0 },
    { skipLiked: 1 }, { skipCommented: 'yes' }, { mode: 'manual' }, { source: 'selected' }, { source: 'user' }, { commentMode: 'manual' },
    { commentMode: 'fixed', commentText: ' ' }, { poolSize: 101 }, { poolSize: 2 }, { intervalSeconds: 61 }, { perFriendLimit: 0 }])
    assert.throws(() => interactionAutomationSettings(input), { code: 'MOMENTS_INTERACTION_SETTINGS_INVALID' });
  assert.equal(interactionAutomationSettings({ likeCount: 0 }).likeCount, 0);
});

test('saving an enabled rule is read-only and the first round starts only after the configured interval', async t => {
  const f = fixture(t); for (let id = 1; id <= 8; id++) f.add(id);
  f.auto.start(); await f.auto.tick(); assert.equal(f.reads.length, 0);
  const enabled = await f.enable(); assert.equal(enabled.nextRunAt, f.now + 300000); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.auto.file(), 'utf8')).ownerStoreId, f.channel.store.data.storeId);
  f.advance(299999); await f.auto.tick(); assert.equal(f.writes.length, 0); f.advance(1);
  const result = await f.auto.tick(); assert.equal(result.counts.liked, 5); assert.equal(result.counts.commented, 2);
  assert.equal(f.auto.list(f.accountId).lastRun.runId, result.id); assert.equal(f.auto.list(f.accountId).nextRunAt, f.now + 300000);
  assert.equal(f.manager.list(f.accountId).automation.running, false);
});

test('automatic quotas skip already liked or commented entries before choosing independent action targets', async t => {
  const f = fixture(t), own = { userId: f.accountId, id: '800', text: '之前评过' };
  f.add(1, { likedByCurrentAccount: true, comments: [own], visibleCommentEntries: 1 });
  f.add(2, { likedByCurrentAccount: true }); f.add(3, { comments: [own], visibleCommentEntries: 1 }); f.add(4, { text: '[微笑]', imageCount: 2 }); f.add(5);
  f.add(6, { author: { userId: f.accountId } }); f.add(7, { createdAt: f.now / 1000 - 8 * 86400 });
  await f.enable({ likeCount: 3, commentCount: 2 }); const result = await f.due();
  assert.deepEqual(f.writes.map(row => [row.query.action, row.query.postId]), [['comment', '2'], ['like', '3'], ['like', '4'], ['like', '5'], ['comment', '5']]);
  assert.equal(result.counts.liked, 3); assert.equal(result.counts.commented, 2); assert.equal(result.scan.selection.skippedLiked, 2);
  assert.equal(result.scan.selection.skippedCommented, 2); assert.equal(result.scan.selection.unreadable, 1);
  assert.deepEqual(JSON.parse(f.models[0].text).posts.map(row => row.postId), ['2', '5']); assert.deepEqual(f.models[0].tools, []);
});

test('confirmed and hidden history prevents repeats even when the next live timeline temporarily lags', async t => {
  const f = fixture(t); f.add(1); f.add(2); await f.enable({ likeCount: 1, commentCount: 1 });
  const first = await f.due(); f.manager.data.runs[first.id].historyDeleted = true; f.manager.save();
  f.posts[0].likedByCurrentAccount = false; f.posts[0].comments = []; f.posts[0].visibleCommentEntries = 0;
  const second = await f.due(); assert.deepEqual(second.rows.map(row => row.postId), ['2']); assert.equal(f.writes.length, 4);
  await f.due(); assert.equal(f.writes.length, 4);
});

test('turning skip off permits a fresh comment but never unlikes or submits an already confirmed like', async t => {
  const f = fixture(t); f.add(1, { likedByCurrentAccount: true, comments: [{ userId: f.accountId, id: '800' }], visibleCommentEntries: 1 });
  await f.enable({ likeCount: 1, commentCount: 1, skipLiked: false, skipCommented: false, commentMode: 'fixed', commentText: '再次回应' });
  const result = await f.due(); assert.equal(result.counts.alreadyLiked, 1); assert.equal(result.counts.commented, 1);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.action, 'comment'); await f.due(); assert.equal(f.writes.length, 2);
});

test('unknown submissions stop the batch and are excluded from future rounds even with skips disabled', async t => {
  const f = fixture(t); f.add(1); f.add(2); const write = f.channel.transport.writeMoments;
  f.channel.transport.writeMoments = async args => { f.writes.push(args); throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '合成未知回执'); };
  await f.enable({ likeCount: 0, commentCount: 2, skipLiked: false, skipCommented: false, commentMode: 'fixed', commentText: '合成回复' });
  const first = await f.due(); assert.equal(first.state, 'partial'); assert.equal(first.counts.unknown, 1); assert.equal(f.writes.length, 1);
  f.channel.transport.writeMoments = write; const second = await f.due(); assert.deepEqual(second.rows.map(row => row.postId), ['2']);
  assert.equal(second.scan.selection.skippedUnknown, 1); assert.equal(f.writes.filter(row => row.query.postId === '1').length, 1);
});

test('malformed generated content fails a round before any likes or comments are submitted', async t => {
  const f = fixture(t); f.add(1); f.channel.runner.run = async () => ({ text: '没有可核实的 ID' });
  await f.enable({ likeCount: 1, commentCount: 1 }); const result = await f.due();
  assert.equal(result.state, 'failed'); assert.equal(f.writes.length, 0); assert(f.auto.list(f.accountId).lastRun.message);
});

test('disabling while comments are generating aborts the old round and removes the next check', async t => {
  const f = fixture(t), g = gate(t); f.add(1); f.channel.runner.run = async input => { g.entered.resolve(); await g.release.promise; input.signal.throwIfAborted(); throw Error('Should be aborted'); };
  await f.enable({ likeCount: 1, commentCount: 1 }); const pending = f.due(); await g.entered.promise;
  assert.equal(f.auto.list(f.accountId).running, true); assert.equal(f.manager.list(f.accountId).runs[0].phase, 'generating');
  await f.configure({ enabled: false }); g.release.resolve(); const result = await pending;
  assert.equal(result.state, 'cancelled'); assert.equal(f.writes.length, 0); assert.equal(f.auto.list(f.accountId).nextRunAt, 0);
  assert.equal(f.auto.list(f.accountId).settings.enabled, false); assert.equal(f.auto.list(f.accountId).lastRun.state, 'cancelled');
});

test('stop-current preserves the first confirmed receipt and the next scheduled interval', async t => {
  const g = gate(t), f = fixture(t, { sleep: async (_ms, signal) => { g.entered.resolve(); await g.release.promise; signal.throwIfAborted(); } });
  f.add(1); f.add(2); await f.enable({ likeCount: 2, commentCount: 0, intervalSeconds: 3 });
  const pending = f.due(); await g.entered.promise; f.auto.cancel(f.accountId); g.release.resolve(); const result = await pending;
  assert.equal(result.state, 'cancelled'); assert.equal(result.counts.liked, 1); assert.equal(f.writes.length, 1);
  assert.equal(f.auto.list(f.accountId).settings.enabled, true); assert.equal(f.auto.list(f.accountId).nextRunAt, f.now + 300000);
});

test('editing settings during selection cancels the old revision and preserves the new interval', async t => {
  const f = fixture(t), g = gate(t); f.add(1); const read = f.channel.transport.readMoments;
  f.channel.transport.readMoments = async (...args) => { g.entered.resolve(); await g.release.promise; return read(...args); };
  const old = await f.enable({ likeCount: 1, commentCount: 0 }); const pending = f.due(); await g.entered.promise;
  const saved = await f.configure({ intervalMinutes: 90, commentCount: 1 }); g.release.resolve(); assert.equal((await pending).state, 'cancelled');
  assert.equal(f.writes.length, 0); assert.equal(f.auto.list(f.accountId).nextRunAt, f.now + 90 * 60000);
  assert.equal(f.auto.list(f.accountId).revision, saved.revision);
  await assert.rejects(f.auto.configure(f.accountId, { enabled: false }, old.revision), { code: 'MOMENTS_INTERACTION_SETTINGS_CHANGED' });
});

test('concurrent timer ticks share one round and a running manual round excludes automatic execution', async t => {
  const f = fixture(t), g = gate(t); f.add(1); const run = f.channel.runner.run;
  f.channel.runner.run = async input => { g.entered.resolve(); await g.release.promise; return run(input); };
  await f.enable({ likeCount: 0, commentCount: 1 }); const pending = f.due(); await g.entered.promise;
  assert.equal(f.auto.tick(), pending); const preview = await f.manager.preview(f.accountId, { action: 'like', count: 1 }, 'manual');
  assert.throws(() => f.manager.start(f.accountId, preview.id, preview.revision), { code: 'MOMENTS_INTERACTION_BUSY' });
  g.release.resolve(); await pending; assert.equal(f.writes.length, 1);
  const g2 = gate(t), read = f.channel.transport.readMoments;
  f.channel.transport.readMoments = async (...args) => { g2.entered.resolve(); await g2.release.promise; return read(...args); };
  f.manager.start(f.accountId, preview.id, preview.revision); await g2.entered.promise;
  await f.due(); assert.equal(f.auto.list(f.accountId).running, false); g2.release.resolve(); await f.manager.whenIdle();
});

for (const change of ['offline', 'account', 'global', 'authorization']) test('automatic execution pauses on ' + change + ' changes before submitting', async t => {
  const f = fixture(t), g = gate(t); f.add(1); const read = f.channel.transport.readMoments;
  f.channel.transport.readMoments = async (...args) => { g.entered.resolve(); await g.release.promise; return read(...args); };
  await f.enable({ likeCount: 1, commentCount: 0 }, change === 'authorization' ? f.scope : undefined);
  const pending = f.due(); await g.entered.promise;
  if (change === 'offline') f.status.online = false;
  if (change === 'account') f.status.account = { id: 'different-account' };
  if (change === 'global') f.settings.enabled = false;
  if (change === 'authorization') f.admins.splice(0);
  const tick = f.auto.tick(); g.release.resolve(); await Promise.all([pending, tick]); assert.equal(f.writes.length, 0);
  assert(f.auto.list(f.accountId).pausedReason); assert.equal(f.auto.list(f.accountId).lastRun.state, 'cancelled');
});

test('offline settings can be disabled and do not invoke live reads', async t => {
  const f = fixture(t); await f.enable(); f.status.online = false; const saved = await f.configure({ enabled: false });
  assert.equal(saved.settings.enabled, false); assert.equal(saved.nextRunAt, 0); assert.equal(f.reads.length, 0);
});

test('restart preserves settings and receipts but schedules a fresh future check instead of catching up', async t => {
  const f = fixture(t); f.add(1); f.add(2); await f.enable({ likeCount: 1, commentCount: 0 }); await f.due(); await f.manager.close();
  f.advance(86400000); const restarted = f.create(); restarted.automation.start(); assert.equal(restarted.error, undefined);
  assert.equal(restarted.automation.list(f.accountId).nextRunAt, f.now + 300000); await restarted.automation.tick(); assert.equal(f.writes.length, 1);
  f.advance(300000); await restarted.automation.tick(); assert.equal(f.writes.length, 2); assert.deepEqual(f.writes.map(row => row.query.postId), ['1', '2']);
});

test('unreadable or foreign schedule data is preserved and never triggers writes', async t => {
  const f = fixture(t); await f.configure({ intervalMinutes: 20 }); const stored = JSON.parse(fs.readFileSync(f.auto.file(), 'utf8'));
  stored.ownerStoreId = 'someone-else'; const raw = JSON.stringify(stored); fs.writeFileSync(f.auto.file(), raw);
  const restarted = f.create(); restarted.automation.start(); await restarted.automation.tick(); assert(restarted.automation.error);
  assert.equal(fs.readFileSync(f.auto.file(), 'utf8'), raw); assert.equal(f.writes.length, 0);
});

test('failed schedule persistence prevents any first round and preserves the filesystem obstruction', async t => {
  const f = fixture(t); fs.mkdirSync(f.auto.file(), { recursive: true });
  await assert.rejects(f.enable(), { code: 'STATE_WRITE_FAILED' }); await f.auto.tick(); assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
  assert(fs.statSync(f.auto.file()).isDirectory());
});

test('automatic friend selection resolves and stores the exact ID, rejects self and never switches to timeline', async t => {
  const f = fixture(t); f.add(1); f.add(2, { author: { userId: 'friend-b' } });
  const saved = await f.enable({ source: 'user', user: '朋友甲', likeCount: 1, commentCount: 0 }); assert.equal(saved.settings.user, 'friend-a');
  f.channel.transport.call = async () => ({ privatePeers: [{ id: 'friend-a', name: '已改名' }, { id: 'friend-b', name: '朋友甲' }, { id: f.accountId, name: '本人' }] });
  const result = await f.due(); assert.equal(result.targetUserId, 'friend-a'); assert.equal(f.reads[0].query.action, 'user'); assert.equal(f.reads[0].query.userId, 'friend-a');
  await assert.rejects(f.configure({ user: f.accountId }), { code: 'MOMENTS_INTERACTION_TARGET' });
  assert.equal(f.auto.list(f.accountId).settings.user, 'friend-a');
});

test('random automatic selection respects friend caps and records a fixed chosen list', async t => {
  let calls = 0; const f = fixture(t, { random: max => { calls++; return max - 1; } });
  f.add(1); f.add(2); f.add(3, { author: { userId: 'friend-b' } }); f.add(4, { author: { userId: 'friend-c' } });
  await f.enable({ mode: 'random', perFriendLimit: 1, likeCount: 3, commentCount: 1 }); const result = await f.due();
  assert.deepEqual(result.rows.map(row => row.postId), ['1', '3', '4']); assert.equal(calls, 3);
  const copy = f.manager.list(f.accountId, result.id).current; assert.deepEqual(copy.rows, result.rows); assert.equal(calls, 3);
});

test('the union of separate automatic like and comment targets never exceeds twenty posts', async t => {
  const f = fixture(t); for (let id = 1; id <= 40; id++) f.add(id, { likedByCurrentAccount: id <= 20,
    ...(id > 20 ? { comments: [{ id: '800', userId: f.accountId }], visibleCommentEntries: 1 } : {}) });
  await f.enable({ likeCount: 20, commentCount: 20, commentMode: 'fixed', commentText: '合成上限测试' }); const result = await f.due();
  assert.equal(result.rows.length, 20); assert.equal(f.writes.length, 20); assert.equal(result.counts.commented, 20); assert.equal(result.counts.liked, 0);
});

test('administrator tool configuration uses a revision and preserves unspecified settings without starting a round', async t => {
  const f = fixture(t), tool = momentsInteractionTool({ manage: (args, signal) => f.channel.moments.manageInteractions(args, f.scope, 'message-1', signal) });
  const execute = args => tool.execute(args, { signal: new AbortController().signal }).then(JSON.parse);
  const listed = await execute({ action: 'list' }); assert.equal(listed.automation.settings.enabled, false);
  const configured = await execute({ action: 'configure_auto', revision: listed.automation.revision, settings: { enabled: true, intervalMinutes: 40 } });
  assert(configured.ok); assert.equal(configured.settings.intervalMinutes, 40); assert.equal(configured.settings.likeCount, 5); assert.equal(f.writes.length, 0);
  assert((await execute({ action: 'stop_auto' })).ok); assert.equal((await execute({ action: 'configure_auto', settings: { enabled: false } })).ok, false);
  const ordinary = { ...f.scope, senderId: 'ordinary', peerId: 'ordinary' };
  await assert.rejects(f.channel.moments.manageInteractions({ action: 'configure_auto', revision: configured.revision, settings: { enabled: false } }, ordinary, 'ordinary-message'), { code: 'REMOTE_NOT_AUTHORIZED' });
  const disabled = await execute({ action: 'configure_auto', revision: configured.revision, settings: { enabled: false } });
  assert(disabled.ok); assert.equal(disabled.settings.intervalMinutes, 40); assert.equal(disabled.settings.enabled, false);
});
