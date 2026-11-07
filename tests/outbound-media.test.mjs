import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { nativeQrSession, writeNativeQrRound } from './fixtures/native-qr-session.mjs';

// Keep protocol fixtures isolated from the running worker and its credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = `export * from ${JSON.stringify(path.join(root, 'src/wechat/protocol/backend.ts'))};
export * from ${JSON.stringify(path.join(root, 'src/wechat/protocol/wire.ts'))};
export * from ${JSON.stringify(path.join(root, 'src/wechat/types.ts'))};`;
const build = await rolldown({ input: 'virtual:outbound-test', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'src/wechat/types.ts') } }, plugins: [{ name: 'outbound-test', resolveId: id => id === 'virtual:outbound-test' ? id : null, load: id => id === 'virtual:outbound-test' ? entry : null }] });
let api;
try {
  const { output } = await build.generate({ format: 'esm' });
  assert.equal(output.length, 1);
  api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);
} finally { await build.close(); }
const { ProtocolBackend, BridgeError, fields, bytes, num, unstring, ld, fv, encodeFrame, imageUploadRequest, imageUploadResponse, IMAGE_CHUNK_BYTES } = api;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1cAAAAASUVORK5CYII=', 'base64');
const bigPng = Buffer.concat([png, Buffer.alloc(120_013, 0x61)]);
const media = (content = png, mediaType = 'image/png', type = 'image') => ({ type, data: { base64: content.toString('base64'), mediaType } });
const message = (...segments) => ({ chatType: 'group', peerId: 'test-group@chatroom', message: segments });
const text = value => ({ type: 'text', data: { text: value } });

function imageAck(body, overrides = {}) {
  const f = fields(body), start = Number(num(f, 6)), length = Number(num(f, 7));
  const item = { ret: 0, clientId: unstring(bytes(f, 2)), from: unstring(bytes(f, 3)), to: unstring(bytes(f, 4)), total: Number(num(f, 5)), start: start + length, length, id: start + length === Number(num(f, 5)) ? '9007199254740999' : undefined, ...overrides };
  return Buffer.concat([ld(1, fv(1, item.ret)), ld(3, ld(1, item.clientId)), ld(4, ld(1, item.from)), ld(5, ld(1, item.to)), fv(6, item.total), fv(7, item.start), fv(8, item.length), fv(9, 1700000000), ...(item.id === undefined ? [] : [fv(10, BigInt(item.id))])]);
}
function textAck(body, id = '9007199254740901') {
  const f = fields(bytes(fields(body), 2));
  return Buffer.concat([ld(1, fv(1, 0)), fv(2, 1), ld(3, Buffer.concat([fv(4, num(f, 5)), fv(5, num(f, 4)), fv(6, 1700000000), fv(8, BigInt(id))]))]);
}
function fixture(t, respond = (cmd, body) => cmd === 110 ? imageAck(body) : textAck(body), withBase = true, qr) {
  const tempRoot = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(tempRoot, 'wechat-outbound-test-'));
  const sessionFile = path.join(dir, 'session.json'), cacheDir = path.join(dir, 'cache');
  fs.writeFileSync(sessionFile, JSON.stringify(qr?.credential ?? { uin: 123, token: 'aa'.repeat(15), wxid: 'wxid_fixture', nickname: '测试账号', sync_key: fv(1, 0).toString('hex'), ...(withBase ? { heartbeat_base_request: Buffer.concat([ld(1, 'fake-session'), fv(2, 123)]).toString('hex') } : {}) }));
  if (qr) writeNativeQrRound(dir, qr);
  const backend = new ProtocolBackend({ sessionFile, cacheDir, syncIntervalMs: 60000, heartbeatIntervalMs: 60000, requestTimeoutMs: 1000, reconnectMs: 1000, sendIntervalMs: 0, sendJitterMs: 0, segmentBytes: 4096 });
  const calls = [], events = [];
  backend.controller = new AbortController(); backend.online = true;
  backend.transport = { connected: true, tx: 0, rx: 0, request: async (cmd, body) => { calls.push({ cmd, body }); return respond(cmd, body, calls.length, backend); }, close() { this.connected = false; } };
  backend.subscribe(event => { if (event.type === 'event.message') events.push(event.payload); });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(dir), tempRoot); assert.match(path.basename(dir), /^wechat-outbound-test-/); fs.rmSync(dir, { recursive: true, force: true }); });
  return { backend, calls, events, cache: () => fs.readFileSync(path.join(cacheDir, `${backend.session.value.uin}.json`), 'utf8') };
}

test('long complete text is segmented without losing Unicode or the ending, with one ACK per segment', async t => {
  const f = fixture(t, (_cmd, body, number) => textAck(body, String(9000000 + number)));
  const reply = '甲🙂双曲线 x²/a² − y²/b² = 1。\n'.repeat(1000) + '完整结尾。';
  assert(reply.length > 12000);
  const result = await f.backend.sendMessage(message(text(reply)));
  assert.equal(result.delivery, 'server-ack'); assert(f.calls.length > 1);
  assert.equal(f.events.map(e => e.message[0].data.text).join(''), reply);
  assert(f.events.every(e => Buffer.byteLength(e.message[0].data.text) <= 4096));
  assert.equal(result.serverMessageIds.length, f.calls.length);
});

test('UploadMsgImg uses command 9, exact wrappers, and complete-image identity', () => {
  const upload = { clientId: 'fixture-image', from: 'self', to: 'peer', total: 6, time: 1700000000, baseRequest: fv(2, 123), extension: 'png' };
  const body = imageUploadRequest(upload, 0, Buffer.from('123456'));
  const f = fields(body);
  assert.deepEqual(bytes(f, 1), upload.baseRequest);
  assert.equal(unstring(bytes(f, 2)), upload.clientId);
  assert.equal(unstring(bytes(f, 3)), upload.from);
  assert.equal(unstring(bytes(f, 4)), upload.to);
  assert.equal(num(f, 9), 3n);
  assert.equal(bytes(f, 33).toString(), 'png');
  assert.equal(num(fields(bytes(f, 8)), 1), 6n);
  assert.equal(bytes(fields(bytes(f, 8)), 2).toString(), '123456');
  assert.equal(encodeFrame(110, body, 123, 'aa'.repeat(15), 1).readUInt32BE(8), 9);
  assert.deepEqual(imageUploadResponse(imageAck(body), upload, 0, 6), { complete: true, id: '9007199254740999', time: 1700000000 });
  assert.equal(imageUploadResponse(imageAck(body, { start: 0 }), upload, 0, 6).complete, true);
});

test('multi-chunk image sends one confirmed message and never stores base64 in the durable cache', async t => {
  const f = fixture(t);
  const sent = await f.backend.sendMessage(message(media(bigPng)));
  assert.equal(f.calls.length, Math.ceil(bigPng.length / IMAGE_CHUNK_BYTES));
  const clientIds = new Set(), uploaded = [];
  for (let i = 0; i < f.calls.length; i++) {
    const { cmd, body } = f.calls[i], values = fields(body);
    assert.equal(cmd, 110); clientIds.add(unstring(bytes(values, 2)));
    assert.equal(Number(num(values, 6)), i * IMAGE_CHUNK_BYTES);
    uploaded.push(bytes(fields(bytes(values, 8)), 2));
  }
  assert.equal(clientIds.size, 1); assert.deepEqual(Buffer.concat(uploaded), bigPng);
  assert.equal(f.events.length, 1); assert.equal(sent.messageType, 3);
  assert.equal(sent.delivery, 'server-ack'); assert.deepEqual(sent.serverMessageIds, ['9007199254740999']);
  assert.equal(sent.message[0].data.bytes, bigPng.length);
  assert.equal(sent.message[0].data.base64, undefined);
  assert.equal(f.backend.status().diagnostics.sent, 1);
  assert.equal(f.backend.queuedMediaBytes, 0);
  assert.ok(!f.cache().includes('base64')); assert.ok(f.cache().length < 2500);
});

for (const [name, override] of [
  ['client image ID', { clientId: 'different' }], ['recipient', { to: 'wrong-group@chatroom' }], ['sender', { from: 'other-account' }],
  ['total length', { total: 1 }], ['chunk length', { length: 1 }], ['chunk offset', { start: 42 }],
]) test(`mismatched ${name} stops uploading without reporting a delivered image`, async t => {
  const f = fixture(t, (_cmd, body) => imageAck(body, override));
  await assert.rejects(async () => f.backend.sendMessage(message(media(bigPng))), error => error.code === 'ERR_PROTOCOL' && error.details.delivery === 'unknown' && error.details.acknowledgedMessageIds.length === 0);
  assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
});

test('missing final message ID is unknown and is never automatically retried', async t => {
  const f = fixture(t, (_cmd, body) => imageAck(body, { id: undefined }));
  await assert.rejects(async () => f.backend.sendMessage(message(media(bigPng))), error => error.code === 'ERR_PROTOCOL' && error.details.delivery === 'unknown');
  assert.equal(f.calls.length, 3); assert.equal(f.events.length, 0); assert.equal(f.backend.status().diagnostics.sent, 0);
});

test('a nonzero image status remains rejected, with no false confirmation', async t => {
  const f = fixture(t, (_cmd, body) => imageAck(body, { ret: -3 }));
  await assert.rejects(async () => f.backend.sendMessage(message(media())), error => error.code === 'ERR_SEND_REJECTED' && error.details.ret === -3 && error.details.delivery === 'rejected');
  assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
});

test('a timeout after writing a chunk is unknown and is never retried', async t => {
  const f = fixture(t, () => { throw new BridgeError('ERR_REQUEST_TIMEOUT', 'fixture timeout', { delivery: 'unknown' }); });
  await assert.rejects(async () => f.backend.sendMessage(message(media(bigPng))), error => error.code === 'ERR_REQUEST_TIMEOUT' && error.details.delivery === 'unknown');
  assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
});

test('cancellation after an intermediate chunk prevents sending the next one', async t => {
  const cancel = new AbortController();
  const f = fixture(t, (_cmd, body) => { cancel.abort(); return imageAck(body); });
  await assert.rejects(async () => f.backend.sendMessage(message(media(bigPng)), cancel.signal), error => error.code === 'ERR_STOPPED' && error.details.acknowledgedMessageIds.length === 0);
  assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
});

test('cancellation during the final request preserves the actual server confirmation', async t => {
  const cancel = new AbortController();
  const f = fixture(t, (_cmd, body) => { cancel.abort(); return imageAck(body); });
  const sent = await f.backend.sendMessage(message(media()), cancel.signal);
  assert.equal(sent.delivery, 'server-ack'); assert.equal(f.events.length, 1); assert.equal(f.calls.length, 1);
});

test('cancellation after a confirmed image prevents later text but preserves the image ACK', async t => {
  const cancel = new AbortController();
  const f = fixture(t, (_cmd, body) => { cancel.abort(); return imageAck(body); });
  await assert.rejects(async () => f.backend.sendMessage(message(media(), text('later')), cancel.signal), error => error.details.delivery === 'partially-acknowledged' && error.details.acknowledgedMessageIds[0] === '9007199254740999');
  assert.equal(f.events.length, 1); assert.equal(f.calls.length, 1);
});

test('a confirmed text is preserved if a later valid image is rejected by WeChat', async t => {
  const f = fixture(t, (cmd, body) => cmd === 522 ? textAck(body) : imageAck(body, { ret: -5 }));
  await assert.rejects(async () => f.backend.sendMessage(message(text('已确认的文字'), media())), error => error.details.delivery === 'partially-acknowledged' && error.details.acknowledgedMessageIds[0] === '9007199254740901');
  assert.deepEqual(f.calls.map(c => c.cmd), [522, 110]); assert.equal(f.events.length, 1); assert.equal(f.events[0].messageType, 1);
});

test('text and face PNG segments preserve ordering; the face is honestly reported as a type 3 image', async t => {
  const f = fixture(t);
  const sent = await f.backend.sendMessage(message(text('前面'), media(png, 'image/png', 'face'), text('后面')));
  assert.deepEqual(f.calls.map(c => c.cmd), [522, 110, 522]);
  assert.deepEqual(f.events.map(e => e.messageType), [1, 3, 1]);
  assert.equal(f.events[1].message[0].type, 'image'); assert.equal(sent.serverMessageIds.length, 3);
});

for (const [name, segment, code] of [
  ['noncanonical base64', { type: 'image', data: { base64: 'Zh==', mediaType: 'image/png' } }, 'ERR_INVALID_PARAMS'],
  ['malformed base64', { type: 'image', data: { base64: '***=', mediaType: 'image/png' } }, 'ERR_INVALID_PARAMS'],
  ['invalid image signature', media(Buffer.from('not an image')), 'ERR_IMAGE_FORMAT'],
  ['MIME mismatch', media(png, 'image/jpeg'), 'ERR_INVALID_PARAMS'],
  ['unsupported GIF', media(Buffer.from('GIF89a0123456789'), 'image/gif'), 'ERR_UNSUPPORTED_IMAGE'],
  ['unsupported WebP', media(Buffer.from('RIFF0000WEBP012345'), 'image/webp'), 'ERR_UNSUPPORTED_IMAGE'],
  ['file reference', { type: 'image', data: { file: 'C:\\private\\secret.png' } }, 'ERR_INVALID_PARAMS'],
]) test(`${name} rejects the whole reply before its text is sent`, async t => {
  const f = fixture(t);
  await assert.rejects(async () => f.backend.sendMessage(message(text('do not send first'), segment)), { code });
  assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
});

test('missing image credential rejects a mixed reply before any text is sent', async t => {
  const f = fixture(t, undefined, false);
  await assert.rejects(async () => f.backend.sendMessage(message(text('do not send first'), media())), error => error.code === 'ERR_IMAGE_CREDENTIAL' && !error.message.includes('重新扫码') && error.details.delivery === 'rejected');
  assert.equal(f.calls.length, 0);
  const sent = await f.backend.sendMessage(message(text('text still works')));
  assert.equal(sent.messageType, 1);
});

test('a real native QR credential shape sends text and a multi-chunk image without a heartbeat capture', async t => {
  const qr = nativeQrSession(api), f = fixture(t, undefined, false, qr);
  assert.equal(f.backend.session.publicStatus().heartbeatAvailable, false);
  assert.equal(f.backend.session.publicStatus().imageUploadAvailable, true);
  const sent = await f.backend.sendMessage(message(text('前面的文字'), media(bigPng)));
  assert.deepEqual(f.calls.map(call => call.cmd), [522, 110, 110, 110]);
  assert.deepEqual(f.events.map(event => event.messageType), [1, 3]);
  assert.equal(sent.delivery, 'server-ack'); assert.equal(sent.serverMessageIds.length, 2);
  for (const call of f.calls.filter(call => call.cmd === 110)) {
    const base = fields(bytes(fields(call.body), 1));
    assert.deepEqual(bytes(base, 1), qr.key); assert.equal(num(base, 2), 42n); assert.deepEqual(bytes(base, 3), qr.deviceId);
  }
});

test('an image cannot continue onto a replacement transport', async t => {
  const f = fixture(t, (_cmd, body, _n, backend) => { backend.transport = { connected: true, close() {} }; return imageAck(body); });
  await assert.rejects(async () => f.backend.sendMessage(message(media(bigPng))), error => error.code === 'ERR_CONNECTION_CLOSED' && error.details.delivery === 'unknown');
  assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
});

test('too many images rejects all segments before sending anything', async t => {
  const f = fixture(t);
  await assert.rejects(async () => f.backend.sendMessage(message(text('do not send first'), ...Array.from({ length: 9 }, () => media()))), { code: 'ERR_INVALID_PARAMS' });
  assert.equal(f.calls.length, 0);
});
