import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StateStore, WechatChannel, TaskScheduler, createPluginService, rpcHandler, ChannelError } from '../lib/testing.js';
import { KnowledgeLibrary, extractDocument } from '../src/features/knowledge/library.mjs';
import { WorkbenchStore, scopeKey } from '../src/features/workbench/store.mjs';

const base = path.resolve('storage/tmp'), signal = () => new AbortController().signal;
const accountId = 'workspace-owner', group = { accountId, chatType: 'group', peerId: 'workspace@chatroom' };
function fixture(t) {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'workbench-test-')), store = new StateStore(root), sends = [];
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
async function importText(library, id, text, name = '产品手册.md') {
  const bytes = Buffer.from(text), upload = library.begin(accountId, { libraryId: id, name, size: bytes.length });
  library.append(accountId, { uploadId: upload.uploadId, offset: 0, data: bytes.toString('base64') }); return library.finish(accountId, upload.uploadId, signal());
}
function collection(library) { library.configureSettings(accountId, { enabled: true, revision: library.list(accountId).revision }); return library.configure(accountId, { revision: library.list(accountId).revision, title: '产品资料', description: '权威产品说明', scopes: [scopeKey(group)], enabled: true }).libraries[0]; }

test('knowledge import is durable, deduplicated, scoped and revoked without leaking other account documents', async t => {
  const f = fixture(t), lib = f.workbench.knowledge, c = collection(lib);
  const imported = await importText(lib, c.id, '退款期限为七天。产品价格为 120 元。');
  assert((await importText(lib, c.id, '退款期限为七天。产品价格为 120 元。')).duplicate);
  assert.equal(lib.list(accountId).documents.length, 1);
  assert((await lib.search(accountId, { query: '退款期限', scope: group })).results[0].text.includes('七天'));
  assert(!(await lib.search(accountId, { query: '退款期限', scope: { ...group, peerId: 'other@chatroom' } })).found);
  lib.configureSettings('another-owner', { enabled: true, revision: 0 });
  assert(!(await lib.search('another-owner', { query: '退款期限' })).found);
  const reopened = new KnowledgeLibrary(new StateStore(f.root)); assert.equal(reopened.view(accountId, imported.document.id).title, '产品手册.md');
  lib.configure(accountId, { ...c, libraryId: c.id, enabled: false, revision: lib.list(accountId).revision });
  assert(!(await lib.search(accountId, { query: '退款期限', scope: group })).found);
  assert((await lib.search(accountId, { query: '退款期限', libraryId: c.id })).found);
  lib.remove(accountId, { documentId: imported.document.id, revision: lib.list(accountId).revision }); assert(!(await lib.search(accountId, { query: '退款期限' })).found);
});

test('knowledge rejects stale saves, wrong upload offsets, cross-account chunks and invalid UTF-8', async t => {
  const f = fixture(t), lib = f.workbench.knowledge, c = collection(lib), upload = lib.begin(accountId, { libraryId: c.id, name: '笔记.txt', size: 3 });
  assert.throws(() => lib.append(accountId, { uploadId: upload.uploadId, offset: 1, data: 'YWJj' }), { code: 'KNOWLEDGE_UPLOAD_INVALID' });
  assert.throws(() => lib.append('another-owner', { uploadId: upload.uploadId, offset: 0, data: 'YWJj' }), { code: 'KNOWLEDGE_UPLOAD_EXPIRED' });
  await assert.rejects(lib.finish(accountId, upload.uploadId, signal()), { code: 'KNOWLEDGE_UPLOAD_INCOMPLETE' });
  assert.throws(() => lib.configure(accountId, { ...c, libraryId: c.id, revision: 0 }), { code: 'WORKBENCH_CHANGED' });
  assert.throws(() => extractDocument('坏文件.txt', Buffer.from([255, 254]), signal()), { code: 'DOCUMENT_ENCODING' });
  assert.equal(lib.list(accountId).documents.length, 0);
});

test('a corrupt knowledge file stays intact instead of becoming an empty library', t => {
  const f = fixture(t), disk = new WorkbenchStore(f.store, 'knowledge'), file = disk.path(accountId), bytes = Buffer.from([255, 254, 1]); fs.writeFileSync(file, bytes);
  assert.throws(() => disk.load(accountId), { code: 'WORKBENCH_STORAGE_INVALID' }); assert.deepEqual(fs.readFileSync(file), bytes);
});

test('source deletion during knowledge answer generation discards the stale answer', async t => {
  const f = fixture(t), lib = f.workbench.knowledge, c = collection(lib), imported = await importText(lib, c.id, '退款期限七天。');
  const reached = Promise.withResolvers(), finish = Promise.withResolvers(); t.after(() => finish.resolve());
  f.runner.run = async () => { reached.resolve(); await finish.promise; return { text: '七天。' }; };
  const job = f.workbench.call('knowledge.ask', { accountId, query: '退款期限', libraryId: c.id }, signal()); await reached.promise;
  lib.remove(accountId, { documentId: imported.document.id, revision: lib.list(accountId).revision }); finish.resolve();
  await assert.rejects(job, { code: 'KNOWLEDGE_CHANGED' });
});

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
  const result = await rpc('knowledge.list', { accountId }, signal(), { principal: { kind: 'peer' } }); assert.equal(result.ok, false); assert.equal(result.error.code, 'OWNER_REQUIRED');
  const read = await rpc('knowledge.list', { accountId }, signal(), { principal: { kind: 'owner' } }); assert.equal(read.ok, true);
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

test('real PDF and DOCX imports preserve source text and reject encrypted, scanned, corrupt and oversized documents atomically', async t => {
  const f = fixture(t), lib = f.workbench.knowledge, c = collection(lib);
  const generated = spawnSync('python', ['-B', 'tests/fixtures/knowledge-documents.py'], { windowsHide: true, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  const samples = JSON.parse(generated.stdout);
  const upload = name => importText(lib, c.id, Buffer.from(samples[name], 'base64'), name);
  const pdf = await upload('guide.pdf'), docx = await upload('guide.docx');
  assert(lib.view(accountId, pdf.document.id).chunks.some(chunk => chunk.label === '第 1 页' && chunk.text.includes('within seven days')));
  assert(lib.view(accountId, docx.document.id).chunks.some(chunk => chunk.text.includes('退款期限为七天。松石三号。') && chunk.text.includes('价格\t120 元\n需要订单号。')));
  for (const name of ['scan.pdf', 'locked.pdf', 'many-pages.pdf', 'broken.pdf', 'entity.docx', 'archive-limit.docx', 'text-limit.docx', 'broken.docx']) {
    await assert.rejects(upload(name), error => error.code === 'DOCUMENT_READ_FAILED' && (name !== 'scan.pdf' || error.message.includes('OCR')) && (name !== 'locked.pdf' || error.message.includes('解密')), name);
    assert.equal(lib.list(accountId).documents.length, 2, name + ' must never enter the knowledge index');
  }
  const bytes = Buffer.from(samples['guide.pdf'], 'base64'), pending = lib.begin(accountId, { libraryId: c.id, name: 'cancelled.pdf', size: bytes.length });
  lib.append(accountId, { uploadId: pending.uploadId, offset: 0, data: bytes.toString('base64') });
  const controller = new AbortController(), job = lib.finish(accountId, pending.uploadId, controller.signal); controller.abort();
  await assert.rejects(job, { name: 'AbortError' }); assert.equal(lib.list(accountId).documents.length, 2);
});

test('diagnostics expire when connection, upload readiness, resolved model or knowledge changes', async t => {
  const f = fixture(t);
  await f.workbench.diagnose(accountId, signal()); assert.equal(f.workbench.diagnostics(accountId).stale, false);
  f.transport.status().online = false; assert.equal(f.workbench.diagnostics(accountId).stale, true);
  f.transport.status().online = true; assert.equal(f.workbench.diagnostics(accountId).stale, false);
  f.transport.status().imageUploadReady = false; assert.equal(f.workbench.diagnostics(accountId).stale, true);
  f.transport.status().imageUploadReady = true;
  f.runner.selection = () => ({ provider: 'fixture', model: 'another-default' }); assert.equal(f.workbench.diagnostics(accountId).stale, true);
  await f.workbench.diagnose(accountId, signal()); assert.equal(f.workbench.diagnostics(accountId).stale, false);
  collection(f.workbench.knowledge); assert.equal(f.workbench.diagnostics(accountId).stale, true);
  f.runner.run = async () => { f.transport.status().good = false; return { text: 'OK' }; };
  await assert.rejects(f.workbench.diagnose(accountId, signal()), { code: 'DIAGNOSTICS_CHANGED' });
  assert.equal(f.sends.length, 0);
});

test('invalid or stale knowledge changes do not cancel an unrelated reply already generating', async t => {
  const f = fixture(t), c = collection(f.workbench.knowledge), started = Promise.withResolvers(), finish = Promise.withResolvers();
  f.runner.run = async request => { started.resolve(request.signal); await finish.promise; return { text: '原来的回复继续完成。' }; };
  f.channel.receive({ id: 'knowledge-invalid-save', serverMessageId: 'knowledge-invalid-save', direction: 'incoming', chatType: 'group', peerId: group.peerId, sender: { id: 'alice' }, time: Date.now() / 1000, message: [{ type: 'text', data: { text: '/agent 请继续处理原问题' } }] }, accountId);
  const runningSignal = await Promise.race([started.promise, f.channel.whenIdle().then(() => { throw new Error('Fixture reply ended before generation began'); })]);
  try {
    const revision = f.workbench.knowledge.list(accountId).revision;
    await assert.rejects(async () => f.service.call('knowledge.configure', { ...c, accountId, libraryId: c.id, title: '', revision }, signal()), { code: 'INVALID_INPUT' });
    await assert.rejects(async () => f.service.call('knowledge.delete', { accountId, libraryId: c.id, revision: revision - 1 }, signal()), { code: 'WORKBENCH_CHANGED' });
    assert.equal(runningSignal.aborted, false); assert.equal(f.workbench.knowledge.list(accountId).revision, revision);
  } finally { finish.resolve(); await f.channel.whenIdle(); }
  assert.equal(f.sends.length, 1);
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
