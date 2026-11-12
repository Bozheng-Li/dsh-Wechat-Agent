import { stickerPng } from './fixtures/stickers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WorkStore, WechatChannel, MomentsService, momentsTool, momentsCommentsTool, momentsWriteTools, momentsAudienceTool, resolveMomentsAudience, workMomentsMedia, chatMomentsMedia, createPluginService, rpcHandler, ChannelError, identity } from '../lib/testing.js';
import { createHash } from 'node:crypto';
import { fixtureWorkRouteDecision } from './fixtures/work-dialogue.mjs';
import { MOMENTS_PUBLISH_RPC_TIMEOUT_MS } from '../shared/moments-publishing.mjs';
const accountId = 'moments-bot', room = 'moments-room@chatroom';
const scope = { accountId, chatType: 'private', peerId: 'alice', senderId: 'alice' };
function fixture(t, { beforeRead, beforeWrite } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-test-')), store = new StateStore(root), reads = [], models = [], sent = [], works = [];
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob', 'visible-author'], groups: [room], prompt: '' });
  const config = store.config.snapshot(store.data); config.remote = { globalAdminIds: ['alice'] }; store.config.commit(config);
  for (const [type, peerId] of [['private', 'alice'], ['private', 'bob'], ['group', room]])
    store.setConversationSettings(accountId, type, peerId, { ...store.conversationSettings(accountId, type, peerId), remoteEnabled: true, mode: type === 'group' ? 'nickname' : 'default', adminIds: [] });
  store.setPersona({ name: '小胖', aliases: ['胖胖'], prompt: '' });
  const writes = [], status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const transport = { status: () => status, readMoments: async (args, signal) => {
    reads.push(args); await beforeRead?.(args); signal.throwIfAborted();
    const items = args.query.action === 'comments'
      ? [{ id: '3', userId: 'visible-author', text: '可见评论', createdAt: Math.floor(Date.now() / 1000) }]
      : [{ id: args.query.postId || '9007199254740997', author: { userId: args.query.userId || accountId },
        text: '授权范围内的响应', imageCount: 1, createdAt: Math.floor(Date.now() / 1000), contentAvailable: true, deleted: false }];
    return { accountId, action: args.query.action, source: 'wechat-sns-live', ...(args.query.action === 'comments' ? { postId: args.query.postId } : {}),
      ...(args.query.action === 'user' ? { userId: args.query.userId } : {}),
      items, nextCursor: null, mediaContentIncluded: false };
  }, writeMoments: async (args, signal) => {
    writes.push(args); await beforeWrite?.(args); signal.throwIfAborted();
    return { accountId, action: args.query.action, postId: args.query.postId ?? '9007199254740999', text: args.query.text,
      liked: true, commentId: '9007199254741000', imageCount: args.query.images?.length ?? 0, delivery: 'server-ack',
      ...(args.query.action === 'publish' ? { audienceConfirmed: true, authorizationConfirmed: true, authorizationExcludedCount: 0,
        authorizedAudienceUserIds: ['alice', 'bob', 'visible-author'], blockedUserIds: [], audienceSource: 'wechat-contacts-live',
        audienceFetchedAt: new Date().toISOString() } : {}),
      ...(args.query.replyToCommentId ? { replyToCommentId: args.query.replyToCommentId, replyToUserId: 'visible-author' } : {}),
      ...(args.query.action === 'delete' ? { deleted: true } : {}) };
  }, send: async payload => { sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['moments-ack-' + sent.length] }; } };
  const runner = { run: async input => {
    if (input.mode === 'work-routing') return { text: JSON.stringify(fixtureWorkRouteDecision(JSON.parse(input.text), { action: 'new' })) };
    if (input.mode === 'work-result') return { text: JSON.parse(input.text).result };
    models.push(input); const tool = input.tools.find(tool => tool.name === 'wechat_moments_read');
    if (tool && input.text.includes('朋友圈')) {
      const result = JSON.parse(await tool.execute({ action: 'timeline' }, { signal: input.signal })); return { text: result.ok ? '已读取朋友圈' : result.message };
    }
    return { text: '普通聊天' };
  } };
  const workRunner = { run: async input => { works.push(input); await input.onSession('moments-work-session');
    const tool = momentsTool({ ...input.moments, assertAllowed: input.assertAllowed, onOperation: input.onOperation });
    const result = JSON.parse(await tool.execute({ action: 'timeline' }, { signal: input.signal })); return { text: result.items[0].text }; } };
  const channel = new WechatChannel({ store, runner, workRunner, transport }); let serial = 0;
  const receive = (text, overrides = {}) => channel.receive({ id: 'moments-message-' + ++serial, direction: 'incoming',
    time: Math.floor(Date.now() / 1000), chatType: 'private', peerId: 'alice', sender: { id: 'alice' },
    message: [{ type: 'text', data: { text } }], ...overrides }, accountId);
  t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-moments-test-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, transport, runner, channel, status, reads, writes, models, works, sent, receive };
}

const audienceSnapshot = { accountId, source: 'wechat-contacts-live', fetchedAt: new Date().toISOString(), membershipComplete: true, unavailableCount: 0,
  contacts: ['alice', 'bob', 'other'].map((id, index) => ({ id, name: index < 2 ? '同名' : '另一位', nickname: id, remark: '', labelIds: index < 2 ? ['1'] : [] })),
  labels: [{ id: '1', name: '同事', memberCount: 2, userIds: ['alice','bob'] }] };
test('audience tools read real IDs with bounded search and label pagination and publish selected IDs unchanged', async () => {
  let writes = [], calls = 0;
  const tool = momentsAudienceTool({ audience: async () => { calls++; return audienceSnapshot; } }), signal = new AbortController().signal;
  const first = JSON.parse(await tool.execute({ search: '同名', limit: 1 }, { signal }));
  assert.equal(first.contacts.length, 1); assert.equal(first.totalMatches, 2); assert.equal(first.nextOffset, 1); assert.equal(first.labels[0].memberCount, 2);
  assert.equal(first.labels[0].userIds, undefined);
  const next = JSON.parse(await tool.execute({ labelId: '1', offset: 1, limit: 1 }, { signal })); assert.equal(next.contacts[0].id, 'bob');
  assert.equal(JSON.parse(await tool.execute({ limit: 101 }, { signal })).ok, false); assert.equal(calls, 2);
  const publish = momentsWriteTools({ write: async query => { writes.push(query); return { delivery: 'server-ack' }; } }).find(tool => tool.name === 'wechat_moments_publish');
  await publish.execute({ text: '正文', blockedLabelIds: ['1'], blockedUserIds: ['alice'] }, { signal });
  assert.deepEqual(writes[0], { action: 'publish', text: '正文', blockedLabelIds: ['1'], blockedUserIds: ['alice'] });
  assert.equal(JSON.parse(await publish.execute({ text: '正文', blockedLabelIds: ['1','1'] }, { signal })).delivery, 'not-sent'); assert.equal(writes.length, 1);
  assert.deepEqual(resolveMomentsAudience(audienceSnapshot, writes[0]).blockedUserIds, ['alice','bob']);
  assert.throws(() => resolveMomentsAudience(audienceSnapshot, { ...writes[0], blockedUserIds: ['unknown'] }));
  assert.throws(() => resolveMomentsAudience({ ...audienceSnapshot, membershipComplete: false }, writes[0]));
});

test('audience access is administrator and account bound in chat, work and owner RPC', async t => {
  const f = fixture(t), reads = [];
  f.status.momentsAudienceReady = true;
  f.transport.readMomentsAudience = async (args, signal) => { reads.push(args); signal.throwIfAborted(); return audienceSnapshot; };
  f.receive('你好'); await f.channel.whenIdle(); assert(f.models[0].tools.some(tool => tool.name === 'wechat_moments_audience'));
  assert.equal(f.channel.moments.audienceAvailable(scope), true); assert.equal(f.channel.moments.audienceAvailable({ ...scope, peerId: 'bob', senderId: 'bob' }), false);
  await assert.rejects(f.channel.moments.audience({ ...scope, senderId: 'bob' }, new AbortController().signal)); assert.equal(reads.length, 0);
  const result = await f.channel.moments.audience(scope, new AbortController().signal); assert.equal(result.labels.length, 1);
  const service = createPluginService({ root: f.root, store: f.store, channel: f.channel, worker: f.transport });
  const invoke = rpcHandler(service), signal = new AbortController().signal;
  assert.equal((await invoke('moments.audience', { accountId }, signal, { principal: { kind: 'owner' } })).ok, true);
  assert.equal((await invoke('moments.audience', { accountId }, signal, { principal: { kind: 'remote' } })).ok, false);
  f.transport.readMomentsAudience = async () => { f.status.account = { id: 'different' }; return audienceSnapshot; };
  await assert.rejects(f.channel.moments.audience(scope, signal), error => error.message.includes('账号'));
});

test('shielded publish requires an exact selection receipt and reuses it after restart without reading changed labels', async t => {
  const f = fixture(t), query = { action: 'publish', text: '正文', blockedLabelIds: ['1'], blockedUserIds: ['alice'] }, signal = new AbortController().signal;
  const oldWrite = f.transport.writeMoments; let writes = 0;
  f.transport.writeMoments = async (args, signal) => { writes++; return { ...await oldWrite(args, signal), audienceConfirmed: true, blockedUserIds: ['alice','bob'], blockedLabelIds: ['1'],
    authorizedAudienceUserIds: ['visible-author'],
    audienceSelection: { blockedLabelIds: ['1'], blockedUserIds: ['alice'] }, audienceSource: audienceSnapshot.source, audienceFetchedAt: audienceSnapshot.fetchedAt }; };
  const confirmed = await f.channel.moments.write(query, scope, 'privacy-turn', signal); assert.equal(confirmed.audienceConfirmed, true);
  const reused = await new MomentsService(f.channel).write(query, scope, 'privacy-turn', signal); assert.equal(reused.reusedReceipt, true); assert.equal(writes, 1);
  f.transport.writeMoments = async (args, signal) => { writes++; return oldWrite(args, signal); };
  await assert.rejects(f.channel.moments.write(query, scope, 'bad-privacy-turn', signal), error => error.code === 'MOMENTS_RESULT_UNKNOWN');
  await assert.rejects(new MomentsService(f.channel).write(query, scope, 'bad-privacy-turn', signal), error => error.code === 'MOMENTS_RESULT_UNKNOWN'); assert.equal(writes, 2);
});
test('chat model can invoke the read-only moments tool for the verified administrator', async t => {
  const f = fixture(t); f.receive('看看朋友圈'); await f.channel.whenIdle();
  assert.equal(f.reads.length, 1); assert.equal(f.works.length, 0); assert(f.models[0].tools.some(tool => tool.name === 'wechat_moments_read'));
  assert.equal(f.reads[0].accountId, accountId); assert.equal(f.reads[0].scopeKey, identity([accountId, 'private', 'alice', 'alice']));
  assert(f.sent.some(payload => JSON.stringify(payload).includes('已读取朋友圈')));
});
for (const action of ['preview', 'publish']) test(`chat ${action} waits beyond the ordinary reply limit but still stops at one hour`, async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let operationSignal;
  f.channel.moments.managePublishing = async (_args, _scope, _key, signal) => {
    operationSignal = signal; entered.resolve();
    await Promise.race([release.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    signal.throwIfAborted(); return {};
  };
  f.runner.run = async input => {
    const tool = input.tools.find(row => row.name === 'wechat_moments_draft'); assert(tool);
    await tool.execute(action === 'preview' ? { action, settings: {} } : { action, id: 'a'.repeat(64) }, { signal: input.signal });
    return { text: '已完成' };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { release.resolve(); t.mock.timers.reset(); });
  f.receive('按我的要求处理朋友圈'); await entered.promise;
  t.mock.timers.tick(600001); assert.equal(operationSignal.aborted, false); assert.equal(f.sent.length, 0);
  t.mock.timers.tick(MOMENTS_PUBLISH_RPC_TIMEOUT_MS - 600001); assert.equal(operationSignal.aborted, true);
  await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(f.writes.length, 0);
});

test('members, fake sender identity, disabled access and unready components receive no social tool', async t => {
  const f = fixture(t), member = { chatType: 'group', peerId: room, sender: { id: 'bob', nickname: '管理员' } };
  f.receive('小胖，看看朋友圈', member); await f.channel.whenIdle();
  assert(!f.models[0].tools.some(tool => tool.name === 'wechat_moments_read')); assert.equal(f.reads.length, 0);
  assert(!f.models[0].tools.some(tool => tool.name === 'wechat_moments_interact'));
  assert.equal(f.channel.moments.available({ ...scope, peerId: 'bob' }), false);
  const config = f.store.conversationSettings(accountId, 'private', 'alice');
  f.store.setConversationSettings(accountId, 'private', 'alice', { ...config, remoteEnabled: false });
  f.receive('看看朋友圈'); await f.channel.whenIdle(); assert.equal(f.reads.length, 0);
  f.store.setConversationSettings(accountId, 'private', 'alice', config); f.status.momentsReadReady = false;
  assert.equal(f.channel.moments.available(scope), false);
});
test('revoking administrator during a social read returns no old response', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve()); const f = fixture(t, { beforeRead: async () => { entered.resolve(); await release.promise; } });
  const pending = f.channel.moments.read({ action: 'timeline' }, scope, new AbortController().signal); await entered.promise;
  const config = f.store.config.snapshot(f.store.data); config.remote.globalAdminIds = []; f.store.config.commit(config); release.resolve();
  await assert.rejects(pending, error => error.code === 'REMOTE_NOT_AUTHORIZED'); assert.equal(f.sent.length, 0);
});
test('work receives the same read capability with the scoped requester', async t => {
  const f = fixture(t), config = f.store.conversationSettings(accountId, 'private', 'alice');
  f.store.setConversationSettings(accountId, 'private', 'alice', { ...config, executionMode: 'work' });
  f.receive('读取朋友圈并整理'); await f.channel.whenIdle();
  assert.equal(f.works.length, 1); assert.equal(f.reads.length, 1); assert.equal(f.models.length, 0);
  assert.equal(typeof f.works[0].moments.manageInteractions, 'function');
  assert.equal(f.reads[0].scopeKey, identity([accountId, 'private', 'alice', 'alice']));
  assert.equal(f.channel.work.list(scope).jobs[0].state, 'succeeded');
  const reloaded = new WorkStore(f.store).list(scope)[0];
  assert.equal(reloaded.state, 'succeeded'); assert.equal(reloaded.operations[0].tool, 'wechat_moments_read');
  assert.equal(reloaded.operations[0].result.items[0].text, '授权范围内的响应');
});
test('owner RPC reads live data without granting another principal or account access', async t => {
  const f = fixture(t), rpc = rpcHandler(createPluginService({ root: f.root, store: f.store, channel: f.channel, runner: f.runner, worker: f.transport }));
  assert.equal((await rpc('moments.read', { accountId }, undefined, { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await rpc('moments.read', { accountId: 'other' }, undefined, { principal: { kind: 'owner' } })).error.code, 'ACCOUNT_CHANGED');
  assert.equal(f.reads.length, 0);
  const result = await rpc('moments.read', { accountId, action: 'timeline', limit: 3 }, undefined, { principal: { kind: 'owner' } });
  assert.equal(result.ok, true); assert.equal(result.value.items.length, 1); assert.equal(f.reads[0].scopeKey, 'owner:' + accountId);
});
test('explicit subjects resolve to their actual roles while vague pronouns and ambiguous names never guess a homepage', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  f.store.configure(accountId, { ...f.store.settings(accountId), privatePeers: [...f.store.settings(accountId).privatePeers, 'friend-a', 'friend-b'] });
  await assert.rejects(f.channel.moments.read({ action: 'user', user: '我' }, scope, signal), error => error.code === 'MOMENTS_SUBJECT_REQUIRED');
  await f.channel.moments.read({ action: 'user', subject: 'account' }, scope, signal);
  assert.equal(f.reads[0].query.userId, accountId);
  for (const user of ['sender', '发起人']) {
    await f.channel.moments.read({ action: 'user', user }, scope, signal); assert.equal(f.reads.at(-1).query.userId, 'alice');
  }
  f.transport.call = async () => ({ privatePeers: [{ id: 'friend-a', name: '张三' }, { id: 'friend-b', nickname: '张三' }] });
  await assert.rejects(f.channel.moments.read({ action: 'user', user: '张三' }, scope, signal), error => error.code === 'MOMENTS_USER_AMBIGUOUS');
  assert.equal(f.reads.length, 3);
  f.transport.call = async () => ({ privatePeers: [{ id: 'friend-a', name: '张三' }] });
  await f.channel.moments.read({ action: 'user', user: '张三' }, scope, signal); assert.equal(f.reads.at(-1).query.userId, 'friend-a');
});
test('read failure stays a failure; cancellation suppresses tool output', async () => {
  const operations = [], tool = momentsTool({ read: async () => { throw new ChannelError('ERR_MOMENTS_REJECTED', '微信拒绝朋友圈读取，未视为空'); },
    onOperation: value => operations.push(value) });
  const result = JSON.parse(await tool.execute({ action: 'user', userId: 'alice', cursor: 'page-2' }, { signal: new AbortController().signal }));
  assert.equal(result.ok, false); assert.equal(result.code, 'ERR_MOMENTS_REJECTED'); assert.equal(result.items, undefined); assert.equal(operations[0].result.ok, false);
  assert.equal(operations[0].userId, 'alice'); assert.equal(operations[0].cursor, 'page-2');
  const controller = new AbortController(); controller.abort(new ChannelError('AUTH_CHANGED', '已撤权'));
  await assert.rejects(tool.execute({ action: 'timeline' }, { signal: controller.signal }), error => error.code === 'AUTH_CHANGED');
});

test('chat exposes mutations only in direct administrator turns and performs no spontaneous writes', async t => {
  const f = fixture(t); f.receive('你好'); await f.channel.whenIdle();
  assert.equal(f.writes.length, 0);
  for (const name of ['wechat_moments_read', 'wechat_moments_comments', 'wechat_moments_like', 'wechat_moments_comment', 'wechat_moments_reply', 'wechat_moments_publish', 'wechat_moments_delete', 'wechat_moments_interact']) assert(f.models[0].tools.some(tool => tool.name === name));
  f.receive('小胖，看看朋友圈', { chatType: 'group', peerId: room, sender: { id: 'bob' } }); await f.channel.whenIdle();
  assert(!f.models.at(-1).tools.some(tool => tool.name.startsWith('wechat_moments_')));
});

test('registered chat tools invoke comments, reply, publish and delete with scoped receipts and restart deduplication', async t => {
  const f = fixture(t), exec = { signal: new AbortController().signal }; f.receive('你好'); await f.channel.whenIdle();
  const tools = f.models[0].tools, find = name => tools.find(tool => tool.name === name);
  const comments = JSON.parse(await find('wechat_moments_comments').execute({ postId: '9007199254740997', limit: 50 }, exec));
  assert.equal(comments.ok, true); assert.equal(f.reads.at(-1).query.action, 'comments');
  const actions = [
    ['wechat_moments_reply', { postId: '9007199254740997', commentId: '3', text: '哈哈' }],
    ['wechat_moments_publish', { text: '自我介绍' }], ['wechat_moments_delete', { postId: '9007199254740997' }],
  ];
  for (const [name, args] of actions) {
    const result = JSON.parse(await find(name).execute(args, exec)); assert.equal(result.ok, true); assert.equal(result.delivery, 'server-ack');
    const query = f.writes.at(-1).query, service = new MomentsService(f.channel), requestId = f.store.data.records.find(record => record.question === '你好').key;
    const reloaded = await service.write(query, scope, requestId, exec.signal);
    assert.equal(reloaded.reusedReceipt, true);
    if (name.endsWith('_reply')) { assert.equal(query.replyToCommentId, '3'); assert.equal(result.replyToUserId, 'visible-author'); }
    if (name.endsWith('_delete')) assert.equal(result.deleted, true);
  }
  assert.equal(f.writes.length, 3);
});

test('comments tool returns read failures and enforces cancellation before exposing a page', async () => {
  const calls = [], tool = momentsCommentsTool({ read: async args => { calls.push(args); throw new ChannelError('ERR_MOMENTS_CURSOR', '分页已过期'); } });
  const result = JSON.parse(await tool.execute({ postId: '1', cursor: 'old-cursor' }, { signal: new AbortController().signal }));
  assert.equal(result.ok, false); assert.equal(result.code, 'ERR_MOMENTS_CURSOR'); assert.equal(calls[0].action, 'comments');
  const abort = new AbortController(); abort.abort(); await assert.rejects(tool.execute({ postId: '1' }, { signal: abort.signal })); assert.equal(calls.length, 1);
});

test('confirmed mutations are deduplicated across concurrent calls and a new service instance', async t => {
  const f = fixture(t), query = { action: 'comment', postId: '9007199254740997', text: '真好看' }, signal = new AbortController().signal;
  const results = await Promise.all([f.channel.moments.write(query, scope, 'actual-message-id', signal), f.channel.moments.write(query, scope, 'actual-message-id', signal)]);
  assert.equal(f.writes.length, 1); assert.equal(results[0].delivery, 'server-ack'); assert.equal(results[1].delivery, 'server-ack');
  const reloaded = new MomentsService(f.channel); const existing = await reloaded.write(query, scope, 'actual-message-id', signal);
  assert.equal(existing.reusedReceipt, true); assert.equal(f.writes.length, 1);
  await reloaded.write(query, scope, 'new-explicit-message', signal); assert.equal(f.writes.length, 2);
  assert.notEqual(f.writes[0].clientId, f.writes[1].clientId);
});

test('unknown writes survive restart without retry; rejected writes also retain the original failure', async t => {
  const f = fixture(t), query = { action: 'publish', text: '完整正文' }, signal = new AbortController().signal;
  f.transport.writeMoments = async () => { f.writes.push('lost'); throw new ChannelError('WORKER_TIMEOUT', '结果不明'); };
  await assert.rejects(f.channel.moments.write(query, scope, 'unknown-message', signal));
  await assert.rejects(new MomentsService(f.channel).write(query, scope, 'unknown-message', signal), error => error.code === 'MOMENTS_RESULT_UNKNOWN');
  assert.equal(f.writes.length, 1);
  f.transport.writeMoments = async () => { f.writes.push('rejected'); throw new ChannelError('ERR_MOMENTS_WRITE_REJECTED', '微信拒绝', { snsDelivery: 'rejected' }); };
  await assert.rejects(f.channel.moments.write(query, scope, 'rejected-message', signal));
  await assert.rejects(new MomentsService(f.channel).write(query, scope, 'rejected-message', signal), error => error.code === 'ERR_MOMENTS_WRITE_REJECTED');
  assert.equal(f.writes.length, 2);
});

test('revoking permissions during a write suppresses output while keeping its real receipt', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  const f = fixture(t, { beforeWrite: async () => { entered.resolve(); await release.promise; } }), query = { action: 'like', postId: '1' };
  const pending = f.channel.moments.write(query, scope, 'revoked-message', new AbortController().signal); await entered.promise;
  const config = f.store.config.snapshot(f.store.data); config.remote.globalAdminIds = []; f.store.config.commit(config); release.resolve();
  await assert.rejects(pending, error => error.code === 'REMOTE_NOT_AUTHORIZED'); assert.equal(f.sent.length, 0);
  const files = fs.readdirSync(path.join(f.root, 'storage/moments/actions'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'storage/moments/actions', files[0]), 'utf8')).state, 'succeeded');
  await assert.rejects(f.channel.moments.write(query, scope, 'another-message', new AbortController().signal)); assert.equal(f.writes.length, 1);
});

test('write tools do not discard images, fabricate success or accept video as a photo', async () => {
  const calls = [], tools = momentsWriteTools({ write: async query => { calls.push(query); return { accountId, delivery: 'server-ack', postId: '1' }; },
    media: { load: async paths => paths.map(() => ({ data: 'YWJj', width: 1, height: 1 })) } });
  const exec = { signal: new AbortController().signal }, publish = tools.find(tool => tool.name === 'wechat_moments_publish');
  assert.equal(JSON.parse(await publish.execute({ text: '正文', images: ['dog.png'] }, exec)).ok, true);
  assert.equal(calls[0].images.length, 1);
  assert.equal(JSON.parse(await publish.execute({ text: '正文', video: 'clip.mp4' }, exec)).ok, false); assert.equal(calls.length, 1);
  const bad = momentsWriteTools({ write: async () => { throw new ChannelError('ERR_MOMENTS_WRITE_REJECTED', '微信拒绝操作'); } })[0];
  const rejected = JSON.parse(await bad.execute({ postId: '1', subject: 'speaker' }, exec));
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'ERR_MOMENTS_WRITE_REJECTED');
});

test('native photo publishing rejects links, escaped task paths and video files before any upload', async t => {
  const f = fixture(t), media = workMomentsMedia(f.root), signal = new AbortController().signal;
  fs.writeFileSync(path.join(f.root, 'video.mp4'), Buffer.from('not-a-photo'));
  for (const target of ['../outside.jpg', 'https://example.com/image.jpg', 'video.mp4']) await assert.rejects(media.load([target], signal, () => {}));
  const folder = path.join(f.root, 'redirect'); fs.symlinkSync(os.tmpdir(), folder, 'junction');
  await assert.rejects(media.load(['redirect/image.jpg'], signal, () => {})); fs.unlinkSync(folder);
  assert.equal(f.writes.length, 0);
});

test('changed publish content in the same user request is blocked even while the original call is running', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
  const f = fixture(t, { beforeWrite: async () => { entered.resolve(); await release.promise; } }), signal = new AbortController().signal;
  const pending = f.channel.moments.write({ action: 'publish', text: '原文' }, scope, 'one-message', signal); await entered.promise;
  await assert.rejects(f.channel.moments.write({ action: 'publish', text: '不同内容' }, scope, 'one-message', signal), error => error.code === 'MOMENTS_STATE_INVALID');
  release.resolve(); await pending;
  await assert.rejects(f.channel.moments.write({ action: 'publish', text: '不同内容' }, scope, 'one-message', signal), error => error.code === 'MOMENTS_STATE_INVALID');
  assert.equal(f.writes.length, 1);
});

test('malformed success receipts are stored as unknown and never repeat a publication', async t => {
  const f = fixture(t), query = { action: 'publish', text: '原文' }, signal = new AbortController().signal;
  f.transport.writeMoments = async () => { f.writes.push('bad-receipt'); return { accountId, action: 'publish', postId: '1', text: '不同内容', imageCount: 0, delivery: 'server-ack' }; };
  await assert.rejects(f.channel.moments.write(query, scope, 'malformed-message', signal), error => error.code === 'MOMENTS_RESULT_UNKNOWN');
  await assert.rejects(new MomentsService(f.channel).write(query, scope, 'malformed-message', signal), error => error.code === 'MOMENTS_RESULT_UNKNOWN');
  assert.equal(f.writes.length, 1);
});

test('chat photo publishing requires frozen room ownership, full media and a still-current undeleted image', async () => {
  const entry = { key: 'image-record', messageId: '111', text: '这张图片', rememberedAt: Date.now(), attachments: [{ type: 'image', resourceId: 'a'.repeat(64) }] };
  const snapshot = { generation: 1, createdAt: Date.now(), entries: [entry] }, doc = structuredClone(snapshot), deleted = {};
  const data = stickerPng();
  let quality = 'original', duringRead = () => {}, reads = 0;
  const channel = { memory: { load: () => doc, expiry: () => Date.now() + 10000, now: Date.now, images: { load: () => ({ deleted }), imageId: () => 'saved-id' } },
    transport: { media: async args => { reads++; assert.equal(args.accountId, accountId); assert.equal(args.peerId, scope.peerId); assert.equal(args.messageId, '111'); duringRead(); return { data: data.toString('base64'), quality }; } } };
  const media = chatMomentsMedia(channel, scope, snapshot, entry.key), id = createHash('sha256').update(JSON.stringify([entry.key, entry.attachments[0].resourceId])).digest('hex'), signal = new AbortController().signal;
  assert((await media.load([id], signal, () => {}))[0].width > 0);
  await assert.rejects(media.load(['unknown'], signal, () => {})); assert.equal(reads, 1);
  quality = 'thumbnail'; await assert.rejects(media.load([id], signal, () => {}));
  quality = 'original'; deleted['saved-id'] = true; await assert.rejects(media.load([id], signal, () => {})); assert.equal(reads, 2);
  deleted['saved-id'] = false; duringRead = () => { doc.generation++; }; await assert.rejects(media.load([id], signal, () => {}));
});
