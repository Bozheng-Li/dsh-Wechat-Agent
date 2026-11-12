import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore, WechatChannel, createPluginService, rpcHandler, MOMENTS_INTERACTION_ENDPOINTS } from '../lib/testing.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-interaction-rpc-')), accountId = 'wxid_interaction_rpc', writes = [], reads = [], lifetime = new AbortController();
  const status = { account: { id: accountId }, online: true, momentsReadReady: true, momentsWriteReady: true }, store = new StateStore(root);
  store.configure(accountId, { enabled: true, privatePeers: ['friend', 'friend-0', 'friend-1'], groups: [], prompt: '' });
  const posts = ['701', '702'].map((id, i) => ({ id, author: { userId: 'friend-' + i, nickname: '合成好友 ' + i }, text: '本地验证动态 ' + i, imageCount: 0,
    createdAt: Math.floor(Date.now() / 1000) - i, deleted: false, contentAvailable: true, likedByCurrentAccount: false, comments: [], visibleCommentEntries: 0 }));
  const worker = { status: () => status, async readMoments(args, signal) {
    signal.throwIfAborted(); reads.push(args); return { accountId, action: args.query.action, source: 'wechat-sns-live', nextCursor: null,
      items: structuredClone(args.query.action === 'detail' ? posts.filter(row => row.id === args.query.postId) : posts.slice(0, args.query.limit)) };
  }, async writeMoments(args, signal) { signal.throwIfAborted(); writes.push(args); return { accountId, action: args.query.action, postId: args.query.postId,
    delivery: 'server-ack', ...(args.query.action === 'like' ? { liked: true } : { text: args.query.text, commentId: String(710 + writes.length) }) }; },
    send: async () => { throw Error('Must never send a real message'); } };
  const runner = { run: async input => ({ text: JSON.stringify({ comments: JSON.parse(input.text).posts.map(row => ({ postId: row.postId, text: '本地评论', skipReason: '' })) }) }) };
  const channel = new WechatChannel({ store, transport: worker, runner }), manager = channel.momentsAutomation.interactions;
  const service = createPluginService({ root, store, worker, runner, channel, lifetime: lifetime.signal }), invoke = rpcHandler(service);
  const rpc = (name, payload = {}, principal = 'owner', signal) => invoke(name, { accountId, ...payload }, signal, { principal: { kind: principal } });
  const preview = async (options = {}) => { const result = await rpc('moments.interactions.preview', { options: { action: 'both', commentMode: 'fixed', commentText: '本地评论', intervalSeconds: 0, count: 2, ...options }, requestId: 'ui-moments-' + randomUUID() }); assert(result.ok, JSON.stringify(result)); return result.value; };
  t.after(async () => { lifetime.abort(); await channel.close(); const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); assert.match(path.basename(target), /^wechat-interaction-rpc-/); fs.rmSync(target, { recursive: true, force: true }); });
  return { accountId, status, store, channel, worker, lifetime, manager, rpc, preview, writes, reads };
}

test('all interaction RPCs are owner and account bound and preview is read-only', async t => {
  const f = fixture(t); assert.equal((await f.rpc('moments.interactions.list')).value.runs.length, 0);
  for (const endpoint of MOMENTS_INTERACTION_ENDPOINTS) {
    for (const principal of ['agent', 'remote']) assert.equal((await f.rpc(endpoint, {}, principal)).error.code, 'OWNER_REQUIRED');
    assert.equal((await f.rpc(endpoint, { accountId: 'other' })).error.code, 'ACCOUNT_CHANGED');
  }
  assert.equal((await f.rpc('moments.interactions.preview', { requestId: 'invalid' })).error.code, 'MOMENTS_INTERACTION_INVALID');
  assert.equal(f.reads.length, 0); const round = await f.preview(); assert.equal(round.rows.length, 2); assert.equal(f.writes.length, 0);
});

test('owner image information RPC validates account and target without granting social write access', async t => {
  const f = fixture(t); let reads = 0;
  f.worker.readMomentsImages = async ({ accountId, query }) => {
    reads++; const post = { id: query.postId, author: { userId: 'friend' }, createdAt: 1794300000,
      text: '没有配图的合成动态', imageCount: 0, media: [], deleted: false, contentAvailable: true };
    return { accountId, postId: query.postId, post, imageCount: 0, source: 'wechat-sns-images-live', complete: true, items: [] };
  };
  assert.equal((await f.rpc('moments.images', { postId: '701' }, 'agent')).error.code, 'OWNER_REQUIRED');
  assert.equal((await f.rpc('moments.images', { postId: '701', accountId: 'wrong' })).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.rpc('moments.images', { postId: '701', url: 'https://example.com/image' })).error.code, 'MOMENTS_IMAGE_CONTEXT');
  assert.equal(reads, 0);
  const result = await f.rpc('moments.images', { postId: '701' }); assert(result.ok, JSON.stringify(result));
  assert.equal(result.value.mediaContentIncluded, false); assert.equal(reads, 1); assert.equal(f.writes.length, 0);
});

test('owner RPC saves revision-bound automatic settings without sending and supports disabling offline', async t => {
  const f = fixture(t); const initial = (await f.rpc('moments.interactions.list')).value.automation;
  assert.equal(initial.settings.enabled, false);
  const saved = await f.rpc('moments.interactions.configure', { revision: initial.revision, settings: { enabled: true, intervalMinutes: 15, likeCount: 4, commentCount: 1 } });
  assert(saved.ok); assert.equal(saved.value.settings.commentCount, 1); assert(saved.value.nextRunAt > Date.now());
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
  assert.equal((await f.rpc('moments.interactions.configure', { revision: initial.revision, settings: { enabled: false } })).error.code, 'MOMENTS_INTERACTION_SETTINGS_CHANGED');
  f.status.online = false;
  const disabled = await f.rpc('moments.interactions.configure', { revision: saved.value.revision, settings: { enabled: false } });
  assert(disabled.ok); assert.equal(disabled.value.nextRunAt, 0); assert.equal(disabled.value.settings.intervalMinutes, 15);
  assert((await f.rpc('moments.interactions.stop')).ok); assert.equal(f.writes.length, 0);
});

test('owner stop RPC cancels an automatic generator while preserving the future schedule', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  f.channel.runner.run = async input => { entered.resolve(); await release.promise; input.signal.throwIfAborted(); throw Error('Should be cancelled'); };
  const current = (await f.rpc('moments.interactions.list')).value.automation;
  assert((await f.rpc('moments.interactions.configure', { revision: current.revision, settings: { enabled: true } })).ok);
  f.manager.automation.start(); f.manager.automation.rule(f.accountId).nextRunAt = 0;
  const pending = f.manager.automation.tick(); await entered.promise;
  const stopped = await f.rpc('moments.interactions.stop'); assert(stopped.ok); release.resolve(); await pending;
  const latest = (await f.rpc('moments.interactions.list')).value.automation;
  assert.equal(latest.lastRun.state, 'cancelled'); assert.equal(latest.settings.enabled, true); assert(latest.nextRunAt > Date.now()); assert.equal(f.writes.length, 0);
});

test('accepted UI rounds survive navigation, keep per-step receipts and reject replay', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  const round = await f.preview(), write = f.worker.writeMoments;
  f.worker.writeMoments = async (...args) => { entered.resolve(); await release.promise; return write(...args); };
  const page = new AbortController(); const started = await f.rpc('moments.interactions.run', { id: round.id, revision: round.revision }, 'owner', page.signal);
  assert(started.ok); assert.equal(started.value.state, 'running'); await entered.promise; page.abort(); release.resolve();
  const done = await f.manager.wait(f.accountId, round.id); assert.equal(done.counts.liked, 2); assert.equal(done.counts.commented, 2);
  const repeated = await f.rpc('moments.interactions.run', { id: round.id, revision: round.revision });
  assert(repeated.ok); assert.equal(repeated.value.state, 'completed'); assert.equal(f.writes.length, 4);
});

test('owner cancel stops between posts and preserves the first confirmed interaction', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  f.manager.sleep = async (_ms, signal) => { entered.resolve(); await release.promise; signal.throwIfAborted(); };
  const round = await f.preview({ action: 'like', intervalSeconds: 3 });
  await f.rpc('moments.interactions.run', { id: round.id, revision: round.revision }); await entered.promise;
  assert((await f.rpc('moments.interactions.cancel', { id: round.id })).ok); release.resolve(); await f.manager.whenIdle();
  const result = (await f.rpc('moments.interactions.list', { id: round.id })).value;
  assert.equal(result.current.state, 'cancelled'); assert.equal(result.current.counts.liked, 1); assert.equal(f.writes.length, 1);
});

test('generate and edit use optimistic revisions; service lifetime shutdown interrupts accepted rounds', async t => {
  const f = fixture(t); let round = await f.preview({ commentMode: 'generated' });
  const generation = await f.rpc('moments.interactions.generate', { id: round.id, revision: round.revision }); assert(generation.ok);
  assert.equal((await f.rpc('moments.interactions.edit', { id: round.id, revision: round.revision, rows: [] })).error.code, 'MOMENTS_INTERACTION_CHANGED'); round = generation.value;
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve()); const read = f.worker.readMoments;
  f.worker.readMoments = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
  await f.rpc('moments.interactions.run', { id: round.id, revision: round.revision }); await entered.promise; f.lifetime.abort(); release.resolve(); await f.manager.whenIdle();
  assert.equal(f.manager.list(f.accountId, round.id).current.state, 'cancelled'); assert.equal(f.writes.length, 0);
});

test('cleanup hides finished interaction rounds while preserving dedup and protecting unknown submissions', async t => {
  const f = fixture(t); const round = await f.preview(); await f.rpc('moments.interactions.run', { id: round.id, revision: round.revision }); await f.manager.whenIdle();
  const draft = await f.preview({ action: 'like' }); f.manager.data.runs[draft.id].state = 'interrupted'; f.manager.data.runs[draft.id].rows[0].like.state = 'unknown'; f.manager.save();
  const preview = await f.rpc('cleanup.preview', { kind: 'moments.interactions' }); assert(preview.ok); assert.equal(preview.value.count, 1); assert.equal(preview.value.protectedCount, 1);
  const deleted = await f.rpc('cleanup.delete', { token: preview.value.token }); assert(deleted.ok); assert.equal(deleted.value.deleted, 1);
  assert.equal(f.manager.list(f.accountId).runs.length, 1); assert.equal(f.manager.data.runs[round.id].rows[0].comment.state, 'succeeded');
  assert.equal((await f.rpc('moments.interactions.run', { id: round.id, revision: round.revision })).error.code, 'MOMENTS_INTERACTION_NOT_FOUND'); assert.equal(f.writes.length, 4);
});
