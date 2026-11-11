import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MomentsLikes } from '../modules/moments/likes.mjs';
import { MomentsService } from '../modules/moments/service.mjs';
import { MOMENTS_LIKE_DEFAULTS, momentsLikeSettings } from '../shared/moments-likes.mjs';
import { ChannelError } from '../shared/contracts.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-likes-')), accountId = 'likes-owner';
  let clock = Date.parse('2026-11-10T04:00:00Z'), enabled = true;
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true }, reads = [], writes = [], posts = new Map();
  const channel = { now: () => clock, store: { root, data: { storeId: 'likes-test' }, settings: () => ({ enabled }) },
    transport: { status: () => status, readMoments: async ({ accountId: requestedAccount, query, scopeKey }, signal) => {
      signal.throwIfAborted(); reads.push({ accountId: requestedAccount, query, scopeKey });
      const all = posts.get(query.userId) ?? [], offset = Number(query.cursor ?? 0), items = all.slice(offset, offset + query.limit);
      return { accountId: requestedAccount, action: 'user', userId: query.userId, source: 'wechat-sns-live', items, nextCursor: offset + query.limit < all.length ? String(offset + query.limit) : null };
    }, writeMoments: async (args, signal) => {
      signal.throwIfAborted(); writes.push(args);
      return { accountId: args.accountId, action: 'like', postId: args.query.postId, liked: true, delivery: 'server-ack' };
    } } };
  channel.moments = new MomentsService(channel);
  const managers = [], create = () => { const manager = new MomentsLikes(channel); managers.push(manager); return manager; }, manager = create();
  const post = (id, extra = {}) => ({ id: String(id), author: { userId: 'friend-a', nickname: '朋友' }, createdAt: Math.floor(clock / 1000), text: '朋友动态',
    contentAvailable: true, deleted: false, likedByCurrentAccount: false, ...extra });
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.close())); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-moments-likes-/); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, channel, manager, create, accountId, status, reads, writes, posts, post, advance: ms => { clock += ms; },
    setTime: value => { clock = Date.parse(value); }, pause: () => { enabled = false; }, resume: () => { enabled = true; },
    configure: settings => manager.configure(accountId, { userIds: ['friend-a'], ...settings }) };
}

test('like defaults are off, friend IDs are private, and safety limits reject invalid settings', t => {
  const f = fixture(t); assert.deepEqual(f.manager.list(f.accountId).settings, { ...MOMENTS_LIKE_DEFAULTS, userIds: [] });
  assert.deepEqual(momentsLikeSettings({ userIds: ['friend-a', 'friend-a'] }).userIds, ['friend-a']);
  for (const value of [null, [], { extra: true }, { enabled: true }, { respondToRequests: 'yes' }, { userIds: ['room@chatroom'] },
    { intervalMinutes: 4 }, { intervalMinutes: 1441 }, { lookbackDays: 31 }, { maxLikesPerRun: 21 }, { maxLikesPerDay: 101 }, { maxLikesPerDay: 0 }])
    assert.throws(() => momentsLikeSettings(value), error => error.code === 'MOMENTS_LIKE_SETTINGS_INVALID');
  assert.throws(() => f.configure({ enabled: true, userIds: [f.accountId] }));
  assert.throws(() => f.manager.runNow(f.accountId, 'empty'));
  f.configure({ enabled: false, respondToRequests: false }); f.manager.configure(f.accountId, { maxLikesPerDay: 10 });
  assert.equal(f.manager.rule(f.accountId).settings.respondToRequests, false, 'partial updates preserve request opt-out');
});

test('scheduled likes scan only selected friends and only new visible unliked posts', async t => {
  const f = fixture(t); f.configure({ enabled: true, intervalMinutes: 5 }); f.manager.stopped = false;
  const enabledAt = f.manager.rule(f.accountId).enabledAt;
  f.posts.set('friend-a', [f.post(1, { createdAt: (enabledAt - 1000) / 1000 }), f.post(2, { likedByCurrentAccount: true }),
    f.post(3, { deleted: true }), f.post(4, { contentAvailable: false }), f.post(5)]);
  await f.manager.tick(); assert.equal(f.reads.length, 0, 'saving does not execute');
  f.advance(300000); await Promise.all([f.manager.tick(), f.manager.tick()]);
  assert.deepEqual(f.reads.map(row => [row.query.action, row.query.userId]), [['user', 'friend-a']]);
  assert.deepEqual(f.writes.map(row => row.query.postId), ['5']);
  assert.equal(f.manager.list(f.accountId).lastRun.liked, 1); assert.equal(f.manager.list(f.accountId).today.attempted, 1);
  f.advance(300000); await f.manager.tick(); assert.equal(f.writes.length, 1);
  const restarted = f.create(); restarted.stopped = false; f.advance(300000); await restarted.tick(); assert.equal(f.writes.length, 1);
});

test('manual rule runs page beyond skipped entries and honor per-run limits without enabling the scheduler', async t => {
  const f = fixture(t); f.configure({ includeExisting: true, maxLikesPerRun: 2 });
  f.posts.set('friend-a', [...Array.from({ length: 20 }, (_, i) => f.post(i + 1, { likedByCurrentAccount: true })), f.post(21), f.post(22), f.post(23)]);
  const view = await f.manager.runNow(f.accountId, 'manual-one');
  assert.equal(view.settings.enabled, false); assert.equal(f.reads.length, 2); assert.deepEqual(f.writes.map(row => row.query.postId), ['21', '22']);
  assert.equal(view.lastRun.attempted, 2); assert.equal(view.lastRun.skipped, 20);
});

test('China calendar day caps count attempts and reset at midnight, while account records stay isolated', async t => {
  const f = fixture(t); f.setTime('2026-11-10T15:59:00Z'); f.configure({ includeExisting: true, maxLikesPerRun: 5, maxLikesPerDay: 1 });
  f.posts.set('friend-a', [f.post(1), f.post(2)]);
  await f.manager.runNow(f.accountId, 'before-midnight'); await f.manager.runNow(f.accountId, 'same-day');
  assert.equal(f.writes.length, 1); assert.equal(f.manager.list(f.accountId).today.date, '2026-11-10');
  f.advance(60000); await f.manager.runNow(f.accountId, 'after-midnight');
  assert.equal(f.writes.length, 2); assert.equal(f.manager.list(f.accountId).today.date, '2026-11-11'); assert.equal(f.manager.list(f.accountId).today.remaining, 0);
  assert.equal(f.manager.list('another-account').today.attempted, 0); assert.equal(f.manager.list('another-account').records.length, 0);
  assert.equal(f.manager.list(f.accountId).lastRun.requestId, 'after-midnight');
});

test('scheduled likes continue a bounded empty recency page instead of treating it as an empty homepage', async t => {
  const f = fixture(t); f.configure({ includeExisting: true });
  f.channel.transport.readMoments = async args => {
    f.reads.push(args);
    return { accountId: f.accountId, action: 'user', userId: 'friend-a', source: 'wechat-sns-live',
      items: args.query.cursor ? [f.post(21)] : [], nextCursor: args.query.cursor ? null : 'reconciled-cursor' };
  };
  const view = await f.manager.runNow(f.accountId, 'continued-recency');
  assert.equal(f.reads.length, 2); assert.deepEqual(f.writes.map(row => row.query.postId), ['21']);
  assert.equal(view.lastRun.liked, 1);
});

test('offline, missing account and global pause never start a scheduled run', async t => {
  const f = fixture(t); f.configure({ enabled: true, intervalMinutes: 5 }); f.manager.stopped = false; f.advance(300000);
  f.status.online = false; f.status.account = undefined; await f.manager.tick();
  f.status.online = true; await f.manager.tick();
  f.status.account = { id: f.accountId }; f.pause(); await f.manager.tick();
  assert.equal(f.reads.length, 0); assert.equal(f.manager.list(f.accountId).runs.length, 0);
});

test('unknown and rejected posts consume limits, stop the run, and survive restart without another submission', async t => {
  for (const delivery of ['unknown', 'rejected']) {
    const f = fixture(t); f.configure({ includeExisting: true }); f.posts.set('friend-a', [f.post(1)]);
    f.channel.transport.writeMoments = async args => { f.writes.push(args); throw new ChannelError('WRITE_ERROR', '提交未确认', { snsDelivery: delivery }); };
    const view = await f.manager.runNow(f.accountId, 'first'); assert.equal(view.records[0].state, delivery); assert.equal(view.today.attempted, 1); assert.equal(view.lastRun.state, 'failed');
    await f.create().runNow(f.accountId, 'new-explicit-run'); assert.equal(f.writes.length, 1, delivery);
  }
});

test('manual request IDs are durable and concurrent repeats join the original operation', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  f.configure({ includeExisting: true }); f.posts.set('friend-a', [f.post(1)]);
  const original = f.channel.transport.readMoments; f.channel.transport.readMoments = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const pending = f.manager.runNow(f.accountId, 'same-request'); await entered.promise;
  const repeated = f.manager.runNow(f.accountId, 'same-request'); assert.equal(pending, repeated);
  assert.throws(() => f.manager.runNow(f.accountId, 'another-request'), error => error.code === 'MOMENTS_LIKE_BUSY');
  release.resolve(); await Promise.all([pending, repeated]); assert.equal(f.writes.length, 1);
  f.posts.set('friend-a', [f.post(2)]); await f.create().runNow(f.accountId, 'same-request'); assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1);
});

test('cancel, setting changes, account changes and global pause during a read prevent every write', async t => {
  for (const mode of ['cancel', 'settings', 'account', 'pause', 'close']) {
    const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
    f.configure({ enabled: true, includeExisting: true }); f.posts.set('friend-a', [f.post(1)]);
    const original = f.channel.transport.readMoments; f.channel.transport.readMoments = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const pending = f.manager.runNow(f.accountId, mode); await entered.promise;
    if (mode === 'cancel') f.manager.cancel(f.accountId);
    if (mode === 'settings') f.manager.configure(f.accountId, { enabled: false });
    if (mode === 'account') f.status.account.id = 'other';
    if (mode === 'pause') f.pause();
    const closing = mode === 'close' ? f.manager.close() : null;
    release.resolve(); await pending; await closing;
    assert.equal(f.writes.length, 0, mode); assert.equal(f.manager.list(f.accountId).lastRun.state, 'cancelled', mode);
  }
});

test('cancel after the server accepts keeps the original durable outcome and never continues to another post', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  f.configure({ includeExisting: true }); f.posts.set('friend-a', [f.post(1), f.post(2)]);
  f.channel.transport.writeMoments = async args => { f.writes.push(args); entered.resolve(); await release.promise;
    return { accountId: f.accountId, action: 'like', postId: args.query.postId, liked: true, delivery: 'server-ack' }; };
  const pending = f.manager.runNow(f.accountId, 'cancelled-after-write'); await entered.promise; f.manager.cancel(f.accountId); release.resolve(); await pending;
  assert.equal(f.writes.length, 1); assert.equal(f.manager.list(f.accountId).records[0].state, 'unknown');
  const actionFile = fs.readdirSync(path.join(f.root, 'storage/moments/actions'))[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'storage/moments/actions', actionFile))).state, 'succeeded');
  const restarted = f.create(); f.posts.set('friend-a', [f.post(1)]); await restarted.runNow(f.accountId, 'later'); assert.equal(f.writes.length, 1);
});

test('unexpected friend authors or account responses reject the entire page before submission', async t => {
  for (const field of ['author', 'accountId', 'state']) {
    const f = fixture(t); f.configure({ includeExisting: true }); f.posts.set('friend-a', [f.post(1), f.post(2)]);
    const original = f.channel.transport.readMoments;
    f.channel.transport.readMoments = async (...args) => { const result = await original(...args);
      if (field === 'author') result.items[1] = f.post(2, { author: { userId: 'unselected-friend' } });
      if (field === 'accountId') result.accountId = 'other';
      if (field === 'state') result.items[1] = f.post(2, { likedByCurrentAccount: undefined });
      return result; };
    const view = await f.manager.runNow(f.accountId, field); assert.equal(f.writes.length, 0, field); assert.equal(view.lastRun.state, 'failed');
  }
});

test('restart marks interrupted submissions unknown and does not replay an interrupted request ID', async t => {
  const f = fixture(t); f.configure({ includeExisting: true }); f.posts.set('friend-a', [f.post(1)]); await f.manager.runNow(f.accountId, 'interrupted');
  const stored = JSON.parse(fs.readFileSync(f.manager.file(), 'utf8')); Object.values(stored.records)[0].state = 'sending'; Object.values(stored.runs)[0].state = 'running';
  fs.writeFileSync(f.manager.file(), JSON.stringify(stored)); const restarted = f.create();
  assert.equal(restarted.list(f.accountId).records[0].state, 'unknown'); assert.equal(restarted.list(f.accountId).lastRun.state, 'interrupted');
  await restarted.runNow(f.accountId, 'interrupted'); await restarted.runNow(f.accountId, 'next-run'); assert.equal(f.writes.length, 1);
});

test('corrupt or wrongly owned persisted state stays untouched and disables only likes', async t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.manager.file()), { recursive: true }); fs.writeFileSync(f.manager.file(), '{broken');
  const invalid = f.create(); invalid.start(); await invalid.tick(); assert(invalid.list(f.accountId).error);
  assert.equal(fs.readFileSync(f.manager.file(), 'utf8'), '{broken'); assert.equal(f.writes.length, 0); assert.equal(f.channel.closed, undefined);
});
