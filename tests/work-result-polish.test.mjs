import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { polishWorkResult, StateStore, WechatChannel, WorkStore, readWorkArtifact, workResult, ChannelError } from '../lib/testing.js';

const signal = () => new AbortController().signal;
const original = '八卡训练完成 229 步，准确率 88.37%。\n[实验记录](https://example.invalid/run/229)\n```json\n{"steps":229,"score":88.37}\n```';

test('result API receives only this finished DSH result and preserves numbers, links and code', async () => {
  let call;
  const polished = original.replace('八卡训练完成', '训练使用八卡，共完成');
  const result = await polishWorkResult({ run: async input => { call = input; return { text: polished }; } }, original, '查实验结果', signal());
  assert.equal(call.mode, 'work-result'); assert.deepEqual(call.tools, []);
  assert.deepEqual(JSON.parse(call.text), { request: '查实验结果', result: original });
  assert.equal(call.history, undefined); assert.equal(call.sessionId, undefined); assert.equal(call.workContext, undefined);
  assert.match(call.systemOverride, /不继续执行任务/); assert.equal(result.text, polished); assert.equal(result.polish.state, 'applied');
});

for (const [name, changed] of [
  ['missing number', original.replace('229 步', '若干步')],
  ['changed number', original.replace('88.37%', '98.37%')],
  ['changed link', original.replace('example.invalid', 'different.invalid')],
  ['changed code', original.replace('"steps"', '"updates"')],
  ['empty response', ''],
]) test(`polishing falls back to the DSH text after ${name}`, async () => {
  const result = await polishWorkResult({ run: async () => ({ text: changed }) }, original, '查实验结果', signal());
  assert.equal(result.text, original); assert.equal(result.polish.state, 'fallback');
});

test('polish API error retains original text, while explicit cancellation is respected', async () => {
  const runner = { run: async () => { throw new ChannelError('API_OFFLINE', '模拟聊天 API 不可用'); } };
  const result = await polishWorkResult(runner, original, '查实验结果', signal());
  assert.equal(result.text, original); assert.equal(result.polish.state, 'fallback'); assert.equal(result.polish.error.code, 'API_OFFLINE');
  const controller = new AbortController(); controller.abort(new ChannelError('WORK_CANCELLED', '已取消'));
  await assert.rejects(polishWorkResult(runner, original, '查实验结果', controller.signal), { code: 'WORK_CANCELLED' });
});

function fixture(t, api) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-work-polish-')), store = new StateStore(root);
  const scope = { accountId: 'polish-owner', chatType: 'private', peerId: 'alice', senderId: 'alice' }, sent = [];
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice'], groups: [], prompt: 'chat-only' });
  store.setConversationSettings(scope.accountId, 'private', 'alice', { ...store.conversationSettings(scope.accountId, 'private', 'alice'), executionMode: 'work' });
  const channel = new WechatChannel({ store, runner: { run: api }, transport: {
    status: () => ({ online: true, account: { id: scope.accountId } }), send: async payload => { sent.push(payload); return { delivery: 'server-ack', serverMessageIds: ['polish-ack'] }; },
  }, workRunner: { run: async input => {
    await input.onSession('native-polish-session', { native: true });
    fs.writeFileSync(path.join(input.cwd, 'metrics.csv'), 'steps,score\n229,88.37\n');
    return { text: original, native: true, artifacts: [readWorkArtifact(input.cwd, 'metrics.csv').metadata] };
  } } });
  t.after(async () => { await channel.close(); assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^wechat-work-polish-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, scope, channel, sent };
}

test('cancelling only the polish phase preserves original DSH text and already validated file metadata', async t => {
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  const f = fixture(t, async input => { started.resolve(); await released.promise; return { text: JSON.parse(input.text).result }; });
  const job = f.channel.work.create(f.scope, '使用 SSH 查看八卡实验结果'); await started.promise;
  assert.equal(f.channel.work.get(job.id, f.scope).nativeExecution, true);
  f.channel.work.cancel(job.id, f.scope); released.resolve(); await f.channel.whenIdle();
  const saved = new WorkStore(f.store).get(job.id);
  assert.equal(saved.state, 'cancelled'); assert.equal(saved.result.originalText, original); assert.equal(saved.result.artifacts[0].name, 'metrics.csv');
  assert.equal(saved.delivery.state, 'suppressed'); assert.equal(f.sent.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(job.cwd, 'metrics.csv'), 'utf8'), 'steps,score\n229,88.37\n');
});

test('native SSH results survive restart without requiring a WeChat-specific SSH command record', async t => {
  const f = fixture(t, async () => { throw new ChannelError('API_OFFLINE', '模拟聊天 API 不可用'); });
  const created = f.channel.work.create(f.scope, '使用 SSH 查看八卡实验结果'); await f.channel.whenIdle();
  const job = new WorkStore(f.store).get(created.id);
  assert.equal(job.state, 'succeeded'); assert.equal(job.nativeExecution, true); assert.deepEqual(job.operations, []);
  assert.equal(job.result.text, original); assert.equal(job.result.polish.state, 'fallback');
  const archive = workResult(job, created.cwd, { full: true });
  assert.match(archive, /原生工具和命令的执行记录保留在 DSH 会话/); assert(!archive.includes('未执行命令'));
});

test('WeChat text removes registered local image Markdown while the full DSH record keeps it', () => {
  const text = '小狗图片已生成。\n\n![小狗](./puppy.png)\n![远程参考](https://example.invalid/puppy.png)\n![未登记](other.png)\n`![代码](puppy.png)`\n```markdown\n![代码块](puppy.png)\n```';
  const job = { id: 'abcdef012345', state: 'succeeded', operations: [], delivery: { state: 'not-ready' },
    result: { text, originalText: text, files: [], artifacts: [{ path: 'puppy.png', name: 'puppy.png', kind: 'image', bytes: 1, mediaType: 'image/png', sha256: 'a'.repeat(64) }] } };
  const reply = workResult(job, '.');
  assert(!reply.includes('![小狗]')); assert(reply.includes('![远程参考]')); assert(reply.includes('![未登记]'));
  assert(reply.includes('`![代码](puppy.png)`')); assert(reply.includes('```markdown\n![代码块](puppy.png)\n```'));
  assert(workResult(job, '.', { full: true }).includes(text)); assert.equal(job.result.text, text);
});

test('local image cleanup supports encoded names and preserves multiline inline code and tilde fences', () => {
  const job = { state: 'succeeded', operations: [], result: { text: '![图](<输出/小狗 图.png> "说明")\n![图](./%E8%BE%93%E5%87%BA/%E5%B0%8F%E7%8B%97%20%E5%9B%BE.png)\n``多行\n![代码](<输出/小狗 图.png>)``\n~~~~markdown\n![代码块](<输出/小狗 图.png>)\n~~~~',
    artifacts: [{ path: '输出/小狗 图.png', name: '小狗 图.png', kind: 'image' }] } };
  const reply = workResult(job, '.');
  assert(!reply.includes('![图]')); assert(reply.includes('``多行\n![代码]'));
  assert(reply.includes('~~~~markdown\n![代码块]'));
});

test('an image-only result uses truthful text while its server confirmation is still pending', () => {
  const job = { state: 'succeeded', operations: [], result: { text: '![小狗](puppy.png)', artifacts: [{ path: 'puppy.png', name: 'puppy.png', kind: 'image' }] } };
  assert.equal(workResult(job, '.'), '图片已生成，等待微信回执。');
});
