import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StateStore, WechatChannel, TaskScheduler, createPluginService, ChannelError, identity,
  personAuthorized, assertConversationAuthorized, authorizationEpoch, assertAuthorizationEpoch } from '../lib/testing.js';
import { emptyRoleCard } from '../shared/role-card.mjs';
import { stickerPng } from './fixtures/stickers.mjs';
import { momentsPlanSettings } from '../shared/moments-publishing.mjs';

const base = path.resolve('storage/tmp');
function fixture(t, options = {}) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'object-authorization-')), store = new StateStore(root), accountId = 'auth-owner';
  const settings = { enabled: true, privatePeers: ['alice', 'bob', 'admin', 'filehelper'], groups: ['room@chatroom', 'other@chatroom'], prompt: '' };
  store.configure(accountId, settings); store.ensureWorkspace();
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true };
  const sent = [], reads = [], writes = [], lowLevel = [], models = [], posts = [], releases = [];
  const runner = { selection: () => ({ provider: 'fixture', model: 'fixture' }), defaultSelection: () => ({ provider: 'fixture', model: 'fixture' }),
    run: async input => { models.push(input); return { text: '模拟回复' }; },
    extractRoleCard: async () => ({ text: '{"updates":[],"conflicts":[]}' }) };
  const transport = { status: () => status,
    send: async (input, signal) => { sent.push(input); return options.send ? options.send(input, signal) : { delivery: 'server-ack', serverMessageIds: ['123'] }; },
    media: async input => { reads.push(input); return { data: stickerPng().toString('base64') }; },
    files: async input => { sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['124'] }; },
    reference: async input => { reads.push(input); return { text: '模拟原文' }; },
    readMomentsImages: async input => { reads.push(input); const postId = input.query.postId;
      return { accountId, source: 'wechat-sns-images-live', postId, post: structuredClone(posts.find(post => post.id === postId)), items: [], imageCount: 0, complete: true }; },
    call: async (operation, input, callOptions) => { lowLevel.push({ operation, input });
      if (options.call) return options.call(operation, input, callOptions);
      if (operation === 'moments.images') { const postId = input.query.postId;
        return { accountId, source: 'wechat-sns-images-live', postId, post: structuredClone(posts.find(post => post.id === postId)), items: [], imageCount: 0, complete: true }; }
      if (operation === 'contacts') return { accountId, privatePeers: settings.privatePeers.map(id => ({ id, name: id })) };
      return { accountId, peerId: input?.peerId, delivery: 'server-ack', serverMessageIds: ['125'] }; },
    readMoments: async input => {
      reads.push(input); const query = input.query;
      const items = query.action === 'comments' ? posts.find(post => post.id === query.postId)?.comments || [] :
        posts.filter(post => query.action === 'detail' ? post.id === query.postId : query.action !== 'user' || post.author.userId === query.userId);
      return { accountId, source: 'wechat-sns-live', action: query.action, userId: query.userId, postId: query.postId, items: structuredClone(items), nextCursor: null };
    },
    writeMoments: async (input, signal) => {
      writes.push(input); const query = input.query;
      if (options.writeMoments) return options.writeMoments(input, signal, transport);
      return { accountId, action: query.action, postId: query.postId || '90', text: query.text,
        delivery: 'server-ack', liked: query.action === 'like', commentId: '91', imageCount: query.images?.length || 0 };
    } };
  const channel = new WechatChannel({ store, runner, transport });
  clearTimeout(channel.personMemory.wakeTimer); channel.personMemory.wake = () => {};
  channel.personMemory.nextScanAt = Infinity; channel.personMemory.nextMomentsScanAt = Infinity; channel.personMemory.lastAccountId = accountId;
  const scheduler = new TaskScheduler({ store, channel }); scheduler.stopped = true;
  const service = createPluginService({ root, store, worker: transport, runner, channel, scheduler });
  const scope = (peerId = 'alice', chatType = peerId.endsWith('@chatroom') ? 'group' : 'private', account = accountId) =>
    ({ accountId: account, chatType, peerId });
  const card = (personId, values = {}, account = accountId) => {
    const person = { accountId: account, personId }, view = store.roleCards.view(person);
    return store.roleCards.save(person, { ...emptyRoleCard(), label: personId, preferences: '喜欢咖啡', ...values }, view.revision);
  };
  const append = (target, senderId, text = '我喜欢咖啡。') => {
    const messageId = randomUUID(), key = identity([target.accountId, target.chatType, target.peerId, messageId]);
    const entry = { key, messageId, senderId, senderName: senderId, direction: 'incoming', text, time: Date.now() };
    const message = { id: messageId, serverMessageId: messageId, chatType: target.chatType, peerId: target.peerId,
      direction: 'incoming', sender: { id: senderId, nickname: senderId }, time: Math.floor(entry.time / 1000),
      message: [{ type: 'text', data: { text } }] };
    store.remember(key, Date.now(), { ...target, key, contextKey: identity([target.accountId, target.chatType, target.peerId, senderId]),
      senderId, sender: senderId, question: text, state: 'skipped', mode: 'default', createdAt: Date.now(), updatedAt: Date.now() },
    { accountId: target.accountId, message });
    channel.memory.append(target, entry); return entry;
  };
  const revoke = async (peerId, chatType = peerId.endsWith('@chatroom') ? 'group' : 'private') => {
    const before = store.settings(accountId), field = chatType === 'group' ? 'groups' : 'privatePeers';
    store.configure(accountId, { ...before, [field]: before[field].filter(id => id !== peerId) });
    await channel.authorization.whenIdle();
  };
  const post = (id, userId, extra = {}) => {
    const value = { id: String(id), author: { userId, nickname: userId }, text: '今天喝咖啡。', createdAt: Math.floor(Date.now() / 1000),
      contentAvailable: true, deleted: false, likedByCurrentAccount: false, imageCount: 0, comments: [], likes: [], visibleCommentEntries: 0, ...extra };
    posts.push(value); return value;
  };
  t.after(async () => {
    for (const release of releases) release();
    await service.drain(); await channel.close();
    const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(base));
    assert(path.basename(target).startsWith('object-authorization-')); fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, store, accountId, settings, status, runner, transport, channel, scheduler, service, scope, card, append, revoke, post,
    sent, reads, writes, lowLevel, models, posts, releases };
}

test('revocation persists administrator cleanup and retains administrators still authorized on another account', async t => {
  const f = fixture(t);
  f.store.configure('other-owner', { ...f.settings, privatePeers: ['alice'] });
  const config = f.store.config.snapshot(f.store.data);
  config.remote = { ...config.remote, globalAdminIds: ['alice', 'bob', 'admin'] };
  f.store.config.commit(config);
  f.append(f.scope('room@chatroom'), 'admin');
  f.store.setConversationSettings(f.accountId, 'group', 'room@chatroom', {
    ...f.store.conversationSettings(f.accountId, 'group', 'room@chatroom'), adminIds: ['alice', 'bob', 'admin'],
  });
  await f.revoke('alice');
  await f.revoke('bob');
  const saved = new StateStore(f.root);
  assert.deepEqual(saved.config.section('remote').globalAdminIds, ['admin', 'alice']);
  assert.deepEqual(saved.conversationSettings(f.accountId, 'group', 'room@chatroom').adminIds, ['admin']);
  assert.deepEqual(saved.data.authorizationRevocations, []);
  assert.equal(f.channel.authorization.error, null);
});

test('startup cleanup failure stays handled, blocks revoked scopes, and can be retried', async t => {
  const f = fixture(t);
  await f.channel.authorization.ready;
  await f.channel.close();
  f.store.data.authorizationRevocations.push(f.scope('alice'));
  f.store.configure(f.accountId, { ...f.settings, privatePeers: f.settings.privatePeers.filter(id => id !== 'alice') });
  const config = f.store.config.snapshot(f.store.data);
  config.remote = { ...config.remote, globalAdminIds: ['alice', 'admin'] };
  f.store.config.commit(config);
  const commit = f.store.config.commit.bind(f.store.config);
  f.store.config.commit = () => { throw Error('simulated disk write failure'); };
  const restarted = new WechatChannel({ store: f.store, runner: f.runner, transport: { status: () => ({ online: false }) } });
  try {
    // Leave readiness unobserved for a turn, as the runtime does while waiting for the worker.
    // node:test reports an unhandled rejection here if reconcile creates a second rejecting promise.
    await new Promise(resolve => setTimeout(resolve, 30));
    await assert.rejects(restarted.authorization.whenIdle(), /simulated disk write failure/);
    assert(restarted.authorization.isCleaning(f.accountId));
    assert.match(restarted.authorization.error, /simulated disk write failure/);
    assert(restarted.authorization.retryTimer);
    f.store.config.commit = commit;
    await restarted.authorization.reconcile();
    assert.deepEqual(new StateStore(f.root).config.section('remote').globalAdminIds, ['admin']);
    assert.deepEqual(f.store.data.authorizationRevocations, []);
    assert.equal(restarted.authorization.error, null);
  } finally {
    f.store.config.commit = commit;
    await restarted.close();
  }
});

test('ordinary cancellation retains a confirmed SNS receipt through both transport wrappers and prevents resubmission', async t => {
  for (const entry of ['method', 'ipc']) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
    const confirm = async input => { entered.resolve(); await release.promise;
      return { accountId: input.accountId, action: 'like', postId: input.query.postId, liked: true, delivery: 'server-ack' }; };
    const f = fixture(t, { writeMoments: (input, signal, transport) => entry === 'ipc'
      ? transport.call('moments.write', input, { signal }) : confirm(input), call: (_operation, input) => confirm(input) });
    f.post(1, 'alice');
    const controller = new AbortController(), query = { action: 'like', postId: '1' }, requestId = 'cancel-after-submit-' + entry;
    const pending = f.channel.moments.writeOwner(query, f.accountId, requestId, controller.signal);
    const rejected = assert.rejects(pending, { code: 'MOMENTS_CANCELLED' });
    await entered.promise; controller.abort(new ChannelError('MOMENTS_CANCELLED', '本轮已取消')); release.resolve(); await rejected;
    const directory = path.join(f.root, 'storage/moments/actions'), files = fs.readdirSync(directory);
    assert.equal(files.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(directory, files[0]))).state, 'succeeded');
    const reused = await f.channel.moments.writeOwner(query, f.accountId, requestId, new AbortController().signal);
    assert.equal(reused.reusedReceipt, true); assert.equal(f.writes.length, 1);
  }
});

test('revocation after ordinary cancellation discards a late SNS acknowledgement even after regrant', async t => {
  for (const entry of ['method', 'ipc']) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(); t.after(() => release.resolve());
    const confirm = async input => { entered.resolve(); await release.promise;
      return { accountId: input.accountId, action: 'like', postId: input.query.postId, liked: true, delivery: 'server-ack' }; };
    const f = fixture(t, { writeMoments: (input, signal, transport) => entry === 'ipc'
      ? transport.call('moments.write', input, { signal }) : confirm(input), call: (_operation, input) => confirm(input) });
    f.post(1, 'alice');
    const controller = new AbortController();
    const pending = f.channel.moments.writeOwner({ action: 'like', postId: '1' }, f.accountId, 'revoke-late-' + entry, controller.signal);
    const rejected = assert.rejects(pending);
    await entered.promise; controller.abort(new ChannelError('MOMENTS_CANCELLED', '本轮已取消'));
    await f.revoke('alice'); await rejected;
    f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: f.settings.privatePeers });
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    const directory = path.join(f.root, 'storage/moments/actions');
    assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], []);
    assert.equal(f.channel.moments.writes.size, 0);
  }
});

test('all direct message and media entry points reject an unauthorised conversation before transport work', async t => {
  const f = fixture(t), input = { ...f.scope('outsider'), message: [{ type: 'text', data: { text: '测试' } }] };
  for (const name of ['send', 'media', 'files', 'reference']) await assert.rejects(f.transport[name](input), { code: 'OBJECT_NOT_AUTHORIZED' });
  for (const operation of ['send', 'media', 'files', 'reference', 'members'])
    await assert.rejects(f.transport.call(operation, input), { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(f.sent.length + f.reads.length + f.lowLevel.length, 0);
  await f.transport.media({ accountId: f.accountId, peerId: 'alice' });
  assert.equal(f.reads.length, 1, 'legacy media parameters still infer the authorised private scope');
});

test('revocation erases renamed and relocated archive copies, scrubs shared sources, and permits only new data after regrant', async t => {
  const f = fixture(t), privateScope = f.scope('alice'), group = f.scope('room@chatroom');
  f.append(privateScope, 'alice', '旧私聊资料');
  const privatePaths = [f.store.data.conversations[identity([f.accountId, 'private', 'alice'])].directory];
  f.store.rememberConversationName(f.accountId, 'private', 'alice', '旧称呼');
  privatePaths.push(f.store.data.conversations[identity([f.accountId, 'private', 'alice'])].directory);
  f.store.setConversationSettings(f.accountId, 'private', 'alice', { ...f.store.conversationSettings(f.accountId, 'private', 'alice'),
    recordsPath: path.join(f.root, 'relocated-records') });
  privatePaths.push(f.store.data.conversations[identity([f.accountId, 'private', 'alice'])].directory);
  f.append(group, 'alice', '群里的旧资料'); f.append(group, 'bob', '仍授权的群资料');
  const groupKey = identity([f.accountId, 'group', group.peerId]), oldGroup = f.store.data.conversations[groupKey].directory;
  f.store.rememberConversationName(f.accountId, 'group', group.peerId, '资料讨论组');
  const newGroup = f.store.data.conversations[groupKey].directory;
  assert.notEqual(oldGroup, newGroup); assert.equal(new Set(privatePaths).size, 3);
  await f.revoke('alice');
  for (const directory of privatePaths) assert(!fs.existsSync(path.join(directory, 'conversation.json')));
  for (const directory of [oldGroup, newGroup]) {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'conversation.json')));
    assert(!JSON.stringify(saved).includes('旧资料')); assert(saved.messages.some(row => row.senderId === 'bob'));
    assert(saved.records.every(row => row.senderId !== 'alice'));
  }
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: f.settings.privatePeers });
  f.append(privateScope, 'alice', '重新授权的新资料');
  const restarted = new StateStore(f.root), messages = restarted.history(f.accountId, 'private', 'alice');
  assert.equal(messages.length, 1); assert.equal(messages[0].text, '重新授权的新资料');
});

test('unauthorised incoming and manual messages create no records, sources or person cards', async t => {
  const f = fixture(t), message = { id: 'not-authorised', peerId: 'outsider', chatType: 'private', sender: { id: 'outsider' },
    time: Math.floor(Date.now() / 1000), direction: 'incoming', message: [{ type: 'text', data: { text: '我喜欢咖啡' } }] };
  f.channel.receive(message, f.accountId); f.channel.receive({ ...message, direction: 'outgoing' }, f.accountId);
  await f.channel.whenIdle();
  assert.equal(f.store.data.records.length, 0); assert.equal(Object.keys(f.store.data.seen).length, 0);
  assert.equal(f.store.roleCards.list(f.accountId).length, 0); assert.equal(f.models.length, 0);
});

test('authorising a group never authorises its members for person cards or friend moments', async t => {
  const f = fixture(t); f.append(f.scope('room@chatroom'), 'outsider', '我喜欢抹茶。');
  assert.equal(personAuthorized(f.store, f.accountId, 'outsider'), false);
  assert.throws(() => f.store.roleCards.view({ accountId: f.accountId, personId: 'outsider' }), { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(fs.existsSync(f.store.roleCards.paths({ accountId: f.accountId, personId: 'outsider' }).observationsFile), false);
  await assert.rejects(f.transport.readMoments({ accountId: f.accountId, query: { action: 'user', userId: 'outsider' } }), { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(f.reads.length, 0);
});

test('timeline, likes and comments are filtered before models, person-memory capture and transport results', async t => {
  const f = fixture(t), captured = [];
  f.channel.personMemory.captureMoments = (_account, result) => captured.push(result);
  f.post(1, 'alice', { comments: [{ id: '10', userId: 'outsider', text: '未授权评论' }, { id: '11', userId: 'bob', text: '已授权评论' }],
    likes: [{ userId: 'outsider' }, { userId: 'bob' }] });
  f.post(2, 'outsider'); f.post(3, f.accountId);
  const result = await f.transport.readMoments({ accountId: f.accountId, query: { action: 'timeline' } });
  assert.deepEqual(result.items.map(post => post.id), ['1', '3']);
  assert.deepEqual(result.items[0].comments.map(comment => comment.id), ['11']);
  assert.deepEqual(result.items[0].likes.map(like => like.userId), ['bob']);
  assert.equal(result.authorizationFilteredCount, 1);
  assert.equal(result.oldestScannedAt, Math.min(...f.posts.map(post => post.createdAt)));
  const comments = await f.transport.readMoments({ accountId: f.accountId, query: { action: 'comments', postId: '1' } });
  assert.deepEqual(comments.items.map(comment => comment.id), ['11']);
  assert(!JSON.stringify(result).includes('未授权评论'));
});

test('like, comment, image and reply operations verify the actual author, including owner requests', async t => {
  const f = fixture(t); f.post(1, 'outsider'); f.post(2, f.accountId, { comments: [{ id: '21', userId: 'outsider', text: '不回复我' }] });
  for (const action of ['like', 'comment']) await assert.rejects(f.channel.moments.writeOwner(
    { action, postId: '1', ...(action === 'comment' ? { text: '评论' } : {}) }, f.accountId, 'blocked-' + action), { code: 'OBJECT_NOT_AUTHORIZED' });
  await assert.rejects(f.transport.writeMoments({ accountId: f.accountId, clientId: 'any', query: { action: 'like', postId: '1' } }), { code: 'OBJECT_NOT_AUTHORIZED' });
  await assert.rejects(f.transport.writeMoments({ accountId: f.accountId, clientId: 'reply', query: { action: 'comment', postId: '2', text: '回复', replyToCommentId: '21' } }),
    { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(f.writes.length, 0);
  f.post(3, 'alice');
  const receipt = await f.channel.moments.writeOwner({ action: 'like', postId: '3' }, f.accountId, 'allowed-like');
  assert.equal(receipt.liked, true); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].authorizedUserIds, f.store.settings(f.accountId).privatePeers);
});

test('authorized moments images use query.postId on both convenience and low-level transport entry points', async t => {
  const f = fixture(t); f.post(1, 'alice'); f.post(2, 'outsider');
  const input = { accountId: f.accountId, query: { postId: '1' } };
  const result = await f.transport.readMomentsImages(input);
  assert.equal(result.post.author.userId, 'alice'); assert.equal(f.reads.filter(row => !row.query?.action).length, 1);
  const raw = await f.transport.call('moments.images', input);
  assert.equal(raw.post.author.userId, 'alice'); assert.equal(f.lowLevel.filter(row => row.operation === 'moments.images').length, 1);
  await assert.rejects(f.transport.readMomentsImages({ ...input, query: { postId: '2' } }), { code: 'OBJECT_NOT_AUTHORIZED' });
  await assert.rejects(f.transport.call('moments.images', { ...input, query: { postId: '2' } }), { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(f.reads.filter(row => !row.query?.action).length, 1); assert.equal(f.lowLevel.filter(row => row.operation === 'moments.images').length, 1);
});

test('saving automatic likes, specific-friend interaction rules and member reminders requires person authorisation', async t => {
  const f = fixture(t), likes = f.channel.momentsAutomation.likes;
  assert.throws(() => likes.configure(f.accountId, { userIds: ['outsider'] }), { code: 'OBJECT_NOT_AUTHORIZED' });
  const automatic = f.channel.momentsAutomation.interactions.automation;
  f.transport.call = async () => ({ accountId: f.accountId, privatePeers: [{ id: 'outsider', name: 'outsider' }] });
  await assert.rejects(automatic.configure(f.accountId, { enabled: true, source: 'user', user: 'outsider' }, ''),
    { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.throws(() => f.scheduler.create({ kind: 'message', content: '提醒', schedule: { kind: 'once', at: Date.now() + 60000 },
    targets: [{ id: 'outsider', name: '未授权成员' }] }, f.scope('room@chatroom')), { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(f.scheduler.data.tasks.length, 0);
});

test('revoking a person deletes local card, private history, memory, images and settings, while retaining another person', async t => {
  const f = fixture(t), alice = f.scope(), bob = f.scope('bob');
  const first = f.append(alice, 'alice'), second = f.append(bob, 'bob');
  f.card('alice'); f.card('bob');
  const attachment = { type: 'image', resourceId: 'a'.repeat(64) };
  await f.channel.imageMemory.capture(alice, first, attachment, { data: stickerPng().toString('base64'), mediaType: 'image/png', quality: 'original' });
  const cardFile = f.store.roleCards.paths({ accountId: f.accountId, personId: 'alice' }).file,
    memoryFile = f.channel.memory.file(f.store.conversationSelector(f.accountId, 'private', 'alice')),
    imageDirectory = f.channel.imageMemory.directory({ ...alice, key: identity([f.accountId, 'private', 'alice']) });
  f.store.setConversationSettings(f.accountId, 'private', 'alice', { ...f.store.conversationSettings(f.accountId, 'private', 'alice'), allowChatTasks: false });
  await f.revoke('alice');
  assert.equal(fs.existsSync(cardFile), false); assert.equal(fs.existsSync(memoryFile), false); assert.equal(fs.existsSync(imageDirectory), false);
  assert(!Object.values(f.store.data.conversations).some(row => row.peerId === 'alice'));
  assert(!f.store.data.records.some(row => row.peerId === 'alice'));
  assert.equal(f.store.roleCards.list(f.accountId)[0].personId, 'bob');
  assert.equal(f.channel.memory.load(bob).entries[0].key, second.key);
  assert.deepEqual(f.store.data.authorizationRevocations, []);
});

test('revoking a person cleans their group sources, shared summaries, model sessions and owned archives', async t => {
  const f = fixture(t), room = f.scope('room@chatroom'), first = f.append(room, 'alice'), second = f.append(room, 'bob');
  let doc = f.channel.memory.load(room); doc.summary = 'alice 喜欢咖啡；bob 正在学习'; f.channel.memory.save(doc);
  f.channel.memory.archive(doc, 'before-edit');
  const view = f.store.views.get(identity([f.accountId, 'group', room.peerId])), context = identity([f.accountId, 'group', room.peerId, '__group_participation__']);
  view.sessions[context] = 'shared-test-session'; f.store.data.sessions[context] = 'shared-test-session';
  f.store.contextOwners.set(context, view.key); f.store.save();
  await f.revoke('alice');
  doc = f.channel.memory.load(room);
  assert.deepEqual(doc.entries.map(entry => entry.key), [second.key]); assert.equal(doc.summary, '');
  assert.deepEqual(view.sessions, {}); assert.equal(f.store.data.sessions[context], undefined);
  const archive = path.join(path.dirname(f.channel.memory.file(doc)), 'archive');
  for (const file of fs.readdirSync(archive)) {
    const saved = JSON.parse(fs.readFileSync(path.join(archive, file), 'utf8'));
    assert.equal(saved.summary, ''); assert(saved.entries.every(entry => entry.senderId !== 'alice'));
    assert(!saved.seen.includes(first.key));
  }
});

test('revoking a group removes only that source from a separately-authorised person card', async t => {
  const f = fixture(t), room = f.scope('room@chatroom'), other = f.scope('other@chatroom');
  f.append(room, 'bob', '我喜欢咖啡。'); f.append(other, 'bob', '叫我小博。');
  const person = { accountId: f.accountId, personId: 'bob' }, doc = f.store.roleCards.document(person), view = f.store.roleCards.view(person);
  const coffee = doc.pending.find(source => source.peerId === room.peerId), name = doc.pending.find(source => source.peerId === other.peerId);
  const evidence = source => [{ ...source, sourceId: source.id, quote: source.text }];
  f.store.roleCards.commit(person, { updates: [{ field: 'preferences', value: '喜欢咖啡', evidence: evidence(coffee) },
    { field: 'addressAs', value: '小博', evidence: evidence(name) }], conflicts: [] }, [coffee, name], view.revision, Date.now());
  await f.revoke(room.peerId);
  const saved = f.store.roleCards.view(person);
  assert.equal(saved.card.preferences, ''); assert.equal(saved.card.addressAs, '小博');
  assert(f.store.roleCards.document(person).sources.every(source => source.peerId !== room.peerId));
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), true);
});

test('revocation removes scheduled tasks, work results, generated-image copies, related digests and recovery records', async t => {
  const f = fixture(t), alice = f.scope(), bob = f.scope('bob'), entry = f.append(alice, 'alice');
  const task = f.scheduler.create({ kind: 'message', content: 'Alice 的提醒', schedule: { kind: 'once', at: Date.now() + 60000 } }, alice),
    retained = f.scheduler.create({ kind: 'message', content: 'Bob 的提醒', schedule: { kind: 'once', at: Date.now() + 60000 } }, bob);
  const workspace = f.store.storageSettings().workspacePath, jobId = 'aaaaaaaaaaaa', keptId = 'bbbbbbbbbbbb';
  for (const [id, scope] of [[jobId, alice], [keptId, bob]]) {
    const folder = '微信agent/work/' + id; fs.mkdirSync(path.join(workspace, folder), { recursive: true });
    fs.writeFileSync(path.join(workspace, folder, 'result.txt'), scope.peerId);
    f.channel.work.store.add({ ...scope, id, folder, senderId: scope.peerId, request: '任务', workspaceRoot: workspace, state: 'succeeded',
      delivery: { state: 'not-ready' }, operations: [], createdAt: Date.now(), updatedAt: Date.now() });
  }
  const imageCopy = path.join(workspace, '微信agent/generated-images', jobId); fs.mkdirSync(imageCopy, { recursive: true });
  fs.writeFileSync(path.join(imageCopy, 'picture.png'), stickerPng());
  const data = f.channel.workbench.disk.load(f.accountId);
  data.summaries.push({ id: 'digest-a', ...alice, source: [{ key: entry.key, text: 'Alice 的原文' }] });
  data.recovery.push({ id: 'recovery-a', ...alice, text: 'Alice 的旧草稿' });
  f.channel.workbench.disk.save(data);
  await f.revoke('alice');
  assert(!f.scheduler.data.tasks.some(row => row.id === task.id)); assert(f.scheduler.data.tasks.some(row => row.id === retained.id));
  assert.equal(fs.existsSync(path.join(workspace, '微信agent/work', jobId)), false); assert.equal(fs.existsSync(imageCopy), false);
  assert.equal(fs.readFileSync(path.join(workspace, '微信agent/work', keptId, 'result.txt'), 'utf8'), 'bob');
  assert.equal(f.channel.workbench.disk.load(f.accountId).summaries.length, 0); assert.equal(f.channel.workbench.disk.load(f.accountId).recovery.length, 0);
});

test('revocation clears automatic friend rules, comments, previews, receipts and person observations together', async t => {
  const f = fixture(t); f.post(1, 'alice'); f.post(2, 'bob');
  f.channel.momentsAutomation.likes.configure(f.accountId, { userIds: ['alice', 'bob'] });
  const automatic = f.channel.momentsAutomation.interactions.automation;
  await automatic.configure(f.accountId, { enabled: true, source: 'user', user: 'alice' }, '');
  const round = await f.channel.momentsAutomation.interactions.preview(f.accountId, { source: 'selected', postIds: ['1'] }, 'preview-alice');
  await f.channel.moments.writeOwner({ action: 'like', postId: '1' }, f.accountId, 'old-like');
  const directory = path.join(f.root, 'storage/moments/actions'); assert.equal(fs.readdirSync(directory).length, 1);
  await f.revoke('alice');
  assert.deepEqual(f.channel.momentsAutomation.likes.rule(f.accountId).settings.userIds, ['bob']);
  assert.equal(automatic.rule(f.accountId).revision, '');
  assert(!f.channel.momentsAutomation.interactions.data.runs[round.id]);
  assert.equal(fs.readdirSync(directory).length, 0);
  assert(![...f.channel.momentOwners.values()].includes('alice'));
});

test('erased trace contexts cannot recreate deleted payloads when a late step finishes', async t => {
  const f = fixture(t), trace = f.channel.traces.task({ accountId: f.accountId, key: 'revoked-model', type: 'memory', peerId: 'alice', chatType: 'private', input: '旧资料' }),
    kept = f.channel.traces.task({ accountId: f.accountId, key: 'kept-model', type: 'memory', peerId: 'bob', chatType: 'private', input: '保留资料' });
  const step = f.channel.traces.startStep(trace, { kind: 'model', title: '迟到模型' });
  await f.channel.traces.flush(); await f.revoke('alice');
  step.end({ output: '不能回来' }); f.channel.traces.update(trace, { state: 'completed', output: '不能回来' }); await f.channel.traces.flush();
  const listing = await f.channel.traces.list(f.accountId);
  assert(listing.items.some(row => row.id === kept.row.id)); assert(!listing.items.some(row => row.id === trace.row.id));
  assert.equal(fs.existsSync(path.join(trace.day.directory, trace.row.id)), false);
});

test('a transport that ignores abort cannot block revocation or return a late result after reauthorisation', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { send: (_input, signal) => { entered.resolve(signal); return release.promise; } });
  f.releases.push(() => release.resolve({ delivery: 'server-ack', serverMessageIds: ['late'] }));
  const pending = f.transport.send({ ...f.scope(), message: [{ type: 'text', data: { text: '测试' } }] });
  const rejected = assert.rejects(pending, { code: 'AUTHORIZATION_CHANGED' }); await entered.promise;
  await f.revoke('alice'); await rejected;
  assert.equal((await entered.promise).aborted, true);
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: [...f.store.settings(f.accountId).privatePeers, 'alice'] });
  release.resolve({ delivery: 'server-ack', serverMessageIds: ['late'] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.data.authorizationRevocations.length, 0); assert.equal(f.sent.length, 1);
});

test('old workbench snapshots cannot restore removed sources after an authorization epoch changes', async t => {
  const f = fixture(t), data = f.channel.workbench.disk.load(f.accountId);
  data.summaries.push({ id: 'late', ...f.scope(), source: [] });
  await f.revoke('alice');
  assert.throws(() => f.channel.workbench.disk.save(data), { code: 'AUTHORIZATION_CHANGED' });
  assert.equal(f.channel.workbench.disk.load(f.accountId).summaries.length, 0);
});

test('a rejected settings save rolls back authorization, epoch and deletion journal before cancelling any work', async t => {
  const f = fixture(t), before = f.store.settings(f.accountId), epoch = authorizationEpoch(f.store, f.accountId), save = f.store.save;
  f.store.save = () => { throw new ChannelError('STATE_WRITE_FAILED', '模拟磁盘失败'); };
  assert.throws(() => f.store.configure(f.accountId, { ...before, privatePeers: ['bob'] }), { code: 'STATE_WRITE_FAILED' });
  f.store.save = save;
  assert.deepEqual(f.store.settings(f.accountId), before); assert.equal(authorizationEpoch(f.store, f.accountId), epoch);
  assert.deepEqual(f.store.data.authorizationRevocations, []); assert.equal(f.channel.authorization.error, undefined);
});

test('failed deletion keeps an object blocked, survives restart metadata and succeeds after the owned file is repaired', async t => {
  const f = fixture(t), alice = f.scope(), key = identity([f.accountId, 'private', 'alice']), directory = f.channel.imageMemory.directory({ ...alice, key }),
    imageState = f.channel.imageMemory.load(alice);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ ...imageState, ownerStoreId: 'other-instance' }));
  const before = f.store.settings(f.accountId);
  f.store.configure(f.accountId, { ...before, privatePeers: before.privatePeers.filter(id => id !== 'alice') });
  await assert.rejects(f.channel.authorization.whenIdle(), { code: 'AUTHORIZATION_CLEANUP_OWNER' });
  assert.equal(personAuthorized(f.store, f.accountId, 'alice'), false); assert.match(f.channel.authorization.error, /清理未完成/);
  assert.equal(new StateStore(f.root).data.authorizationRevocations.length, 1);
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: [...f.store.settings(f.accountId).privatePeers, 'alice'] });
  assert.throws(() => assertConversationAuthorized(f.store, alice), { code: 'OBJECT_NOT_AUTHORIZED' });
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(imageState));
  await f.channel.authorization.enqueue(f.store.data.authorizationRevocations);
  assert.equal(fs.existsSync(directory), false); assert.equal(personAuthorized(f.store, f.accountId, 'alice'), true);
  assert.equal(f.channel.authorization.error, null);
});

test('revocation removes both image collections and source-only memory without a chat archive', async t => {
  const f = fixture(t), scope = f.scope(), key = identity([f.accountId, 'private', 'alice']);
  const doc = f.channel.memory.load(scope);
  f.channel.memory.save(doc);
  const file = f.channel.memory.file(doc), directories = [];
  for (const collection of ['conversation', 'generated']) {
    const state = f.channel.imageMemory.load({ ...scope, collection });
    directories.push(f.channel.imageMemory.directory(state));
  }
  assert.equal(f.store.data.conversations[key], undefined);
  await f.revoke('alice');
  assert.equal(fs.existsSync(file), false);
  assert(directories.every(directory => !fs.existsSync(directory)));
  assert.equal(f.channel.memory.index.conversations[key], undefined);
});

test('a restart retains material provenance after its deletion and finishes removing associated drafts', async t => {
  const f = fixture(t), materials = f.channel.momentsAutomation.materials, publishing = f.channel.momentsAutomation.publishing;
  const entry = f.append(f.scope(), 'alice'), item = materials.put(f.accountId, {
    requestId: 'revoked-material', fields: { title: '原文素材', text: '来自 Alice 的旧资料' } });
  const saved = materials.account(f.accountId).items[item.id];
  saved.origin = 'chat'; saved.sources = [{ chatType: 'private', peerId: 'alice', messageKey: entry.key, at: Date.now() }];
  materials.save();
  const kept = materials.put(f.accountId, { requestId: 'retained-material', fields: { title: '保留素材', text: '保留的公开资料' } });
  const settings = momentsPlanSettings(), now = Date.now(), runId = 'c'.repeat(64), keptId = 'd'.repeat(64);
  const draft = (id, material) => ({ id, accountId: f.accountId, requestId: 'draft-' + id,
    inputHash: createHash('sha256').update(JSON.stringify(settings)).digest('hex'), settings, state: 'draft', origin: 'preview',
    createdAt: now, updatedAt: now, scheduledAt: now, text: '已生成的素材草稿', selectedMaterials: [{ id: material.id, revision: material.revision }] });
  publishing.data.runs[runId] = draft(runId, item); publishing.data.runs[keptId] = draft(keptId, kept); publishing.save();
  const retained = structuredClone(publishing.data.runs[keptId]);
  publishing.error = '模拟后续草稿清理保存失败';
  await assert.rejects(f.revoke('alice'), { code: 'AUTHORIZATION_CLEANUP_STATE' });
  assert.equal(materials.account(f.accountId).items[item.id], undefined);
  assert(publishing.data.runs[runId]);
  const restartedStore = new StateStore(f.root);
  assert(restartedStore.data.authorizationRevocations[0].materialIds.includes(item.id));
  await f.channel.close();
  const restarted = new WechatChannel({ store: restartedStore, runner: f.runner, transport: { status: () => f.status } });
  try {
    await restarted.authorization.ready;
    assert.equal(restarted.momentsAutomation.publishing.data.runs[runId], undefined);
    assert.deepEqual(restarted.momentsAutomation.publishing.data.runs[keptId], retained);
    assert(restarted.momentsAutomation.materials.account(f.accountId).items[kept.id]);
    assert.deepEqual(restartedStore.data.authorizationRevocations, []);
    assert.equal(f.sent.length + f.writes.length, 0);
  } finally { await restarted.close(); }
});

test('a trace index write failure keeps cleanup pending until the deletion is durably saved', async t => {
  const f = fixture(t), traces = f.channel.traces;
  const erased = traces.task({ accountId: f.accountId, key: 'erased-trace', type: 'memory', chatType: 'private', peerId: 'alice', input: '旧资料' }),
    kept = traces.task({ accountId: f.accountId, key: 'retained-trace', type: 'memory', chatType: 'private', peerId: 'bob', input: '保留资料' });
  await traces.flush();
  const rename = fs.promises.rename;
  const mocked = t.mock.method(fs.promises, 'rename', async function (source, target) {
    if (target === erased.day.file) throw Object.assign(new Error('模拟轨迹索引写入失败'), { code: 'EACCES' });
    return rename.call(this, source, target);
  });
  await assert.rejects(f.revoke('alice'), { code: 'EACCES' });
  assert.match(f.channel.authorization.error, /清理未完成/);
  assert.equal(f.store.data.authorizationRevocations.length, 1);
  assert(JSON.parse(fs.readFileSync(erased.day.file, 'utf8')).rows.some(row => row.id === erased.row.id));
  assert.equal(fs.existsSync(path.join(erased.day.directory, erased.row.id)), false);
  mocked.mock.restore();
  await f.channel.authorization.enqueue(f.store.data.authorizationRevocations);
  const rows = JSON.parse(fs.readFileSync(erased.day.file, 'utf8')).rows;
  assert(!rows.some(row => row.id === erased.row.id)); assert(rows.some(row => row.id === kept.row.id));
  assert.deepEqual(f.store.data.authorizationRevocations, []);
});

test('shared work folders remove only the revoked task files and retain shared or externally changed artifacts', async t => {
  const f = fixture(t), workspace = f.store.storageSettings().workspacePath, folder = '微信agent/work/aaaaaaaaaaaa',
    directory = path.join(workspace, folder), now = Date.now();
  fs.mkdirSync(path.join(directory, '.wechat-work'), { recursive: true });
  const artifact = (name, content) => {
    const bytes = Buffer.from(content); fs.writeFileSync(path.join(directory, name), bytes);
    return { path: name, name, kind: 'file', mediaType: 'text/plain', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const privateFile = artifact('alice.txt', '旧任务成果'), shared = artifact('shared.txt', '共用成果'), changed = artifact('changed.txt', '原文件');
  fs.writeFileSync(path.join(directory, 'changed.txt'), '用户后来修改的内容');
  const bob = artifact('bob.txt', '保留任务成果');
  for (const [id, peerId, artifacts] of [['aaaaaaaaaaaa', 'alice', [privateFile, shared, changed]], ['bbbbbbbbbbbb', 'bob', [bob, shared]]]) {
    fs.writeFileSync(path.join(directory, '.wechat-work', id + '.md'), peerId);
    f.channel.work.store.add({ ...f.scope(peerId), id, folder, senderId: peerId, request: '任务', workspaceRoot: workspace, state: 'succeeded',
      delivery: { state: 'not-ready' }, operations: [], result: { text: '成果', files: [], artifacts }, createdAt: now, updatedAt: now });
  }
  await f.revoke('alice');
  assert.equal(fs.existsSync(path.join(directory, 'alice.txt')), false);
  assert.equal(fs.existsSync(path.join(directory, '.wechat-work/aaaaaaaaaaaa.md')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'shared.txt'), 'utf8'), '共用成果');
  assert.equal(fs.readFileSync(path.join(directory, 'changed.txt'), 'utf8'), '用户后来修改的内容');
  assert.equal(fs.readFileSync(path.join(directory, 'bob.txt'), 'utf8'), '保留任务成果');
  assert.equal(f.channel.work.store.data.jobs.length, 1); assert.equal(f.channel.work.store.data.jobs[0].peerId, 'bob');
});

test('authorization and cleanup remain isolated between WeChat accounts', async t => {
  const f = fixture(t); f.store.configure('second-owner', { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  f.card('alice'); f.card('alice', { preferences: '另一个账号的资料' }, 'second-owner');
  const other = f.store.roleCards.paths({ accountId: 'second-owner', personId: 'alice' }).file, bytes = fs.readFileSync(other);
  await f.revoke('alice'); assert.deepEqual(fs.readFileSync(other), bytes);
  assert.equal(personAuthorized(f.store, 'second-owner', 'alice'), true);
  assertAuthorizationEpoch(f.store, 'second-owner', 0);
});

test('revoking group-source messages never removes another account from aggregate records or its archive', async t => {
  const f = fixture(t), otherAccount = 'second-owner';
  f.store.configure(otherAccount, { enabled: true, privatePeers: ['alice'], groups: ['room@chatroom'], prompt: '' });
  f.append(f.scope('room@chatroom'), 'alice');
  const other = f.scope('room@chatroom', 'group', otherAccount), entry = f.append(other, 'alice', '另一账号需要保留的原文');
  const view = f.store.views.get(identity([otherAccount, 'group', other.peerId])), file = path.join(f.store.data.conversations[view.key].directory, 'conversation.json'),
    bytes = fs.readFileSync(file);
  await f.revoke('alice');
  assert(f.store.data.records.some(row => row.key === entry.key), 'the aggregate must retain records owned by the other account');
  assert(view.records.some(row => row.key === entry.key)); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(f.channel.memory.load(other).entries[0].text, '另一账号需要保留的原文');
});

test('successful cleanup of another account keeps a failed revocation visible and scheduled for retry', async t => {
  const f = fixture(t), otherAccount = 'second-owner';
  f.store.configure(otherAccount, { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  await f.channel.authorization.whenIdle();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = f.channel.imageMemory.directory({ ...f.scope(), key: identity([f.accountId, 'private', 'alice']) }),
    imageState = f.channel.imageMemory.load(f.scope());
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ ...imageState, ownerStoreId: 'other-instance' }));
  await assert.rejects(f.revoke('alice'), { code: 'AUTHORIZATION_CLEANUP_OWNER' });
  const retry = f.channel.authorization.retryTimer;
  assert(retry); assert.match(f.channel.authorization.error, /清理未完成/);
  f.store.configure(otherAccount, { ...f.store.settings(otherAccount), privatePeers: [] });
  await f.channel.authorization.whenIdle();
  assert.equal(f.channel.authorization.retryTimer, retry, 'a different successful cleanup must not cancel the failed account retry');
  assert.match(f.channel.authorization.error, /清理未完成/);
  assert.equal(f.store.data.authorizationRevocations.length, 1);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(imageState));
  t.mock.timers.tick(30000); await f.channel.authorization.whenIdle();
  assert.equal(f.store.data.authorizationRevocations.length, 0); assert.equal(f.channel.authorization.error, null);
  assert.equal(fs.existsSync(directory), false); t.mock.timers.reset();
});

test('the automatic reply switch pauses work while retaining valid authorisations and saved data', async t => {
  const f = fixture(t); f.card('alice'); const file = f.store.roleCards.paths({ accountId: f.accountId, personId: 'alice' }).file;
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), enabled: false });
  await f.channel.authorization.whenIdle();
  assert.equal(fs.existsSync(file), true); assert.equal(personAuthorized(f.store, f.accountId, 'alice'), true);
  assert.deepEqual(f.store.data.authorizationRevocations, []);
});
