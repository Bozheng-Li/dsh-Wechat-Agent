import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentIdentity, StateStore, WechatChannel, conversationMemoryTool, needsConversationalRewrite } from '../lib/testing.js';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const owner = 'identity_fixture', roomA = 'identity-a@chatroom', roomB = 'identity-b@chatroom';
function fixture(t) {
  fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'identity-'));
  const store = new StateStore(root), calls = [], sent = [], now = Date.now();
  store.configure(owner, { enabled: true, groups: [roomA, roomB], privatePeers: ['friend'], prompt: '' });
  store.setPersona({ name: '默认小胖', aliases: [], prompt: '默认风格' });
  const channel = new WechatChannel({ store, now: () => now, runner: { run: async request => { calls.push(request); return { text: '嗯，听着呢。' }; } },
    transport: { status: () => ({ online: true, account: { id: owner } }), send: async message => { sent.push(message); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sent.length] }; } } });
  let serial = 0;
  const receive = (peerId, text, chatType = 'group') => channel.receive({ id: 'identity-' + ++serial, time: Math.floor(now / 1000), direction: 'incoming', chatType, peerId,
    sender: { id: 'friend', nickname: '阿禾' }, message: [{ type: 'text', data: { text } }] }, owner);
  t.after(async () => { await channel.close(); assert.equal(path.dirname(root), base); assert(path.basename(root).startsWith('identity-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, channel, calls, sent, receive };
}

test('global identity is a durable editable Markdown file and detects external edits', t => {
  const f = fixture(t), identity = new AgentIdentity(f.root), initial = identity.view();
  assert(initial.markdown.includes('不主动谈 AI')); assert.equal(path.basename(initial.path), 'AGENT.md');
  identity.edit('# 全局身份\n保持简短、诚实。', initial.revision);
  assert.equal(new AgentIdentity(f.root).view().markdown, '# 全局身份\n保持简短、诚实。');
  const beforeExternal = identity.view(); fs.writeFileSync(identity.file, '# 外部修改\n尊重当前会话。');
  assert.throws(() => identity.edit('旧草稿', beforeExternal.revision), error => error.code === 'IDENTITY_CHANGED');
  assert(identity.view().markdown.includes('外部修改'));
  fs.writeFileSync(identity.file, ''); assert.throws(() => identity.view(), error => error.code === 'IDENTITY_INVALID');
});

test('each conversation uses its own persona for nickname triggers and model requests', async t => {
  const f = fixture(t), first = { name: '阿圆', aliases: ['圆圆'], prompt: '语气温和，喜欢摄影。' }, second = { name: '北辰', aliases: ['老北'], prompt: '务实直接，讨论技术。' };
  for (const [peer, persona] of [[roomA, first], [roomB, second]]) f.store.setConversationSettings(owner, 'group', peer, { ...f.store.conversationSettings(owner, 'group', peer), mode: 'nickname', persona });
  f.receive(roomA, '圆圆，来聊聊'); await f.channel.whenIdle();
  f.receive(roomB, '老北，来聊聊'); await f.channel.whenIdle();
  f.receive(roomA, '北辰，来聊聊'); await f.channel.whenIdle();
  f.receive('friend', '来聊聊', 'private'); await f.channel.whenIdle();
  assert.deepEqual(f.calls.map(value => value.persona.name), ['阿圆', '北辰', '默认小胖']);
  assert.deepEqual(f.calls[0].persona, first); assert.deepEqual(f.calls[1].persona, second);
  const restored = new StateStore(f.root);
  assert.deepEqual(restored.conversationPersona(owner, 'group', roomA), first);
  f.store.setConversationSettings(owner, 'group', roomA, { ...f.store.conversationSettings(owner, 'group', roomA), persona: null });
  assert.equal(f.store.conversationPersona(owner, 'group', roomA).name, '默认小胖');
  assert.deepEqual(f.store.conversationPersona(owner, 'group', roomB), second);
});

test('on-demand memory keeps recent context and exposes only a scoped read tool', async t => {
  const f = fixture(t);
  f.store.setConversationSettings(owner, 'group', roomA, { ...f.store.conversationSettings(owner, 'group', roomA), memoryMode: 'on-demand' });
  f.channel.longMemory.prompt = scope => scope.peerId === roomA ? 'A_ONLY：下周讨论摄影。' : 'B_ONLY：另一群的私事。';
  f.receive(roomA, '/agent 下周约好摄影。'); await f.channel.whenIdle();
  f.receive(roomA, '/agent 上次约好什么？'); await f.channel.whenIdle();
  const request = f.calls[1]; assert(!request.memory.includes('A_ONLY')); assert(!request.memory.includes('B_ONLY'));
  assert(request.memory.includes('下周约好摄影'));
  const read = request.tools.find(value => value.name === 'wechat_memory'); assert(read);
  const result = JSON.parse(await read.execute({ section: 'long-term', query: '摄影' }, { signal: new AbortController().signal }));
  assert(result.text.includes('A_ONLY')); assert(!result.text.includes('B_ONLY'));
  const unmatched = JSON.parse(await read.execute({ section: 'long-term', query: '没有匹配' }, {}));
  assert.equal(unmatched.found, true); assert.equal(unmatched.queryMatched, false); assert.equal(unmatched.coverage, 'complete');
  assert(unmatched.text.includes('A_ONLY')); assert(!unmatched.text.includes('B_ONLY'));
});

test('memory lookup rechecks permission and cannot be redirected to another scope', async () => {
  let allowed = true; const scope = { accountId: owner, chatType: 'group', peerId: roomA };
  const tool = conversationMemoryTool({}, { prompt: request => { assert.deepEqual(request, scope); return '只属于A的内容'; } }, scope,
    () => { if (!allowed) throw new Error('revoked'); });
  assert(JSON.parse(await tool.execute({ section: 'long-term', accountId: 'other', peerId: roomB }, {})).text.includes('只属于A'));
  allowed = false; await assert.rejects(tool.execute({ section: 'long-term' }, {}), /revoked/);
});

test('casual introductions reject unsolicited system monologues while direct identity questions remain honest', () => {
  assert(needsConversationalRewrite('我是小胖，一个 AI 助手，住在服务器上，没性别，也没有家人。换一段对话就不记得了。', '小胖，简单介绍一下自己'));
  assert(!needsConversationalRewrite('我是小胖，话不算多，熟了就爱接两句。', '简单介绍一下自己'));
  assert(!needsConversationalRewrite('是呀，我是 AI，叫我小胖就行。', '你是不是 AI？'));
  assert(!needsConversationalRewrite('我是一个 AI 助手。', '你是 AI 吗？'));
});

test('on-demand lookups cannot introduce room messages received after a queued question', async t => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = fixture(t);
  f.store.setConversationSettings(owner, 'group', roomA, { ...f.store.conversationSettings(owner, 'group', roomA), memoryMode: 'on-demand' });
  f.receive(roomA, '/agent 之前约好周六去摄影'); await f.channel.whenIdle();
  let lookup, first = true;
  f.channel.runner.run = async request => {
    f.calls.push(request);
    if (first) {
      first = false; started.resolve(); await gate.promise;
      const tool = request.tools.find(value => value.name === 'wechat_memory');
      lookup = JSON.parse(await tool.execute({ section: 'conversation' }, { signal: request.signal }));
      return { text: '先回答这一问。' };
    }
    return { text: '再接后来的话题。' };
  };
  f.receive(roomA, '/agent 按之前的约定回答'); await started.promise;
  f.receive(roomA, '后来才到的内容 LATER_ONLY');
  f.receive(roomA, '/agent 后来才到的提问 LATER_QUESTION');
  gate.resolve(); await f.channel.whenIdle();
  assert(lookup.text.includes('之前约好周六去摄影'));
  assert(!lookup.text.includes('LATER_ONLY'), 'a read tool must respect the same receive boundary as the prompt');
  assert(!lookup.text.includes('LATER_QUESTION'));
  assert(f.calls[2].memory.includes('LATER_ONLY'), 'later questions still receive the later context');
  assert(f.calls[2].memory.includes('先回答这一问'), 'the preceding real reply remains available');
  assert.equal(f.sent.length, 3);
});

test('identity reads accept UTF-8 with a BOM and reject malformed bytes before they reach the model', t => {
  const f = fixture(t), identity = new AgentIdentity(f.root);
  fs.writeFileSync(identity.file, '\uFEFF# 全局身份\n自然接话，保留中文。', 'utf8');
  assert.equal(identity.view().markdown, '# 全局身份\n自然接话，保留中文。');
  const malformed = Buffer.from([0x23, 0x20, 0xe4, 0xb8, 0x0a]);
  fs.writeFileSync(identity.file, malformed);
  assert.throws(() => identity.view(), error => error.code === 'IDENTITY_INVALID' && error.message.includes('UTF-8'));
  assert.deepEqual(fs.readFileSync(identity.file), malformed, 'invalid bytes are retained for repair');
});

test('on-demand lookup recovers details omitted by turn compression and stops after memory is cleared', async t => {
  const f = fixture(t), scope = { accountId: owner, chatType: 'group', peerId: roomA };
  f.receive(roomA, '周六阿禾负责带相机 ARCHIVE_DETAIL。' + '较长的活动背景资料。'.repeat(180));
  await f.channel.whenIdle();
  f.store.setConversationSettings(owner, 'group', roomA, { ...f.store.conversationSettings(owner, 'group', roomA), memoryMode: 'on-demand', memoryWindowChars: 1000 });
  f.channel.runner.summarize = async () => '本群讨论过周末活动。';
  f.receive(roomA, '/agent 周六谁负责带相机？'); await f.channel.whenIdle();
  const request = f.calls[0], tool = request.tools.find(value => value.name === 'wechat_memory');
  assert(!request.memory.includes('ARCHIVE_DETAIL'), 'the bounded prompt has lost this detail through compression');
  const lookup = JSON.parse(await tool.execute({ section: 'conversation', query: 'ARCHIVE_DETAIL' }, { signal: request.signal }));
  assert.equal(lookup.found, true); assert(lookup.text.includes('阿禾负责带相机'));
  f.channel.memory.clear(scope);
  await assert.rejects(tool.execute({ section: 'conversation', query: 'ARCHIVE_DETAIL' }, {}), error => error.code === 'MEMORY_CHANGED');
});

test('an unreadable long-term document is reported as an error instead of an empty search result', async t => {
  const f = fixture(t);
  f.store.setConversationSettings(owner, 'group', roomA, { ...f.store.conversationSettings(owner, 'group', roomA), memoryMode: 'on-demand' });
  const longTerm = f.channel.longMemory.view(owner);
  fs.writeFileSync(longTerm.path, '# 缺少记忆归属标记的损坏文档', 'utf8');
  f.receive(roomA, '/agent 上次说的偏好是什么？'); await f.channel.whenIdle();
  const tool = f.calls[0].tools.find(value => value.name === 'wechat_memory');
  const lookup = JSON.parse(await tool.execute({ section: 'long-term' }, {}));
  assert.equal(lookup.found, false); assert.equal(lookup.text, ''); assert(lookup.error.includes('长期记忆'));
  assert.equal(fs.readFileSync(longTerm.path, 'utf8'), '# 缺少记忆归属标记的损坏文档');
});
