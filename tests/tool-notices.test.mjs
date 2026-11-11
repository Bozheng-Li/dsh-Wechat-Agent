import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, WechatChannel, ChannelError, createToolNotifier, toolNoticeText } from '../lib/testing.js';
import { registerModelTools } from '../modules/tools/registry.mjs';
import { recoveryAllowed } from '../modules/recovery/service.mjs';

const scope = { accountId: 'fixture-owner', chatType: 'private', peerId: 'fixture-friend', senderId: 'fixture-friend', senderName: 'Friend' };
const signal = () => new AbortController().signal;
function fixture(t, send) {
  const base = path.resolve(import.meta.dirname, '../storage/tmp'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'tool-notices-')), store = new StateStore(root), sent = [];
  const account = { id: scope.accountId };
  store.configure(account.id, { enabled: true, privatePeers: [scope.peerId], groups: [], prompt: '' });
  const channel = new WechatChannel({ store, runner: { run: async () => ({ text: '最终回答' }) }, transport: {
    status: () => ({ online: true, account }), send: async (request, abort) => {
      sent.push(request); return send ? send(request, abort) : { delivery: 'server-ack', serverMessageIds: ['fixture-ack-' + sent.length] };
    } } });
  t.after(async () => { await channel.close(); const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(base)); assert(path.basename(actual).startsWith('tool-notices-')); fs.rmSync(actual, { recursive: true }); });
  return { channel, store, sent, notifier: options => createToolNotifier(channel, { scope, requestKey: 'fixture-request', signal: signal(), assertAllowed() {}, ...options }) };
}

test('the chat sends a durable notice before a slow tool, keeping final delivery and memory separate', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.channel.runner.run = async input => {
    await input.onBeforeTool('wechat_web_search', { query: 'PUBLIC' }, { signal: input.signal, callId: 'chat-search' });
    entered.resolve(); await finish.promise; return { text: '最终查证结果' };
  };
  f.channel.receive({ id: 'fixture-message', serverMessageId: 'fixture-message', direction: 'incoming', time: Math.floor(Date.now() / 1000),
    chatType: scope.chatType, peerId: scope.peerId, sender: { id: scope.senderId }, message: [{ type: 'text', data: { text: '帮我查证一下' } }] }, scope.accountId);
  await entered.promise;
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].message[0].data.text, /先联网/);
  const final = f.store.data.records.find(record => !record.toolProgress), notice = f.store.data.records.find(record => record.toolProgress);
  assert.equal(final.state, 'generating'); assert.equal(final.sendAttempted, undefined);
  assert.equal(notice.state, 'sent'); assert.deepEqual(notice.acknowledgedMessageIds, ['fixture-ack-1']);
  finish.resolve(); await f.channel.whenIdle();
  assert.equal(f.sent.length, 2); assert.equal(final.reply, '最终查证结果');
  assert.deepEqual(final.acknowledgedMessageIds, ['fixture-ack-2']);
  const history = f.store.history(scope.accountId, scope.chatType, scope.peerId, 100);
  assert(history.some(row => row.text === '最终查证结果')); assert(!history.some(row => /先联网/.test(row.text)));
});

test('parallel tool notices preserve per-call ordering and duplicate call IDs do not resend', async t => {
  let active = 0, peak = 0;
  const f = fixture(t, async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return { delivery: 'server-ack', serverMessageIds: ['ack-' + f.sent.length] }; });
  const notify = f.notifier();
  await Promise.all([notify('wechat_web_search', {}, { callId: 'a' }), notify('wechat_read_image', {}, { callId: 'b' }), notify('wechat_web_search', {}, { callId: 'a' })]);
  assert.equal(peak, 1); assert.equal(f.sent.length, 2);
  await f.notifier()('wechat_web_search', {}, { callId: 'a' }); assert.equal(f.sent.length, 2);
});

test('notice text is bounded and never reflects raw queries, commands, recipients or results', async t => {
  const f = fixture(t), secret = 'PRIVATE-QUERY-AND-KEY';
  const notify = f.notifier({ presentation: { prompt: '第一行必须单独写“固定开场”。最后一行必须单独写“固定结尾”。' } });
  await notify('wechat_web_search', { query: secret, peerId: 'other', reasoning: secret });
  assert.equal(f.sent[0].peerId, scope.peerId); assert.equal(f.sent[0].accountId, scope.accountId);
  assert(!JSON.stringify(f.sent).includes(secret)); assert(!JSON.stringify(f.store.data.records).includes(secret));
  assert(f.sent[0].message[0].data.text.startsWith('固定开场\n')); assert(f.sent[0].message[0].data.text.endsWith('\n固定结尾'));
  assert.match(toolNoticeText('wechat_moments_images'), /配图/);
  assert.match(toolNoticeText('wechat_moments_like_recent'), /找到.*再.*点赞/);
  assert.match(toolNoticeText('unfamiliar_tool', { text: secret }), /先处理/);
});

test('unknown notice delivery is saved once, cannot recover as a stale final response, and permits the real tool', async t => {
  const f = fixture(t, async () => ({ delivery: 'unknown' })), notify = f.notifier();
  const record = await notify('wechat_web_search', {}, { callId: 'unknown' });
  assert.equal(record.state, 'unknown'); assert.equal(record.acknowledgedMessageIds, undefined);
  await notify('wechat_web_search', {}, { callId: 'unknown' }); assert.equal(f.sent.length, 1);
  assert.throws(() => recoveryAllowed({}, record, 'text', true), error => error.code === 'RECOVERY_NOT_ALLOWED');
});

test('revocation prevents a notice and retains a received ACK when revoked during its send', async t => {
  const denied = new ChannelError('AUTH_CHANGED', 'revoked'), f = fixture(t);
  await assert.rejects(f.notifier({ assertAllowed() { throw denied; } })('wechat_web_search', {}), error => error === denied);
  assert.equal(f.sent.length, 0);
  const controller = new AbortController();
  f.channel.transport.send = async request => { f.sent.push(request); controller.abort(denied); return { delivery: 'server-ack', serverMessageIds: ['ack-before-cancel'] }; };
  await assert.rejects(f.notifier({ signal: controller.signal })('wechat_read_image', {}), error => error === denied);
  assert.equal(f.store.data.records.at(-1).state, 'sent');
  assert.deepEqual(f.store.data.records.at(-1).acknowledgedMessageIds, ['ack-before-cancel']);
});

test('the native dispatch hook waits for notification, rechecks authority, and stays scoped to its agent', async () => {
  const events = [], hooks = new Map(), disposers = [], agent = {}, foreign = {};
  let allowed = true;
  const ctx = { tools: { restrict() {}, register() {}, guard() {} },
    on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); }, systemPrompt: { section() {} } };
  registerModelTools(ctx, [], { agent, onDispose: fn => disposers.push(fn),
    assertAllowed() { if (!allowed) throw new Error('revoked'); },
    onBeforeTool: async (name, args) => { events.push('notice:' + name); assert.equal(args.action, 'read'); await Promise.resolve(); } });
  const run = hooks.get('tools/execute');
  await run({ agent, name: 'read_file', arguments: { action: 'read' }, signal: signal() }, async () => events.push('tool'));
  assert.deepEqual(events, ['notice:read_file', 'tool']);
  await run({ agent: foreign }, async () => events.push('foreign')); assert.equal(events.length, 3);
  allowed = false;
  await assert.rejects(run({ agent, name: 'read_file', signal: signal() }, async () => events.push('must-not-run')), /revoked/);
  for (const dispose of disposers.reverse()) dispose(); assert.equal(hooks.size, 0);
});
