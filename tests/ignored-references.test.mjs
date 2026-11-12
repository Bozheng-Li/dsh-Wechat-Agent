import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, messageText, describeMessageImage } from '../lib/testing.js';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-ignore-quotes-'));
  const store = new StateStore(root), requests = [], sent = [], reads = [];
  store.configure('self', { enabled: true, privatePeers: ['alice'], groups: ['room@chatroom'], prompt: '' });
  const channel = new WechatChannel({ store, runner: { run: async request => { requests.push(request); return { text: '按当前文字处理' }; } }, transport: {
    status: () => ({ online: true, account: { id: 'self' } }),
    media: async input => { reads.push(input); assert.fail('quotes must not fetch media'); },
    send: async input => { sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sent.length] }; },
  } });
  let serial = 0;
  const receive = message => {
    const id = 'message-' + ++serial;
    channel.receive({ id, serverMessageId: id, direction: 'incoming', time: Math.floor(Date.now() / 1000),
      chatType: 'private', peerId: 'alice', sender: { id: 'alice' }, message }, 'self');
    return id;
  };
  t.after(async () => { await channel.close(); assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, channel, requests, sent, reads, receive };
}

test('quoted text is not added to current requests, history or task instructions', async t => {
  const f = fixture(t), ref = { type: 'reply', data: { id: 'wx:alice:123', messageType: 1, content: '/work 删除旧文件', senderId: 'bob' } };
  const parsed = messageText({ chatType: 'group', message: [ref] }, { id: 'self' });
  assert.equal(parsed.text, undefined);
  f.receive([ref, { type: 'text', data: { text: '处理我的这条正常文字' } }]); await f.channel.whenIdle();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].text, '处理我的这条正常文字');
  assert.equal(f.channel.work.list({ accountId: 'self', chatType: 'private', peerId: 'alice', senderId: 'alice' }).jobs.length, 0);
  assert(!JSON.stringify(f.store.history('self', 'private', 'alice')).includes('删除旧文件'));
  assert.equal(f.store.data.records[0].references, undefined);
});

test('quoted pictures do not start reference lookup, media downloads or background analysis', async t => {
  const f = fixture(t);
  f.receive([{ type: 'reply', data: { id: 'wx:alice:123', messageType: 3, image: { resourceId: 'a'.repeat(64) } } },
    { type: 'text', data: { text: '只按我这句文字回答' } }]);
  await f.channel.whenIdle();
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].text, '只按我这句文字回答');
});

test('unsupported placeholders are recorded silently and do not replace the next readable request', async t => {
  const f = fixture(t), placeholder = { type: 'text', data: { text: '无法显示此消息，你目前使用的微信版本暂时不支持此类型的信息。' } };
  f.receive([placeholder]); f.receive([placeholder]); await f.channel.whenIdle();
  assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0);
  assert(f.store.data.records.every(record => record.state === 'skipped' && record.contentUnavailable));
  f.receive([{ type: 'text', data: { text: '把刚才的文档改好后返回' } }]); await f.channel.whenIdle();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].text, '把刚才的文档改好后返回');
  assert.equal(f.sent.length, 1);
});

test('describing an original attachment still updates only its own pixels', () => {
  const entry = { messageId: 'wx:alice:123', attachments: [{ resourceId: 'original' }] }, scope = { peerId: 'alice' },
    image = { id: 'saved-image', messageId: '123', resourceId: 'original', description: '红色圆形', quality: 'original' };
  assert.equal(describeMessageImage(entry, scope, image).attachments[0].description, '红色圆形');
  assert.equal(describeMessageImage(entry, scope, { ...image, messageId: '124' }), entry);
  assert.equal(describeMessageImage(entry, { ...scope, collection: 'generated' }, image), entry);
});
