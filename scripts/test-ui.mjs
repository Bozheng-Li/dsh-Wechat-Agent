import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { rolldown } from 'rolldown';
import { StateStore, WechatChannel, TaskScheduler, AgentIdentity, VERSION, identity, createPluginService, rpcHandler, ChannelError, describeWorkspace, migrateWorkspaceRoot, SearchService, REPLY_STYLE_REVIEW_NOTE } from '../lib/testing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.argv[2] || process.env.ELECTRON_PATH;
if (!electron || !path.isAbsolute(electron) || !fs.existsSync(electron)) throw new Error('Pass an Electron executable: npm run test:ui -- <absolute path to electron.exe>');
const out = path.resolve(process.env.WECHAT_UI_TEST_OUTPUT || path.join(root, 'storage/logs', process.env.WECHAT_UI_TEST_NATURAL_ONLY === '1' ? 'natural-chat-preview' : process.env.WECHAT_UI_TEST_VISUALS_ONLY === '1' ? 'visual-refresh-preview' : process.env.WECHAT_UI_TEST_TASKS_ONLY === '1' ? 'tasks-layout-preview' : 'ui-preview'));
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(root, 'storage/tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'storage/tmp/ui-preview-'));
const bootstrap = path.join(fixture, 'initial');
const paths = { bootstrap, basePath: path.join(fixture, 'relocated'), workspacePath: path.join(fixture, 'custom-workspace'), recordsPath: path.join(fixture, 'custom-records'), conversationPath: path.join(fixture, 'custom-alpha') };
const token = randomBytes(24).toString('hex');
const accountId = 'wxid_ui_fixture';
const crc32 = data => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
function fixturePng(rgb, padding = 0) {
  const chunk = (kind, data) => { const name = Buffer.from(kind), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...(padding ? [chunk('tEXt', Buffer.from('ui-fixture\0' + 'A'.repeat(padding)))] : []), chunk('IDAT', deflateSync(Buffer.from([0, ...rgb, ...rgb, 0, ...rgb, ...rgb]))), chunk('IEND', Buffer.alloc(0))]);
}
function fixtureZip(items) {
  const local = [], directory = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), data = item.data, checksum = crc32(data), header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, name, data); directory.push(central, name); offset += header.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
// An ancillary PNG chunk makes the ZIP cross the real 256 KiB upload boundary.
const assetZip = fixtureZip([{ name: '赞同/红色方块.png', data: fixturePng([220, 66, 66], 300 * 1024) }, { name: '冷静/绿色方块.png', data: fixturePng([44, 168, 112]) }]);
let store = new StateStore(bootstrap), activeRoot = bootstrap;
store.ensureWorkspace();
store.setStorageSettings({ workspacePath: paths.workspacePath, recordsPath: paths.recordsPath });
store.configure(accountId, { enabled: true, privatePeers: ['wxid_alice'], groups: ['group_alpha@chatroom', 'group_beta@chatroom'], prompt: '回答清楚、简洁。' });
store.setConversationSettings(accountId, 'group', 'group_alpha@chatroom', { ...store.conversationSettings(accountId, 'group', 'group_alpha@chatroom'), recordsPath: paths.conversationPath });
store.setPersona({ name: '小胖', aliases: ['胖胖'], background: '一起讨论产品与日常生活的 AI 同事。', personality: '友好、坦诚、有好奇心。', style: '自然简洁，不机械复述。' });
const contacts = {
  privatePeers: [
    { id: 'wxid_alice', name: 'Alice·产品同事', nickname: 'Alice', remark: '产品负责人' },
    { id: 'wxid_bob', name: 'Bob·设计同事', nickname: 'Bob', remark: '视觉设计' },
    { id: 'wxid_li_ming', name: '李明', nickname: '李明', remark: '' },
    { id: 'wxid_xiao_li', name: '小李', nickname: '李同学', remark: '小李' }
  ],
  groups: [{ id: 'group_alpha@chatroom', name: '产品讨论组' }, { id: 'group_beta@chatroom', name: '周末出游' }, { id: 'group_gamma@chatroom', name: '设计评审组' }]
};
store.rememberConversationNames(accountId, contacts);
let sequence = 0;
for (const [chatType, peerId, count, label] of [['group', 'group_alpha@chatroom', 63, 'ALPHA'], ['group', 'group_beta@chatroom', 3, 'BETA'], ['private', 'wxid_alice', 3, 'ALICE']]) {
  for (let index = 0; index < count; index++) {
    const id = `ui-fixture-${++sequence}`, key = identity([accountId, chatType, peerId, id]);
    const time = Math.floor(Date.now() / 1000) - (count - index) * 60;
    const question = `${label} · 第 ${index + 1} 条界面验证消息`;
    const message = { id, serverMessageId: id, time, direction: 'incoming', chatType, peerId, sender: { id: 'wxid_alice', nickname: 'Alice' }, message: [{ type: 'text', data: { text: question } }] };
    const record = { key, contextKey: identity([accountId, chatType, peerId, 'wxid_alice']), accountId, chatType, peerId, messageId: id,
      senderId: 'wxid_alice', sender: 'Alice', agentName: '小胖', mode: 'default', state: 'queued', question, createdAt: time * 1000, updatedAt: time * 1000 };
    store.remember(key, Date.now(), record, { accountId, message });
    store.update(record, { state: 'sent', reply: `${label} · 这是一条用于页面验证的合成回复。`, acknowledgedMessageIds: [`fixture-ack-${sequence}`] });
  }
}
let state = { account: { id: accountId, nickname: '小胖·界面测试' }, online: true, state: 'online', runtimeReady: true, login: { state: 'online', running: false } };
const memberRequests = [], migrations = [];
const members = {
  'group_alpha@chatroom': [
    { id: 'wxid_alice', name: 'Alice·产品同事', card: 'Alice·产品同事', nickname: 'Alice', remark: '产品负责人' },
    { id: 'wxid_bob', name: 'Bob·设计同事', card: 'Bob·设计同事', nickname: 'Bob', remark: '视觉设计' },
    { id: 'wxid_li_ming_a', name: '李明', card: '李明', nickname: '明同学', remark: '研发同事' },
    { id: 'wxid_li_ming_b', name: '李明', card: '李明', nickname: '小明', remark: '设计同事' },
  ],
  'group_beta@chatroom': [{ id: 'wxid_weekend', name: '周末小伙伴', card: '周末小伙伴', nickname: '周末同学' }],
  'group_gamma@chatroom': [],
};
const worker = {
  status: () => structuredClone(state),
  async call(endpoint, payload = {}) {
    if (endpoint === 'contacts') return structuredClone(contacts);
    if (endpoint === 'members') {
      if (payload.accountId !== state.account?.id || !Object.hasOwn(members, payload.peerId)) throw new Error('Unexpected synthetic member scope');
      memberRequests.push(structuredClone(payload));
      return { accountId: payload.accountId, peerId: payload.peerId, scope: 'protocol-observed-only', members: (members[payload.peerId] || []).map(member => ({ ...member, groupId: payload.peerId })) };
    }
    if (endpoint === 'connect') state.online = true;
    if (endpoint === 'disconnect') state.online = false;
    return structuredClone(state);
  },
  async send() { throw new Error('The UI fixture must never send a WeChat message'); }
};
const assetAnalysisRequests = [];
let memoryImageReadsReady = false;
worker.media = async ({ resourceId }) => {
  if (resourceId === 'c'.repeat(64)) return { data: fixturePng([200, 200, 200]).toString('base64'), mediaType: 'image/png', quality: 'thumbnail', fixtureMemoryImage: true };
  if (!memoryImageReadsReady) throw new ChannelError('IMAGE_URL_INVALID', '图片资源地址不是可读取的微信媒体地址');
  return { data: fixturePng([200, 30, 30]).toString('base64'), mediaType: 'image/png', quality: 'original', fixtureMemoryImage: true };
};
const runner = { selection: () => store.modelChoice() || { provider: 'fixture', model: 'alpha' }, defaultSelection: () => ({ provider: 'fixture', model: 'alpha' }),
  async describeImage(_image, signal) { signal.throwIfAborted(); return '合成测试图片的笔记。'; },
  async describeImages(images, signal) { signal.throwIfAborted(); if (!images.every(image => image.fixtureMemoryImage)) assetAnalysisRequests.push(images.length); return images.map(() => '合成方块，用于表达赞同或让讨论冷静下来。'); },
  async run() { throw new Error('The UI fixture must never generate a model response'); } };
let channel = new WechatChannel({ store, runner, transport: worker });
// This fixture checks owner UI/RPC and durable files. Automatic extraction must not
// drain its deliberately queued cancellation samples or call a real model.
channel.maintainMemory = () => {};
let scheduler = new TaskScheduler({ store, channel }); channel.scheduler = scheduler;
let agentIdentity = new AgentIdentity(activeRoot);
const preservedFiles = Object.fromEntries(Object.entries(describeWorkspace(activeRoot, store)).filter(([key]) => ['workspacePath', 'recordsPath', 'memoryPath', 'assetsPath', 'tasksPath', 'loginPath', 'cachePath'].includes(key)).map(([key, directory]) => {
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'ui-preserved.txt'), content = 'Synthetic data preserved for ' + key;
  fs.writeFileSync(file, content); return [key, { file, content }];
}));
function openFixtureRuntime(nextRoot) {
  const nextStore = new StateStore(nextRoot); nextStore.ensureWorkspace();
  const nextChannel = new WechatChannel({ store: nextStore, runner, transport: worker }); nextChannel.maintainMemory = () => {};
  const nextScheduler = new TaskScheduler({ store: nextStore, channel: nextChannel }); nextChannel.scheduler = nextScheduler;
  return { root: nextRoot, store: nextStore, channel: nextChannel, scheduler: nextScheduler, identity: new AgentIdentity(nextRoot), worker, runner };
}
function installFixtureRuntime(runtime) {
  ({ root: activeRoot, store, channel, scheduler, identity: agentIdentity } = runtime);
  service.replaceRuntime(runtime);
}
async function relocateWorkspace(targetRoot, signal) {
  signal?.throwIfAborted();
  const previous = { root: activeRoot, store, channel, scheduler };
  await previous.scheduler.close(); await previous.channel.close();
  let transfer, next;
  try {
    signal?.throwIfAborted();
    transfer = migrateWorkspaceRoot({ bootstrap, store: previous.store, targetRoot });
    next = openFixtureRuntime(transfer.root); signal?.throwIfAborted();
    transfer.commit(); transfer = undefined;
    installFixtureRuntime(next); migrations.push({ from: previous.root, to: activeRoot });
  } catch (error) {
    await next?.scheduler.close(); await next?.channel.close(); transfer?.rollback();
    installFixtureRuntime(openFixtureRuntime(previous.root)); throw error;
  }
}
function appendFixtureRecord(peerId, queued = false) {
  if (!['group_alpha@chatroom', 'group_beta@chatroom'].includes(peerId)) throw new Error('Unknown synthetic conversation');
  const id = `ui-live-${++sequence}`, chatType = 'group', key = identity([accountId, chatType, peerId, id]);
  const question = `${peerId === 'group_alpha@chatroom' ? 'ALPHA' : 'BETA'} · 新记录 ${sequence}`;
  const message = { id, serverMessageId: id, time: Math.floor(Date.now() / 1000), direction: 'incoming', chatType, peerId,
    sender: { id: 'wxid_alice', nickname: 'Alice' }, message: [{ type: 'text', data: { text: question } }] };
  const config = store.conversationSettings(accountId, chatType, peerId);
  const record = { key, contextKey: identity([accountId, chatType, peerId, 'wxid_alice']), accountId, chatType, peerId, messageId: id,
    senderId: 'wxid_alice', sender: 'Alice', mode: config.mode, state: 'queued', question, createdAt: Date.now(), updatedAt: Date.now() };
  store.remember(key, Date.now(), record, { accountId, message });
  if (queued) channel.queue.push({ record, message, mode: config.mode, config, text: question, prompt: '' });
  else store.update(record, { state: 'sent', reply: '仅用于离线界面验证的合成回复。', acknowledgedMessageIds: [`fixture-ack-${sequence}`] });
  return key;
}
const searchKeys = new Map();
const ctx = { llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'alpha' }, { id: 'beta' }] }, credentials: {
  set: async (ref, value) => { searchKeys.set(ref, value); },
  resolve: async ref => searchKeys.has(ref) ? { value: searchKeys.get(ref) } : undefined,
  describe: async ref => ({ configured: searchKeys.has(ref) }),
} };
runner.search = new SearchService(ctx, { fetchImpl: async () => { throw new Error('UI fixture must not call a real search endpoint'); } });
const service = createPluginService({ ctx, root: activeRoot, store, worker, runner, channel, scheduler, identity: agentIdentity, relocateWorkspace, dshSessionPath: path.join(fixture, 'host-sessions') });
const rpc = rpcHandler(service), failures = new Set(), cancelRequests = [], assetUploadRequests = [], storageRequests = [], identityRequests = [];
const heldRequests = new Map();
let globalMemoryFault = null;
function ownedFixtureFile(file) {
  const absolute = path.resolve(file), relative = path.relative(fixture, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.lstatSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Memory fault must stay in an ordinary owned fixture file');
  return absolute;
}
function repairGlobalMemory() {
  if (!globalMemoryFault) return;
  fs.writeFileSync(ownedFixtureFile(globalMemoryFault.file), globalMemoryFault.bytes);
  globalMemoryFault = null;
}
let lastHistoryRequest = null;
const build = await rolldown({ input: path.join(root, 'tests/fixtures/ui-entry.jsx'), platform: 'browser', transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') } } });
let script;
try { script = (await build.generate({ format: 'iife' })).output.find(item => item.type === 'chunk').code; }
finally { await build.close(); }
const html = `<!doctype html><html lang="zh-CN" data-theme="dark" class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信 Agent · 离线界面验证</title><style>html,body,#root{height:100%;margin:0}html{color-scheme:dark;--background-primary:#1b1d22;color:#e1e4e9;background:#1b1d22}html[data-theme=light]{color-scheme:light;--background-primary:#fbfcfb;color:#26322f;background:#fbfcfb}</style><div id="root"></div><script>window.__UI_FIXTURE_KEY__=${JSON.stringify(token)}</script><script src="/fixture.js"></script></html>`;
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
  if (req.method === 'GET' && req.url === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(script); return; }
  if (req.method !== 'POST' || !['/rpc', '/fixture'].includes(req.url) || req.headers['x-fixture-key'] !== token) { json(res, { message: 'Not found' }, 404); return; }
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 524288) throw new Error('Fixture request too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/fixture') {
      if (body.command === 'state') { json(res, service.call('status')); return; }
      if (body.command === 'flagRecordStyle') {
        const record = store.data.records.find(value => value.key === body.payload?.recordKey && value.accountId === state.account?.id);
        if (!record || record.state !== 'sent') throw new Error('Choose a confirmed synthetic record');
        store.update(record, { replyStyleWarning: REPLY_STYLE_REVIEW_NOTE }); json(res, { key: record.key, reply: record.reply }); return;
      }
      if (body.command === 'searchFailure') { runner.searchStatus = () => ({ ok: false, provider: 'tavily', code: 'WEB_SEARCH_AUTH_FAILED', message: 'Tavily 搜索接口返回 HTTP 401，请检查 Tavily API Key 与访问权限。', checkedAt: new Date().toISOString() }); json(res, { ok: true }); return; }
      if (body.command === 'paths') { json(res, paths); return; }
      if (body.command === 'stats') { json(res, { lastHistoryRequest, cancelRequests, tasks: scheduler.list(accountId).tasks, assetUploadRequests, assetAnalysisRequests, memberRequests, migrations, storageRequests, identityRequests, activeRoot, storeFile: store.file, identityPath: agentIdentity.file, preservedFiles }); return; }
      if (body.command === 'identity') { json(res, agentIdentity.view()); return; }
      if (body.command === 'editIdentityExternally') {
        const markdown = body.payload?.markdown;
        if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 32000 || markdown.includes('\0')) throw new Error('Invalid synthetic identity Markdown');
        fs.writeFileSync(agentIdentity.file, markdown, 'utf8'); json(res, agentIdentity.view()); return;
      }
      if (body.command === 'assetZip') { json(res, { name: '界面测试表情.zip', data: assetZip.toString('base64'), bytes: assetZip.length }); return; }
      if (body.command === 'assets') { json(res, channel.library.list(state.account.id)); return; }
      if (body.command === 'globalMemory') { json(res, channel.longMemory.view(state.account.id)); return; }
      if (body.command === 'imageMemory') { json(res, channel.imageMemory.list({ accountId: state.account.id, chatType: body.payload?.chatType || 'group', peerId: body.payload?.peerId || 'group_alpha@chatroom' })); return; }
      if (body.command === 'seedImageMemory') {
        const samples = [];
        for (const [chatType, peerId, label] of [['group', 'group_alpha@chatroom', 'ALPHA_IMAGE_NOTE'], ['group', 'group_beta@chatroom', 'BETA_IMAGE_NOTE'], ['private', 'wxid_alice', 'PRIVATE_IMAGE_NOTE']]) {
          const scope = { accountId, chatType, peerId }, entry = { key: label, messageId: 'message-' + label, direction: 'incoming', senderId: 'wxid_alice', senderName: 'Alice', time: Date.now(), text: label,
            attachments: [{ type: 'image', resourceId: label.toLowerCase().padEnd(64, 'a'), description: label + '：红色方块。' }] };
          channel.memory.append(scope, entry);
          const item = await channel.imageMemory.capture(scope, entry, entry.attachments[0], { mediaType: 'image/png', data: fixturePng([220, 20, 20]).toString('base64'), quality: 'original' }, new AbortController().signal);
          samples.push({ scope, id: item.id });
        }
        json(res, samples); return;
      }
      if (body.command === 'seedLongMemorySources') {
        if (channel.longMemory.view(accountId).sections.length) throw new Error('Long-memory source fixture already seeded');
        for (const [chatType, peerId, label] of [['group', 'group_alpha@chatroom', 'ALPHA_SOURCE_FACT'],
          ['group', 'group_beta@chatroom', 'BETA_SOURCE_FACT'], ['private', 'wxid_alice', 'PRIVATE_SOURCE_FACT']]) {
          const scope = { accountId, chatType, peerId };
          channel.longMemory.capture(scope, [{ key: 'ui-long-source-' + label, text: label + '：本会话的合成长事实。', direction: 'incoming',
            senderId: 'wxid_alice', senderName: 'Alice', time: Date.now() }]);
          await channel.longMemory.extract(scope, { run: async () => ({ text: JSON.stringify({
            facts: [{ text: label + '：本会话的合成长事实。', sources: ['s1'], replaces: [] }]
          }) }) }, new AbortController().signal);
        }
        json(res, channel.longMemory.view(accountId)); return;
      }
      if (body.command === 'localMemory') { json(res, await service.call('memory.get', { accountId, chatType: 'group', peerId: body.payload?.peerId || 'group_alpha@chatroom' })); return; }
      if (body.command === 'holdNext') {
        if (body.payload?.endpoint !== 'memory.edit' || heldRequests.has(body.payload.endpoint)) throw new Error('Only one isolated memory save can be held');
        let release; const wait = new Promise(resolve => { release = resolve; });
        heldRequests.set(body.payload.endpoint, { wait, release, started: false, payload: null }); json(res, { ok: true }); return;
      }
      if (body.command === 'heldRequest') {
        const held = heldRequests.get(body.payload?.endpoint); json(res, { started: !!held?.started, payload: held?.payload || null }); return;
      }
      if (body.command === 'releaseRequest') {
        const held = heldRequests.get(body.payload?.endpoint);
        if (!held?.started) throw new Error('No started fixture request to release');
        heldRequests.delete(body.payload.endpoint); held.release(); json(res, { ok: true }); return;
      }
      if (body.command === 'unreadableGlobalMemory') {
        if (globalMemoryFault) throw new Error('Global memory fault already active');
        const file = ownedFixtureFile(channel.longMemory.view(accountId).path);
        globalMemoryFault = { file, bytes: fs.readFileSync(file) };
        fs.writeFileSync(file, Buffer.alloc(8000001, 88));
        json(res, channel.longMemory.view(accountId)); return;
      }
      if (body.command === 'repairGlobalMemory') { repairGlobalMemory(); json(res, channel.longMemory.view(accountId)); return; }
      if (body.command === 'seedImageFailures') {
        const scope = { accountId, chatType: 'group', peerId: 'group_alpha@chatroom' };
        channel.memory.append(scope, { key: 'ui-image-failures', messageId: 'ui-image-failures', text: '[合成图片与表情]', direction: 'incoming', time: Date.now(),
          attachments: [{ type: 'face', resourceId: 'd'.repeat(64), error: '旧表情理解失败，应跳过' }, { type: 'image', resourceId: 'a'.repeat(64), error: '图片资源地址不是可读取的微信媒体地址' },
            { type: 'image', resourceId: 'b'.repeat(64), error: '图片资源地址不是可读取的微信媒体地址' },
            { type: 'image', resourceId: 'c'.repeat(64), description: '仅有缩略图，小字尚未核实。', quality: 'thumbnail' }] });
        json(res, channel.memory.view(scope)); return;
      }
      if (body.command === 'fixImageReads') { memoryImageReadsReady = true; json(res, { ok: true }); return; }
      if (body.command === 'taskHistory') {
        if (scheduler.data.tasks.some(task => task.id === 'ui-history-completed-0')) throw new Error('Task history fixture already seeded');
        const stamp = Date.now(), planned = stamp - 3600000;
        const base = { accountId, chatType: 'group', peerId: 'group_alpha@chatroom', senderId: accountId, senderName: '管理员', source: 'owner', kind: 'message',
          schedule: { kind: 'once', at: planned }, nextRunAt: planned, createdAt: planned - 3600000, updatedAt: stamp, revision: 1, lastError: null };
        const append = (id, patch, runs = []) => { scheduler.data.tasks.push({ ...base, id, ...patch }); scheduler.data.runs.push(...runs.map(run => ({ accountId, taskId: id, scheduledAt: planned, startedAt: planned + 1000, ...run }))); };
        for (let index = 0; index < 24; index++) {
          const id = 'ui-history-completed-' + index, finishedAt = stamp - index * 60000;
          append(id, { content: `已完成的合成提醒 ${index + 1}：按时喝水`, peerId: index % 2 ? 'group_beta@chatroom' : base.peerId, state: 'completed', lastState: 'sent', runId: id + '-run', updatedAt: finishedAt + 15000 },
            [{ id: id + '-run', state: 'sent', finishedAt, acknowledgedMessageIds: ['fixture-history-ack-' + index] }]);
        }
        append('ui-history-daily', { content: '每日合成提醒：汇总今天的行动项', kind: 'agent', schedule: { kind: 'daily', time: '18:00', timeZone: 'Asia/Shanghai' }, nextRunAt: stamp + 86400000, state: 'pending', lastState: 'sent', runId: 'daily-run-0' },
          [0, 1, 2].map(index => ({ id: 'daily-run-' + index, state: 'sent', finishedAt: stamp - index * 86400000 - 5000, acknowledgedMessageIds: ['fixture-daily-ack-' + index] })));
        append('ui-history-pending', { content: '待执行的合成提醒：十分钟后休息一下', state: 'pending', lastState: null, nextRunAt: stamp + 600000 });
        append('ui-history-unknown', { content: '需要核对的合成提醒：结果不明', state: 'paused', lastState: 'unknown', lastError: '没有收到微信确认，请先核对记录，不自动重发。', runId: 'unknown-run' },
          [{ id: 'unknown-run', state: 'unknown', reason: '没有收到微信确认，请先核对记录，不自动重发。', finishedAt: stamp, acknowledgedMessageIds: [] }]);
        append('ui-history-expired', { content: '已过期的合成提醒：无需补发', state: 'expired', lastState: 'expired', lastError: '超过计划时间十分钟，已跳过。' });
        append('ui-history-late-ack', { content: '取消后的合成提醒：保留真实回执', state: 'cancelled', lastState: 'sent', runId: 'late-ack-run', updatedAt: stamp + 1000 },
          [{ id: 'late-ack-run', state: 'sent', finishedAt: stamp + 2000, acknowledgedMessageIds: ['fixture-late-ack'] }]);
        scheduler.save(); json(res, { completedAt: stamp, plannedAt: planned }); return;
      }
      if (body.command === 'appendRecords') {
        const count = body.payload?.count;
        if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw new Error('Invalid fixture count');
        json(res, { keys: Array.from({ length: count }, () => appendFixtureRecord('group_alpha@chatroom')) }); return;
      }
      if (body.command === 'queueTasks') {
        if (channel.queue.length || channel.active) throw new Error('Fixture tasks already queued');
        json(res, { keys: ['group_alpha@chatroom', 'group_beta@chatroom'].map(peerId => appendFixtureRecord(peerId, true)) }); return;
      }
      if (body.command === 'failNext') { failures.add(body.payload.endpoint); json(res, { ok: true }); return; }
      if (body.command === 'switchAccount') {
        state = { ...state, account: { id: 'wxid_ui_other', nickname: '另一账号·界面测试' } };
        store.configure(state.account.id, { enabled: false, privatePeers: [], groups: [], prompt: '' }); json(res, { ok: true }); return;
      }
      throw new Error('Unsupported fixture command');
    }
    if (body.endpoint === 'storage.save') storageRequests.push(structuredClone(body.payload));
    if (body.endpoint === 'identity.save') identityRequests.push(structuredClone(body.payload));
    if (failures.delete(body.endpoint)) { json(res, { ok: false, error: { code: 'FIXTURE_FAILURE', message: '界面测试：模拟保存失败，原设置保留' } }); return; }
    const held = heldRequests.get(body.endpoint);
    if (held && !held.started) { held.started = true; held.payload = structuredClone(body.payload); await held.wait; }
    if (body.endpoint === 'records.list') lastHistoryRequest = body.payload;
    if (body.endpoint === 'cancel') cancelRequests.push(body.payload);
    if (body.endpoint.startsWith('assets.upload.')) assetUploadRequests.push({ endpoint: body.endpoint, accountId: body.payload.accountId, uploadId: body.payload.uploadId, offset: body.payload.offset, bytes: body.payload.data ? Buffer.from(body.payload.data, 'base64').length : undefined });
    // A typo in a browser test must not create files outside its disposable fixture.
    for (const value of Object.values(body.payload?.storage || {})) {
      const relative = path.relative(fixture, path.resolve(String(value)));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ChannelError('FIXTURE_PATH', '界面测试只能使用自己的临时目录');
    }
    const signal = new AbortController(); req.once('aborted', () => signal.abort());
    json(res, await rpc(body.endpoint, body.payload, signal.signal, { principal: { kind: 'owner' } }));
  } catch (error) { json(res, { message: error.message }, 400); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const runId = randomBytes(16).toString('hex');
  const env = { ...process.env, WECHAT_UI_TEST_ORIGIN: origin, WECHAT_UI_TEST_RUN_ID: runId }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(root, 'scripts/test-ui-driver.cjs'), 'ui-fixture', out], { cwd: root, windowsHide: true, stdio: 'inherit', env });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  if (exit !== 0) throw new Error(`UI verification failed (${exit}); see ${path.join(out, 'report.json')}`);
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')); } catch {}
  if (!report?.ok || report.runId !== runId || !report.assertions?.length || !report.screenshots?.length || report.errors?.length)
    throw new Error('UI driver did not produce a successful report for this run; check the Electron executable and report.json');
  fs.writeFileSync(path.join(out, 'fixture-summary.json'), JSON.stringify({ ok: true, root: fixture, version: VERSION, actualWeChatMessages: 0, actualModelRequests: 0 }, null, 2));
} finally {
  for (const held of heldRequests.values()) held.release();
  repairGlobalMemory();
  await scheduler.close(); await channel.close(); await new Promise(resolve => server.close(resolve));
}
