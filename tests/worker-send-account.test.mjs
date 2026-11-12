import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { rolldown } from 'rolldown';

// Exercise the real worker's IPC dispatch with an isolated, offline backend.
// Neither real credentials nor network transports are available to this child.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mocks = {
  './protocol/backend.ts': `export class ProtocolBackend {
    constructor() { this.session = { value: process.env.WECHAT_TEST_NO_ACCOUNT === '1' ? undefined : { wxid: 'worker-current-account' } }; this.sent = 0; }
    status() { return { online: !!this.session.value, diagnostics: { state: 'fixture', account: this.session.value ? { id: this.session.value.wxid } : null, sent: this.sent } }; }
    subscribe() {}
    async sendMessage(params) {
      this.sent++;
      if (params.peerId === 'protocol@chatroom' || params.peerId === 'unsafe-protocol@chatroom') throw Object.assign(new Error(params.peerId === 'protocol@chatroom'
        ? '图片上传回执的长度或分片位置不匹配，发送结果未知' : 'raw packet token=PRIVATE_TOKEN'), { code: 'ERR_PROTOCOL', details: {
        ret: params.peerId === 'protocol@chatroom' ? -2 : 'PRIVATE_TOKEN', delivery: 'unknown', rawPacket: 'PRIVATE_PACKET'
      } });
      if (params.peerId === 'partial@chatroom') throw Object.assign(new Error('internal transport detail'), { code: 'ERR_SEND_FAILED', details: {
        delivery: 'partially-acknowledged', acknowledgedMessageIds: ['9007199254740999'], privateData: 'do not forward',
        deliveryParts: [{ index: 0, type: 'text', state: 'acknowledged', serverMessageId: '9007199254740999', raw: 'not public' }, { index: 1, type: 'image', state: 'unknown', bytes: 'not public' }]
      } });
      return { delivery: 'server-ack', serverMessageIds: ['9007199254740999'], actualAccount: this.session.value.wxid, receivedParams: params };
    }
    async writeMoments(query, clientId) {
      if (query.action === 'rejected') throw Object.assign(new Error('微信拒绝朋友圈操作（ret=-2）'), { code: 'ERR_MOMENTS_WRITE_REJECTED', details: { delivery: 'rejected', rawPacket: 'PRIVATE_PACKET' } });
      if (query.action === 'publish') throw Object.assign(new Error('微信已返回动态，屏蔽范围未确认'), { code: 'ERR_MOMENTS_WRITE_PROTOCOL', details: { delivery: 'unknown', rawPacket: 'PRIVATE_PACKET', publication: {
        accountId: this.session.value.wxid, postId: query.text === 'malformed' ? 1 : '9007199254740999', createdAt: 1700000000,
        textHash: 'f'.repeat(64), imageCount: 0, submittedBlockedUserIds: ['friend'], returnedBlockedUserIds: [],
        audienceSelection: { blockedUserIds: ['friend'], blockedLabelIds: [] }, audienceSource: 'submitted-identifiers',
        rawPacket: 'PRIVATE_PACKET', url: 'https://private.invalid/?token=PRIVATE_TOKEN'
      } } });
      return { accountId: this.session.value.wxid, action: query.action, clientId, postId: query.postId, delivery: 'server-ack' };
    }
    async readMoments() { throw Object.assign(new Error('这条动态暂不可读取（ret=-2）'), { code: 'ERR_MOMENTS_REJECTED', details: { ret: -2, rawPacket: 'PRIVATE_PACKET' } }); }
    async readMomentsPublication(query) { return { accountId: this.session.value.wxid, postId: query.postId, readOnly: true }; }
    receivedFileContext(query) {
      if (query.accountId !== this.session.value.wxid) throw new Error('Backend must not run for a stale account');
      return { files: [{ messageId: '9007199254740999', name: 'fixture.docx', bytes: 3 }],
        ...(query.peerId === 'uncertain@chatroom' ? { latestUnavailable: true } : {}) };
    }
    async downloadFile(query, signal) {
      signal.throwIfAborted();
      if (query.accountId !== this.session.value.wxid) throw new Error('Backend must not run for a stale account');
      if (query.peerId === 'expired@chatroom') throw Object.assign(new Error('微信未提供该附件（ret=-2），文件可能已过期'),
        { code: 'ERR_FILE_DOWNLOAD_REJECTED', details: { rawPacket: 'PRIVATE_PACKET', attachId: 'PRIVATE_LOCATOR' } });
      if (query.peerId === 'changed@chatroom') this.session.value = { ...this.session.value, token: 'new-session' };
      return { messageId: query.messageId, name: 'fixture.docx', bytes: 3, data: 'YWJj', sha256: 'a'.repeat(64) };
    }
    async close() {}
  }`,
  './protocol/login.ts': `export class QrLoginManager { status() { return { state: 'idle' }; } async close() {} }`,
  './paths.ts': `export const protectStorage = () => {}; export const projectPaths = root => ({ private: root, cache: root });`,
  './protocol/media-loader.mjs': `export const loadObservedMedia = () => { throw new Error('Media is not available in this isolated worker'); };`,
};
const build = await rolldown({ input: path.join(root, 'backend/worker.mjs'), platform: 'node', plugins: [{ name: 'offline-worker-boundary',
  resolveId(source) { return Object.hasOwn(mocks, source) ? '\0offline:' + source : null; },
  load(id) { return id.startsWith('\0offline:') ? mocks[id.slice('\0offline:'.length)] : null; },
}] });
let code;
try { const { output } = await build.generate({ format: 'cjs' }); assert.equal(output.length, 1); code = output[0].code; }
finally { await build.close(); }

async function workerFixture(t, noAccount = false) {
  const temporary = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(temporary, 'wechat-worker-boundary-'));
  const entry = path.join(dir, 'offline-worker.cjs'); fs.writeFileSync(entry, code);
  const child = fork(entry, [dir], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, NAPCAT_RESOURCE_ROOT: dir, WECHAT_TEST_NO_ACCOUNT: noAccount ? '1' : '0' } });
  const pending = new Map(), ready = Promise.withResolvers(), exited = Promise.withResolvers(); let serial = 0;
  child.on('message', message => {
    if (message.type === 'ready') ready.resolve(message.status);
    if (message.type === 'result') { const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); } }
  });
  child.on('error', error => ready.reject(error));
  child.on('exit', () => { ready.reject(new Error('Offline worker exited before becoming ready')); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Offline worker exited')); } pending.clear(); exited.resolve(); });
  const call = (op, args) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Offline worker IPC timed out')); }, 5000);
    pending.set(id, { resolve, reject, timer }); child.send({ type: 'call', id, op, args });
  });
  t.after(async () => {
    if (child.connected) { try { await call('close'); } catch { child.kill(); } }
    else if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.promise;
    assert.equal(path.dirname(dir), temporary); assert.match(path.basename(dir), /^wechat-worker-boundary-/); fs.rmSync(dir, { recursive: true, force: true });
  });
  await ready.promise;
  return { call };
}
const message = { chatType: 'group', peerId: 'test@chatroom', message: [{ type: 'text', data: { text: 'isolated fixture only' } }] };

test('worker rejects a stale parent account before invoking the send backend', async t => {
  const f = await workerFixture(t);
  const response = await f.call('send', { accountId: 'parent-stale-account', ...message });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'ACCOUNT_CHANGED');
  assert.equal(response.error.details.delivery, 'rejected'); assert.match(response.error.message, /尚未发送/);
  assert.equal((await f.call('status')).value.sent, 0);
});

test('worker requires an explicit matching account and strips it from protocol parameters', async t => {
  const f = await workerFixture(t);
  const missing = await f.call('send', message);
  assert.equal(missing.ok, false); assert.equal(missing.error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.call('status')).value.sent, 0);
  const response = await f.call('send', { accountId: 'worker-current-account', ...message });
  assert.equal(response.ok, true); assert.equal(response.value.actualAccount, 'worker-current-account');
  assert.deepEqual(response.value.receivedParams, message); assert.equal((await f.call('status')).value.sent, 1);
});

test('worker refuses sending when no account is logged in', async t => {
  const f = await workerFixture(t, true);
  const response = await f.call('send', { accountId: 'worker-current-account', ...message });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.call('status')).value.sent, 0);
});

test('retired attachment IPC rejects current and stale callers without exposing files', async t => {
  const f = await workerFixture(t), query = { peerId: 'files@chatroom', before: Date.now(), messageId: '9007199254740999' };
  for (const accountId of [undefined, 'stale-account', 'worker-current-account']) for (const action of ['list', 'download']) {
    const result = await f.call('files', { ...query, accountId, action });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'FILE_FEATURE_DISABLED'); assert.equal(result.value, undefined);
  }
});

test('retired attachment IPC returns a short error before invoking the download backend', async t => {
  const f = await workerFixture(t), query = { accountId: 'worker-current-account', action: 'download', before: Date.now(), messageId: '9007199254740999' };
  const expired = await f.call('files', { ...query, peerId: 'expired@chatroom' });
  assert.equal(expired.ok, false); assert.equal(expired.error.code, 'FILE_FEATURE_DISABLED'); assert.equal(expired.error.message, '微信附件读取功能已停用');
  assert(!JSON.stringify(expired).includes('PRIVATE_'));
  const changed = await f.call('files', { ...query, peerId: 'changed@chatroom' });
  assert.equal(changed.ok, false); assert.equal(changed.error.code, 'FILE_FEATURE_DISABLED'); assert.equal(changed.value, undefined);
});

test('worker preserves per-part ACK and uncertainty across IPC without serializing transport internals', async t => {
  const f = await workerFixture(t);
  const response = await f.call('send', { accountId: 'worker-current-account', ...message, peerId: 'partial@chatroom' });
  assert.equal(response.ok, false); assert.equal(response.error.details.delivery, 'partially-acknowledged');
  assert.deepEqual(response.error.details.deliveryParts, [{ index: 0, type: 'text', state: 'acknowledged', serverMessageId: '9007199254740999' }, { index: 1, type: 'image', state: 'unknown' }]);
  assert(!JSON.stringify(response).includes('not public')); assert(!JSON.stringify(response).includes('do not forward')); assert(!JSON.stringify(response).includes('internal transport detail'));
});

test('worker forwards a known image protocol explanation and numeric status without raw packets', async t => {
  const f = await workerFixture(t);
  const response = await f.call('send', { accountId: 'worker-current-account', ...message, peerId: 'protocol@chatroom' });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'ERR_PROTOCOL');
  assert.match(response.error.message, /分片位置不匹配/); assert.match(response.error.message, /ret=-2/);
  assert.equal(response.error.details.ret, -2); assert.equal(response.error.details.delivery, 'unknown');
  assert(!JSON.stringify(response).includes('PRIVATE_PACKET'));
});

test('unexpected protocol text and nonnumeric status remain private at the worker boundary', async t => {
  const f = await workerFixture(t);
  const response = await f.call('send', { accountId: 'worker-current-account', ...message, peerId: 'unsafe-protocol@chatroom' });
  assert.match(response.error.message, /协议校验未通过/); assert.equal(response.error.details.ret, undefined);
  assert(!JSON.stringify(response).includes('PRIVATE_')); assert(!JSON.stringify(response).includes('raw packet'));
});

test('SNS read IPC retains a numeric rejection and verifies own-publication read scope without any send', async t => {
  const f = await workerFixture(t), accountId = 'worker-current-account', scopeKey = 'owner:worker-current-account';
  const result = await f.call('moments.read', { accountId, scopeKey, authorizedUserIds: ['friend'], query: { action: 'comments', postId: '9007199254740999' } });
  assert.equal(result.ok, false); assert.equal(result.error.details.ret, -2); assert(!JSON.stringify(result).includes('PRIVATE_PACKET'));
  const read = await f.call('moments.publication', { accountId, scopeKey, query: { postId: '9007199254740999' } });
  assert.equal(read.ok, true); assert.equal(read.value.readOnly, true);
  assert.equal((await f.call('moments.publication', { accountId: 'other', scopeKey, query: { postId: '1' } })).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.call('moments.publication', { accountId, query: { postId: '1' } })).error.code, 'ERR_INVALID_MOMENTS_QUERY');
  assert.equal((await f.call('status')).value.sent, 0);
});

test('SNS publication uncertainty crosses IPC only as validated metadata and never includes raw response credentials', async t => {
  const f = await workerFixture(t), args = { accountId: 'worker-current-account', clientId: 'sns_' + 'b'.repeat(64), authorizedUserIds: ['friend'], query: { action: 'publish', text: 'valid' } };
  const result = await f.call('moments.write', args);
  assert.equal(result.ok, false); assert.equal(result.error.details.snsDelivery, 'unknown');
  assert.equal(result.error.details.publication.postId, '9007199254740999');
  assert.deepEqual(result.error.details.publication.submittedBlockedUserIds, ['friend']);
  assert(!JSON.stringify(result).includes('PRIVATE_')); assert(!JSON.stringify(result).includes('private.invalid'));
  const invalid = await f.call('moments.write', { ...args, query: { action: 'publish', text: 'malformed' } });
  assert.equal(invalid.error.details.publication, undefined); assert.equal(invalid.error.details.snsDelivery, 'unknown');
});

test('SNS write IPC refuses stale accounts and invalid request IDs, and preserves only safe rejection metadata', async t => {
  const f = await workerFixture(t), clientId = 'sns_' + 'a'.repeat(64), query = { action: 'like', postId: '9007199254740999' };
  assert.equal((await f.call('moments.write', { accountId: 'other', clientId, query })).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.call('moments.write', { accountId: 'worker-current-account', clientId: 'invalid', query })).error.code, 'ERR_INVALID_MOMENTS_WRITE');
  assert.equal((await f.call('moments.write', { accountId: 'worker-current-account', clientId, query })).error.code, 'OBJECT_NOT_AUTHORIZED');
  const success = await f.call('moments.write', { accountId: 'worker-current-account', clientId, authorizedUserIds: ['friend'], query });
  assert.equal(success.ok, true); assert.equal(success.value.postId, query.postId); assert.equal(success.value.clientId, clientId);
  const rejected = await f.call('moments.write', { accountId: 'worker-current-account', clientId, authorizedUserIds: ['friend'], query: { action: 'rejected' } });
  assert.equal(rejected.error.code, 'ERR_MOMENTS_WRITE_REJECTED'); assert.equal(rejected.error.details.snsDelivery, 'rejected');
  assert(!JSON.stringify(rejected).includes('PRIVATE_PACKET')); assert.equal((await f.call('status')).value.sent, 0);
});
