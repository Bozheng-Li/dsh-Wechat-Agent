import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { crc32 } from '../modules/media/image-format.mjs';
import { StateStore, WechatChannel, WorkStore, workTools, readWorkArtifact, workArtifacts, nativeWorkFileSnapshot, nativeWorkArtifacts, ImageGenerationService, IMAGE_GENERATION_CREDENTIAL, imageGenerationCredential, imageGenerationEndpoint, imageGenerationSettings, ChannelError, createPluginService, rpcHandler } from '../lib/testing.js';

const chunk = (type, content) => { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(content.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, content]))); return Buffer.concat([length, name, content, checksum]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 100, 100, 100, 255]))), chunk('IEND', Buffer.alloc(0))]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const scope = { accountId: 'artifacts-owner', chatType: 'private', peerId: 'alice', senderId: 'alice' };
function fixture(t, run, send) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-artifacts-')), store = new StateStore(root), sent = [];
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  store.setConversationSettings(scope.accountId, 'private', 'alice', { ...store.conversationSettings(scope.accountId, 'private', 'alice'), executionMode: 'work' });
  const transport = { status: () => ({ online: true, account: { id: scope.accountId } }), send: async payload => {
    sent.push(payload); if (send) return send(payload);
    const deliveryParts = payload.message.map((part, index) => ({ index, type: part.type, state: 'acknowledged', serverMessageId: `ack-${sent.length}-${index}`,
      ...(part.type === 'text' ? {} : { name: part.data.name, bytes: Buffer.from(part.data.base64, 'base64').length, sha256: digest(Buffer.from(part.data.base64, 'base64')) }) }));
    return { delivery: 'server-ack', serverMessageIds: deliveryParts.map(part => part.serverMessageId), deliveryParts };
  } };
  const channel = new WechatChannel({ store, transport, runner: {}, workRunner: { run: async input => {
    const tools = workTools({ ...input, onOperation: input.onOperation });
    const invoke = async (name, args) => JSON.parse(await tools.find(tool => tool.name === name).execute(args, { signal: input.signal }));
    return run(input, invoke);
  } } });
  const start = async request => { channel.work.create(scope, request); await channel.work.whenIdle(); return channel.work.list(scope).jobs[0]; };
  t.after(async () => { await channel.close(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^wechat-artifacts-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, channel, sent, start, transport };
}

test('DSH arbitrary binary files and generated images return exact bytes with individual server acknowledgements', async t => {
  const originals = { '报告.docx': Buffer.from([0, 255, 128, 1, 2, 3]), '数据.xlsx': Buffer.from('sheet-binary'), '结果.pdf': Buffer.from('%PDF-1.7\nexample'), '产物.zip': Buffer.from([80, 75, 3, 4, 0, 255]), '脚本.py': Buffer.from('print("你好")\n'), '图.png': png };
  const f = fixture(t, async ({ cwd }, invoke) => {
    for (const [name, bytes] of Object.entries(originals)) fs.writeFileSync(path.join(cwd, name), bytes);
    fs.writeFileSync(path.join(cwd, 'intermediate.tmp'), 'not requested');
    assert.equal((await invoke('wechat_work_output', { paths: Object.keys(originals) })).ok, true);
    return { text: '成果已生成，等待回传。' };
  });
  const job = await f.start('生成各类文件和配图并返回给我');
  assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'sent');
  const media = f.sent[0].message.filter(part => part.type !== 'text');
  assert.equal(media.length, 6); assert.equal(media.at(-1).type, 'image'); assert.equal(media[0].type, 'file');
  for (const part of media) assert.deepEqual(Buffer.from(part.data.base64, 'base64'), originals[part.data.name]);
  assert.equal(job.result.files.length, 7); assert.equal(job.result.artifacts.length, 6);
  assert(job.delivery.artifacts.every(value => value.state === 'sent' && value.serverMessageId));
  const persisted = fs.readFileSync(f.channel.work.store.file, 'utf8'); assert(!persisted.includes('base64')); assert(!persisted.includes(png.toString('base64')));
  const restored = new WorkStore(f.store); assert.deepEqual(restored.get(job.id).delivery.artifacts, job.delivery.artifacts); assert.equal(f.sent.length, 1);
});

test('registered large files pass through the complete work handoff with exact bytes and durable receipts', async t => {
  const original = Buffer.alloc(21 * 1024 * 1024 + 13, 0xa7);
  const f = fixture(t, async ({ cwd }, invoke) => {
    for (const name of ['large.docx', 'large.zip']) fs.writeFileSync(path.join(cwd, name), original);
    assert.equal((await invoke('wechat_work_output', { paths: ['large.docx', 'large.zip'] })).ok, true);
    return { text: '两份大文件已生成' };
  });
  const job = await f.start('返回两份大文件');
  assert.equal(job.delivery.state, 'sent'); assert.equal(job.result.artifacts.length, 2);
  for (const part of f.sent[0].message.filter(part => part.type === 'file')) assert.deepEqual(Buffer.from(part.data.base64, 'base64'), original);
  assert(job.delivery.artifacts.every(artifact => artifact.state === 'sent' && artifact.bytes === original.length && artifact.sha256 === digest(original)));
  assert.equal(new WorkStore(f.store).get(job.id).delivery.state, 'sent');
});

test('image can be returned as the original file and internal or escaping paths cannot be registered', async t => {
  const f = fixture(t, async ({ cwd }, invoke) => {
    fs.writeFileSync(path.join(cwd, 'source.png'), png);
    assert.equal((await invoke('wechat_work_output', { paths: ['source.png'], sendAs: 'file' })).artifacts[0].kind, 'file');
    return { text: '原文件已登记' };
  });
  const job = await f.start('把原图作为文件返回'); assert.equal(f.sent[0].message[1].type, 'file');
  assert.throws(() => readWorkArtifact(job.cwd, '../outside.txt'), { code: 'WORK_PATH_INVALID' });
  assert.throws(() => readWorkArtifact(job.cwd, `.wechat-work/${job.id}.md`), { code: 'WORK_ARTIFACT_INVALID' });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(job.cwd, 'junction'), 'junction');
  assert.throws(() => readWorkArtifact(job.cwd, 'junction/secret.txt'), { code: 'WORK_PATH_INVALID' });
});

test('changed or missing final files fail before any text or file is transmitted', async t => {
  const f = fixture(t, async ({ cwd }, invoke) => {
    fs.writeFileSync(path.join(cwd, 'result.csv'), 'score\n42');
    assert.equal((await invoke('wechat_work_output', { paths: ['result.csv'] })).ok, true);
    fs.writeFileSync(path.join(cwd, 'result.csv'), 'score\n99'); return { text: '等待回传' };
  });
  const job = await f.start('生成 CSV 并返回'); assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'failed');
  assert.equal(f.sent.length, 0); assert.match(job.delivery.reason, /已变化/); assert.equal(job.delivery.artifacts[0].state, 'failed');
});

test('partial file delivery retains confirmed, unknown and unattempted files without resend after reload', async t => {
  const f = fixture(t, async ({ cwd }, invoke) => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a'); fs.writeFileSync(path.join(cwd, 'b.txt'), 'b'); fs.writeFileSync(path.join(cwd, 'c.txt'), 'c');
    await invoke('wechat_work_output', { paths: ['a.txt', 'b.txt', 'c.txt'] }); return { text: '三份成果等待回传' };
  }, payload => {
    const parts = payload.message.map((part, index) => ({ index, type: part.type, state: index < 2 ? 'acknowledged' : index === 2 ? 'unknown' : 'not-sent', ...(index < 2 ? { serverMessageId: 'confirmed-' + index } : {}),
      ...(part.type !== 'text' ? { name: part.data.name, sha256: digest(Buffer.from(part.data.base64, 'base64')), bytes: Buffer.from(part.data.base64, 'base64').length } : {}) }));
    throw new ChannelError('SEND_UNKNOWN', '第二份文件回执超时', { delivery: 'partially-acknowledged', acknowledgedMessageIds: ['confirmed-0', 'confirmed-1'], deliveryParts: parts });
  });
  const job = await f.start('生成两份文件并返回'); assert.equal(job.delivery.state, 'partial');
  assert.deepEqual(job.delivery.artifacts.map(value => value.state), ['sent', 'unknown', 'not-sent']);
  assert.equal(job.delivery.artifacts[0].serverMessageId, 'confirmed-1'); new WorkStore(f.store); assert.equal(f.sent.length, 1);
});

const retryOptions = job => ({ expectedUpdatedAt: job.updatedAt, expectedRetryCount: job.delivery.retryAttempts?.length ?? 0, confirmedNotReceived: true });
const deliveryParts = (payload, prefix) => payload.message.map((part, index) => ({ index, type: part.type, state: 'acknowledged', serverMessageId: `${prefix}-${index}`,
  ...(part.type === 'text' ? {} : { name: part.data.name, bytes: Buffer.from(part.data.base64, 'base64').length, sha256: digest(Buffer.from(part.data.base64, 'base64')) }) }));
function unconfirmed(payload, { confirmed = 0, unknown = confirmed } = {}) {
  const parts = deliveryParts(payload, 'original').map((part, index) => ({ ...part, state: index < confirmed ? 'acknowledged' : index === unknown ? 'unknown' : 'not-sent',
    serverMessageId: index < confirmed ? part.serverMessageId : undefined }));
  return new ChannelError('SEND_UNKNOWN', '尚未确认的文件没有自动重发', { delivery: confirmed ? 'partially-acknowledged' : 'unknown',
    acknowledgedMessageIds: parts.filter(part => part.state === 'acknowledged').map(part => part.serverMessageId), deliveryParts: parts });
}

test('owner recovery sends only existing unconfirmed artifacts and preserves original text, task, files and receipts', async t => {
  let executions = 0, sends = 0;
  const f = fixture(t, async ({ cwd }, invoke) => {
    executions++; fs.writeFileSync(path.join(cwd, 'a.csv'), 'score\n42'); fs.writeFileSync(path.join(cwd, 'puppy.png'), png); fs.writeFileSync(path.join(cwd, 'c.zip'), Buffer.from([80, 75, 0, 255]));
    await invoke('wechat_work_output', { paths: ['a.csv', 'puppy.png', 'c.zip'] }); return { text: '原始结果数字 42 保留。' };
  }, payload => {
    if (++sends === 1) throw unconfirmed(payload, { confirmed: 2 });
    const parts = deliveryParts(payload, 'retry'); return { delivery: 'server-ack', serverMessageIds: parts.map(part => part.serverMessageId), deliveryParts: parts };
  });
  const original = await f.start('生成三个文件并返回');
  assert.deepEqual(original.delivery.artifacts.map(value => value.state), ['sent', 'unknown', 'not-sent']);
  fs.unlinkSync(path.join(original.cwd, 'a.csv'));
  const accepted = f.channel.work.retryDelivery(original.id, scope, retryOptions(original));
  assert.equal(accepted.delivery.state, 'pending'); await f.channel.work.whenIdle();
  const job = f.channel.work.get(original.id, scope);
  assert.equal(executions, 1); assert.equal(sends, 2); assert.equal(job.state, original.state); assert.equal(job.sessionId, original.sessionId);
  assert.deepEqual(job.result, original.result); assert.deepEqual(job.operations, original.operations);
  assert.deepEqual(f.sent[1].message.map(part => [part.type, part.data.name]), [['image', 'puppy.png'], ['file', 'c.zip']]);
  assert.deepEqual(Buffer.from(f.sent[1].message[0].data.base64, 'base64'), png);
  assert.equal(job.delivery.state, 'sent'); assert(job.delivery.artifacts.every(value => value.state === 'sent'));
  assert.deepEqual(job.delivery.acknowledgedMessageIds, ['original-0', 'original-1', 'retry-0', 'retry-1']);
  assert.deepEqual(job.delivery.deliveryParts[0], original.delivery.deliveryParts[0]);
  assert.equal(job.delivery.retryAttempts.length, 1); assert.equal(job.delivery.retryAttempts[0].source, 'owner');
  assert.deepEqual(job.delivery.retryAttempts[0].previousDelivery.deliveryParts, original.delivery.deliveryParts);
  const records = f.store.recordsPage(scope.accountId, { ...scope, limit: 100 }).records;
  assert.equal(records.find(record => record.key === original.delivery.recordKey).state, 'partial');
  assert.equal(records.find(record => record.key === job.delivery.lastRetryRecordKey).state, 'sent');
  const persisted = fs.readFileSync(f.channel.work.store.file, 'utf8'); assert(!persisted.includes('base64')); assert(!persisted.includes(png.toString('base64')));
  assert.deepEqual(new WorkStore(f.store).get(job.id).delivery, JSON.parse(JSON.stringify(job.delivery))); assert.equal(sends, 2);
  assert.throws(() => f.channel.work.retryDelivery(job.id, scope, retryOptions(job)), { code: 'WORK_ALREADY_DELIVERED' });
});

for (const [name, change, code] of [
  ['receipt confirmation', options => ({ ...options, confirmedNotReceived: false }), 'WORK_DELIVERY_CONFIRMATION'],
  ['current task revision', options => ({ ...options, expectedUpdatedAt: options.expectedUpdatedAt - 1 }), 'WORK_DELIVERY_CHANGED'],
  ['current retry count', options => ({ ...options, expectedRetryCount: 1 }), 'WORK_DELIVERY_CHANGED'],
]) test(`artifact retry requires ${name} before creating a record or sending bytes`, async t => {
  const f = fixture(t, async ({ cwd }, invoke) => { fs.writeFileSync(path.join(cwd, 'result.png'), png); await invoke('wechat_work_output', { paths: ['result.png'] }); return { text: '待回传' }; }, payload => { throw unconfirmed(payload); });
  const job = await f.start('生成图片并返回');
  assert.throws(() => f.channel.work.retryDelivery(job.id, scope, change(retryOptions(job))), { code });
  assert.deepEqual(f.channel.work.get(job.id, scope), job); assert.equal(f.sent.length, 1);
});

test('changed retry file and changed sender authorization stop before any additional bytes or records', async t => {
  const f = fixture(t, async ({ cwd }, invoke) => { fs.writeFileSync(path.join(cwd, 'result.png'), png); await invoke('wechat_work_output', { paths: ['result.png'] }); return { text: '待回传' }; }, payload => { throw unconfirmed(payload); });
  const job = await f.start('生成图片并返回');
  const changedPng = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 150, 100, 100, 255]))), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(job.cwd, 'result.png'), changedPng);
  assert.throws(() => f.channel.work.retryDelivery(job.id, scope, retryOptions(job)), error => /已变化/.test(error.message));
  assert.throws(() => f.channel.work.retryDelivery(job.id, { ...scope, senderId: 'bob' }, retryOptions(job)), { code: 'WORK_NOT_FOUND' });
  f.store.configure(scope.accountId, { ...f.store.settings(scope.accountId), enabled: false, prompt: '' });
  assert.throws(() => f.channel.work.retryDelivery(job.id, scope, retryOptions(job)), { code: 'WORK_NOT_AUTHORIZED' });
  assert.equal(f.sent.length, 1); assert.deepEqual(f.channel.work.store.get(job.id).delivery, job.delivery);
});

test('duplicate retry actions cannot resend when task timestamps are equal or a response is lost', async t => {
  let calls = 0;
  const f = fixture(t, async ({ cwd }, invoke) => { fs.writeFileSync(path.join(cwd, 'result.png'), png); await invoke('wechat_work_output', { paths: ['result.png'] }); return { text: '待回传' }; }, payload => { calls++; throw unconfirmed(payload, { confirmed: calls === 1 ? 1 : 0 }); });
  f.channel.now = () => 1794210000000; f.channel.work.store.now = f.channel.now;
  const job = await f.start('生成图片并返回'), options = retryOptions(job);
  f.channel.work.retryDelivery(job.id, scope, options);
  assert.throws(() => f.channel.work.retryDelivery(job.id, scope, options), { code: 'WORK_DELIVERY_BUSY' });
  await f.channel.work.whenIdle(); const after = f.channel.work.get(job.id, scope);
  assert.equal(after.updatedAt, job.updatedAt); assert.equal(after.delivery.state, 'partial');
  assert.deepEqual(after.delivery.acknowledgedMessageIds, ['original-0']); assert.equal(after.delivery.artifacts[0].state, 'unknown');
  assert.throws(() => f.channel.work.retryDelivery(job.id, scope, options), { code: 'WORK_DELIVERY_CHANGED' });
  assert.equal(calls, 2); new WorkStore(f.store); assert.equal(calls, 2);
});

test('artifact recovery is an owner-only RPC and verifies the currently logged-in account', async t => {
  let calls = 0;
  const f = fixture(t, async ({ cwd }, invoke) => { fs.writeFileSync(path.join(cwd, 'result.png'), png); await invoke('wechat_work_output', { paths: ['result.png'] }); return { text: '待回传' }; }, payload => {
    if (++calls === 1) throw unconfirmed(payload, { confirmed: 1 });
    const parts = deliveryParts(payload, 'owner-retry'); return { delivery: 'server-ack', serverMessageIds: parts.map(part => part.serverMessageId), deliveryParts: parts };
  });
  const job = await f.start('生成图片并返回');
  const service = createPluginService({ root: f.root, store: f.store, channel: f.channel, worker: { status: f.transport.status }, runner: {} });
  const rpc = rpcHandler(service), payload = { ...scope, id: job.id, ...retryOptions(job) };
  assert.equal((await rpc('work.retryDelivery', payload, undefined, { principal: { kind: 'remote' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await rpc('work.retryDelivery', { ...payload, accountId: 'other-account' }, undefined, { principal: { kind: 'owner' } })).error.code, 'ACCOUNT_CHANGED');
  assert.equal(calls, 1);
  assert.equal((await rpc('work.retryDelivery', payload, undefined, { principal: { kind: 'owner' } })).ok, true);
  await f.channel.work.whenIdle(); assert.equal(calls, 2); assert.equal(f.channel.work.get(job.id, scope).delivery.state, 'sent');
});

test('a general ACK cannot stand in for individual file confirmations', async t => {
  const f = fixture(t, async ({ cwd }, invoke) => { fs.writeFileSync(path.join(cwd, 'a.txt'), 'a'); await invoke('wechat_work_output', { paths: ['a.txt'] }); return { text: '等待回传' }; }, () => ({ delivery: 'server-ack', serverMessageIds: ['text-ack'] }));
  const job = await f.start('生成文件并返回'); assert.equal(job.delivery.state, 'partial'); assert.equal(job.delivery.artifacts[0].state, 'unknown'); assert.equal(f.sent.length, 1);
});

for (const invalid of ['size', 'message ID', 'duplicate message ID']) test(`an invalid file ${invalid} receipt never appears as delivered`, async t => {
  const f = fixture(t, async ({ cwd }, invoke) => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a'); fs.writeFileSync(path.join(cwd, 'b.txt'), 'b');
    await invoke('wechat_work_output', { paths: ['a.txt', 'b.txt'] }); return { text: '成果等待回传' };
  }, payload => {
    const parts = payload.message.map((part, index) => ({ index, type: part.type, state: 'acknowledged', serverMessageId: 'confirmed-' + index,
      ...(part.type !== 'text' ? { name: part.data.name, sha256: digest(Buffer.from(part.data.base64, 'base64')), bytes: Buffer.from(part.data.base64, 'base64').length } : {}) }));
    if (invalid === 'size') parts[2].bytes++;
    else parts[2].serverMessageId = invalid === 'message ID' ? 'unlisted-message' : parts[1].serverMessageId;
    return { delivery: 'server-ack', serverMessageIds: ['confirmed-0', 'confirmed-1', 'confirmed-2'], deliveryParts: parts };
  });
  const job = await f.start('生成两份文件并返回');
  assert.equal(job.delivery.state, 'partial'); assert.equal(job.delivery.artifacts[1].state, 'unknown');
  assert.equal(job.delivery.artifacts[1].serverMessageId, undefined);
  if (invalid === 'duplicate message ID') assert.equal(job.delivery.artifacts[0].state, 'unknown');
  new WorkStore(f.store); assert.equal(f.sent.length, 1);
});

test('result selection deduplicates latest versions and rejects excessive total outputs', () => {
  const value = { path: 'a.txt', name: 'a.txt', kind: 'file', bytes: 1, mediaType: 'text/plain', sha256: 'a'.repeat(64) };
  assert.deepEqual(workArtifacts([{ tool: 'wechat_work_output', result: { ok: true, artifacts: [value] } }, { tool: 'wechat_work_output', result: { ok: true, artifacts: [{ ...value, sha256: 'b'.repeat(64) }] } }])[0].sha256, 'b'.repeat(64));
  assert.throws(() => workArtifacts([{ tool: 'wechat_work_output', result: { ok: true, artifacts: Array.from({ length: 9 }, (_, index) => ({ ...value, path: index + '.txt', name: index + '.txt' })) } }]), { code: 'WORK_ARTIFACT_LIMIT' });
});

test('native DSH files are collected by actual changes without registering intermediate scripts or internal records', async t => {
  const f = fixture(t, async () => ({ text: 'fixture' })), cwd = path.join(f.root, 'native-files'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'old.docx'), 'old'); fs.writeFileSync(path.join(cwd, 'metrics.csv'), 'score\n41');
  fs.mkdirSync(path.join(cwd, '.wechat-work')); fs.writeFileSync(path.join(cwd, '.wechat-work', 'internal.pdf'), 'internal');
  const before = nativeWorkFileSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'metrics.csv'), 'score\n42'); fs.writeFileSync(path.join(cwd, 'dog.png'), png);
  fs.writeFileSync(path.join(cwd, 'helper.py'), 'print(42)'); fs.writeFileSync(path.join(cwd, 'answer.txt'), 'done');
  const artifacts = nativeWorkArtifacts(cwd, 'answer.txt 和 dog.png 已生成，指标已更新', before);
  assert.deepEqual(artifacts.map(value => value.name).sort(), ['answer.txt', 'dog.png', 'metrics.csv']);
  assert.equal(artifacts.find(value => value.name === 'dog.png').kind, 'image');
  for (const artifact of artifacts) assert.equal(readWorkArtifact(cwd, artifact.path, artifact).metadata.sha256, artifact.sha256);
});

test('native outputs accept large files, detect their changes and still enforce the output count', async t => {
  const f = fixture(t, async () => ({ text: 'fixture' })), cwd = path.join(f.root, 'native-limits'); fs.mkdirSync(cwd);
  const target = path.join(cwd, 'large.docx'), descriptor = fs.openSync(target, 'w'); fs.ftruncateSync(descriptor, 21 * 1024 * 1024); fs.closeSync(descriptor);
  const before = nativeWorkFileSnapshot(cwd);
  assert.equal(nativeWorkArtifacts(cwd, 'large.docx', before).length, 0);
  fs.writeFileSync(target, Buffer.alloc(21 * 1024 * 1024, 0xa7));
  const collected = nativeWorkArtifacts(cwd, 'large.docx', before);
  assert.equal(collected.length, 1); assert.equal(collected[0].kind, 'file');
  assert.equal(readWorkArtifact(cwd, collected[0].path, collected[0]).metadata.sha256, digest(fs.readFileSync(target)));
  assert.equal(workArtifacts([{ tool: 'wechat_work_output', result: { ok: true, artifacts: [collected[0], { ...collected[0], path: 'second.docx', name: 'second.docx' }] } }]).length, 2);
  assert.equal(fs.statSync(target).size, 21 * 1024 * 1024);
  fs.unlinkSync(target);
  for (let index = 0; index < 9; index++) fs.writeFileSync(path.join(cwd, `report-${index}.pdf`), 'pdf');
  assert.throws(() => nativeWorkArtifacts(cwd, ''), { code: 'WORK_ARTIFACT_LIMIT' });
});

function apiFixture(t, fetchImpl, extra = {}) {
  const f = fixture(t, async () => ({ text: 'fixture' }));
  const next = f.store.config.snapshot(f.store.data); next.imageGeneration = { enabled: true, endpoint: 'https://image-fixture.invalid/v1', model: 'fixture-image' }; f.store.config.commit(next);
  const credentials = new Map([[IMAGE_GENERATION_CREDENTIAL, 'fixture-secret-key']]);
  const ctx = { credentials: { resolve: async reference => ({ value: credentials.get(reference) }), describe: async reference => ({ configured: credentials.has(reference) }), set: async (reference, value) => credentials.set(reference, value) } };
  const service = new ImageGenerationService(ctx, f.store, { fetchImpl, ...extra });
  return { ...f, service, ctx, credentials };
}

test('compatible image API accepts base64, uses a dedicated key and returns an actual image without exposing secrets', async t => {
  const calls = [], f = apiFixture(t, async (url, options) => { calls.push({ url, options }); return Response.json({ data: [{ b64_json: png.toString('base64') }] }); });
  const generated = await f.service.generate({ prompt: '画一只猫' }, new AbortController().signal);
  assert.deepEqual(generated.bytes, png); assert.equal(generated.extension, '.png'); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://image-fixture.invalid/v1/images/generations'); assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-secret-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'fixture-image', prompt: '画一只猫', n: 1, size: '1024x1024' });
  assert(!JSON.stringify(f.service.status()).includes('fixture-secret-key')); assert(!fs.readFileSync(f.store.config.file, 'utf8').includes('fixture-secret-key'));
});

test('compatible URL response downloads bounded actual bytes without forwarding the API key', async t => {
  const calls = [], f = apiFixture(t, async (url, options) => { calls.push({ url, options }); return calls.length === 1 ? Response.json({ data: [{ url: 'https://cdn-fixture.invalid/result.png' }] }) : new Response(png); }, { lookupImpl: async () => [{ address: '203.0.113.4' }] });
  assert.deepEqual((await f.service.generate({ prompt: '生成图片' }, new AbortController().signal)).bytes, png);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.headers, undefined); assert.equal(calls[1].options.redirect, 'error');
});

test('a real compatible HTTP API returns base64 and downloadable images with credentials confined to the API request', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let content = ''; for await (const bytes of request) content += bytes.toString('utf8');
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, content });
    if (request.url === '/v1/images/generations') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [requests.length === 1 ? { b64_json: png.toString('base64') } : { url: `http://127.0.0.1:${server.address().port}/result.png` }] }));
    } else if (request.url === '/result.png') { response.setHeader('content-type', 'image/png'); response.end(png); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = apiFixture(t), next = f.store.config.snapshot(f.store.data);
  next.imageGeneration.endpoint = `http://127.0.0.1:${server.address().port}/v1`; f.store.config.commit(next);
  for (const prompt of ['返回 base64 图片', '返回图片下载链接']) {
    const generated = await f.service.generate({ prompt }, new AbortController().signal);
    assert.deepEqual(generated.bytes, png); assert.equal(generated.mediaType, 'image/png');
  }
  assert.deepEqual(requests.map(request => [request.method, request.path]), [['POST', '/v1/images/generations'], ['POST', '/v1/images/generations'], ['GET', '/result.png']]);
  assert(requests.slice(0, 2).every(request => request.authorization === 'Bearer fixture-secret-key' && JSON.parse(request.content).model === 'fixture-image'));
  assert.equal(requests[2].authorization, undefined); assert.equal(f.sent.length, 0);
});

for (const [name, status] of [['authentication', 401], ['rate limit', 429], ['server error', 500]]) test(`image API ${name} failure is readable and never automatically retried`, async t => {
  let calls = 0; const f = apiFixture(t, async () => { calls++; return new Response('fixture-secret-key must not escape', { status }); });
  await assert.rejects(() => f.service.generate({ prompt: '生成图片' }, new AbortController().signal), error => error.code === 'IMAGE_GENERATION_HTTP' && !error.message.includes('fixture-secret-key'));
  assert.equal(calls, 1);
});

test('invalid, missing and private-address image responses never become saved or delivered images', async t => {
  const f = apiFixture(t, async () => Response.json({ data: [{ url: 'https://private-fixture.invalid/secret' }] }), { lookupImpl: async () => [{ address: '127.0.0.1' }] });
  await assert.rejects(() => f.service.generate({ prompt: '生成图片' }, new AbortController().signal), { code: 'IMAGE_GENERATION_RESPONSE' });
  f.service.fetchImpl = async () => Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
  await assert.rejects(() => f.service.generate({ prompt: '生成图片' }, new AbortController().signal), { code: 'IMAGE_GENERATION_RESPONSE' });
  f.credentials.clear(); await assert.rejects(() => f.service.generate({ prompt: '生成图片' }, new AbortController().signal), { code: 'IMAGE_GENERATION_CREDENTIAL' }); assert.equal(f.sent.length, 0);
});

test('generation tool automatically saves and registers API bytes; cancellation cannot save a late image', async t => {
  const f = apiFixture(t, async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }));
  const cwd = path.join(f.root, 'isolated-task'); fs.mkdirSync(cwd); const operations = [], signal = new AbortController();
  const tools = workTools({ cwd, request: '生成一张猫咪图片', limits: {}, assertAllowed: () => signal.signal.throwIfAborted(), onOperation: op => operations.push(op), imageGeneration: f.service });
  const tool = tools.find(value => value.name === 'wechat_work_generate_image');
  const result = JSON.parse(await tool.execute({ prompt: '猫咪', path: '猫咪.jpg' }, { signal: signal.signal }));
  assert.equal(result.ok, true); assert.equal(result.artifacts[0].path, '猫咪.png'); assert.deepEqual(fs.readFileSync(path.join(cwd, '猫咪.png')), png);
  assert.equal(workArtifacts(operations).length, 1); assert(!JSON.stringify(operations).includes('fixture-secret-key')); assert(!JSON.stringify(operations).includes('base64'));
  f.service.fetchImpl = async () => { signal.abort(new ChannelError('CANCELLED', '取消')); return Response.json({ data: [{ b64_json: png.toString('base64') }] }); };
  await assert.rejects(() => tool.execute({ prompt: '另一只猫咪', path: 'late.png' }, { signal: signal.signal })); assert(!fs.existsSync(path.join(cwd, 'late.png')));
});

test('only owner RPC can save image API settings and key; public status contains only credential state', async t => {
  const f = apiFixture(t, async () => { throw Error('configuration must not generate paid images'); }); f.channel.work.imageGeneration = f.service;
  const service = createPluginService({ ctx: f.ctx, root: f.root, store: f.store, channel: f.channel, worker: f.transport, runner: {} }), rpc = rpcHandler(service);
  const settings = { enabled: true, endpoint: 'https://example.invalid/v1', model: 'owner-image' };
  const rejected = await rpc('imageGeneration.configure', { settings }, undefined, { principal: { kind: 'guest' } }); assert.equal(rejected.ok, false);
  const saved = await rpc('imageGeneration.configure', { settings }, undefined, { principal: { kind: 'owner' } }); assert.equal(saved.ok, true); assert.equal(saved.value.imageGeneration.model, 'owner-image');
  const key = await rpc('imageGeneration.credential', { apiKey: 'new-private-key' }, undefined, { principal: { kind: 'owner' } }); assert.equal(key.ok, true); assert(!JSON.stringify(key).includes('new-private-key'));
  assert.equal(f.credentials.get(IMAGE_GENERATION_CREDENTIAL), 'new-private-key'); assert.equal(f.sent.length, 0);
});

test('compatible configuration accepts base and complete endpoints and rejects secrets in YAML', () => {
  assert.equal(imageGenerationEndpoint('https://example.invalid'), 'https://example.invalid/v1/images/generations');
  assert.equal(imageGenerationEndpoint('https://example.invalid/custom/v1/'), 'https://example.invalid/custom/v1/images/generations');
  assert.equal(imageGenerationEndpoint('https://example.invalid/v1/images/generations'), 'https://example.invalid/v1/images/generations');
  assert.throws(() => imageGenerationSettings({ apiKey: 'secret' }), { code: 'IMAGE_GENERATION_CONFIG' });
  assert.throws(() => imageGenerationSettings({ enabled: true }), { code: 'IMAGE_GENERATION_CONFIG' });
});

test('owner RPC saves multiple interfaces and targets credentials without borrowing the default key', async t => {
  const f = apiFixture(t, async () => { throw Error('Saving settings cannot generate images'); }); f.channel.work.imageGeneration = f.service;
  const rpc = rpcHandler(createPluginService({ ctx: f.ctx, root: f.root, store: f.store, channel: f.channel, worker: f.transport, runner: {} }));
  const settings = { enabled: true, defaultProviderId: 'first', providers: ['first', 'second'].map(id => ({ id, name: id, endpoint: `https://${id}.invalid/v1`, models: ['shared-image', 'alternate-image'], defaultModel: 'shared-image' })) };
  const owner = { principal: { kind: 'owner' } }, guest = { principal: { kind: 'guest' } };
  assert.equal((await rpc('imageGeneration.configure', { settings }, undefined, guest)).ok, false);
  assert.equal((await rpc('imageGeneration.configure', { settings }, undefined, owner)).ok, true);
  const payload = { providerId: 'second', endpoint: 'https://second.invalid/v1', apiKey: 'second-owner-key' };
  assert.equal((await rpc('imageGeneration.credential', payload, undefined, guest)).ok, false);
  const saved = await rpc('imageGeneration.credential', payload, undefined, owner);
  assert.equal(saved.ok, true); assert.equal(saved.value.imageGeneration.credentialConfigured, false);
  assert.equal(saved.value.imageGeneration.providers[1].credentialConfigured, true);
  assert.equal(f.credentials.get(imageGenerationCredential(f.service.settings().providers[1])), 'second-owner-key');
  assert.equal(f.credentials.get(IMAGE_GENERATION_CREDENTIAL), 'fixture-secret-key');
  assert(!JSON.stringify(saved).includes('second-owner-key')); assert.equal(f.sent.length, 0);
});

for (const revoke of [false, true]) test(`owner artifact recovery in chat mode preserves execution mode and ${revoke ? 'blocks revoked recipients' : 'sends existing image only'}`, async t => {
  let executions = 0, sends = 0;
  const f = fixture(t, async ({ cwd }, invoke) => { executions++; fs.writeFileSync(path.join(cwd, 'result.png'), png); await invoke('wechat_work_output', { paths: ['result.png'] }); return { text: '原图待回传' }; }, payload => {
    if (++sends === 1) throw unconfirmed(payload, { confirmed: 1 });
    const parts = deliveryParts(payload, 'chat-owner-retry'); return { delivery: 'server-ack', serverMessageIds: parts.map(part => part.serverMessageId), deliveryParts: parts };
  });
  const original = await f.start('生成图片并返回');
  const config = f.store.conversationSettings(scope.accountId, 'private', 'alice');
  f.store.setConversationSettings(scope.accountId, 'private', 'alice', { ...config, executionMode: 'chat' });
  if (revoke) {
    f.store.configure(scope.accountId, { ...f.store.settings(scope.accountId), privatePeers: [], prompt: '' });
    assert.throws(() => f.channel.work.retryDelivery(original.id, scope, retryOptions(original)), { code: 'WORK_NOT_AUTHORIZED' });
    assert.equal(sends, 1); assert.deepEqual(f.channel.work.get(original.id, scope).delivery, original.delivery);
  } else {
    assert.throws(() => f.channel.work.create(scope, '创建另一项任务'), { code: 'WORK_NOT_AUTHORIZED' });
    f.channel.work.retryDelivery(original.id, scope, retryOptions(original)); await f.channel.work.whenIdle();
    const after = f.channel.work.get(original.id, scope);
    assert.equal(after.delivery.state, 'sent'); assert.equal(sends, 2); assert.equal(executions, 1);
    assert.deepEqual(f.sent[1].message.map(p => [p.type, p.data.name]), [['image', 'result.png']]);
    assert.deepEqual(Buffer.from(f.sent[1].message[0].data.base64, 'base64'), png);
    assert.deepEqual(after.result, original.result); assert.deepEqual(after.operations, original.operations);
    assert.equal(after.sessionId, original.sessionId); assert.equal(after.state, original.state);
  }
  assert.equal(f.store.conversationSettings(scope.accountId, 'private', 'alice').executionMode, 'chat');
});
