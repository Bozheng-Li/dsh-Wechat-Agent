import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BridgeError, MAX_SEND_IMAGE_BYTES, object, validateParams, type Backend, type BackendStatus, type ActionName, type Params, type Result, type BridgeEvent, type BridgeMessage, type Contact, type Group, type Member } from '@napcat-wechat/protocol';
import { atomicJson, readJson, SessionStore, validateCredential, type Credential } from "./session.js";
import { bytes, commandFields, fields, fv, ld, num, signed, syncRequest, syncResponse, sendRequest, sendResponse, unstring, IMAGE_CHUNK_BYTES, imageUploadRequest, imageUploadResponse, imageDownloadRequest, imageDownloadResponse, MAX_DOWNLOAD_IMAGE_BYTES, type ImageUpload, type ImageDownload } from "./wire.js";
import { LonglinkTransport } from "./transport.js";
import { downloadImageChunk } from "./image-download.js";
import { imageMime, observedImage } from "./media.js";
import { quotedMessage } from "./reference.js";
import { FILE_CHUNK_BYTES, fileUploadRequest, fileUploadResponse, fileMessageRequest, fileMessageResponse, requestFileCgi, type FileUpload, type FileMessage } from './file-upload.js';
import { MomentsReader } from './moments.js';
import { MomentsWriter, validateSnsWrite } from './moments-write.js';
import { MomentsAudienceReader } from './moments-audience.js';
import { resolveMomentsAudience } from '../../../shared/moments-audience.mjs';

export interface ProtocolOptions {
  sessionFile: string; cacheDir: string; syncIntervalMs: number; heartbeatIntervalMs: number;
  requestTimeoutMs: number; reconnectMs: number; sendIntervalMs: number; sendJitterMs: number; segmentBytes: number;
}
type CachedGroup = Group & { memberCountKnown: false };
interface Cache { account: string; contacts: Contact[]; groups: CachedGroup[]; members: Member[]; messages: BridgeMessage[]; cursor: string }
type MentionTarget = { id: string; name: string };
type SendPart = { type: 'text'; text: string; mentions?: MentionTarget[] } | { type: 'image'; bytes: Buffer; mediaType: string; extension: 'png' | 'jpg'; sha256: string; name?: string } | { type: 'file'; bytes: Buffer; mediaType: string; sha256: string; name: string };
export class ProtocolBackend implements Backend {
  readonly mode = 'protocol' as const;
  readonly session: SessionStore;
  private events = new EventEmitter();
  private transport?: LonglinkTransport;
  private controller?: AbortController;
  private worker?: Promise<void>;
  private online = false;
  private state = 'session-missing';
  private lastError?: string;
  private lastSyncAt?: number;
  private lastHeartbeatAt?: number;
  private activeHost?: string;
  private activePort?: number;
  private reconnects = 0;
  private tx = 0; private rx = 0; private sent = 0; private received = 0;
  private cache!: Cache;
  private messages = new Map<string, BridgeMessage>();
  private sendTail: Promise<unknown> = Promise.resolve();
  private sendPending = 0;
  private queuedMediaBytes = 0;
  private nextSendAt = 0;
  private importing = false;
  private syncRequested = false;
  private imageChunk = downloadImageChunk;
  private fileRequest = requestFileCgi;
  private momentsReader = new MomentsReader(() => this.session.value, () => {
    if (!this.status().online) throw new BridgeError('ERR_MOMENTS_OFFLINE', '微信尚未连接，暂时不能读取朋友圈');
  });
  private momentsWriter = new MomentsWriter();
  private momentsAudienceReader = new MomentsAudienceReader();
  constructor(readonly options: ProtocolOptions) { this.session = new SessionStore(options.sessionFile); this.loadCache(); }
  private accountKey(c: Credential) { return `${c.uin}-${c.wxid}`; }
  private cacheFile() { return path.join(this.options.cacheDir, `${this.session.value!.uin}.json`); }
  private loadCache() {
    const c = this.session.value;
    this.cache = { account: c ? this.accountKey(c) : '', contacts: [], groups: [], members: [], messages: [], cursor: c?.sync_key ?? '' };
    this.messages.clear();
    if (c && existsSync(this.cacheFile())) {
      const saved = readJson(this.cacheFile()) as Cache;
      if (saved.account !== this.accountKey(c)) throw new BridgeError('ERR_CACHE_ACCOUNT', 'Protocol cache belongs to another account');
      if (![saved.contacts, saved.groups, saved.members, saved.messages].every(Array.isArray)) throw new BridgeError('ERR_CACHE_FORMAT', 'Invalid protocol cache');
      this.cache = saved;
      if (saved.cursor) { fields(Buffer.from(saved.cursor, 'hex')); c.sync_key = saved.cursor; }
      for (const m of saved.messages) this.messages.set(m.id, m);
    }
  }
  private persist() {
    if (!this.session.value) return;
    this.cache.messages = [...this.messages.values()].slice(-5000);
    atomicJson(this.cacheFile(), this.cache);
  }
  private emit(event: BridgeEvent) {
    // The sync cursor is already committed before publication. One consumer's
    // failure must not prevent other consumers or later batch messages running.
    const errors: unknown[] = [];
    for (const listener of this.events.rawListeners('event')) {
      try { listener.call(this.events, event); }
      catch (error) { errors.push(error); }
    }
    // A failing log consumer must not recursively generate more log events.
    if (event.type !== 'event.log') for (const error of errors) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log('error', `事件处理失败（${event.type}${event.type === 'event.message' ? ' · ' + event.payload.id : ''}）：${detail}`);
    }
  }
  private log(level: string, message: string) { this.emit({ type: 'event.log', payload: { level, message, time: Date.now() } }); }
  private setState(state: string, online = false) {
    const changed = this.online !== online; this.online = online; this.state = state;
    if (changed) this.emit({ type: 'event.meta', payload: { state: online ? 'connected' : 'disconnected', mode: this.mode } });
    this.emit({ type: 'event.runtime', payload: { state, online } });
  }
  status(): BackendStatus {
    const transport = this.transport;
    return { mode: this.mode, online: this.online && !!transport?.connected, good: this.online && !!transport?.connected && !this.lastError, hookCount: 0,
      diagnostics: { state: this.state, account: this.session.publicStatus().account, credentials: this.session.publicStatus(), lastError: this.lastError,
        connection: { host: this.activeHost, port: this.activePort, connected: !!transport?.connected, latencyMs: transport?.latencyMs ?? null, connectedAt: transport?.connectedAt, txFrames: this.tx + (transport?.tx ?? 0), rxFrames: this.rx + (transport?.rx ?? 0), reconnects: this.reconnects },
        sync: { lastSyncAt: this.lastSyncAt, lastHeartbeatAt: this.lastHeartbeatAt, intervalMs: this.options.syncIntervalMs },
        cache: { contacts: this.cache.contacts.length, groups: this.cache.groups.length, members: this.cache.members.length, messages: this.messages.size, scope: 'protocol-observed-only' },
        sent: this.sent, received: this.received, sendQueue: this.sendPending, independent: true, loginSupported: true } };
  }
  async start() {
    if (this.worker) return;
    if (!this.session.value) { this.lastError = this.session.error; this.setState(this.session.error ? 'credential-error' : 'session-missing'); return; }
    this.controller = new AbortController(); const signal = this.controller.signal;
    this.worker = this.run(signal).catch(error => { if (!signal.aborted) { this.lastError = error instanceof Error ? error.message : String(error); this.setState('error'); this.log('error', this.lastError); } }).finally(() => { this.worker = undefined; });
  }
  private retireTransport() {
    this.momentsReader.clear();
    if (!this.transport) return;
    this.tx += this.transport.tx; this.rx += this.transport.rx;
    this.transport.close(); this.transport = undefined;
  }
  private async run(signal: AbortSignal) {
    let attempts = 0;
    while (!signal.aborted) {
      const c = this.session.value!;
      const endpoints = [...new Map([{ host: c.host, port: c.port }, ...c.edges, { host: 'long.weixin.qq.com', port: c.port }]
        .map(endpoint => [`${endpoint.host}:${endpoint.port}`, endpoint])).values()];
      const endpoint = endpoints[attempts % endpoints.length], host = endpoint.host; this.activeHost = host; this.activePort = endpoint.port;
      this.setState('connecting');
      const t = new LonglinkTransport(c, this.options.requestTimeoutMs, () => { this.syncRequested = true; }); this.transport = t;
      try {
        await t.connect(host, endpoint.port);
        if (signal.aborted) return;
        await this.sync(t);
        c.host = host; c.port = endpoint.port; this.session.save(c);
        if (attempts) this.log('info', 'Protocol connection recovered'); attempts = 0;
        let nextSync = Date.now() + this.options.syncIntervalMs;
        let nextHeartbeat = Date.now() + this.options.heartbeatIntervalMs;
        while (!signal.aborted && t.connected) {
          if (this.syncRequested || Date.now() >= nextSync) {
            this.syncRequested = false; await this.sync(t); nextSync = Date.now() + this.options.syncIntervalMs;
          }
          if (c.heartbeat_base_request && Date.now() >= nextHeartbeat) {
            const body = Buffer.concat([ld(1, Buffer.from(c.heartbeat_base_request, 'hex')), fv(2, Math.floor(Date.now() / 1000)), ld(3, Buffer.from(c.sync_key, 'hex'))]);
            const response = fields(await t.request(518, body));
            const ret = signed(num(fields(bytes(response, 1)), 1));
            if (ret !== 0) throw new BridgeError('ERR_HEARTBEAT', `Heartbeat rejected (ret=${ret ?? 'missing'})`);
            this.lastHeartbeatAt = Date.now(); nextHeartbeat = Date.now() + this.options.heartbeatIntervalMs;
          }
          await sleep(250, undefined, { signal });
        }
        if (!signal.aborted) throw new BridgeError('ERR_CONNECTION_CLOSED', 'Protocol edge closed the connection');
      } catch (error) {
        if (signal.aborted) return;
        this.lastError = error instanceof Error ? error.message : String(error); this.setState('reconnecting');
        this.log('warn', `${host}:${endpoint.port}: ${this.lastError}`); attempts++; this.reconnects++;
      } finally { this.retireTransport(); }
      try { await sleep(Math.min(this.options.reconnectMs * Math.max(1, Math.floor(attempts / endpoints.length) + 1), 60000), undefined, { signal }); }
      catch { return; }
    }
  }
  private async sync(t: LonglinkTransport) {
    const c = this.session.value!;
    const result = syncResponse(await t.request(138, syncRequest(c.sync_key)));
    const published: BridgeMessage[] = [];
    // Decode the whole batch first: a malformed supported command must not advance the cursor.
    const decoded = result.commands.map(cmd => ({ id: cmd.id, fs: cmd.id === 5 || cmd.id === 2 ? commandFields(cmd.payload, cmd.id === 5 ? 'message' : 'contact') : [] }));
    const previousCache = result.commands.length ? structuredClone(this.cache) : this.cache;
    const previousMessages = result.commands.length ? new Map(this.messages) : this.messages;
    const previousCursor = c.sync_key, previousReceived = this.received;
    try {
      for (const cmd of decoded) {
        if (cmd.id === 2) this.updateContact(cmd.fs);
        else if (cmd.id === 5) {
          const message = this.decodeMessage(cmd.fs);
          if (message && !this.messages.has(message.id)) {
            this.remember(message); published.push(message);
            if (message.direction === 'incoming') this.received++;
          }
        }
      }
      if (result.key) { this.cache.cursor = result.key; c.sync_key = result.key; }
      // Cache and cursor are one atomic record; session.json mirrors it for portability.
      if (result.commands.length || c.sync_key !== previousCursor) this.persist();
    } catch (error) {
      this.cache = previousCache; this.messages = previousMessages; c.sync_key = previousCursor; this.cache.cursor = previousCursor; this.received = previousReceived;
      throw error;
    }
    let mirrorError: unknown;
    try { if (c.sync_key !== previousCursor) this.session.save(c); } catch (error) { mirrorError = error; }
    this.lastSyncAt = Date.now(); this.syncRequested = result.more;
    if (!this.online) { this.lastError = undefined; this.setState('online', true); }
    for (const message of published) this.emit({ type: 'event.message', payload: structuredClone(message) });
    if (mirrorError) throw mirrorError;
  }
  private updateContact(fs: ReturnType<typeof fields>) {
    const id = unstring(bytes(fs, 1)); if (!/^[\w@.:-]{1,256}$/.test(id)) throw new BridgeError('ERR_PROTOCOL', 'Invalid ModContact identity');
    const nickname = unstring(bytes(fs, 2)) || id;
    if (id.endsWith('@chatroom')) {
      const group: CachedGroup = { id, name: nickname, memberCount: 0, memberCountKnown: false };
      this.cache.groups = [...this.cache.groups.filter(g => g.id !== id), group];
    } else {
      const previous = this.cache.contacts.find(c => c.id === id);
      // Only fields evidenced in mod_contact_cmd.json are promoted to metadata.
      const contact: Contact = { ...previous, id, nickname, remark: unstring(bytes(fs, 10)) };
      this.cache.contacts = [...this.cache.contacts.filter(c => c.id !== id), contact];
      this.cache.members = this.cache.members.map(member => member.id === id ? { ...member, ...contact } : member);
      if (id === this.session.value?.wxid && nickname !== id) this.session.value.nickname = nickname;
    }
  }
  private decodeMessage(fs: ReturnType<typeof fields>): BridgeMessage | undefined {
    const self = this.session.value!, from = unstring(bytes(fs, 2)), to = unstring(bytes(fs, 3));
    const type = Number(num(fs, 4));
    if (!/^[\w@.:-]{1,256}$/.test(from) || !/^[\w@.:-]{1,256}$/.test(to) || !Number.isInteger(type)) throw new BridgeError('ERR_PROTOCOL', 'Invalid AddMsg fields');
    const outgoing = from === self.wxid;
    if (!outgoing && to !== self.wxid && !from.endsWith('@chatroom')) return;
    const peer = outgoing ? to : from, group = peer.endsWith('@chatroom');
    let content = unstring(bytes(fs, 5)), sender = outgoing ? self.wxid : from;
    if (group && !outgoing) {
      const match = /^([\w@.:-]+):\n/.exec(content);
      if (match) { sender = match[1]; content = content.slice(match[0].length); }
    }
    const id = (num(fs, 12) || num(fs, 1))?.toString();
    if (!id || id === '0') throw new BridgeError('ERR_PROTOCOL', 'AddMsg has no message ID');
    const contact = sender === self.wxid ? { id: self.wxid, nickname: self.nickname } : this.cache.contacts.find(c => c.id === sender) ?? { id: sender, nickname: sender };
    const quoted = type === 49 ? quotedMessage(content, peer) : undefined;
    const mentions: BridgeMessage['message'] = [];
    if (group && (type === 1 || type === 3 || type === 47 || quoted)) {
      const source = unstring(bytes(fs, 10));
      const list = /<atuserlist>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/atuserlist>/.exec(source)?.[1];
      for (const at of list?.split(',') ?? []) if (/^[\w@.:-]+$/.test(at.trim())) mentions.push({ type: 'at', data: { qq: at.trim() } });
      if (!this.cache.groups.some(g => g.id === peer)) this.cache.groups.push({ id: peer, name: peer, memberCount: 0, memberCountKnown: false });
      if (sender !== peer) {
        const member = this.cache.members.find(m => m.groupId === peer && m.id === sender);
        if (!member) this.cache.members.push({ ...contact, groupId: peer, role: 'member', roleKnown: false });
        else if (contact.nickname !== sender) Object.assign(member, contact);
      }
    } else if (!group && !outgoing && !this.cache.contacts.some(c => c.id === sender)) this.cache.contacts.push(contact);
    const labels: Record<number, string> = { 3: '[图片]', 34: '[语音]', 43: '[视频]', 47: '[表情]', 49: '[链接或文件]', 10000: '[系统消息]' };
    return { id: `wx:${peer}:${id}`, serverMessageId: id, time: Number(num(fs, 9) ?? 0n), chatType: group ? 'group' : 'private', peerId: peer, sender: contact,
      message: [...mentions, ...(quoted ?? (type === 3 || type === 47 ? [observedImage(fs, content, path.join(this.options.cacheDir, 'media', String(self.uin)), `${peer}:${id}`)] : [{ type: 'text' as const, data: { text: type === 1 ? content : labels[type] ?? `[消息类型 ${type}]` } }]))], messageType: type,
      direction: outgoing ? 'outgoing' : 'incoming', source: 'longlink:NewSync', delivery: 'observed', observedAt: Date.now(), partial: type !== 1 && type !== 3 && type !== 47 && !quoted };
  }
  private remember(m: BridgeMessage) { this.messages.set(m.id, m); while (this.messages.size > 5000) this.messages.delete(this.messages.keys().next().value!); }
  recentMessages(peerId?: string, limit = 100) { return structuredClone([...this.messages.values()].filter(m => !peerId || m.peerId === peerId).slice(-limit)); }
  async downloadImage(input: { peerId: string; messageId: string; originalBytes?: number; fullBytes?: number }, signal: AbortSignal) {
    const account = this.session.value, transport = this.transport;
    const message = this.messages.get(`wx:${input.peerId}:${input.messageId}`);
    if (!account || !transport?.connected || !this.online) throw new BridgeError('ERR_BACKEND_OFFLINE', '微信尚未连接，暂时不能下载高清图片');
    if (!message || message.peerId !== input.peerId || message.serverMessageId !== input.messageId || message.direction !== 'incoming' || message.messageType !== 3)
      throw new BridgeError('ERR_IMAGE_OWNER', '只能下载当前账号已收到的这条图片消息');
    const imageBase = account.image_base_request ?? account.heartbeat_base_request;
    if (!imageBase) throw new BridgeError('ERR_IMAGE_CREDENTIAL', '当前会话的图片下载参数未完整交接，请更新插件后重试');
    const assertCurrent = () => {
      signal.throwIfAborted();
      const current = this.session.value;
      if (!current || ['uin', 'wxid', 'token', 'body_key', 's08'].some(key => current[key as keyof Credential] !== account[key as keyof Credential]) ||
          this.transport !== transport || !transport.connected || !this.online)
        throw new BridgeError('ERR_IMAGE_ACCOUNT_CHANGED', '下载期间微信连接或账号已变化，未返回旧账号图片');
    };
    let lastError: unknown;
    const variants: (0 | 1)[] = !input.originalBytes && input.fullBytes ? [0] : [1, 0];
    for (const compressType of variants) {
      assertCurrent();
      const announced = compressType === 1 ? input.originalBytes : input.fullBytes;
      if (announced && announced > MAX_DOWNLOAD_IMAGE_BYTES) { lastError = new BridgeError('ERR_IMAGE_TOO_LARGE', '高清图片超过 10 MiB'); continue; }
      const image: ImageDownload = { messageId: input.messageId, from: input.peerId, to: account.wxid,
        total: Number.isSafeInteger(announced) && announced! > 0 ? announced! : 0,
        baseRequest: Buffer.from(imageBase, 'hex'), compressType };
      const chunks: Buffer[] = []; let start = 0;
      try {
        do {
          assertCurrent();
          const result = imageDownloadResponse(await this.imageChunk(account, imageDownloadRequest(image, start), signal), image, start);
          assertCurrent();
          image.total = result.total; chunks.push(result.content); start += result.content.length;
        } while (start < image.total);
        const content = Buffer.concat(chunks);
        imageMime(content);
        return { content, quality: compressType === 1 ? 'original' as const : 'full' as const };
      } catch (error) {
        assertCurrent(); lastError = error;
        // A rejected original may have a regular full image. A malformed or
        // interrupted response is never silently accepted as a different image.
        if (!(error instanceof BridgeError) || !['ERR_IMAGE_DOWNLOAD_REJECTED', 'ERR_IMAGE_TOO_LARGE'].includes(error.code)) throw error;
      }
    }
    throw lastError || new BridgeError('ERR_IMAGE_DOWNLOAD', '未取得高清图片');
  }
  assertReady(_action: ActionName) { if (!this.status().online) throw new BridgeError('ERR_BACKEND_OFFLINE', this.lastError ?? 'Import valid session credentials and wait for a successful NewSync'); }
  async readMoments(query: unknown, scopeKey: string, signal: AbortSignal) {
    const transport = this.transport;
    const result = await this.momentsReader.read(query, scopeKey, AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]));
    if (!transport?.connected || this.transport !== transport || !this.status().online)
      throw new BridgeError('ERR_MOMENTS_ACCOUNT_CHANGED', '读取期间微信连接已变化，未返回旧连接朋友圈');
    return result;
  }
  async readMomentsAudience(signal: AbortSignal) {
    const account = this.session.value, transport = this.transport;
    const identity = account && ['uin', 'wxid', 'token', 'body_key', 's08'].map(key => (account as any)[key]);
    const check = () => {
      signal.throwIfAborted();
      if (!account || identity!.some((value, index) => (this.session.value as any)?.[['uin', 'wxid', 'token', 'body_key', 's08'][index]] !== value) ||
          !transport?.connected || this.transport !== transport || !this.status().online)
        throw new BridgeError('ERR_MOMENTS_ACCOUNT_CHANGED', '读取标签与联系人期间微信账号或连接变化，未使用旧账号名单', { delivery: 'not-sent' });
    };
    check();
    const reader = new MomentsAudienceReader((account, cmd, route, makeBody, requestSignal) => this.momentsAudienceReader.request(account, cmd, route, makeBody,
      AbortSignal.any([requestSignal, AbortSignal.timeout(this.options.requestTimeoutMs)])));
    return reader.read(account!, signal, check);
  }
  async writeMoments(raw: unknown, clientId: string, signal: AbortSignal) {
    let query = validateSnsWrite(raw), audience;
    const account = this.session.value, transport = this.transport;
    const credentialKeys = ['uin', 'wxid', 'token', 'body_key', 's08'], identity = credentialKeys.map(key => (account as any)?.[key]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!account || credentialKeys.some((key, index) => (this.session.value as any)?.[key] !== identity[index]) ||
          !transport?.connected || this.transport !== transport || !this.status().online)
        throw new BridgeError('ERR_MOMENTS_ACCOUNT_CHANGED', '朋友圈操作期间账号或连接变化，已停止后续操作，请核对已提交的结果');
    };
    assertCurrent();
    if (query.action === 'publish' && (query.blockedUserIds?.length || query.blockedLabelIds?.length)) {
      try {
        const snapshot = await this.readMomentsAudience(signal); assertCurrent();
        const resolved = resolveMomentsAudience(snapshot, query);
        audience = { audienceSelection: resolved.selection, audienceSource: snapshot.source, audienceFetchedAt: snapshot.fetchedAt,
          blockedLabelIds: resolved.selection.blockedLabelIds };
        const { blockedLabelIds, ...remaining } = query;
        query = { ...remaining, blockedUserIds: resolved.blockedUserIds };
      } catch (error) {
        throw new BridgeError('ERR_MOMENTS_AUDIENCE', (error as Error).message, { delivery: 'not-sent' });
      }
    }
    // Each media chunk has its own network timeout; the IPC caller controls the
    // overall lifetime. A long upload must not be cancelled after ten seconds.
    const writer = new MomentsWriter((account, cmd, route, makeBody, requestSignal) => this.momentsWriter.request(account, cmd, route, makeBody,
      AbortSignal.any([requestSignal, AbortSignal.timeout(this.options.requestTimeoutMs)])));
    const result = await writer.write(account!, query, clientId, signal, assertCurrent);
    return { ...result, ...(audience ?? {}) };
  }
  async call<A extends ActionName>(action: A, raw: Params<A>): Promise<Result<A>> {
    const p = validateParams(action, raw); let result: unknown;
    switch (action) {
      case 'action.get_login_info': { const c = this.session.value; this.assertReady(action); result = { id: c!.wxid, nickname: c!.nickname }; break; }
      // Older caches may contain group IDs added while decoding system/non-text messages.
      // Keep their history intact, but never expose a group as a private conversation.
      case 'action.get_friend_list': result = this.cache.contacts.filter(c => !c.id.endsWith('@chatroom')); break;
      case 'action.get_group_list': result = this.cache.groups; break;
      case 'action.get_group_member_list': {
        if (!this.session.value || this.cache.account !== this.accountKey(this.session.value)) throw new BridgeError('ERR_CACHE_ACCOUNT', '群成员名单与当前微信账号不匹配');
        result = this.cache.members.filter(m => m.groupId === (p as Params<'action.get_group_member_list'>).groupId); break;
      }
      case 'action.get_msg': { result = this.messages.get((p as Params<'action.get_msg'>).id); if (!result) throw new BridgeError('ERR_NOT_FOUND', 'Message is not in the protocol cache'); break; }
      case 'action.send_msg': result = await this.enqueueSend(p as Params<'action.send_msg'>); break;
    }
    return structuredClone(result) as Result<A>;
  }
  sendMessage(p: Params<'action.send_msg'>, cancel?: AbortSignal): Promise<BridgeMessage> { return this.enqueueSend(validateParams('action.send_msg', p), cancel); }
  private mentionTargets(peerId: string, ids: string[]): MentionTarget[] {
    const account = this.session.value;
    if (!account || this.cache.account !== this.accountKey(account)) throw new BridgeError('ERR_MENTION_TARGET', '群成员名单与当前账号不匹配，整条回复尚未发送', { delivery: 'rejected' });
    const targets = [...new Set(ids)].map(id => {
      if (!/^[\w@.:-]{1,256}$/.test(id) || id.endsWith('@chatroom') || /^(?:all|@all|notify@all)$/i.test(id))
        throw new BridgeError('ERR_MENTION_TARGET', '请选择具体群成员，不支持 @所有人；整条回复尚未发送', { delivery: 'rejected' });
      const member = this.cache.members.find(member => member.groupId === peerId && member.id === id);
      if (!member) throw new BridgeError('ERR_MENTION_TARGET', '提醒对象已不在当前群的已同步成员名单中，整条回复尚未发送；请重新核对成员', { delivery: 'rejected' });
      const name = (member.card || member.nickname || member.remark || member.id).trim();
      if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name))
        throw new BridgeError('ERR_MENTION_TARGET', '提醒对象的群昵称无效，整条回复尚未发送；请重新核对成员', { delivery: 'rejected' });
      return { id, name };
    });
    if (targets.length > 20 || Buffer.byteLength(targets.map(target => '@' + target.name + '\u2005').join('')) > this.options.segmentBytes)
      throw new BridgeError('ERR_MENTION_LIMIT', '本次 @ 对象过多或昵称过长，请减少提醒对象；整条回复尚未发送', { delivery: 'rejected' });
    return targets;
  }
  private enqueueSend(p: Params<'action.send_msg'>, cancel?: AbortSignal): Promise<BridgeMessage> {
    this.assertReady('action.send_msg');
    if (!/^[\w@.:-]{1,256}$/.test(p.peerId) || p.peerId.endsWith('@chatroom') !== (p.chatType === 'group')) throw new BridgeError('ERR_INVALID_PARAMS', 'Destination does not match chat type');
    if (this.sendPending >= 128) throw new BridgeError('ERR_SEND_QUEUE_FULL', 'Send queue is full');
    const mentionIds = p.message.flatMap(segment => segment.type === 'at' ? [segment.data.qq] : []);
    if (mentionIds.length && p.chatType !== 'group') throw new BridgeError('ERR_MENTION_TARGET', '真正 @ 只支持群聊，私聊消息尚未发送', { delivery: 'rejected' });
    if (mentionIds.length) this.mentionTargets(p.peerId, mentionIds);
    // Validate the whole reply before sending its first text segment. Media
    // references are never resolved here: only trusted callers can supply bytes.
    const parts: SendPart[] = []; let text = '', mediaBytes = 0, mediaCount = 0;
    const flushText = () => {
      if (!text.trim()) { text = ''; return; }
      let chunk = '', size = 0;
      for (const char of text) {
        const n = Buffer.byteLength(char);
        if (chunk && size + n > this.options.segmentBytes) { parts.push({ type: 'text', text: chunk }); chunk = ''; size = 0; }
        chunk += char; size += n;
      }
      if (chunk) parts.push({ type: 'text', text: chunk });
      text = '';
    };
    for (const segment of p.message) {
      if (segment.type === 'at') continue;
      if (segment.type === 'text') { text += segment.data.text; continue; }
      if (segment.type === 'file') {
        flushText();
        const content = Buffer.from(segment.data.base64 || '', 'base64');
        if (!content.length || content.toString('base64') !== segment.data.base64)
          throw new BridgeError('ERR_INVALID_PARAMS', '文件内容无效，整条回复尚未发送', { delivery: 'rejected' });
        mediaBytes += content.length; mediaCount++;
        if (mediaCount > 8) throw new BridgeError('ERR_INVALID_PARAMS', '一次回复最多发送 8 个文件／图片', { delivery: 'rejected' });
        parts.push({ type: 'file', bytes: content, name: segment.data.name, mediaType: segment.data.mediaType || 'application/octet-stream', sha256: createHash('sha256').update(content).digest('hex') });
        continue;
      }
      if (segment.type !== 'image' && segment.type !== 'face') throw new BridgeError('ERR_UNSUPPORTED_ACTION', '当前发送支持文字、群成员 @、图片和文件附件', { delivery: 'rejected' });
      flushText();
      const encoded = segment.data.base64;
      if (!encoded) throw new BridgeError('ERR_INVALID_PARAMS', '发送图片需要素材库提供的图片内容，不能直接使用文件路径或网址', { delivery: 'rejected' });
      const content = Buffer.from(encoded, 'base64');
      if (!content.length || content.length > MAX_SEND_IMAGE_BYTES || content.toString('base64') !== encoded)
        throw new BridgeError('ERR_INVALID_PARAMS', '图片内容无效或超过 10 MiB，整条回复尚未发送', { delivery: 'rejected' });
      let mime: string;
      try { mime = imageMime(content); }
      catch { throw new BridgeError('ERR_IMAGE_FORMAT', '图片内容无法识别为有效图片，整条回复尚未发送', { delivery: 'rejected' }); }
      if (mime !== segment.data.mediaType) throw new BridgeError('ERR_INVALID_PARAMS', '图片实际格式与声明的类型不一致，整条回复尚未发送', { delivery: 'rejected' });
      if (mime !== 'image/png' && mime !== 'image/jpeg') throw new BridgeError('ERR_UNSUPPORTED_IMAGE', '当前微信发送支持 PNG/JPEG 静态图片；GIF/WebP 请先转成 PNG/JPEG，整条回复尚未发送', { delivery: 'rejected' });
      mediaBytes += content.length; mediaCount++;
      if (mediaCount > 8) throw new BridgeError('ERR_INVALID_PARAMS', '每次回复最多发送 8 个文件／图片', { delivery: 'rejected' });
      parts.push({ type: 'image', bytes: content, mediaType: mime, extension: mime === 'image/png' ? 'png' : 'jpg', sha256: createHash('sha256').update(content).digest('hex'), ...(segment.data.name ? { name: segment.data.name } : {}) });
    }
    flushText();
    // A native mention needs a text message even for an otherwise image-only
    // reply. The first text part alone owns its display prefix and atuserlist.
    if (mentionIds.length && parts[0]?.type !== 'text') parts.unshift({ type: 'text', text: '' });
    if (!parts.length) throw new BridgeError('ERR_INVALID_PARAMS', 'Message cannot be empty');
    const account = this.session.value!;
    const sendingAccount = this.accountKey(account);
    const imageBase = account.image_base_request ?? account.heartbeat_base_request;
    if (mediaCount && !imageBase) throw new BridgeError(parts.some(part => part.type === 'image') ? 'ERR_IMAGE_CREDENTIAL' : 'ERR_FILE_CREDENTIAL', '当前会话的媒体发送参数未完整交接，请更新插件后重试；整条回复尚未发送', { delivery: 'rejected' });
    const signal = cancel ? AbortSignal.any([this.controller!.signal, cancel]) : this.controller!.signal; this.sendPending++; this.queuedMediaBytes += mediaBytes;
    const task = this.sendTail.then(async () => {
      const ids: string[] = []; let first: BridgeMessage | undefined, currentIndex = -1, requestStarted = false;
      const deliveryParts = () => parts.map((part, index) => ({ index, type: part.type, state: index < ids.length ? 'acknowledged' : index === currentIndex && requestStarted ? 'unknown' : 'not-sent', ...(ids[index] ? { serverMessageId: ids[index] } : {}),
        ...(part.type !== 'text' && part.name ? { name: part.name, bytes: part.bytes.length, sha256: part.sha256 } : {}) }));
      try {
        for (let index = 0; index < parts.length; index++) {
          currentIndex = index; requestStarted = false;
          let part = parts[index];
          await sleep(Math.max(0, this.nextSendAt - Date.now()) + Math.floor(Math.random() * (this.options.sendJitterMs + 1)), undefined, { signal });
          if (signal.aborted) throw new BridgeError('ERR_STOPPED', 'Session stopped');
          this.assertReady('action.send_msg');
          if (!this.session.value || this.accountKey(this.session.value) !== sendingAccount)
            throw new BridgeError('ERR_MENTION_TARGET', '微信账号已变化，本次发送已停止；请核对已有回执', { delivery: 'rejected' });
          if (index === 0 && mentionIds.length && part.type === 'text') {
            // Recheck after queueing: no recipient can be silently dropped or
            // replaced, and the display name comes from this account's cache.
            const mentions = this.mentionTargets(p.peerId, mentionIds), prefix = mentions.map(target => '@' + target.name + '\u2005').join('');
            let length = 0, size = Buffer.byteLength(prefix);
            for (const char of part.text) { const bytes = Buffer.byteLength(char); if (size + bytes > this.options.segmentBytes) break; size += bytes; length += char.length; }
            const rest = part.text.slice(length);
            part = parts[index] = { type: 'text', text: prefix + part.text.slice(0, length), mentions };
            if (rest) parts.splice(index + 1, 0, { type: 'text', text: rest });
          }
          const t = this.transport!;
          this.nextSendAt = Date.now() + this.options.sendIntervalMs;
          let ack: { id: string; time: number };
          if (part.type === 'text') {
            const request = sendRequest(p.peerId, part.text, part.mentions?.map(target => target.id));
            requestStarted = true;
            ack = sendResponse(await t.request(522, request.body), request.f4, request.f5);
          } else if (part.type === 'file') {
            const upload: FileUpload = { clientId: `${account.wxid}_${Date.now()}_${randomBytes(8).toString('hex')}`, from: account.wxid, total: part.bytes.length, md5: createHash('md5').update(part.bytes).digest('hex'), baseRequest: Buffer.from(imageBase!, 'hex') };
            let mediaId: string | undefined;
            for (let start = 0; start < part.bytes.length; start += FILE_CHUNK_BYTES) {
              if (signal.aborted) throw new BridgeError('ERR_STOPPED', '文件上传已停止，尚未发送文件消息');
              this.assertReady('action.send_msg');
              if (!this.session.value || this.accountKey(this.session.value) !== sendingAccount || t !== this.transport || !t.connected)
                throw new BridgeError('ERR_CONNECTION_CLOSED', '文件上传期间账号或连接变化，未继续发送文件消息');
              const chunk = part.bytes.subarray(start, start + FILE_CHUNK_BYTES);
              const result = fileUploadResponse(await this.fileRequest(account, 220, fileUploadRequest(upload, start, chunk), AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)])), upload, start, chunk.length);
              if (result.complete) mediaId = result.mediaId;
            }
            if (!mediaId) throw new BridgeError('ERR_FILE_PROTOCOL', '文件上传缺少完整附件 ID，未发送文件消息');
            if (signal.aborted) throw new BridgeError('ERR_STOPPED', '文件已上传，但文件消息尚未发送');
            this.assertReady('action.send_msg');
            if (!this.session.value || this.accountKey(this.session.value) !== sendingAccount || t !== this.transport || !t.connected)
              throw new BridgeError('ERR_CONNECTION_CLOSED', '文件消息发送前账号或连接变化，未继续发送');
            const file: FileMessage = { ...upload, clientId: upload.clientId + '_msg', to: p.peerId, name: part.name, mediaId, time: Math.floor(Date.now() / 1000) };
            requestStarted = true;
            ack = fileMessageResponse(await this.fileRequest(account, 222, fileMessageRequest(file), AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)])), file);
          } else {
            const upload: ImageUpload = { clientId: `${account.wxid}_${Date.now()}_${randomBytes(8).toString('hex')}`, from: account.wxid, to: p.peerId, total: part.bytes.length, time: Math.floor(Date.now() / 1000), baseRequest: Buffer.from(imageBase!, 'hex'), extension: part.extension };
            let final: { id: string; time: number } | undefined;
            for (let start = 0; start < part.bytes.length; start += IMAGE_CHUNK_BYTES) {
              if (signal.aborted) throw new BridgeError('ERR_STOPPED', '图片上传已停止；已写出的分片不会自动重发');
              if (t !== this.transport || !t.connected) throw new BridgeError('ERR_CONNECTION_CLOSED', '图片上传期间连接已断开，发送结果未知');
              const chunk = part.bytes.subarray(start, start + IMAGE_CHUNK_BYTES);
              requestStarted = true;
              const result = imageUploadResponse(await t.request(110, imageUploadRequest(upload, start, chunk)), upload, start, chunk.length);
              // Do not discard a final server ACK if cancellation arrived while
              // the request was in flight. Stop before the next request instead.
              if (result.complete && result.id) final = { id: result.id, time: result.time };
            }
            if (!final) throw new BridgeError('ERR_PROTOCOL', '图片上传缺少最终确认，发送结果未知');
            ack = final;
          }
          ids.push(ack.id); this.sent++;
          const c = this.session.value!;
          // The durable cache stores only media metadata, never base64 payloads.
          const message: BridgeMessage = { id: `wx:${p.peerId}:${ack.id}`, serverMessageId: ack.id, time: ack.time, chatType: p.chatType, peerId: p.peerId, sender: { id: c.wxid, nickname: c.nickname }, message: part.type === 'text' ? [...(part.mentions || []).map(target => ({ type: 'at' as const, data: { qq: target.id, name: target.name } })), { type: 'text', data: { text: part.text } }] : part.type === 'file' ? [{ type: 'file', data: { name: part.name, mediaType: part.mediaType, bytes: part.bytes.length, sha256: part.sha256 } }] : [{ type: 'image', data: { file: 'unavailable', mediaType: part.mediaType, bytes: part.bytes.length, sha256: part.sha256, ...(part.name ? { name: part.name } : {}) } }], direction: 'outgoing', source: part.type === 'text' ? 'longlink:SendMsg' : part.type === 'file' ? 'shortlink:SendAppMsg' : 'longlink:UploadMsgImg', delivery: 'server-ack', observedAt: Date.now(), messageType: part.type === 'text' ? 1 : part.type === 'file' ? 49 : 3 };
          this.remember(message); this.persist(); first ??= message; this.emit({ type: 'event.message', payload: structuredClone(message) });
        }
      } catch (error) {
        if (error instanceof BridgeError && error.details.delivery === 'rejected') requestStarted = false;
        throw new BridgeError(error instanceof BridgeError ? error.code : 'ERR_SEND_FAILED', error instanceof Error ? error.message : 'Send failed', { ...(error instanceof BridgeError ? error.details : {}), acknowledgedMessageIds: ids, deliveryParts: deliveryParts(), delivery: ids.length ? 'partially-acknowledged' : error instanceof BridgeError && error.details.delivery === 'rejected' ? 'rejected' : parts[currentIndex]?.type === 'file' && !requestStarted ? 'not-sent' : error instanceof BridgeError ? error.details.delivery ?? 'unknown' : 'unknown' });
      }
      return { ...first!, serverMessageIds: ids, deliveryParts: deliveryParts() };
    });
    this.sendTail = task.catch(() => {});
    return task.finally(() => { this.sendPending--; this.queuedMediaBytes -= mediaBytes; });
  }
  async importSession(raw: unknown) {
    if (this.importing) throw new BridgeError('ERR_SESSION_BUSY', 'Session import is already in progress');
    const data = object(raw), next = validateCredential(data);
    let contacts: Contact[] = [];
    if (data.contacts !== undefined) {
      if (!Array.isArray(data.contacts) || data.contacts.length > 50000) throw new BridgeError('ERR_CREDENTIAL', 'Invalid native contact list');
      contacts = data.contacts.map(rawContact => {
        const c = object(rawContact);
        if (typeof c.id !== 'string' || !/^[\w@.:-]{1,256}$/.test(c.id) || typeof c.nickname !== 'string' || c.nickname.length > 256 || typeof c.remark !== 'string' || c.remark.length > 256)
          throw new BridgeError('ERR_CREDENTIAL', 'Invalid native contact');
        return { id: c.id, nickname: c.nickname || c.id, remark: c.remark };
      });
    }
    this.importing = true;
    try {
      await this.stopProtocol();
      const importedCursor = next.sync_key;
      this.session.save(next); this.loadCache();
      for (const contact of contacts) {
        if (contact.id.endsWith('@chatroom')) this.cache.groups = [...this.cache.groups.filter(g => g.id !== contact.id), { id: contact.id, name: contact.nickname, memberCount: 0, memberCountKnown: false }];
        else this.cache.contacts = [...this.cache.contacts.filter(c => c.id !== contact.id), contact];
      }
      // An explicit import replaces any older local cursor for the same account.
      this.cache.cursor = importedCursor; this.session.value!.sync_key = importedCursor; this.persist();
      this.lastError = undefined; this.lastSyncAt = undefined; this.lastHeartbeatAt = undefined;
      await this.start(); return this.session.publicStatus();
    } finally { this.importing = false; }
  }
  private async stopProtocol() {
    this.controller?.abort(); this.transport?.close(); await this.worker;
    await this.sendTail; this.nextSendAt = 0; this.setState('stopped');
  }
  async close() { await this.stopProtocol(); this.events.removeAllListeners(); }
  async disconnect() { await this.stopProtocol(); }
  subscribe(listener: (event: BridgeEvent) => void) { this.events.on('event', listener); return () => this.events.off('event', listener); }
}
