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
      return { accountId: this.session.value.wxid, action: query.action, clientId, postId: query.postId, delivery: 'server-ack' };
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

test('SNS write IPC refuses stale accounts and invalid request IDs, and preserves only safe rejection metadata', async t => {
  const f = await workerFixture(t), clientId = 'sns_' + 'a'.repeat(64), query = { action: 'like', postId: '9007199254740999' };
  assert.equal((await f.call('moments.write', { accountId: 'other', clientId, query })).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.call('moments.write', { accountId: 'worker-current-account', clientId: 'invalid', query })).error.code, 'ERR_INVALID_MOMENTS_WRITE');
  const success = await f.call('moments.write', { accountId: 'worker-current-account', clientId, query });
  assert.equal(success.ok, true); assert.equal(success.value.postId, query.postId); assert.equal(success.value.clientId, clientId);
  const rejected = await f.call('moments.write', { accountId: 'worker-current-account', clientId, query: { action: 'rejected' } });
  assert.equal(rejected.error.code, 'ERR_MOMENTS_WRITE_REJECTED'); assert.equal(rejected.error.details.snsDelivery, 'rejected');
  assert(!JSON.stringify(rejected).includes('PRIVATE_PACKET')); assert.equal((await f.call('status')).value.sent, 0);
});
