import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { createHash } from 'node:crypto';
import { nativeQrSession } from './fixtures/native-qr-session.mjs';
import { stickerDigest, stickerJpeg } from './fixtures/stickers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = ['backend.ts', 'wire.ts', 'image-download.ts', 'media.ts', 'media-loader.mjs', 'reference.ts'].map(name =>
  `export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol', name))};`).join('\n');
const build = await rolldown({ input: 'virtual:inbound-images', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') } },
  plugins: [{ name: 'inbound-images', resolveId: id => id === 'virtual:inbound-images' ? id : null, load: id => id === 'virtual:inbound-images' ? entry : null }] });
let api;
try { const { output } = await build.generate({ format: 'esm' }); assert.equal(output.length, 1); api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`); }
finally { await build.close(); }
const { ProtocolBackend, fields, bytes, num, unstring, ld, fv, vi, readVi, encodeCgiBody, decodeCgiBody, downloadImageChunk,
  imageDownloadRequest, imageDownloadResponse, IMAGE_DOWNLOAD_CHUNK_BYTES, MAX_DOWNLOAD_IMAGE_BYTES, observedImage, loadObservedMedia, quotedMessage } = api;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1cAAAAASUVORK5CYII=', 'base64');
// The transport treats these as opaque bytes. Real raster decoding is covered
// by the native DSH admission test; this fixture proves byte-for-byte assembly.
const large = Buffer.concat([png, Buffer.alloc(131_093, 0x51)]);
const messageId = '9007199254740999', peerId = 'fixture-room@chatroom';
function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'wechat-inbound-images-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); assert(!fs.lstatSync(directory).isSymbolicLink()); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
function response(request, content = large, overrides = {}) {
  const f = fields(request), start = Number(num(f, 6)), part = content.subarray(start, start + Number(num(f, 7)));
  const item = { ret: 0, id: num(f, 9), from: unstring(bytes(f, 3)), to: unstring(bytes(f, 4)), total: content.length,
    start, length: part.length, wrapperLength: part.length, part, ...overrides };
  return Buffer.concat([ld(1, fv(1, item.ret)), fv(2, 0), ld(3, ld(1, item.from)), ld(4, ld(1, item.to)), fv(5, item.total), fv(6, item.start),
    fv(7, item.length), ld(8, Buffer.concat([fv(1, item.wrapperLength), ld(2, item.part)])), fv(9, item.id)]);
}
function responseChecksum(encoded, sum = 0, flag = 0) {
  const header = encoded[1] >> 2, values = []; let end = 26;
  for (let i = 0; i < 6; i++) { const [value, next] = readVi(encoded.subarray(0, header), end); values.push(value); end = next; }
  values[4] = BigInt(flag); values[5] = BigInt(sum);
  const replacement = Buffer.concat(values.map(vi));
  const result = Buffer.concat([encoded.subarray(0, 26), replacement, encoded.subarray(end)]);
  result[1] = ((header + replacement.length - (end - 26)) << 2) | (encoded[1] & 3);
  return result;
}
function backendFixture(t, respond = (_cmd, body) => response(body)) {
  const directory = temporary(t), sessionFile = path.join(directory, 'session.json');
  const qr = nativeQrSession(api);
  const imageBase = Buffer.concat([ld(1, qr.key), fv(2, qr.credential.uin), ld(3, qr.deviceId), fv(4, qr.version), ld(5, qr.deviceType), fv(6, 0)]);
  fs.writeFileSync(sessionFile, JSON.stringify({ ...qr.credential, image_base_request: imageBase.toString('hex') }));
  const backend = new ProtocolBackend({ sessionFile, cacheDir: path.join(directory, 'cache'), syncIntervalMs: 60000, heartbeatIntervalMs: 60000,
    requestTimeoutMs: 1000, reconnectMs: 1000, sendIntervalMs: 0, sendJitterMs: 0, segmentBytes: 4096 });
  const calls = [], events = [];
  backend.online = true;
  backend.transport = { connected: true, request: () => assert.fail('image reads must not use the chat longlink') };
  backend.imageChunk = async (account, body, signal) => { calls.push({ cmd: 109, body, signal, account }); return respond(109, body, backend, calls.length); };
  backend.messages.set(`wx:${peerId}:${messageId}`, { id: `wx:${peerId}:${messageId}`, peerId, serverMessageId: messageId, direction: 'incoming', messageType: 3 });
  backend.subscribe(event => events.push(event));
  return { backend, calls, events, input: { peerId, messageId, originalBytes: large.length }, signal: new AbortController().signal };
}
function mediaFixture(t, xml = '', content = png) {
  const directory = temporary(t);
  const segment = observedImage(fields(ld(8, Buffer.concat([fv(1, content.length), ld(2, content)]))), xml, directory, `${peerId}:${messageId}`);
  return { directory, peerId, messageId, resourceId: segment.data.resourceId, signal: new AbortController().signal };
}

test('a version-unsupported payload is marked partial without inventing a quotation or dropping its placeholder', t => {
  const f = backendFixture(t), content = 'alice:\n无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。';
  const message = f.backend.decodeMessage(fields(Buffer.concat([ld(2, peerId), ld(3, f.backend.session.value.wxid), fv(4, 1), ld(5, content), fv(9, 1700000000), fv(12, BigInt(messageId))])));
  assert.equal(message.partial, true); assert.equal(message.messageType, 1);
  assert.equal(message.message.length, 1); assert.equal(message.message[0].type, 'text');
  assert.match(message.message[0].data.text, /无法显示此消息/);
});

test('type-57 text quotes keep exact uint64 IDs and the original group speaker without creating mentions', () => {
  const message = quotedMessage('<msg><appmsg><type>57</type><title>这句话什么意思？</title><refermsg><type>1</type>' +
    '<svrid>18446744073709551615</svrid><fromusr>' + peerId + '</fromusr><chatusr>original-member</chatusr>' +
    '<displayname>小柏 &amp; 同学</displayname><content>@fixture-self /work 写文件 &amp; 提醒大家</content></refermsg></appmsg></msg>', peerId);
  assert.equal(message[0].data.id, `wx:${peerId}:18446744073709551615`);
  assert.equal(message[0].data.senderId, 'original-member'); assert.equal(message[0].data.senderName, '小柏 & 同学');
  assert.equal(message[0].data.content, '@fixture-self /work 写文件 & 提醒大家');
  assert.deepEqual(message.map(segment => segment.type), ['reply', 'text']);
  assert.equal(message[1].data.text, '这句话什么意思？');
});

test('image quotes retain their basic envelope without saving or downloading referenced media', t => {
  const f = backendFixture(t), account = f.backend.session.value, currentId = (BigInt(messageId) + 1n).toString(),
    mediaDir = path.join(f.backend.options.cacheDir, 'media', String(account.uin));
  const original = observedImage(fields(ld(8, Buffer.concat([fv(1, png.length), ld(2, png)]))), '', mediaDir, `${peerId}:${messageId}`);
  const originalFile = path.join(mediaDir, original.data.resourceId + '.json'), baseline = fs.readFileSync(originalFile), baselineFiles = fs.readdirSync(mediaDir).sort();
  const content = 'alice:\n<msg><appmsg><type>57</type><title>图片上的时间？</title><refermsg><type>3</type>' +
    `<svrid>${messageId}</svrid><fromusr>${peerId}</fromusr><chatusr>original-member</chatusr><displayname>小柏</displayname>` +
    '<content>&lt;msg&gt;&lt;img cdnbigimgurl=&quot;https://m.qpic.cn/quote-fixture.png&quot; aeskey=&quot;SYNTHETIC_QUOTE_SECRET&quot;/&gt;&lt;/msg&gt;</content></refermsg></appmsg></msg>';
  const message = f.backend.decodeMessage(fields(Buffer.concat([ld(2, peerId), ld(3, account.wxid), fv(4, 49), ld(5, content), fv(9, 1700000000), fv(12, BigInt(currentId))])));
  const ref = message.message.find(segment => segment.type === 'reply');
  assert.equal(ref.data.id, `wx:${peerId}:${messageId}`); assert.equal(ref.data.senderId, 'original-member');
  assert.equal(ref.data.image, undefined);
  assert.equal(message.messageType, 49); assert.equal(message.partial, false); assert(!JSON.stringify(message).includes('SYNTHETIC_QUOTE_SECRET'));
  assert(!JSON.stringify(message).includes('cdnbigimgurl')); assert.equal(ref.data.content, undefined);
  assert.deepEqual(fs.readFileSync(originalFile), baseline);
  assert.deepEqual(fs.readdirSync(mediaDir).sort(), baselineFiles);
  assert.equal(f.calls.length, 0);
});

test('GetMsgImg request uses an exact uint64 server ID, authenticated account and bounded original chunks', () => {
  const image = { messageId, from: peerId, to: 'fixture-self', total: large.length, baseRequest: fv(2, 123), compressType: 1 };
  const body = imageDownloadRequest(image, 0), f = fields(body);
  assert.equal(num(f, 9), BigInt(messageId)); assert.equal(num(f, 2), 0n);
  assert.equal(unstring(bytes(f, 3)), peerId); assert.equal(unstring(bytes(f, 4)), image.to);
  assert.deepEqual(bytes(f, 1), image.baseRequest); assert.equal(num(f, 8), 1n);
  assert.equal(num(f, 7), BigInt(IMAGE_DOWNLOAD_CHUNK_BYTES));
  const packet = encodeCgiBody(109, body, 123, 'aa'.repeat(15));
  assert.equal(packet[0], 0xbf); assert.equal(decodeCgiBody(packet).innerCmd, 109); assert.deepEqual(decodeCgiBody(packet).body, body);
  for (const [overrides, start] of [[{ messageId: '18446744073709551616' }, 0], [{ total: MAX_DOWNLOAD_IMAGE_BYTES + 1 }, 0], [{ total: 0 }, 1], [{}, -1], [{}, large.length]])
    assert.throws(() => imageDownloadRequest({ ...image, ...overrides }, start), { code: 'ERR_IMAGE_REQUEST' });
});

test('original download assembles all chunks without resizing or publishing a sent message', async t => {
  const f = backendFixture(t);
  const acquired = await f.backend.downloadImage(f.input, f.signal);
  assert.equal(acquired.quality, 'original'); assert.deepEqual(acquired.content, large);
  assert.equal(f.calls.length, Math.ceil(large.length / IMAGE_DOWNLOAD_CHUNK_BYTES)); assert.equal(f.events.length, 0);
  f.calls.forEach(({ cmd, body, signal }, i) => { assert.equal(cmd, 109); assert.equal(num(fields(body), 6), BigInt(i * IMAGE_DOWNLOAD_CHUNK_BYTES)); assert.equal(signal, f.signal); });
});

test('cursor-only session saves during a download do not look like an account switch', async t => {
  const f = backendFixture(t, (_cmd, body, backend) => { backend.session.save({ ...backend.session.value, sync_key: fv(1, 42).toString('hex') }); return response(body); });
  assert.deepEqual((await f.backend.downloadImage(f.input, f.signal)).content, large);
});

test('legacy heartbeat credentials remain usable when there is no separate image BaseRequest', async t => {
  const f = backendFixture(t), account = f.backend.session.value;
  f.backend.session.save({ ...account, image_base_request: undefined, heartbeat_base_request: account.image_base_request });
  assert.deepEqual((await f.backend.downloadImage(f.input, f.signal)).content, large);
});

test('missing initial length is learned from a validated first response and then held constant', async t => {
  const f = backendFixture(t);
  assert.deepEqual((await f.backend.downloadImage({ ...f.input, originalBytes: undefined }, f.signal)).content, large);
  assert.equal(num(fields(f.calls[0].body), 5), 0n); assert.equal(num(fields(f.calls[1].body), 5), BigInt(large.length));
});

test('an original rejected by WeChat falls back to the regular complete image', async t => {
  const f = backendFixture(t, (_cmd, body) => response(body, large, num(fields(body), 8) === 1n ? { ret: -3 } : {}));
  const acquired = await f.backend.downloadImage({ ...f.input, fullBytes: large.length }, f.signal);
  assert.equal(acquired.quality, 'full'); assert.deepEqual(acquired.content, large);
  assert.deepEqual(f.calls.map(call => Number(num(fields(call.body), 8))), [1, 0, 0, 0]);
});

test('an announced original over the size bound uses the regular complete image directly', async t => {
  const f = backendFixture(t);
  assert.equal((await f.backend.downloadImage({ ...f.input, originalBytes: MAX_DOWNLOAD_IMAGE_BYTES + 1 }, f.signal)).quality, 'full');
  assert(f.calls.every(call => num(fields(call.body), 8) === 0n));
});

for (const [name, overrides] of [
  ['message ID', { id: 2n }], ['sender', { from: 'wrong-room' }], ['recipient', { to: 'other-account' }],
  ['offset', { start: 9 }], ['chunk length', { length: 5 }], ['wrapper length', { wrapperLength: 5 }], ['empty chunk', { part: Buffer.alloc(0), wrapperLength: 0, length: 0 }],
]) test(`download rejects a mismatched ${name} without another image attempt`, async t => {
  const f = backendFixture(t, (_cmd, body) => response(body, large, overrides));
  await assert.rejects(f.backend.downloadImage(f.input, f.signal), { code: 'ERR_PROTOCOL' }); assert.equal(f.calls.length, 1);
});

test('unknown, outgoing and non-image messages never initiate downloads', async t => {
  const f = backendFixture(t);
  await assert.rejects(f.backend.downloadImage({ ...f.input, peerId: 'other-room' }, f.signal), { code: 'ERR_IMAGE_OWNER' });
  const message = f.backend.messages.get(`wx:${peerId}:${messageId}`);
  message.direction = 'outgoing'; await assert.rejects(f.backend.downloadImage(f.input, f.signal), { code: 'ERR_IMAGE_OWNER' });
  message.direction = 'incoming'; message.messageType = 1; await assert.rejects(f.backend.downloadImage(f.input, f.signal), { code: 'ERR_IMAGE_OWNER' });
  assert.equal(f.calls.length, 0);
});

test('advertised image length does not override the actual cached rendition length', async t => {
  const f = backendFixture(t, (_cmd, body) => {
    const total = Number(num(fields(body), 5));
    return response(body, large, total && total !== large.length ? { ret: -104 } : {});
  });
  const acquired = await f.backend.downloadImage({ ...f.input, originalBytes: undefined, fullBytes: 113834 }, f.signal);
  assert.equal(acquired.quality, 'full'); assert.deepEqual(acquired.content, large);
  assert.equal(num(fields(f.calls[0].body), 5), 0n);
  assert(f.calls.slice(1).every(call => num(fields(call.body), 5) === BigInt(large.length)));
});

test('the actual total cannot change after the first checked image chunk', async t => {
  const f = backendFixture(t, (_cmd, body, _backend, count) => response(body, large, count === 1 ? {} : { total: large.length + 1 }));
  await assert.rejects(f.backend.downloadImage(f.input, f.signal), { code: 'ERR_PROTOCOL' });
  assert.equal(f.calls.length, 2);
});

test('account or login changes during a chunk discard acquired bytes', async t => {
  const f = backendFixture(t, (_cmd, body, backend) => { backend.session.value = { ...backend.session.value, token: 'bb'.repeat(15) }; return response(body); });
  await assert.rejects(f.backend.downloadImage(f.input, f.signal), { code: 'ERR_IMAGE_ACCOUNT_CHANGED' }); assert.equal(f.calls.length, 1);
});

test('cancellation between chunks stops downloading and never downgrades to another resource', async t => {
  const controller = new AbortController();
  const f = backendFixture(t, (_cmd, body) => { controller.abort(new Error('cancel fixture')); return response(body); });
  await assert.rejects(f.backend.downloadImage(f.input, controller.signal), /cancel fixture/); assert.equal(f.calls.length, 1);
});

test('image CGI uses the fixed official shortlink endpoint and verifies account and command after decryption', async () => {
  const account = nativeQrSession(api).credential, key = Buffer.from(account.body_key, 'hex'), s08 = Buffer.from(account.s08, 'hex');
  const request = fv(2, 123), answer = fv(3, 456), signal = new AbortController().signal;
  const fetched = await downloadImageChunk(account, request, signal, async (url, options) => {
    assert.equal(url, 'http://short.weixin.qq.com/cgi-bin/micromsg-bin/getmsgimg');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual'); assert.equal(options.signal, signal);
    assert.deepEqual(decodeCgiBody(options.body, key, s08).body, request);
    assert.equal(decodeCgiBody(options.body, key, s08).innerCmd, 109);
    return new Response(encodeCgiBody(109, answer, account.uin, account.token, key, s08));
  });
  assert.deepEqual(fetched, answer);
  for (const [uin, cmd] of [[account.uin + 1, 109], [account.uin, 110]])
    await assert.rejects(downloadImageChunk(account, request, signal, async () => new Response(encodeCgiBody(cmd, answer, uin, account.token, key, s08))), { code: 'ERR_PROTOCOL' });
});

test('shortlink rejects redirects and oversized chunks without following untrusted locations', async () => {
  const account = nativeQrSession(api).credential, signal = new AbortController().signal;
  await assert.rejects(downloadImageChunk(account, Buffer.alloc(0), signal, async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/' } })), { code: 'ERR_IMAGE_DOWNLOAD' });
  await assert.rejects(downloadImageChunk(account, Buffer.alloc(0), signal, async () => new Response(Buffer.alloc(100000))), { code: 'ERR_PROTOCOL' });
});

test('native image response envelopes retain identity, content and length validation', async () => {
  const account = nativeQrSession(api).credential, key = Buffer.from(account.body_key, 'hex'), s08 = Buffer.from(account.s08, 'hex');
  const body = fv(3, 456), request = fv(2, 123), signal = new AbortController().signal;
  const packet = (uin = account.uin, cmd = 109, sum = 0, flag = 0) => responseChecksum(encodeCgiBody(cmd, body, uin, account.token, key, s08), sum, flag);
  const valid = packet();
  assert.deepEqual(await downloadImageChunk(account, request, signal, async () => new Response(valid)), body);
  // File-upload request-echo validation is still separate and strict.
  const original = encodeCgiBody(109, request, account.uin, account.token, key, s08);
  assert.throws(() => decodeCgiBody(valid, key, s08, original), /checksum/);
  for (const invalid of [packet(account.uin + 1), packet(account.uin, 110), packet(account.uin, 109, 12345),
    packet(account.uin, 109, 0, 1), valid.subarray(0, valid.length - 1)])
    await assert.rejects(downloadImageChunk(account, request, signal, async () => new Response(invalid)));
});

test('image timeout and cancellation leave the independent chat connection untouched', async t => {
  const f = backendFixture(t), controller = new AbortController();
  f.backend.imageChunk = (account, body, signal) => downloadImageChunk(account, body, signal, async (_url, options) => {
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const pending = f.backend.downloadImage(f.input, controller.signal);
  controller.abort(new Error('cancel fixture')); await assert.rejects(pending, /cancel fixture/);
  assert.equal(f.backend.transport.connected, true);
  const timed = f.backend.downloadImage(f.input, AbortSignal.timeout(5)), keepAlive = setTimeout(() => {}, 100);
  await assert.rejects(timed, { name: 'TimeoutError' }); clearTimeout(keepAlive);
  assert.equal(f.backend.transport.connected, true);
});

test('messages that advertise only a regular full image do not request an unavailable original first', async t => {
  const f = backendFixture(t);
  assert.equal((await f.backend.downloadImage({ ...f.input, originalBytes: undefined, fullBytes: large.length }, f.signal)).quality, 'full');
  assert(f.calls.every(call => num(fields(call.body), 8) === 0n));
});

test('double-escaped and numeric-escaped XML retains original/full lengths and source URLs', t => {
  const xml = '<msg><img hdlength="345678" length="123456" cdnbigimgurl="https://m.qpic.cn/full.png" cdnmidimgurl="https://m.qpic.cn/medium.png" /></msg>';
  for (const encoded of [xml.replaceAll('<', '&amp;lt;').replaceAll('>', '&amp;gt;').replaceAll('"', '&amp;quot;'), xml.replaceAll('<', '&#x3c;').replaceAll('>', '&#62;')]) {
    const f = mediaFixture(t, encoded), descriptor = JSON.parse(fs.readFileSync(path.join(f.directory, f.resourceId + '.json'), 'utf8'));
    assert.deepEqual(descriptor.download, { originalBytes: 345678, fullBytes: 123456 });
    assert.equal(descriptor.resources[0].quality, 'original'); assert.equal(descriptor.resources[0].size, 345678); assert.equal(descriptor.contentEncoding, 'escaped-xml');
  }
});

test('current WeChat imgmsg envelopes preserve original and full resources instead of silently becoming thumbnail-only', t => {
  const f = mediaFixture(t, 'fixture-member:\n<?xml version="1.0"?><msg><imgmsg aeskey="' + 'a'.repeat(32) +
    '" cdnthumburl="thumb-fixture" cdnthumblength="3000" cdnmidimgurl="full-fixture" length="34149" cdnbigimgurl="original-fixture" hdlength="680414" md5="' + 'b'.repeat(32) + '" /></msg>');
  const descriptor = JSON.parse(fs.readFileSync(path.join(f.directory, f.resourceId + '.json'), 'utf8'));
  assert.deepEqual(descriptor.download, { originalBytes: 680414, fullBytes: 34149 });
  assert.deepEqual(descriptor.resources.map(item => [item.quality, item.size]), [['original', 680414], ['medium', 34149], ['thumbnail', 3000]]);
  assert.equal(descriptor.contentEncoding, 'xml');
});

test('a cached inline thumbnail never masks a downloadable original, which is cached byte for byte', async t => {
  const f = mediaFixture(t), image = await loadObservedMedia({ ...f, downloadOriginal: async input => {
    assert.equal(input.peerId, peerId); assert.equal(input.messageId, messageId); return { content: large, quality: 'original' };
  } });
  assert.equal(image.quality, 'original'); assert.equal(image.data, large.toString('base64'));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.resourceId + '.original.image')), large);
  assert.equal((await loadObservedMedia({ ...f, downloadOriginal: () => assert.fail('must reuse original cache') })).data, image.data);
});

test('HTTP original precedes native download and regular resources; the exact hash and size are checked', async t => {
  const md5 = createHash('md5').update(large).digest('hex').toUpperCase();
  const f = mediaFixture(t, '<img cdnbigimgurl="https://m.qpic.cn/original.png" hdlength="' + large.length + '" md5="' + md5 + '" />');
  const image = await loadObservedMedia({ ...f, fetcher: async url => { assert.equal(url.href, 'https://m.qpic.cn/original.png'); return new Response(large); }, downloadOriginal: () => assert.fail('HTTP original is already available') });
  assert.equal(image.quality, 'original'); assert.equal(image.data, large.toString('base64'));
});

test('an incorrect HTTP image hash cannot replace the available thumbnail', async t => {
  const f = mediaFixture(t, '<img cdnbigimgurl="https://m.qpic.cn/original.png" md5="' + '0'.repeat(32) + '" />');
  const image = await loadObservedMedia({ ...f, fetcher: async () => new Response(large) });
  assert.equal(image.quality, 'thumbnail'); assert.equal(image.data, png.toString('base64'));
  assert(!fs.existsSync(path.join(f.directory, f.resourceId + '.original.image')));
});

test('explicit retries can upgrade a full cache when an original becomes available', async t => {
  const f = mediaFixture(t);
  await loadObservedMedia({ ...f, downloadOriginal: async () => ({ content: png, quality: 'full' }) });
  assert.equal((await loadObservedMedia({ ...f, downloadOriginal: () => assert.fail('full cache is reused normally') })).quality, 'full');
  const upgraded = await loadObservedMedia({ ...f, preferOriginal: true, downloadOriginal: async () => ({ content: large, quality: 'original' }) });
  assert.equal(upgraded.quality, 'original'); assert.equal(upgraded.bytes, large.length);
});

test('unavailable original falls back honestly to inline thumbnail, without enlarging it', async t => {
  const f = mediaFixture(t), acquired = await loadObservedMedia({ ...f, downloadOriginal: async () => { throw new Error('expired'); } });
  assert.equal(acquired.quality, 'thumbnail'); assert.equal(acquired.data, png.toString('base64')); assert.match(acquired.qualityNote, /缩略图/);
});

test('loader rejects cross-message ownership before downloads and propagates explicit cancellation', async t => {
  const f = mediaFixture(t);
  await assert.rejects(loadObservedMedia({ ...f, peerId: 'other-room', downloadOriginal: () => assert.fail('cannot download another room') }), { code: 'IMAGE_OWNER_MISMATCH' });
  const controller = new AbortController();
  await assert.rejects(loadObservedMedia({ ...f, signal: controller.signal, downloadOriginal: async () => { controller.abort(new Error('cancel fixture')); return { content: large, quality: 'original' }; } }), /cancel fixture/);
  assert(!fs.existsSync(path.join(f.directory, f.resourceId + '.original.image')));
});

test('emoji resources use the emoji CDN and do not invoke the photo protocol', async t => {
  const f = mediaFixture(t, '<msg><emoji cdnurl="https://emoji.qpic.cn/fixture.png" /></msg>');
  assert.equal((await loadObservedMedia({ ...f, fetcher: async () => new Response(png), downloadOriginal: () => assert.fail('emoji must not download as a photo') })).quality, 'original');
});

test('downloaded JPEG metadata stays in the raw cache and never reaches vision or image memory', async t => {
  const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const jpeg = Buffer.concat([Buffer.from([0xff,0xd8]), segment(0xc0, Buffer.from([8,0,2,0,3,1,1,0x11,0])),
    segment(0xda, Buffer.from([1,1,0,0,63,0])), Buffer.from([1,2,3,0xff,0xd9])]);
  const downloaded = Buffer.concat([jpeg, Buffer.from('wechat-cdn-extra-metadata')]);
  const f = mediaFixture(t); let calls = 0;
  const first = await loadObservedMedia({ ...f, downloadOriginal: async () => { calls++; return { content: downloaded, quality: 'full' }; } });
  assert.equal(first.quality, 'full'); assert.equal(first.data, jpeg.toString('base64'));
  assert.equal(first.bytes, jpeg.length); assert.equal(first.sourceBytes, downloaded.length);
  assert.equal(first.trailerBytes, downloaded.length - jpeg.length);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.resourceId + '.full.image')), downloaded);
  const second = await loadObservedMedia({ ...f, preserveStickerOriginal: true, downloadOriginal: async () => { throw Error('Do not redownload a complete cached image'); } });
  assert.equal(second.data, first.data); assert.equal(calls, 1);
});

test('only an explicit sticker archive read retains the verified JPEG original and its native MD5', async t => {
  const { pixels, original } = stickerJpeg(), md5 = stickerDigest(original);
  const f = mediaFixture(t, '<msg><emoji md5="' + md5 + '" cdnurl="https://emoji.qpic.cn/native.jpg" /></msg>');
  let downloads = 0;
  const archive = await loadObservedMedia({ ...f, preserveStickerOriginal: true, fetcher: async () => { downloads++; return new Response(original); } });
  assert.equal(archive.stickerMd5, md5); assert.equal(archive.data, original.toString('base64'));
  const preview = await loadObservedMedia({ ...f, fetcher: () => assert.fail('use the already verified cache') });
  assert.equal(preview.data, pixels.toString('base64')); assert.equal(downloads, 1);
});
