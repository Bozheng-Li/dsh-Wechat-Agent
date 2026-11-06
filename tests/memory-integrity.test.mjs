import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, ConversationMemory, conversationMemoryTool } from '../lib/testing.js';
import { LongTermMemory } from '../src/long-term-memory.mjs';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const accountId = 'memory_integrity_owner', peerId = 'memory-integrity@chatroom';
const signal = () => new AbortController().signal;
const entry = (key, text, extra = {}) => ({ key, text, direction: 'incoming', senderId: 'alice', senderName: '阿禾', time: Date.now(), ...extra });
const extractor = facts => ({ run: async () => ({ text: JSON.stringify({ facts }) }) });
const fact = (text, replaces = []) => ({ text, sources: ['s1'], replaces });
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'memory-integrity-'));
  const store = new StateStore(root);
  store.configure(accountId, { enabled: true, groups: [peerId], privatePeers: [], prompt: '' });
  const local = new ConversationMemory(store); store.memory = local; local.onPressure = null;
  const long = new LongTermMemory(store), scope = { accountId, chatType: 'group', peerId };
  t.after(() => {
    const resolved = fs.realpathSync(root), relative = path.relative(fs.realpathSync(base), resolved);
    assert(relative.startsWith('memory-integrity-') && !relative.includes('..') && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, store, local, long, scope };
}

test('a same-wording correction keeps a usable long-term fact after restart', async t => {
  const f = fixture(t);
  f.long.capture(f.scope, [entry('original-preference', '我喜欢猫。')]);
  await f.long.extract(f.scope, extractor([fact('阿禾喜欢猫。')]), signal());
  const previous = f.long.view(accountId).sections[0].facts[0];
  f.long.capture(f.scope, [entry('affirmed-preference', '我说的还是喜欢猫，这点没变。')]);
  await f.long.extract(f.scope, extractor([fact('阿禾喜欢猫。', [previous.id])]), signal());
  const restored = new LongTermMemory(new StateStore(f.root));
  assert.equal(restored.view(accountId).factCount, 1);
  assert(restored.prompt(f.scope).includes('阿禾喜欢猫。'));
});

test('a correction matching an unaffected fact does not duplicate or remove that remaining fact', async t => {
  const f = fixture(t);
  f.long.capture(f.scope, [entry('original-drinks', '我常喝咖啡，也常喝茶。')]);
  await f.long.extract(f.scope, extractor([fact('阿禾常喝咖啡。'), fact('阿禾常喝茶。')]), signal());
  const coffee = f.long.view(accountId).sections[0].facts.find(value => value.text.includes('咖啡'));
  f.long.capture(f.scope, [entry('corrected-drinks', '之前咖啡说错了，我只常喝茶。')]);
  await f.long.extract(f.scope, extractor([fact('阿禾常喝茶。', [coffee.id])]), signal());
  assert.equal(f.long.view(accountId).factCount, 1);
  assert(f.long.prompt(f.scope).includes('阿禾常喝茶。'));
  assert(!f.long.prompt(f.scope).includes('阿禾常喝咖啡。'));
});

test('compaction cannot discard a picture description completed while its summary was being generated', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), started = Promise.withResolvers();
  t.after(() => gate.resolve('仅保留了普通聊天。'));
  f.local.setWindowChars(1000);
  f.local.append(f.scope, entry('picture-during-compaction', '这是本周约定的背景资料。'.repeat(160), {
    messageId: 'picture-message', attachments: [{ type: 'image', resourceId: 'picture-resource' }],
  }));
  const pending = f.local.compact(f.scope, { summarize: async () => { started.resolve(); return gate.promise; } }, signal());
  await started.promise;
  await f.local.enrich(f.scope, { describeImage: async () => '图片写明：周五十点在书店见面。' }, {
    media: async () => ({ quality: 'original', bytes: 1500 }),
  }, signal());
  gate.resolve('仅保留了普通聊天。');
  await assert.rejects(pending, { code: 'MEMORY_CHANGED' });
  assert(new ConversationMemory(new StateStore(f.root)).view(f.scope).text.includes('周五十点在书店见面'));
});

test('cancelling image understanding prevents a late model response from changing stored memory', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), started = Promise.withResolvers(), controller = new AbortController();
  t.after(() => gate.resolve('过期图像描述'));
  f.local.append(f.scope, entry('cancelled-picture', '[图片]', { messageId: 'cancelled-picture-message', attachments: [{ type: 'image', resourceId: 'cancelled-resource' }] }));
  const before = f.local.load(f.scope);
  const pending = f.local.enrich(f.scope, { describeImage: async () => { started.resolve(); return gate.promise; } }, {
    media: async () => ({ quality: 'original', bytes: 1500 }),
  }, controller.signal);
  await started.promise; controller.abort(new Error('图像理解已取消')); gate.resolve('过期图像描述');
  await assert.rejects(pending, /图像理解已取消/);
  assert.deepEqual(f.local.load(f.scope), before);
});

test('invalid UTF-8 in authoritative long-term memory is withheld from prompts and archived intact on repair', t => {
  const f = fixture(t), original = f.long.view(accountId);
  const marker = '<!-- wechat-global:begin -->', split = original.markdown.indexOf(marker) + marker.length;
  const bytes = Buffer.concat([Buffer.from(original.markdown.slice(0, split)), Buffer.from([0x0a, 0xe4, 0xb8, 0x0a]), Buffer.from(original.markdown.slice(split))]);
  fs.writeFileSync(original.path, bytes);
  assert.equal(f.long.prompt(f.scope), '');
  const broken = f.long.view(accountId);
  assert.equal(broken.invalid, true); assert.match(broken.error, /UTF-8/);
  assert.deepEqual(fs.readFileSync(original.path), bytes);
  f.long.edit(accountId, original.markdown, broken.revision);
  const archive = path.join(path.dirname(original.path), 'global-memory-archive');
  assert(fs.readdirSync(archive).some(file => fs.readFileSync(path.join(archive, file)).equals(bytes)));
  assert.equal(f.long.view(accountId).invalid, false);
});

test('invalid UTF-8 in conversation memory is reported without feeding replacement characters into a reply', t => {
  const f = fixture(t);
  f.local.append(f.scope, entry('valid-text', '这是需要保留的中文记忆。'));
  const file = f.local.view(f.scope).path, valid = fs.readFileSync(file), needle = Buffer.from('这是需要保留的中文记忆。');
  const split = valid.indexOf(needle); assert(split >= 0);
  const bytes = Buffer.concat([valid.subarray(0, split), Buffer.from([0xe4, 0xb8]), valid.subarray(split + needle.length)]);
  fs.writeFileSync(file, bytes);
  assert.throws(() => f.local.view(f.scope), { code: 'MEMORY_INVALID' });
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a non-file long-term document is read-only and all document mutations reject before model work', async t => {
  const f = fixture(t), original = f.long.view(accountId);
  fs.renameSync(original.path, original.path + '.original'); fs.mkdirSync(original.path);
  f.long.capture(f.scope, [entry('retained-for-repair', '我们每周五十点开会。')]);
  const broken = f.long.view(accountId);
  assert.equal(broken.invalid, true); assert.equal(broken.readOnly, true);
  assert.equal(broken.markdown, ''); assert.equal(broken.revision, null);
  assert.equal(broken.pendingCount, 1);
  assert.throws(() => f.long.edit(accountId, original.markdown, broken.revision), { code: 'LONG_MEMORY_INVALID' });
  assert.throws(() => f.long.clear(accountId), { code: 'LONG_MEMORY_INVALID' });
  let calls = 0;
  await assert.rejects(f.long.extract(f.scope, { run: async () => { calls++; return { text: '{"facts":[]}' }; } }, signal()), { code: 'LONG_MEMORY_INVALID' });
  assert.equal(calls, 0); assert.equal(f.long.view(accountId).pendingCount, 1);
  assert.equal(fs.readFileSync(original.path + '.original', 'utf8'), original.markdown);
});

test('editing or clearing cannot archive memory through a redirected archive directory', t => {
  const f = fixture(t), original = f.long.view(accountId);
  const archive = path.join(path.dirname(original.path), 'global-memory-archive');
  const redirected = path.join(f.root, 'redirected-archive'); fs.mkdirSync(redirected);
  fs.symlinkSync(redirected, archive, 'junction');
  const next = original.markdown.replace('<!-- wechat-global:begin -->', '<!-- wechat-global:begin -->\n新的全局约定。');
  assert.throws(() => f.long.edit(accountId, next, original.revision), { code: 'LONG_MEMORY_INVALID' });
  assert.throws(() => f.long.clear(accountId), { code: 'LONG_MEMORY_INVALID' });
  assert.deepEqual(fs.readdirSync(redirected), []);
  assert.equal(fs.readFileSync(original.path, 'utf8'), original.markdown);
});

test('a keyword near the end of a long memory line is included in the returned search excerpt', async () => {
  const note = '背景。'.repeat(10000) + '阿禾的书店约定：每周五十点见面。' + '补充背景。'.repeat(10000);
  const scope = { accountId, chatType: 'group', peerId };
  const tool = conversationMemoryTool({}, { prompt: input => { assert.deepEqual(input, scope); return note; } }, scope, () => {});
  const result = JSON.parse(await tool.execute({ section: 'long-term', query: '书店约定' }, {}));
  assert.equal(result.found, true);
  assert(result.text.includes('阿禾的书店约定：每周五十点见面。'));
  assert(result.text.length <= 24000); assert.equal(result.truncated, true);
});

test('model-generated multi-keyword queries recall relevant facts instead of requiring the entire phrase', async () => {
  const scope = { accountId, chatType: 'group', peerId };
  const text = '- 阿禾一直喜欢猫。\n- 阿禾将青藤书店见面改到2026年11月15日下午15:00。\n- 小林每天晚饭后散步。\n' + '无关背景资料。\n'.repeat(1000);
  const tool = conversationMemoryTool({}, { prompt: () => text }, scope, () => {});
  const result = JSON.parse(await tool.execute({ section: 'long-term', query: '阿禾 见面 约定 偏好' }, {}));
  assert.equal(result.found, true);
  assert(result.text.includes('阿禾一直喜欢猫。'));
  assert(result.text.includes('2026年11月15日下午15:00'));
  assert(!result.text.includes('小林每天晚饭后散步'));
});

test('different keywords far apart in one long line both keep their matching context', async () => {
  const scope = { accountId, chatType: 'group', peerId };
  const text = '阿禾是活动联系人。' + '背景。'.repeat(10000) + '青藤书店约定：星期日下午三点。';
  const tool = conversationMemoryTool({}, { prompt: () => text }, scope, () => {});
  const result = JSON.parse(await tool.execute({ section: 'long-term', query: '阿禾 书店约定' }, {}));
  assert.equal(result.found, true); assert.equal(result.truncated, true);
  assert(result.text.includes('阿禾是活动联系人。'));
  assert(result.text.includes('青藤书店约定：星期日下午三点。'));
  assert(result.text.length <= 24000);
});

test('short scoped memory preserves preferences expressed differently from the model query', async () => {
  const scope = { accountId, chatType: 'group', peerId };
  const text = '- 阿禾一直喜欢猫。\n- 阿禾将见面改为2026年11月15日下午15:00，地点仍为青藤书店。';
  const tool = conversationMemoryTool({}, { prompt: input => { assert.deepEqual(input, scope); return text; } }, scope, () => {});
  const result = JSON.parse(await tool.execute({ section: 'long-term', query: '见面 日期 时间 地点 偏好' }, {}));
  assert(result.text.includes('阿禾一直喜欢猫。'));
  assert.equal(result.found, true); assert.equal(result.queryMatched, true);
  assert.equal(result.coverage, 'complete'); assert.equal(result.omitted, false);
});

test('an unmatched keyword cannot report an existing short memory as an empty database', async () => {
  const scope = { accountId, chatType: 'group', peerId };
  const text = '- 阿禾一直喜欢猫。';
  const tool = conversationMemoryTool({}, { prompt: () => text }, scope, () => {});
  const result = JSON.parse(await tool.execute({ section: 'long-term', query: '偏好' }, {}));
  assert.equal(result.found, true); assert.equal(result.queryMatched, false);
  assert.equal(result.text, text); assert.equal(result.coverage, 'complete');
});

test('filtered large memory tells the model that unmatched facts may be omitted', async () => {
  const scope = { accountId, chatType: 'group', peerId };
  const text = '- 阿禾一直喜欢猫。\n' + '无关背景资料。\n'.repeat(1000) + '- 青藤书店见面定于周日下午三点。';
  const tool = conversationMemoryTool({}, { prompt: () => text }, scope, () => {});
  const result = JSON.parse(await tool.execute({ section: 'long-term', query: '青藤书店 偏好' }, {}));
  assert.equal(result.coverage, 'matches'); assert.equal(result.omitted, true);
  assert(result.matchedTerms.includes('青藤书店')); assert(result.unmatchedTerms.includes('偏好'));
  assert(result.guidance.includes('不代表没有记录')); assert(result.guidance.includes('省略 query'));
});
