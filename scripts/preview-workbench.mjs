import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rolldown } from 'rolldown';
import { StateStore, WechatChannel, TaskScheduler, createPluginService, rpcHandler } from '../lib/testing.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), testMode = process.argv.includes('--test');
const folder = path.join(repo, 'storage/tmp'); fs.mkdirSync(folder, { recursive: true });
const root = fs.mkdtempSync(path.join(folder, 'workbench-preview-')), accountId = 'preview-studio-owner', peerId = 'studio-team@chatroom';
const scope = { accountId, chatType: 'group', peerId }, store = new StateStore(root), key = randomBytes(24).toString('hex');
const out = path.resolve(process.env.WECHAT_WORKBENCH_OUTPUT || path.join(repo, 'storage/logs/workbench-preview')); fs.mkdirSync(out, { recursive: true });
store.configure(accountId, { enabled: true, privatePeers: ['preview-alice'], groups: [peerId, 'studio-design@chatroom'], prompt: '' });
store.setPersona({ name: '小胖', aliases: ['胖胖'], prompt: '可靠、有分寸的产品伙伴，用自然简洁的中文交流。' });
store.rememberConversationNames(accountId, { privatePeers: [{ id: 'preview-alice', name: '阿禾' }], groups: [{ id: peerId, name: '产品协作组' }, { id: 'studio-design@chatroom', name: '设计讨论组' }] });
const now = Date.now(), seed = ['产品试用期确定为 14 天，退款申请在付款后七天内提交。', '我明天下午整理一份产品 FAQ，发给大家核对。', '企业版是否支持独立部署，还需要和技术团队确认。'];
seed.forEach((text, index) => store.remember('preview-message-' + index, now, null, { accountId, message: { id: 'preview-message-' + index, serverMessageId: 'preview-message-' + index, chatType: 'group', peerId, sender: { id: index === 1 ? 'preview-alice' : 'preview-bob', nickname: index === 1 ? '阿禾' : '季川' }, time: Math.floor((now - (3 - index) * 300000) / 1000), message: [{ type: 'text', data: { text } }] } }));
store.add({ ...scope, key: 'preview-failed-text', messageId: 'preview-failed-text', contextKey: 'preview-failed-text', senderId: 'preview-alice', sender: '阿禾', state: 'failed', question: '帮我给同事解释一下试用期和退款规则。', replyDraft: '试用期为 14 天。付款后七天内可以申请退款，提交订单号即可核对。', errorCode: 'WECHAT_OFFLINE', delivery: 'not-sent', reason: '生成完成时连接断开，整条回复尚未发送。', createdAt: now - 120000, updatedAt: now - 120000 });
store.add({ ...scope, key: 'preview-unknown', messageId: 'preview-unknown', contextKey: 'preview-unknown', senderId: 'preview-bob', sender: '季川', state: 'unknown', question: '今天的交付安排是什么？', reply: '今天完成交付清单，明天进行内部评审。', reason: '未收到最终回执，请先在微信核对。', createdAt: now - 240000, updatedAt: now - 240000 });
const simulated = { modelRequests: 0, sends: 0, searchRequests: 0 };
let failNextDelete = '', extraRecovery = 0;
const workerState = { account: { id: accountId, nickname: '工作台预览账号' }, online: true, good: true, runtimeReady: true, state: 'online', imageUploadReady: true, login: { state: 'online' } };
const worker = { status: () => structuredClone(workerState), call: async endpoint => { if (endpoint === 'contacts') return { privatePeers: [], groups: [] }; if (endpoint === 'disconnect') workerState.online = false; if (endpoint === 'connect') workerState.online = true; return structuredClone(workerState); }, send: async () => { simulated.sends++; return { delivery: 'server-ack', serverMessageIds: ['synthetic-ack-' + simulated.sends] }; } };
const runner = { selection: () => ({ provider: 'preview', model: 'fixture' }), defaultSelection: () => ({ provider: 'preview', model: 'fixture' }),
  search: { status: () => ({ credentials: { tavily: false, dsh: false }, credentialStore: false }), forConfig: () => ({ search: async () => { simulated.searchRequests++; return { sources: [{ url: 'https://example.org', title: '合成测试来源' }] }; } }) },
  async run(request) {
    request.signal?.throwIfAborted(); simulated.modelRequests++;
    if (request.text === '请只输出 OK') return { text: 'OK' };
    if (request.mode === 'long-memory') return { text: '{"facts":[]}' };
    if (request.text.includes('"messages":')) {
      const input = JSON.parse(request.text.slice(0, request.text.lastIndexOf('\n输出'))), refs = input.messages;
      return { text: JSON.stringify({ title: '试用政策与本周交付', conclusions: refs[0] ? [{ text: refs[0].text, sources: [refs[0].id] }] : [], questions: refs[2] ? [{ text: refs[2].text, sources: [refs[2].id] }] : [], todos: refs[1] ? [{ text: '整理产品 FAQ，提交给团队核对。', owner: refs[1].sender, sources: [refs[1].id] }] : [] }) };
    }
    return { text: '试用期为 14 天，退款请在付款后七天内申请。可以回看当前会话中的约定。' };
  } };
const channel = new WechatChannel({ store, runner, transport: worker }); channel.maintainMemory = () => {};
const scheduler = new TaskScheduler({ store, channel }); channel.scheduler = scheduler;
const memory = channel.longMemory;
memory.capture(scope, [{ key: 'budget-old', text: '本次采购预算为 800 元。', direction: 'incoming', senderId: 'preview-alice', senderName: '阿禾', time: now }]);
await memory.extract(scope, { run: async () => ({ text: '{"facts":[{"text":"阿禾的采购预算为 800 元。","sources":["s1"],"evidence":[{"source":"s1","quote":"本次采购预算为 800 元。"}],"replaces":[]}]}' }) }, new AbortController().signal);
const old = memory.view(accountId).sections[0].facts[0];
memory.capture(scope, [{ key: 'budget-new', text: '预算调整到 980 元了。', direction: 'incoming', senderId: 'preview-alice', senderName: '阿禾', time: now }]);
await memory.extract(scope, { run: async () => ({ text: JSON.stringify({ facts: [{ text: '阿禾的采购预算为 980 元。', sources: ['s1'], evidence: [{ source: 's1', quote: '预算调整到 980 元了。' }], replaces: [old.id] }] }) }) }, new AbortController().signal);
memory.capture(scope, [{ key: 'stable-fact', text: '平时我喜欢喝茶。', direction: 'incoming', senderId: 'preview-alice', senderName: '阿禾', time: now }]);
await memory.extract(scope, { run: async () => ({ text: '{"facts":[{"text":"阿禾喜欢喝茶。","sources":["s1"],"evidence":[{"source":"s1","quote":"平时我喜欢喝茶。"}],"replaces":[]}]}' }) }, new AbortController().signal);
const service = createPluginService({ store, channel, scheduler, worker, runner, root, ctx: {} }), rpc = rpcHandler(service);
const build = await rolldown({ input: path.join(repo, 'tests/fixtures/ui-entry.jsx'), platform: 'browser', transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') } } });
const script = (await build.generate({ format: 'iife' })).output.find(value => value.type === 'chunk').code; await build.close();
const html = `<!doctype html><html lang="zh-CN" data-theme="light" class="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信 Agent · 本地审阅</title><style>html,body{height:100%;margin:0;background:#f5f6f8;color:#252933;--background-primary:#fff;color-scheme:light}html[data-theme=dark]{background:#141519;color:#e8eaf0;--background-primary:#1e2025;color-scheme:dark}#preview-label{height:30px;box-sizing:border-box;padding:6px 12px;text-align:center;font:11px system-ui;border-bottom:1px solid #8883;letter-spacing:.05em}#root{height:calc(100% - 30px)}</style><div id="preview-label">本地审阅 / 合成会话 / 不连接真实微信与模型</div><div id="root"></div><script>window.__UI_FIXTURE_KEY__=${JSON.stringify(key)}</script><script src="/fixture.js"></script></html>`;
const json = (res, value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
  if (req.method === 'GET' && req.url === '/fixture.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(script); return; }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST' || req.headers['x-fixture-key'] !== key) return json(res, { error: 'Forbidden' }, 403);
  const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return json(res, { error: 'Too large' }, 413); chunks.push(chunk); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/fixture') {
      if (body.command === 'summary') return json(res, { simulated, workbench: channel.workbench.listDigests(accountId), records: channel.workbench.recoveryList(accountId), memory: memory.view(accountId), archives: [...store.views.values()].filter(view => view.accountId === accountId).flatMap(view => view.records) });
      if (testMode && body.command === 'fail-next-delete' && ['recovery.delete', 'memory.fact.delete'].includes(body.payload?.endpoint)) { failNextDelete = body.payload.endpoint; return json(res, { ready: true }); }
      if (testMode && body.command === 'add-recovery') { const recordKey = 'preview-extra-recovery-' + ++extraRecovery; store.add({ ...scope, key: recordKey, messageId: recordKey, contextKey: recordKey, senderId: 'preview-alice', sender: '阿禾', state: 'failed', question: '新增的合成待处理消息', replyDraft: '新增合成回复', createdAt: Date.now(), updatedAt: Date.now() }); return json(res, { added: true }); }
      if (testMode && body.command === 'seed-blocked-natural') {
        const before = store.conversationSettings(accountId, 'group', peerId), config = store.setConversationSettings(accountId, 'group', peerId, { ...before, mode: 'natural', natural: { ...before.natural, intervalMode: 'fixed', fixedMinutes: 5, activeHours: false } });
        const natural = channel.natural.state(scope, config); natural.deliveryBlockedKey = 'preview-unknown'; natural.lastReason = 'delivery'; channel.natural.save(scope, natural);
        return json(res, { ready: true });
      }
      if (testMode && body.command === 'cancel-first-reminder') { const task = scheduler.data.tasks.find(task => task.source === 'owner'); if (!task) throw Error('Missing fixture reminder'); scheduler.cancel(task.id, { accountId }, true); return json(res, { cancelled: true }); }
      return json(res, { error: 'Unknown fixture command' }, 400);
    }
    const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    if (testMode && body.endpoint === failNextDelete) { failNextDelete = ''; return json(res, { ok: false, error: { code: 'STATE_WRITE_FAILED', message: '合成测试：删除保存失败，原记录保留。' } }); }
    json(res, await rpc(body.endpoint, body.payload, controller.signal, { principal: { kind: 'owner' } }));
  } catch { json(res, { error: 'Preview request failed' }, 400); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(path.join(out, testMode ? 'test-server.json' : 'server.json'), JSON.stringify({ pid: process.pid, origin, root, startedAt: new Date().toISOString(), mode: 'isolated-synthetic-preview', actualMessages: 0 }, null, 2));
console.log(JSON.stringify({ preview: origin, mode: 'isolated-synthetic-preview', actualMessages: 0 }));
if (testMode) {
  try {
    const electron = process.argv[process.argv.indexOf('--test') + 1]; if (!electron || !path.isAbsolute(electron)) throw Error('Supply Electron path after --test');
    const env = { ...process.env, WECHAT_UI_TEST_ORIGIN: origin }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [path.join(repo, 'scripts/test-workbench-ui.cjs'), 'ui-fixture', out], { windowsHide: true, stdio: 'inherit', env });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); if (code !== 0) process.exitCode = 1;
  } finally { await scheduler.close(); await channel.close(); channel.library.close(); await new Promise(resolve => server.close(resolve)); }
} else {
  const close = async () => { await scheduler.close(); await channel.close(); channel.library.close(); server.close(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
