import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { StateStore } from '../backend/storage/state-store.mjs';
import { WechatChannel } from '../modules/conversation/channel.mjs';
import { momentsTool, momentsWriteTools } from '../modules/tools/moments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-recency-'));
test.after(() => {
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(resolved), /^wechat-moments-recency-/);
  fs.rmSync(resolved, { recursive: true, force: true });
});
const build = await rolldown({ input: path.join(root, 'backend/wechat/protocol/moments.ts'), platform: 'node',
  resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') } } });
try { await build.write({ file: path.join(temporary, 'codec.mjs'), format: 'esm' }); } finally { await build.close(); }
const { MomentsReader } = await import(pathToFileURL(path.join(temporary, 'codec.mjs')).href);
const account = { uin: 42, wxid: 'synthetic-account', token: 'synthetic-session' };
const target = 'synthetic-friend';
const signal = () => new AbortController().signal;
const post = (id, createdAt, userId = target, extra = {}) => ({ id, createdAt, author: { userId, nickname: '合成好友' },
  text: '合成正文', media: [], imageCount: 0, contentAvailable: true, deleted: false,
  likedByCurrentAccount: false, likeCount: 0, commentCount: 0, comments: [], likes: [], ...extra });
const old = () => post('15035118848570700376', 1792325836);
const latest = () => post('15051586470778384968', 1794288929);
function fixture(profile, timeline, options = {}) {
  const tables = {};
  for (const [action, pages] of Object.entries({ user: profile, timeline })) {
    const table = new Map(); let maxId;
    for (const rows of pages) {
      table.set(maxId, rows);
      if (rows.length) maxId = rows.reduce((minimum, row) => BigInt(row.id) < BigInt(minimum) ? row.id : minimum, rows[0].id);
    }
    tables[action] = table;
  }
  const calls = [];
  const reader = new MomentsReader(options.getAccount ?? (() => account), () => {}, async (_account, page, activeSignal) => {
    calls.push(structuredClone(page));
    const custom = await options.request?.(page, activeSignal);
    if (custom) return custom;
    if (page.action === 'detail') return { items: [latest()], firstPageMd5: '' };
    return { items: structuredClone(tables[page.action].get(page.maxId) ?? []), firstPageMd5: 'synthetic-md5',
      ...(page.action === 'timeline' ? { session: Buffer.from('PRIVATE_TIMELINE_SESSION') } : {}) };
  }, options.now ?? Date.now);
  const read = (query = {}, scope = 'requester', activeSignal = signal()) => reader.read({ action: 'user', userId: target, ...query }, scope, activeSignal);
  return { reader, calls, read };
}
function channelFixture(t, reader) {
  const directory = fs.mkdtempSync(path.join(temporary, 'channel-')), store = new StateStore(directory), writes = [], reads = [];
  store.configure(account.wxid, { enabled: true, privatePeers: ['requester', target], groups: [], prompt: '' });
  const config = store.config.snapshot(store.data); config.remote = { globalAdminIds: ['requester'] }; store.config.commit(config);
  store.setConversationSettings(account.wxid, 'private', 'requester', { ...store.conversationSettings(account.wxid, 'private', 'requester'), remoteEnabled: true });
  const transport = { status: () => ({ online: true, account: { id: account.wxid }, momentsReadReady: true, momentsWriteReady: true }),
    call: async () => ({ privatePeers: [{ id: target, name: '合成好友' }], groups: [] }),
    readMoments: async (args, activeSignal) => { reads.push(args); return reader.read(args.query, args.scopeKey, activeSignal); },
    writeMoments: async ({ query }) => { writes.push(query); return { accountId: account.wxid, ...query, delivery: 'server-ack',
      ...(query.action === 'like' ? { liked: true } : { commentId: '417' }) }; },
  };
  const channel = new WechatChannel({ store, transport, runner: { run: async () => { throw new Error('No model expected in this offline test'); } } });
  t.after(() => channel.close());
  const scope = { accountId: account.wxid, chatType: 'private', peerId: 'requester', senderId: 'requester' };
  return { channel, writes, reads, scope };
}

test('the real stale-homepage shape selects the November post instead of the October post', async () => {
  const f = fixture([[old()]], [[latest(), post('15050976763511116278', 1794216247, 'another-friend')]]);
  const result = await f.read({ limit: 1 });
  assert.deepEqual(result.items.map(row => row.id), [latest().id]);
  assert.equal(result.selection.offset, 0); assert.equal(result.selection.complete, true);
  assert.equal(result.selection.basis, 'profile-and-timeline');
  assert.deepEqual(f.calls.map(row => row.action), ['user', 'timeline']);
  assert.equal(result.mediaContentIncluded, false);
  assert(!JSON.stringify(result).includes('PRIVATE_TIMELINE_SESSION'));
});

test('a profile-only newer post stays ahead of an older timeline match', async () => {
  const f = fixture([[latest(), old()]], [[old()]]);
  assert.equal((await f.read({ limit: 1 })).items[0].id, latest().id);
});

test('an empty homepage does not hide a target post visible in the timeline', async () => {
  const f = fixture([[]], [[latest()]]);
  assert.equal((await f.read({ limit: 1 })).items[0].id, latest().id);
});

test('a bounded scan leaves a recency gap instead of returning the known old profile post', async () => {
  const f = fixture([[post('100', 1000)]], [[post('500', 5000, 'other')], [post('400', 4000, 'other')],
    [post('300', 3000, 'other')], [post('200', 2000)], [post('100', 1000)]]);
  const first = await f.read({ limit: 1 });
  assert.deepEqual(first.items, []); assert(first.nextCursor); assert.equal(first.selection.complete, false);
  assert.equal(f.calls.length, 4);
  const second = await f.read({ cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.items.map(row => row.id), ['200']); assert.equal(second.selection.offset, 0);
  const third = await f.read({ cursor: second.nextCursor, limit: 1 });
  assert.deepEqual(third.items.map(row => row.id), ['100']); assert.equal(third.selection.offset, 1);
});

test('a first page may return only its confirmed prefix while keeping older rows for continuation', async () => {
  const f = fixture([[post('100', 1000)]], [[post('500', 5000), post('400', 4000, 'other')],
    [post('300', 3000, 'other')], [post('200', 2000, 'other')], [post('100', 1000)]]);
  const result = await f.read({ limit: 2 });
  assert.deepEqual(result.items.map(row => row.id), ['500']); assert(result.nextCursor);
  assert.equal(result.selection.complete, false);
  assert.equal((await f.read({ limit: 1, cursor: result.nextCursor })).items[0].id, '100');
});

test('merged duplicates preserve the later interaction state and buffered pages keep their original read time', async () => {
  let clock = 1700000000000;
  const f = fixture([[post('100', 1000)]], [[post('200', 2000), post('100', 1000, target, { likedByCurrentAccount: true })]], { now: () => clock });
  const first = await f.read({ limit: 1 }); clock += 1000;
  const second = await f.read({ cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.items.map(row => row.id), ['100']); assert.equal(second.items[0].likedByCurrentAccount, true);
  assert.equal(second.fetchedAt, first.fetchedAt); assert.equal(f.calls.length, 2);
  const replay = await f.read({ cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(replay.items, second.items);
  const end = await f.read({ cursor: second.nextCursor, limit: 1 });
  assert.deepEqual(end.items, []); assert.equal(end.nextCursor, null);
});

test('inclusive page boundaries are deduplicated while still requiring progress', async () => {
  const f = fixture([[post('100', 1000)]], [[post('300', 3000, 'other')], [post('300', 3000, 'other'), post('200', 2000)],
    [post('200', 2000), post('100', 1000)]]);
  const result = await f.read({ limit: 2 });
  assert.deepEqual(result.items.map(row => row.id), ['200', '100']);
});

test('equal timestamps retain exact descending uint64 order without number rounding', async () => {
  const f = fixture([[post('15035118848570700376', 1000)]], [[post('15035118848570700377', 1000), post('15035118848570700376', 1000)]]);
  assert.deepEqual((await f.read({ limit: 2 })).items.map(row => row.id), ['15035118848570700377', '15035118848570700376']);
});

test('a deleted newer post does not occupy the latest visible position or leave an endless cursor', async () => {
  const f = fixture([[post('100', 1000)]], [[post('200', 2000, target, { deleted: true }), post('100', 1000)]]);
  const first = await f.read({ limit: 1 });
  assert.deepEqual(first.items.map(row => row.id), ['100']); assert.equal(first.selection.offset, 0);
  const end = await f.read({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(end.items, []); assert.equal(end.nextCursor, null);
});

test('cursor state cannot cross requester, target, login, or expiry', async () => {
  let current = account, clock = 1700000000000;
  const f = fixture([[old()]], [[latest()]], { getAccount: () => current, now: () => clock });
  const first = await f.read({ limit: 1 });
  for (const [query, scope] of [[{ cursor: first.nextCursor }, 'intruder'], [{ cursor: first.nextCursor, userId: 'another-target' }, 'requester']])
    await assert.rejects(f.read(query, scope), { code: 'ERR_MOMENTS_CURSOR' });
  current = { ...account, token: 'changed-login' };
  await assert.rejects(f.read({ cursor: first.nextCursor }), { code: 'ERR_MOMENTS_CURSOR' });
  current = account; const fresh = await f.read({ limit: 1 }); clock += 600001;
  await assert.rejects(f.read({ cursor: fresh.nextCursor }), { code: 'ERR_MOMENTS_CURSOR' });
});

for (const cancelled of [false, true]) test((cancelled ? 'cancellation' : 'account switch') + ' during timeline reconciliation returns no content or cursor', async () => {
  let current = account; const controller = new AbortController();
  const f = fixture([[old()]], [[latest()]], { getAccount: () => current, request: async page => {
    if (page.action === 'timeline') {
      if (cancelled) controller.abort(new Error('synthetic cancellation'));
      else current = { ...account, wxid: 'changed-account' };
    }
  } });
  await assert.rejects(f.read({ limit: 1 }, 'requester', controller.signal), cancelled ? /synthetic cancellation/ : { code: 'ERR_MOMENTS_ACCOUNT_CHANGED' });
  assert.equal(f.reader.cursors.size, 0);
});

test('a rejected source is neither an empty page nor a claim about the contact privacy setting', async () => {
  const error = Object.assign(new Error('微信朋友圈接口读取未成功（ret=207）；具体原因未确认'), { code: 'ERR_MOMENTS_REJECTED', details: { ret: 207 } });
  const f = fixture([[old()]], [[latest()]], { request: async page => { if (page.action === 'user') throw error; } });
  await assert.rejects(f.read({ limit: 1 }), value => value === error);
  assert.equal(f.reader.cursors.size, 0);
});

test('a ret=-2 homepage recovers only fresh visible timeline rows without claiming a verified latest position', async () => {
  const unavailable = Object.assign(new Error('synthetic refusal'), { code: 'ERR_MOMENTS_REJECTED', details: { ret: -2 } });
  const f = fixture([[old()]], [[latest(), old()]], { request: async page => { if (page.action === 'user') throw unavailable; } });
  const result = await f.read({ limit: 1 });
  assert.deepEqual(result.items.map(post => post.id), [latest().id]);
  assert.equal(result.selection.basis, 'timeline'); assert.equal(result.selection.recencyVerified, false);
  assert.equal(result.selection.complete, false); assert.equal(result.selection.unavailableSources[0].ret, -2);
  assert.match(result.selection.message, /不能据此断言/);
  const second = await f.read({ limit: 1, cursor: result.nextCursor });
  assert.deepEqual(second.items.map(post => post.id), [old().id]); assert.equal(second.selection.offset, 1);
  await assert.rejects(f.read({ limit: 1, cursor: result.nextCursor }, 'another-reader'), { code: 'ERR_MOMENTS_CURSOR' });
});

test('both refused sources still return the actual error instead of an empty or cached homepage', async () => {
  const f = fixture([[old()]], [[latest()]], { request: async () => {
    throw Object.assign(new Error('synthetic refusal'), { code: 'ERR_MOMENTS_REJECTED', details: { ret: -2 } });
  } });
  await assert.rejects(f.read(), { code: 'ERR_MOMENTS_REJECTED' }); assert.equal(f.reader.cursors.size, 0);
});

test('latest-like refuses a recovered partial range and sends no guessed interaction', async t => {
  const source = fixture([[old()]], [[latest()]], { request: async page => {
    if (page.action === 'user') throw Object.assign(new Error('synthetic refusal'), { code: 'ERR_MOMENTS_REJECTED', details: { ret: -2 } });
  } }), f = channelFixture(t, source.reader);
  await assert.rejects(f.channel.moments.likeRecent({ subject: 'contact', user: '合成好友' }, f.scope,
    'partial-request', '请给合成好友最新一条朋友圈点赞', signal()), { code: 'MOMENTS_LIKE_READ_INCOMPLETE' });
  assert.deepEqual(f.writes, []);
});

test('a nonadvancing timeline cannot promote an old profile row', async () => {
  const f = fixture([[post('100', 1000)]], [[post('300', 3000, 'other')]], { request: async page =>
    page.action === 'timeline' && page.maxId ? { items: [post('300', 3000, 'other')], firstPageMd5: '' } : undefined });
  await assert.rejects(f.read({ limit: 1 }), { code: 'ERR_MOMENTS_PROTOCOL' });
  assert.equal(f.reader.cursors.size, 0);
});

test('contradictory author or creation time is rejected before an interaction target is returned', async () => {
  const wrongAuthor = fixture([[post('100', 1000, 'wrong-author')]], [[latest()]]);
  await assert.rejects(wrongAuthor.read(), { code: 'ERR_MOMENTS_PROTOCOL' });
  const wrongTime = fixture([[post('100', 1000)]], [[post('100', 2000)]]);
  await assert.rejects(wrongTime.read(), { code: 'ERR_MOMENTS_PROTOCOL' });
  const backwardsTime = fixture([[post('100', 1000)]], [[post('300', 3000, 'other')], [post('200', 4000)]]);
  await assert.rejects(backwardsTime.read(), { code: 'ERR_MOMENTS_PROTOCOL' });
});

test('shared chat and work read/write tools use the reconciled newest target for both like and comment', async t => {
  const source = fixture([[old()]], [[latest()]]), f = channelFixture(t, source.reader), activeSignal = signal();
  const readTool = momentsTool({ read: (args, signal) => f.channel.moments.read(args, f.scope, signal) });
  const page = JSON.parse(await readTool.execute({ action: 'user', subject: 'contact', user: '合成好友', limit: 1 }, { signal: activeSignal }));
  const tools = momentsWriteTools({ write: (args, signal, key) => f.channel.moments.write(args, f.scope, 'synthetic-task', signal, undefined, key) });
  const like = await tools.find(tool => tool.name === 'wechat_moments_like').execute({ postId: page.items[0].id, subject: 'contact', user: '合成好友' }, { signal: activeSignal });
  const comment = await tools.find(tool => tool.name === 'wechat_moments_comment').execute({ postId: page.items[0].id, text: '针对合成正文的评论' }, { signal: activeSignal });
  assert.equal(JSON.parse(like).ok, true); assert.equal(JSON.parse(comment).ok, true);
  assert.deepEqual(f.writes.map(row => row.postId), [latest().id, latest().id]);
  assert.match(readTool.description, /没有看过图片/); assert.match(tools.find(tool => tool.name === 'wechat_moments_comment').description, /不能编造画面/);
});

test('composite latest-like reads only the requested count and locks the corrected post across retries', async t => {
  const source = fixture([[old()]], [[latest()]]), f = channelFixture(t, source.reader);
  const args = { subject: 'contact', user: '合成好友' }, text = '请给合成好友最新一条朋友圈点赞';
  const first = await f.channel.moments.likeRecent(args, f.scope, 'same-request', text, signal());
  const again = await f.channel.moments.likeRecent(args, f.scope, 'same-request', text, signal());
  assert.equal(first.ok, true); assert.equal(again.reusedRequest, true);
  assert.deepEqual(f.writes.map(row => row.postId), [latest().id]); assert.equal(f.reads[0].query.limit, 1);
  assert.equal(first.results[0].createdAt, latest().createdAt);
});

test('a participant latest-like continues across an empty bounded scan without liking the known old post', async t => {
  const source = fixture([[post('100', 1000)]], [[post('500', 5000, 'other')], [post('400', 4000, 'other')],
    [post('300', 3000, 'other')], [post('200', 2000)]]), f = channelFixture(t, source.reader);
  const scope = { ...f.scope, peerId: target, senderId: target };
  const result = await f.channel.moments.likeRecent({ subject: 'speaker' }, scope, 'participant-request', '帮我最新一条朋友圈点赞', signal());
  assert.equal(result.ok, true); assert.deepEqual(f.writes.map(row => row.postId), ['200']); assert.equal(f.reads.length, 2);
});

test('an already-liked newest timeline post never shifts the request to an older unliked profile post', async t => {
  const source = fixture([[old()]], [[{ ...latest(), likedByCurrentAccount: true }]]), f = channelFixture(t, source.reader);
  const result = await f.channel.moments.likeRecent({ subject: 'contact', user: '合成好友' }, f.scope, 'already-liked-newest',
    '请给合成好友最新一条朋友圈点赞', signal());
  assert.equal(result.ok, true); assert.equal(result.alreadyLiked, 1);
  assert.equal(result.results[0].postId, latest().id); assert.equal(f.writes.length, 0);
});

test('an unresolved scan limit never submits a partial batch or substitutes an older profile post', async t => {
  const timeline = Array.from({ length: 24 }, (_, index) => [post(String(1000 - index), 10000 - index, 'other')]);
  const source = fixture([[post('100', 1000)]], timeline), f = channelFixture(t, source.reader);
  await assert.rejects(f.channel.moments.likeRecent({ subject: 'contact', user: '合成好友' }, f.scope, 'bounded-request',
    '请给合成好友最新一条朋友圈点赞', signal()), { code: 'MOMENTS_LIKE_READ_LIMIT' });
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 5);
});
