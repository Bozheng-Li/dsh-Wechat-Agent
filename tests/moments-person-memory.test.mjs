import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, WechatChannel, createPluginService, rpcHandler, ChannelError } from '../lib/testing.js';
import { readMomentsWithMemory } from '../modules/moments/read.mjs';
import { validateRoleCardProposal } from '../modules/memory/roles/profile-extraction.mjs';
import { emptyRoleCard } from '../shared/role-card.mjs';

const accountId = 'moment-memory-owner', parent = path.resolve('storage/tmp');
const owner = { principal: { kind: 'owner' } };
const signal = () => new AbortController().signal;
const post = (now, extra = {}) => ({ id: '9007199254740997', author: { userId: 'alice', nickname: '阿宁' },
  createdAt: Math.floor(now / 1000), text: '我长期喜欢红茶。', contentAvailable: true, deleted: false,
  media: [], imageCount: 0, comments: [], likes: [], likedByCurrentAccount: false, ...extra });
const page = (posts, query = { action: 'timeline' }) => ({ accountId, source: 'wechat-sns-live',
  action: query.action, ...(query.userId ? { userId: query.userId } : {}), ...(query.postId ? { postId: query.postId } : {}),
  fetchedAt: new Date().toISOString(), items: posts, nextCursor: null });
const proposal = (source, field = 'preferences', value = '喜欢红茶') => ({ updates: [{ field, value,
  evidence: [{ sourceId: source.id, quote: source.text }] }], conflicts: [] });

function fixture(t) {
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'moments-person-')), store = new StateStore(root);
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob', 'requester'], groups: ['people@chatroom'], prompt: '' });
  const config = store.config.snapshot(store.data); config.remote = { globalAdminIds: ['requester'] }; store.config.commit(config);
  store.setConversationSettings(accountId, 'private', 'requester', { ...store.conversationSettings(accountId, 'private', 'requester'), remoteEnabled: true });
  let now = Date.now(); const reads = [], reviews = [], sent = [];
  const state = { account: { id: accountId }, online: true, result: page([post(now)]), extract: data => proposal(data.sources[0]) };
  const runner = { selection: () => ({ provider: 'test', model: 'test' }), defaultSelection: () => ({ provider: 'test', model: 'test' }),
    run: async () => ({ text: '知道了。' }), extractRoleCard: async input => {
      const data = JSON.parse(input.text); reviews.push(data); return { text: JSON.stringify(await state.extract(data, input)) };
    } };
  const worker = { status: () => ({ online: state.online, state: 'online', account: state.account, momentsReadReady: true, login: { state: 'idle' } }),
    call: async () => ({ privatePeers: [{ id: 'alice', name: '阿宁' }], groups: [] }),
    readMoments: async (params, activeSignal) => { reads.push(params); return state.read ? state.read(params, activeSignal) : structuredClone(state.result); },
    send: async value => { sent.push(value); return { delivery: 'server-ack', serverMessageIds: ['synthetic'] }; } };
  const channel = new WechatChannel({ store, runner, transport: worker, now: () => now });
  const maintenance = channel.personMemory;
  clearTimeout(maintenance.wakeTimer); maintenance.wake = () => {};
  maintenance.nextScanAt = Infinity; maintenance.nextMomentsScanAt = Infinity; maintenance.lastAccountId = accountId;
  maintenance.configure({ ...store.roleCardSettings(), trigger: 'time' }, store.roleCardSettingsView().revision);
  maintenance.nextMomentsScanAt = Infinity;
  const service = createPluginService({ ctx: { llm: { listProviders: () => [], listModels: () => [] } }, root, store, worker, runner, channel });
  const rpc = rpcHandler(service), person = personId => ({ accountId, personId });
  const scope = { accountId, chatType: 'private', peerId: 'requester', senderId: 'requester' };
  t.after(async () => {
    await channel.close(); await service.drain();
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(parent));
    assert(path.basename(resolved).startsWith('moments-person-')); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, channel, maintenance, worker, state, reads, reviews, sent, rpc, person, scope,
    now: () => now, advance: ms => { now += ms; },
    run: async () => { maintenance.tick(); await maintenance.whenIdle(); },
    observe: (posts, query = { action: 'timeline' }) => maintenance.captureMoments(accountId, page(posts, query), query) };
}

test('owner reads collect author text, preserve one card across chat and Moments, and wait the configured hour', async t => {
  const f = fixture(t), scope = { accountId, chatType: 'private', peerId: 'alice' };
  const old = f.store.roleCards.save(f.person('alice'), { ...emptyRoleCard(), addressAs: '阿宁' }, 'empty', f.now() - 86400000);
  f.channel.memory.append(scope, { key: 'chat-one', messageId: '1', senderId: 'alice', senderName: '阿宁',
    direction: 'incoming', text: '今天天气不错。', time: f.now() });
  const result = await f.rpc('moments.read', { accountId, action: 'timeline' }, signal(), owner);
  assert.equal(result.ok, true); assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 2);
  f.state.extract = data => proposal(data.sources.find(source => source.kind === 'moments'));
  await f.run(); f.advance(3599999); await f.run(); assert.equal(f.reviews.length, 0);
  f.advance(1); await f.run(); assert.equal(f.reviews.length, 1);
  const view = f.store.roleCards.view(f.person('alice'));
  assert.equal(view.roleId, old.roleId); assert.equal(view.card.addressAs, '阿宁'); assert.equal(view.card.preferences, '喜欢红茶');
  assert.equal(view.evidence.preferences.sources[0].kind, 'moments');
  assert.equal(view.evidence.preferences.sources[0].postId, '9007199254740997');
  assert.equal(view.evidence.preferences.sources[0].quote, '我长期喜欢红茶。');
  assert.equal(view.pendingCount, 0); assert.equal(f.store.roleCardSettings().timeoutMinutes, 60); assert.equal(f.sent.length, 0);
});

test('repeated reads, different viewers and interaction changes never count the same original text twice', async t => {
  const f = fixture(t); f.observe([post(f.now())]);
  f.advance(5000);
  f.state.result = page([post(f.now() - 5000, { author: { userId: 'alice', nickname: '另一个显示昵称' },
    likedByCurrentAccount: true, likeCount: 20, likes: [{ userId: 'bob' }] })]);
  await f.channel.moments.read({ action: 'timeline' }, f.scope, signal());
  const query = { action: 'user', userId: 'alice' };
  f.observe(f.state.result.items, query);
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 1);
  f.advance(3595000); await f.run(); assert.equal(f.reviews.length, 1);
  assert.equal(f.observe(f.state.result.items), 0);
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 0);
});

test('comments belong to their own verified authors, and likes or photos provide no personal evidence', async t => {
  const f = fixture(t), bob = { id: '22', userId: 'bob', nickname: '阿宁', text: '我长期喜欢咖啡。', createdAt: Math.floor(f.now() / 1000), deleted: false };
  f.observe([post(f.now(), { comments: [bob], likes: [{ userId: 'carol', text: '我喜欢牛奶。' }],
    link: { title: '我叫博士', description: '职业医生' }, imageCount: 1, media: [{ type: 'image', description: '爱潜水' }] })]);
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 1);
  assert.equal(f.store.roleCards.view(f.person('bob')).pendingCount, 1);
  assert.notEqual(f.store.roleCards.identity(f.person('alice')), f.store.roleCards.identity(f.person('bob')));
  assert.throws(() => f.store.roleCards.view(f.person('carol')), { code: 'OBJECT_NOT_AUTHORIZED' });
  assert.equal(fs.existsSync(f.store.roleCards.paths(f.person('carol')).observationsFile), false);
  const alice = f.store.roleCards.document(f.person('alice')).pending[0];
  assert.equal(alice.text, '我长期喜欢红茶。'); assert(!JSON.stringify(alice).includes('医生')); assert(!JSON.stringify(alice).includes('潜水'));
  const query = { action: 'comments', postId: '9007199254740997' };
  f.observe([bob], query); assert.equal(f.store.roleCards.view(f.person('bob')).pendingCount, 1);
  f.state.extract = data => proposal(data.sources[0], 'preferences', data.person.personId === 'bob' ? '喜欢咖啡' : '喜欢红茶');
  f.advance(3600000); await f.run();
  assert.equal(f.store.roleCards.view(f.person('bob')).evidence.preferences.sources[0].commentId, '22');
  assert.equal(f.store.roleCards.view(f.person('alice')).card.preferences, '喜欢红茶');
});

test('untrusted, wrong-target, future, deleted, truncated and owner content cannot enter a person card', async t => {
  const f = fixture(t), query = { action: 'detail', postId: '99' };
  assert.equal(f.observe([post(f.now())], query), 0);
  assert.equal(f.maintenance.captureMoments(accountId, { ...page([post(f.now())]), accountId: 'another-owner' }, { action: 'timeline' }), 0);
  assert.equal(f.maintenance.captureMoments(accountId, { ...page([post(f.now())]), source: 'cache' }, { action: 'timeline' }), 0);
  for (const value of [post(f.now(), { deleted: true }), post(f.now(), { contentAvailable: false }), post(f.now(), { textTruncated: true }),
    post(f.now() + 60000), post(f.now(), { author: { userId: accountId } }), post(f.now(), { author: { userId: 'room@chatroom' } }),
    post(f.now(), { id: '0' }), post(f.now(), { text: '', imageCount: 1 })]) f.observe([value]);
  assert.equal(f.store.roleCards.list(accountId).length, 0);
});

test('older Moments cannot replace a newer administrator correction, and third-person quotes fail extraction', async t => {
  const f = fixture(t);
  f.store.roleCards.save(f.person('alice'), { ...emptyRoleCard(), preferences: '喜欢咖啡' }, 'empty', f.now());
  f.observe([post(f.now() - 86400000)]); f.advance(3600000); await f.run();
  assert.equal(f.store.roleCards.view(f.person('alice')).card.preferences, '喜欢咖啡');
  f.observe([post(f.now(), { id: '9007199254740998', text: '我妹妹喜欢红茶。' })]);
  const source = f.store.roleCards.document(f.person('alice')).pending[0];
  assert.throws(() => validateRoleCardProposal(JSON.stringify(proposal(source)), { scope: f.person('alice'), sources: [source], now: f.now() }),
    { code: 'ROLE_CARD_EXTRACTION_INVALID' });
});

test('pending Moments survive restart and do not depend on a private-chat archive generation', async t => {
  const f = fixture(t); f.observe([post(f.now())]);
  const persisted = new StateStore(f.root), source = persisted.roleCards.document(f.person('alice')).pending[0];
  assert.equal(source.kind, 'moments'); assert.equal(source.generation, undefined);
  const view = persisted.roleCards.view(f.person('alice'));
  f.maintenance.jobs.clear(); f.maintenance.scan(accountId); clearTimeout(f.maintenance.scanTimer); f.maintenance.scanning = false;
  assert(f.maintenance.jobs.has(view.roleId)); assert.equal(f.maintenance.sourceAvailable(source), true);
  f.channel.memory.clear({ accountId, chatType: 'private', peerId: 'alice' });
  assert.equal(f.maintenance.sourceAvailable(source), true);
  f.advance(3600000); await f.run(); assert.equal(f.store.roleCards.view(f.person('alice')).card.preferences, '喜欢红茶');
});

test('live read cancellation or a revoked reader authorization prevents capture', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); let allowed = true;
  f.state.read = async () => { await gate.promise; return page([post(f.now())]); };
  const pending = readMomentsWithMemory(f.channel, { accountId, scopeKey: 'reader', query: { action: 'timeline' } }, signal(),
    () => { if (!allowed) throw new ChannelError('UNAUTHORIZED', 'synthetic revoked reader'); });
  allowed = false; gate.resolve(); await assert.rejects(pending, { code: 'UNAUTHORIZED' });
  assert.equal(f.store.roleCards.list(accountId).length, 0);
});

test('a card persistence failure is recorded without breaking a valid WeChat read', async t => {
  const f = fixture(t);
  t.mock.method(f.store.roleCards, 'observe', () => { throw new ChannelError('ROLE_CARD_WRITE_FAILED', 'synthetic disk failure'); });
  const result = await f.rpc('moments.read', { accountId, action: 'timeline' }, signal(), owner);
  assert.equal(result.ok, true); assert.equal(result.value.items[0].id, '9007199254740997');
  assert.equal(f.store.roleCards.errors.get(f.store.roleCards.identity(f.person('alice'))), 'synthetic disk failure');
});

test('the independent hourly poll is bounded, deduplicated, and stops with automatic memory disabled', async t => {
  const f = fixture(t);
  f.state.read = async ({ query }) => ({ ...page([post(f.now() - 1000, { id: String(100 + f.reads.length) })]), nextCursor: 'cursor-' + f.reads.length });
  await f.maintenance.scanMoments(accountId);
  assert.equal(f.reads.length, 3); assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 3);
  assert.equal(f.maintenance.nextMomentsScanAt, f.now() + 3600000); assert.equal(f.sent.length, 0);
  f.maintenance.configure({ ...f.store.roleCardSettings(), enabled: false }, f.store.roleCardSettingsView().revision);
  await f.maintenance.scanMoments(accountId); assert.equal(f.reads.length, 3);
});

test('an account switch during the poll returns no old-account sources', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.state.read = async () => { await gate.promise; return page([post(f.now())]); };
  const pending = f.maintenance.scanMoments(accountId);
  f.state.account = { id: 'another-account' }; gate.resolve(); await pending;
  assert.equal(f.store.roleCards.list(accountId).length, 0); assert.equal(f.sent.length, 0);
});
