import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, WechatChannel, LongTermMemory, createPluginService, rpcHandler, buildWechatPrompt, replyMemoryContext } from '../lib/testing.js';
import { emptyRoleCard } from '../shared/role-card.mjs';
import { reviewMemoryDraft, memoryReviewFlags } from '../modules/memory/roles/reflection.mjs';

const base = path.resolve('storage/tmp'), signal = () => new AbortController().signal;
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'role-production-')), store = new StateStore(root),
    account = { id: 'role-owner', nickname: '测试账号' }, group = { accountId: account.id, chatType: 'group', peerId: 'role-room@chatroom' },
    scope = { accountId: account.id, chatType: 'private', peerId: 'alice' };
  store.configure(account.id, { enabled: true, privatePeers: ['alice', 'bob'], groups: [group.peerId], prompt: '' });
  let now = Date.now(), serial = 0;
  const calls = [], sent = [], state = { account }, runner = { selection: () => ({ provider: 'test', model: 'test' }),
    defaultSelection: () => ({ provider: 'test', model: 'test' }), run: async input => { calls.push(input); return { text: '知道了。' }; } };
  const worker = { status: () => ({ online: true, state: 'online', account: state.account, login: { state: 'idle' } }),
    call: async () => ({}), send: async input => { sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['ack-' + sent.length] }; } };
  const channel = new WechatChannel({ store, runner, transport: worker, now: () => now }), memory = channel.longMemory,
    ctx = { llm: { listProviders: () => [], listModels: () => [] } },
    service = createPluginService({ ctx, root, store, worker, runner, channel }), rpc = rpcHandler(service);
  const entry = (text, senderId = 'alice', senderName = '阿宁') => ({ key: 'entry-' + ++serial, text, time: now, senderId, senderName, direction: 'incoming' });
  const write = async (text, { to = scope, senderId = 'alice', senderName = '阿宁', subjectId = senderId, replaces = [], expiresAt = null, extra = {} } = {}) => {
    const source = entry(text, senderId, senderName); memory.capture(to, [source]);
    await memory.extract(to, { run: async () => ({ text: JSON.stringify({ facts: [{ subjectId, text, sources: ['s1'],
      evidence: [{ source: 's1', quote: text }], replaces, expiresAt, ...extra }], unresolved: [] }) }) }, signal());
    return source;
  };
  t.after(async () => {
    await channel.close(); await service.drain();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(base)); assert(path.basename(resolved).startsWith('role-production-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, scope, group, memory, channel, runner, service, rpc, state, calls, sent, entry, write,
    now: () => now, advance: amount => { now += amount; },
    message: text => ({ id: 'message-' + ++serial, time: now / 1000, direction: 'incoming', chatType: 'private', peerId: 'alice',
      sender: { id: 'alice', nickname: '阿宁' }, message: [{ type: 'text', data: { text } }] }) };
}
const owner = { principal: { kind: 'owner' } };
const facts = f => f.memory.view(f.scope.accountId).sections.flatMap(section => section.facts);

test('role cards inherit the global persona and keep the same memory identity after edits and resets', async t => {
  const f = fixture(t), original = f.store.roleCards.view(f.scope);
  assert.equal(original.inherited, true);
  assert.deepEqual(f.store.conversationPersona(f.scope.accountId, 'private', 'alice'), f.store.persona());
  await f.write('我不吃香菜。');
  const bytes = fs.readFileSync(f.memory.paths(f.scope.accountId).file);
  const saved = f.store.roleCards.save(f.scope, { ...emptyRoleCard(), label: '老朋友', style: '说话自然直接', addressAs: '阿宁' }, original.revision);
  assert.equal(saved.roleId, original.roleId); assert.equal(saved.inherited, false);
  assert.equal(f.store.conversationPersona(f.scope.accountId, 'private', 'alice').roleCard.addressAs, '阿宁');
  assert.equal(facts(f)[0].roleId, saved.roleId);
  const reopened = new StateStore(f.root);
  assert.deepEqual(reopened.roleCards.view(f.scope), saved);
  assert.equal(reopened.roleCards.save(f.scope, emptyRoleCard(), saved.revision).roleId, original.roleId);
  assert.deepEqual(fs.readFileSync(f.memory.paths(f.scope.accountId).file), bytes);
  assert.throws(() => f.store.roleCards.save(f.scope, emptyRoleCard(), saved.revision), { code: 'ROLE_CARD_CHANGED' });
});

test('same card content in two conversations or accounts does not share facts or role ids', async t => {
  const f = fixture(t), bob = { ...f.scope, peerId: 'bob' };
  for (const scope of [f.scope, bob]) f.store.roleCards.save(scope, { ...emptyRoleCard(), label: '朋友' }, 'empty');
  await f.write('我只喝美式咖啡。');
  assert.notEqual(f.store.roleCards.identity(f.scope), f.store.roleCards.identity(bob));
  assert.notEqual(f.store.roleCards.identity(f.scope), f.store.roleCards.identity({ ...f.scope, accountId: 'different-owner' }));
  assert(!f.memory.roleContext(bob, { text: '我喝什么咖啡' }).memory.includes('美式'));
});

test('owner RPC validates account, known conversation, fields and optimistic card revisions', async t => {
  const f = fixture(t), before = await f.rpc('memory.role.get', f.scope, signal(), owner);
  assert(before.ok);
  assert.equal((await f.rpc('memory.role.save', { ...f.scope, revision: 'empty', card: emptyRoleCard() }, signal(), { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await f.rpc('memory.role.get', { ...f.scope, accountId: 'foreign' }, signal(), owner)).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await f.rpc('memory.role.get', { ...f.scope, peerId: 'unknown' }, signal(), owner)).error.code, 'MEMORY_CONVERSATION_MISSING');
  assert.equal((await f.rpc('memory.role.save', { ...f.scope, revision: 'empty', card: { scope: 'foreign' } }, signal(), owner)).error.code, 'ROLE_CARD_INVALID');
  const payload = { ...f.scope, revision: 'empty', card: { ...emptyRoleCard(), relationship: '同事' } };
  assert((await f.rpc('memory.role.save', payload, signal(), owner)).ok);
  assert.equal((await f.rpc('memory.role.save', payload, signal(), owner)).error.code, 'ROLE_CARD_CHANGED');
  assert.equal((await f.rpc('memory.role.get', f.scope, signal(), owner)).value.card.relationship, '同事');
});

test('source-backed personal facts survive reopening and deletion blocks changed-quote replay', async t => {
  const f = fixture(t), source = await f.write('我喝咖啡时用燕麦奶，别的饮品不要求。');
  const fact = facts(f)[0]; assert.equal(fact.subjectId, 'alice'); assert.equal(fact.state, 'active');
  assert(fact.text.includes('阿宁说：')); assert(fact.rawClaim.includes('别的饮品'));
  const reopened = new LongTermMemory(f.store, { now: f.now });
  assert(reopened.roleContext({ ...f.scope, senderId: 'alice' }, { text: '帮我写咖啡备注' }).memory.includes('燕麦奶'));
  reopened.deleteFacts(f.scope.accountId, { factIds: [fact.id], revision: reopened.view(f.scope.accountId).revision, confirmDelete: true });
  assert.equal(reopened.capture(f.scope, [{ ...source, text: source.text + ' 补充一下。' }]).pendingCount, 0);
  assert(!reopened.prompt(f.scope).includes('燕麦奶'));
});

test('legacy Markdown remains byte-identical and unassigned instead of becoming the current speaker', async t => {
  const f = fixture(t), source = f.entry('阿哲喜欢红茶。'); f.memory.capture(f.scope, [source]);
  await f.memory.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text: '阿哲喜欢红茶。', sources: ['s1'], replaces: [] }] }) }) }, signal());
  const file = f.memory.paths(f.scope.accountId).file, before = fs.readFileSync(file);
  const projected = f.memory.roleContext({ ...f.scope, senderId: 'alice' }, { text: '我喜欢喝什么' });
  assert(!projected.memory.includes('红茶')); assert(projected.legacyMemory.includes('人物尚未确认'));
  assert(f.memory.prompt(f.scope).includes('红茶')); assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(facts(f)[0].subjectId, undefined);
});

test('independent facts in adjacent clauses do not steal each other conditions', async t => {
  const f = fixture(t), text = '我不吃香菜，咖啡只喝美式。'; f.memory.capture(f.scope, [f.entry(text)]);
  await f.memory.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: ['我不吃香菜', '咖啡只喝美式'].map(quote => ({
    subjectId: 'alice', text: quote, sources: ['s1'], evidence: [{ source: 's1', quote }], replaces: [], expiresAt: null })), unresolved: [] }) }) }, signal());
  assert.equal(facts(f).length, 2); assert(facts(f).every(fact => fact.state === 'active'));
  const conditional = '喝咖啡时，才用燕麦奶。'; f.memory.capture(f.scope, [f.entry(conditional)]);
  await assert.rejects(f.memory.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [{ subjectId: 'alice', text: '用燕麦奶',
    sources: ['s1'], evidence: [{ source: 's1', quote: '才用燕麦奶' }], replaces: [] }] }) }) }, signal()), { code: 'LONG_MEMORY_EXTRACTION_FAILED' });
});

for (const reverse of [false, true]) test(`duplicate corrections remain pending regardless of proposal order: ${reverse}`, async t => {
  const f = fixture(t); await f.write('我喜欢牛奶。'); const old = facts(f)[0]; f.advance(1000);
  const text = '更正一下，我现在改喝燕麦奶。'; f.memory.capture(f.scope, [f.entry(text)]);
  const first = { subjectId: 'alice', text, sources: ['s1'], evidence: [{ source: 's1', quote: text }], replaces: [] },
    proposals = [first, { ...first, replaces: [old.id] }];
  await f.memory.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: reverse ? proposals.reverse() : proposals, unresolved: [] }) }) }, signal());
  const all = facts(f), pending = all.filter(fact => fact.state === 'pending');
  assert.equal(pending.length, 1); assert.deepEqual(pending[0].replaces, [old.id]);
  assert.equal(f.memory.usableFacts(all).length, 0);
  const doc = f.memory.view(f.scope.accountId);
  f.memory.resolveFact(f.scope.accountId, { factId: pending[0].id, decision: 'accept', revision: doc.revision });
  assert.equal(f.memory.usableFacts(facts(f)).length, 1);
  assert(f.memory.prompt(f.scope).includes('管理员已确认适用'));
});

test('expired correction no longer suppresses an otherwise valid fact', async t => {
  const f = fixture(t); await f.write('我喜欢牛奶。'); const old = facts(f)[0]; f.advance(1000);
  await f.write('更正，我现在改喝燕麦奶，有效至今天结束。', { replaces: [old.id], expiresAt: new Date(f.now() + 1000).toISOString() });
  assert.equal(f.memory.usableFacts(facts(f)).length, 0); f.advance(1500);
  assert.equal(f.memory.usableFacts(facts(f)).length, 1);
  const candidate = facts(f).find(fact => fact.state === 'pending');
  assert.throws(() => f.memory.resolveFact(f.scope.accountId, { factId: candidate.id, decision: 'accept', revision: f.memory.view(f.scope.accountId).revision }), { code: 'LONG_MEMORY_CONFLICT' });
});

test('a multi-person quotation keeps authors and subjects separate without rejecting the second named clause', async t => {
  const f = fixture(t);
  f.channel.memory.append(f.group, f.entry('我是阿哲。', 'bob', '阿哲'));
  const text = '我不吃香菜，阿哲喜欢红茶。'; f.memory.capture(f.group, [f.entry(text)]);
  await f.memory.extract(f.group, { run: async request => {
    const data = JSON.parse(request.text.split('\n到期时间')[0]), id = data.sources.find(source => source.text === text).id;
    return { text: JSON.stringify({ facts: ['alice', 'bob'].map(subjectId => ({
      subjectId, text: subjectId === 'alice' ? '不吃香菜' : '喜欢红茶', sources: [id], evidence: [{ source: id, quote: text }], replaces: [] })), unresolved: [] }) };
  } }, signal());
  const all = facts(f); assert.equal(all.length, 2);
  assert.equal(all.find(fact => fact.subjectId === 'alice').state, 'active');
  assert.equal(all.find(fact => fact.subjectId === 'bob').state, 'pending');
  assert.equal(all.find(fact => fact.subjectId === 'bob').sources[0].senderId, 'alice');
  assert.equal(all.find(fact => fact.subjectId === 'bob').reviewReason, 'reported');
});

for (const change of ['forged-subject', 'forged-quote', 'foreign-scope', 'future-source']) test(`invalid role extraction preserves the source: ${change}`, async t => {
  const f = fixture(t), source = f.entry('我不吃香菜。');
  if (change === 'future-source') source.time += 60000;
  f.memory.capture(f.scope, [source]);
  const row = { subjectId: change === 'forged-subject' ? 'foreign' : 'alice', text: source.text, sources: ['s1'], replaces: [],
    evidence: [{ source: 's1', quote: change === 'forged-quote' ? '我不吃花生。' : source.text }] };
  if (change === 'foreign-scope') row.scope = { ...f.scope, peerId: 'bob' };
  await assert.rejects(f.memory.extract(f.scope, { run: async () => ({ text: JSON.stringify({ facts: [row] }) }) }, signal()), { code: 'LONG_MEMORY_EXTRACTION_FAILED' });
  assert.equal(facts(f).length, 0); assert.equal(f.memory.view(f.scope.accountId).pendingCount, 1);
});

test('role projection and older context share one budget and on-demand mode omits automatic facts', async t => {
  const f = fixture(t); await f.write('我不吃香菜。');
  const role = f.memory.roleContext({ ...f.scope, senderId: 'alice' }, { text: '帮我写点单备注' });
  assert(role.memory.includes('香菜'));
  const snapshot = { entries: [], summary: '之前聊天的详细备注。'.repeat(6000) };
  const input = { snapshot, text: '帮我写点单备注', role, promptStrategy: 'progressive-v1' };
  const context = replyMemoryContext(input); assert(context.referenceChars <= 3000); assert(context.memory.includes('香菜'));
  assert.equal(replyMemoryContext({ ...input, onDemand: true }).memory, undefined);
});

test('actual chat requests receive the selected card and person facts while another conversation inherits defaults', async t => {
  const f = fixture(t); await f.write('我不吃香菜。');
  let reviewInput;
  f.runner.reviewMemoryReply = async (input, text) => { reviewInput = input; return { text, audit: { calls: 0 } }; };
  f.store.roleCards.save(f.scope, { ...emptyRoleCard(), addressAs: '阿宁', style: '自然地直接回答' }, 'empty');
  f.channel.receive(f.message('帮我写一条点单备注'), f.scope.accountId); await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].persona.roleCard.addressAs, '阿宁'); assert(f.calls[0].memory.includes('香菜'));
  assert.deepEqual(reviewInput.speaker, f.calls[0].speaker); assert.equal(reviewInput.group, false);
  assert.equal(reviewInput.currentContext, '');
  for (const strategy of ['legacy', 'progressive-v1']) {
    const prompt = buildWechatPrompt({ ...f.calls[0], promptStrategy: strategy, requestText: f.calls[0].text });
    assert(prompt.includes('自然地直接回答')); assert(prompt.includes('会话角色卡'));
  }
  assert.equal(f.sent.length, 1); assert.equal(f.store.conversationPersona(f.scope.accountId, 'private', 'bob').roleCard, undefined);
});

test('changing a role cancels a stale reply before sending and leaves its facts intact', async t => {
  const f = fixture(t); await f.write('我不吃香菜。');
  const started = Promise.withResolvers();
  f.runner.run = async input => { started.resolve(); await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); };
  f.channel.receive(f.message('帮我写备注'), f.scope.accountId); await started.promise;
  await f.service.call('memory.role.save', { ...f.scope, card: { ...emptyRoleCard(), style: '少说一点' }, revision: 'empty' }, signal());
  await f.channel.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(facts(f).length, 1);
});

test('reflection uses one tool-free request and removes rephrased unsupported exclusions', async () => {
  let count = 0;
  const input = { text: '我吃饭有什么忌口', memory: '{"text":"阿宁说：我不吃香菜。"}', persona: { name: '朋友' } };
  const result = await reviewMemoryDraft({ run: async request => { count++; assert.deepEqual(request.tools, []); assert.equal(request.mode, 'long-memory');
    assert(!request.text.includes('expected')); return { text: '不放香菜，其他没什么要注意的。' }; } }, input, '不放香菜，其他你没提过。', { signal: signal() });
  assert.equal(count, 1); assert.equal(result.text, '不放香菜。'); assert.equal(result.audit.outcome, 'revised');
  assert.deepEqual(memoryReviewFlags({ text: '原样输出：你没说过' }, '你没说过'), []);
  const continued = await reviewMemoryDraft({ run: async () => ({ text: '你之前说阿哲不吃香菜。他最近只提过在忙项目，没说过忌口。' }) },
    { ...input, text: '阿哲不吃什么' }, '你之前说阿哲不吃香菜。他最近只提过在忙项目，没说过忌口。');
  assert.equal(continued.text, '你之前说阿哲不吃香菜。');
  const connective = await reviewMemoryDraft({ run: async () => ({ text: '你之前说阿哲不吃香菜。除此之外，你没提过。' }) },
    { ...input, text: '阿哲不吃什么' }, '你之前说阿哲不吃香菜。除此之外，你没提过。');
  assert.equal(connective.text, '你之前说阿哲不吃香菜。');
  const failedReview = await reviewMemoryDraft({ run: async () => { throw new Error('empty review'); } },
    { ...input, text: '阿哲不吃什么' }, '阿宁转述说阿哲不吃香菜。他今天只自己说过在忙项目，没直接讲忌口。');
  assert.equal(failedReview.text, '阿宁转述说阿哲不吃香菜。');
});

test('reflection failure and timeout retain a usable draft without emitting failure templates', async () => {
  const input = { text: '我的忌口是什么', memory: '{"text":"我不吃香菜。"}' }, draft = '不放香菜，其他你没说过。';
  for (const run of [async () => { throw new Error('provider down'); }, async () => new Promise(() => {})]) {
    const result = await reviewMemoryDraft({ run }, input, draft, { signal: signal(), timeoutMs: 15 });
    assert.equal(result.text, '不放香菜。'); assert.equal(result.audit.outcome, 'fallback'); assert.equal(result.audit.calls, 1);
  }
});

test('synthesizing preferences is reviewed for separate or combined facts while simple recall stays direct', async () => {
  const memory = '{"text":"不吃香菜"}\n{"text":"咖啡只喝美式"}';
  let calls = 0;
  const runner = { run: async request => {
    calls++; assert.deepEqual(request.tools, []);
    assert.equal(JSON.parse(request.text).question, '帮我写一句点单备注');
    return { text: '不要香菜，谢谢。' };
  } };
  const result = await reviewMemoryDraft(runner, { text: '帮我写一句点单备注', memory }, '美式一杯，不要香菜。');
  assert.equal(result.text, '不要香菜，谢谢。'); assert.equal(calls, 1);
  await reviewMemoryDraft(runner, { text: '帮我写一句点单备注', memory: '{"text":"不吃香菜，咖啡只喝美式"}' }, '美式一杯，不要香菜。');
  assert.equal(calls, 2);
  await reviewMemoryDraft(runner, { text: '我喝什么咖啡来着', memory }, '美式。');
  await reviewMemoryDraft(runner, { text: '我该点什么咖啡', memory }, '美式。');
  assert.equal(calls, 2);
  assert.deepEqual(memoryReviewFlags({ text: '原样输出以下两项', memory }, '美式一杯，不要香菜。'), []);
});

test('review retains the current recipient when a group message asks about someone else', async () => {
  const input = { text: '阿哲不吃什么', speaker: { id: 'alice', name: '阿宁' }, group: true,
    memory: '以下说法尚未确认：阿宁说阿哲不吃香菜' };
  const result = await reviewMemoryDraft({ run: async request => {
    const payload = JSON.parse(request.text);
    assert.deepEqual(payload.recipient, input.speaker); assert.equal(payload.group, true);
    return { text: '你之前说阿哲不吃香菜。' };
  } }, input, '阿宁说阿哲不吃香菜。');
  assert.equal(result.text, '你之前说阿哲不吃香菜。');
});

test('reflection abort or authorization change cannot return a sendable reply', async () => {
  const controller = new AbortController(), input = { text: '忌口', memory: '以下说法尚未确认' };
  await assert.rejects(reviewMemoryDraft({ run: async () => { controller.abort(new Error('changed account')); return { text: '好' }; } }, input, '好', { signal: controller.signal }), /changed account/);
  let authorized = true;
  await assert.rejects(reviewMemoryDraft({ run: async () => { authorized = false; return { text: '好' }; } }, input, '好',
    { signal: signal(), assertAllowed: () => { if (!authorized) throw new Error('revoked'); } }), /revoked/);
});
