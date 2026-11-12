import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { StateStore, WechatChannel, DshAgentRunner, NATURAL_REPLY_RULES, REPLY_STYLE_REVIEW_NOTE, ChannelError } from '../lib/testing.js';

const accountId = 'persona-delivery-owner', peerId = 'persona-delivery@chatroom';
const temporary = path.resolve(import.meta.dirname, '../storage/tmp');
const persona = { name: '墨白', aliases: ['小墨'], prompt: 'PERSONA_CAPTURED：克制的轻古风，照当前请求完成作品。' };

function png() {
  const crc = data => { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const tag = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([tag, data]))); return Buffer.concat([length, tag, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 128, 128, 128]))), chunk('IEND', Buffer.alloc(0))]);
}

function fixture(t, answers, { caption = '此刻歇一歇，也无妨。', afterSelect, legacy = false, selectMedia = true, sendFailure } = {}) {
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, 'persona-delivery-'));
  const store = new StateStore(root);
  store.configure(accountId, { enabled: true, groups: [peerId], privatePeers: [], prompt: 'ACCOUNT_CAPTURED：只用中文，保留必要作品。' });
  store.setPersona(persona);
  const choice = { provider: 'fixture', model: 'first' };
  const runtime = { identityMarkdown: '# GLOBAL_CAPTURED\n尊重当前会话，不套通用客服口吻。', modelConfig: { maxTokens: 1536, temperature: 0.2 },
    persona: { name: '默认人设', aliases: [], prompt: 'DEFAULT_PERSONA_SHOULD_NOT_APPEAR' } };
  const requests = [], messages = [], scopes = [], sent = [];
  let channel, asset;
  const create = async options => {
    const number = scopes.length;
    const answer = answers[number];
    assert.equal(typeof answer, 'string', 'style review must not request a second model response');
    const scope = { definitions: [], hooks: [],
      tools: { restrict() {}, guard() {}, register: tool => scope.definitions.push(tool) },
      systemPrompt: { suppressRuntimeContext() {}, section: section => { scope.prompt = section.text; } },
      on: (event, hook) => { if (event === 'agent/request') scope.hooks.push(hook); },
    };
    scopes.push(scope); options.setup(scope);
    requests.push(await scope.hooks.reduceRight((next, hook) => () => hook({}, next), async () => options.agentOptions)());
    let pending = Promise.resolve();
    return { agent: {
      session: { seq: 0, snapshotEvents: () => [
        { type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: answer }] } } },
        { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
      ] },
      followup: message => {
        messages.push(message);
        pending = (async () => {
          if (number !== 0 || !selectMedia) return;
          const read = scope.definitions.find(value => value.name === 'wechat_sticker_read'); assert(read);
          await read.execute({ action: 'read', assetId: asset.id }, { signal: options.signal });
          const tool = scope.definitions.find(value => value.name === 'wechat_sticker_send'); assert(tool);
          const result = JSON.parse(await tool.execute({ assetId: asset.id, caption }, { signal: options.signal }));
          assert(result.ok && !result.sent);
          await afterSelect?.({ runtime, choice, store, channel, asset });
        })();
      },
      whenIdle: async () => pending, cancel() {},
    }, dispose: async () => {} };
  };
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'first' }) },
    llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'first' }, { id: 'second' }] },
    agents: { create, resume: create },
  };
  const runner = new DshAgentRunner(ctx, () => choice, () => runtime);
  // These scenarios cover delivery; background fact extraction is verified by
  // the memory suites and must not consume the model answers for this turn.
  runner.extractLongTermMemory = undefined;
  if (legacy) runner.run = async input => {
    const read = input.tools.find(value => value.name === 'wechat_sticker_read'); assert(read);
    await read.execute({ action: 'read', assetId: asset.id }, { signal: input.signal });
    const tool = input.tools.find(value => value.name === 'wechat_sticker_send'); assert(tool);
    await tool.execute({ assetId: asset.id, caption }, { signal: input.signal });
    return { text: '兼容 runner 的未采用正文' };
  };
  const transport = {
    status: () => ({ online: true, account: { id: accountId, nickname: '隔离测试账号' } }),
    send: async input => { sent.push(input); if (sendFailure) throw sendFailure; return { delivery: 'server-ack', serverMessageIds: ['persona-delivery-ack'] }; },
  };
  channel = new WechatChannel({ store, runner, transport, random: () => 0 });
  channel.library.configure(accountId, { ...channel.library.account(accountId).settings, autoDescribe: false });
  channel.library.import(accountId, { name: '示例.png', kind: 'sticker', data: png().toString('base64') });
  asset = channel.library.list(accountId).items[0];
  const receive = async (question = '发个表情包，配一句话。') => {
    channel.receive({ id: 'persona-delivery-message', serverMessageId: 'persona-delivery-message', direction: 'incoming',
      time: Math.floor(Date.now() / 1000), chatType: 'group', peerId, sender: { id: 'member', nickname: '阿禾' },
      message: [{ type: 'text', data: { text: '/agent ' + question } }] }, accountId);
    await channel.whenIdle();
  };
  t.after(async () => {
    await channel.close(); channel.library.close();
    assert.equal(path.dirname(root), temporary);
    assert.match(path.basename(root), /^persona-delivery-/);
    assert(fs.realpathSync(root).startsWith(temporary + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, channel, runner, sent, scopes, requests, messages, receive, record: () => store.data.records.at(-1) };
}

test('a valid selected caption is delivered without rewriting the unused assistant body', async t => {
  const caption = '此刻歇一歇，也无妨。';
  const f = fixture(t, ['收到你的问题，下面让我为你分析。'], { caption });
  await f.receive();
  assert.equal(f.record().state, 'sent', f.record().reason);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.sent[0].message.map(value => value.type), ['text', 'face']);
  assert.equal(f.sent[0].message[0].data.text, caption);
  assert.equal(f.record().reply, caption);
  assert.equal(f.record().replyStyleWarning, undefined, 'unused assistant boilerplate must not flag a clean caption');
});

test('a boilerplate caption is sent unchanged and marked for review with the captured generation settings', async t => {
  const caption = '收到你的问题，此刻歇一歇，也无妨。';
  const f = fixture(t, ['素材已选好。'], { caption, afterSelect: ({ runtime, choice }) => {
    runtime.identityMarkdown = '# GLOBAL_CHANGED'; runtime.modelConfig = { maxTokens: 768, temperature: 0.9 };
    runtime.persona.prompt = 'PERSONA_CHANGED'; choice.model = 'second';
  } });
  await f.receive();
  assert.equal(f.record().state, 'sent', f.record().reason);
  assert.equal(f.messages.length, 1);
  assert.equal(f.sent[0].message[0].data.text, caption);
  assert.equal(f.record().replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.deepEqual(f.record().acknowledgedMessageIds, ['persona-delivery-ack']);
  assert(f.requests.every(request => request.model === 'first' && request.maxTokens === 1536 && request.temperature === 0.2));
  for (const scope of f.scopes) {
    for (const value of ['PERSONA_CAPTURED', 'GLOBAL_CAPTURED', 'ACCOUNT_CAPTURED']) assert(scope.prompt.includes(value), value);
    for (const value of ['GLOBAL_CHANGED', 'PERSONA_CHANGED', 'DEFAULT_PERSONA_SHOULD_NOT_APPEAR']) assert(!scope.prompt.includes(value), value);
    assert.equal(scope.prompt.split(NATURAL_REPLY_RULES).length, 2);
  }
  assert.equal(f.scopes.length, 1, 'a caption review cannot select media or create tasks again');
});

test('the reported conic-section reply sends once with real ACK and its review marker survives reload', async t => {
  const answer = '收到你的问题。\n双曲线：x²/a² − y²/b² = 1。\n抛物线：y² = 2px。';
  const f = fixture(t, [answer], { selectMedia: false });
  await f.receive('小胖你把双曲线和抛物线的都写出来');
  const record = f.record(); assert.equal(record.state, 'sent', record.reason);
  assert.equal(f.sent.length, 1); assert.equal(f.messages.length, 1);
  assert.deepEqual(f.sent[0].message, [{ type: 'text', data: { text: answer } }]);
  assert.equal(record.reply, answer); assert.equal(record.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  const restored = new StateStore(f.store.root).data.records.find(value => value.key === record.key);
  assert.equal(restored.state, 'sent'); assert.equal(restored.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.deepEqual(restored.acknowledgedMessageIds, ['persona-delivery-ack']);
});

test('a review note never turns a genuine sending failure into success', async t => {
  const f = fixture(t, ['收到你的问题，双曲线方程是 x²/a² − y²/b² = 1。'], { selectMedia: false,
    sendFailure: new ChannelError('SEND_REJECTED', '微信拒绝了本次发送', { delivery: 'rejected' }) });
  await f.receive('写出双曲线方程');
  assert.equal(f.sent.length, 1); assert.equal(f.record().state, 'failed');
  assert.equal(f.record().replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
  assert.equal(f.record().acknowledgedMessageIds, undefined); assert.match(f.record().reason, /微信拒绝/);
});

test('image-only selection does not invent text or rewrite the unused assistant body', async t => {
  const f = fixture(t, ['收到你的问题，下面让我为你分析。'], { caption: null });
  await f.receive();
  assert.equal(f.record().state, 'sent', f.record().reason);
  assert.equal(f.record().reply, '');
  assert.deepEqual(f.sent[0].message.map(value => value.type), ['face']);
  assert.equal(f.messages.length, 1);
});

test('only the selected caption is length-checked and private reasoning markers are filtered before delivery', async t => {
  const f = fixture(t, ['未采用的正文'.repeat(2500)], { caption: '<think>不应投递的推理</think>且歇一歇。' });
  await f.receive();
  assert.equal(f.record().state, 'sent', f.record().reason);
  assert.equal(f.sent[0].message[0].data.text, '且歇一歇。');
  assert.equal(f.record().reply, '且歇一歇。');
  assert.equal(f.messages.length, 1);
});

test('legacy runners that do not select reply text still preserve tool captions', async t => {
  const f = fixture(t, [], { caption: '原样配文。', legacy: true });
  await f.receive();
  assert.equal(f.record().state, 'sent', f.record().reason);
  assert.equal(f.sent[0].message[0].data.text, '原样配文。');
  assert.deepEqual(f.sent[0].message.map(value => value.type), ['text', 'face']);
});

test('legacy caption review propagates its note and still sends the selected caption once', async t => {
  const caption = '收到你的问题，原样配文。', f = fixture(t, [], { caption, legacy: true });
  await f.receive(); assert.equal(f.record().state, 'sent', f.record().reason);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].message[0].data.text, caption);
  assert.equal(f.record().replyStyleWarning, REPLY_STYLE_REVIEW_NOTE);
});

test('selecting delivery text does not bypass media availability checks after generation', async t => {
  const f = fixture(t, ['素材已选好。'], { afterSelect: ({ channel, asset }) => channel.library.edit(accountId, asset.id, { enabled: false }) });
  await f.receive();
  assert.equal(f.record().state, 'failed');
  assert.equal(f.sent.length, 0);
  assert.match(f.record().reason, /素材/);
});
