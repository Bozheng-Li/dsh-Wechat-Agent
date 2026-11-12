import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rolldown } from 'rolldown';
import { nativeQrSession } from './fixtures/native-qr-session.mjs';
import { wordFixture, xmlEscape } from './fixtures/word.mjs';

const root = path.resolve(import.meta.dirname, '..');
const entry = ['backend.ts', 'wire.ts', 'file-message.ts', 'file-download.ts', 'reference.ts'].map(name =>
  `export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol', name))};`).join('\n');
const build = await rolldown({ input: 'virtual:inbound-files', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') } },
  plugins: [{ name: 'inbound-files', resolveId: id => id === 'virtual:inbound-files' ? id : null, load: id => id === 'virtual:inbound-files' ? entry : null }] });
let api;
try { const { output } = await build.generate({ format: 'esm' }); api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`); }
finally { await build.close(); }
const { ProtocolBackend, fields, bytes, num, fv, ld, vi, readVi, fileDownloadRequest, fileDownloadResponse, downloadFileChunk, encodeCgiBody,
  decodeCgiBody, quotedMessage, parseReceivedFile, FILE_DOWNLOAD_CHUNK_BYTES } = api;
const peerId = 'fixture-room@chatroom', messageId = '18446744073709551001';
const sha = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const content = wordFixture({ extra: [{ name: 'word/media/fixture.bin', data: Buffer.alloc(150001, 0x61), stored: true }] });
function fileXml({ name = '需求 & 预算.docx', data = content, attachId = 'synthetic-attachment-id', md5 = sha(data, 'md5'), total = data.length } = {}) {
  return `<msg><appmsg appid=""><title>${xmlEscape(name)}</title><type>6</type><appattach><totallen>${total}</totallen><attachid>${attachId}</attachid>` +
    `<fileext>docx</fileext><cdnattachurl>synthetic-cdn-secret</cdnattachurl><aeskey>synthetic-aes-secret</aeskey></appattach><md5>${md5}</md5></appmsg></msg>`;
}
function response(request, { data = content, ...override } = {}) {
  const f = fields(request), start = Number(num(f, 7)), part = data.subarray(start, start + Number(num(f, 8)));
  const value = { ret: 0, mediaId: bytes(f, 4).toString(), username: bytes(f, 5).toString(), total: data.length, start, length: part.length, wrapperLength: part.length, part, ...override };
  return Buffer.concat([ld(1, fv(1, value.ret)), ld(2, ''), ld(3, value.mediaId), ld(4, value.username), fv(5, value.total), fv(6, value.start),
    fv(7, value.length), ld(8, Buffer.concat([fv(1, value.wrapperLength), ld(2, value.part)]))]);
}
function fixture(t, overrides = {}) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'wechat-inbound-files-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  const qr = nativeQrSession(api), sessionFile = path.join(directory, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ ...qr.credential, image_base_request: Buffer.concat([ld(1, qr.key), fv(2, qr.credential.uin),
    ld(3, qr.deviceId), fv(4, qr.version), ld(5, qr.deviceType), fv(6, 0)]).toString('hex') }));
  const backend = new ProtocolBackend({ sessionFile, cacheDir: path.join(directory, 'cache'), requestTimeoutMs: 1000 });
  backend.online = true; backend.transport = { connected: true, request: () => assert.fail('file download must not use the chat longlink') };
  const calls = [], events = [];
  backend.fileChunk = async (account, body, signal) => { calls.push({ account, body, signal }); return response(body); };
  backend.subscribe(event => events.push(event));
  const receive = (xml = fileXml(overrides), id = messageId, peer = peerId) => {
    const msg = backend.decodeMessage(fields(Buffer.concat([ld(2, peer), ld(3, qr.credential.wxid), fv(4, 49), ld(5, 'sender-fixture:\n' + xml),
      fv(9, Math.floor(Date.now() / 1000)), fv(12, BigInt(id))])));
    backend.remember(msg); return msg;
  };
  const message = receive();
  const input = { peerId, messageId, before: Date.now() + 1000 };
  return { directory, backend, calls, events, input, message, receive, signal: new AbortController().signal };
}

test('incoming Word preserves metadata and exact server ID, keeping locators out of the bridge and cache messages', t => {
  const f = fixture(t), file = f.message.message[0];
  assert.equal(file.type, 'file'); assert.equal(file.data.name, '需求 & 预算.docx'); assert.equal(file.data.bytes, content.length);
  assert.equal(f.message.partial, false); assert.equal(f.message.serverMessageId, messageId); assert.equal(f.calls.length, 0);
  assert(!JSON.stringify(f.message).includes('secret')); assert(!JSON.stringify(f.message).includes('synthetic-attachment-id'));
  const descriptor = JSON.parse(fs.readFileSync(path.join(f.directory, 'cache/files/42', file.data.resourceId + '.json'), 'utf8'));
  assert.equal(descriptor.attachId, 'synthetic-attachment-id'); assert.equal(descriptor.messageId, messageId); assert.equal(descriptor.senderId, 'sender-fixture');
  f.backend.persist();
  const reloaded = new ProtocolBackend(f.backend.options);
  assert.deepEqual(reloaded.receivedFiles(f.input), f.backend.receivedFiles(f.input));
});

test('file quotes retain the basic envelope without file enrichment or downloadable originals', t => {
  const f = fixture(t), before = fs.readdirSync(path.join(f.directory, 'cache/files/42'));
  const quote = quotedMessage(`<msg><appmsg><type>57</type><title>按这份文件做方案</title><refermsg><type>49</type><svrid>${messageId}</svrid><content>${xmlEscape(fileXml())}</content></refermsg></appmsg></msg>`, peerId);
  assert.equal(quote[0].data.file, undefined); assert(!JSON.stringify(quote).includes('secret'));
  assert.equal(quote[0].data.id, `wx:${peerId}:${messageId}`); assert.deepEqual(fs.readdirSync(path.join(f.directory, 'cache/files/42')), before);
});

test('unsafe titles cannot name a cache path and unrelated app messages are not files', t => {
  const f = fixture(t, { name: '../../CON:<report>.docx' });
  assert(!/[\\/:<>]/.test(f.message.message[0].data.name)); assert.equal(f.calls.length, 0);
  assert.equal(parseReceivedFile(fileXml().replace('<type>6</type>', '<type>5</type>')), undefined);
  assert.equal(parseReceivedFile('<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///fixture">]>' + fileXml()), undefined);
  assert.equal(parseReceivedFile('<appmsg><type>6</type><title>broken.docx'), undefined);
});

test('file inventory and downloads remain bound to original room, incoming direction and receive-time cutoff', async t => {
  const f = fixture(t);
  assert.equal(f.backend.receivedFiles({ ...f.input, peerId: 'other@chatroom' }).length, 0);
  assert.equal(f.backend.receivedFiles({ ...f.input, before: f.message.observedAt - 1 }).length, 0);
  await assert.rejects(f.backend.downloadFile({ ...f.input, messageId: '1' }, f.signal), { code: 'ERR_FILE_DOWNLOAD_MISSING' });
  await assert.rejects(f.backend.downloadFile({ ...f.input, messageId: undefined }, f.signal), { code: 'ERR_FILE_DOWNLOAD_INVALID' });
  f.message.direction = 'outgoing';
  await assert.rejects(f.backend.downloadFile(f.input, f.signal), { code: 'ERR_FILE_DOWNLOAD_MISSING' });
  assert.equal(f.calls.length, 0);
});

test('file inventory projects safe metadata even when a cached message contains extra private fields', t => {
  const f = fixture(t);
  Object.assign(f.message.message[0].data, { attachId: 'private-locator', aesKey: 'private-key', base64: 'private-bytes', file: 'C:/private' });
  const listed = f.backend.receivedFiles(f.input);
  assert.equal(listed.length, 1); assert.equal(listed[0].messageId, messageId);
  assert(!JSON.stringify(listed).includes('private-')); assert(!JSON.stringify(listed).includes('C:/private'));
});

test('recent unsupported messages flag an uncertain default without crossing the room or request cutoff', t => {
  const f = fixture(t), originalAt = f.message.observedAt;
  const input = { peerId, before: originalAt + 20 };
  assert.equal(f.backend.receivedFileContext(input).latestUnavailable, undefined);
  const placeholder = { ...f.message, id: `wx:${peerId}:123`, serverMessageId: '123', messageType: 1, observedAt: originalAt + 10,
    message: [{ type: 'text', data: { text: '无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。' } }] };
  f.backend.remember(placeholder);
  const uncertain = f.backend.receivedFileContext(input);
  assert.equal(uncertain.latestUnavailable, true); assert.equal(uncertain.files[0].messageId, messageId);
  assert.equal(f.backend.receivedFileContext({ ...input, before: originalAt + 5 }).latestUnavailable, undefined);
  placeholder.peerId = 'another-room@chatroom';
  assert.equal(f.backend.receivedFileContext(input).latestUnavailable, undefined);
  placeholder.peerId = peerId; placeholder.direction = 'outgoing';
  assert.equal(f.backend.receivedFileContext(input).latestUnavailable, undefined);
  placeholder.direction = 'incoming';
  const newer = f.receive(fileXml({ name: '最新需求.docx' }), '124'); newer.observedAt = originalAt + 15;
  const current = f.backend.receivedFileContext(input); assert.equal(current.latestUnavailable, undefined);
  assert.deepEqual(current.files.map(file => file.name), ['最新需求.docx', '需求 & 预算.docx']);
  newer.observedAt = placeholder.observedAt;
  assert.equal(f.backend.receivedFileContext(input).latestUnavailable, undefined);
});

test('DownloadAppAttach uses its published request and response field numbers and bounded exact uint64 identifiers', t => {
  const f = fixture(t), file = { baseRequest: Buffer.from('fixture'), appId: '', mediaId: 'fixture-media', username: 'fixture-self', total: content.length, messageId };
  const request = fileDownloadRequest(file, 0), parsed = fields(request);
  assert.equal(num(parsed, 13), BigInt(messageId)); assert.equal(num(parsed, 6), BigInt(content.length)); assert.equal(num(parsed, 8), BigInt(FILE_DOWNLOAD_CHUNK_BYTES));
  assert.equal(bytes(parsed, 4).toString(), file.mediaId); assert.equal(bytes(parsed, 5).toString(), file.username);
  assert.deepEqual(fileDownloadResponse(response(request), file, 0), content.subarray(0, FILE_DOWNLOAD_CHUNK_BYTES));
  assert.equal(f.calls.length, 0);
  for (const override of [{ messageId: '18446744073709551616' }, { total: 0 }, { total: 21 * 1024 * 1024 }])
    assert.throws(() => fileDownloadRequest({ ...file, ...override }, 0), { code: 'ERR_FILE_DOWNLOAD_INVALID' });
});

test('download assembles every byte, verifies MD5, survives cursor refresh and reuses complete cache without sending a message', async t => {
  const f = fixture(t);
  f.backend.fileChunk = async (_account, body) => { f.calls.push({ body }); f.backend.session.save({ ...f.backend.session.value, sync_key: fv(1, 43).toString('hex') }); return response(body); };
  const file = await f.backend.downloadFile(f.input, f.signal);
  assert.deepEqual(Buffer.from(file.data, 'base64'), content); assert.equal(file.sha256, sha(content)); assert.equal(file.messageId, messageId);
  assert.equal(f.calls.length, Math.ceil(content.length / FILE_DOWNLOAD_CHUNK_BYTES)); assert.equal(f.events.length, 0);
  f.backend.fileChunk = () => assert.fail('cached file must not download again');
  assert.equal((await f.backend.downloadFile(f.input, f.signal)).cached, true);
});

test('cached files without a source MD5 still detect same-size changes and source replacement', async t => {
  for (const changed of ['bytes', 'descriptor']) {
    const f = fixture(t, { md5: '' }); await f.backend.downloadFile(f.input, f.signal);
    const prefix = path.join(f.directory, 'cache/files/42', f.message.message[0].data.resourceId);
    if (changed === 'bytes') { const edited = Buffer.from(content); edited[100] ^= 1; fs.writeFileSync(prefix + '.file', edited); }
    else { const descriptor = JSON.parse(fs.readFileSync(prefix + '.json', 'utf8')); descriptor.attachId = 'replacement'; fs.writeFileSync(prefix + '.json', JSON.stringify(descriptor)); }
    f.backend.fileChunk = () => assert.fail('a changed sealed cache must not silently redownload');
    await assert.rejects(f.backend.downloadFile(f.input, f.signal), { code: 'FILE_INTEGRITY_FAILED' });
  }
});

test('an interrupted cache publish without an integrity record is downloaded again before use', async t => {
  const f = fixture(t, { md5: '' }), target = path.join(f.directory, 'cache/files/42', f.message.message[0].data.resourceId + '.file');
  fs.writeFileSync(target, Buffer.alloc(content.length));
  const file = await f.backend.downloadFile(f.input, f.signal);
  assert.equal(file.cached, false); assert.deepEqual(Buffer.from(file.data, 'base64'), content); assert(f.calls.length > 0);
});

test('source metadata changed during download cannot publish the previous attachment', async t => {
  const f = fixture(t), descriptorFile = path.join(f.directory, 'cache/files/42', f.message.message[0].data.resourceId + '.json');
  f.backend.fileChunk = async (_account, body) => {
    const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8')); descriptor.attachId = 'changed-source';
    fs.writeFileSync(descriptorFile, JSON.stringify(descriptor)); return response(body);
  };
  await assert.rejects(f.backend.downloadFile(f.input, f.signal), { code: 'FILE_SOURCE_INVALID' });
  assert(!fs.readdirSync(path.dirname(descriptorFile)).some(name => name.endsWith('.file')));
});

for (const [name, override] of [ ['media ID', { mediaId: 'other' }], ['account', { username: 'other' }], ['total', { total: 2 }],
  ['offset', { start: 3 }], ['length', { length: 5 }], ['buffer wrapper', { wrapperLength: 6 }], ['empty chunk', { part: Buffer.alloc(0), length: 0, wrapperLength: 0 }] ])
  test(`mismatched attachment ${name} never creates a readable partial file`, async t => {
    const f = fixture(t); f.backend.fileChunk = async (_account, body) => response(body, override);
    await assert.rejects(f.backend.downloadFile(f.input, f.signal), { code: 'ERR_FILE_DOWNLOAD_PROTOCOL' });
    assert(!fs.readdirSync(path.join(f.directory, 'cache/files/42')).some(name => name.endsWith('.file')));
  });

test('MD5 mismatch, unavailable CDN-only files and oversize metadata are explicit failures', async t => {
  const bad = fixture(t, { md5: 'f'.repeat(32) }); await assert.rejects(bad.backend.downloadFile(bad.input, bad.signal), { code: 'FILE_INTEGRITY_FAILED' });
  const cdn = fixture(t, { attachId: '' }); await assert.rejects(cdn.backend.downloadFile(cdn.input, cdn.signal), { code: 'FILE_DOWNLOAD_UNSUPPORTED' }); assert.equal(cdn.calls.length, 0);
  const large = fixture(t, { total: 21 * 1024 * 1024 }); await assert.rejects(large.backend.downloadFile(large.input, large.signal), { code: 'FILE_SIZE_UNSUPPORTED' }); assert.equal(large.calls.length, 0);
});

test('cancellation or account replacement during a chunk never returns or caches the old file', async t => {
  for (const change of ['cancel', 'account']) {
    const f = fixture(t), controller = new AbortController();
    f.backend.fileChunk = async (_account, body) => { if (change === 'cancel') controller.abort(); else f.backend.session.value.wxid = 'other-account'; return response(body); };
    await assert.rejects(f.backend.downloadFile(f.input, controller.signal), change === 'cancel' ? { name: 'AbortError' } : { code: 'ERR_FILE_DOWNLOAD_ACCOUNT_CHANGED' });
    assert(!fs.readdirSync(path.join(f.directory, 'cache/files/42')).some(name => name.endsWith('.file')));
  }
});

test('the shortlink download validates endpoint, encrypted response account and response size', async t => {
  const f = fixture(t), account = f.backend.session.value, request = fileDownloadRequest({ baseRequest: Buffer.from('test'), appId: '', mediaId: 'fixture', username: account.wxid, total: content.length, messageId }, 0);
  const fetcher = async (url, options) => {
    assert.equal(url, 'http://short.weixin.qq.com/cgi-bin/micromsg-bin/downloadappattach'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const decoded = decodeCgiBody(options.body, Buffer.from(account.body_key, 'hex'), Buffer.from(account.s08, 'hex')); assert.equal(decoded.innerCmd, 221);
    return new Response(encodeCgiBody(221, response(decoded.body), account.uin, account.token, Buffer.from(account.body_key, 'hex'), Buffer.from(account.s08, 'hex')));
  };
  assert.deepEqual(await downloadFileChunk(account, request, f.signal, fetcher), response(request));
  await assert.rejects(downloadFileChunk(account, request, f.signal, async () => new Response(Buffer.alloc(100000))), { code: 'ERR_FILE_DOWNLOAD_PROTOCOL' });
  for (const [uin, command] of [[43, 221], [account.uin, 220]])
    await assert.rejects(downloadFileChunk(account, request, f.signal, async () => new Response(encodeCgiBody(command, response(request), uin, account.token,
      Buffer.from(account.body_key, 'hex'), Buffer.from(account.s08, 'hex')))), { code: 'ERR_FILE_DOWNLOAD_PROTOCOL' });
});

test('PC download accepts only the matching request-checksum echo observed in the live Word experiment', async t => {
  const f = fixture(t), account = f.backend.session.value, key = Buffer.from(account.body_key, 'hex'), s08 = Buffer.from(account.s08, 'hex');
  const request = fileDownloadRequest({ baseRequest: Buffer.from('test'), appId: '', mediaId: 'fixture', username: account.wxid, total: content.length, messageId }, 0);
  const headerValues = packet => {
    let offset = 26; const values = [];
    for (let i = 0; i < 6; i++) { let value; [value, offset] = readVi(packet, offset); values.push(value); }
    return { values, offset };
  };
  const reply = wrong => async (_url, options) => {
    const encoded = encodeCgiBody(221, response(request), account.uin, account.token, key, s08), original = headerValues(options.body), echoed = headerValues(encoded);
    const oldLength = encoded[1] >> 2;
    echoed.values[4] = 0n; echoed.values[5] = original.values[5] + (wrong ? 1n : 0n);
    const header = Buffer.concat([encoded.subarray(0, 26), ...echoed.values.map(vi), encoded.subarray(echoed.offset, oldLength)]);
    header[1] = header.length * 4 + (encoded[1] & 3);
    return new Response(Buffer.concat([header, encoded.subarray(oldLength)]));
  };
  assert.deepEqual(await downloadFileChunk(account, request, f.signal, reply(false)), response(request));
  await assert.rejects(downloadFileChunk(account, request, f.signal, reply(true)), { code: 'ERR_FILE_DOWNLOAD_PROTOCOL' });
});
