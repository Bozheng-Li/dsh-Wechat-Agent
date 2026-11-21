import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionTraces } from '../modules/traces/store.mjs';
import { StateStore } from '../backend/storage/state-store.mjs';
import { MomentsService } from '../modules/moments/service.mjs';
import { SearchService } from '../modules/search/service.mjs';
import { imageGenerationTool } from '../modules/tools/image-generation.mjs';
import { generatedChatImageSegment } from '../modules/memory/images/chat-generated.mjs';
import { splitChatReply, replySegments } from '../shared/chat-reply-split.mjs';
import { recoveryAllowed, recoveryPlan, prepareRecovery } from '../modules/recovery/service.mjs';
import { recordVersion } from '../modules/workbench/helpers.mjs';
import { validateSettings, schedulesEnabled, momentsEnabled, ChannelError } from '../shared/contracts.mjs';

const DAY = 86400000;
function traceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sync-traces-'));
  let now = Date.parse('2026-07-01T12:00:00Z');
  const source = { root, data: { storeId: 'trace-sync-owner' } };
  const store = new ExecutionTraces(source, { now: () => now });
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, store, advance(days) { now += days * DAY; } };
}
const traceSpec = key => ({ accountId: 'account', key, type: 'maintenance', title: key });

test('legacy trace history remains until the owner explicitly selects a retention period', async t => {
  const f = traceFixture(t), saved = f.store.task(traceSpec('old-completed'));
  f.store.update(saved, { state: 'completed' });
  await f.store.flush({ strict: true });
  f.advance(120); f.store.prune();
  assert(fs.existsSync(saved.day.file));
  assert.deepEqual(f.store.settingsView(), { settings: { retentionDays: null, cacheDays: 14 }, retentionRevision: 'empty' });
  assert(!fs.existsSync(path.join(f.root, 'config.yaml')), 'retention must not add fields to the shared App YAML');
  f.store.configure({ retentionDays: 30, cacheDays: 14 }, 'empty'); f.store.prune();
  assert(!fs.existsSync(saved.day.file));
});

test('trace retention protects active tasks and foreign or corrupt day indexes', async t => {
  const f = traceFixture(t), complete = f.store.task(traceSpec('completed'));
  f.store.update(complete, { state: 'completed' });
  f.advance(2);
  const active = f.store.task({ ...traceSpec('active'), createdAt: Date.parse('2026-07-03T12:00:00Z') });
  await f.store.flush({ strict: true });
  f.store.configure({ retentionDays: 30, cacheDays: 14 }, 'empty'); f.advance(120);
  const foreignDir = path.join(f.store.root, 'a'.repeat(32), '2026-01-01'); fs.mkdirSync(foreignDir, { recursive: true });
  const foreignFile = path.join(foreignDir, 'index.json');
  fs.writeFileSync(foreignFile, JSON.stringify({ version: 1, ownerStoreId: 'another-store', accountId: 'foreign', day: '2026-01-01', rows: [] }));
  const corruptDir = path.join(f.store.root, 'b'.repeat(32), '2026-01-01'); fs.mkdirSync(corruptDir, { recursive: true });
  const corruptFile = path.join(corruptDir, 'index.json'); fs.writeFileSync(corruptFile, '{broken');
  f.store.prune();
  assert(fs.existsSync(active.day.file), 'active tasks are never pruned');
  assert(!fs.existsSync(complete.day.file));
  assert(fs.existsSync(foreignFile)); assert(fs.existsSync(corruptFile));
});

test('a corrupt trace day is reported without hiding remaining valid traces', async t => {
  const f = traceFixture(t), broken = f.store.task(traceSpec('broken-day'));
  f.store.update(broken, { state: 'completed' });
  f.advance(2);
  const valid = f.store.task({ ...traceSpec('valid-day'), createdAt: Date.parse('2026-07-03T12:00:00Z') });
  f.store.update(valid, { state: 'completed' }); await f.store.flush({ strict: true });
  const brokenDay = broken.day.day;
  await f.store.close(); fs.writeFileSync(broken.day.file, '{broken');
  const reopened = new ExecutionTraces(f.source, { now: () => Date.parse('2026-07-03T13:00:00Z') });
  const result = await reopened.list('account', { from: '2026-07-01', to: '2026-07-03', limit: 20 });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].title, 'valid-day');
  assert.equal(result.errors[0].date, brokenDay); assert.equal(result.errors[0].code, 'TRACE_INDEX_INVALID');
  await reopened.close();
});

test('automation settings retain old master-switch fallback and allow independent choices', () => {
  const legacy = validateSettings({ enabled: false, privatePeers: [], groups: [], prompt: '' });
  assert.equal(schedulesEnabled(legacy), false); assert.equal(momentsEnabled(legacy), false);
  const explicit = validateSettings({ enabled: false, schedules: true, moments: false, privatePeers: [], groups: [], prompt: '' });
  assert.equal(schedulesEnabled(explicit), true); assert.equal(momentsEnabled(explicit), false);
});

test('automatic Moments writes use the Moments switch but retain administrator scope and recheck it before dispatch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-switch-'));
  const store = new StateStore(root), accountId = 'moments-owner', senderId = 'admin', peerId = 'friend';
  store.configure(accountId, { enabled: false, schedules: false, moments: true, privatePeers: [peerId], groups: ['room@chatroom'], prompt: '' });
  const config = store.config.snapshot(store.data); config.remote = { globalAdminIds: [senderId] }; store.config.commit(config);
  store.setConversationSettings(accountId, 'group', 'room@chatroom', { ...store.conversationSettings(accountId, 'group', 'room@chatroom'), remoteEnabled: true });
  const scope = { accountId, chatType: 'group', peerId: 'room@chatroom', senderId }, writes = [];
  const transport = { status: () => ({ online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true }),
    writeMoments: async request => { writes.push(request); return { accountId, action: 'like', postId: request.query.postId, liked: true, delivery: 'server-ack' }; } };
  const channel = { store, transport, closed: false, now: () => Date.now(), momentOwners: new Map([[accountId + ':123', peerId]]) };
  const moments = new MomentsService(channel), query = { action: 'like', postId: '123' };
  t.after(async () => { await channel.authorization?.close?.(); fs.rmSync(root, { recursive: true, force: true }); });
  const result = await moments.writeAutomatic(query, scope, 'auto-round-1', new AbortController().signal);
  assert.equal(result.delivery, 'server-ack'); assert.equal(writes.length, 1);
  store.configure(accountId, { ...store.settings(accountId), moments: false });
  await assert.rejects(moments.writeAutomatic({ action: 'like', postId: '124' }, scope, 'auto-round-2', new AbortController().signal),
    { code: 'REMOTE_NOT_AUTHORIZED' });
  assert.equal(writes.length, 1);
});

test('business splitting uses only explicit markers and keeps code fences and mentions intact', () => {
  assert.deepEqual(splitChatReply('第一句换行\n仍是一泡<SPLIT>第二泡'), ['第一句换行\n仍是一泡', '第二泡']);
  assert.deepEqual(splitChatReply('```txt\n<SPLIT>\n``` 后仍一泡'), ['```txt\n<SPLIT>\n``` 后仍一泡']);
  const sent = replySegments([{ type: 'at', data: { qq: 'peer', name: '友' } },
    { type: 'text', data: { text: '甲' } }, { type: 'text', data: { text: '乙' } }]);
  assert.equal(sent.length, 2); assert.equal(sent[0][0].type, 'at');
  assert.equal(sent[1].some(part => part.type === 'at'), false);
});

test('split recovery offers only bubbles whose protocol receipts are all explicitly not-sent', () => {
  const workbench = {}, original = { state: 'partial', acknowledgedMessageIds: ['acked'], replyPlan: [
    { index: 0, type: 'text', text: '已发送' }, { index: 1, type: 'text', text: '结果未知' },
    { index: 2, type: 'text', text: '可以恢复' }, { index: 3, type: 'image', media: { name: '未发图片.png' } },
  ], deliveryParts: [
    { planIndex: 0, type: 'text', state: 'acknowledged', serverMessageId: 'acked' },
    { planIndex: 1, type: 'text', state: 'unknown' }, { planIndex: 2, type: 'text', state: 'not-sent' },
    { planIndex: 3, type: 'image', state: 'not-sent' },
  ] };
  assert.deepEqual(recoveryPlan(original, ['text', 'image']).map(part => part.index), [2, 3]);
  assert.deepEqual(recoveryPlan(original, ['text']).map(part => part.index), [2]);
  assert.deepEqual(recoveryAllowed(workbench, original, 'retry'), ['text', 'image', 'face']);
  assert.throws(() => recoveryAllowed(workbench, { ...original, unavailableNotice: true }, 'regenerate'), { code: 'RECOVERY_NOT_ALLOWED' });
  assert.throws(() => recoveryAllowed(workbench, { ...original, deliveryParts: original.deliveryParts.filter(part => part.planIndex !== 2 && part.planIndex !== 3) }, 'retry'),
    { code: 'RECOVERY_AMBIGUOUS' });
});

test('recovery prepare persists only the selected definitely-not-sent bubble and revision-binds it', async () => {
  const original = { key: 'original-reply', accountId: 'account', chatType: 'private', peerId: 'peer', senderId: 'peer', question: '原始问题',
    state: 'partial', acknowledgedMessageIds: ['ack-0'], replyPlan: [
      { index: 0, type: 'text', text: '已发部分' }, { index: 1, type: 'text', text: '未发送部分' },
      { index: 2, type: 'image', media: { id: 'image', name: 'photo.png' } },
    ], deliveryParts: [
      { planIndex: 0, type: 'text', state: 'acknowledged', serverMessageId: 'ack-0' },
      { planIndex: 1, type: 'text', state: 'not-sent' }, { planIndex: 2, type: 'image', state: 'unknown' },
    ] };
  const disk = { recovery: [] }, workbench = { now: () => 1000,
    scope: value => ({ accountId: value.accountId, chatType: value.chatType, peerId: value.peerId }),
    record: () => original, recoveryDeleted: () => false, deletedRecovery: () => new Set(), recoveryBusy: () => false,
    recoveryAllowed: (record, mode, confirmed) => recoveryAllowed(workbench, record, mode, confirmed),
    disk: { load: () => disk, save: value => { disk.recovery = value.recovery; } },
    store: { settings: () => ({ prompt: '' }), conversationPersona: () => ({ name: 'fixture', aliases: [], prompt: '' }) },
    channel: { longMemory: { adminNotes: () => '', prompt: () => '' } }, runner: { run: async () => ({ text: '重生成文字' }) } };
  const revision = recordVersion(original);
  const draft = await prepareRecovery(workbench, { ...original, recordKey: original.key, revision, mode: 'text', partIndexes: [1] }, new AbortController().signal);
  assert.equal(draft.text, '未发送部分'); assert.deepEqual(draft.partIndexes, [1]); assert.equal(disk.recovery.length, 1);
  await assert.rejects(prepareRecovery(workbench, { ...original, recordKey: original.key, revision, mode: 'text', partIndexes: [0] }, new AbortController().signal),
    { code: 'RECOVERY_CHANGED' });
  const regenerated = await prepareRecovery(workbench, { ...original, recordKey: original.key, revision, mode: 'regenerate', partIndexes: [1] }, new AbortController().signal);
  assert.equal(regenerated.text, '重生成文字'); assert.deepEqual(regenerated.partIndexes, [1]);
});

test('chat image generation works with an empty or disabled library but only attempts the provider once', async () => {
  const bytes = Buffer.from('synthetic-image-bytes'), digest = createHash('sha256').update(bytes).digest('hex'),
    asset = { id: digest, contentSha256: digest, name: 'AI-test.png', kind: 'image', mediaType: 'image/png' };
  let calls = 0, imports = 0, selected;
  const library = { import(accountId, input) { imports++; assert.equal(accountId, 'account'); assert.equal(input.kind, 'image'); return { assetIds: [asset.id] }; },
    resolveAsset(_accountId, id, options) { assert.equal(id, asset.id); assert.deepEqual(options, { enabledOnly: false }); return asset; } };
  const api = { status: () => ({ enabled: true, credentialConfigured: true }), async generate() { calls++; return { bytes, mediaType: 'image/png', providerName: 'synthetic', model: 'fixture' }; } };
  const tool = imageGenerationTool({ imageGeneration: api, library, scope: { accountId: 'account', chatType: 'private', peerId: 'peer' }, select: async value => { selected = value; } });
  const execute = () => tool.execute({ prompt: 'draw one image' }, { signal: new AbortController().signal }).then(JSON.parse);
  assert.equal((await execute()).ok, true); assert.equal(calls, 1); assert.equal(imports, 1);
  assert.equal(selected.generated.prompt, 'draw one image');
  assert.equal((await execute()).code, 'IMAGE_GENERATION_ALREADY_ATTEMPTED'); assert.equal(calls, 1);
  const segment = generatedChatImageSegment({ resolveAsset(_account, _id, options) { assert.deepEqual(options, { enabledOnly: false }); return asset; },
    getContent() { return { data: bytes.toString('base64') }; } }, 'account', { asset, generated: { bytes, mediaType: 'image/png', prompt: 'draw' } });
  assert.equal(segment.type, 'image'); assert.equal(Buffer.from(segment.data.base64, 'base64').toString(), bytes.toString());
});

test('chat image generation preserves the first provider failure and does not bill a second attempt', async () => {
  let calls = 0;
  const tool = imageGenerationTool({ imageGeneration: { status: () => ({ enabled: true, credentialConfigured: true }),
    async generate() { calls++; throw new ChannelError('IMAGE_GENERATION_NETWORK', 'synthetic unavailable'); } },
    library: {}, scope: { accountId: 'account', chatType: 'private', peerId: 'peer' }, select() {} });
  const execute = () => tool.execute({ prompt: 'draw' }, { signal: new AbortController().signal }).then(JSON.parse);
  assert.equal((await execute()).code, 'IMAGE_GENERATION_NETWORK');
  assert.equal((await execute()).code, 'IMAGE_GENERATION_ALREADY_ATTEMPTED'); assert.equal(calls, 1);
});

test('App DeepSeek aliases use the native provider with frozen custom endpoint and model', async () => {
  const captured = [], ctx = { credentials: { resolve: async ref => { assert.equal(ref, 'WECHAT_AGENT_DEEPSEEK_SEARCH_API_KEY'); return { value: 'synthetic-key' }; } } };
  class Provider {
    constructor(options) { this.options = options(); }
    async search(request) { captured.push({ options: this.options, request }); return { sources: [{ title: 'fixture', url: 'https://example.test', content: 'public result' }] }; }
  }
  const service = new SearchService(ctx, { loadDeepSeek: async () => ({ DeepSeekSearchProvider: Provider,
    DEEPSEEK_DEFAULT_BASE_URL: 'https://default.test/messages', DEEPSEEK_DEFAULT_MODEL: 'default-model',
    DEEPSEEK_DEFAULT_API_VERSION: '2023-06-01', DEEPSEEK_DEFAULT_MAX_TOKENS: 4096 }) });
  const configured = service.forConfig({ searchProvider: 'deepseek', deepseekBaseURL: 'https://custom.test/anthropic/v1', deepseekModel: 'fixture-search' });
  const result = await configured.search({ query: 'public topic', maxResults: 3 }, new AbortController().signal);
  assert.equal(result.provider, 'dsh'); assert.equal(captured[0].options.baseURL, 'https://custom.test/anthropic/v1');
  assert.equal(captured[0].options.model, 'fixture-search'); assert.equal(captured[0].options.apiKey, 'synthetic-key');
});
