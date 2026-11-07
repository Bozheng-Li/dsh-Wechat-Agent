import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, WechatChannel, TaskScheduler, createPluginService, rpcHandler } from '../lib/testing.js';
import { scopeKey } from '../src/features/workbench/store.mjs';

const base = path.resolve('storage/tmp'), accountId = 'deletion-fixture-owner';
const group = { accountId, chatType: 'group', peerId: 'deletion-a@chatroom' }, other = { ...group, peerId: 'deletion-b@chatroom' };
const signal = () => new AbortController().signal;
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'workbench-deletion-')), store = new StateStore(root), sends = [], extraChannels = [], clock = { value: Date.now() };
  store.configure(accountId, { enabled: true, groups: [group.peerId, other.peerId], privatePeers: ['alice'], prompt: '' });
  store.configure('deletion-other-owner', { enabled: true, groups: [group.peerId], privatePeers: [], prompt: '' });
  store.rememberConversationNames(accountId, { groups: [{ id: group.peerId, name: '删除测试 A' }, { id: other.peerId, name: '删除测试 B' }], privatePeers: [{ id: 'alice', name: '阿禾' }] });
  const transport = { status: () => ({ account: { id: accountId }, online: true, good: true }), send: async input => { sends.push(input); return { delivery: 'server-ack', serverMessageIds: ['deletion-ack-' + sends.length] }; } };
  const runner = { run: async () => ({ text: '合成回复' }) }, channel = new WechatChannel({ store, runner, transport, now: () => clock.value });
  channel.maintainMemory = () => {};
  const scheduler = new TaskScheduler({ store, channel }); channel.scheduler = scheduler;
  const service = createPluginService({ store, root, channel, runner, worker: transport, scheduler, ctx: {} }), workbench = channel.workbench;
  let sequence = 0;
  const add = (patch = {}, scope = group) => {
    const key = 'deletion-source-' + ++sequence;
    const record = { ...scope, key, contextKey: key, messageId: key, senderId: 'alice', sender: '阿禾', state: 'failed', question: '合成问题 ' + sequence, replyDraft: '保留的合成回复 ' + sequence, createdAt: clock.value + sequence, updatedAt: clock.value + sequence, ...patch };
    store.add(record); return record;
  };
  const list = () => workbench.recoveryList(accountId);
  const prepare = record => workbench.prepare({ ...record, recordKey: record.key, revision: list().records.find(row => row.key === record.key && row.peerId === record.peerId).revision, mode: 'text' }, signal());
  const remove = row => workbench.call('recovery.delete', { accountId, confirmDelete: true, revision: list().revision, records: [{ recordKey: row.key, chatType: row.chatType, peerId: row.peerId, revision: row.revision }] }, signal());
  t.after(async () => {
    for (const extra of extraChannels) { await extra.close(); extra.library.close(); }
    await scheduler.close(); await channel.close(); channel.library.close();
    const resolved = fs.realpathSync(root), parent = fs.realpathSync(base);
    assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('workbench-deletion-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return { root, store, sends, extraChannels, clock, transport, runner, channel, scheduler, service, workbench, add, list, prepare, remove, memory: channel.longMemory };
}
async function seedFact(f, scope, key, text, replaces = [], expiresAt = null) {
  f.memory.capture(scope, [{ key, text, direction: 'incoming', senderId: 'alice', senderName: '阿禾', time: f.clock.value }]);
  await f.memory.extract(scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text, sources: ['s1'], replaces, expiresAt }] }) }) }, signal());
  return f.memory.view(scope.accountId).sections.find(section => section.peerId === scope.peerId && section.chatType === scope.chatType).facts.at(-1);
}
const factInput = (memory, ids) => ({ factIds: ids, revision: memory.view(accountId).revision, confirmDelete: true });

test('recovery deletion removes the selected entry and its drafts, preserves archives, and scopes identical keys to their room', async t => {
  const f = fixture(t), original = f.add({ key: 'shared-record-key' }), otherRecord = f.add({ key: original.key }, other);
  await f.prepare(original); await f.prepare(otherRecord);
  const archives = structuredClone([...f.store.views.values()].map(view => view.records));
  const result = await f.remove(f.list().records.find(row => row.peerId === group.peerId));
  assert.equal(result.deletedRecords, 1); assert.equal(result.deletedDrafts, 1);
  assert.deepEqual(result.records.map(row => row.peerId), [other.peerId]); assert.equal(result.drafts[0].peerId, other.peerId);
  assert.deepEqual([...f.store.views.values()].map(view => view.records), archives);
  const reopened = new StateStore(f.root);
  assert.equal(reopened.views.get(scopeKey(group)).records[0].key, original.key);
  assert.equal(reopened.views.get(scopeKey(group)).records[0].state, 'failed');
  await assert.rejects(f.workbench.prepare({ ...group, recordKey: original.key, revision: 'old', mode: 'text' }, signal()), { code: 'RECOVERY_DELETED' });
  assert.equal(f.sends.length, 0);
});

test('clearing a recovery category covers every matching record beyond the displayed hundred', async t => {
  const f = fixture(t);
  for (let i = 0; i < 125; i++) f.add();
  for (let i = 0; i < 4; i++) f.add({ state: 'unknown' }, other);
  const view = f.list(); assert.equal(view.records.length, 100); assert.equal(view.counts.failed, 125);
  const result = await f.workbench.call('recovery.delete', { accountId, confirmDelete: true, revision: view.revision, recordFilter: 'failed', recordsRevision: view.recordsRevision }, signal());
  assert.equal(result.deletedRecords, 125); assert.equal(result.counts.all, 4); assert(result.records.every(row => row.state === 'unknown'));
  assert.equal(f.store.views.get(scopeKey(group)).records.length, 125);
  assert.equal(f.workbench.disk.load('deletion-other-owner').revision, 0);
  assert.equal(new StateStore(f.root).views.get(scopeKey(group)).records.length, 125);
});

test('history cleanup covers all drafts beyond the displayed fifty while keeping original recovery entries', async t => {
  const f = fixture(t), original = f.add();
  for (let i = 0; i < 70; i++) await f.prepare(original);
  const view = f.list(); assert.equal(view.drafts.length, 50); assert.equal(view.draftCount, 70);
  const result = await f.workbench.call('recovery.delete', { accountId, confirmDelete: true, revision: view.revision, clearDrafts: true, draftsRevision: view.draftsRevision }, signal());
  assert.equal(result.deletedDrafts, 70); assert.equal(result.draftCount, 0); assert.equal(result.records.length, 1);
  assert.equal(f.workbench.disk.load(accountId).recovery.length, 0);
});

test('recovery deletion rejects absent confirmation, stale snapshots, duplicates and cross-account requests without partial changes', async t => {
  const f = fixture(t), original = f.add(), row = f.list().records[0], draft = await f.prepare(original), view = f.list();
  const record = { recordKey: row.key, chatType: row.chatType, peerId: row.peerId, revision: row.revision };
  const input = { accountId, revision: view.revision, records: [record], confirmDelete: true };
  await assert.rejects(f.workbench.call('recovery.delete', { ...input, confirmDelete: false }, signal()), { code: 'RECOVERY_CONFIRM_REQUIRED' });
  await assert.rejects(f.workbench.call('recovery.delete', { ...input, accountId: 'deletion-other-owner' }, signal()), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(f.workbench.call('recovery.delete', { ...input, records: [record, record] }, signal()), { code: 'INVALID_INPUT' });
  await assert.rejects(f.workbench.call('recovery.delete', { ...input, records: [record, { ...record, recordKey: 'absent' }] }, signal()), { code: 'RECOVERY_CHANGED' });
  await assert.rejects(f.workbench.call('recovery.delete', { ...input, records: [{ ...record, peerId: other.peerId }] }, signal()), { code: 'RECOVERY_CHANGED' });
  f.add({ state: 'unknown' });
  await assert.rejects(f.workbench.call('recovery.delete', { accountId, confirmDelete: true, revision: view.revision, recordFilter: 'all', recordsRevision: view.recordsRevision }, signal()), { code: 'RECOVERY_CHANGED' });
  await f.prepare(original);
  await assert.rejects(f.workbench.call('recovery.delete', { ...input }, signal()), { code: 'WORKBENCH_CHANGED' });
  const latest = f.list();
  await assert.rejects(f.workbench.call('recovery.delete', { accountId, revision: latest.revision, confirmDelete: true, draftIds: [draft.id], draftRevisions: { [draft.id]: 'stale' } }, signal()), { code: 'RECOVERY_CHANGED' });
  assert.equal(f.list().records.length, 2); assert.equal(f.list().draftCount, 2);
});

test('deletion is blocked while awaiting an ACK; clearing sent history cannot bypass persisted deduplication', async t => {
  const f = fixture(t), original = f.add(), draft = await f.prepare(original), ready = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  f.transport.send = async input => { f.sends.push(input); ready.resolve(); await finish.promise; return { delivery: 'server-ack', serverMessageIds: ['retained-real-fixture-ack'] }; };
  const job = f.workbench.call('recovery.send', { accountId, draftId: draft.id, confirmSend: true }, signal()); await ready.promise;
  let view = f.list(); assert(view.records[0].busy); assert(view.drafts[0].busy);
  await assert.rejects(f.remove(view.records[0]), { code: 'RECOVERY_BUSY' });
  await assert.rejects(f.workbench.call('recovery.delete', { accountId, revision: view.revision, confirmDelete: true, draftIds: [draft.id], draftRevisions: { [draft.id]: view.drafts[0].revision } }, signal()), { code: 'RECOVERY_BUSY' });
  finish.resolve(); assert.equal((await job).state, 'sent'); view = f.list();
  await f.workbench.call('recovery.delete', { accountId, revision: view.revision, confirmDelete: true, draftIds: [draft.id], draftRevisions: { [draft.id]: view.drafts[0].revision } }, signal());
  const archived = new StateStore(f.root).views.get(scopeKey(group)).records.find(record => record.key === 'recovery:' + draft.id);
  assert.equal(archived.state, 'sent'); assert.deepEqual(archived.acknowledgedMessageIds, ['retained-real-fixture-ack']);
  const next = await f.prepare(original);
  await assert.rejects(f.workbench.call('recovery.send', { accountId, draftId: next.id, confirmSend: true }, signal()), { code: 'RECOVERY_ALREADY_ATTEMPTED' });
  assert.equal(f.sends.length, 1);
});

test('a stopped submission without a queued record is displayed as interrupted and can be cleaned up', async t => {
  const f = fixture(t), original = f.add(), draft = await f.prepare(original), data = f.workbench.disk.load(accountId);
  data.recovery.find(item => item.id === draft.id).state = 'submitting'; f.workbench.disk.save(data);
  const view = f.list(); assert.equal(view.drafts[0].state, 'interrupted'); assert.equal(view.drafts[0].busy, false);
  await f.workbench.call('recovery.delete', { accountId, revision: view.revision, confirmDelete: true, draftIds: [draft.id], draftRevisions: { [draft.id]: view.drafts[0].revision } }, signal());
  assert.equal(f.list().draftCount, 0); assert.equal(f.sends.length, 0);
});

test('recovery write failure leaves the durable list, drafts and deletion markers unchanged', async t => {
  const f = fixture(t), original = f.add(); await f.prepare(original);
  const file = f.workbench.disk.path(accountId), bytes = fs.readFileSync(file), rename = fs.renameSync.bind(fs);
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === file) throw Object.assign(new Error('fixture write failure'), { code: 'EPERM' }); return rename(from, to); });
  await assert.rejects(f.remove(f.list().records[0]), { code: 'WORKBENCH_WRITE_FAILED' }); mock.mock.restore();
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(f.list().records.length, 1); assert.equal(f.list().draftCount, 1);
});

test('deleting a source during regeneration prevents a late draft from reviving it', async t => {
  const f = fixture(t), original = f.add(), row = f.list().records[0], reached = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  f.runner.run = async () => { reached.resolve(); await finish.promise; return { text: '迟到的合成回复' }; };
  const job = f.workbench.prepare({ ...group, recordKey: original.key, revision: row.revision, mode: 'regenerate' }, signal()); await reached.promise;
  await f.remove(row); finish.resolve(); await assert.rejects(job, { code: 'RECOVERY_DELETED' });
  assert.equal(f.list().counts.all, 0); assert.equal(f.list().draftCount, 0); assert.equal(f.sends.length, 0);
});

test('fact deletion updates the authoritative memory, retains notes and other scopes, and blocks old-source refill across restart', async t => {
  const f = fixture(t), first = await seedFact(f, group, 'tea-source', '阿禾喜欢茶。'), second = await seedFact(f, other, 'book-source', '阿禾在书店工作。');
  await seedFact(f, { ...group, accountId: 'deletion-other-owner' }, 'another-owner-source', '其他账号的事实。');
  const before = f.memory.view(accountId), notes = '共同约定：默认使用中文。';
  f.memory.edit(accountId, before.markdown.slice(0, before.globalRange.start) + '\n' + notes + '\n' + before.markdown.slice(before.globalRange.end), before.revision);
  const deleted = await f.workbench.call('memory.fact.delete', { accountId, ...factInput(f.memory, [first.id]) }, signal());
  assert.equal(deleted.deletedFacts, 1); assert(deleted.globalNotes.includes(notes)); assert.equal(deleted.sections.flatMap(section => section.facts).length, 1);
  assert.equal(deleted.sections.flatMap(section => section.facts)[0].id, second.id); assert(!f.memory.prompt(group).includes('喜欢茶'));
  assert(f.memory.prompt(other).includes('书店工作')); assert(f.memory.view('deletion-other-owner').markdown.includes('其他账号的事实'));
  const archive = path.join(path.dirname(deleted.path), 'global-memory-archive');
  assert(fs.readdirSync(archive).some(name => fs.readFileSync(path.join(archive, name), 'utf8').includes('阿禾喜欢茶。')));
  const reloadedStore = new StateStore(f.root), freshChannel = new WechatChannel({ store: reloadedStore, runner: f.runner, transport: f.transport, now: () => f.clock.value });
  f.extraChannels.push(freshChannel);
  assert(!freshChannel.longMemory.prompt(group).includes('喜欢茶'));
  assert.equal(freshChannel.longMemory.capture(group, [{ key: 'tea-source', text: '阿禾喜欢茶。', direction: 'incoming', senderId: 'alice' }]).captured, false);
});

test('removing a disputed old fact clears its reference while keeping the new candidate pending', async t => {
  const f = fixture(t), old = await seedFact(f, group, 'old-budget', '阿禾预算为 800 元。'), pending = await seedFact(f, group, 'new-budget', '阿禾预算为 980 元。', [old.id]);
  const result = f.memory.deleteFacts(accountId, factInput(f.memory, [old.id])), retained = result.sections[0].facts[0];
  assert.equal(retained.id, pending.id); assert.equal(retained.state, 'pending'); assert.deepEqual(retained.replaces, []);
  assert(!f.memory.prompt(group).includes('980 元')); assert.equal(result.factCount, 0);
  f.memory.resolveFact(accountId, { factId: pending.id, revision: result.revision, decision: 'accept' });
  assert(f.memory.prompt(group).includes('980 元'));
});

test('one confirmed memory deletion removes active, pending, expired and historical facts including their generated history notes', async t => {
  const f = fixture(t), old = await seedFact(f, group, 'historical-old', '阿禾住在城北。');
  const replacement = await seedFact(f, group, 'historical-new', '阿禾住在城南。', [old.id]);
  f.memory.resolveFact(accountId, { factId: replacement.id, revision: f.memory.view(accountId).revision, decision: 'accept' });
  await seedFact(f, group, 'active-source', '阿禾喜欢猫。');
  await seedFact(f, group, 'expired-source', '周六去书店。', [], f.clock.value + 60000);
  await seedFact(f, group, 'pending-again', '阿禾住在城东。', [replacement.id]);
  f.clock.value += 61000;
  const before = f.memory.view(accountId), facts = before.sections[0].facts;
  assert(facts.some(fact => fact.state === 'superseded')); assert(facts.some(fact => fact.state === 'pending')); assert.equal(before.expiredFactsCount, 1);
  const result = f.memory.deleteFacts(accountId, factInput(f.memory, facts.map(fact => fact.id)));
  assert.equal(result.deletedFacts, 5); assert.equal(result.sections[0].facts.length, 0); assert(!result.markdown.includes('此条已被后续更正'));
});

test('memory deletion rejects stale, duplicate and missing targets, and a replacement write failure preserves the original Markdown', async t => {
  const f = fixture(t), fact = await seedFact(f, group, 'fail-source', '阿禾喜欢咖啡。'), before = f.memory.view(accountId), bytes = fs.readFileSync(before.path);
  assert.throws(() => f.memory.deleteFacts(accountId, { ...factInput(f.memory, [fact.id]), confirmDelete: false }), { code: 'LONG_MEMORY_CONFIRM_REQUIRED' });
  assert.throws(() => f.memory.deleteFacts(accountId, { ...factInput(f.memory, [fact.id]), revision: 'stale' }), { code: 'LONG_MEMORY_CHANGED' });
  assert.throws(() => f.memory.deleteFacts(accountId, factInput(f.memory, [fact.id, fact.id])), { code: 'LONG_MEMORY_NOT_FOUND' });
  assert.throws(() => f.memory.deleteFacts(accountId, factInput(f.memory, [fact.id, 'absent'])), { code: 'LONG_MEMORY_NOT_FOUND' });
  const rename = fs.renameSync.bind(fs), mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === before.path) throw new Error('fixture Markdown replacement failure'); return rename(from, to); });
  assert.throws(() => f.memory.deleteFacts(accountId, factInput(f.memory, [fact.id])), { code: 'STATE_WRITE_FAILED' }); mock.mock.restore();
  assert.deepEqual(fs.readFileSync(before.path), bytes); assert(f.memory.prompt(group).includes('喜欢咖啡'));
});

test('a late extraction cannot restore a deleted fact or its source, while unrelated pending sources remain available', async t => {
  const f = fixture(t), old = await seedFact(f, group, 'concurrent-old', '阿禾喜欢猫。'), ready = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  f.memory.capture(group, [{ key: 'concurrent-old', text: '阿禾仍然喜欢猫。', direction: 'incoming', senderId: 'alice' }, { key: 'new-unrelated', text: '阿禾周五打球。', direction: 'incoming', senderId: 'alice' }]);
  const job = f.memory.extract(group, { run: async () => { ready.resolve(); await finish.promise; return { text: JSON.stringify({ facts: [{ text: '阿禾仍然喜欢猫。', sources: ['s1'], replaces: [] }] }) }; } }, signal());
  await ready.promise; f.memory.deleteFacts(accountId, factInput(f.memory, [old.id])); finish.resolve();
  await assert.rejects(job, { code: 'LONG_MEMORY_CHANGED' }); assert(!f.memory.prompt(group).includes('喜欢猫'));
  assert.equal(f.memory.view(accountId).pendingCount, 1);
  const pending = Object.values(f.memory.state(accountId).pending).flatMap(batch => batch.entries);
  assert.deepEqual(pending.map(entry => entry.key), ['new-unrelated']);
});

test('deletion and explicit natural resume RPCs remain restricted to the local owner', async t => {
  const f = fixture(t), rpc = rpcHandler(f.service);
  for (const endpoint of ['recovery.delete', 'memory.fact.delete', 'natural.resume']) {
    const result = await rpc(endpoint, { accountId }, signal(), { principal: { kind: 'peer' } });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'OWNER_REQUIRED');
  }
  assert.equal(f.sends.length, 0);
});
