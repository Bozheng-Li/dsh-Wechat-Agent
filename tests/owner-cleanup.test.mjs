import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore, MomentsAutomation, OwnerCleanup, taskViews, createPluginService, rpcHandler } from '../lib/testing.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accountId = 'cleanup-owner';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cleanup-')), store = new StateStore(root);
  store.configure(accountId, { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  const status = { online: true, account: { id: accountId } };
  const channel = { store, now: () => 1800000000000, transport: { status: () => status }, runner: { run: async input => input.mode === 'moments-content-review'
    ? { text: '{"ok":true,"reason":""}' } : ({ text: JSON.stringify({ theme: '随手记', text: '一段完整内容。', imagePrompt: '' }) }) } };
  channel.momentsAutomation = new MomentsAutomation(channel);
  const cleanup = new OwnerCleanup(channel), manager = channel.momentsAutomation.publishing;
  const add = request => manager.preview(accountId, { themes: [] }, request, new AbortController().signal);
  t.after(async () => { await channel.momentsAutomation.close(); const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); assert.match(path.basename(target), /^wechat-cleanup-/); fs.rmSync(target, { recursive: true, force: true }); });
  return { root, store, channel, cleanup, manager, add, status };
}

test('cleanup freezes the full history, preserves arrivals and is account scoped and idempotent', async t => {
  const f = fixture(t), first = await f.add('first'), template = f.manager.data.runs[first.id];
  for (let i = 0; i < 105; i++) { const id = hash(i); f.manager.data.runs[id] = { ...structuredClone(template), id, requestId: 'seed-' + i }; }
  assert.equal(f.manager.list(accountId).runs.length, 100);
  const preview = f.cleanup.preview(accountId, { kind: 'moments.publishing' }); assert.equal(preview.count, 106);
  const arrived = await f.add('after-confirmation');
  assert.throws(() => f.cleanup.remove('other-account', preview), { code: 'CLEANUP_CHANGED' });
  assert.equal(f.cleanup.remove(accountId, preview).deleted, 106);
  assert.equal(f.cleanup.remove(accountId, preview).deleted, 106);
  assert.deepEqual(f.manager.list(accountId).runs.map(row => row.id), [arrived.id]);
  await assert.rejects(f.add('first'), { code: 'MOMENTS_DRAFT_MISSING' });
  const reloaded = new MomentsAutomation(f.channel); assert.equal(reloaded.error, undefined); assert.equal(reloaded.publishing.error, undefined);
  assert.deepEqual(reloaded.publishing.list(accountId).runs.map(row => row.id), [arrived.id]);
});

test('cleanup rejects a changed selection before deleting any row and protects active or uncertain publishing', async t => {
  const f = fixture(t), a = await f.add('a'), b = await f.add('b');
  const preview = f.cleanup.preview(accountId, { kind: 'moments.publishing', ids: [a.id, b.id] });
  f.manager.editDraft(accountId, b.id, '后来编辑的内容。');
  assert.throws(() => f.cleanup.remove(accountId, preview), { code: 'CLEANUP_CHANGED' });
  assert.equal(f.manager.list(accountId).runs.length, 2);
  f.manager.data.runs[a.id].state = 'sending'; f.manager.data.runs[b.id].state = 'unknown';
  const protectedRows = f.cleanup.preview(accountId, { kind: 'moments.publishing' });
  assert.equal(protectedRows.count, 0); assert.equal(protectedRows.protectedCount, 2);
});

test('published cleanup retains dedup evidence and removes only the publishing copy of an image', async t => {
  const f = fixture(t), draft = await f.add('published'), row = f.manager.data.runs[draft.id];
  Object.assign(row, { state: 'published', origin: 'schedule', postId: '123', publishedAt: f.channel.now(), delivery: 'server-ack' });
  const relative = 'storage/moments/publishing-media/' + row.id + '.png';
  fs.mkdirSync(path.dirname(path.join(f.root, relative)), { recursive: true }); fs.writeFileSync(path.join(f.root, relative), 'fixture');
  row.image = { path: relative, sha256: hash('fixture') };
  const before = f.manager.recent(accountId);
  f.cleanup.remove(accountId, f.cleanup.preview(accountId, { kind: 'moments.publishing' }));
  assert.deepEqual(f.manager.recent(accountId), before); assert.equal(row.state, 'published'); assert.equal(row.publishedAt, f.channel.now());
  assert.equal(fs.existsSync(path.join(f.root, relative)), false);
  assert.throws(() => f.manager.contentImage(accountId, row.id), { code: 'MOMENTS_DRAFT_MISSING' });
  const reloaded = new MomentsAutomation(f.channel); assert.equal(reloaded.publishing.error, undefined); assert.deepEqual(reloaded.publishing.recent(accountId), before);
});

test('likes and replies disappear from lists without resetting quotas or allowing another attempt', t => {
  const f = fixture(t), likes = f.channel.momentsAutomation.likes;
  const row = { accountId, postId: '12', userId: 'alice', text: '旧的动态', createdAt: 1700000000, updatedAt: f.channel.now(), attemptedAt: f.channel.now(), state: 'liked', delivery: 'server-ack', requestId: likes.postRequestId(accountId, '12') };
  const id = hash([accountId, row.postId]); likes.data.records[id] = row;
  const reply = { accountId, postId: '13', commentId: '14', state: 'sent', text: '私有回复内容', commentText: '私有评论', updatedAt: f.channel.now() };
  f.channel.momentsAutomation.data.replies.reply = reply;
  const before = likes.today(accountId);
  for (const kind of ['moments.likes.records', 'moments.replies']) f.cleanup.remove(accountId, f.cleanup.preview(accountId, { kind }));
  assert.deepEqual(likes.today(accountId), before); assert(likes.data.records[id]); assert.equal(likes.list(accountId).records.length, 0);
  assert.equal(f.channel.momentsAutomation.list(accountId).replies.length, 0); assert.equal(reply.text, undefined);
  const reloaded = new MomentsAutomation(f.channel); assert.equal(reloaded.likes.error, undefined); assert.deepEqual(reloaded.likes.today(accountId), before);
});

test('material batch cleanup validates revisions first and never revives deleted request IDs', t => {
  const f = fixture(t), materials = f.channel.momentsAutomation.materials;
  const put = requestId => materials.put(accountId, { requestId, fields: { title: '素材', text: '公开内容' } });
  const a = put('a'), b = put('b'), preview = f.cleanup.preview(accountId, { kind: 'moments.materials' });
  materials.put(accountId, { id: b.id, revision: b.revision, fields: { title: '新标题', text: '公开新内容' } });
  assert.throws(() => f.cleanup.remove(accountId, preview), { code: 'CLEANUP_CHANGED' }); assert.equal(materials.list(accountId).items.length, 2);
  f.cleanup.remove(accountId, f.cleanup.preview(accountId, { kind: 'moments.materials' }));
  assert.equal(materials.list(accountId).items.length, 0); assert.throws(() => put('a'), { code: 'MOMENTS_MATERIAL_CHANGED' });
  const reloaded = new MomentsAutomation(f.channel); assert.equal(reloaded.materials.error, undefined); assert.equal(reloaded.materials.list(accountId).items.length, 0);
});

test('task history cleanup keeps recurring schedules, returns only after new execution, and protects settling sends', t => {
  const f = fixture(t), recurring = { id: 'daily', accountId, revision: 2, updatedAt: 10, state: 'pending', lastState: 'sent', runId: 'one' };
  const settling = { id: 'settling', accountId, revision: 1, updatedAt: 10, state: 'cancelled', runId: 'two' };
  const runs = [{ id: 'one', taskId: 'daily', state: 'sent', startedAt: 1, finishedAt: 10 }, { id: 'two', taskId: 'settling', state: 'running', startedAt: 10 }];
  const scheduler = { data: { tasks: [recurring, settling], runs }, save() {} }, cleanup = new OwnerCleanup(f.channel, scheduler);
  const preview = cleanup.preview(accountId, { kind: 'tasks.history' }); assert.equal(preview.count, 1); assert.equal(preview.protectedCount, 1);
  cleanup.remove(accountId, preview);
  assert.equal(recurring.state, 'pending'); assert.equal(taskViews(scheduler.data.tasks, runs).current.length, 1); assert.equal(taskViews(scheduler.data.tasks, runs).history.length, 1);
  recurring.revision++; recurring.updatedAt = 30; runs.push({ id: 'three', taskId: 'daily', state: 'sent', finishedAt: 30 });
  const entry = taskViews(scheduler.data.tasks, runs).history.find(row => row.task.id === 'daily'); assert.deepEqual(entry.runs.map(row => row.id), ['three']);
});

test('cleanup RPC is owner only and cannot target another account', async t => {
  const f = fixture(t); await f.add('owner');
  const service = createPluginService({ root: f.root, store: f.store, channel: f.channel, worker: { status: () => f.status } });
  const rpc = rpcHandler(service), payload = { accountId, kind: 'moments.publishing' }, signal = new AbortController().signal;
  assert.equal((await rpc('cleanup.preview', payload, signal, { principal: { kind: 'guest' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await rpc('cleanup.preview', { ...payload, accountId: 'other' }, signal, { principal: { kind: 'owner' } })).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await rpc('cleanup.preview', payload, signal, { principal: { kind: 'owner' } })).value.count, 1);
});

test('changing the data directory invalidates cleanup previews and switches to the new storage', async t => {
  const first = fixture(t), second = fixture(t); await first.add('old'); await second.add('new-one'); await second.add('new-two');
  const runtime = f => ({ root: f.root, store: f.store, channel: f.channel, worker: { status: () => f.status } });
  const service = createPluginService(runtime(first));
  const preview = await service.call('cleanup.preview', { accountId, kind: 'moments.publishing' });
  service.replaceRuntime(runtime(second));
  assert.throws(() => service.call('cleanup.delete', { accountId, token: preview.token }), { code: 'CLEANUP_CHANGED' });
  assert.equal((await service.call('cleanup.preview', { accountId, kind: 'moments.publishing' })).count, 2);
  assert.equal(first.manager.list(accountId).runs.length, 1);
});
