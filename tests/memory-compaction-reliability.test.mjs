import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compressionBatches, summarizeMemory, MAX_COMPRESSION_INPUT_CHARS } from '../modules/memory/conversation/compaction.mjs';
import { StateStore, ConversationMemory, WechatChannel, ChannelError, createPluginService } from '../lib/testing.js';

function fixture(t, { timeoutMs } = {}) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'wechat-compaction-reliability-'));
  const store = new StateStore(root), scope = { accountId: 'compact-owner', chatType: 'group', peerId: 'compact-room@chatroom' };
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  let now = Date.parse('2026-11-09T06:00:00Z');
  const memory = new ConversationMemory(store, { now: () => now });
  const runner = { run: async () => ({ text: '正常回复。' }), summarize: async () => '阿禾周五带咖啡。' };
  const transport = { status: () => ({ online: true, account: { id: scope.accountId } }),
    send: async () => assert.fail('memory maintenance must never send a WeChat message') };
  const channel = new WechatChannel({ store, memory, runner, transport, timeoutMs, now: () => now });
  const service = createPluginService({ ctx: {}, root, store, worker: transport, runner, channel });
  t.after(async () => { await channel.close(); await service.drain(); const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), base); fs.rmSync(resolved, { recursive: true, force: true }); });
  const append = key => memory.append(scope, { key, time: now, senderId: 'alice', senderName: '阿禾',
    direction: 'incoming', text: '阿禾周五带咖啡。' + '普通重复消息。'.repeat(90) });
  const idle = async () => { await new Promise(resolve => setImmediate(resolve)); await channel.whenIdle(); };
  return { root, scope, store, memory, runner, channel, service, append, idle, tick: ms => { now += ms; } };
}

test('large messages retain exact text, image notes, speaker and timestamps in bounded valid JSON fragments', () => {
  const source = { time: 1794206659000, speaker: '阿禾', senderId: 'alice', direction: 'incoming',
    text: ('来源“原话”\\\n😀\u0001').repeat(5000), images: [{ type: 'image', quality: 'original', description: '已看清的图片内容。'.repeat(3000) }] };
  const batches = compressionBatches(JSON.stringify(source));
  assert(batches.length > 2); assert(batches.every(batch => batch.length <= MAX_COMPRESSION_INPUT_CHARS));
  const fragments = batches.flatMap(batch => batch.split('\n').map(line => JSON.parse(line)));
  assert.equal(fragments.map(row => row.text).join(''), source.text);
  assert.equal(fragments.flatMap(row => row.images ?? []).map(image => image.description).join(''), source.images[0].description);
  assert(fragments.every(row => row.senderId === source.senderId && row.speaker === source.speaker && row.time === source.time && row.direction === source.direction));
  assert(fragments.every(row => !/[\uD800-\uDBFF]$/.test(row.text)));
});

const largeMaterial = () => Array.from({ length: 620 }, (_, index) => JSON.stringify({ time: 1794200000000 + index,
  speaker: '阿禾', senderId: 'alice', direction: 'incoming', text: `source-${index}：` + '普通对话。'.repeat(15) + (index === 619 ? '预算更正为980元。' : '旧预算100元。') })).join('\n');

test('large-memory requests use at most two concurrent bounded inputs, a frozen model and an ordered final consolidation', async () => {
  let active = 0, maximumActive = 0, snapshots = 0;
  const inputs = [], snapshot = { selection: { provider: 'fixture', model: 'captured' }, runtime: { modelConfig: { temperature: 0.2 } } };
  const runner = { memoryExecutionSnapshot: async () => { snapshots++; return snapshot; },
    summarize: async (material, _target, signal, retry) => {
      inputs.push({ material, retry }); assert(material.length <= MAX_COMPRESSION_INPUT_CHARS); assert.equal(retry.executionSnapshot, snapshot);
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setImmediate(resolve)); signal.throwIfAborted(); active--;
      return material.includes('980元') ? '阿禾：预算已更正为980元。' : '阿禾：旧预算100元。';
    } };
  const result = await summarizeMemory(largeMaterial(), 4000, runner, new AbortController().signal);
  assert.equal(result, '阿禾：预算已更正为980元。'); assert.equal(snapshots, 1); assert.equal(maximumActive, 2);
  assert(inputs.filter(input => input.retry.batch).length > 3);
  const final = inputs.at(-1).material;
  assert(final.indexOf('旧预算100元') < final.lastIndexOf('更正为980元'));
});

test('a failed batch preserves validated parts for retry without reusing changed evidence', async () => {
  const cache = new Map(), calls = []; let fail = true;
  const runner = { summarize: async (material, _target, _signal, retry) => {
    calls.push(material);
    if (retry.batch?.index === 2 && fail) {
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new ChannelError('MODEL_INCOMPLETE', '模型请求传输失败');
    }
    return '阿禾：预算更正为980元。';
  } };
  await assert.rejects(summarizeMemory(largeMaterial(), 4000, runner, new AbortController().signal, cache), { code: 'MODEL_INCOMPLETE' });
  assert(cache.size > 0);
  const beforeRetry = calls.length; fail = false;
  assert.equal(await summarizeMemory(largeMaterial(), 4000, runner, new AbortController().signal, cache), '阿禾：预算更正为980元。');
  assert(calls.length - beforeRetry < compressionBatches(largeMaterial()).length + 1);
  const beforeChange = calls.length;
  await summarizeMemory(largeMaterial().replace('source-0', 'changed-source-0'), 4000, runner, new AbortController().signal, cache);
  assert(calls.slice(beforeChange).some(input => input.includes('changed-source-0')));
});

test('manual compression returns acceptance while the model is running and only commits after completion', { timeout: 5000 }, async t => {
  const f = fixture(t), reached = Promise.withResolvers(), gate = Promise.withResolvers();
  f.append('manual-first'); f.append('manual-last');
  const original = f.memory.load(f.scope);
  f.runner.summarize = async () => { reached.resolve(); await gate.promise; return '阿禾周五带咖啡。'; };
  await f.service.call('memory.compress', f.scope);
  await reached.promise;
  assert.equal(f.memory.view(f.scope).compacting, true); assert.equal(f.memory.view(f.scope).compressions, 0);
  assert.deepEqual(f.memory.load(f.scope), original);
  gate.resolve(); await f.idle();
  const after = f.memory.view(f.scope); assert.equal(after.compacting, false); assert.equal(after.compressionQueued, false);
  assert.equal(after.compressions, 1); assert.equal(after.error, null);
  const archiveDir = path.join(path.dirname(after.path), 'archive');
  const archive = fs.readdirSync(archiveDir).find(name => name.endsWith('before-compaction.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archiveDir, archive), 'utf8')), original);
});

test('failed manual compression below the window keeps its force flag and retries the original evidence', async t => {
  const f = fixture(t); f.append('retry-original'); let calls = 0;
  const original = f.memory.load(f.scope);
  f.runner.summarize = async material => {
    assert(material.includes('阿禾周五带咖啡'));
    if (!calls++) throw new ChannelError('MODEL_INCOMPLETE', '模型请求传输失败');
    return '阿禾周五带咖啡。';
  };
  await f.service.call('memory.compress', f.scope); await f.idle();
  const failed = f.memory.view(f.scope);
  assert(failed.chars < failed.windowChars); assert.match(failed.error, /传输失败/);
  assert.equal(failed.retryKind, 'compression'); assert.deepEqual(f.memory.load(f.scope), original);
  f.tick(30000); f.channel.checkMemoryPressure(); await f.idle();
  assert.equal(calls, 2); assert.equal(f.memory.view(f.scope).compressions, 1); assert.equal(f.memory.view(f.scope).error, null);
});

test('a manual request during durable-fact extraction yields that call and cannot be consumed by the earlier no-op compaction', { timeout: 5000 }, async t => {
  const f = fixture(t), reached = Promise.withResolvers(); let extractions = 0, compressed = 0;
  f.runner.extractLongTermMemory = async () => {};
  f.channel.longMemory.extract = async (_scope, _runner, signal) => {
    if (++extractions !== 1) return;
    reached.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  f.runner.summarize = async () => { compressed++; return '阿禾周五带咖啡。'; };
  f.append('pending-facts'); await reached.promise;
  await f.service.call('memory.compress', f.scope); await f.idle();
  assert.equal(compressed, 1); assert.equal(f.memory.view(f.scope).compressions, 1);
  assert.equal(f.channel.memoryForced.size, 0); assert.equal(f.memory.view(f.scope).error, null);
});

test('a later edit cannot be overwritten by a completed compression batch', async t => {
  const f = fixture(t), reached = Promise.withResolvers(), gate = Promise.withResolvers(); f.append('edit-source');
  f.runner.summarize = async () => { reached.resolve(); await gate.promise; return '旧摘要候选。'; };
  await f.service.call('memory.compress', f.scope); await reached.promise;
  const current = f.memory.view(f.scope); f.memory.edit(f.scope, '管理员的新记忆。', current.revision);
  gate.resolve(); await f.idle();
  const after = f.memory.view(f.scope); assert.equal(after.summary, '管理员的新记忆。'); assert.equal(after.compressions, 0);
  assert.match(after.error, /已被修改/); assert(after.entries.some(row => row.key === 'edit-source'));
});

test('clearing memory cancels a pending manual retry instead of restoring the cleared source', async t => {
  const f = fixture(t); f.append('clear-source');
  f.runner.summarize = async () => { throw new ChannelError('MODEL_INCOMPLETE', '模型请求传输失败'); };
  await f.service.call('memory.compress', f.scope); await f.idle();
  assert(f.channel.memoryForced.size > 0);
  await f.service.call('memory.clear', f.scope); f.tick(30000); f.channel.checkMemoryPressure(); await f.idle();
  assert.equal(f.channel.memoryForced.size, 0); assert.equal(f.memory.view(f.scope).summary, '');
  assert.deepEqual(f.memory.view(f.scope).entries, []); assert.equal(f.memory.view(f.scope).compressions, 0);
});

test('slow durable-fact extraction cannot consume the timeout before window compression succeeds', async t => {
  const f = fixture(t, { timeoutMs: 25 }); f.memory.setWindowChars(1000); let compressed = false, extractionSignal;
  f.runner.summarize = async () => { compressed = true; return '阿禾周五带咖啡。'; };
  f.runner.extractLongTermMemory = async ({ signal }) => {
    assert(compressed); extractionSignal = signal;
    // A real pending provider owns I/O. Keep this bounded fixture alive until
    // the application's unreferenced timeout cancels that request.
    await delay(5000, undefined, { signal }).catch(error => { throw signal.reason ?? error; });
  };
  f.append('extraction-timeout'); f.append('extraction-pressure'); await f.idle();
  const after = f.memory.view(f.scope); assert.equal(after.compressions, 1); assert.equal(after.error, null);
  assert.equal(extractionSignal.aborted, true, 'the model request must be cancelled by its deadline');
  assert.equal(after.retryKind, 'extraction'); assert(f.channel.longMemory.view(f.scope.accountId).pendingCount > 0);
});

test('compression timeouts expose a useful cause and retain the unmodified source', async t => {
  const f = fixture(t, { timeoutMs: 25 }); f.memory.setWindowChars(1000);
  f.runner.summarize = async (_material, _target, signal) => delay(5000, 'unexpected late result', { signal })
    .catch(error => { throw signal.reason ?? error; });
  f.append('compression-timeout'); f.append('compression-pressure'); const before = f.memory.load(f.scope);
  await f.idle();
  const after = f.memory.view(f.scope); assert.match(after.error, /等待模型超时/);
  assert.equal(after.retryKind, 'compression'); assert.equal(after.compressions, 0); assert.equal(after.compacting, false);
  assert.deepEqual(f.memory.load(f.scope), before);
});
