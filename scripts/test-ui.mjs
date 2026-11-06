import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rolldown } from 'rolldown';
import { StateStore, WechatChannel, identity, createPluginService, rpcHandler, ChannelError } from '../lib/testing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.argv[2] || process.env.ELECTRON_PATH;
if (!electron || !path.isAbsolute(electron) || !fs.existsSync(electron)) throw new Error('Pass an Electron executable: npm run test:ui -- <absolute path to electron.exe>');
const out = path.join(root, 'storage/logs/ui-preview');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(root, 'storage/tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'storage/tmp/ui-preview-'));
const token = randomBytes(24).toString('hex');
const accountId = 'wxid_ui_fixture';
const store = new StateStore(fixture);
store.ensureWorkspace();
store.configure(accountId, { enabled: true, privatePeers: ['wxid_alice'], groups: ['group_alpha@chatroom', 'group_beta@chatroom'], prompt: '回答清楚、简洁。' });
store.setPersona({ name: '小胖', aliases: ['胖胖'], background: '一起讨论产品与日常生活的 AI 同事。', personality: '友好、坦诚、有好奇心。', style: '自然简洁，不机械复述。' });
const contacts = {
  privatePeers: [
    { id: 'wxid_alice', name: 'Alice·产品同事', nickname: 'Alice', remark: '产品负责人' },
    { id: 'wxid_bob', name: 'Bob·设计同事', nickname: 'Bob', remark: '视觉设计' }
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
const worker = {
  status: () => structuredClone(state),
  async call(endpoint) {
    if (endpoint === 'contacts') return structuredClone(contacts);
    if (endpoint === 'connect') state.online = true;
    if (endpoint === 'disconnect') state.online = false;
    return structuredClone(state);
  },
  async send() { throw new Error('The UI fixture must never send a WeChat message'); }
};
const runner = { selection: () => store.modelChoice() || { provider: 'fixture', model: 'alpha' }, defaultSelection: () => ({ provider: 'fixture', model: 'alpha' }),
  async run() { throw new Error('The UI fixture must never generate a model response'); } };
const channel = new WechatChannel({ store, runner, transport: worker });
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
const ctx = { llm: { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'alpha' }, { id: 'beta' }] } };
const service = createPluginService({ ctx, root: fixture, store, worker, runner, channel, dshSessionPath: path.join(fixture, 'host-sessions') });
const rpc = rpcHandler(service), failures = new Set(), cancelRequests = [];
let lastHistoryRequest = null;
const paths = { workspacePath: path.join(fixture, 'custom-workspace'), recordsPath: path.join(fixture, 'custom-records'), conversationPath: path.join(fixture, 'custom-alpha') };
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
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 131072) throw new Error('Fixture request too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/fixture') {
      if (body.command === 'state') { json(res, service.call('status')); return; }
      if (body.command === 'paths') { json(res, paths); return; }
      if (body.command === 'stats') { json(res, { lastHistoryRequest, cancelRequests }); return; }
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
    if (failures.delete(body.endpoint)) { json(res, { ok: false, error: { code: 'FIXTURE_FAILURE', message: '界面测试：模拟保存失败，原设置保留' } }); return; }
    if (body.endpoint === 'records.list') lastHistoryRequest = body.payload;
    if (body.endpoint === 'cancel') cancelRequests.push(body.payload);
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
  const env = { ...process.env, WECHAT_UI_TEST_ORIGIN: origin }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(root, 'scripts/test-ui-driver.cjs'), 'ui-fixture', out], { cwd: root, windowsHide: true, stdio: 'inherit', env });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  if (exit !== 0) throw new Error(`UI verification failed (${exit}); see storage/logs/ui-preview/report.json`);
  fs.writeFileSync(path.join(out, 'fixture-summary.json'), JSON.stringify({ ok: true, root: fixture, version: '0.2.0-preview.1', actualWeChatMessages: 0, actualModelRequests: 0 }, null, 2));
} finally { await channel.close(); await new Promise(resolve => server.close(resolve)); }
