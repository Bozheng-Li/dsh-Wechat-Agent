import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, ConversationMemory, LongTermMemory, ImageMemory, DEFAULT_MEMORY_RETENTION_MS } from '../lib/testing.js';

const month = 30 * 86400000, signal = () => new AbortController().signal;
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-retention-'));
  const store = new StateStore(root), scope = { accountId: 'retention-owner', chatType: 'group', peerId: 'retention@chatroom' };
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  let at = Date.parse('2026-11-07T04:00:00Z'); const now = () => at;
  const local = new ConversationMemory(store, { now }), long = new LongTermMemory(store, { now }); store.memory = local;
  t.after(() => { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('wechat-retention-')); fs.rmSync(resolved, { recursive: true, force: true }); });
  const add = (key, text) => local.append(scope, { key, text, direction: 'incoming', senderId: 'synthetic', time: at - 90 * 86400000 });
  const notes = value => { const doc = long.view(scope.accountId); return long.edit(scope.accountId, doc.markdown.slice(0, doc.globalRange.start) + '\n' + value + '\n' + doc.markdown.slice(doc.globalRange.end), doc.revision); };
  const facts = async text => { long.capture(scope, [{ key: 'fact-' + at, text, direction: 'incoming', senderId: 'synthetic', time: at }]); await long.extract(scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text, sources: ['s1'], replaces: [] }] }) }) }, signal()); };
  return { root, store, scope, local, long, now, add, notes, facts, tick: ms => { at += ms; } };
}

test('conversation entries expire exactly 30 days after first saving and seen keys prevent reintroduction', t => {
  const f = fixture(t); assert.equal(DEFAULT_MEMORY_RETENTION_MS, month);
  f.add('same', '旧来源时间不影响新保存的期限。'); f.tick(month - 1); assert.equal(f.local.view(f.scope).entries.length, 1);
  f.tick(1); assert.equal(f.local.view(f.scope).entries.length, 0);
  f.add('same', '过期后不得重新补回。'); assert.equal(f.local.view(f.scope).entries.length, 0);
  f.add('new', '新的来源可以保存。'); assert.equal(f.local.view(f.scope).entries.length, 1);
});

test('compaction preserves the earliest source expiry rather than renewing the summary', async t => {
  const f = fixture(t); f.local.setWindowChars(1000); f.add('old', '重要旧事项。'.repeat(250));
  f.tick(20 * 86400000); f.add('new', '重要新事项。'.repeat(250));
  await f.local.compact(f.scope, { summarize: async () => '旧事项与新事项。' }, signal());
  const doc = f.local.view(f.scope); assert.equal(doc.summaryExpiresAt, f.now() + 10 * 86400000);
  f.tick(10 * 86400000); assert.equal(f.local.view(f.scope).summary, '');
});

test('legacy conversation windows get a full month once, preserving original timestamps and archives', t => {
  const f = fixture(t); f.add('old', '旧资料'); const doc = f.local.load(f.scope), originalTime = doc.entries[0].time;
  delete doc.retentionVersion; delete doc.entries[0].rememberedAt; doc.summary = '旧摘要'; delete doc.summaryExpiresAt;
  fs.writeFileSync(f.local.file(doc), JSON.stringify(doc)); f.tick(50 * 86400000);
  const migrated = f.local.view(f.scope); assert.equal(migrated.entries[0].time, originalTime); assert.equal(migrated.summaryExpiresAt, f.now() + month);
  f.tick(month); const expired = f.local.view(f.scope); assert.equal(expired.entries.length, 0); assert.equal(expired.summary, '');
  const history = path.join(path.dirname(expired.path), 'archive'); assert(fs.readdirSync(history).some(name => name.endsWith('before-expiry.json')));
});

test('shared notes and automatic facts expire independently; fact extraction and reads do not renew owner notes', async t => {
  const f = fixture(t); f.notes('角色共同约定'); const expiry = f.long.view(f.scope.accountId).globalNotesExpiresAt;
  f.tick(20 * 86400000); await f.facts('新的稳定偏好');
  assert.equal(f.long.view(f.scope.accountId).globalNotesExpiresAt, expiry);
  f.tick(10 * 86400000); assert.equal(f.long.adminNotes(f.scope), ''); assert(f.long.prompt(f.scope).includes('新的稳定偏好'));
  assert(f.long.view(f.scope.accountId).markdown.includes('角色共同约定'));
  f.tick(20 * 86400000); assert.equal(f.long.view(f.scope.accountId).factCount, 0);
  f.notes('修改后的共同约定'); assert.equal(f.long.adminNotes(f.scope), '修改后的共同约定');
});

test('a manually permanent fact stays available beyond a month and does not make other facts permanent', async t => {
  const f = fixture(t); await f.facts('管理员保留的事实'); const doc = f.long.view(f.scope.accountId);
  f.long.updateFact(f.scope.accountId, { factId: doc.sections[0].facts[0].id, revision: doc.revision, expiresAt: null });
  f.tick(month + 1); const restored = new LongTermMemory(f.store, { now: f.now });
  assert.equal(restored.view(f.scope.accountId).factCount, 1); assert(restored.prompt(f.scope).includes('管理员保留的事实'));
});

test('pending source batches expire without a model request or resurrection; delayed extraction cannot renew a source', async t => {
  const f = fixture(t), source = { key: 'pending-before-expiry', text: '重要偏好', direction: 'incoming', senderId: 'synthetic', time: f.now() };
  f.long.capture(f.scope, [source]); f.tick(month); let models = 0;
  assert.equal(f.long.view(f.scope.accountId).pendingCount, 0);
  await f.long.extract(f.scope, { run: async () => { models++; return { text: '{"facts":[]}' }; } }, signal());
  assert.equal(models, 0); assert.equal(f.long.capture(f.scope, [source]).pendingCount, 0);
  f.long.capture(f.scope, [{ ...source, key: 'delayed-extraction' }]); f.tick(20 * 86400000);
  await f.long.extract(f.scope, { run: async () => ({ text: '{"facts":[{"text":"重要偏好","sources":["s1"],"replaces":[]}]}' }) }, signal());
  assert.equal(f.long.view(f.scope.accountId).sections[0].facts[0].expiresAt, f.now() + 10 * 86400000);
});

test('pictures default to 30 days, while an explicit permanent setting survives restart', async t => {
  const f = fixture(t), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 'base64');
  const images = new ImageMemory(f.store, { now: f.now, thumbnailMaker: async () => png });
  assert.equal(images.list(f.scope).settings.retentionDays, 30);
  const source = { key: 'pixels', messageId: 'pixels', senderId: 'synthetic', time: f.now(), attachments: [{ type: 'image', resourceId: 'pixels' }] };
  const saved = await images.capture(f.scope, source, source.attachments[0], { data: png.toString('base64'), mediaType: 'image/png', quality: 'original' }, signal());
  assert.equal(saved.expiresAt, f.now() + month);
  images.configure(f.scope, { enabled: true, retentionDays: null }); f.tick(month + 1);
  const restored = new ImageMemory(f.store, { now: f.now }); assert.equal(restored.list(f.scope).storedCount, 1); assert.equal(restored.list(f.scope).settings.retentionDays, null);
});

test('legacy facts without an expiry get a full month from migration without rewriting their Markdown', async t => {
  const f = fixture(t); await f.facts('旧版本的稳定偏好'); const doc = f.long.view(f.scope.accountId);
  const markdown = doc.markdown.replace(/(<!-- wechat-fact:begin )([A-Za-z0-9_-]+)( -->)/u, (all, prefix, encoded, suffix) => {
    const metadata = JSON.parse(Buffer.from(encoded, 'base64url').toString()); delete metadata.expiresAt; delete metadata.expirySource;
    return prefix + Buffer.from(JSON.stringify(metadata)).toString('base64url') + suffix;
  });
  fs.writeFileSync(doc.path, markdown); const statePath = f.long.paths(f.scope.accountId).state;
  const state = JSON.parse(fs.readFileSync(statePath)); delete state.retentionActivatedAt; fs.writeFileSync(statePath, JSON.stringify(state));
  f.tick(90 * 86400000); const restored = new LongTermMemory(f.store, { now: f.now });
  assert.equal(restored.view(f.scope.accountId).sections[0].facts[0].expiresAt, f.now() + month); assert.equal(fs.readFileSync(doc.path, 'utf8'), markdown);
});

test('legacy permanent image defaults migrate once to a fresh month and can then be manually made permanent', async t => {
  const f = fixture(t), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 'base64');
  const images = new ImageMemory(f.store, { now: f.now, thumbnailMaker: async () => png }), source = { key: 'legacy-image', messageId: 'legacy-image', time: f.now(), attachments: [{ type: 'image', resourceId: 'legacy-image' }] };
  const saved = await images.capture(f.scope, source, source.attachments[0], { data: png.toString('base64'), mediaType: 'image/png', quality: 'original' }, signal());
  const state = images.load(f.scope); delete state.retentionVersion; state.settings.retentionDays = null; state.items[saved.id].expiresAt = null; images.save(state);
  f.tick(90 * 86400000); const migrated = new ImageMemory(f.store, { now: f.now });
  assert.equal(migrated.list(f.scope).items[0].expiresAt, f.now() + month); migrated.configure(f.scope, { enabled: true, retentionDays: null });
  f.tick(month + 1); assert.equal(new ImageMemory(f.store, { now: f.now }).list(f.scope).storedCount, 1);
});
