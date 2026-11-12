import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { rolldown } from 'rolldown';
import { uiFixtureModels } from '../tests/fixtures/model-catalog.mjs';
import { stickerGif } from '../tests/fixtures/stickers.mjs';
import { seedExecutionTraceFixture } from '../tests/fixtures/execution-traces.mjs';
import { StateStore, WechatChannel, TaskScheduler, AgentIdentity, VERSION, identity, createPluginService, rpcHandler, ChannelError, describeWorkspace, migrateWorkspaceRoot, SearchService, REPLY_STYLE_REVIEW_NOTE, readWorkArtifact, archiveWorkImages } from '../lib/testing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.argv[2] || process.env.ELECTRON_PATH;
if (!electron || !path.isAbsolute(electron) || !fs.existsSync(electron)) throw new Error('Pass an Electron executable: npm run test:ui -- <absolute path to electron.exe>');
const authorizationFixture = process.env.WECHAT_UI_TEST_AUTHORIZATION_ONLY === '1';
const generatedImagesFixture = process.env.WECHAT_UI_TEST_GENERATED_IMAGES_ONLY === '1';
const stickerFixture = process.env.WECHAT_UI_TEST_STICKERS_ONLY === '1';
const executionTraceFixture = process.env.WECHAT_UI_TEST_TRACES_ONLY === '1';
const automationFixture = process.env.WECHAT_UI_TEST_AUTOMATION_ONLY === '1';
const out = path.resolve(process.env.WECHAT_UI_TEST_OUTPUT || path.join(root, 'storage/logs', automationFixture ? 'automation-settings-preview' : generatedImagesFixture ? 'generated-images-preview' : authorizationFixture ? 'authorization-preview' : process.env.WECHAT_UI_TEST_INTERACTIONS_ONLY === '1' ? 'moments-interactions-preview' : process.env.WECHAT_UI_TEST_LIKES_ONLY === '1' ? 'moments-likes-preview' : process.env.WECHAT_UI_TEST_NATURAL_ONLY === '1' ? 'natural-chat-preview' : process.env.WECHAT_UI_TEST_VISUALS_ONLY === '1' ? 'visual-refresh-preview' : process.env.WECHAT_UI_TEST_TASKS_ONLY === '1' ? 'tasks-layout-preview' : 'ui-preview'));
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(root, 'storage/tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'storage/tmp/ui-preview-'));
const bootstrap = path.join(fixture, 'initial');
const paths = { bootstrap, basePath: path.join(fixture, 'relocated'), workspacePath: path.join(fixture, 'custom-workspace'), recordsPath: path.join(fixture, 'custom-records'), conversationPath: path.join(fixture, 'custom-alpha') };
const token = randomBytes(24).toString('hex');
const accountId = 'wxid_ui_fixture';
const visualFixture = process.env.WECHAT_UI_TEST_VISUAL_SYSTEM === '1';
// Deliberately non-scannable login illustration, never a real login token.
const visualQr = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="white"/><g fill="none" stroke="#172b30" stroke-width="8"><path d="M20 20h40v40H20zM132 20h40v40h-40zM20 132h40v40H20z"/></g><g fill="#172b30"><path d="M32 32h16v16H32zM144 32h16v16h-16zM32 144h16v16H32zM84 20h12v24H84zM104 52h16v16h-16zM20 84h32v12H20zM64 104h12v28H64zM132 84h40v12h-40zM148 108h24v24h-24zM104 144h28v12h-28zM152 152h20v20h-20z"/></g><rect x="53" y="75" width="86" height="35" rx="6" fill="white"/><text x="96" y="97" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#087f79">登录界面预览</text></svg>').toString('base64');
const crc32 = data => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
function fixturePng(rgb, padding = 0, width = 2, height = 2) {
  const chunk = (kind, data) => { const name = Buffer.from(kind), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...(padding ? [chunk('tEXt', Buffer.from('ui-fixture\0' + 'A'.repeat(padding)))] : []), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
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
store.configure(accountId, { enabled: true,
  privatePeers: ['wxid_alice', ...(authorizationFixture ? ['wxid_authorized_only'] : [])],
  groups: ['group_alpha@chatroom', 'group_beta@chatroom', ...(authorizationFixture ? ['group_authorized_only@chatroom'] : [])],
  prompt: '回答清楚、简洁。' });
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
let generatedImageSequence = 0;
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
let state = { account: { id: accountId, nickname: '小胖·界面测试' }, online: true, state: 'online', runtimeReady: true, momentsReadReady: true, momentsWriteReady: true, momentsAudienceReady: true, login: { state: 'online', running: false } };
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
const stickerSamples = [fixturePng([224, 154, 45], 0, 180, 140), stickerGif, fixturePng([76, 150, 207], 0, 160, 160)].map(content => ({ content, md5: createHash('md5').update(content).digest('hex') }));
const stickerFavorites = new Set(stickerSamples.slice(0, 2).map(item => item.md5)), stickerSends = [];
let stickerReadFailure = false, stickerSendUnknown = false;
if (stickerFixture) {
  state.nativeStickersReady = true;
  worker.readStickers = async ({ accountId: id }) => {
    if (stickerReadFailure) throw new ChannelError('STICKER_UNAVAILABLE', '合成微信收藏暂不可用，原有表情保留');
    return { complete: true, items: id === accountId ? [...stickerFavorites].map(md5 => ({ md5, previewAvailable: true })) : [] };
  };
  worker.readStickerContent = async ({ md5 }) => ({ stickerMd5: md5, data: stickerSamples.find(item => item.md5 === md5).content.toString('base64'), quality: 'original' });
  worker.recentStickers = async ({ accountId: id }) => id !== accountId ? [] : [{ id: 'ui-sticker-chat', serverMessageId: '1701', time: Math.floor(Date.now() / 1000),
    direction: 'incoming', source: 'longlink:NewSync', peerId: 'group_alpha@chatroom', chatType: 'group', sender: { id: 'wxid_alice' },
    message: [{ type: 'face', data: { resourceId: 'ui-chat-sticker', stickerMd5: stickerSamples[2].md5 } }] }];
  worker.favoriteSticker = async ({ md5 }) => { stickerFavorites.add(md5); return { saved: true, alreadyFavorite: false }; };
  worker.send = async args => {
    if (args.peerId !== 'filehelper' || args.accountId !== accountId) throw Error('Synthetic sticker tests may only target filehelper');
    stickerSends.push({ accountId: args.accountId, peerId: args.peerId, native: !!args.message[0]?.data?.nativeSticker });
    return { delivery: 'server-ack', serverMessageIds: stickerSendUnknown ? [] : [String(9000 + stickerSends.length)], messageType: args.message[0]?.data?.nativeSticker ? 47 : 3 };
  };
}
const fixtureMoments = [{ id: '9007199254740997', author: { userId: accountId }, createdAt: Math.floor(Date.now() / 1000), text: '合成朋友圈：性格随和，笑点不高。', imageCount: 0, deleted: false }];
const fixtureComments = [{ id: '3', userId: 'wxid_alice', nickname: 'Alice', text: '这个笑话有点冷！', createdAt: Math.floor(Date.now() / 1000), deleted: false }];
const likesFixture = process.env.WECHAT_UI_TEST_LIKES_ONLY === '1';
const interactionsFixture = process.env.WECHAT_UI_TEST_INTERACTIONS_ONLY === '1';
const repliesFixture = process.env.WECHAT_UI_TEST_REPLIES_ONLY === '1';
const interactionPosts = [
  ['72001', 'wxid_alice', 'Alice', '今天试了燕麦拿铁，少糖刚刚好。', 0],
  ['72002', 'wxid_bob', 'Bob', '公园的桂花开了，散步时一路都是香气。', 2],
  ['72003', 'wxid_li_ming', '李明', '[强][呲牙]', 9],
  ['72004', 'wxid_xiao_li', '小李', '终于把那本书读完了，结尾还想再看一遍。', 0],
  ['72005', 'wxid_bob', 'Bob', '这条仅用于合成异常回执。', 0],
  ['72006', 'wxid_alice', 'Alice', '周末想试试做烘焙。', 0],
].map(([id, userId, nickname, text, imageCount], index) => ({ id, author: { userId, nickname }, text, imageCount, media: Array.from({ length: imageCount }, (_, photo) => ({ id: id + '-image-' + photo, type: 'image' })),
  likedByCurrentAccount: false, likeCount: 7, commentCount: 0, comments: [], visibleCommentEntries: 0,
  contentAvailable: true, deleted: false, createdAt: Math.floor(Date.now() / 1000) - index * 60 }));
let interactionWriteGate = null, interactionGenerateGate = null, interactionUnknown = false, interactionGenerations = 0;
let replyGenerateGate = null, replyReadFailure = false;
const replyGenerations = [];
if (repliesFixture) {
  interactionPosts[0].comments = [
    { id: '501', userId: accountId, nickname: '测试账号', text: '这杯拿铁看起来不错。', createdAt: Math.floor(Date.now() / 1000), deleted: false },
    { id: '502', userId: 'wxid_alice', nickname: 'Alice', text: '你也喜欢少糖吗？', replyToCommentId: '501', replyToUserId: accountId, createdAt: Math.floor(Date.now() / 1000) + 1, deleted: false }
  ];
  interactionPosts.push({ ...fixtureMoments[0], contentAvailable: true, likedByCurrentAccount: false, media: [], comments: fixtureComments });
}
const momentImageReads = [];
worker.readMomentsImages = async ({ accountId, query }, signal) => {
  signal.throwIfAborted(); momentImageReads.push(query.postId);
  const post = interactionPosts.find(row => row.id === query.postId);
  if (!post || post.id === '72003') throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '合成图片读取失败，跳过自动评论');
  const bytes = fixturePng([30, 160, 70]);
  return { accountId, postId: post.id, post: structuredClone(post), source: 'wechat-sns-images-live', complete: true, imageCount: post.imageCount,
    items: post.media.map((item, index) => ({ index: index + 1, mediaId: item.id, bytes: bytes.length, data: bytes.toString('base64'),
      mediaType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') })) };
};
const fixtureFriendMoments = [
  ['91001', 'wxid_alice', 'Alice', '周末沿着江边慢慢走，收集了一路的晚霞。', false, 7],
  ['91002', 'wxid_bob', 'Bob', '给新做的海报换了一套轻快的颜色。', true, 12],
  ['91003', 'wxid_alice', 'Alice', '合成结果不明：没有收到点赞回执。', false, 3],
  ['91004', 'wxid_bob', 'Bob', '合成已有点赞：提交前由微信核实。', false, 4],
  ['91005', 'wxid_bob', 'Bob', '合成失败：当前动态不允许互动。', false, 0],
].map(([id, userId, nickname, text, likedByCurrentAccount, likeCount]) => ({ id, author: { userId, nickname }, text, likedByCurrentAccount, likeCount, commentCount: 2, imageCount: 0, contentAvailable: true, deleted: false, createdAt: Math.floor(Date.now() / 1000) }));
const momentReads = [], momentRpcRequests = [];
let momentLikeReadGate = null;
let momentSerial = 100;
const momentWrites = [];
let momentGenerationMode = 'normal', momentGenerationGate = null, momentGenerationCalls = 0;
const fixtureAudience = { accountId, source: 'wechat-contacts-live', fetchedAt: new Date().toISOString(), membershipComplete: true, unavailableCount: 0,
  contacts: [{ id: 'wxid_alice', name: 'Alice', nickname: 'Alice', remark: '', labelIds: ['1'] }, { id: 'wxid_bob', name: 'Bob', nickname: 'Bob', remark: '', labelIds: ['1'] }],
  labels: [{ id: '1', name: '产品同事', memberCount: 2, userIds: ['wxid_alice','wxid_bob'] }, { id: '2', name: '空标签', memberCount: 0, userIds: [] }] };
worker.readMomentsAudience = async (args, signal) => {
  signal.throwIfAborted(); if (args.accountId !== state.account.id) throw new ChannelError('ACCOUNT_CHANGED', '账号已变化');
  return structuredClone({ ...fixtureAudience, accountId: state.account.id });
};
worker.readMoments = async (args, signal) => {
  signal.throwIfAborted(); if (args.accountId !== state.account.id) throw new ChannelError('ACCOUNT_CHANGED', '账号已变化');
  if (interactionsFixture || repliesFixture) {
    momentReads.push(structuredClone(args.query)); const query = args.query;
    if (repliesFixture && replyReadFailure && query.action === 'comments') throw new ChannelError('MOMENTS_FIXTURE_READ', '合成评论区读取失败');
    const all = args.accountId !== accountId ? [] : query.action === 'detail' || query.action === 'comments' ? interactionPosts.filter(post => post.id === query.postId)
      : query.action === 'user' ? interactionPosts.filter(post => post.author.userId === query.userId) : interactionPosts;
    const offset = Number(query.cursor ?? 0), limit = query.limit ?? 20;
    return { accountId: args.accountId, action: query.action, source: 'wechat-sns-live', ...(query.action === 'comments' ? { postId: query.postId, visibleCommentEntries: all[0]?.comments.length ?? 0 } : {}),
      items: structuredClone(query.action === 'comments' ? all[0]?.comments ?? [] : all.slice(offset, offset + limit)), nextCursor: all.length > offset + limit ? String(offset + limit) : null };
  }
  if (likesFixture && ['timeline', 'user'].includes(args.query.action)) {
    momentReads.push(structuredClone(args.query));
    if (args.scopeKey.startsWith('moments-likes:') && momentLikeReadGate) {
      const gate = momentLikeReadGate; gate.started = true;
      let abort;
      try { await Promise.race([gate.promise, new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]); }
      finally { signal.removeEventListener('abort', abort); }
      signal.throwIfAborted();
    }
    const otherAccount = args.accountId !== accountId;
    const items = otherAccount ? [] : args.query.action === 'user' ? fixtureFriendMoments.filter(post => post.author.userId === args.query.userId) : args.query.cursor ? [fixtureFriendMoments[0], ...fixtureFriendMoments.slice(3)] : [fixtureMoments[0], ...fixtureFriendMoments.slice(0, 3)];
    return { accountId: args.accountId, action: args.query.action, ...(args.query.action === 'user' ? { userId: args.query.userId } : {}), source: 'wechat-sns-live', items: structuredClone(items), nextCursor: !otherAccount && args.query.action === 'timeline' && !args.query.cursor ? 'fixture-friends-page-2' : null };
  }
  const items = args.query.action === 'comments' ? fixtureComments : args.query.action === 'detail' ? fixtureMoments.filter(post => post.id === args.query.postId) :
    args.query.action === 'user' ? fixtureMoments.filter(post => post.author.userId === args.query.userId) : fixtureMoments;
  return { accountId: args.accountId, action: args.query.action, source: 'wechat-sns-live',
    ...(args.query.action === 'user' ? { userId: args.query.userId } : {}), ...(args.query.action === 'comments' ? { postId: args.query.postId } : {}),
    items: structuredClone(items), visibleCommentEntries: fixtureComments.length, nextCursor: null };
};
worker.writeMoments = async (args, signal) => {
  signal.throwIfAborted(); if (args.accountId !== accountId) throw new ChannelError('ACCOUNT_CHANGED', '账号已变化');
  const query = args.query, postId = query.postId ?? String(BigInt('9007199254740999') + BigInt(++momentSerial));
  momentWrites.push(structuredClone(query));
  if (interactionsFixture || repliesFixture) {
    const post = interactionPosts.find(row => row.id === postId); if (!post) throw new Error('Unknown isolated interaction target');
    if (interactionWriteGate) { interactionWriteGate.started = true; await interactionWriteGate.promise; signal.throwIfAborted(); }
    if (interactionUnknown && query.action === 'comment' && postId === '72005') throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '合成测试：评论回执不明，未重发');
    if (query.action === 'like') { post.likedByCurrentAccount = true; post.likeCount++; }
    const commentId = String(++momentSerial);
    const target = query.replyToCommentId ? post.comments.find(row => row.id === query.replyToCommentId) : null;
    const relation = target ? { replyToCommentId: target.id, replyToUserId: target.userId } : {};
    if (query.action === 'comment') { post.comments.push({ id: commentId, userId: accountId, nickname: '测试账号', text: query.text, createdAt: Math.floor(Date.now() / 1000), deleted: false, ...relation }); post.commentCount++; post.visibleCommentEntries++; }
    return { accountId, action: query.action, postId, delivery: 'server-ack', ...(query.action === 'like' ? { liked: true } : { commentId, text: query.text, ...relation }) };
  }
  if (likesFixture && query.action === 'like') {
    const post = fixtureFriendMoments.find(post => post.id === query.postId);
    if (!post) throw new Error('Unknown synthetic friend moment');
    if (post.id === '91003') throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '合成点赞未收到确认，请核对微信中的实际状态');
    if (post.id === '91005' && momentWrites.filter(row => row.action === 'like' && row.postId === post.id).length === 1) throw new ChannelError('MOMENTS_TARGET_UNAVAILABLE', '合成点赞失败：当前动态不允许互动，未提交', { snsDelivery: 'not-sent' });
    const alreadyLiked = post.likedByCurrentAccount || post.id === '91004';
    post.likedByCurrentAccount = true;
    return { accountId, action: 'like', postId, liked: true, delivery: alreadyLiked ? 'verified-existing' : 'server-ack', ...(alreadyLiked ? { alreadyLiked: true } : {}) };
  }
  const selection = { blockedLabelIds: query.blockedLabelIds ?? [], blockedUserIds: query.blockedUserIds ?? [] };
  const blockedUserIds = [...new Set([...selection.blockedUserIds, ...fixtureAudience.labels.filter(row => selection.blockedLabelIds.includes(row.id)).flatMap(row => row.userIds)])];
  if (query.action === 'publish') fixtureMoments.push({ id: postId, author: { userId: accountId }, createdAt: Math.floor(Date.now() / 1000), text: query.text, imageCount: query.images?.length ?? 0 });
  if (query.action === 'delete') fixtureMoments.find(post => post.id === postId).deleted = true;
  const commentId = String(++momentSerial);
  if (query.replyToCommentId) fixtureComments.push({ id: commentId, userId: accountId, text: query.text, replyToCommentId: query.replyToCommentId, replyToUserId: 'wxid_alice', createdAt: Math.floor(Date.now() / 1000) });
  return { accountId, action: query.action, postId, text: query.text, commentId, createdAt: Math.floor(Date.now() / 1000), imageCount: query.images?.length ?? 0, delivery: 'server-ack',
    ...(query.action === 'publish' ? { blockedUserIds, blockedLabelIds: selection.blockedLabelIds, audienceConfirmed: true, audienceSelection: selection, audienceSource: fixtureAudience.source, audienceFetchedAt: fixtureAudience.fetchedAt } : {}),
    ...(query.replyToCommentId ? { replyToCommentId: query.replyToCommentId, replyToUserId: 'wxid_alice' } : {}), ...(query.action === 'delete' ? { deleted: true } : {}) };
};
const assetAnalysisRequests = [];
let memoryImageReadsReady = false;
worker.media = async ({ resourceId }) => {
  if (stickerFixture && resourceId === 'ui-chat-sticker') return { data: stickerSamples[2].content.toString('base64'), stickerMd5: stickerSamples[2].md5, quality: 'original' };
  if (resourceId === 'c'.repeat(64)) return { data: fixturePng([200, 200, 200]).toString('base64'), mediaType: 'image/png', quality: 'thumbnail', fixtureMemoryImage: true };
  if (!memoryImageReadsReady) throw new ChannelError('IMAGE_URL_INVALID', '图片资源地址不是可读取的微信媒体地址');
  return { data: fixturePng([200, 30, 30]).toString('base64'), mediaType: 'image/png', quality: 'original', fixtureMemoryImage: true };
};
const runner = { selection: () => store.modelChoice() || { provider: 'fixture', model: 'alpha' }, defaultSelection: () => ({ provider: 'fixture', model: 'alpha' }),
  async summarize(_material, _target, signal) { signal.throwIfAborted(); return '产品讨论组：周五带咖啡讨论产品。'; },
  async describeImage(_image, signal) { signal.throwIfAborted(); return '合成测试图片的笔记。'; },
  async describeImages(images, signal) { signal.throwIfAborted(); if (!images.every(image => image.fixtureMemoryImage)) assetAnalysisRequests.push(images.length); return images.map(() => '合成方块，用于表达赞同或让讨论冷静下来。'); },
  async describeStickers(images, signal) { signal.throwIfAborted(); assetAnalysisRequests.push(images.length); return images.map(image => ({
    name: '合成表情 ' + createHash('sha256').update(image.data).digest('hex').slice(0, 4), description: '用于界面验证的合成图片。',
    usage: '适合轻松回应、表示赞同；严肃求助时先用文字。', tags: ['赞同', '轻松回应'],
  })); },
  async run(input) {
    if (repliesFixture && input.mode === 'moments-reply') {
      const request = JSON.parse(input.text); replyGenerations.push(request);
      if (replyGenerateGate) { const gate = replyGenerateGate; gate.started = true; let abort;
        try { await Promise.race([gate.promise, new Promise((_, reject) => { abort = () => reject(input.signal.reason); input.signal.addEventListener('abort', abort, { once: true }); })]); }
        finally { input.signal.removeEventListener('abort', abort); }
      }
      input.signal.throwIfAborted();
      return { text: request.incomingReply ? JSON.stringify({ text: '我也喜欢少糖，刚好能尝到咖啡香。', skipReason: '' }) : '把窗户关上，笑话就不冷啦。' };
    }
    if (interactionsFixture && input.mode === 'moments-image-read') {
      input.signal.throwIfAborted(); return { text: JSON.stringify({ images: input.images.map((_image, index) => ({ index: index + 1, readable: true, description: '合成图片中是一片绿色方块。' })) }) };
    }
    if (interactionsFixture && input.mode === 'moments-interaction') {
      interactionGenerations++; input.signal.throwIfAborted(); const { posts } = JSON.parse(input.text);
      if (interactionGenerateGate) { const gate = interactionGenerateGate; gate.started = true; let abort;
        try { await Promise.race([gate.promise, new Promise((_, reject) => { abort = () => reject(input.signal.reason); input.signal.addEventListener('abort', abort, { once: true }); })]); }
        finally { input.signal.removeEventListener('abort', abort); } input.signal.throwIfAborted(); }
      return { text: JSON.stringify({ comments: posts.map(post => ({ postId: post.postId, text: post.text.includes('拿铁') ? '燕麦的香味配咖啡应该不错。' : '合成回应：' + post.text, skipReason: '' })) }) };
    }
    if (visualFixture && input.mode === 'workbench' && input.text.includes('"messages":')) {
      input.signal.throwIfAborted();
      const request = JSON.parse(input.text.slice(0, input.text.lastIndexOf('\n输出'))), refs = request.messages;
      return { text: JSON.stringify({ title: '产品讨论 · 本次结论与待办',
        conclusions: [{ text: '先核对本次交付范围，再安排下一轮评审。', sources: [refs[0].id] }],
        questions: [{ text: '上线时间仍待确认。', sources: [refs[0].id] }],
        todos: [{ text: '整理评审意见并发送给产品同事核对。', owner: 'Alice', sources: [refs[0].id] }] }) };
    }
    if (input.mode === 'moments-materials') {
      input.signal.throwIfAborted(); const request = JSON.parse(input.text);
      return { text: JSON.stringify({ items: [{ title: '一个工具小观察', text: '设置越多未必越顺手，有时减少一个步骤就很好。', sourceIds: [request.records[0].id], updateId: null, expiresInDays: null }] }) };
    }
    if (input.mode === 'moments-material-review') {
      input.signal.throwIfAborted(); return { text: JSON.stringify({ safeIds: JSON.parse(input.text).candidates.map(item => item.id) }) };
    }
    if (input.mode === 'moments-content-review') return { text: '{"ok":true,"reason":""}' };
    if (input.mode !== 'moments-publish') throw new Error('The UI fixture must never generate a model response');
    momentGenerationCalls++;
    if (momentGenerationMode === 'fail') { momentGenerationMode = 'normal'; throw new ChannelError('MOMENTS_FIXTURE_FAILED', '界面测试：正文生成失败，未发布'); }
    if (momentGenerationMode === 'hold') {
      let abort;
      try { await Promise.race([momentGenerationGate.promise, new Promise((resolve, reject) => {
        abort = () => reject(input.signal.reason); input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) abort();
      })]); } finally { input.signal.removeEventListener('abort', abort); }
    }
    input.signal.throwIfAborted(); const request = JSON.parse(input.text);
    return { text: JSON.stringify({ theme: request.themes[0] || '随手想法', text: request.research?.unavailable ? '合成纯文字草稿：给忙碌的一天留一点空白，仅本地验证。' : '合成 AI 草稿：冰箱里大家很冷静，仅本地验证。', imagePrompt: request.image ? '合成配图要求' : '',
      materialIds: request.materials.slice(0, 2).map(item => item.id), imageMaterialId: request.imageMode === 'library' ? request.materials.find(item => item.kind === 'image' && item.imageUse === 'publish')?.id || '' : '' }) }; } };
let channel = new WechatChannel({ store, runner, transport: worker });
const executionTraces = executionTraceFixture ? await seedExecutionTraceFixture(channel, accountId) : null;
const fixturePython = process.env.WECHAT_TEST_PYTHON || path.join(root, 'storage/cache', 'dsh-plugin-python-3.13.9-' + createHash('sha256').update(fs.readFileSync(path.join(root, 'runtime/requirements.txt'))).digest('hex').slice(0, 16), 'python.exe');
if (fs.existsSync(fixturePython)) channel.library.pythonPath = fixturePython;
if (!stickerFixture) channel.library.configure(accountId, { ...channel.library.account(accountId).settings, autoDescribe: false });
else store.setModelConfig({ ...store.modelConfig(), vision: true });
if (interactionsFixture) channel.momentsAutomation.interactions.automation.start();
// This fixture checks owner UI/RPC and durable files. Automatic extraction must not
// drain its deliberately queued cancellation samples or call a real model.
channel.maintainMemory = (selector, options) => {
  if (options?.force) return WechatChannel.prototype.maintainMemory.call(channel, selector, options);
};
let scheduler = new TaskScheduler({ store, channel }); channel.scheduler = scheduler;
let agentIdentity = new AgentIdentity(activeRoot);
const preservedFiles = Object.fromEntries(Object.entries(describeWorkspace(activeRoot, store)).filter(([key]) => ['workspacePath', 'recordsPath', 'memoryPath', 'assetsPath', 'tasksPath', 'loginPath', 'cachePath'].includes(key)).map(([key, directory]) => {
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'ui-preserved.txt'), content = 'Synthetic data preserved for ' + key;
  fs.writeFileSync(file, content); return [key, { file, content }];
}));
function openFixtureRuntime(nextRoot) {
  const nextStore = new StateStore(nextRoot); nextStore.ensureWorkspace();
  const nextChannel = new WechatChannel({ store: nextStore, runner, transport: worker });
  nextChannel.maintainMemory = (selector, options) => {
    if (options?.force) return WechatChannel.prototype.maintainMemory.call(nextChannel, selector, options);
  };
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
let modelCatalog = structuredClone(uiFixtureModels);
let modelInfoFailure = false;
const modelInfoRequests = [];
const listedModels = () => modelCatalog.map(({ reasoning, ...model }) => structuredClone(model));
const ctx = { llm: {
  listProviders: () => [{ id: 'fixture' }],
  listModels: async () => listedModels(),
  resolveModelInfo: async (provider, id) => {
    if (modelInfoFailure) throw new Error('SYNTHETIC_PRIVATE_MODEL_LOOKUP_FAILURE');
    return structuredClone(modelCatalog.find(model => provider === 'fixture' && model.id === id));
  },
}, credentials: {
  set: async (ref, value) => { searchKeys.set(ref, value); },
  resolve: async ref => searchKeys.has(ref) ? { value: searchKeys.get(ref) } : undefined,
  describe: async ref => ({ configured: searchKeys.has(ref) }),
} };
runner.search = new SearchService(ctx, { fetchImpl: async () => { throw new Error('UI fixture must not call a real search endpoint'); } });
runner.ctx = ctx; channel.work.imageGeneration.ctx = ctx;
const service = createPluginService({ ctx, root: activeRoot, store, worker, runner, channel, scheduler, identity: agentIdentity, relocateWorkspace, dshSessionPath: path.join(fixture, 'host-sessions') });
let authorizationCleanupPreview = null;
if (authorizationFixture) {
  const originalCall = service.call.bind(service);
  service.call = (endpoint, ...args) => {
    const value = originalCall(endpoint, ...args);
    return endpoint === 'status' && authorizationCleanupPreview
      ? { ...value, authorization: authorizationCleanupPreview } : value;
  };
}
const rpc = rpcHandler(service), failures = new Set(), cancelRequests = [], assetUploadRequests = [], storageRequests = [], identityRequests = [], settingsRequests = [];
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
const validatedClientFile = process.env.WECHAT_UI_TEST_CLIENT_BUNDLE;
const clientPlugins = [];
if (validatedClientFile) {
  if (!path.isAbsolute(validatedClientFile) || !fs.statSync(validatedClientFile).isFile()) throw new Error('Pass an existing absolute client bundle path');
  const bytes = fs.readFileSync(validatedClientFile, 'utf8');
  fs.writeFileSync(path.join(out, 'client-bundle-verification.json'), JSON.stringify({
    file: validatedClientFile, sha256: createHash('sha256').update(bytes).digest('hex'), loadedProductionBundle: true,
  }, null, 2) + '\n');
  clientPlugins.push({ name: 'validated-client-bundle', onLoad: {
    filter: { id: /[\\/]frontend[\\/]panel\.jsx$/ },
    handler: () => ({ code: `import * as React from 'react'; import * as jsxRuntime from 'react/jsx-runtime';
      let captured; window.__ModuleLoader__ = { load({ factory }) { captured = factory(name => {
        if (name === 'react') return React; if (name === 'react/jsx-runtime') return jsxRuntime;
        throw new Error('Unexpected client dependency: ' + name);
      }); } }; new Function(${JSON.stringify(bytes)})();
      export const WechatPanel = captured.WechatPanel;`, loader: 'js' }),
  } });
}
const build = await rolldown({ input: path.join(root, 'tests/fixtures/ui-entry.jsx'), platform: 'browser',
  plugins: clientPlugins, transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') } } });
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
      if (body.command === 'authorizationCleanupState' && authorizationFixture) {
        const pendingCount = body.payload?.pendingCount;
        if (!Number.isInteger(pendingCount) || pendingCount < 0 || pendingCount > 10) throw new Error('Choose a synthetic cleanup count');
        authorizationCleanupPreview = pendingCount || body.payload.error
          ? { pendingCount, error: body.payload.error || null } : null;
        json(res, { ok: true }); return;
      }
      if (body.command === 'automationState' && automationFixture) {
        const id = state.account.id;
        const views = await Promise.all(['moments.list', 'moments.likes.list', 'moments.interactions.list', 'moments.materials.list']
          .map(endpoint => service.call(endpoint, { accountId: id })));
        json(res, { status: service.call('status'), role: store.roleCardSettingsView(), media: channel.library.list(id).settings,
          moments: views[0], likes: views[1], interactions: views[2], materials: views[3] }); return;
      }
      if (visualFixture && body.command === 'visualLogin') {
        const loginState = body.payload?.state;
        if (!['online', 'offline', 'logged-out', 'qrcode', 'scanned', 'error'].includes(loginState)) throw new Error('Unsupported synthetic login state');
        state = { ...state, account: ['online', 'offline'].includes(loginState) ? { id: accountId, nickname: '小胖·界面测试' } : null,
          online: loginState === 'online', state: loginState === 'online' ? 'online' : 'offline',
          login: { state: loginState === 'logged-out' ? 'idle' : loginState, running: ['qrcode', 'scanned'].includes(loginState),
            image: ['qrcode', 'scanned'].includes(loginState) ? visualQr : null,
            error: loginState === 'error' ? '合成登录错误：二维码已过期，请重新扫码。' : null } };
        json(res, { ok: true }); return;
      }
      if (visualFixture && body.command === 'seedRecovery') {
        const scope = { accountId, chatType: 'group', peerId: 'group_alpha@chatroom' };
        for (const [index, recordState] of ['failed', 'unknown', 'partial'].entries()) {
          const key = 'visual-recovery-' + recordState;
          store.add({ ...scope, key, messageId: key, contextKey: key, senderId: 'wxid_alice', sender: 'Alice', state: recordState,
            question: '请汇总今天的交付安排。', replyDraft: '今天完成交付清单，明天进行内部评审。',
            reason: recordState === 'failed' ? '连接断开，回复尚未发送。' : '未收到最终回执，请先在微信核对。',
            delivery: recordState === 'failed' ? 'not-sent' : recordState, createdAt: Date.now() - index * 1000, updatedAt: Date.now() - index * 1000 });
        }
        json(res, { ok: true }); return;
      }
      if (visualFixture && body.command === 'seedMemoryConflict') {
        const scope = { accountId, chatType: 'group', peerId: 'group_alpha@chatroom' };
        const section = channel.longMemory.view(accountId).sections.find(item => item.peerId === scope.peerId);
        const old = section?.facts.find(item => item.state === 'active');
        if (!old) throw new Error('Seed source facts before the conflict fixture');
        const factText = 'ALPHA：本会话的合成长事实已修订，等待核对。';
        channel.longMemory.capture(scope, [{ key: 'visual-conflicting-fact', text: factText, direction: 'incoming', senderId: 'wxid_alice', senderName: 'Alice', time: Date.now() }]);
        const result = await channel.longMemory.extract(scope, { run: async request => {
          const sources = JSON.parse(request.text.split('\n')[0]).sources;
          const reference = sources.find(source => source.text === factText);
          if (!reference) throw new Error('Synthetic conflict source is missing');
          return { text: JSON.stringify({ facts: [{ text: factText, sources: [reference.id], evidence: [{ source: reference.id, quote: factText }], replaces: [old.id] }] }) };
        } }, new AbortController().signal);
        json(res, result); return;
      }
      if (body.command === 'momentWrites') { json(res, momentWrites); return; }
      if (repliesFixture && body.command === 'momentReplies') {
        const manager = channel.momentsAutomation, mode = body.payload?.mode;
        if (mode === 'due') { manager.stopped = false; manager.rule(state.account.id).nextRunAt = Date.now() - 1; void manager.tick().catch(() => {}); }
        if (mode === 'hold') replyGenerateGate = { ...Promise.withResolvers(), started: false };
        if (mode === 'release') { replyGenerateGate?.resolve(); replyGenerateGate = null; }
        if (mode === 'read-failure') replyReadFailure = body.payload.enabled;
        if (mode === 'add') {
          const post = interactionPosts[0], parent = post.comments.findLast(row => row.userId === accountId);
          post.comments.push({ id: String(++momentSerial), userId: 'wxid_alice', nickname: 'Alice', text: '下次再一起试试别的口味。',
            replyToCommentId: parent.id, replyToUserId: accountId, createdAt: Math.floor(Date.now() / 1000) + 1, deleted: false });
        }
        json(res, { list: manager.list(state.account.id), reads: momentReads, generations: replyGenerations, generating: !!replyGenerateGate?.started }); return;
      }
      if (process.env.WECHAT_UI_TEST_MOMENTS_RECOVERY_ONLY === '1' && body.command === 'seedMomentsRecovery') {
        const manager = channel.momentsAutomation.publishing, selection = { blockedLabelIds: ['1'], blockedUserIds: [] };
        const write = worker.writeMoments, created = [];
        try {
          for (const [index, evidence] of [false, true].entries()) {
            const draft = await manager.preview(accountId, selection, 'ui-recovery-preview-' + index, new AbortController().signal);
            const text = evidence ? '合成状态核对：已发布，但指定屏蔽对象尚未全部确认。' : '合成状态核对：这条曾发布的动态已经删除。';
            manager.editDraft(accountId, draft.id, text);
            const postId = String(93001 + index), createdAt = Math.floor(Date.now() / 1000);
            worker.writeMoments = async args => {
              momentWrites.push(structuredClone(args.query));
              throw new ChannelError('ERR_MOMENTS_WRITE_PROTOCOL', '合成回执：屏蔽范围尚未确认', { snsDelivery: 'unknown', ...(evidence ? { publication: {
                accountId, postId, createdAt, textHash: createHash('sha256').update(text).digest('hex'), imageCount: 0,
                submittedBlockedUserIds: ['wxid_alice', 'wxid_bob'], returnedBlockedUserIds: ['wxid_alice'],
                audienceSelection: selection, audienceSource: fixtureAudience.source, audienceFetchedAt: fixtureAudience.fetchedAt,
              } } : {}) });
            };
            try { await manager.publishDraft(accountId, draft.id, new AbortController().signal); }
            catch (error) { if (error.code !== 'ERR_MOMENTS_WRITE_PROTOCOL') throw error; }
            const post = { id: postId, author: { userId: accountId }, text, createdAt, imageCount: 0, deleted: false };
            fixtureMoments.push(post); channel.momentsAutomation.remember(accountId, [post]);
            if (!evidence) {
              worker.writeMoments = write;
              await channel.moments.writeOwner({ postId, action: 'delete' }, accountId, 'ui-recovery-explicit-delete', new AbortController().signal);
            }
            created.push({ id: draft.id, postId, evidence });
          }
        } finally { worker.writeMoments = write; }
        channel.momentsAutomation.configure(accountId, { enabled: false });
        for (const id of ['94001', '94002']) {
          channel.momentsAutomation.remember(accountId, [{ id, author: { userId: accountId }, createdAt: Math.floor(Date.now() / 1000), text: '合成暂不可读动态', imageCount: 0 }]);
          channel.momentsAutomation.recordReadFailure(accountId, id, new ChannelError('ERR_MOMENTS_REJECTED', 'unavailable', { ret: -2 }));
        }
        Object.assign(channel.momentsAutomation.data.accounts[accountId], { lastError: null, lastRun: { startedAt: Date.now(), finishedAt: Date.now(),
          scanned: 12, attempted: 0, replied: 0, skipped: 12, unavailable: 2, deferred: 1, state: 'partial' } });
        channel.momentsAutomation.save();
        json(res, { created }); return;
      }
      if (interactionsFixture && body.command === 'momentInteractions') { json(res, { list: channel.momentsAutomation.interactions.list(state.account.id, body.payload?.id), reads: momentReads, imageReads: momentImageReads, requests: momentRpcRequests, generations: interactionGenerations }); return; }
      if (interactionsFixture && body.command === 'interactionMode') {
        if (body.payload?.mode === 'hold') interactionWriteGate = { ...Promise.withResolvers(), started: false };
        if (body.payload?.mode === 'release') { interactionWriteGate?.resolve(); interactionWriteGate = null; }
        if (body.payload?.mode === 'unknown') interactionUnknown = true;
        if (body.payload?.mode === 'hold-generation') interactionGenerateGate = { ...Promise.withResolvers(), started: false };
        if (body.payload?.mode === 'release-generation') { interactionGenerateGate?.resolve(); interactionGenerateGate = null; }
        json(res, { started: !!interactionWriteGate?.started, generating: !!interactionGenerateGate?.started }); return;
      }
      if (interactionsFixture && body.command === 'interactionAutomation') {
        const automatic = channel.momentsAutomation.interactions.automation;
        if (body.payload?.mode === 'due') { automatic.start(); automatic.rule(state.account.id).nextRunAt = Date.now() - 1; void automatic.tick().catch(() => {}); }
        if (body.payload?.mode === 'change') await automatic.configure(state.account.id, body.payload.settings, automatic.list(state.account.id).revision);
        if (body.payload?.mode === 'add') for (const id of ['72007', '72008']) {
          if (!interactionPosts.some(post => post.id === id)) interactionPosts.push({ ...structuredClone(interactionPosts[0]), id,
            text: '新增合成动态 ' + id, createdAt: Math.floor(Date.now() / 1000), likedByCurrentAccount: false, comments: [], visibleCommentEntries: 0, commentCount: 0 });
        }
        json(res, automatic.list(state.account.id)); return;
      }
      if (likesFixture && body.command === 'momentLikes') { json(res, { reads: momentReads, requests: momentRpcRequests, list: await service.call('moments.likes.list', { accountId: state.account.id }) }); return; }
      if (likesFixture && body.command === 'momentLikeReadGate') {
        if (body.payload?.mode === 'hold') momentLikeReadGate = { ...Promise.withResolvers(), started: false };
        if (body.payload?.mode === 'release') { momentLikeReadGate?.resolve(); momentLikeReadGate = null; }
        json(res, { started: !!momentLikeReadGate?.started }); return;
      }
      if (body.command === 'momentMaterials') { json(res, channel.momentsAutomation.materials.list(accountId)); return; }
      if (process.env.WECHAT_UI_TEST_CLEANUP_ONLY === '1' && body.command === 'seedCleanup') {
        const materials = channel.momentsAutomation.materials;
        if (body.payload?.arrive) {
          materials.put(accountId, { requestId: 'cleanup-arrival', fields: { title: '确认后新增', text: '保留这条后来出现的素材。' } });
        } else {
          for (let i = 0; i < 3; i++) materials.put(accountId, { requestId: 'cleanup-' + i, fields: { title: '清理样本 ' + i, text: '仅本地测试的素材。' } });
          for (let i = 0; i < 3; i++) await channel.momentsAutomation.publishing.preview(accountId, { themes: [], name: '清理草稿 ' + i }, 'cleanup-draft-' + i, new AbortController().signal);
          const likes = channel.momentsAutomation.likes;
          likes.data.runs.cleanup = { id: 'cleanup', accountId, requestId: 'cleanup', source: 'manual', state: 'completed', startedAt: Date.now(), finishedAt: Date.now(), scanned: 1, attempted: 0, liked: 0, skipped: 1 };
          likes.data.records.cleanup = { accountId, postId: '900', userId: 'wxid_alice', createdAt: Math.floor(Date.now() / 1000), updatedAt: Date.now(), attemptedAt: null, requestId: 'cleanup', text: '合成点赞记录', state: 'skipped' }; likes.save();
          channel.momentsAutomation.data.replies.cleanup = { accountId, postId: '901', commentId: '902', state: 'sent', updatedAt: Date.now(), text: '合成评论回复' }; channel.momentsAutomation.save();
          const data = channel.workbench.disk.load(accountId);
          data.summaries.push({ id: 'cleanup-digest', accountId, chatType: 'group', peerId: 'group_alpha@chatroom', title: '待清理的合成简报', from: Date.now() - 60000, to: Date.now(), createdAt: Date.now(), source: [], conclusions: [], questions: [], todos: [], coverage: { storedMessages: 0, included: 0, truncated: false, localOnly: true } });
          channel.workbench.disk.save(data);
        }
        json(res, { ok: true }); return;
      }
      if (body.command === 'momentGeneration') {
        const mode = body.payload?.mode;
        if (!['normal', 'hold', 'release', 'fail', 'status'].includes(mode)) throw Error('Invalid synthetic generation mode');
        if (mode === 'hold') { momentGenerationMode = 'hold'; momentGenerationGate = Promise.withResolvers(); }
        else if (mode === 'release') { momentGenerationMode = 'normal'; momentGenerationGate?.resolve(); }
        else if (mode !== 'status') momentGenerationMode = mode;
        json(res, { calls: momentGenerationCalls }); return;
      }
      if (body.command === 'modelCatalog') {
        if (!['full', 'without-low', 'empty', 'expanded'].includes(body.payload?.mode)) throw new Error('Invalid synthetic model catalog mode');
        modelCatalog = structuredClone(uiFixtureModels);
        const reasoning = modelCatalog.find(model => model.id === 'beta').reasoning;
        if (['without-low', 'empty'].includes(body.payload.mode)) reasoning.efforts = reasoning.efforts.filter(effort => body.payload.mode === 'without-low' && effort.id !== 'low');
        if (body.payload.mode === 'expanded') {
          reasoning.efforts = [{ id: 'off', name: '关闭' }, reasoning.efforts[0], { id: 'medium', name: '中' }, reasoning.efforts[1], { id: 'adaptive/custom', name: '自适应' }];
          delete reasoning.defaultEffort;
        }
        json(res, { models: listedModels() }); return;
      }
      if (body.command === 'modelInfoFailure') { modelInfoFailure = body.payload?.enabled === true; json(res, { ok: true }); return; }
      if (body.command === 'flagRecordStyle') {
        const record = store.data.records.find(value => value.key === body.payload?.recordKey && value.accountId === state.account?.id);
        if (!record || record.state !== 'sent') throw new Error('Choose a confirmed synthetic record');
        store.update(record, { replyStyleWarning: REPLY_STYLE_REVIEW_NOTE }); json(res, { key: record.key, reply: record.reply }); return;
      }
      if (body.command === 'recordMemoryContext') {
        const record = store.data.records.find(value => value.key === body.payload?.recordKey && value.accountId === state.account?.id);
        if (!record || record.state !== 'sent' || !['always', 'on-demand'].includes(body.payload.mode)) throw new Error('Choose a confirmed synthetic record and memory mode');
        const memoryContext = body.payload.mode === 'on-demand'
          ? { mode: 'on-demand', recentMessages: 4, referenceChars: 0 }
          : { mode: 'always', recentMessages: 4, referenceChars: 128, matchedTerms: ['喝茶', '偏好'], omitted: true };
        store.update(record, { memoryContext }); json(res, { key: record.key, memoryContext }); return;
      }
      if (body.command === 'searchFallback') { runner.searchStatus = () => ({ ok: true, provider: 'dsh', primaryProvider: 'tavily', fallbackUsed: true, fallbackAttempted: true, sourceCount: 3, checkedAt: new Date().toISOString() }); json(res, { ok: true }); return; }
      if (body.command === 'searchBothFailed') { runner.searchStatus = () => ({ ok: false, provider: null, primaryProvider: 'tavily', fallbackUsed: false, fallbackAttempted: true, code: 'WEB_SEARCH_FAILED', message: 'Tavily 搜索请求未完成；DeepSeek 原生搜索暂时异常，本次未取得搜索结果。', checkedAt: new Date().toISOString() }); json(res, { ok: true }); return; }
      if (body.command === 'searchFailure') { runner.searchStatus = () => ({ ok: false, provider: 'tavily', code: 'WEB_SEARCH_AUTH_FAILED', message: 'Tavily 搜索接口返回 HTTP 401，请检查 Tavily API Key 与访问权限。', checkedAt: new Date().toISOString() }); json(res, { ok: true }); return; }
      if (body.command === 'paths') { json(res, paths); return; }
      if (body.command === 'stats') { json(res, { lastHistoryRequest, cancelRequests, tasks: scheduler.list(accountId).tasks, assetUploadRequests, assetAnalysisRequests, memberRequests, migrations, storageRequests, identityRequests, modelInfoRequests, activeRoot, storeFile: store.file, identityPath: agentIdentity.file, preservedFiles,
        ...(authorizationFixture ? { settingsRequests, firstAccountSettings: store.settings(accountId) } : {}) }); return; }
      if (body.command === 'identity') { json(res, agentIdentity.view()); return; }
      if (body.command === 'editIdentityExternally') {
        const markdown = body.payload?.markdown;
        if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 32000 || markdown.includes('\0')) throw new Error('Invalid synthetic identity Markdown');
        fs.writeFileSync(agentIdentity.file, markdown, 'utf8'); json(res, agentIdentity.view()); return;
      }
      if (body.command === 'assetZip') { json(res, { name: '界面测试表情.zip', data: assetZip.toString('base64'), bytes: assetZip.length }); return; }
      if (body.command === 'assets') { json(res, { ...channel.library.list(state.account.id), stickers: channel.stickers.view(state.account.id) }); return; }
      if (body.command === 'traceFixture' && executionTraces) { json(res, { ids: executionTraces.ids }); return; }
      if (body.command === 'completeTraceFixture' && executionTraces) { executionTraces.complete(); json(res, { ok: true }); return; }
      if (body.command === 'stickerState' && stickerFixture) { json(res, { sends: stickerSends, favorites: [...stickerFavorites], analysis: assetAnalysisRequests, records: store.data.records.filter(record => record.mode === 'sticker-test') }); return; }
      if (body.command === 'stickerFailure' && stickerFixture) { stickerReadFailure = body.payload?.read === true; stickerSendUnknown = body.payload?.send === true; json(res, { ok: true }); return; }
      if (body.command === 'seedAssets') { json(res, channel.library.import(accountId, { name: '界面测试表情.zip', data: assetZip.toString('base64'), kind: 'sticker' })); return; }
      if (body.command === 'seedWork') {
        const timestamp = Date.now();
        for (const [id, jobState] of [['aaaaaaaaaaaa', 'succeeded'], ['bbbbbbbbbbbb', 'queued']]) {
          const folder = `work/${id}`, cwd = path.join(store.storageSettings().workspacePath, folder);
          fs.mkdirSync(cwd, { recursive: true }); fs.writeFileSync(path.join(cwd, 'hello.py'), 'print(123)');
          channel.work.store.add({ id, accountId, chatType: 'group', peerId: 'group_alpha@chatroom', senderId: 'wxid_alice', senderName: 'Alice',
            request: '合成任务：写一个 Python 示例', folder, workspaceRoot: store.storageSettings().workspacePath, sessionId: 'ui-work-session', state: jobState,
            delivery: { state: jobState === 'succeeded' ? 'unknown' : 'not-ready', reason: jobState === 'succeeded' ? '合成回传未获得服务端确认' : '', ...(jobState === 'succeeded' ? { artifacts: [{ path: 'report.pdf', name: 'report.pdf', kind: 'file', bytes: 100, mediaType: 'application/pdf', sha256: 'a'.repeat(64), state: 'sent', serverMessageId: '9007199254740997' }, { path: 'picture.png', name: 'picture.png', kind: 'image', bytes: 200, mediaType: 'image/png', sha256: 'b'.repeat(64), state: 'unknown' }, { path: 'data.xlsx', name: 'data.xlsx', kind: 'file', bytes: 300, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'c'.repeat(64), state: 'not-sent' }] } : {}) },
            operations: jobState === 'succeeded' ? [{ tool: 'wechat_work_exec', command: 'python hello.py', result: { ok: true, exitCode: 0, stdout: '123', sandbox: { mode: 'workspace-write', enforcement: 'partial' } } },
              { tool: 'wechat_work_ssh_exec', alias: 'scut2', command: 'cat results/metrics.json', result: { ok: true, stage: 'ssh-executed', exitCode: 0, stdout: '八卡实验 reward=1.25', stdoutTruncated: true } },
              { tool: 'wechat_work_status', result: { ok: true, action: 'tasks', text: '实际 DSH 状态：合成任务正在执行' } },
              { tool: 'wechat_work_vscode_connect', alias: 'scut2', result: { ok: true, stage: 'vscode-requested', exitCode: 0, connectedConfirmed: false, message: '合成结果：VS Code 已收到连接请求。',
                steps: [{ name: 'SSH 认证与远端探测', ok: true, exitCode: 0 }, { name: '检查 Remote - SSH 扩展', ok: true, exitCode: 0 }, { name: '提交 VS Code 远程连接请求', ok: true, exitCode: 0 }] } }] : [],
            ...(jobState === 'succeeded' ? { result: { text: '合成任务已生成 hello.py', files: [{ path: 'hello.py', bytes: 10 }], artifacts: [{ path: 'report.pdf', name: 'report.pdf', kind: 'file', bytes: 100, mediaType: 'application/pdf', sha256: 'a'.repeat(64) }, { path: 'picture.png', name: 'picture.png', kind: 'image', bytes: 200, mediaType: 'image/png', sha256: 'b'.repeat(64) }, { path: 'data.xlsx', name: 'data.xlsx', kind: 'file', bytes: 300, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'c'.repeat(64) }] } } : {}), createdAt: timestamp, updatedAt: timestamp });
          if (jobState === 'succeeded') {
            fs.writeFileSync(path.join(cwd, 'picture.png'), fixturePng([120, 80, 200]));
            const image = readWorkArtifact(cwd, 'picture.png').metadata;
            const archives = archiveWorkImages(channel.work.store.get(id), cwd, [image]);
            channel.work.store.update(id, { imageArchives: [...archives, { ...image, sourcePath: 'unsaved.png',
              path: `微信agent/generated-images/${id}/unsaved.png`, state: 'failed',
              error: { code: 'WORK_IMAGE_ARCHIVE_FAILED', message: '测试图片保存失败，原任务文件保留' } }] });
          }
        }
        json(res, channel.work.list({ accountId })); return;
      }
      if (body.command === 'globalMemory') { json(res, channel.longMemory.view(state.account.id)); return; }
      if (body.command === 'roleCard') { json(res, store.roleCards.view({ ...body.payload, accountId: state.account.id })); return; }
      if (body.command === 'roleCardSettings') { json(res, store.roleCardSettingsView()); return; }
      if (body.command === 'roleCardsOffline' && process.env.WECHAT_UI_TEST_ROLE_CARDS_ONLY === '1') {
        state = { ...state, account: null, online: false, state: 'offline' }; json(res, { ok: true }); return;
      }
      if (body.command === 'seedPersonCards') {
        const settings = store.settings(accountId);
        store.configure(accountId, { ...settings, privatePeers: [...new Set([...settings.privatePeers, 'wxid_role_alice', 'wxid_role_group_only'])] });
        const group = { accountId, chatType: 'group', peerId: 'group_alpha@chatroom' };
        const add = (scope, id, name, text, key) => channel.memory.append(scope, {
          key, messageId: key, direction: 'incoming', senderId: id, senderName: name, text, time: Date.now(),
        });
        add(group, 'wxid_role_alice', 'Alice 角色测试', '叫我 Alice，我喜欢红茶。', 'ui-role-group-alice');
        add({ accountId, chatType: 'private', peerId: 'wxid_role_alice' }, 'wxid_role_alice', 'Alice 角色测试', '我喜欢红茶。', 'ui-role-private-alice');
        add(group, 'wxid_role_group_only', '小禾 仅群聊', '叫我小禾，我喜欢骑行。', 'ui-role-group-only');
        runner.extractRoleCard = async input => {
          const data = JSON.parse(input.text), isAlice = data.person.personId === 'wxid_role_alice',
            source = data.sources.find(row => row.text.includes(isAlice ? '叫我 Alice' : '叫我小禾'));
          if (!source) return { text: '{"updates":[],"conflicts":[]}' };
          return { text: JSON.stringify({ updates: [
            { field: 'addressAs', value: isAlice ? 'Alice' : '小禾', evidence: [{ sourceId: source.id, quote: source.text }] },
            { field: 'preferences', value: isAlice ? '喜欢红茶' : '喜欢骑行', evidence: [{ sourceId: source.id, quote: source.text }] },
          ], conflicts: [] }) };
        };
        for (const personId of ['wxid_role_alice', 'wxid_role_group_only'])
          await channel.personMemory.update({ accountId, personId });
        json(res, { people: store.roleCards.list(accountId).map(row => row.personId) }); return;
      }
      if (body.command === 'seedRoleCardGallery' && process.env.WECHAT_UI_TEST_ROLE_CARDS_ONLY === '1') {
        const rows = [
          ['wxid_gallery_books', '林间', '阿林', '读书群里认识的朋友', '喜欢散文和旧书，周末常去逛书店。'],
          ['wxid_gallery_photo', '林间', '小林', '一起讨论摄影的朋友', '喜欢胶片摄影，偏爱安静的街道与自然光。'],
          ['wxid_gallery_long', '周末还在写代码的朋友', '周末', '一起做项目的同事', '喜欢把复杂的问题拆开讨论，先讲结论，再慢慢补充细节。'.repeat(12)],
          ['wxid_gallery_riley', 'Riley', 'Riley', '', ''],
        ];
        const settings = store.settings(accountId);
        store.configure(accountId, { ...settings, privatePeers: [...new Set([...settings.privatePeers, ...rows.map(row => row[0]),
          'wxid_gallery_empty', 'wxid_gallery_name_only'])] });
        for (const [personId, name, addressAs, relationship, preferences] of rows) {
          const scope = { accountId, personId };
          channel.memory.append({ accountId, chatType: 'group', peerId: 'group_alpha@chatroom' }, {
            key: 'gallery-' + personId, messageId: 'gallery-' + personId, direction: 'incoming', senderId: personId,
            senderName: name, text: '叫我' + addressAs + '。' + preferences, time: Date.now(),
          });
          if (addressAs) {
            const view = store.roleCards.view(scope);
            store.roleCards.save(scope, { ...view.card, addressAs, relationship, preferences }, view.revision);
          }
        }
        for (const personId of ['wxid_gallery_empty', 'wxid_gallery_name_only']) {
          channel.memory.append({ accountId, chatType: 'group', peerId: 'group_alpha@chatroom' }, {
            key: 'gallery-' + personId, messageId: 'gallery-' + personId, direction: 'incoming', senderId: personId,
            senderName: '暂无资料', text: '大家好。', time: Date.now(),
          });
          if (personId.endsWith('name_only')) {
            const view = store.roleCards.view({ accountId, personId });
            store.roleCards.save(view.scope, { ...view.card, label: '只有名称' }, view.revision);
          }
        }
        fixtureAudience.contacts = [
          { id: 'wxid_role_alice', labelIds: ['1'] }, { id: 'wxid_gallery_books', labelIds: ['1'] },
          { id: 'wxid_gallery_photo', labelIds: ['2'] }, { id: 'wxid_gallery_long', labelIds: ['1', '2'] },
          { id: 'wxid_gallery_riley', labelIds: [] }, { id: 'wxid_gallery_empty', labelIds: ['1'] },
        ];
        fixtureAudience.labels = [
          { id: '1', name: '计实一班', userIds: ['wxid_role_alice', 'wxid_gallery_books', 'wxid_gallery_long', 'wxid_gallery_empty'], memberCount: 4 },
          { id: '2', name: '摄影朋友', userIds: ['wxid_gallery_photo', 'wxid_gallery_long'], memberCount: 2 },
          { id: '3', name: '空标签', userIds: [], memberCount: 0 },
        ];
        json(res, { people: store.roleCards.list(accountId).length }); return;
      }
      if (body.command === 'imageMemory') { json(res, channel.imageMemory.list({ accountId: state.account.id, chatType: body.payload?.chatType || 'group', peerId: body.payload?.peerId || 'group_alpha@chatroom', collection: body.payload?.collection })); return; }
      if (generatedImagesFixture && body.command === 'seedQuotedRecords') {
        const scope = { accountId, chatType: 'group', peerId: 'group_alpha@chatroom', senderId: 'wxid_alice' },
          received = channel.imageMemory.list(scope).items[0],
          generated = channel.imageMemory.list({ ...scope, collection: 'generated' }).items.find(image => image.generation.deliveryState === 'sent');
        const refs = [
          { id: '9007199254740999', messageType: 1, senderId: 'wxid_bob', senderName: 'Bob', content: '明天 14:30 在 A203 讨论设计。' },
          { id: received.messageId, messageType: 3, senderId: received.senderId, senderName: received.senderName },
          { id: generated.generation.serverMessageIds[0], messageType: 3, senderId: accountId, senderName: '小胖' },
        ];
        const keys = [];
        for (const [index, data] of refs.entries()) {
          const id = 'ui-quoted-' + index, key = identity([accountId, scope.chatType, scope.peerId, id]), now = Date.now(),
            message = { id, serverMessageId: id, chatType: scope.chatType, peerId: scope.peerId, direction: 'incoming', time: now,
              sender: { id: 'wxid_alice', nickname: 'Alice' }, message: [{ type: 'text', data: { text: '引用记录预览 ' + index } }, { type: 'reply', data }] },
            record = { ...scope, key, messageId: id, contextKey: key, sender: 'Alice', question: '引用记录预览 ' + index,
              state: 'skipped', mode: 'default', reason: '隔离界面样本', createdAt: now, updatedAt: now };
          store.remember(key, now, record, { accountId, message });
          // Historical reference records remain readable; new messages no longer create or enrich them.
          const image = index === 1 ? received : index === 2 ? generated : null;
          store.update(record, { references: [{ ...data, messageId: data.id,
            ...(image ? { images: [{ id: image.id, collection: index === 1 ? 'conversation' : 'generated',
              description: index === 2 ? '已查看：这张生成图实际为蓝色方块。' : image.description, quality: image.quality }] } : {}) }] });
          keys.push(key);
        }
        channel.imageMemory.describe({ ...scope, collection: 'generated' }, generated.id, '已查看：这张生成图实际为蓝色方块。');
        json(res, { keys, receivedId: received.id, generatedId: generated.id }); return;
      }
      if (generatedImagesFixture && body.command === 'seedGeneratedImageMemory') {
        const samples = [], now = Date.now(), workspaceRoot = store.storageSettings().workspacePath;
        const sources = body.payload?.additional
          ? [['group', 'group_alpha@chatroom', 'EXTRA_GENERATED', true]]
          : [['group', 'group_alpha@chatroom', 'ALPHA_PORTRAIT', true], ['group', 'group_alpha@chatroom', 'ALPHA_DRAFT', false],
            ['group', 'group_beta@chatroom', 'BETA_GENERATED', true], ['private', 'wxid_alice', 'PRIVATE_GENERATED', true]];
        for (const [chatType, peerId, label, delivered] of sources) {
          const id = 'cccccc' + (++generatedImageSequence).toString(16).padStart(6, '0'),
            folder = `微信agent/work/${id}`, cwd = path.join(workspaceRoot, folder), name = label + '.png';
          fs.mkdirSync(cwd, { recursive: true }); fs.writeFileSync(path.join(cwd, name), fixturePng([36, 120, 220], 0, 640, 480));
          const artifact = readWorkArtifact(cwd, name).metadata,
            job = { id, accountId, chatType, peerId, senderId: 'wxid_alice', senderName: 'Alice', workspaceRoot, folder,
              request: '生成小胖自己的样貌，穿绿色毛衣。' + label, state: 'succeeded',
              createdAt: now - 3000, updatedAt: now - 1000, startedAt: now - 2000, finishedAt: now - 1000,
              operations: [{ tool: 'wechat_work_generate_image', at: now - 1500,
                result: { ok: true, artifacts: [artifact], providerName: '界面测试生图接口', model: 'fixture-image-v1' } }],
              result: { text: '合成图片已生成', artifacts: [artifact], files: [{ path: name, bytes: artifact.bytes }] },
              delivery: { state: delivered ? 'sent' : 'failed', acknowledgedMessageIds: delivered ? ['generated-fixture-ack-' + id] : [],
                artifacts: [{ ...artifact, state: delivered ? 'sent' : 'failed', ...(delivered ? { serverMessageId: 'generated-fixture-ack-' + id } : {}) }] } };
          job.imageArchives = archiveWorkImages(job, cwd, [artifact]); channel.work.store.add(job);
          samples.push({ scope: { accountId, chatType, peerId }, jobId: id, label });
        }
        json(res, samples); return;
      }
      if (generatedImagesFixture && body.command === 'generatedImageFiles') {
        json(res, channel.work.store.list({ accountId }).flatMap(job => (job.imageArchives ?? []).map(archive => ({
          jobId: job.id, originalExists: fs.existsSync(path.join(job.workspaceRoot, job.folder, archive.sourcePath)),
          archiveExists: fs.existsSync(path.join(job.workspaceRoot, archive.path)) })))); return;
      }
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
          const scope = { accountId, chatType, peerId }, factText = label + '：本会话的合成长事实。';
          channel.longMemory.capture(scope, [{ key: 'ui-long-source-' + label, text: factText, direction: 'incoming',
            senderId: 'wxid_alice', senderName: 'Alice', time: Date.now() }]);
          let added = false;
          for (let attempt = 0; attempt < 10 && !added; attempt++) {
            const result = await channel.longMemory.extract(scope, { run: async request => {
              const sources = JSON.parse(request.text.split('\n')[0]).sources;
              const reference = sources.find(source => source.direction === 'incoming' && source.text === factText);
              return { text: JSON.stringify({ facts: reference ? [{ text: factText, sources: [reference.id],
                evidence: [{ source: reference.id, quote: factText }], replaces: [] }] : [] }) };
            } }, new AbortController().signal);
            added = result.added === 1;
            if (!added && !result.processed) break;
          }
          if (!added) throw new Error('Synthetic long-memory source was not extracted: ' + label);
        }
        json(res, channel.longMemory.view(accountId)); return;
      }
      if (body.command === 'localMemory') { json(res, await service.call('memory.get', { accountId, chatType: 'group', peerId: body.payload?.peerId || 'group_alpha@chatroom' })); return; }
      if (body.command === 'manualCompressionSeed') {
        const scope = { accountId, chatType: 'group', peerId: 'group_alpha@chatroom' };
        for (let i = 0; i < 6; i++) channel.memory.append(scope, { key: `manual-compression-${i}`, text: '周五带咖啡讨论产品。' + '重复闲聊。'.repeat(30), direction: 'incoming', senderId: 'wxid_alice', time: Date.now() });
        json(res, channel.memory.view(scope)); return;
      }
      if (body.command === 'holdNext') {
        if (!['memory.edit', 'memory.compress', 'memory.role.get', 'model.info', ...(executionTraceFixture ? ['traces.export', 'traces.get'] : []), ...(authorizationFixture ? ['settings'] : []), ...(visualFixture ? ['status'] : []), ...(likesFixture ? ['moments.read', 'moments.write', 'moments.likes.run'] : []), ...(interactionsFixture ? ['moments.interactions.preview'] : [])].includes(body.payload?.endpoint) || heldRequests.has(body.payload.endpoint)) throw new Error('Only one isolated request per supported endpoint can be held');
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
        store.configure(state.account.id, authorizationFixture
          ? { enabled: false, privatePeers: ['wxid_alice'], groups: ['group_alpha@chatroom'], prompt: '另一个账号的回复要求。' }
          : { enabled: false, privatePeers: [], groups: [], prompt: '' }); json(res, { ok: true }); return;
      }
      throw new Error('Unsupported fixture command');
    }
    if (body.endpoint === 'storage.save') storageRequests.push(structuredClone(body.payload));
    if (authorizationFixture && body.endpoint === 'settings') settingsRequests.push(structuredClone(body.payload));
    if (likesFixture && ['moments.read', 'moments.write', 'moments.likes.configure', 'moments.likes.run', 'moments.likes.cancel'].includes(body.endpoint)) momentRpcRequests.push({ endpoint: body.endpoint, payload: structuredClone(body.payload) });
    if (interactionsFixture && body.endpoint.startsWith('moments.interactions.')) momentRpcRequests.push({ endpoint: body.endpoint, payload: structuredClone(body.payload) });
    if (body.endpoint === 'identity.save') identityRequests.push(structuredClone(body.payload));
    const modelInfoRequest = body.endpoint === 'model.info' ? { ...structuredClone(body.payload), completed: false } : null;
    if (modelInfoRequest) modelInfoRequests.push(modelInfoRequest);
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
    const result = await rpc(body.endpoint, body.payload, signal.signal, { principal: { kind: 'owner' } });
    if (modelInfoRequest) modelInfoRequest.completed = true;
    json(res, result);
  } catch (error) { json(res, { message: error.message }, 400); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const runId = randomBytes(16).toString('hex');
  const env = { ...process.env, WECHAT_UI_TEST_ORIGIN: origin, WECHAT_UI_TEST_RUN_ID: runId }; delete env.ELECTRON_RUN_AS_NODE;
  const driver = process.env.WECHAT_UI_TEST_TIME_ONLY === '1' ? 'test-time-settings-ui.cjs' : repliesFixture ? 'test-moments-replies-ui.cjs' : interactionsFixture ? 'test-moments-interactions-ui.cjs' : process.env.WECHAT_UI_TEST_VISUAL_SYSTEM === '1' ? 'test-visual-system.cjs' : 'test-ui-driver.cjs';
  const child = spawn(electron, [path.join(root, 'scripts', driver), 'ui-fixture', out], { cwd: root, windowsHide: true, stdio: 'inherit', env });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  if (exit !== 0) throw new Error(`UI verification failed (${exit}); see ${path.join(out, 'report.json')}`);
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')); } catch {}
  if (!report?.ok || report.runId !== runId || !report.assertions?.length || !report.screenshots?.length || report.errors?.length)
    throw new Error('UI driver did not produce a successful report for this run; check the Electron executable and report.json');
  fs.writeFileSync(path.join(out, 'fixture-summary.json'), JSON.stringify({ ok: true, root: fixture, version: VERSION, actualWeChatMessages: 0, actualModelRequests: 0 }, null, 2));
} finally {
  momentLikeReadGate?.resolve();
  interactionWriteGate?.resolve();
  for (const held of heldRequests.values()) held.release();
  repairGlobalMemory();
  await scheduler.close(); await channel.close(); await new Promise(resolve => server.close(resolve));
}
