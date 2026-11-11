import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { crc32, inspectAssetImage } from '../modules/media/image-format.mjs';
import { decodeGeneratedImage } from '../modules/work/image-response.mjs';
import { StateStore, WechatChannel, ImageGenerationService, IMAGE_GENERATION_CREDENTIAL, workTools, readWorkArtifact } from '../lib/testing.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function png(width = 1, height = 1, level = 6) {
  const chunk = (kind, data) => {
    const name = Buffer.from(kind), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 100);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level })), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(t, response) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-image-response-')), store = new StateStore(root), calls = [];
  const next = store.config.snapshot(store.data);
  next.imageGeneration = { enabled: true, endpoint: 'https://image.invalid/v1', model: 'image-one', size: '2048x2048' };
  store.config.commit(next);
  const f = { root, store, calls };
  f.service = new ImageGenerationService({ credentials: { resolve: async reference => {
    assert.equal(reference, IMAGE_GENERATION_CREDENTIAL); return { value: 'private-image-key' };
  } } }, store, { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return typeof response === 'function' ? response(url, options) : Response.json(response);
  } });
  t.after(async () => {
    await f.channel?.close(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-image-response-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return f;
}
const signal = () => new AbortController().signal;

for (const stage of ['request', 'response', 'download']) test(`image ${stage} transport errors identify their stage without secrets or automatic regeneration`, async t => {
  const transportError = new TypeError('private-image-key must not be reported', { cause: Object.assign(new Error('private endpoint'), { code: 'ECONNRESET' }) });
  const f = fixture(t, (_url, options) => {
    if (stage === 'request') throw transportError;
    if (stage === 'response') return new Response(new ReadableStream({ start(controller) { controller.error(transportError); } }));
    if (options.method === 'POST') return Response.json({ data: [{ url: 'https://image.invalid/original.png' }] });
    throw transportError;
  });
  await assert.rejects(f.service.generate({ prompt: '检查传输故障' }, signal()), error => {
    assert.equal(error.code, 'IMAGE_GENERATION_NETWORK'); assert.equal(error.imageGeneration.stage, stage);
    assert.equal(error.imageGeneration.networkCode, 'ECONNRESET'); assert.match(error.message, /连接中断/);
    assert(!JSON.stringify(error).includes('private-image-key')); assert(!error.message.includes('private-image-key'));
    return true;
  });
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(f.calls.length, stage === 'download' ? 2 : 1);
});

test('base64 data URIs, MIME line breaks, omitted padding and URL-safe encoding retain exact API image bytes', async t => {
  let bytes = png();
  for (let width = 2; !bytes.toString('base64').endsWith('='); width++) bytes = png(width);
  const encoded = bytes.toString('base64');
  const forms = [encoded, 'data:image/png;base64,' + encoded, encoded.match(/.{1,12}/g).join('\r\n'),
    encoded.replace(/=+$/, ''), bytes.toString('base64url'), '  data:image/png;base64,' + encoded.replace(/=+$/, '') + '\n'];
  for (const value of forms) {
    const f = fixture(t, { data: [{ b64_json: value }] });
    const result = await f.service.generate({ prompt: '小狗图片' }, signal());
    assert.deepEqual(result.bytes, bytes); assert.equal(result.sendAs, 'image'); assert.equal(f.calls.length, 1);
  }
  const f = fixture(t, { data: [{ url: 'data:image/png;base64,' + encoded }] });
  assert.deepEqual((await f.service.generate({ prompt: '小狗图片' }, signal())).bytes, bytes);
  assert.equal(f.calls.length, 1, 'a data URI must not trigger a network download');
  assert.equal(f.service.catalog().providers[0].size, '2048x2048');
});

test('malformed encoding is rejected without returning payloads or retrying', async t => {
  for (const encoded of ['%%private-image-key', 'A', 'AQ=', 'AB==', 'AQ===', 'data:text/plain;base64,AQ==']) {
    const f = fixture(t, { data: [{ b64_json: encoded }] });
    await assert.rejects(f.service.generate({ prompt: '小狗图片' }, signal()), error =>
      error.code === 'IMAGE_GENERATION_RESPONSE' && error.message.includes('编码格式无效') && !error.message.includes('private-image-key'));
    assert.equal(f.calls.length, 1);
  }
});

test('API originals above 20 MiB retain exact bytes and use a file attachment for JSON and streamed downloads', async t => {
  const original = png(4096, 2048, 0);
  assert(original.length > 20 * 1024 * 1024);
  assert.deepEqual(decodeGeneratedImage(original.toString('base64')), original);
  for (const download of [false, true]) {
    const f = fixture(t, (url, options) => options.method === 'POST'
      ? download ? Response.json({ data: [{ url: 'https://image.invalid/original.png' }] })
        : Response.json({ data: [{ b64_json: original.toString('base64') }] })
      : new Response(original, { headers: { 'content-length': String(original.length) } }));
    const result = await f.service.generate({ prompt: '保存完整原图' }, signal());
    assert.deepEqual(result.bytes, original); assert.equal(result.sendAs, 'file');
    assert.equal(f.calls.length, download ? 2 : 1);
  }
});

test('empty base64 preserves an existing API image URL without making another generation request or forwarding credentials', async t => {
  const bytes = png();
  for (const empty of ['', ' \r\n ', null]) {
    const url = 'https://image.invalid/generated/dog.png';
    const f = fixture(t, (target, options) => options.method === 'POST'
      ? Response.json({ data: [{ b64_json: empty, url }] }) : new Response(bytes));
    const result = await f.service.generate({ prompt: '小狗图片' }, signal());
    assert.deepEqual(result.bytes, bytes);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url, url);
    assert.equal(f.calls[1].options.headers, undefined, 'download URL received an API credential');
  }
  const f = fixture(t, { data: [{ b64_json: '', url: 'data:image/png;base64,' + bytes.toString('base64') }] });
  assert.deepEqual((await f.service.generate({ prompt: '小狗图片' }, signal())).bytes, bytes);
  assert.equal(f.calls.length, 1);
});

test('empty and upstream-error image responses identify the selected provider and model without payloads, fallback or retries', async t => {
  for (const response of [{ data: [{ b64_json: '', url: '' }] }, { data: [] }, {}]) {
    const f = fixture(t, response);
    await assert.rejects(f.service.generate({ prompt: '小狗图片' }, signal()), error => {
      assert.equal(error.code, 'IMAGE_GENERATION_EMPTY');
      assert(error.message.includes('默认接口 / image-one'));
      assert.equal(error.imageGeneration.providerId, 'default');
      assert.equal(error.imageGeneration.model, 'image-one');
      assert.equal(error.imageGeneration.response.base64Characters, 0);
      assert.equal(error.imageGeneration.response.urlPresent, false);
      assert(!JSON.stringify(error.imageGeneration).includes('private-image-key'));
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(t, { error: { code: 'private-image-key', message: 'private-image-key' }, data: [{ b64_json: '' }] });
  await assert.rejects(f.service.generate({ prompt: '小狗图片' }, signal()), error =>
    error.code === 'IMAGE_GENERATION_UPSTREAM' && !error.message.includes('private-image-key') &&
    !JSON.stringify(error.imageGeneration).includes('private-image-key'));
  assert.equal(f.calls.length, 1);
});

test('a valid API original above 10 MiB is saved and delivered as an exact file with its individual WeChat acknowledgement', async t => {
  const bytes = png(2048, 1800, 0);
  assert(bytes.length > 10 * 1024 * 1024 && bytes.length < 20 * 1024 * 1024);
  assert.throws(() => inspectAssetImage(bytes), { code: 'ASSET_TOO_LARGE' });
  const f = fixture(t, { data: [{ b64_json: bytes.toString('base64') }] });
  const accountId = 'image-owner', peerId = 'alice', sent = [];
  f.store.configure(accountId, { enabled: true, privatePeers: [peerId], groups: [], prompt: '' });
  const admins = f.store.config.snapshot(f.store.data); admins.remote = { globalAdminIds: [peerId] }; f.store.config.commit(admins);
  f.store.setConversationSettings(accountId, 'private', peerId, { ...f.store.conversationSettings(accountId, 'private', peerId), executionMode: 'work', remoteEnabled: true });
  const runner = { run: async input => {
    assert.equal(input.mode, 'work-routing'); assert.deepEqual(input.tools, []);
    assert.equal(JSON.parse(input.text).message, '生成一张小狗的图片给我');
    return { text: JSON.stringify({ action: 'new', taskId: null,
      review: { intent: 'execute', evidence: JSON.parse(input.text).message, target: 'none' } }) };
  } };
  const workRunner = { run: async input => {
    await input.onSession('large-image-session');
    const tool = workTools({ ...input, imageGeneration: f.service }).find(tool => tool.name === 'wechat_work_generate_image');
    const result = JSON.parse(await tool.execute({ prompt: '小狗图片', path: 'dog.png' }, { signal: input.signal }));
    assert.equal(result.ok, true); assert.equal(result.artifacts[0].kind, 'file');
    assert.equal(result.artifacts[0].mediaType, 'image/png'); assert.equal(result.artifacts[0].sha256, hash(bytes));
    const read = readWorkArtifact(input.cwd, 'dog.png', result.artifacts[0]);
    assert.deepEqual(Buffer.from(read.segment.data.base64, 'base64'), bytes);
    return { text: '原图已生成，作为文件附件回传。' };
  } };
  f.channel = new WechatChannel({ store: f.store, runner, workRunner, transport: {
    status: () => ({ online: true, account: { id: accountId } }),
    send: async payload => {
      sent.push(payload);
      const parts = payload.message.map((part, index) => ({ index, type: part.type, state: 'acknowledged',
        serverMessageId: `image-ack-${sent.length}-${index}`, ...(part.type === 'file' ? {
          name: part.data.name, bytes: Buffer.from(part.data.base64, 'base64').length, sha256: hash(Buffer.from(part.data.base64, 'base64')),
        } : {}) }));
      return { delivery: 'server-ack', serverMessageIds: parts.map(part => part.serverMessageId), deliveryParts: parts };
    },
  } });
  f.channel.work.imageGeneration = f.service;
  f.channel.receive({ id: 'dog-message', direction: 'incoming', chatType: 'private', peerId, sender: { id: peerId },
    time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '生成一张小狗的图片给我' } }] }, accountId);
  await f.channel.whenIdle();
  const [job] = f.channel.work.list({ accountId, chatType: 'private', peerId, senderId: peerId }).jobs;
  assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'sent', JSON.stringify(job.delivery)); assert.equal(f.calls.length, 1);
  const file = sent.flatMap(payload => payload.message).find(part => part.type === 'file');
  assert(file); assert.deepEqual(Buffer.from(file.data.base64, 'base64'), bytes);
  assert.equal(job.delivery.artifacts[0].state, 'sent');
});
