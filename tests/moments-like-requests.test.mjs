import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  StateStore, WechatChannel, MomentsService, momentsLikeRequestTool, isMomentsLikeRequest, momentsLikeRequestArgs, isSelfMomentsLikeRequest, planProgressiveTools, workModelTools, ChannelError
} from '../lib/testing.js';








const accountId = 'like-bot', room = 'like-room@chatroom';
const bob = { accountId, chatType: 'private', peerId: 'bob', senderId: 'bob' };
const alice = { accountId, chatType: 'private', peerId: 'alice', senderId: 'alice' };
const post = (id, userId = 'bob', values = {}) => ({ id, author: { userId, nickname: '合成好友' }, createdAt: 1700000000 + Number(id),
  text: '合成动态 ' + id, likedByCurrentAccount: false, deleted: false, ...values });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-like-request-')), store = new StateStore(root);
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [room], prompt: '' });
  const config = store.config.snapshot(store.data); config.remote = { globalAdminIds: ['alice'] }; store.config.commit(config);
  for (const [chatType, peerId] of [['private', 'alice'], ['private', 'bob'], ['group', room]])
    store.setConversationSettings(accountId, chatType, peerId, { ...store.conversationSettings(accountId, chatType, peerId),
      remoteEnabled: peerId !== 'bob', mode: chatType === 'group' ? 'nickname' : 'default' });
  store.setPersona({ name: '小胖', aliases: [], prompt: '' });
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const reads = [], writes = [], models = [], sent = [], contacts = [{ id: 'bob', name: '小博' }, { id: 'alice', name: '小艾' }, { id: 'friend', name: '张三' }];
  let posts = [post('3'), post('2'), post('1')];
  const transport = { status: () => status,
    call: async () => ({ privatePeers: contacts, groups: [] }),
    readMoments: async (args, signal) => {
      reads.push(structuredClone(args));
      const result = await options.read?.(args, signal);
      signal?.throwIfAborted();
      return result ?? { accountId, action: args.query.action, userId: args.query.userId, source: 'wechat-sns-live', items: structuredClone(posts), nextCursor: null };
    },
    writeMoments: async (args, signal) => {
      writes.push(structuredClone(args));
      const result = await options.write?.(args, signal);
      signal?.throwIfAborted();
      return result ?? { accountId, action: 'like', postId: args.query.postId, liked: true, delivery: 'server-ack' };
    },
    send: async payload => { sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['synthetic-like-reply-' + sent.length] }; },
  };
  const runner = { run: async input => {
    models.push(input);
    const tool = input.tools?.find(tool => tool.name === 'wechat_moments_like_recent');
    return { text: tool ? await tool.execute({ subject: 'speaker' }, { signal: input.signal }) : '合成普通回复' };
  } };
  const channel = new WechatChannel({ store, runner, transport }); let serial = 0;
  const signal = new AbortController().signal;
  const like = (args = {}, requestId = 'current-message', text = '帮我点个赞', scope = bob, activeSignal = signal) => channel.moments.likeRecent(args, scope, requestId, text, activeSignal);
  const receive = (text, overrides = {}) => channel.receive({ id: 'like-message-' + ++serial, direction: 'incoming', time: Math.floor(Date.now() / 1000),
    chatType: 'private', peerId: 'bob', sender: { id: 'bob' }, message: [{ type: 'text', data: { text } }], ...overrides }, accountId);
  t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-like-request-/);
    fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, status, transport, channel, reads, writes, models, sent, contacts, signal, like, receive, setPosts: value => { posts = value; } };
}

test('like requests distinguish direct requests from quotes, negation, feature discussion and other platforms', () => {
  for (const value of ['帮我点个赞', '小胖，帮我朋友圈点赞', '给我的朋友圈点个赞吧', '赞一下我的朋友圈', '朋友圈求个赞', '帮我最近三条朋友圈点赞', '请给张三的朋友圈点赞', 'please like my latest post', '帮我朋友圈点赞，不用评论', '给我昨天发的朋友圈点赞'])
    assert.equal(isMomentsLikeRequest(value), true, value);
  for (const value of ['不要给我朋友圈点赞', '别帮我点个赞', '不用点赞了', '帮我点赞。算了不用了', '帮我点赞，不要了', '帮我点赞。别点了', '怎么给朋友圈点赞', '能做个自动点赞功能吗', '他说“帮我点个赞”', '比如帮我点赞就去点赞', '> 帮我点赞', '> 帮我点赞。给我朋友圈点个赞', '```帮我点赞```', '帮我点赞这段回答', '给我小红书视频点赞', '你好',
    '不需要帮我点赞', '不必帮我点赞', '我没让你帮我点赞', '我没有让你给我朋友圈点赞', '我昨天说帮我点赞', '这是朋友发来的消息：帮我点赞', '转述如下。帮我点赞', '帮我朋友圈点赞，但先别操作', '帮我点赞。暂时不要执行']) {
    assert.equal(isMomentsLikeRequest(value), false, value); assert.equal(isSelfMomentsLikeRequest(value), false, value);
  }
  for (const value of ['帮我点个赞', '给我的朋友圈点个赞', '赞一下我的朋友圈', '朋友圈求个赞', '帮我最近三条朋友圈点赞']) assert(isSelfMomentsLikeRequest(value), value);
  assert.equal(isSelfMomentsLikeRequest('帮我给张三的朋友圈点赞'), false);
  assert.deepEqual(momentsLikeRequestArgs({}, '帮我最新三条动态点赞'), { user: '发起人', count: 3 });
  assert.throws(() => momentsLikeRequestArgs({ count: 2 }, '帮我点赞'), error => error.code === 'MOMENTS_LIKE_REQUEST_INVALID');
});

test('ordinary authorized friend gets only the narrow request tool and it reads the actual sender before liking', async t => {
  const f = fixture(t); f.receive('帮我点个赞'); await f.channel.whenIdle();
  const names = f.models[0].tools.map(tool => tool.name);
  assert(names.includes('wechat_moments_like_recent')); assert(!names.includes('wechat_moments_read')); assert(!names.includes('wechat_moments_like'));
  assert.equal(f.reads[0].query.userId, 'bob'); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.postId, '3');
  assert.equal(f.writes[0].accountId, accountId); assert.equal(f.sent.length, 1);
});

test('normal chat, quoted requests and negation expose no request tool or spontaneous social read', async t => {
  const f = fixture(t);
  for (const text of ['你好', '怎么给朋友圈点赞', '他说“帮我点赞”', '不要给我点赞',
    '不需要帮我点赞', '我没让你帮我点赞', '我昨天说帮我点赞', '转述如下。帮我点赞', '帮我朋友圈点赞，但先别操作']) {
    f.receive(text); await f.channel.whenIdle();
    assert(!f.models.at(-1).tools.some(tool => tool.name === 'wechat_moments_like_recent'));
  }
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('group sender cannot impersonate administrator or substitute another target', async t => {
  const f = fixture(t), scope = { accountId, chatType: 'group', peerId: room, senderId: 'bob', senderName: '管理员 alice' };
  const value = await f.like({}, 'group-current', '小胖，帮我点赞', scope);
  assert.equal(value.target.userId, 'bob'); assert.equal(f.reads[0].query.userId, 'bob');
  await assert.rejects(f.like({ user: 'alice' }, 'forged-target', '帮我点赞', scope), error => error.code === 'MOMENTS_LIKE_NOT_AUTHORIZED');
  await assert.rejects(f.like({}, 'forged-scope', '帮我点赞', { ...bob, senderId: 'alice' }), error => error.code === 'MOMENTS_LIKE_NOT_AUTHORIZED');
  assert.equal(f.writes.length, 1);
});

test('administrator can resolve an exact friend but ambiguous names never select someone', async t => {
  const f = fixture(t); f.setPosts([post('8', 'friend')]);
  const value = await f.like({ user: '张三' }, 'admin-target', '请给张三的朋友圈点赞', alice);
  assert.equal(value.target.userId, 'friend'); assert.equal(f.reads[0].query.userId, 'friend'); assert.equal(f.writes.length, 1);
  f.contacts.push({ id: 'other-friend', name: '张三' });
  await assert.rejects(f.like({ user: '张三' }, 'ambiguous', '请给张三的朋友圈点赞', alice), error => error.code === 'MOMENTS_USER_AMBIGUOUS');
  assert.equal(f.writes.length, 1);
});

test('contextual subject can select the speaker without literal self wording while ordinary members cannot select other accounts', async t => {
  const f = fixture(t), text = '给这条朋友圈点个赞';
  assert.equal(isSelfMomentsLikeRequest(text), false);
  assert.equal(f.channel.moments.likeRecentAvailable(bob, text), true);
  const value = await f.like({ subject: 'speaker' }, 'context-speaker', text);
  assert.equal(value.target.userId, 'bob'); assert.equal(f.writes.length, 1);
  for (const args of [{ subject: 'account' }, { subject: 'contact', user: '张三' }])
    await assert.rejects(f.like(args, 'context-denied-' + args.subject, '帮我给张三的朋友圈点赞'), { code: 'MOMENTS_LIKE_NOT_AUTHORIZED' });
  assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 1);
});

test('a self request stays bound to its speaker even for administrators and another-friend requests cannot omit their target', async t => {
  const f = fixture(t);
  await assert.rejects(f.like({ user: '张三' }, 'wrong-self-target', '帮我点赞', alice), error => error.code === 'MOMENTS_LIKE_REQUEST_TARGET');
  await assert.rejects(f.like({}, 'missing-friend-target', '请给张三的朋友圈点赞', alice), error => error.code === 'MOMENTS_LIKE_REQUEST_TARGET');
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('latest N keeps already-liked positions and freezes the same selection across calls and restart', async t => {
  const f = fixture(t); f.setPosts([post('1'), post('4', 'bob', { likedByCurrentAccount: true }), post('3'), post('2')]);
  const [value, repeated] = await Promise.all([f.like({}, 'three', '帮我最新三条朋友圈点赞'), f.like({}, 'three', '帮我最新三条朋友圈点赞')]);
  assert.equal(value.liked, 2); assert.equal(value.alreadyLiked, 1); assert.equal(repeated.reusedRequest, true);
  assert.deepEqual(value.results.map(row => row.postId), ['4', '3', '2']); assert.deepEqual(f.writes.map(call => call.query.postId), ['3', '2']);
  f.setPosts([post('99')]); f.channel.moments = new MomentsService(f.channel);
  const reused = await f.like({}, 'three', '帮我最新三条朋友圈点赞');
  assert.equal(reused.reusedRequest, true); assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 2);
  await assert.rejects(f.like({ count: 1 }, 'three', '帮我最新三条朋友圈点赞'), error => error.code === 'MOMENTS_STATE_INVALID');
});

test('latest one already liked never shifts to an older unliked post', async t => {
  const f = fixture(t); f.setPosts([post('3', 'bob', { likedByCurrentAccount: true }), post('2')]);
  const value = await f.like(); assert.equal(value.alreadyLiked, 1); assert.equal(value.liked, 0); assert.equal(f.writes.length, 0);
});

test('damaged completed receipts or duplicated selections never become fake successful request results', async t => {
  const f = fixture(t), invoke = () => f.like({}, 'corrupt', '帮我最近三条朋友圈点赞'); await invoke();
  const directory = path.join(f.root, 'storage/moments/like-requests'), file = path.join(directory, fs.readdirSync(directory)[0]);
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const corrupt of [record => { record.results[0].liked = false; }, record => { record.results[0].delivery = 'unknown'; },
    record => { record.results[1] = record.results[0]; }, record => { record.posts[1] = record.posts[0]; }, record => { record.posts[0].createdAt = 'invalid'; },
    record => { record.results = []; }]) {
    const changed = structuredClone(original); corrupt(changed); fs.writeFileSync(file, JSON.stringify(changed));
    f.channel.moments = new MomentsService(f.channel);
    await assert.rejects(invoke(), error => error.code === 'MOMENTS_STATE_INVALID');
  }
  for (const invalid of [null, false, [], { ...original, args: undefined }]) {
    fs.writeFileSync(file, JSON.stringify(invalid)); f.channel.moments = new MomentsService(f.channel);
    await assert.rejects(invoke(), error => error.code === 'MOMENTS_STATE_INVALID');
  }
  assert.equal(f.writes.length, 3); fs.writeFileSync(file, JSON.stringify(original));
});

test('deleted items can continue the same target cursor but a wrong author or malformed response does not write', async t => {
  const f = fixture(t, { read: args => ({ accountId, action: 'user', items: args.query.cursor ? [post('2')] : [post('3', 'bob', { deleted: true })], nextCursor: args.query.cursor ? null : 'next' }) });
  const value = await f.like(); assert.equal(value.results[0].postId, '2'); assert.equal(f.reads[1].query.userId, 'bob'); assert.equal(f.reads[1].query.cursor, 'next');
  for (const result of [
    { accountId: 'wrong', action: 'user', items: [post('3')] },
    { accountId, action: 'user', items: [post('3', 'alice')] },
    { accountId, action: 'user', items: [post('3', 'bob', { likedByCurrentAccount: undefined })] },
  ]) {
    const invalid = fixture(t, { read: () => result });
    await assert.rejects(invalid.like(), error => error.code === 'MOMENTS_LIKE_READ_INVALID'); assert.equal(invalid.writes.length, 0);
  }
});

test('read failure is a failure result rather than an empty friend feed', async t => {
  const f = fixture(t, { read: () => { throw new ChannelError('READ_DENIED', '合成读取失败'); } });
  const tool = momentsLikeRequestTool({ like: (args, signal) => f.like(args, 'fail-read', '帮我点赞', bob, signal) });
  const value = JSON.parse(await tool.execute({ subject: 'speaker' }, { signal: f.signal }));
  assert.equal(value.ok, false); assert.equal(value.code, 'READ_DENIED'); assert.equal(value.results, undefined); assert.equal(f.writes.length, 0);
});

test('an unknown write stops the batch and repeated or restarted execution does not send again', async t => {
  const f = fixture(t, { write: args => { if (args.query.postId === '2') throw new ChannelError('NO_RECEIPT', '合成回执丢失'); } });
  const result = await f.like({}, 'batch-unknown', '帮我最新三条朋友圈点赞');
  assert.equal(result.ok, false); assert.equal(result.liked, 1); assert.equal(result.remaining, 1); assert.equal(result.results[1].state, 'unknown');
  assert.deepEqual(f.writes.map(call => call.query.postId), ['3', '2']);
  f.channel.moments = new MomentsService(f.channel);
  const repeated = await f.like({}, 'batch-unknown', '帮我最新三条朋友圈点赞'); assert.equal(repeated.reusedRequest, true); assert.equal(f.writes.length, 2);
});

test('damaged progress cannot resume remaining posts after a failed or unknown receipt', async t => {
  const f = fixture(t, { write: args => { if (args.query.postId === '2') throw new ChannelError('NO_RECEIPT', '合成回执丢失'); } });
  const invoke = () => f.like({}, 'damaged-unknown', '帮我最新三条朋友圈点赞'); await invoke();
  const directory = path.join(f.root, 'storage/moments/like-requests'), file = path.join(directory, fs.readdirSync(directory)[0]);
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const state of ['unknown', 'rejected', 'not-sent']) {
    const changed = structuredClone(original); changed.state = 'selected'; delete changed.error; changed.results[1].state = state;
    fs.writeFileSync(file, JSON.stringify(changed)); f.channel.moments = new MomentsService(f.channel);
    await assert.rejects(invoke(), error => error.code === 'MOMENTS_STATE_INVALID');
  }
  assert.deepEqual(f.writes.map(call => call.query.postId), ['3', '2']);
});

test('wrong target in a claimed success receipt is never reported as a confirmed like', async t => {
  const f = fixture(t, { write: () => ({ accountId, action: 'like', postId: '99', liked: true, delivery: 'server-ack' }) });
  const value = await f.like(); assert.equal(value.ok, false); assert.equal(value.liked, 0); assert.equal(value.results[0].state, 'unknown');
});

test('disabled or unreadable request settings and withdrawn conversation authorization stop the narrow capability', async t => {
  const f = fixture(t);
  f.channel.momentsAutomation.likes.configure(accountId, { respondToRequests: false });
  assert.equal(f.channel.moments.likeRecentAvailable(bob, '帮我点赞'), false);
  await assert.rejects(f.like(), error => error.code === 'MOMENTS_LIKE_REQUEST_DISABLED');
  f.channel.momentsAutomation.likes.configure(accountId, { respondToRequests: true }); f.channel.momentsAutomation.likes.error = '合成状态错误';
  await assert.rejects(f.like(), error => error.code === 'MOMENTS_LIKE_REQUEST_DISABLED');
  f.channel.momentsAutomation.likes.error = null;
  f.store.configure(accountId, { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  await assert.rejects(f.like(), error => error.code === 'MOMENTS_LIKE_NOT_AUTHORIZED'); assert.equal(f.writes.length, 0);
});

test('revoking scope, changing account or disabling requests while reading prevents the first write', async t => {
  for (const mutation of [f => f.store.configure(accountId, { ...f.store.settings(accountId), enabled: false }), f => { f.status.account = { id: 'changed-account' }; },
    f => f.channel.momentsAutomation.likes.configure(accountId, { respondToRequests: false })]) {
    let current;
    const f = fixture(t, { read: () => mutation(current) }); current = f;
    await assert.rejects(f.like()); assert.equal(f.writes.length, 0);
  }
});

test('administrator revocation during another-friend read cannot fall back to ordinary self authority', async t => {
  let current;
  const f = fixture(t, { read: () => { const config = current.store.config.snapshot(current.store.data); config.remote.globalAdminIds = []; current.store.config.commit(config); } }); current = f;
  f.setPosts([post('8', 'friend')]);
  await assert.rejects(f.like({ user: '张三' }, 'revoked-admin', '请给张三的朋友圈点赞', alice), error => error.code === 'MOMENTS_LIKE_NOT_AUTHORIZED');
  assert.equal(f.writes.length, 0);
});

test('cancellation during submission suppresses output and permanently stops the remaining batch', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController(); t.after(() => release.resolve());
  const f = fixture(t, { write: async () => { entered.resolve(); await release.promise; } });
  const pending = f.like({}, 'cancelled', '帮我最新三条朋友圈点赞', bob, controller.signal); await entered.promise;
  controller.abort(new ChannelError('CANCELLED', '合成取消')); release.resolve(); await assert.rejects(pending, error => error.code === 'CANCELLED');
  const result = await f.like({}, 'cancelled', '帮我最新三条朋友圈点赞'); assert.equal(result.ok, false); assert.equal(f.writes.length, 1);
});

test('native work registers the composite port and progressive mode preloads direct like requests', async () => {
  const calls = [], definitions = workModelTools({ surface: 'native', cwd: process.cwd(), request: '帮我点赞', limits: {}, assertAllowed() {}, onOperation() {},
    moments: { read: async () => ({}), likeRecent: async args => { calls.push(args); return { ok: true, liked: 1 }; } } });
  const tool = definitions.find(value => value.name === 'wechat_moments_like_recent'); assert(tool);
  await tool.execute({ subject: 'speaker' }, { signal: new AbortController().signal }); assert.equal(calls.length, 1);
  assert(planProgressiveTools([tool], '帮我点个赞').initial.includes(tool));
  const deferred = planProgressiveTools([tool], '你好'); assert.equal(deferred.deferredGroups[0].id, 'moments-like');
  assert.deepEqual(planProgressiveTools([], '帮我点赞'), { initial: [], deferredGroups: [] });
});
