import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore, ConversationMemory, observedImage, loadObservedMedia, completedText, ChannelError } from '../lib/testing.js';

test('request quotas are distinguishable from connection failures and never expose provider diagnostics or partial output', () => {
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '不可发送的半截回复' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', message: 'PRIVATE_PROVIDER_DIAGNOSTICS' } } } },
  ];
  assert.throws(() => completedText(events), error => {
    assert(error instanceof ChannelError);
    assert.equal(error.code, 'MODEL_INCOMPLETE');
    assert.match(error.message, /请求额度或调用频率已达上限/);
    assert.match(error.message, /未发送/);
    assert.doesNotMatch(error.message, /连接|余额|PRIVATE_PROVIDER|半截回复/);
    return true;
  });
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1cAAAAASUVORK5CYII=', 'base64');
const md5 = createHash('md5').update(png).digest('hex');
const scope = { accountId: 'emoji-owner', chatType: 'group', peerId: 'emoji-room@chatroom' };
function temporary(t) {
  const base = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(base, 'wechat-emoji-vision-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), base); assert(!fs.lstatSync(resolved).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}
function imageFixture(t, address = 'http://vweixinf.tc.qq.com/fixture.png', digest = md5) {
  const directory = temporary(t), messageId = 'fixture-emoji';
  const segment = observedImage([], `<msg><emoji cdnurl="${address}" md5="${digest}" /></msg>`, directory, `${scope.peerId}:${messageId}`);
  return { directory, messageId, peerId: scope.peerId, resourceId: segment.data.resourceId, signal: new AbortController().signal };
}

test('the actual WeChat emoji CDN is read over its advertised HTTP transport, checked and cached for vision', async t => {
  const f = imageFixture(t); let requests = 0;
  const image = await loadObservedMedia({ ...f, downloadOriginal: () => assert.fail('an emoji must not use the photo CGI'), fetcher: async url => {
    requests++; assert.equal(url.href, 'http://vweixinf.tc.qq.com/fixture.png'); return new Response(png);
  } });
  assert.equal(requests, 1); assert.equal(image.quality, 'original'); assert.equal(image.mediaType, 'image/png');
  assert.equal(image.data, png.toString('base64'));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.resourceId + '.original.image')), png);
  assert.equal((await loadObservedMedia({ ...f, fetcher: () => assert.fail('original cache must be reused') })).data, image.data);
});

test('HTTPS emoji addresses remain HTTPS; other WeChat CDNs still upgrade HTTP', async t => {
  for (const [address, expected] of [['https://vweixinf.tc.qq.com/fixture.png', 'https://vweixinf.tc.qq.com/fixture.png'],
    ['http://emoji.qpic.cn/fixture.png', 'https://emoji.qpic.cn/fixture.png']]) {
    const f = imageFixture(t, address);
    await loadObservedMedia({ ...f, fetcher: async url => { assert.equal(url.href, expected); return new Response(png); } });
  }
});

test('lookalike CDN names, arbitrary ports and URL credentials cannot trigger a media fetch', async t => {
  for (const address of ['http://vweixinf.tc.qq.com.evil.invalid/fixture.png', 'http://evil-vweixinf.tc.qq.com/fixture.png',
    'http://vweixinf.tc.qq.com:8080/fixture.png', 'http://user:password@vweixinf.tc.qq.com/fixture.png']) {
    const f = imageFixture(t, address);
    await assert.rejects(loadObservedMedia({ ...f, fetcher: () => assert.fail('invalid address must be rejected before fetching') }), { code: 'IMAGE_URL_INVALID' });
  }
});

test('redirects cannot escape the WeChat media hosts, and a mismatched emoji hash is never cached', async t => {
  const redirect = imageFixture(t); let requests = 0;
  await assert.rejects(loadObservedMedia({ ...redirect, fetcher: async () => {
    requests++; return new Response(null, { status: 302, headers: { location: 'https://outside.invalid/fixture.png' } });
  } }), { code: 'IMAGE_URL_INVALID' });
  assert.equal(requests, 1);
  const badHash = imageFixture(t, 'http://vweixinf.tc.qq.com/fixture.png', '0'.repeat(32));
  await assert.rejects(loadObservedMedia({ ...badHash, fetcher: async () => new Response(png) }), { code: 'IMAGE_INTEGRITY_FAILED' });
  assert(!fs.existsSync(path.join(badHash.directory, badHash.resourceId + '.original.image')));
});

test('a stored failed emoji may be archived but never consumes vision, including explicit retry', async t => {
  const f = imageFixture(t), root = temporary(t), store = new StateStore(root);
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId, 'other-room@chatroom'], privatePeers: [], prompt: '' });
  const memory = new ConversationMemory(store), other = { ...scope, peerId: 'other-room@chatroom' };
  const note = { key: 'emoji-entry', messageId: f.messageId, text: '[表情]', direction: 'incoming', time: Date.now(),
    attachments: [{ type: 'face', resourceId: f.resourceId, error: '图片资源地址不是可读取的微信媒体地址', attempts: 1 }] };
  memory.append(scope, note); memory.append(other, { ...note, key: 'other-emoji', messageId: 'other-message' });
  assert.deepEqual(memory.view(scope).imageFailures, []);
  const otherBefore = fs.readFileSync(memory.view(other).path), modelImages = [];
  const runner = { describeImage: async image => { modelImages.push(image); return '合成测试图像笔记。'; } };
  const transport = { media: async input => {
    assert.equal(input.accountId, scope.accountId); assert.equal(input.peerId, scope.peerId); assert.equal(input.preferOriginal, true);
    return loadObservedMedia({ ...f, fetcher: async () => new Response(png) });
  } };
  await memory.enrich(scope, runner, transport, f.signal, { retryFailed: true });
  const result = new ConversationMemory(new StateStore(root)).view(scope);
  assert.equal(result.failedImages, 0); assert.deepEqual(result.imageFailures, []); assert.equal(modelImages.length, 0);
  assert.equal(result.entries[0].attachments[0].quality, 'original');
  assert.equal(result.entries[0].attachments[0].attempts, 2); assert.equal(result.entries[0].attachments[0].error, undefined);
  assert.deepEqual(fs.readFileSync(memory.view(other).path), otherBefore);
});

test('image failure summaries keep resource and model failures separate across restart', async t => {
  const root = temporary(t), store = new StateStore(root);
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  const memory = new ConversationMemory(store);
  memory.append(scope, { key: 'failures', messageId: 'failures', text: '[图片与表情]', direction: 'incoming', time: Date.now(),
    attachments: ['resource-a', 'resource-b', 'model'].map(resourceId => ({ type: 'image', resourceId })) });
  const runner = { describeImage: async () => { throw new ChannelError('MODEL_INCOMPLETE', '模型任务未完成'); } };
  const transport =
    { media: async ({ resourceId }) => {
      if (resourceId.startsWith('resource')) throw new ChannelError('IMAGE_DOWNLOAD_FAILED', '图片资源未取得');
      return { data: png.toString('base64'), mediaType: 'image/png' };
    } };
  await memory.enrich(scope, runner, transport, new AbortController().signal);
  await memory.enrich(scope, runner, transport, new AbortController().signal, { imageRequest: { key: 'failures', resourceId: 'model' } });
  const result = new ConversationMemory(new StateStore(root)).view(scope);
  assert.equal(result.failedImages, 3);
  assert.deepEqual(result.imageFailures, [{ reason: '图片资源未取得', count: 2 }, { reason: '模型任务未完成', count: 1 }]);
});

test('native model transport and timeout failures show the actual class without exposing provider diagnostics', () => {
  for (const [code, label] of [['TRANSPORT', '传输失败'], ['TIMEOUT', '超时']]) {
    const events = [{ type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { code, message: 'PRIVATE_PROVIDER_DIAGNOSTICS' } } } }];
    assert.throws(() => completedText(events), error => {
      assert.equal(error.code, 'MODEL_INCOMPLETE'); assert(error.message.includes(label));
      assert(!error.message.includes('PRIVATE_PROVIDER_DIAGNOSTICS')); return true;
    });
  }
});

test('native account quota errors identify the model account and do not expose private provider diagnostics', () => {
  const events = [{ type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { code: 'ACCOUNT_QUOTA', message: 'Insufficient Balance PRIVATE_PROVIDER_DIAGNOSTICS' } } } }];
  assert.throws(() => completedText(events), error => {
    assert.equal(error.code, 'MODEL_INCOMPLETE'); assert(error.message.includes('余额或额度不足')); assert(!error.message.includes('PRIVATE_PROVIDER_DIAGNOSTICS')); return true;
  });
});
