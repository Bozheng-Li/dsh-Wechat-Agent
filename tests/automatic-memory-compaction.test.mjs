import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, ConversationMemory, WechatChannel, ChannelError, memoryText, validateConversationSettings } from '../lib/testing.js';

function fixture(t, { prefill = false, offline = false } = {}) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-auto-compact-'));
  const store = new StateStore(root), scope = { accountId: 'auto-memory-owner', chatType: 'group', peerId: 'auto-memory@chatroom' };
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  let at = Date.parse('2026-11-07T05:00:00Z'), calls = 0; const now = () => at;
  const memory = new ConversationMemory(store, { now }); memory.setWindowChars(1000);
  const source = key => ({ key, text: '阿禾喜欢猫，周五带咖啡。' + '普通重复内容。'.repeat(240), direction: 'incoming', senderId: 'alice', time: at });
  if (prefill) memory.append(scope, source('startup-pressure'));
  const runner = { run: async () => ({ text: '普通回复' }), summarize: async () => { calls++; return '阿禾喜欢猫，周五带咖啡。'; } };
  const status = { online: !offline, account: { id: scope.accountId } };
  const transport = { status: () => status, send: async () => { throw new Error('Automatic memory maintenance cannot send a message'); } };
  const channel = new WechatChannel({ store, memory, runner, transport, now });
  t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('wechat-auto-compact-')); fs.rmSync(resolved, { recursive: true, force: true }); });
  const idle = async () => { await new Promise(resolve => setImmediate(resolve)); await channel.whenIdle(); };
  return { root, store, scope, memory, runner, channel, status, source, idle, now, calls: () => calls, tick: ms => { at += ms; } };
}

test('window pressure automatically shrinks an overlong model candidate and commits an archived valid summary', async t => {
  const f = fixture(t); let calls = 0; const targets = [];
  f.runner.summarize = async (material, target, signal, retry) => { calls++; targets.push(target); if (calls === 1) return '长摘要。'.repeat(200); assert.equal(retry.attempt, 1); assert(material.includes('长摘要')); return '阿禾喜欢猫，周五带咖啡。'; };
  f.memory.append(f.scope, f.source('incoming-pressure')); await f.idle();
  const doc = f.memory.view(f.scope); assert.equal(calls, 2); assert(targets[1] < targets[0]); assert(doc.chars < 1000); assert(doc.compressions > 0); assert.equal(doc.error, null);
  assert(fs.readdirSync(path.join(path.dirname(doc.path), 'archive')).some(name => name.endsWith('before-compaction.json')));
});

test('an oversized saved window is compressed automatically on startup without a new message', async t => {
  const f = fixture(t, { prefill: true }); await f.idle(); assert.equal(f.calls(), 1); assert(f.memory.view(f.scope).chars < 1000);
});

test('automatic failures preserve source memory and retry after backoff without manual compression', async t => {
  const f = fixture(t); let calls = 0;
  f.runner.summarize = async () => { calls++; if (calls === 1) throw new ChannelError('MODEL_UNAVAILABLE', '合成服务离线'); return '阿禾喜欢猫，周五带咖啡。'; };
  f.memory.append(f.scope, f.source('retry-pressure')); await f.idle();
  const failed = f.memory.view(f.scope); assert(failed.entries.some(entry => entry.key === 'retry-pressure')); assert(failed.error); assert.equal(failed.retryAt, f.now() + 30000);
  f.channel.checkMemoryPressure(); await f.idle(); assert.equal(calls, 1);
  f.tick(30000); f.channel.checkMemoryPressure(); await f.idle();
  assert.equal(calls, 2); assert(f.memory.view(f.scope).chars < 1000); assert.equal(f.memory.view(f.scope).retryAt, null); assert.equal(f.memory.view(f.scope).error, null);
});

test('long-term extraction failure does not block automatic window compaction', async t => {
  const f = fixture(t); f.runner.extractLongTermMemory = async () => { throw new ChannelError('LONG_MEMORY_EXTRACTION_FAILED', '合成长期提取失败'); };
  f.memory.append(f.scope, f.source('extraction-pressure')); await f.idle();
  assert.equal(f.calls(), 1); assert(f.memory.view(f.scope).chars < 1000); assert(f.channel.longMemory.view(f.scope.accountId).pendingCount > 0);
});

test('window changes schedule automatic compaction and restored connectivity handles saved pressure', async t => {
  const f = fixture(t, { offline: true }); f.memory.setWindowChars(5000); f.memory.append(f.scope, f.source('offline-pressure')); await f.idle();
  assert.equal(f.calls(), 0); f.memory.setWindowChars(1000); await f.idle(); assert.equal(f.calls(), 0);
  f.status.online = true; f.channel.checkMemoryPressure(); await f.idle(); assert.equal(f.calls(), 1); assert(f.memory.view(f.scope).chars < 1000);
});

test('the exact window boundary triggers automatic compression and repeated empty candidates wait for retry', async t => {
  const f = fixture(t); const doc = f.memory.load(f.scope); doc.summary = '边'.repeat(1000 - memoryText({ summary: '边', entries: [] }).length + 1); doc.summaryExpiresAt = f.now() + 86400000; f.memory.save(doc);
  assert.equal(f.memory.view(f.scope).chars, 1000); f.channel.checkMemoryPressure(); await f.idle(); assert.equal(f.calls(), 1);
  f.runner.summarize = async () => ''; f.memory.append(f.scope, f.source('empty-pressure')); await f.idle();
  assert(f.memory.view(f.scope).entries.some(entry => entry.key === 'empty-pressure')); assert(f.memory.view(f.scope).retryAt > f.now());
});

test('new defaults and legacy defaults use 100000 characters while explicit million-character windows survive restart', t => {
  const f = fixture(t), other = new ConversationMemory(f.store); other.onPressure = null;
  assert.equal(new ConversationMemory(new StateStore(path.join(f.root, 'fresh'))).index.windowChars, 100000);
  other.index.windowChars = 32000; delete other.index.windowDefaultVersion; delete other.index.windowCustomized; fs.writeFileSync(other.indexFile, JSON.stringify(other.index));
  assert.equal(new ConversationMemory(f.store).index.windowChars, 100000);
  const custom = new ConversationMemory(f.store); custom.setWindowChars(1000000); assert.equal(new ConversationMemory(f.store).index.windowChars, 1000000);
  custom.setWindowChars(32000); assert.equal(new ConversationMemory(f.store).index.windowChars, 32000);
  const input = { mode: 'default', intervalMode: 'fixed', fixedMessages: 5, minMessages: 5, maxMessages: 20, recordsPath: '', memoryWindowChars: 1000000 };
  assert.equal(validateConversationSettings(input).memoryWindowChars, 1000000);
  for (const value of [999, Infinity, 1000.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => custom.setWindowChars(value), { code: 'INVALID_MEMORY_SETTINGS' });
});
