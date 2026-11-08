import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, WechatChannel, TaskScheduler, createPluginService, rpcHandler, ChannelError, messageText } from '../lib/testing.js';

const base = path.resolve('storage/tmp'), signal = () => new AbortController().signal;
const accountId = 'workspace-owner', group = { accountId, chatType: 'group', peerId: 'workspace@chatroom' };
function fixture(t, prepare = () => {}) {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'workbench-test-'));
  prepare(root);
  const store = new StateStore(root), sends = [];
  store.configure(accountId, { enabled: true, groups: [group.peerId, 'other@chatroom'], privatePeers: [], prompt: '' });
  store.rememberConversationNames(accountId, { privatePeers: [], groups: [{ id: group.peerId, name: '项目组' }, { id: 'other@chatroom', name: '其他群' }] });
  let current = { account: { id: accountId }, online: true, good: true, runtimeReady: true, imageUploadReady: true };
  const transport = { status: () => current, send: async input => { sends.push(input); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sends.length] }; } };
  const runner = { selection: () => ({ provider: 'fixture', model: 'local' }), defaultSelection: () => ({ provider: 'fixture', model: 'local' }), run: async () => ({ text: 'OK' }), search: { status: () => ({ credentials: { tavily: true } }), forConfig: () => ({ search: async () => ({ sources: [{ url: 'https://example.org' }] }) }) } };
  const channel = new WechatChannel({ store, runner, transport }), scheduler = new TaskScheduler({ store, channel }); channel.scheduler = scheduler;
  const workbench = channel.workbench, service = createPluginService({ store, root, channel, runner, worker: transport, scheduler, ctx: {} });
  t.after(async () => { await scheduler.close(); await channel.close(); channel.library.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(base)); assert(path.basename(resolved).startsWith('workbench-test-')); fs.rmSync(resolved, { recursive: true }); });
  const addRecord = patch => { const key = 'failed:' + Math.random(), record = { ...group, key, contextKey: key, senderId: 'alice', sender: '阿禾', messageId: key, state: 'failed', question: '请回答产品价格', replyDraft: '产品为 120 元。', createdAt: Date.now(), updatedAt: Date.now(), ...patch }; store.add(record); return record; };
  return { root, store, transport, runner, channel, scheduler, workbench, service, sends, addRecord, switchAccount: value => { current = { ...current, account: { id: value } }; } };
}
test('recovery prepares without sending and explicit submission is idempotent after a server ACK', async t => {
  const f = fixture(t), original = f.addRecord(), view = f.workbench.recoveryList(accountId).records[0];
  const draft = await f.workbench.prepare({ ...group, recordKey: original.key, revision: view.revision, mode: 'text' }, signal()); assert.equal(f.sends.length, 0);
  await assert.rejects(f.workbench.sendDraft({ accountId, draftId: draft.id }, signal()), { code: 'RECOVERY_CONFIRM_REQUIRED' });
  const sent = await f.workbench.sendDraft({ accountId, draftId: draft.id, confirmSend: true }, signal()); assert.equal(sent.state, 'sent'); assert.equal(f.sends.length, 1); assert.equal(original.state, 'failed');
  const repeated = await f.workbench.sendDraft({ accountId, draftId: draft.id, confirmSend: true }, signal()); assert.equal(repeated.state, 'sent'); assert.equal(f.sends.length, 1);
  assert(f.store.history(accountId, group.chatType, group.peerId, 100).some(entry => entry.direction === 'outgoing' && entry.text === draft.text));
});

test('recovery blocks acknowledged types, ambiguous legacy partial delivery and unconfirmed unknowns', async t => {
  const f = fixture(t), check = (record, mode, confirmUnreceived = false) => {
    const view = f.workbench.recoveryList(accountId).records.find(value => value.key === record.key);
    return f.workbench.prepare({ ...group, recordKey: record.key, revision: view.revision, mode, confirmUnreceived }, signal());
  };
  await assert.rejects(check(f.addRecord({ state: 'unknown' }), 'text'), { code: 'RECOVERY_CONFIRM_REQUIRED' });
  await assert.rejects(check(f.addRecord({ state: 'partial', acknowledgedMessageIds: ['ack'] }), 'text', true), { code: 'RECOVERY_AMBIGUOUS' });
  await assert.rejects(check(f.addRecord({ state: 'partial' }), 'text', true), { code: 'RECOVERY_AMBIGUOUS' });
  await assert.rejects(check(f.addRecord({ state: 'partial', acknowledgedMessageIds: ['ack'], deliveryParts: [{ index: 0, type: 'text', state: 'acknowledged', serverMessageId: 'ack' }, { index: 1, type: 'image', state: 'unknown' }] }), 'text', true), { code: 'RECOVERY_ALREADY_SENT' });
  assert.equal(f.sends.length, 0);
});

test('recovery rechecks authorization and source revision at submission', async t => {
  const f = fixture(t), original = f.addRecord(), view = f.workbench.recoveryList(accountId).records[0];
  const draft = await f.workbench.prepare({ ...group, recordKey: original.key, revision: view.revision, mode: 'text' }, signal());
  f.store.configure(accountId, { enabled: false, groups: [], privatePeers: [], prompt: '' });
  await assert.rejects(f.workbench.sendDraft({ accountId, draftId: draft.id, confirmSend: true }, signal()), { code: 'CONVERSATION_NOT_AUTHORIZED' }); assert.equal(f.sends.length, 0);
});

test('owner can cancel while recovery waits for a transport ACK; a late genuine ACK remains recorded', async t => {
  const f = fixture(t), record = f.addRecord(), ready = Promise.withResolvers(), finish = Promise.withResolvers(); t.after(() => finish.resolve());
  f.transport.send = async () => { ready.resolve(); await finish.promise; return { delivery: 'server-ack', serverMessageIds: ['late-ack'] }; };
  const draft = await f.workbench.prepare({ ...group, recordKey: record.key, revision: f.workbench.recoveryList(accountId).records[0].revision, mode: 'text' }, signal());
  const pending = f.service.call('recovery.send', { accountId, draftId: draft.id, confirmSend: true }, signal()); await ready.promise;
  const cancellation = f.service.call('cancel', group, signal()); await new Promise(resolve => setTimeout(resolve, 20));
  assert(f.channel.active.controller.signal.aborted); finish.resolve(); const value = await pending; await cancellation; assert.equal(value.state, 'sent');
});

test('new workbench RPCs remain owner-only and cannot be invoked by ordinary peers', async t => {
  const f = fixture(t), rpc = rpcHandler(f.service);
  const result = await rpc('digest.list', { accountId }, signal(), { principal: { kind: 'peer' } }); assert.equal(result.ok, false); assert.equal(result.error.code, 'OWNER_REQUIRED');
  const read = await rpc('digest.list', { accountId }, signal(), { principal: { kind: 'owner' } }); assert.equal(read.ok, true);
});

test('retired document RPCs are unavailable even to the owner and do not create storage', async t => {
  const f = fixture(t), rpc = rpcHandler(f.service);
  for (const method of ['list', 'settings', 'index.rebuild', 'configure', 'delete', 'document', 'search', 'ask', 'upload.start', 'upload.chunk', 'upload.finish', 'upload.abort']) {
    const result = await rpc('knowledge.' + method, { accountId }, signal(), { principal: { kind: 'owner' } });
    assert.equal(result.ok, false, method);
    assert.equal(result.error.code, 'UNKNOWN_OPERATION', method);
  }
  assert.equal(Object.hasOwn(f.workbench, 'knowledge'), false);
  assert.equal(typeof f.workbench.answerKnowledge, 'undefined');
  assert.equal(fs.existsSync(path.join(f.root, 'storage/knowledge')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'storage/knowledge-index')), false);
  assert.equal(f.sends.length, 0);
});

test('retired commands do not bypass the normal group wake-up policy', () => {
  const message = { chatType: 'group', peerId: group.peerId, sender: { id: 'alice' } }, account = { id: accountId };
  for (const text of ['/kb 退款期限', '/知识库：退款期限']) {
    const result = messageText({ ...message, message: [{ type: 'text', data: { text } }] }, account);
    assert(result.reason, text);
    assert.equal(result.trigger, undefined);
    assert(!result.reason.includes('/kb'));
  }
  const result = messageText({ ...message, message: [{ type: 'text', data: { text: '/agent 你好' } }] }, account);
  assert.equal(result.text, '你好');
  assert.equal(result.trigger, 'command');
});

test('starting and diagnosing leaves former document files byte-for-byte intact', async t => {
  const legacy = { 'knowledge/legacy.json': Buffer.from([255, 254, 1]), 'knowledge/original.md': Buffer.from('original document'), 'knowledge-index/old.sqlite': Buffer.from('old index') };
  const f = fixture(t, root => {
    for (const [name, bytes] of Object.entries(legacy)) {
      const file = path.join(root, 'storage', name);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    }
  });
  const result = await f.workbench.diagnose(accountId, signal());
  assert.deepEqual(result.checks.map(check => check.id), ['wechat', 'model', 'search', 'image']);
  for (const [name, bytes] of Object.entries(legacy)) assert.deepEqual(fs.readFileSync(path.join(f.root, 'storage', name)), bytes);
  assert.equal(f.sends.length, 0);
});

test('saved diagnostics hide retired checks and require a fresh run without rewriting the old report', async t => {
  const f = fixture(t);
  await f.workbench.diagnose(accountId, signal());
  const data = f.workbench.disk.load(accountId);
  data.diagnostics.checks.push({ id: 'knowledge', title: 'former check', state: 'passed' });
  f.workbench.disk.save(data);
  const file = f.workbench.disk.path(accountId), before = fs.readFileSync(file);
  const result = f.workbench.diagnostics(accountId);
  assert.equal(result.stale, true);
  assert(!result.checks.some(check => check.id === 'knowledge'));
  assert.deepEqual(fs.readFileSync(file), before);
});

test('diagnostics distinguish disabled search, real model failure and image readiness without sending messages', async t => {
  const f = fixture(t); f.runner.run = async () => { throw Error('secret must never escape'); };
  const result = await f.workbench.diagnose(accountId, signal()); assert.equal(result.checks.find(row => row.id === 'model').state, 'failed'); assert(!JSON.stringify(result).includes('secret'));
  assert.equal(result.checks.find(row => row.id === 'search').state, 'disabled'); assert.equal(result.checks.find(row => row.id === 'image').state, 'ready'); assert.equal(result.checks.find(row => row.id === 'image').deliveryVerified, false); assert.equal(f.sends.length, 0);
});

test('group digest validates source IDs and never schedules an unconfirmed extracted todo', async t => {
  const f = fixture(t), now = Date.now(), message = { id: 'source-one', serverMessageId: 'source-one', chatType: 'group', peerId: group.peerId, sender: { id: 'alice', nickname: '阿禾' }, time: now / 1000, message: [{ type: 'text', data: { text: '周一我来整理产品 FAQ。' } }] };
  f.store.remember('digest-source', now, null, { accountId, message });
  f.runner.run = async () => ({ text: JSON.stringify({ title: '项目安排', conclusions: [], questions: [], todos: [{ text: '整理产品 FAQ', owner: '阿禾', sources: ['bad-id'] }] }) });
  await assert.rejects(f.workbench.generateDigest({ ...group, from: now - 10000, to: now + 1000 }, signal()), { code: 'DIGEST_SOURCE_INVALID' });
  assert.equal(f.workbench.listDigests(accountId).summaries.length, 0);
  f.runner.run = async () => ({ text: JSON.stringify({ title: '项目安排', conclusions: [], questions: [], todos: [{ text: '整理产品 FAQ', owner: '阿禾', sources: ['S1'] }] }) });
  const summary = await f.workbench.generateDigest({ ...group, from: now - 10000, to: now + 1000 }, signal()), todo = summary.todos[0]; assert.equal(f.scheduler.data.tasks.length, 0);
  await assert.rejects(f.workbench.todo({ accountId, summaryId: summary.id, todoId: todo.id, remind: true, at: now + 60000 }, signal()), { code: 'DIGEST_CONFIRM_REQUIRED' });
  await f.workbench.todo({ accountId, summaryId: summary.id, todoId: todo.id, state: 'confirmed' }, signal());
  await f.workbench.todo({ accountId, summaryId: summary.id, todoId: todo.id, remind: true, at: now + 60000 }, signal()); assert.equal(f.scheduler.data.tasks.length, 1); assert.equal(f.sends.length, 0);
  const view = f.workbench.listDigests(accountId);
  await assert.rejects(f.workbench.call('digest.delete', { accountId, summaryId: summary.id, revision: view.revision - 1 }, signal()), { code: 'WORKBENCH_CHANGED' });
  await f.workbench.call('digest.delete', { accountId, summaryId: summary.id, revision: view.revision }, signal());
  assert.equal(f.workbench.listDigests(accountId).summaries.length, 0); assert.equal(f.scheduler.data.tasks.length, 1, 'saved reminders outlive a deleted digest');
});

test('expired memory is excluded after restart, conflicts remain withheld until an explicit decision', async t => {
  const f = fixture(t), memory = f.channel.longMemory, time = Date.now(); let now = time; memory.now = () => now;
  memory.capture(group, [{ key: 'trip', text: '我今天在上海。', direction: 'incoming', senderId: 'alice', senderName: '阿禾', time }]);
  await memory.extract(group, { run: async () => ({ text: JSON.stringify({ facts: [{ text: '阿禾今天在上海。', sources: ['s1'], replaces: [], expiresAt: time + 60000 }] }) }) }, signal());
  assert(memory.prompt(group).includes('上海')); now += 61000; assert(!memory.prompt(group).includes('上海')); assert.equal(memory.view(accountId).expiredFactsCount, 1);
  const doc = memory.view(accountId), fact = doc.sections[0].facts[0]; memory.updateFact(accountId, { factId: fact.id, revision: doc.revision, expiresAt: null }); assert(memory.prompt(group).includes('上海'));
  assert.throws(() => memory.updateFact(accountId, { factId: fact.id, revision: doc.revision, expiresAt: null }), { code: 'LONG_MEMORY_CHANGED' });
});

test('diagnostics expire when connection, upload readiness, resolved model or search settings change', async t => {
  const f = fixture(t);
  await f.workbench.diagnose(accountId, signal()); assert.equal(f.workbench.diagnostics(accountId).stale, false);
  f.transport.status().online = false; assert.equal(f.workbench.diagnostics(accountId).stale, true);
  f.transport.status().online = true; assert.equal(f.workbench.diagnostics(accountId).stale, false);
  f.transport.status().imageUploadReady = false; assert.equal(f.workbench.diagnostics(accountId).stale, true);
  f.transport.status().imageUploadReady = true;
  f.runner.selection = () => ({ provider: 'fixture', model: 'another-default' }); assert.equal(f.workbench.diagnostics(accountId).stale, true);
  await f.workbench.diagnose(accountId, signal()); assert.equal(f.workbench.diagnostics(accountId).stale, false);
  f.runner.search.status = () => ({ credentials: { tavily: false } }); assert.equal(f.workbench.diagnostics(accountId).stale, true);
  f.runner.run = async () => { f.transport.status().good = false; return { text: 'OK' }; };
  await assert.rejects(f.workbench.diagnose(accountId, signal()), { code: 'DIAGNOSTICS_CHANGED' });
  assert.equal(f.sends.length, 0);
});

test('a rejected recovery queue preserves a retryable draft and never leaves a fictitious submitting state', async t => {
  const f = fixture(t), original = f.addRecord(), view = f.workbench.recoveryList(accountId).records[0];
  const draft = await f.workbench.prepare({ ...group, recordKey: original.key, revision: view.revision, mode: 'text' }, signal());
  const submit = f.channel.submitScheduled.bind(f.channel);
  f.channel.submitScheduled = async () => { throw new ChannelError('TASK_QUEUE_FULL', '队列已满'); };
  await assert.rejects(f.workbench.sendDraft({ accountId, draftId: draft.id, confirmSend: true }, signal()), { code: 'TASK_QUEUE_FULL' });
  assert.equal(f.workbench.recoveryList(accountId).drafts[0].state, 'draft'); assert.equal(f.sends.length, 0);
  f.channel.submitScheduled = submit;
  assert.equal((await f.workbench.sendDraft({ accountId, draftId: draft.id, confirmSend: true }, signal())).state, 'sent');
  assert.equal(f.sends.length, 1);
});

test('a todo reminder cannot duplicate after its task persisted but saving the summary reference failed', async t => {
  const f = fixture(t), data = f.workbench.disk.load(accountId), now = Date.now();
  data.summaries.push({ ...group, id: 'summary-id', title: '项目', todos: [{ id: 'todo-id', text: '整理 FAQ', state: 'confirmed', taskId: null }] }); f.workbench.disk.save(data);
  const save = f.workbench.disk.save.bind(f.workbench.disk); let first = true;
  f.workbench.disk.save = (...args) => { if (first) { first = false; throw new ChannelError('WORKBENCH_WRITE_FAILED', '模拟磁盘写入失败'); } return save(...args); };
  await assert.rejects(f.workbench.todo({ accountId, summaryId: 'summary-id', todoId: 'todo-id', remind: true, at: now + 60000 }, signal()), { code: 'WORKBENCH_WRITE_FAILED' });
  assert.equal(f.scheduler.data.tasks.length, 1);
  const result = await f.workbench.todo({ accountId, summaryId: 'summary-id', todoId: 'todo-id', remind: true, at: now + 120000 }, signal());
  assert.equal(f.scheduler.data.tasks.length, 1, 'changing the retry time must reconcile the existing task, not create another');
  assert.equal(result.todos[0].taskId, f.scheduler.data.tasks[0].id);
  assert.equal(result.todos[0].reminder.at, now + 60000, 'report the persisted time rather than the retry form time');
  f.scheduler.cancel(result.todos[0].taskId, group, true);
  assert.equal(f.workbench.listDigests(accountId).summaries[0].todos[0].reminder.state, 'cancelled');
  assert.equal(f.sends.length, 0);
});
