import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore, WechatChannel, createPluginService, rpcHandler, generateInteractionComments } from '../lib/testing.js';
import { personRoleCardTool, personRoleContext, readableRoleCard } from '../modules/memory/roles/tool.mjs';
import { validateRoleCardProposal } from '../modules/memory/roles/profile-extraction.mjs';
import { emptyRoleCard } from '../shared/role-card.mjs';
import { DEFAULT_ROLE_CARD_SETTINGS } from '../shared/role-card-settings.mjs';

const base = path.resolve('storage/tmp');
const owner = { principal: { kind: 'owner' } };
const signal = () => new AbortController().signal;
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'person-card-')), store = new StateStore(root);
  const account = { id: 'person-owner', nickname: '测试账号' }, group = { accountId: account.id, chatType: 'group', peerId: 'people@chatroom' },
    privateChat = { accountId: account.id, chatType: 'private', peerId: 'alice' };
  store.configure(account.id, { enabled: true, groups: [group.peerId], privatePeers: ['alice', 'bob'], prompt: '' });
  let now = Date.now(), serial = 0;
  const sent = [], calls = [], background = [];
  const state = { account, online: true, extract: async () => ({ updates: [], conflicts: [] }) };
  const runner = { selection: () => ({ provider: 'test', model: 'test' }), defaultSelection: () => ({ provider: 'test', model: 'test' }),
    run: async input => { calls.push(input); return { text: '知道了。' }; },
    extractRoleCard: async input => { background.push(input); const result = await state.extract(JSON.parse(input.text), input); return { text: JSON.stringify(result) }; } };
  const worker = { status: () => ({ online: state.online, state: 'online', account: state.account, login: { state: 'idle' } }),
    send: async input => { sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sent.length] }; } };
  const channel = new WechatChannel({ store, runner, transport: worker, now: () => now });
  // Drive the real persisted queue with a deterministic clock, without polling.
  clearInterval(channel.personMemory.timer); clearTimeout(channel.personMemory.wakeTimer);
  channel.personMemory.wake = () => {}; channel.personMemory.nextScanAt = Infinity; channel.personMemory.lastAccountId = account.id;
  const service = createPluginService({ ctx: { llm: { listProviders: () => [], listModels: () => [] } }, root, store, worker, runner, channel });
  const rpc = rpcHandler(service), person = personId => ({ accountId: account.id, personId });
  const append = (text, { to = privateChat, id = 'alice', name = '阿宁', time = now, direction = 'incoming' } = {}) => {
    const entry = { key: 'person-message-' + ++serial, messageId: 'message-' + serial, text, direction, senderId: id, senderName: name, time };
    channel.memory.append(to, entry); return entry;
  };
  const run = async () => { channel.personMemory.tick(); await channel.personMemory.whenIdle(); };
  const configure = settings => channel.personMemory.configure({ ...store.roleCardSettings(), ...settings }, store.roleCardSettingsView().revision);
  t.after(async () => {
    await channel.close(); await service.drain();
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(base));
    assert(path.basename(resolved).startsWith('person-card-')); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, channel, runner, worker, account, group, privateChat, person, append, run, configure, state, sent, calls, background, rpc,
    now: () => now, advance: ms => { now += ms; } };
}
const proposal = (field, value, source) => ({ updates: [{ field, value, evidence: [{ sourceId: source.id, quote: source.text }] }], conflicts: [] });

test('observations and empty reviews retain sources without creating a card until person details exist', async t => {
  const f = fixture(t), person = f.person('alice');
  const first = f.append('你好，今天见到你很开心。');
  const paths = f.store.roleCards.paths(person);
  assert.equal(fs.existsSync(paths.file), false);
  assert.equal(fs.existsSync(paths.observationsFile), true);
  assert.equal(f.store.roleCards.list(f.account.id).length, 0);
  assert.equal(new StateStore(f.root).roleCards.list(f.account.id, { includePending: true })[0].pendingCount, 1);
  f.channel.personMemory.jobs.clear();
  f.configure({ messageThreshold: 1 }); await f.run();
  assert.equal(f.background.length, 1, 'settings changes rediscover source-only people');
  assert.equal(fs.existsSync(paths.file), false);
  assert.equal(f.store.roleCards.document(person).sources[0].messageKey, first.key);
  assert.equal(f.store.roleCards.list(f.account.id).length, 0);
  f.append('我喜欢红茶。');
  f.state.extract = async data => proposal('preferences', '喜欢红茶', data.sources[0]); await f.run();
  assert.equal(fs.existsSync(paths.file), true);
  assert.equal(fs.existsSync(paths.observationsFile), false);
  assert.equal(f.store.roleCards.list(f.account.id)[0].card.preferences, '喜欢红茶');
  assert.equal(f.store.roleCards.document(person).sources.length, 2);
});

test('names alone do not create cards and previously created empty cards are hidden without discarding records', async t => {
  const f = fixture(t), person = f.person('alice');
  f.append('普通招呼。');
  const named = f.store.roleCards.save(person, { ...emptyRoleCard(), label: '阿宁' }, 'empty', f.now());
  const paths = f.store.roleCards.paths(person);
  assert.equal(named.inherited, true);
  assert.equal(fs.existsSync(paths.file), false);
  assert.equal(f.store.roleCards.list(f.account.id).length, 0);
  const actual = f.store.roleCards.save(person, { ...named.card, preferences: '喜欢红茶' }, named.revision, f.now() + 1);
  assert.equal(f.store.roleCards.list(f.account.id).length, 1);
  f.store.roleCards.save(person, emptyRoleCard(), actual.revision, f.now() + 2);
  const bytes = fs.readFileSync(paths.file);
  assert.equal(f.store.roleCards.list(f.account.id).length, 0);
  assert.equal(f.store.roleCards.list(f.account.id, { includePending: true })[0].pendingCount, 1);
  assert.deepEqual(fs.readFileSync(paths.file), bytes, 'listing never deletes or rewrites older empty cards');
});

test('owner cards default to descending actual field counts rather than most recent update', async t => {
  const f = fixture(t);
  f.store.roleCards.save(f.person('alice'), { ...emptyRoleCard(), addressAs: '阿宁', preferences: '喜欢红茶', background: '学习计算机' }, 'empty', f.now() - 1000);
  f.store.roleCards.save(f.person('bob'), { ...emptyRoleCard(), preferences: '喜欢骑行' }, 'empty', f.now());
  const result = await f.rpc('memory.role.list', { accountId: f.account.id }, signal(), owner);
  assert(result.ok);
  assert.deepEqual(result.value.people.map(row => [row.personId, row.filledFields]), [['alice', 3], ['bob', 1]]);
});

test('ordinary observations default to 20 messages per person across conversations, with no time fallback', async t => {
  const f = fixture(t);
  assert.deepEqual(f.store.roleCardSettings(), DEFAULT_ROLE_CARD_SETTINGS);
  for (let index = 0; index < 19; index++) f.append('普通聊天 ' + index, { to: index % 2 ? f.group : f.privateChat });
  f.append('另一个人的日常发言', { to: f.group, id: 'bob' });
  f.append('助手自己的话', { direction: 'outgoing', id: f.account.id });
  await f.run(); f.advance(5000); await f.run(); f.advance(86400000); await f.run();
  assert.equal(f.background.length, 0);
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 19);
  assert.equal(f.channel.personMemory.state(f.store.roleCards.view(f.person('alice'))), 'collecting');
  f.append('第 20 条普通聊天', { to: f.group }); await f.run();
  assert.equal(f.background.length, 1);
  assert.equal(JSON.parse(f.background[0].text).sources.length, 20);
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 0);
  assert.equal(f.store.roleCards.view(f.person('bob')).pendingCount, 1);
  f.advance(3600000); await f.run(); assert.equal(f.background.length, 1);
});

test('time mode waits an hour from first new observation and skips every empty interval', async t => {
  const f = fixture(t); f.configure({ trigger: 'time' });
  f.advance(3600000); await f.run(); assert.equal(f.background.length, 0);
  f.append('第一条普通对话');
  f.advance(3000000);
  for (let index = 0; index < 20; index++) f.append('后来新增 ' + index, { to: f.group });
  await f.run(); assert.equal(f.background.length, 0, '20 messages do not bypass time mode');
  f.advance(599999); await f.run(); assert.equal(f.background.length, 0);
  f.advance(1); await f.run(); assert.equal(f.background.length, 1, 'new arrivals do not postpone the first deadline');
  for (let hour = 0; hour < 4; hour++) { f.advance(3600000); await f.run(); }
  assert.equal(f.background.length, 1);
  f.append('下一轮只有一条'); await f.run(); assert.equal(f.background.length, 1);
  f.advance(3600000); await f.run(); assert.equal(f.background.length, 2);
});

// Put native AbortSignal deadlines on the same clock as the maintenance timer,
// so the former conversation-timeout cap also fails these regressions.
function mockReviewTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    timer.unref?.();
    return controller.signal;
  });
}

test('person reviews default to an independent hour and can finish after the chat timeout', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.channel.timeoutMs = 60000;
  assert.equal(f.store.roleCardSettings().timeoutMinutes, 60);
  f.append('叫我阿宁。');
  f.state.extract = async data => { await gate.promise; return proposal('addressAs', '阿宁', data.sources[0]); };
  mockReviewTimers(t);
  try {
    f.channel.personMemory.tick();
    assert.equal(f.background.length, 1);
    t.mock.timers.tick(60001);
    assert.equal(f.background[0].signal.aborted, false, 'the chat deadline must not abort a person review');
    t.mock.timers.tick(3539998);
    assert.equal(f.background[0].signal.aborted, false, 'the review remains live until its own hour expires');
    gate.resolve(); await f.channel.personMemory.whenIdle();
    const view = f.store.roleCards.view(f.person('alice'));
    assert.equal(view.card.addressAs, '阿宁'); assert.equal(view.pendingCount, 0); assert.equal(view.error, null);
    t.mock.timers.tick(3600000);
    assert.equal(f.background[0].signal.aborted, false, 'a completed review releases its deadline');
    assert.equal(f.sent.length, 0);
  } finally {
    gate.resolve(); await f.channel.personMemory.whenIdle(); t.mock.timers.reset();
  }
});

test('a configured review timeout preserves the card and sources, rejects late output and permits retry', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.configure({ timeoutMinutes: 2 }); f.channel.timeoutMs = 10000;
  assert.equal(new StateStore(f.root).roleCardSettings().timeoutMinutes, 2);
  f.store.roleCards.save(f.person('alice'), { ...emptyRoleCard(), preferences: '喜欢红茶' }, 'empty', f.now() - 10);
  const entry = f.append('叫我阿宁。');
  f.state.extract = async data => { await gate.promise; return proposal('addressAs', '阿宁', data.sources[0]); };
  mockReviewTimers(t);
  try {
    f.channel.personMemory.tick();
    t.mock.timers.tick(119999); assert.equal(f.background[0].signal.aborted, false);
    t.mock.timers.tick(1); await f.channel.personMemory.whenIdle();
    assert.equal(f.background[0].signal.reason.code, 'ROLE_CARD_TIMEOUT');
    const failed = f.store.roleCards.view(f.person('alice'));
    assert.match(failed.error, /2 分钟/); assert.equal(failed.card.preferences, '喜欢红茶');
    assert.equal(failed.card.addressAs, ''); assert.equal(failed.pendingCount, 1);
    assert.equal(f.store.roleCards.document(f.person('alice')).pending[0].messageKey, entry.key);
    gate.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.store.roleCards.view(f.person('alice')).card.addressAs, '', 'late model output cannot write after timeout');
    f.state.extract = async data => proposal('addressAs', '阿宁', data.sources[0]);
    f.advance(15001); await f.run();
    const recovered = f.store.roleCards.view(f.person('alice'));
    assert.equal(recovered.card.addressAs, '阿宁'); assert.equal(recovered.card.preferences, '喜欢红茶');
    assert.equal(recovered.pendingCount, 0); assert.equal(recovered.error, null);
    assert.equal(f.channel.fault, null); assert.equal(f.sent.length, 0);
  } finally {
    gate.resolve(); await f.channel.personMemory.whenIdle(); t.mock.timers.reset();
  }
});

test('ordinary arrivals during a triggered batch start a fresh count, while large snapshots finish in batches', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.state.extract = async () => { await gate.promise; return { updates: [], conflicts: [] }; };
  for (let index = 0; index < 30; index++) f.append('触发前普通消息 ' + index);
  f.channel.personMemory.tick(); assert.equal(f.background.length, 1);
  f.advance(1000); f.append('模型执行中新增的一条');
  gate.resolve(); await f.channel.personMemory.whenIdle();
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 7);
  f.advance(1000); await f.run();
  assert.equal(f.background.length, 2);
  assert.equal(JSON.parse(f.background[1].text).sources.length, 6);
  f.advance(86400000); await f.run();
  assert.equal(f.background.length, 2);
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 1);
  for (let index = 0; index < 19; index++) f.append('下一轮累计 ' + index);
  await f.run(); assert.equal(f.background.length, 3);
  assert.equal(JSON.parse(f.background[2].text).sources.length, 20);
});

test('time mode starts the next deadline from messages received during an active review', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); f.configure({ trigger: 'time' });
  f.append('首轮对话'); f.advance(3600000);
  f.state.extract = async () => { await gate.promise; return { updates: [], conflicts: [] }; };
  f.channel.personMemory.tick(); f.advance(1000); f.append('整理时到达的新话');
  gate.resolve(); await f.channel.personMemory.whenIdle();
  f.advance(3599999); await f.run(); assert.equal(f.background.length, 1);
  f.advance(1); await f.run(); assert.equal(f.background.length, 2);
});

test('settings save is owner-only, available offline, validated, persistent and protected from stale revisions', async t => {
  const f = fixture(t); f.state.online = false; f.state.account = null;
  const initial = await f.rpc('memory.role.settings', {}, signal(), owner); assert(initial.ok);
  const settings = { ...initial.value.settings, enabled: false, trigger: 'time', messageThreshold: 35, intervalMinutes: 120 };
  const saved = await f.rpc('memory.role.configure', { settings, revision: initial.value.revision }, signal(), owner);
  assert(saved.ok); assert.deepEqual(saved.value.settings, settings);
  assert.deepEqual(new StateStore(f.root).roleCardSettings(), settings);
  const stale = await f.rpc('memory.role.configure', { settings: initial.value.settings, revision: initial.value.revision }, signal(), owner);
  assert.equal(stale.error.code, 'ROLE_CARD_SETTINGS_CHANGED');
  for (const invalid of [{ messageThreshold: 0 }, { messageThreshold: 513 }, { intervalMinutes: 0 },
    { intervalMinutes: 1.5 }, { timeoutMinutes: 0 }, { timeoutMinutes: 1441 }, { timeoutMinutes: 1.5 },
    { trigger: 'both' }, { enabled: 'yes' }, { unknown: true }]) {
    const result = await f.rpc('memory.role.configure', { settings: { ...settings, ...invalid }, revision: saved.value.revision }, signal(), owner);
    assert.equal(result.error.code, 'ROLE_CARD_SETTINGS_INVALID');
  }
  for (const endpoint of ['memory.role.settings', 'memory.role.configure'])
    assert.equal((await f.rpc(endpoint, {}, signal(), { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.deepEqual(f.store.roleCardSettings(), settings);
});

test('failed settings writes preserve the previous frequency and running background work', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.append('叫我阿宁。'); f.state.extract = async data => { await gate.promise; return proposal('addressAs', '阿宁', data.sources[0]); };
  f.channel.personMemory.tick();
  const original = f.store.save;
  f.store.save = () => { throw Error('simulated disk failure'); };
  assert.throws(() => f.configure({ enabled: false }), /simulated disk failure/);
  assert.equal(f.store.roleCardSettings().enabled, true);
  assert.equal(f.background[0].signal.aborted, false);
  f.store.save = original; gate.resolve(); await f.channel.personMemory.whenIdle();
  assert.equal(f.store.roleCards.view(f.person('alice')).card.addressAs, '阿宁');
});

test('disabling cancels automatic writes and corrections, keeps read access and chat, and allows owner refresh', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.store.roleCards.save(f.person('alice'), { ...emptyRoleCard(), preferences: '喜欢红茶' }, 'empty', f.now() - 10);
  f.append('叫我阿宁。');
  f.state.extract = async data => { await gate.promise; return proposal('addressAs', '阿宁', data.sources[0]); };
  f.channel.personMemory.tick();
  f.configure({ enabled: false });
  assert.equal(f.background[0].signal.aborted, true);
  gate.resolve(); await f.channel.personMemory.whenIdle();
  f.append('更正一下，叫我小宁。', { to: f.group }); f.advance(7200000); await f.run();
  assert.equal(f.background.length, 1);
  const view = f.store.roleCards.view(f.person('alice'));
  assert.equal(view.card.addressAs, ''); assert.equal(view.pendingCount, 2);
  assert.equal(f.channel.personMemory.state(view), 'disabled');
  const tool = personRoleCardTool(f.channel, { ...f.privateChat, senderId: 'alice' });
  assert.equal(JSON.parse(await tool.execute({ action: 'read' })).card.preferences, '喜欢红茶');
  await assert.rejects(tool.execute({ action: 'update' }), { code: 'ROLE_CARD_AUTO_DISABLED' });
  f.channel.receive({ id: 'chat-with-memory-disabled', direction: 'incoming', time: f.now() / 1000,
    chatType: 'private', peerId: 'alice', sender: { id: 'alice', nickname: '阿宁' }, message: [{ type: 'text', data: { text: '继续聊聊吧' } }] }, f.account.id);
  await f.channel.whenIdle(); assert.equal(f.sent.length, 1); assert.equal(f.channel.fault, null);
  f.state.extract = async data => proposal('addressAs', '小宁', data.sources.find(source => source.text.includes('更正')));
  const queued = await f.rpc('memory.role.refresh', f.person('alice'), signal(), owner); assert(queued.ok);
  await f.run(); assert.equal(f.store.roleCards.view(f.person('alice')).card.addressAs, '小宁');
  assert.equal(f.store.roleCardSettings().enabled, false);
});

test('changing frequency reschedules immediately, removes old fast deadlines, and never duplicates a batch', async t => {
  const f = fixture(t);
  for (let index = 0; index < 10; index++) f.append('常规聊天 ' + index);
  f.store.roleCards.mutate(f.person('alice'), doc => { delete doc.scheduleRevision; doc.nextAt = f.now() + 5000; });
  f.advance(5000); await f.run(); assert.equal(f.background.length, 0);
  f.configure({ trigger: 'time', intervalMinutes: 60 });
  f.advance(3600000); f.configure({ trigger: 'messages', messageThreshold: 20 });
  await f.run(); assert.equal(f.background.length, 0);
  f.configure({ messageThreshold: 10 }); await f.run(); await f.run();
  assert.equal(f.background.length, 1);
  f.configure({ trigger: 'time' }); f.advance(3600000); await f.run();
  assert.equal(f.background.length, 1);
});

test('restart and reconnection restore the persisted deadline without collecting duplicate observations', async t => {
  const f = fixture(t); f.configure({ trigger: 'time' });
  f.append('离线前的日常对话'); const deadline = f.store.roleCards.view(f.person('alice')).nextAt;
  await f.channel.close(); f.state.online = false; f.advance(1800000);
  const reopened = new StateStore(f.root), resumed = new WechatChannel({ store: reopened, runner: f.runner, transport: f.worker, now: f.now });
  try {
    resumed.personMemory.tick(); assert.equal(f.background.length, 0);
    f.state.online = true; resumed.personMemory.tick(); await resumed.personMemory.whenIdle();
    assert.equal(reopened.roleCards.view(f.person('alice')).nextAt, deadline);
    f.advance(1800000); resumed.personMemory.tick(); await resumed.personMemory.whenIdle();
    assert.equal(f.background.length, 1);
    assert.equal(JSON.parse(f.background[0].text).sources.length, 1);
  } finally { await resumed.close(); }
});

test('continued chat is rejected without losing evidence, then a later structured extraction can recover', async t => {
  const f = fixture(t);
  f.append('以后叫我主人。');
  f.append('那你也叫我一声，叫一声就行，以后除非我的要求，还是叫我主人。');
  f.runner.extractRoleCard = async input => {
    f.background.push(input);
    return { text: '爸爸。主人，以后我还是叫您主人。' };
  };
  await f.run();
  const failed = f.store.roleCards.view(f.person('alice'));
  assert.equal(failed.card.addressAs, '');
  assert.equal(failed.pendingCount, 2);
  assert(failed.error);
  assert.equal(f.channel.fault, null);
  assert.equal(f.sent.length, 0);
  f.runner.extractRoleCard = async input => {
    const data = JSON.parse(input.text);
    assert(data.task.includes('没有待回复'));
    assert(data.outputContract.includes('不回答或续写'));
    assert(input.text.indexOf(data.sources.at(-1).text) < input.text.indexOf('"outputContract"'));
    return { text: JSON.stringify(proposal('addressAs', '主人', data.sources.at(-1))) };
  };
  f.advance(15001); await f.run();
  const recovered = f.store.roleCards.view(f.person('alice'));
  assert.equal(recovered.card.addressAs, '主人');
  assert.equal(recovered.pendingCount, 0);
  assert.equal(recovered.error, null);
  assert.equal(recovered.card.relationship, '');
  assert.equal(f.sent.length, 0);
});

test('the background agent fills one shared person card from private and group chat, including group-only people', async t => {
  const f = fixture(t);
  f.append('叫我阿宁。', { to: f.group });
  f.append('我喜欢红茶。');
  f.append('叫我阿哲，我不吃香菜。', { to: f.group, id: 'bob', name: '阿哲' });
  f.state.extract = async data => data.person.personId === 'alice' ? { updates: [
    { field: 'addressAs', value: '阿宁', evidence: [{ sourceId: data.sources[0].id, quote: data.sources[0].text }] },
    { field: 'preferences', value: '喜欢红茶', evidence: [{ sourceId: data.sources[1].id, quote: data.sources[1].text }] },
  ], conflicts: [] } : proposal('dislikes', '不吃香菜', data.sources[0]);
  await f.run();
  const alice = f.store.roleCards.view(f.person('alice')), bob = f.store.roleCards.view(f.person('bob'));
  assert.equal(alice.card.addressAs, '阿宁'); assert.equal(alice.card.preferences, '喜欢红茶');
  assert.equal(f.store.roleCards.identity(f.privateChat), f.store.roleCards.identity({ ...f.group, senderId: 'alice' }));
  assert.equal(alice.encounters.length, 2); assert.equal(bob.encounters.length, 1);
  assert.equal(bob.card.dislikes, '不吃香菜'); assert.equal(f.store.roleCards.list(f.account.id).length, 2);
  assert.throws(() => f.store.roleCards.view(f.group), { code: 'ROLE_CARD_SCOPE' });
  assert.deepEqual(f.store.conversationPersona(f.account.id, 'private', 'alice'), f.store.persona());
  for (const request of f.background) { assert.equal(request.mode, 'role-memory'); assert.deepEqual(request.tools, []); }
  assert.deepEqual(new StateStore(f.root).roleCards.view(f.person('alice')), alice);
  const read = JSON.parse(await personRoleCardTool(f.channel, { ...f.privateChat, senderId: 'alice' }).execute({ action: 'read', personId: 'bob' }));
  assert.equal(read.card.dislikes, '不吃香菜');
});

test('periodic refresh runs without another message and explicit corrections replace old preferences automatically', async t => {
  const f = fixture(t);
  f.configure({ trigger: 'time' });
  f.append('我喜欢咖啡。');
  f.state.extract = async data => proposal('preferences', '喜欢咖啡', data.sources.at(-1));
  await f.run(); assert.equal(f.background.length, 0);
  f.advance(3600000); await f.run(); assert.equal(f.store.roleCards.view(f.person('alice')).card.preferences, '喜欢咖啡');
  f.advance(1000); f.append('我现在改喝红茶，不再喝咖啡。', { to: f.group });
  f.state.extract = async data => proposal('preferences', '现在喝红茶，不再喝咖啡', data.sources.at(-1));
  await f.run(); assert.equal(f.store.roleCards.view(f.person('alice')).card.preferences, '现在喝红茶，不再喝咖啡');
  f.advance(1000); f.append('我也喜欢散步。');
  await f.run(); assert.equal(f.background.length, 2);
  f.state.extract = async data => proposal('preferences', '现在喝红茶，不再喝咖啡；喜欢散步', data.sources.at(-1));
  f.advance(3600000); await f.run();
  assert.equal(f.background.length, 3);
  assert(f.store.roleCards.view(f.person('alice')).card.preferences.includes('散步'));
});

test('a slow background agent does not block chat, emit progress messages or abort on a new message', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.state.extract = async data => { await gate.promise; return proposal('addressAs', '阿宁', data.sources[0]); };
  f.append('叫我阿宁。', { to: f.group }); f.channel.personMemory.tick();
  assert.equal(f.channel.personMemory.active.size, 1);
  f.channel.receive({ id: 'live-chat', direction: 'incoming', time: f.now() / 1000, chatType: 'private', peerId: 'alice',
    sender: { id: 'alice', nickname: '阿宁' }, message: [{ type: 'text', data: { text: '今天天气真好' } }] }, f.account.id);
  await f.channel.whenIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.channel.personMemory.active.size, 1);
  assert.equal(f.background[0].signal.aborted, false);
  const tool = f.calls[0].tools.find(tool => tool.name === 'wechat_role_card');
  const queued = JSON.parse(await tool.execute({ action: 'update', reason: '称呼需要更新' }));
  assert.equal(queued.queued, true); assert.equal(f.sent.length, 1);
  gate.resolve(); await f.channel.personMemory.whenIdle();
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 1);
});

test('new observations during a person update are retained and the same person never has two concurrent writers', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.state.extract = async data => { await gate.promise; return proposal('addressAs', '阿宁', data.sources[0]); };
  f.append('叫我阿宁。'); f.channel.personMemory.tick();
  f.advance(1000); f.append('更正一下，叫我小宁。', { to: f.group }); f.channel.personMemory.tick();
  assert.equal(f.background.length, 1);
  gate.resolve(); await f.channel.personMemory.whenIdle();
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 1);
  f.state.extract = async data => proposal('addressAs', '小宁', data.sources[0]);
  f.advance(1000); await f.run();
  assert.equal(f.store.roleCards.view(f.person('alice')).card.addressAs, '小宁');
  assert.equal(f.store.roleCards.view(f.person('alice')).pendingCount, 0);
});

test('an owner correction during extraction wins, while failed revisions keep their sources for a later retry', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.state.extract = async data => { await gate.promise; return proposal('addressAs', '旧称呼', data.sources[0]); };
  f.append('叫我旧称呼。'); f.channel.personMemory.tick();
  f.advance(1000);
  f.store.roleCards.save(f.person('alice'), { ...emptyRoleCard(), addressAs: '管理员纠正' }, 'empty', f.now());
  gate.resolve(); await f.channel.personMemory.whenIdle();
  const saved = f.store.roleCards.view(f.person('alice'));
  assert.equal(saved.card.addressAs, '管理员纠正'); assert.equal(saved.pendingCount, 1); assert(saved.error);
  f.advance(1001); await f.run();
  assert.equal(f.store.roleCards.view(f.person('alice')).card.addressAs, '管理员纠正', 'older messages cannot undo a newer correction');
});

test('failure is isolated, retries are backed off, and a reopened queue retains its original sources', async t => {
  const f = fixture(t);
  f.state.extract = async () => { throw Error('model unavailable'); };
  f.append('叫我阿宁。'); await f.run();
  const doc = f.store.roleCards.document(f.person('alice'));
  assert.equal(doc.pending.length, 1); assert(doc.nextAt > f.now());
  assert.equal(f.channel.fault, null);
  assert.equal(new StateStore(f.root).roleCards.document(f.person('alice')).pending[0].text, '叫我阿宁。');
  await f.run(); assert.equal(f.background.length, 1);
  f.state.extract = async data => proposal('addressAs', '阿宁', data.sources[0]);
  f.advance(15001); await f.run();
  assert.equal(f.store.roleCards.view(f.person('alice')).error, null);
  assert.equal(f.store.roleCards.view(f.person('alice')).card.addressAs, '阿宁');
});

for (const change of ['account', 'authorization', 'clear', 'cancel']) test('in-flight profile results cannot survive changed ownership or sources: ' + change, async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.state.extract = async data => { await gate.promise; return proposal('addressAs', '阿宁', data.sources[0]); };
  f.append('叫我阿宁。'); f.channel.personMemory.tick();
  if (change === 'account') f.state.account = { id: 'another-account' };
  if (change === 'authorization') f.store.configure(f.account.id, { enabled: true, groups: [f.group.peerId], privatePeers: [], prompt: '' });
  if (change === 'clear') f.channel.memory.clear(f.privateChat);
  if (change === 'cancel') f.channel.personMemory.cancel(f.privateChat);
  gate.resolve(); await f.channel.personMemory.whenIdle();
  if (change === 'authorization') {
    await f.channel.authorization.whenIdle();
    assert.throws(() => f.store.roleCards.view(f.person('alice')), { code: 'OBJECT_NOT_AUTHORIZED' });
    assert.equal(fs.existsSync(f.store.roleCards.paths(f.person('alice')).observationsFile), false);
  } else assert.equal(f.store.roleCards.view(f.person('alice')).card.addressAs, '');
});

test('same-named members are distinct, unknown IDs cannot be invented, and card reads respect receive time', async t => {
  const f = fixture(t);
  f.append('叫我小林。', { to: f.group, id: 'alice', name: '小林' });
  f.append('叫我小林。', { to: f.group, id: 'bob', name: '小林' });
  f.state.extract = async data => proposal('addressAs', '小林', data.sources[0]); await f.run();
  const tool = personRoleCardTool(f.channel, { ...f.privateChat, senderId: 'alice' });
  const results = JSON.parse(await tool.execute({ action: 'search', query: '小林' }));
  assert.equal(results.people.length, 2); assert.notEqual(results.people[0].personId, results.people[1].personId);
  await assert.rejects(tool.execute({ action: 'read', personId: 'invented' }), { code: 'ROLE_CARD_PERSON_UNKNOWN' });
  await assert.rejects(tool.execute({ action: 'update', personId: f.group.peerId }), { code: 'ROLE_CARD_PERSON_UNKNOWN' });
  assert.equal(readableRoleCard(f.store.roleCards.view(f.person('alice')), f.now() - 1).card.addressAs, '');
  assert(!personRoleContext(f.channel, { ...f.privateChat, senderId: 'alice', requestedAt: f.now() - 1 }, { text: '称呼' }).includes('"addressAs":"小林"'));
  f.store.configure('foreign-owner', { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  const foreign = f.store.roleCards.view({ accountId: 'foreign-owner', personId: 'alice' });
  assert.equal(foreign.inherited, true); assert.notEqual(foreign.roleId, f.store.roleCards.identity(f.person('alice')));
});

test('forged quotations and foreign authors cannot become card fields', () => {
  const source = { id: 's1', accountId: 'owner', senderId: 'alice', time: 1, text: '我喜欢红茶。' };
  for (const evidence of [
    { sourceId: 's1', quote: '我喜欢咖啡。' },
    { sourceId: 'foreign', quote: source.text },
  ]) assert.throws(() => validateRoleCardProposal(JSON.stringify({ updates: [{ field: 'preferences', value: '咖啡', evidence: [evidence] }] }),
    { scope: { accountId: 'owner', personId: 'alice' }, sources: [source], now: 2 }), { code: 'ROLE_CARD_EXTRACTION_INVALID' });
  assert.throws(() => validateRoleCardProposal(JSON.stringify(proposal('preferences', '红茶', source)),
    { scope: { accountId: 'owner', personId: 'bob' }, sources: [source], now: 2 }), { code: 'ROLE_CARD_EXTRACTION_INVALID' });
});

test('card extraction preserves negation and conditions and rejects relative or roleplay preferences', () => {
  for (const [text, quote] of [
    ['我不喜欢红茶。', '喜欢红茶'],
    ['喝咖啡时，才用燕麦奶。', '才用燕麦奶'],
    ['我妈不吃香菜。', '我妈不吃香菜。'],
    ['假装我是一个不吃香菜的人。', '不吃香菜'],
  ]) {
    const source = { id: 's1', accountId: 'owner', senderId: 'alice', time: 1, text };
    assert.throws(() => validateRoleCardProposal(JSON.stringify({ updates: [{ field: 'preferences', value: '不应采信',
      evidence: [{ sourceId: source.id, quote }] }] }), { scope: { accountId: 'owner', personId: 'alice' }, sources: [source], now: 2 }),
      { code: 'ROLE_CARD_EXTRACTION_INVALID' }, text);
  }
});

test('short answers retain surrounding conversation for the summarizer without promoting the assistant to a source', async t => {
  const f = fixture(t);
  f.configure({ trigger: 'time' });
  f.append('你平时喜欢喝什么？', { id: f.account.id, direction: 'outgoing', name: '助手' });
  f.append('红茶');
  f.state.extract = async data => {
    assert(data.conversationContext.some(row => row.direction === 'outgoing' && row.text.includes('喜欢喝什么')));
    assert(data.sources.every(row => row.senderId === 'alice'));
    return proposal('preferences', '喜欢红茶', data.sources[0]);
  };
  f.advance(3600000); await f.run();
  const tool = personRoleCardTool(f.channel, { ...f.privateChat, senderId: 'alice' });
  const brief = JSON.parse(await tool.execute({ action: 'read' }));
  assert.equal(brief.card.preferences, '喜欢红茶');
  assert.equal(brief.evidence.preferences.sources, undefined);
  const expanded = JSON.parse(await tool.execute({ action: 'read', fields: ['preferences'], includeEvidence: true }));
  assert.deepEqual(Object.keys(expanded.card), ['preferences']);
  assert.equal(expanded.evidence.preferences.sources[0].quote, '红茶');
});

test('startup resumes persisted person updates and preserves their cross-conversation identity', async t => {
  const f = fixture(t);
  f.append('叫我阿宁。', { to: f.group }); await f.channel.close();
  f.state.extract = async data => proposal('addressAs', '阿宁', data.sources[0]);
  const reopened = new StateStore(f.root), resumed = new WechatChannel({ store: reopened, runner: f.runner, transport: f.worker, now: f.now });
  try {
    resumed.personMemory.tick(); await resumed.personMemory.whenIdle();
    assert.equal(reopened.roleCards.view(f.privateChat).card.addressAs, '阿宁');
    assert.equal(reopened.roleCards.identity(f.privateChat), f.store.roleCards.identity({ ...f.group, senderId: 'alice' }));
  } finally { await resumed.close(); }
});

test('unresolved conflicts suppress stale fields and the next supported correction resolves them', async t => {
  const f = fixture(t);
  f.append('叫我阿宁。'); f.state.extract = async data => proposal('addressAs', '阿宁', data.sources[0]); await f.run();
  f.advance(1000); f.append('称呼有点乱，先别这样叫。');
  f.state.extract = async data => ({ updates: [], conflicts: [{ field: 'addressAs', note: '尚不清楚希望使用的称呼',
    evidence: [{ sourceId: data.sources[0].id, quote: data.sources[0].text }] }] });
  await f.run();
  let view = readableRoleCard(f.store.roleCards.view(f.person('alice')));
  assert.equal(view.card.addressAs, ''); assert.equal(view.conflicts.length, 1);
  f.advance(1000); f.append('改叫我小宁。');
  f.state.extract = async data => proposal('addressAs', '小宁', data.sources[0]); await f.run();
  view = readableRoleCard(f.store.roleCards.view(f.person('alice')));
  assert.equal(view.card.addressAs, '小宁'); assert.equal(view.conflicts.length, 0);
});

test('the owner UI API lists group-only people after extracting actual data and refresh is a nonblocking queue operation', async t => {
  const f = fixture(t); f.append('叫我阿哲。', { to: f.group, id: 'bob', name: '阿哲' });
  const list = await f.rpc('memory.role.list', { accountId: f.account.id }, signal(), owner);
  assert(list.ok); assert.equal(list.value.people.length, 0);
  const view = await f.rpc('memory.role.get', f.person('bob'), signal(), owner);
  assert(view.ok); assert.equal(view.value.encounters[0].chatType, 'group');
  const queued = await f.rpc('memory.role.refresh', f.person('bob'), signal(), owner);
  assert(queued.ok); assert.equal(queued.value.queued, true); assert.equal(f.background.length, 0);
  f.state.extract = async data => proposal('addressAs', '阿哲', data.sources[0]); await f.run();
  const created = await f.rpc('memory.role.list', { accountId: f.account.id }, signal(), owner);
  assert(created.ok); assert.equal(created.value.people[0].personId, 'bob');
  assert.equal((await f.rpc('memory.role.refresh', f.person('bob'), signal(), { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
});

test('generated Moments comments can read the same role card without requiring a private conversation', async t => {
  const f = fixture(t);
  f.append('叫我阿哲，我喜欢骑行。', { to: f.group, id: 'bob', name: '阿哲' });
  f.state.extract = async data => proposal('preferences', '喜欢骑行', data.sources[0]); await f.run();
  f.runner.run = async input => {
    assert.equal(input.mode, 'moments-interaction');
    const tool = input.tools.find(tool => tool.name === 'wechat_role_card');
    const read = JSON.parse(await tool.execute({ action: 'read', personId: 'bob' }));
    assert.equal(read.card.preferences, '喜欢骑行');
    assert.equal(JSON.parse(input.text).posts[0].authorId, 'bob');
    return { text: JSON.stringify({ comments: [{ postId: '123', text: '这条骑行路线真舒服。', skipReason: '' }] }) };
  };
  const result = await generateInteractionComments(f.channel, [{ postId: '123', userId: 'bob', nickname: '阿哲', text: '周末骑行', imageCount: 0 }],
    '', signal(), () => {}, f.account.id);
  assert.equal(result.get('123').text, '这条骑行路线真舒服。');
  assert.equal(f.sent.length, 0);
});

test('private legacy cards migrate without rewriting the original and group legacy cards never become a person', async t => {
  const f = fixture(t), hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const writeLegacy = (scope, card) => {
    const roleId = 'role-' + hash([scope.accountId, scope.chatType, scope.peerId]);
    const file = path.join(f.root, 'storage/memory/role-cards', hash([scope.accountId]), roleId, 'card.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, ownerStoreId: f.store.data.storeId, scope, roleId, card, updatedAt: f.now() }));
    return file;
  };
  const file = writeLegacy(f.privateChat, { label: '旧标签', addressAs: '阿宁', relationship: '', style: '自然' });
  writeLegacy(f.group, { label: '群角色', addressAs: '全员同一称呼', relationship: '', style: '' });
  const bytes = fs.readFileSync(file), before = f.store.roleCards.view(f.person('alice'));
  assert.equal(before.card.addressAs, '阿宁'); assert(before.migratedFrom);
  f.append('叫我阿哲。', { to: f.group, id: 'bob', name: '阿哲' });
  assert.equal(f.store.roleCards.view(f.person('bob')).card.addressAs, '');
  assert.deepEqual(fs.readFileSync(file), bytes);
});
