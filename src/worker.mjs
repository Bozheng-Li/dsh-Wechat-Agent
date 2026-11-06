import fs from 'node:fs';
import path from 'node:path';
import { ProtocolBackend } from './wechat/protocol/backend.ts';
import { QrLoginManager } from './wechat/protocol/login.ts';
import { protectStorage, projectPaths } from './wechat/paths.ts';
import { ChannelError } from './contracts.mjs';

const root = path.resolve(process.argv[2]);
const resources = process.env.NAPCAT_RESOURCE_ROOT;
const dirs = projectPaths(root);
protectStorage(root);
const backend = new ProtocolBackend({ sessionFile: path.join(dirs.private, 'session.json'), cacheDir: path.join(dirs.cache, 'protocol'),
  syncIntervalMs: 3000, heartbeatIntervalMs: 30000, requestTimeoutMs: 10000, reconnectMs: 3000,
  sendIntervalMs: 1200, sendJitterMs: 600, segmentBytes: 1800 });
const login = new QrLoginManager(root, backend, publishStatus);
const sending = new Map();
let closing;
const runtimeReady = process.platform === 'win32' && process.arch === 'x64' &&
  ['runtime/python/python.exe', 'runtime/native_login_worker.py', 'runtime/wechat39-engine/manifest.json'].every(file => fs.existsSync(path.join(resources, file)));
function send(message) { if (process.connected) process.send(message, () => {}); }
function snapshot() {
  const status = backend.status(), diagnostics = status.diagnostics || {};
  return {
    online: status.online, good: status.good, state: diagnostics.state,
    account: diagnostics.account ? { id: diagnostics.account.id, nickname: diagnostics.account.nickname } : null,
    sent: diagnostics.sent, received: diagnostics.received, sendQueue: diagnostics.sendQueue,
    login: login.status(), runtimeReady,
    ...diagnostics.lastError ? { error: '微信连接异常，请检查网络；持续离线时请重新扫码' } : {}
  };
}
function publishStatus() { send({ type: 'status', status: snapshot() }); }
backend.subscribe(event => {
  if (event.type === 'event.message' && event.payload.direction === 'incoming') {
    publishStatus();
    send({ type: 'message', accountId: snapshot().account?.id, message: event.payload });
  } else if (['event.runtime', 'event.meta'].includes(event.type)) publishStatus();
});
async function close() {
  return closing ??= (async () => {
    for (const controller of sending.values()) controller.abort();
    await login.close(); await backend.close();
  })();
}
async function perform(id, op, args) {
  if (closing && op !== 'close') throw new ChannelError('WORKER_STOPPING', '微信组件正在停止');
  switch (op) {
    case 'status': return snapshot();
    case 'connect': await backend.start(); return snapshot();
    case 'disconnect': await login.close(); await backend.disconnect(); return snapshot();
    case 'login.start':
      if (!runtimeReady) throw new ChannelError('RUNTIME_MISSING', '缺少随包登录组件，请安装完整的 Windows x64 插件包');
      await login.start(args?.replace === true); return snapshot();
    case 'login.cancel': await login.cancel(); return snapshot();
    case 'contacts': return {
      privatePeers: (await backend.call('action.get_friend_list', {})).map(c => ({ id: c.id, name: c.remark || c.nickname || c.id, remark: c.remark || '', nickname: c.nickname || '' })),
      groups: (await backend.call('action.get_group_list', {})).map(g => ({ id: g.id, name: g.name || g.id }))
    };
    case 'send': {
      const controller = new AbortController(); sending.set(id, controller);
      try { return await backend.sendMessage(args, controller.signal); }
      finally { sending.delete(id); }
    }
    case 'close': await close(); return null;
    default: throw new ChannelError('UNKNOWN_OPERATION', '不支持的微信操作');
  }
}
process.on('message', async message => {
  if (!message || !Number.isSafeInteger(message.id)) return;
  if (message.type === 'cancel') { sending.get(message.id)?.abort(); return; }
  if (message.type !== 'call') return;
  try { send({ type: 'result', id: message.id, ok: true, value: await perform(message.id, message.op, message.args) }); }
  catch (error) {
    const details = error?.details || {};
    send({ type: 'result', id: message.id, ok: false, error: {
      code: error?.code || 'WECHAT_FAILED',
      message: error instanceof ChannelError || ['ERR_LOGIN_BUSY', 'ERR_SESSION_EXISTS', 'ERR_LOGIN_HANDOFF'].includes(error?.code)
        ? error.message : message.op === 'send' ? '微信发送失败，请检查连接及回执记录' : '微信操作失败，请检查连接状态',
      details: {
        ...['unknown', 'partially-acknowledged'].includes(details.delivery) ? { delivery: details.delivery } : {},
        ...Array.isArray(details.acknowledgedMessageIds) ? { acknowledgedMessageIds: details.acknowledgedMessageIds } : {}
      }
    } });
  }
  publishStatus();
  if (message.op === 'close') process.disconnect();
});
process.once('disconnect', () => { void close().finally(() => process.exit(0)); });
send({ type: 'ready', status: snapshot() });
