import fs from "node:fs";
import path from "node:path";
import { ProtocolBackend } from "./protocol/backend.ts";
import { QrLoginManager } from "./protocol/login.ts";
import { protectStorage, projectPaths } from "./paths.ts";
import { ChannelError } from "../../shared/contracts.mjs";
import { loadObservedMedia } from "./protocol/media-loader.mjs";
import { publicSendErrorMessage } from './send-errors.mjs';
import { publicMomentPublication } from '../../shared/moments-publication.mjs';

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
function publicDeliveryParts(value) {
  if (!Array.isArray(value) || value.length > 256 || !value.every((part, index) => part?.index === index && ['text', 'image', 'face', 'file'].includes(part.type) &&
    ['acknowledged', 'unknown', 'not-sent'].includes(part.state) && (part.state !== 'acknowledged' || typeof part.serverMessageId === 'string' && part.serverMessageId && part.serverMessageId !== '0'))) return null;
  return value.map(part => ({ index: part.index, type: part.type, state: part.state, ...(part.state === 'acknowledged' ? { serverMessageId: part.serverMessageId } : {}),
    ...(part.nativeFallback === true ? { nativeFallback: true } : {}),
    ...(typeof part.name === 'string' && part.name.length <= 240 && !/[\\/:\u0000-\u001f\u007f]/.test(part.name) && Number.isSafeInteger(part.bytes) && part.bytes > 0 && /^[a-f0-9]{64}$/.test(part.sha256) ? { name: part.name, bytes: part.bytes, sha256: part.sha256 } : {}) }));
}
function snapshot() {
  const status = backend.status(), diagnostics = status.diagnostics || {};
  return {
    online: status.online, good: status.good, state: diagnostics.state,
    account: diagnostics.account ? { id: diagnostics.account.id, nickname: diagnostics.account.nickname } : null,
    sent: diagnostics.sent, received: diagnostics.received, sendQueue: diagnostics.sendQueue,
    login: login.status(), runtimeReady, imageUploadReady: runtimeReady && !!(backend.session.value?.image_base_request ?? backend.session.value?.heartbeat_base_request),
    momentsReadReady: status.online && !!backend.session.value?.image_base_request,
    momentsImagesReady: status.online && !!backend.session.value?.image_base_request,
    momentsWriteReady: status.online && !!backend.session.value?.image_base_request,
    momentsAudienceReady: status.online && !!backend.session.value?.image_base_request,
    nativeStickersReady: status.online && !!(backend.session.value?.image_base_request ?? backend.session.value?.heartbeat_base_request),
    ...diagnostics.lastError ? { error: '微信连接异常，请检查网络；持续离线时请重新扫码' } : {}
  };
}
function publishStatus() { send({ type: 'status', status: snapshot() }); }
backend.subscribe(event => {
  if (event.type === 'event.message' && (event.payload.direction === 'incoming' || event.payload.direction === 'outgoing' && event.payload.source === 'longlink:NewSync')) {
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
    case 'members': {
      const account = backend.session.value;
      if (!account || args?.accountId !== account.wxid) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，未读取其他账号的群成员');
      const accountUin = account.uin;
      if (typeof args?.peerId !== 'string' || args.peerId.length > 256 || !/^[\w.:-]+@chatroom$/.test(args.peerId)) throw new ChannelError('INVALID_GROUP', '请选择需要读取成员的群聊');
      const members = await backend.call('action.get_group_member_list', { groupId: args.peerId });
      if (backend.session.value?.wxid !== args.accountId || backend.session.value?.uin !== accountUin)
        throw new ChannelError('ACCOUNT_CHANGED', '读取成员期间微信账号已变化，未返回其他账号的群成员');
      return { accountId: args.accountId, peerId: args.peerId, scope: 'protocol-observed-only', members: members.filter(member => member.groupId === args.peerId).map(member => ({
        id: member.id, name: member.card || member.nickname || member.remark || member.id, groupId: args.peerId,
        card: member.card || '', nickname: member.nickname || '', remark: member.remark || '', alias: member.alias || ''
      })) };
    }
    case 'send': {
      const account = backend.session.value;
      if (!account || args?.accountId !== account.wxid) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化或发送账号不匹配，消息尚未发送', { delivery: 'rejected' });
      const { accountId: _accountId, ...params } = args;
      const controller = new AbortController(); sending.set(id, controller);
      try { return await backend.sendMessage(params, controller.signal); }
      finally { sending.delete(id); }
    }
    case 'moments.write': {
      const account = backend.session.value;
      if (!account || args?.accountId !== account.wxid) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，未操作其他账号的朋友圈');
      if (typeof args.clientId !== 'string' || !/^sns_[a-f0-9]{64}$/.test(args.clientId)) throw new ChannelError('ERR_INVALID_MOMENTS_WRITE', '朋友圈操作缺少稳定请求编号');
      // 发布可以不带授权名单：账号选择“自定义屏蔽名单”时不自动屏蔽未授权好友。
      const authorized = args.authorizedUserIds;
      if ((args.query?.action !== 'publish' || authorized !== undefined) &&
          (!Array.isArray(authorized) || authorized.length > 50000 ||
           authorized.some(value => typeof value !== 'string' || !/^[\w.:-]{1,200}$/.test(value)) ||
           new Set(authorized).size !== authorized.length))
        throw new ChannelError('OBJECT_NOT_AUTHORIZED', '朋友圈操作缺少当前账号的有效授权对象，未执行');
      const controller = new AbortController(); sending.set(id, controller);
      try { return await backend.writeMoments(args.query, args.clientId, controller.signal, authorized); }
      finally { sending.delete(id); }
    }
    case 'moments.audience': {
      const account = backend.session.value;
      if (!account || args?.accountId !== account.wxid) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，未读取其他账号的标签和联系人');
      const controller = new AbortController(); sending.set(id, controller);
      try { return await backend.readMomentsAudience(controller.signal); }
      finally { sending.delete(id); }
    }
    case 'moments.publication':
    case 'moments.images':
    case 'moments.read': {
      const account = backend.session.value;
      if (!account || args?.accountId !== account.wxid) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，未读取其他账号的朋友圈');
      if (typeof args.scopeKey !== 'string' || !args.scopeKey || args.scopeKey.length > 1000)
        throw new ChannelError('ERR_INVALID_MOMENTS_QUERY', '朋友圈读取缺少实际发起人范围');
      const controller = new AbortController(); sending.set(id, controller);
      try {
        const result = await (op === 'moments.publication' ? backend.readMomentsPublication(args.query, args.scopeKey, controller.signal)
          : op === 'moments.images' ? backend.readMomentsImages(args.query, args.scopeKey, controller.signal) : backend.readMoments(args.query, args.scopeKey, controller.signal));
        if (backend.session.value !== account && (!backend.session.value || ['uin', 'wxid', 'token', 'body_key', 's08'].some(key => backend.session.value[key] !== account[key])))
          throw new ChannelError('ACCOUNT_CHANGED', '读取期间微信账号已变化，未返回旧账号朋友圈');
        return result;
      } finally { sending.delete(id); }
    }
    case 'stickers.list':
    case 'stickers.content':
    case 'stickers.favorite':
    case 'stickers.recent': {
      const account = backend.session.value;
      if (!account || args?.accountId !== account.wxid) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，未读取其他账号的表情');
      const controller = new AbortController(); sending.set(id, controller);
      try {
        return await (op === 'stickers.list' ? backend.readStickers(controller.signal) : op === 'stickers.favorite' ? backend.favoriteSticker(args.md5, controller.signal) : op === 'stickers.content' ? backend.readStickerContent(args.md5, controller.signal) : backend.recentStickers(controller.signal));
      } finally { sending.delete(id); }
    }
    case 'media': {
      const account = backend.session.value;
      if (!account || args.accountId !== account.wxid) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，未读取其他账号的图片');
      const controller = new AbortController(); sending.set(id, controller);
      try {
        const image = await loadObservedMedia({ directory: path.join(dirs.cache, 'protocol/media', String(account.uin)), peerId: args.peerId, messageId: args.messageId, resourceId: args.resourceId, signal: controller.signal,
          preferOriginal: args.preferOriginal === true,
          preserveStickerOriginal: args.preserveStickerOriginal === true,
          downloadOriginal: ({ signal, ...input }) => backend.downloadImage(input, signal) });
        const current = backend.session.value;
        if (!current || ['uin', 'wxid', 'token', 'body_key', 's08'].some(key => current[key] !== account[key]))
          throw new ChannelError('ACCOUNT_CHANGED', '读取图片期间微信账号已变化，未返回旧账号图片');
        return image;
      }
      finally { sending.delete(id); }
    }
    case 'files': {
      throw new ChannelError('FILE_FEATURE_DISABLED', '微信附件读取功能已停用');
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
    const publication = message.op === 'moments.write' ? publicMomentPublication(details.publication) : null;
    const parts = publicDeliveryParts(details.deliveryParts);
    send({ type: 'result', id: message.id, ok: false, error: {
      code: error?.code || 'WECHAT_FAILED',
      message: error instanceof ChannelError || /^ERR_STICKER_/.test(error?.code ?? '') || message.op === 'files' && /^ERR_FILE_/.test(error?.code ?? '') || ['ERR_LOGIN_BUSY', 'ERR_SESSION_EXISTS', 'ERR_LOGIN_HANDOFF', 'ERR_IMAGE_FORMAT', 'ERR_IMAGE_CREDENTIAL', 'ERR_FILE_CREDENTIAL', 'ERR_FILE_REJECTED', 'ERR_FILE_NETWORK', 'ERR_FILE_PROTOCOL', 'ERR_UNSUPPORTED_IMAGE', 'ERR_MENTION_TARGET', 'ERR_MENTION_LIMIT',
        'ERR_INVALID_MOMENTS_QUERY', 'ERR_MOMENTS_OFFLINE', 'ERR_MOMENTS_CREDENTIAL', 'ERR_MOMENTS_NETWORK', 'ERR_MOMENTS_REJECTED', 'ERR_MOMENTS_PROTOCOL', 'ERR_MOMENTS_CURSOR', 'ERR_MOMENTS_ACCOUNT_CHANGED',
        'ERR_INVALID_MOMENTS_WRITE', 'ERR_MOMENTS_WRITE_REJECTED', 'ERR_MOMENTS_WRITE_PROTOCOL', 'ERR_MOMENTS_TARGET_UNAVAILABLE', 'ERR_MOMENTS_AUDIENCE'].includes(error?.code)
        ? error.message : message.op === 'send' ? publicSendErrorMessage(error) ?? '微信发送失败，请检查连接及回执记录' : '微信操作失败，请检查连接状态',
      details: {
          ...(message.op === 'moments.write' && ['unknown', 'not-sent', 'rejected'].includes(details.delivery) ? { snsDelivery: details.delivery } : {}),
        ...(['send', 'moments.read', 'moments.images', 'moments.publication', 'moments.write'].includes(message.op) && Number.isSafeInteger(details.ret) && details.ret >= -0x80000000 && details.ret <= 0x7fffffff ? { ret: details.ret } : {}),
        ...(publication ? { publication } : {}),
        ...['unknown', 'partially-acknowledged', 'rejected', 'not-sent'].includes(details.delivery) ? { delivery: details.delivery } : {},
        ...Array.isArray(details.acknowledgedMessageIds) ? { acknowledgedMessageIds: details.acknowledgedMessageIds } : {},
        ...(parts ? { deliveryParts: parts } : {})
      }
    } });
  }
  publishStatus();
  if (message.op === 'close') process.disconnect();
});
process.once('disconnect', () => { void close().finally(() => process.exit(0)); });
send({ type: 'ready', status: snapshot() });
