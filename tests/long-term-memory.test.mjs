import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, ConversationMemory } from '../lib/testing.js';
import { LongTermMemory } from "../modules/memory/long-term/store.mjs";

const temp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const accountId = 'long_memory_owner', peerId = 'long-memory@chatroom';
const signal = () => new AbortController().signal;
const fact = (text, sources = ['s1'], replaces = []) => ({ text, sources, replaces });
const runner = facts => ({ run: async request => ({ text: JSON.stringify({ facts: typeof facts === 'function' ? facts(request) : facts }) }) });
const entry = (key, text, extra = {}) => ({ key, text, direction: 'incoming', senderId: 'alice', senderName: '阿禾', time: Date.now(), ...extra });

function fixture(t) {
  fs.mkdirSync(temp, { recursive: true }); const root = fs.mkdtempSync(path.join(temp, 'long-memory-'));
  const store = new StateStore(root);
  store.configure(accountId, { enabled: true, groups: [peerId, 'other@chatroom'], privatePeers: ['alice'], prompt: '' });
  store.configure('another_owner', { enabled: true, groups: [peerId], privatePeers: [], prompt: '' });
  store.rememberConversationNames(accountId, { groups: [{ id: peerId, name: '产品讨论组' }, { id: 'other@chatroom', name: '周末出游' }], privatePeers: [{ id: 'alice', name: '阿禾' }] });
  const local = new ConversationMemory(store); store.memory = local; local.onPressure = null;
  const memory = new LongTermMemory(store), scope = { accountId, chatType: 'group', peerId };
  t.after(() => {
    const resolved = fs.realpathSync(root), relative = path.relative(fs.realpathSync(temp), resolved);
    assert(relative.startsWith('long-memory-') && !relative.includes('..') && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, local, memory, scope };
}
function notes(memory, owner, value) {
  const doc = memory.view(owner);
  return memory.edit(owner, doc.markdown.slice(0, doc.globalRange.start) + '\n' + value + '\n' + doc.markdown.slice(doc.globalRange.end), doc.revision);
}

test('long-term source batches survive local compaction and the Markdown facts survive local clearing and restart', async t => {
  const f = fixture(t), original = entry('first-source', '我叫阿禾，长期住在海边，喜欢猫。' + '最近聊了很多日常。'.repeat(180));
  f.local.append(f.scope, original); f.memory.capture(f.scope, f.local.load(f.scope));
  f.local.setWindowChars(1000);
  await f.local.compact(f.scope, { summarize: async () => '最近谈了很多日常。' }, signal());
  assert(!f.local.view(f.scope).text.includes('长期住在海边'));
  const result = await f.memory.extract(f.scope, runner(request => {
    assert(request.text.includes('长期住在海边')); return [fact('阿禾长期住在海边，喜欢猫。')];
  }), signal());
  assert.equal(result.added, 1); assert.equal(f.memory.view(accountId).pendingCount, 0);
  const doc = f.memory.view(accountId); assert.equal(path.basename(doc.path), 'global-memory.md');
  assert(fs.readFileSync(doc.path, 'utf8').includes('阿禾长期住在海边，喜欢猫。'));
  f.local.clear(f.scope);
  assert(new LongTermMemory(f.store).prompt(f.scope).includes('喜欢猫'));
});

test('automatic facts remain scoped to their account and conversation while owner notes apply across that account', async t => {
  const f = fixture(t), privateScope = { ...f.scope, chatType: 'private', peerId: 'alice' }, otherScope = { ...f.scope, peerId: 'other@chatroom' };
  notes(f.memory, accountId, '大家通用的约定：回复默认使用中文。');
  f.memory.capture(privateScope, [entry('private-source', '我在街角书店工作。')]);
  await f.memory.extract(privateScope, runner([fact('阿禾在街角书店工作。')]), signal());
  assert(f.memory.prompt(privateScope).includes('街角书店'));
  assert(!f.memory.prompt(otherScope).includes('街角书店'));
  assert(f.memory.prompt(otherScope).includes('回复默认使用中文'));
  assert(!f.memory.prompt({ ...f.scope, accountId: 'another_owner' }).includes('回复默认使用中文'));
  assert.notEqual(f.memory.view(accountId).path, f.memory.view('another_owner').path);
  assert.throws(() => f.memory.parse('another_owner', f.memory.view(accountId).markdown), { code: 'LONG_MEMORY_INVALID' });
});

test('Markdown remains authoritative after manual edits and stale UI revisions cannot overwrite newer content', async t => {
  const f = fixture(t); f.memory.capture(f.scope, [entry('cat-source', '我喜欢猫。')]);
  await f.memory.extract(f.scope, runner([fact('阿禾喜欢猫。')]), signal());
  const before = f.memory.view(accountId);
  fs.writeFileSync(before.path, before.markdown.replace('阿禾喜欢猫。', '阿禾更喜欢狗。'));
  const restored = new LongTermMemory(f.store);
  assert(restored.prompt(f.scope).includes('更喜欢狗') && !restored.prompt(f.scope).includes('喜欢猫'));
  assert.throws(() => restored.edit(accountId, before.markdown, before.revision), { code: 'LONG_MEMORY_CHANGED' });
  assert(restored.view(accountId).markdown.includes('更喜欢狗'));
});

test('manual edits during extraction retain the draft and pending source for a later retry', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers();
  f.memory.capture(f.scope, [entry('new-agreement', '以后每周五开会。')]);
  const pending = f.memory.extract(f.scope, { run: async () => { reached.resolve(); await gate.promise; return { text: JSON.stringify({ facts: [fact('本群以后每周五开会。')] }) }; } }, signal());
  await reached.promise;
  notes(f.memory, accountId, '管理员手写：不要替群友认关系。'); gate.resolve();
  await assert.rejects(pending, { code: 'LONG_MEMORY_CHANGED' });
  const beforeRetry = f.memory.view(accountId); assert.equal(beforeRetry.pendingCount, 1); assert.equal(beforeRetry.factCount, 0);
  assert.equal(beforeRetry.globalNotes, '管理员手写：不要替群友认关系。');
  await f.memory.extract(f.scope, runner([fact('本群以后每周五开会。')]), signal());
  assert(f.memory.prompt(f.scope).includes('每周五开会')); assert.equal(f.memory.view(accountId).pendingCount, 0);
});

test('clear and external deletion tombstone old local-window sources instead of resurrecting them', async t => {
  const f = fixture(t), old = entry('old-local-source', '我的老偏好是猫。');
  f.local.append(f.scope, old); f.memory.capture(f.scope, [old]);
  const gate = Promise.withResolvers(), reached = Promise.withResolvers();
  const pending = f.memory.extract(f.scope, { run: async () => { reached.resolve(); await gate.promise; return { text: JSON.stringify({ facts: [fact('阿禾喜欢猫。')] }) }; } }, signal());
  await reached.promise; f.memory.clear(accountId); gate.resolve(); await assert.rejects(pending, { code: 'LONG_MEMORY_CHANGED' });
  assert.equal(f.memory.capture(f.scope, f.local.load(f.scope)).pendingCount, 0);
  assert.equal(f.memory.capture(f.scope, [{ ...old, attachments: [{ type: 'image', description: '旧图中也是猫。' }] }]).pendingCount, 0);
  f.memory.capture(f.scope, [entry('after-clear', '现在我喜欢散步。')]);
  await f.memory.extract(f.scope, runner([fact('阿禾现在喜欢散步。')]), signal());
  assert(f.memory.prompt(f.scope).includes('喜欢散步') && !f.memory.prompt(f.scope).includes('喜欢猫'));
  const doc = f.memory.view(accountId); fs.unlinkSync(doc.path);
  assert.equal(f.memory.view(accountId).factCount, 0);
  assert.equal(f.memory.capture(f.scope, [old, entry('after-clear', '现在我喜欢散步。')]).pendingCount, 0);
  assert.equal(f.memory.capture(f.scope, [entry('after-deletion', '新信息从这里开始。')]).pendingCount, 1);
});

test('image descriptions recapture the same source key, while unchanged snapshots do not consume model requests', async t => {
  const f = fixture(t), picture = entry('same-picture', '[图片]', { attachments: [{ type: 'image', resourceId: 'fixture' }] });
  let requests = 0; const noFacts = { run: async () => { requests++; return { text: '{"facts":[]}' }; } };
  f.memory.capture(f.scope, [picture]); await f.memory.extract(f.scope, noFacts, signal());
  assert.equal(f.memory.capture(f.scope, [picture]).pendingCount, 0);
  const understood = { ...picture, attachments: [{ type: 'image', resourceId: 'fixture', description: '图片上写着：每周五十点产品例会。' }] };
  assert.equal(f.memory.capture(f.scope, [understood]).pendingCount, 1);
  await f.memory.extract(f.scope, runner(request => { requests++; assert(request.text.includes('每周五十点')); return [fact('本群图片中的长期约定是每周五十点产品例会。')]; }), signal());
  assert.equal(requests, 1); assert(f.memory.prompt(f.scope).includes('每周五十点'));
  assert.equal(f.memory.capture(f.scope, [understood]).pendingCount, 0);
});

test('failed or ungrounded extraction leaves durable source batches and reports no private backend details', async t => {
  const f = fixture(t); f.memory.capture(f.scope, [entry('preserved-source', '我长期在书店工作。')]);
  const before = f.memory.view(accountId).markdown;
  await assert.rejects(f.memory.extract(f.scope, { run: async () => { throw new Error('token=PRIVATE_SECRET'); } }, signal()));
  assert(!f.memory.view(accountId).error.includes('PRIVATE_SECRET'));
  assert.equal(new LongTermMemory(f.store).view(accountId).pendingCount, 1);
  await assert.rejects(f.memory.extract(f.scope, runner([fact('捏造的事实', ['s999'])]), signal()), { code: 'LONG_MEMORY_EXTRACTION_FAILED' });
  assert.equal(f.memory.view(accountId).markdown, before); assert.equal(f.memory.view(accountId).pendingCount, 1);
  await f.memory.extract(f.scope, runner([fact('阿禾长期在书店工作。')]), signal());
  assert.equal(f.memory.view(accountId).pendingCount, 0);
});

test('corrections preserve old facts in Markdown and remove them only from the current prompt', async t => {
  const f = fixture(t); notes(f.memory, accountId, '手动备注要原样保留。');
  f.memory.capture(f.scope, [entry('old-preference', '我喜欢猫。')]);
  await f.memory.extract(f.scope, runner([fact('阿禾喜欢猫。')]), signal());
  const old = f.memory.view(accountId).sections[0].facts[0];
  f.memory.capture(f.scope, [entry('new-preference', '更正一下，我现在更喜欢狗。')]);
  await f.memory.extract(f.scope, runner([fact('阿禾现在更喜欢狗。', ['s1'], [old.id])]), signal());
  const pending = f.memory.view(accountId), candidate = pending.sections[0].facts.find(value => value.state === 'pending');
  assert(candidate); assert.equal(pending.factCount, 0);
  assert(!f.memory.prompt(f.scope).includes('阿禾喜欢猫。') && !f.memory.prompt(f.scope).includes('更喜欢狗'));
  f.memory.resolveFact(accountId, { factId: candidate.id, revision: pending.revision, decision: 'accept' });
  const doc = f.memory.view(accountId);
  assert.equal(doc.globalNotes, '手动备注要原样保留。'); assert.equal(doc.factCount, 1);
  assert(doc.markdown.includes('阿禾喜欢猫。') && doc.markdown.includes('已被后续更正'));
  assert(!f.memory.prompt(f.scope).includes('阿禾喜欢猫。') && f.memory.prompt(f.scope).includes('更喜欢狗'));
  const current = doc.sections[0].facts.find(value => value.state === 'active');
  f.memory.edit(accountId, doc.markdown.slice(0, current.start) + doc.markdown.slice(current.end), doc.revision);
  assert.equal(f.memory.capture(f.scope, [entry('new-preference', '更正一下，我现在更喜欢狗。', { attachments: [{ type: 'image', description: '又补充了一张狗图。' }] })]).pendingCount, 0);
});

test('newly appended source data survives an extraction in progress, and cancellation yields without a persistent error', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), reached = Promise.withResolvers();
  let queued = 0; f.memory.onPending = () => queued++;
  const first = entry('concurrent-source', '我喜欢猫。'); f.memory.capture(f.scope, [first]);
  const pending = f.memory.extract(f.scope, { run: async () => { reached.resolve(); await gate.promise; return { text: '{"facts":[]}' }; } }, signal());
  await reached.promise;
  f.memory.capture(f.scope, [{ ...first, attachments: [{ type: 'image', description: '一张重要的补充图片。' }] }, entry('later-source', '每周五开会。')]);
  gate.resolve(); await pending;
  assert.equal(f.memory.view(accountId).pendingCount, 2); assert(queued >= 3);
  const controller = new AbortController(), started = Promise.withResolvers();
  const cancelling = f.memory.extract(f.scope, { run: async request => { started.resolve(); await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } }, controller.signal);
  await started.promise; controller.abort(); await assert.rejects(cancelling);
  assert.equal(f.memory.view(accountId).pendingCount, 2); assert.equal(f.memory.view(accountId).error, null);
});

test('malformed Markdown remains editable and does not discard pending sources or prevent ordinary conversation prompts', t => {
  const f = fixture(t), doc = f.memory.view(accountId);
  fs.writeFileSync(doc.path, doc.markdown.replace('wechat-global:end', 'broken-global:end'));
  f.memory.capture(f.scope, [entry('pending-while-broken', '记住周五开会。')]);
  const broken = f.memory.view(accountId); assert(broken.invalid && broken.error); assert.equal(broken.pendingCount, 1);
  assert.equal(f.memory.prompt(f.scope), '');
  f.memory.edit(accountId, doc.markdown, broken.revision);
  assert.equal(f.memory.view(accountId).invalid, false); assert.equal(f.memory.view(accountId).pendingCount, 1);
});
