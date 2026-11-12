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
const entry = `export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol/backend.ts'))};
export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol/wire.ts'))};
export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol/stickers.ts'))};
export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol/file-upload.ts'))};
export * from ${JSON.stringify(path.join(root, 'backend/wechat/types.ts'))};`;
const build = await rolldown({ input: 'virtual:outbound-test', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') } }, plugins: [{ name: 'outbound-test', resolveId: id => id === 'virtual:outbound-test' ? id : null, load: id => id === 'virtual:outbound-test' ? entry : null }] });
let api;
try {
  const { output } = await build.generate({ format: 'esm' });
  assert.equal(output.length, 1);
  api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);
} finally { await build.close(); }
const { ProtocolBackend, BridgeError, fields, bytes, num, unstring, ld, fv, vi, readVi, encodeFrame, imageUploadRequest, imageUploadResponse, IMAGE_CHUNK_BYTES, FILE_CHUNK_BYTES, fileUploadRequest, fileUploadResponse, fileMessageRequest, fileMessageResponse, requestFileCgi, encodeCgiBody, decodeCgiBody } = api;
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
function imageWindowAck(body, overrides = {}) {
  const f = fields(body), remaining = Number(num(f, 5)) - Number(num(f, 6)) - Number(num(f, 7));
  return imageAck(body, { length: Math.min(65_536, remaining), ...overrides });
}
function textAck(body, id = '9007199254740901') {
  const f = fields(bytes(fields(body), 2));
  return Buffer.concat([ld(1, fv(1, 0)), fv(2, 1), ld(3, Buffer.concat([fv(4, num(f, 5)), fv(5, num(f, 4)), fv(6, 1700000000), fv(8, BigInt(id))]))]);
}
function attachAck(body, overrides = {}) {
  const f = fields(body), item = { ret: 0, clientId: bytes(f, 4).toString(), from: bytes(f, 5).toString(), total: Number(num(f, 6)), offset: Number(num(f, 7)) + Number(num(f, 8)), length: Number(num(f, 8)), mediaId: 'fixture-media-id', ...overrides };
  return Buffer.concat([ld(1, fv(1, item.ret)), ...(item.mediaId ? [ld(3, item.mediaId)] : []), ld(4, item.clientId), ld(5, item.from), fv(6, item.total), fv(7, item.offset), fv(8, item.length), fv(9, 1700000000)]);
}
function appAck(body, overrides = {}) {
  const f = fields(bytes(fields(body), 2)), item = { ret: 0, from: bytes(f, 1).toString(), to: bytes(f, 4).toString(), clientId: bytes(f, 8).toString(), type: 6, id: '9007199254740997', ...overrides };
  return Buffer.concat([ld(1, fv(1, item.ret)), ld(3, item.from), ld(4, item.to), ld(6, item.clientId), fv(7, 1700000000), fv(8, item.type), ...(item.id ? [fv(9, BigInt(item.id))] : [])]);
}
// Synthetic server format observed in upload-only PC probes: the reply echoes
// the request checksum. Fixtures contain no operator packets or credentials.
function shortlinkAck(account, cmd, requestBody, responseBody, overrideChecksum) {
  const key = account.body_key ? Buffer.from(account.body_key, 'hex') : undefined, s08 = account.s08 ? Buffer.from(account.s08, 'hex') : undefined;
  const request = encodeCgiBody(cmd, requestBody, account.uin, account.token, key, s08), response = encodeCgiBody(cmd, responseBody, account.uin, account.token, key, s08);
  const values = packet => { let offset = 26; const values = []; for (let index = 0; index < 6; index++) { let value; [value, offset] = readVi(packet, offset); values.push(value); } return { values, offset }; };
  const original = values(request), reply = values(response), oldLength = response[1] >> 2;
  reply.values[4] = 0n; reply.values[5] = overrideChecksum ?? original.values[5];
  const header = Buffer.concat([response.subarray(0, 26), ...reply.values.map(vi), response.subarray(reply.offset, oldLength)]);
  header[1] = header.length * 4 + (response[1] & 3);
  return Buffer.concat([header, response.subarray(oldLength)]);
}
function fixture(t, respond = (cmd, body) => cmd === 110 ? imageAck(body) : cmd === 220 ? attachAck(body) : cmd === 222 ? appAck(body) : textAck(body), withBase = true, qr) {
  const tempRoot = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(tempRoot, 'wechat-outbound-test-'));
  const sessionFile = path.join(dir, 'session.json'), cacheDir = path.join(dir, 'cache');
  fs.writeFileSync(sessionFile, JSON.stringify(qr?.credential ?? { uin: 123, token: 'aa'.repeat(15), wxid: 'wxid_fixture', nickname: '测试账号', sync_key: fv(1, 0).toString('hex'), ...(withBase ? { heartbeat_base_request: Buffer.concat([ld(1, 'fake-session'), fv(2, 123)]).toString('hex') } : {}) }));
  if (qr) writeNativeQrRound(dir, qr);
  const backend = new ProtocolBackend({ sessionFile, cacheDir, syncIntervalMs: 60000, heartbeatIntervalMs: 60000, requestTimeoutMs: 1000, reconnectMs: 1000, sendIntervalMs: 0, sendJitterMs: 0, segmentBytes: 4096 });
  const calls = [], events = [];
  backend.controller = new AbortController(); backend.online = true;
  backend.transport = { connected: true, tx: 0, rx: 0, request: async (cmd, body) => { calls.push({ cmd, body }); return respond(cmd, body, calls.length, backend); }, close() { this.connected = false; } };
  backend.fileRequest = async (_account, cmd, body) => { calls.push({ cmd, body }); return respond(cmd, body, calls.length, backend); };
  backend.stickerRequest = async (_account, cmd, body) => { calls.push({ cmd, body }); return respond(cmd, body, calls.length, backend); };
  backend.subscribe(event => { if (event.type === 'event.message') events.push(event.payload); });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(dir), tempRoot); assert.match(path.basename(dir), /^wechat-outbound-test-/); fs.rmSync(dir, { recursive: true, force: true }); });
  return { backend, calls, events, cache: () => fs.readFileSync(path.join(cacheDir, `${backend.session.value.uin}.json`), 'utf8') };
}

test('multi-chunk arbitrary file is only delivered after SendAppMsg ACK, preserving bytes, name and metadata', async t => {
  const f = fixture(t), content = Buffer.alloc(120013, 0xa7), name = 'DSH 成果 & 报告.docx';
  const result = await f.backend.sendMessage(message({ type: 'file', data: { name, base64: content.toString('base64') } }));
  assert.deepEqual(f.calls.map(call => call.cmd), [220, 220, 220, 222]);
  const uploads = f.calls.filter(call => call.cmd === 220); assert.equal(new Set(uploads.map(call => bytes(fields(call.body), 4).toString())).size, 1);
  assert.deepEqual(Buffer.concat(uploads.map(call => bytes(fields(bytes(fields(call.body), 9)), 2))), content);
  assert.equal(num(fields(uploads[0].body), 10), 4n); assert.equal(FILE_CHUNK_BYTES, 50000);
  const app = fields(bytes(fields(f.calls.at(-1).body), 2)); assert.equal(num(app, 5), 6n);
  assert.match(bytes(app, 6).toString(), /DSH 成果 &amp; 报告.docx/); assert.match(bytes(app, 6).toString(), /<attachid>fixture-media-id<\/attachid>/);
  assert.equal(result.messageType, 49); assert.equal(result.message[0].type, 'file'); assert.equal(result.message[0].data.name, name); assert.equal(result.message[0].data.bytes, content.length);
  assert.equal(result.message[0].data.base64, undefined); assert.equal(result.delivery, 'server-ack'); assert.equal(f.events.length, 1);
  assert.equal(result.deliveryParts[0].state, 'acknowledged'); assert.equal(result.deliveryParts[0].name, name); assert.equal(f.backend.queuedMediaBytes, 0); assert(!f.cache().includes('base64')); assert(!f.cache().includes('fixture-media-id'));
});

for (const [name, override] of [['client identity', { clientId: 'wrong' }], ['account', { from: 'foreign' }], ['total size', { total: 1 }], ['offset', { offset: 1 }], ['length', { length: 1 }], ['final attachment ID', { mediaId: '' }]]) test(`file upload with wrong ${name} never sends a file message`, async t => {
  const f = fixture(t, (_cmd, body) => attachAck(body, override));
  await assert.rejects(() => f.backend.sendMessage(message({ type: 'file', data: { name: 'result.pdf', base64: Buffer.from('PDF').toString('base64') } })), error => error.code === 'ERR_FILE_PROTOCOL' && error.details.deliveryParts[0].state === 'not-sent');
  assert.deepEqual(f.calls.map(call => call.cmd), [220]); assert.equal(f.events.length, 0);
});

for (const [name, override] of [['sender', { from: 'foreign' }], ['recipient', { to: 'foreign@chatroom' }], ['client identity', { clientId: 'wrong' }], ['message type', { type: 1 }], ['message ID', { id: undefined }]]) test(`file message with wrong ${name} remains unknown and is not retried`, async t => {
  const f = fixture(t, (cmd, body) => cmd === 220 ? attachAck(body) : appAck(body, override));
  await assert.rejects(() => f.backend.sendMessage(message({ type: 'file', data: { name: 'result.zip', base64: Buffer.from('ZIP').toString('base64') } })), error => error.code === 'ERR_FILE_PROTOCOL' && error.details.deliveryParts[0].state === 'unknown');
  assert.deepEqual(f.calls.map(call => call.cmd), [220, 222]); assert.equal(f.events.length, 0);
});

test('cancellation after uploading a file never submits its recipient message', async t => {
  const cancel = new AbortController(), f = fixture(t, (cmd, body) => { assert.equal(cmd, 220); cancel.abort(); return attachAck(body); });
  await assert.rejects(() => f.backend.sendMessage(message({ type: 'file', data: { name: 'result.txt', base64: Buffer.from('result').toString('base64') } }), cancel.signal));
  assert.deepEqual(f.calls.map(call => call.cmd), [220]); assert.equal(f.events.length, 0);
});

test('cancellation during final file message preserves its real ACK', async t => {
  const cancel = new AbortController(), f = fixture(t, (cmd, body) => { if (cmd === 220) return attachAck(body); cancel.abort(); return appAck(body); });
  const result = await f.backend.sendMessage(message({ type: 'file', data: { name: 'result.txt', base64: Buffer.from('result').toString('base64') } }), cancel.signal);
  assert.equal(result.delivery, 'server-ack'); assert.equal(result.deliveryParts[0].state, 'acknowledged'); assert.equal(f.events.length, 1);
});

test('confirmed text is retained if a later file message times out and following image is not sent', async t => {
  const f = fixture(t, (cmd, body) => { if (cmd === 522) return textAck(body); if (cmd === 220) return attachAck(body); throw new BridgeError('ERR_ACK_TIMEOUT', 'file ACK missing', { delivery: 'unknown' }); });
  await assert.rejects(() => f.backend.sendMessage(message(text('结果摘要'), { type: 'file', data: { name: 'report.xlsx', base64: Buffer.from('xlsx').toString('base64') } }, media())), error => {
    assert.equal(error.details.delivery, 'partially-acknowledged'); assert.deepEqual(error.details.deliveryParts.map(part => part.state), ['acknowledged', 'unknown', 'not-sent']); return true;
  });
  assert.deepEqual(f.calls.map(call => call.cmd), [522, 220, 222]); assert.equal(f.events.length, 1);
});

test('file references and unsafe names fail before the first text, and files need authenticated base material', async t => {
  const f = fixture(t);
  for (const data of [{ name: 'result.pdf', file: 'C:/private/result.pdf' }, { name: '../secret.txt', base64: 'YQ==' }, { name: 'result.txt', base64: 'Zh==' }])
    await assert.rejects(async () => f.backend.sendMessage(message(text('do not send'), { type: 'file', data })), { code: 'ERR_INVALID_PARAMS' });
  assert.equal(f.calls.length, 0);
  const missing = fixture(t, undefined, false); await assert.rejects(async () => missing.backend.sendMessage(message(text('do not send'), { type: 'file', data: { name: 'result.txt', base64: 'YQ==' } })), { code: 'ERR_FILE_CREDENTIAL' }); assert.equal(missing.calls.length, 0);
});

test('file shortlink uses encrypted fixed CGI routes and validates account and command without retry', async () => {
  const account = { uin: 123, wxid: 'fixture', token: 'aa'.repeat(15) }, upload = { clientId: 'fixture-file', from: account.wxid, total: 3, md5: 'a'.repeat(32), baseRequest: fv(2, 123) };
  const body = fileUploadRequest(upload, 0, Buffer.from('abc')); let calls = 0;
  const fetched = await requestFileCgi(account, 220, body, new AbortController().signal, async (url, options) => {
    calls++; assert.equal(url, 'http://short.weixin.qq.com/cgi-bin/micromsg-bin/uploadappattach'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.deepEqual(decodeCgiBody(options.body).body, body);
    return new Response(encodeCgiBody(220, attachAck(body), 123, account.token));
  });
  assert.equal(fileUploadResponse(fetched, upload, 0, 3).mediaId, 'fixture-media-id'); assert.equal(calls, 1);
  await assert.rejects(() => requestFileCgi(account, 220, body, new AbortController().signal, async () => new Response(encodeCgiBody(220, attachAck(body), 999, account.token))), { code: 'ERR_FILE_PROTOCOL' });
});

test('PC shortlink binds echoed request checksums and consumed cursor acknowledgements for every file chunk', async () => {
  const account = { uin: 123, wxid: 'fixture', token: 'aa'.repeat(15), body_key: '11'.repeat(16), s08: '22'.repeat(16) };
  const content = Buffer.alloc(FILE_CHUNK_BYTES + 13, 0xa7), upload = { clientId: 'pc-file', from: account.wxid, total: content.length, md5: 'a'.repeat(32), baseRequest: fv(2, 123) };
  let calls = 0;
  for (let start = 0; start < content.length; start += FILE_CHUNK_BYTES) {
    const chunk = content.subarray(start, start + FILE_CHUNK_BYTES), body = fileUploadRequest(upload, start, chunk);
    const response = await requestFileCgi(account, 220, body, new AbortController().signal, async () => {
      calls++; return new Response(shortlinkAck(account, 220, body, attachAck(body, { length: 0 })));
    });
    assert.equal(fileUploadResponse(response, upload, start, chunk.length).complete, start + chunk.length === content.length);
  }
  assert.equal(calls, 2);
});

for (const total of [50_469, 170_013]) test(`PC file upload windows retain exact identity and cursor for ${total} bytes`, async t => {
  const content = Buffer.alloc(total, 0xa7), f = fixture(t, (cmd, body) => {
    if (cmd !== 220) return appAck(body);
    const fieldsIn = fields(body), start = Number(num(fieldsIn, 7)), length = Number(num(fieldsIn, 8)), remaining = total - start - length;
    // The observed 50,469-byte Word reports 50,000/469 after both requests:
    // next-window ACK first, echoed final chunk with an attachment ID last.
    return attachAck(body, remaining ? { length: Math.min(65_536, remaining), mediaId: '' }
      : { offset: start, length });
  });
  const result = await f.backend.sendMessage(message({ type: 'file', data: { name: 'result.docx', base64: content.toString('base64') } }));
  assert.equal(result.deliveryParts[0].state, 'acknowledged');
  assert.equal(result.serverMessageId, '9007199254740997');
  assert.equal(f.calls.at(-1).cmd, 222);
  assert.deepEqual(Buffer.concat(f.calls.filter(call => call.cmd === 220).map(call => bytes(fields(bytes(fields(call.body), 9)), 2))), content);
});

for (const override of [{ offset: 49_999, length: 469 }, { length: 470 }, { clientId: 'foreign', length: 469 }, { from: 'foreign', length: 469 }, { total: 50_470, length: 469 }])
  test(`invalid PC file window ${JSON.stringify(override)} cannot send an attachment`, async t => {
    const f = fixture(t, (_cmd, body) => attachAck(body, override));
    await assert.rejects(() => f.backend.sendMessage(message({ type: 'file', data: { name: 'result.docx', base64: Buffer.alloc(50_469).toString('base64') } })), error =>
      error.code === 'ERR_FILE_PROTOCOL' && error.details.deliveryParts[0].state === 'not-sent');
    assert.deepEqual(f.calls.map(call => call.cmd), [220]); assert.equal(f.events.length, 0);
  });

test('PC file upload accepts the full remaining length from the live 151135-byte Word response', async t => {
  const content = Buffer.alloc(151135, 0xa7), f = fixture(t, (cmd, body) => {
    if (cmd !== 220) return appAck(body);
    const input = fields(body), end = Number(num(input, 7)) + Number(num(input, 8)), remaining = content.length - end;
    return attachAck(body, { length: remaining, mediaId: remaining ? '' : 'fixture-media-id' });
  });
  const result = await f.backend.sendMessage(message({ type: 'file', data: { name: 'roundtrip.docx', base64: content.toString('base64') } }));
  assert.equal(result.delivery, 'server-ack'); assert.deepEqual(f.calls.map(call => call.cmd), [220, 220, 220, 220, 222]);
  const upload = { clientId: 'fixture-upload', from: 'fixture-self', total: content.length, md5: 'a'.repeat(32), baseRequest: fv(2, 123) };
  const body = fileUploadRequest(upload, 0, content.subarray(0, FILE_CHUNK_BYTES));
  for (const override of [{ length: 101134 }, { length: 101136 }, { offset: 49999, length: 101135 }])
    assert.throws(() => fileUploadResponse(attachAck(body, override), upload, 0, FILE_CHUNK_BYTES), { code: 'ERR_FILE_PROTOCOL' });
});

test('files above 20 MiB, aggregate replies above 20 MiB and queues above 64 MiB preserve all bytes and final ACKs', async t => {
  const f = fixture(t), content = Buffer.alloc(22 * 1024 * 1024 + 13, 0xa7);
  const segment = name => ({ type: 'file', data: { name, base64: content.toString('base64') } });
  const first = f.backend.sendMessage(message(segment('first.zip'), segment('second.zip')));
  const second = f.backend.sendMessage(message(segment('third.zip')));
  assert(f.backend.queuedMediaBytes > 64 * 1024 * 1024);
  const results = await Promise.all([first, second]);
  assert.equal(results[0].deliveryParts.length, 2); assert.equal(results[1].deliveryParts.length, 1);
  assert(results.every(result => result.deliveryParts.every(part => part.state === 'acknowledged' && part.bytes === content.length)));
  const uploads = f.calls.filter(call => call.cmd === 220), clientIds = new Set(uploads.map(call => bytes(fields(call.body), 4).toString()));
  assert.equal(clientIds.size, 3);
  for (const clientId of clientIds) assert.deepEqual(Buffer.concat(uploads.filter(call => bytes(fields(call.body), 4).toString() === clientId)
    .map(call => bytes(fields(bytes(fields(call.body), 9)), 2))), content);
  assert.equal(f.calls.filter(call => call.cmd === 222).length, 3); assert.equal(f.backend.queuedMediaBytes, 0);
});

test('an echoed checksum from another shortlink request cannot confirm a file and is never retried', async () => {
  const account = { uin: 123, wxid: 'fixture', token: 'aa'.repeat(15) }, upload = { clientId: 'pc-file', from: account.wxid, total: 3, md5: 'a'.repeat(32), baseRequest: fv(2, 123) };
  const body = fileUploadRequest(upload, 0, Buffer.from('abc')); let calls = 0;
  await assert.rejects(() => requestFileCgi(account, 220, body, new AbortController().signal, async () => {
    calls++; return new Response(shortlinkAck(account, 220, body, attachAck(body, { length: 0 }), 1n));
  }), { code: 'ERR_FILE_PROTOCOL' });
  assert.equal(calls, 1);
});

test('PC SendAppMsg response checksum remains bound to the actual message request and its final identity ACK', async () => {
  const account = { uin: 123, wxid: 'fixture', token: 'aa'.repeat(15) };
  const file = { clientId: 'pc-file-message', from: account.wxid, to: 'synthetic-peer', total: 3, md5: 'a'.repeat(32), baseRequest: fv(2, 123), mediaId: 'fixture-media-id', name: 'result.txt', time: 1700000000 };
  const body = fileMessageRequest(file), response = await requestFileCgi(account, 222, body, new AbortController().signal,
    async () => new Response(shortlinkAck(account, 222, body, appAck(body))));
  assert.equal(fileMessageResponse(response, file).id, '9007199254740997');
});

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

test('consumed image cursors with zero data length only confirm delivery after the final message ID', async t => {
  const f = fixture(t, (_cmd, body, _number, backend) => {
    assert.equal(backend.status().diagnostics.sent, 0); assert.equal(f.events.length, 0);
    return imageAck(body, { length: 0 });
  });
  const sent = await f.backend.sendMessage(message(media(bigPng)));
  assert.equal(f.calls.length, Math.ceil(bigPng.length / IMAGE_CHUNK_BYTES));
  assert.deepEqual(Buffer.concat(f.calls.map(call => bytes(fields(bytes(fields(call.body), 8)), 2))), bigPng);
  assert.equal(sent.delivery, 'server-ack'); assert.deepEqual(sent.serverMessageIds, ['9007199254740999']);
  assert.equal(sent.deliveryParts[0].state, 'acknowledged'); assert.equal(f.events.length, 1);
});

test('PC image ACK advertises the next window clipped to remaining bytes, ending at zero with a final message ID', async t => {
  const f = fixture(t, (_cmd, body, _number, backend) => {
    assert.equal(backend.status().diagnostics.sent, 0); assert.equal(f.events.length, 0);
    return imageWindowAck(body);
  });
  const sent = await f.backend.sendMessage(message(media(bigPng)));
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(call => Number(num(fields(call.body), 7))), [50_000, 50_000, bigPng.length - 100_000]);
  assert.deepEqual(Buffer.concat(f.calls.map(call => bytes(fields(bytes(fields(call.body), 8)), 2))), bigPng);
  assert.equal(sent.delivery, 'server-ack'); assert.equal(sent.deliveryParts[0].state, 'acknowledged');
  assert.deepEqual(sent.serverMessageIds, ['9007199254740999']); assert.equal(f.events.length, 1);
});

for (const [name, override] of [
  ['client image ID', { clientId: 'different' }], ['recipient', { to: 'wrong-group@chatroom' }], ['sender', { from: 'other-account' }],
  ['total length', { total: 1 }], ['chunk length', { length: 1 }], ['chunk offset', { start: 42 }],
  ['unconsumed zero-length chunk', { start: 0, length: 0 }], ['wrong consumed cursor', { start: 42, length: 0 }],
  ['unconsumed 64 KiB window', { start: 0, length: 65_536 }], ['wrong cursor with 64 KiB window', { start: 42, length: 65_536 }],
  ['unrecognized upload window', { length: 65_535 }],
]) test(`mismatched ${name} stops uploading without reporting a delivered image`, async t => {
  const f = fixture(t, (_cmd, body) => imageAck(body, override));
  await assert.rejects(async () => f.backend.sendMessage(message(media(bigPng))), error => error.code === 'ERR_PROTOCOL' && error.details.delivery === 'unknown' && error.details.acknowledgedMessageIds.length === 0);
  assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
});

for (const [name, override] of [['chunk echo', {}], ['consumed zero-length cursor', { length: 0 }], ['next upload window', { nextWindow: true }]]) test(`missing final image ID after ${name} stays unknown and is never retried`, async t => {
  const f = fixture(t, (_cmd, body) => override.nextWindow ? imageWindowAck(body, { id: undefined }) : imageAck(body, { ...override, id: undefined }));
  await assert.rejects(async () => f.backend.sendMessage(message(media(bigPng))), error => error.code === 'ERR_PROTOCOL' && error.details.delivery === 'unknown');
  assert.equal(f.calls.length, 3); assert.equal(f.events.length, 0); assert.equal(f.backend.status().diagnostics.sent, 0);
});

test('a nonzero image status remains rejected, with no false confirmation', async t => {
  const f = fixture(t, (_cmd, body) => imageAck(body, { ret: -3 }));
  await assert.rejects(async () => f.backend.sendMessage(message(media())), error => error.code === 'ERR_SEND_REJECTED' && error.details.ret === -3 && error.details.delivery === 'rejected' && error.details.deliveryParts[0].state === 'not-sent');
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
  await assert.rejects(async () => f.backend.sendMessage(message(text('已确认的文字'), media())), error => error.details.delivery === 'partially-acknowledged' && error.details.acknowledgedMessageIds[0] === '9007199254740901' && error.details.deliveryParts[1].state === 'not-sent');
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

const nativeMd5 = 'a'.repeat(32), nativeFace = (fallback = true) => ({ type: 'face', data: { nativeSticker: { md5: nativeMd5 }, ...(fallback ? media().data : {}) } });
function stickerAck(body, overrides = {}) {
  const item = fields(bytes(fields(body), 3));
  const value = { ret: 0, md5: bytes(item, 1).toString(), start: 1, total: 1, id: '9007199254740998', ...overrides };
  return Buffer.concat([ld(1, fv(1, 0)), fv(2, 1), ld(3, Buffer.concat([fv(1, value.ret), fv(2, value.start), fv(3, value.total), ld(4, value.md5), ...(value.id ? [fv(6, BigInt(value.id))] : [])]))]);
}
function stickerPage(md5s, index = md5s.length, complete = true) {
  return Buffer.concat([ld(1, fv(1, 0)), fv(2, index), ...md5s.map(md5 => ld(3, md5)), fv(4, complete ? 1 : 0),
    ...md5s.map(md5 => ld(5, Buffer.concat([ld(1, md5), ld(2, 'https://weixin.qq.com/private-sticker-token/' + md5)])))]);
}
test('native favorite sends a real type-47 sticker with a matching full ACK and no image upload', async t => {
  const f = fixture(t, (cmd, body) => { assert.equal(cmd, 175); return stickerAck(body); });
  const result = await f.backend.sendMessage(message(nativeFace()));
  assert.deepEqual(f.calls.map(call => call.cmd), [175]); assert.equal(result.messageType, 47);
  assert.equal(result.source, 'shortlink:SendEmoji'); assert.equal(result.deliveryParts[0].type, 'face');
  assert.equal(result.deliveryParts[0].state, 'acknowledged'); assert.equal(result.serverMessageIds[0], '9007199254740998');
  assert(!f.cache().includes('base64')); assert.equal(f.backend.queuedMediaBytes, 0);
});
test('explicit native rejection falls back to one saved image without repeating acknowledged text', async t => {
  const f = fixture(t, (cmd, body) => cmd === 175 ? stickerAck(body, { ret: -2 }) : cmd === 110 ? imageAck(body) : textAck(body));
  const result = await f.backend.sendMessage(message(text('好呀'), nativeFace()));
  assert.deepEqual(f.calls.map(call => call.cmd), [522, 175, 110]);
  assert.deepEqual(result.deliveryParts.map(part => part.type), ['text', 'image']);
  assert.equal(result.deliveryParts[1].nativeFallback, true); assert.deepEqual(f.events.map(event => event.messageType), [1, 3]);
});
for (const [label, overrides] of [['wrong digest', { md5: 'b'.repeat(32) }], ['incomplete transfer', { start: 0 }], ['missing ID', { id: undefined }], ['overflow ID', { id: '18446744073709551616' }]])
  test(`native ${label} never falls back or retries an uncertain send`, async t => {
    const f = fixture(t, (_cmd, body) => stickerAck(body, overrides));
    await assert.rejects(() => f.backend.sendMessage(message(nativeFace())), error => error.details.deliveryParts[0].state === 'unknown');
    assert.deepEqual(f.calls.map(call => call.cmd), [175]); assert.equal(f.events.length, 0);
  });
test('native timeout never becomes an image retry and preserves preceding text confirmation', async t => {
  const f = fixture(t, (cmd, body) => { if (cmd === 522) return textAck(body); throw new BridgeError('ERR_ACK_TIMEOUT', 'fixture timeout'); });
  await assert.rejects(() => f.backend.sendMessage(message(text('先回一句'), nativeFace())), error => error.details.delivery === 'partially-acknowledged' && error.details.acknowledgedMessageIds.length === 1);
  assert.deepEqual(f.calls.map(call => call.cmd), [522, 175]);
});
test('native-only references work without preview bytes and explicit rejection is reported without fabricating an image', async t => {
  const f = fixture(t, (_cmd, body) => stickerAck(body));
  assert.equal((await f.backend.sendMessage(message(nativeFace(false)))).messageType, 47);
  const rejected = fixture(t, (_cmd, body) => stickerAck(body, { ret: -2 }));
  await assert.rejects(() => rejected.backend.sendMessage(message(nativeFace(false))), { code: 'ERR_STICKER_REJECTED' });
  assert.deepEqual(rejected.calls.map(call => call.cmd), [175]);
});
test('native ACK that races cancellation is retained, while cancellation after rejection prevents image fallback', async t => {
  const cancel = new AbortController(), f = fixture(t, (_cmd, body) => { cancel.abort(); return stickerAck(body); });
  assert.equal((await f.backend.sendMessage(message(nativeFace()), cancel.signal)).delivery, 'server-ack');
  const abort = new AbortController(), rejected = fixture(t, (_cmd, body) => { abort.abort(); return stickerAck(body, { ret: -2 }); });
  await assert.rejects(() => rejected.backend.sendMessage(message(nativeFace()), abort.signal));
  assert.deepEqual(rejected.calls.map(call => call.cmd), [175]);
});
test('native favorites paginate completely while keeping private resource URLs inside the backend', async t => {
  const other = 'b'.repeat(32), f = fixture(t, (cmd, body) => { assert.equal(cmd, 697); return num(fields(body), 1) === 0n ? stickerPage([nativeMd5], 1, false) : stickerPage([other], 2); });
  const list = await f.backend.readStickers(new AbortController().signal);
  assert.equal(list.complete, true); assert.equal(list.items.length, 2); assert.equal(list.items[0].previewAvailable, true);
  assert(!JSON.stringify(list).includes('private-sticker-token')); assert.deepEqual(f.calls.map(call => Number(num(fields(call.body), 1))), [0, 1]);
  const saved = f.backend.stickerResources;
  f.backend.stickerRequest = async () => stickerPage([nativeMd5], 0, false);
  await assert.rejects(() => f.backend.readStickers(new AbortController().signal), { code: 'ERR_STICKER_PROTOCOL' });
  assert.equal(f.backend.stickerResources, saved);
});
test('favorite read rejects a changed account before committing its private URL map', async t => {
  const f = fixture(t, (_cmd, _body, _n, backend) => { backend.session.value.wxid = 'changed-account'; return stickerPage([nativeMd5]); });
  await assert.rejects(() => f.backend.readStickers(new AbortController().signal), { code: 'ERR_STICKER_ACCOUNT_CHANGED' });
  assert.equal(f.backend.stickerResources.size, 0);
});
test('native collection rereads favorites before claiming success and does not call a deletion opcode', async t => {
  let reads = 0;
  const f = fixture(t, cmd => cmd === 697 ? stickerPage(++reads === 1 ? [] : [nativeMd5]) : ld(1, fv(1, 0)));
  assert.deepEqual(await f.backend.favoriteSticker(nativeMd5, new AbortController().signal), { saved: true, alreadyFavorite: false });
  assert.deepEqual(f.calls.map(call => call.cmd), [697, 696, 697]); assert.equal(bytes(fields(f.calls[1].body), 1).toString(), nativeMd5);
  const already = fixture(t, () => stickerPage([nativeMd5]));
  assert.equal((await already.backend.favoriteSticker(nativeMd5, new AbortController().signal)).alreadyFavorite, true);
  assert.deepEqual(already.calls.map(call => call.cmd), [697]);
});
for (const needsUpload of [true, false]) test(`unconfirmed collection reports ${needsUpload ? 'needs upload' : 'unknown'} instead of pretending to save`, async t => {
  const f = fixture(t, cmd => cmd === 697 ? stickerPage([]) : Buffer.concat([ld(1, fv(1, 0)), ...(needsUpload ? [ld(2, nativeMd5)] : [])]));
  await assert.rejects(() => f.backend.favoriteSticker(nativeMd5, new AbortController().signal), { code: needsUpload ? 'ERR_STICKER_UPLOAD_REQUIRED' : 'ERR_STICKER_FAVORITE_UNKNOWN' });
  assert.deepEqual(f.calls.map(call => call.cmd), [697, 696, 697]);
});
test('native list codecs reject malformed fields, duplicate identifiers and missing completion markers', () => {
  const valid = stickerPage([nativeMd5]);
  for (const body of [Buffer.concat([valid, fv(4, 1)]), stickerPage([nativeMd5, nativeMd5]), Buffer.concat([ld(1, fv(1, 0)), fv(2, 0)]), stickerPage(['not-an-md5'])])
    assert.throws(() => api.stickerListResponse(body), { code: 'ERR_STICKER_PROTOCOL' });
  assert.throws(() => api.stickerListRequest(-1), { code: 'ERR_STICKER_QUERY' });
});
test('native CGI accepts validated request-echo and content checksums, rejects another account and never retries', async () => {
  const account = { uin: 123, wxid: 'fixture', token: 'aa'.repeat(15) }, body = api.stickerListRequest(), response = stickerPage([nativeMd5]);
  for (const echo of [true, false]) {
    let calls = 0;
    const result = await api.requestStickerCgi(account, 697, body, new AbortController().signal, async (url, options) => {
      calls++; assert(url.endsWith('/mmbatchemojidownload')); assert.equal(options.redirect, 'error');
      return new Response(echo ? shortlinkAck(account, 697, body, response) : encodeCgiBody(697, response, account.uin, account.token));
    });
    assert.equal(calls, 1); assert.deepEqual(result, response);
  }
  let calls = 0;
  await assert.rejects(() => api.requestStickerCgi(account, 697, body, new AbortController().signal, async () => { calls++; return new Response(encodeCgiBody(697, response, 124, account.token)); }), { code: 'ERR_STICKER_PROTOCOL' });
  assert.equal(calls, 1);
});
