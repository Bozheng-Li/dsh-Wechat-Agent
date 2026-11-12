import { artifactName } from '../../shared/work-artifacts.mjs';

export interface MediaData {
  file?: string; url?: string; resourceId?: string;
  // Only trusted, already-loaded bytes may be submitted for sending. File/URL
  // references describe received or cached media; the sender never reads them.
  base64?: string; mediaType?: string; bytes?: number; sha256?: string;
  name?: string;
  stickerMd5?: string;
  // With a native sticker reference, base64 (if present) is only the checked
  // static fallback, used after an explicit native rejection, never a timeout.
  nativeSticker?: { md5: string };
}
export const MAX_SEND_IMAGE_BYTES = 10 * 1024 * 1024;
export type Segment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: MediaData }
  | { type: 'face'; data: MediaData }
  | { type: 'file'; data: MediaData & { name: string } }
  | { type: 'at'; data: { qq: string; name?: string } }
  | { type: 'reply'; data: { id?: string; messageType?: number; senderId?: string; senderName?: string; content?: string; image?: { resourceId: string }; file?: { name: string; bytes?: number } } };

export interface Contact { id: string; nickname: string; remark?: string; avatar?: string; alias?: string }
export interface Group { id: string; name: string; memberCount: number; maxMemberCount?: number }
export interface Member extends Contact { groupId: string; card?: string; role: 'owner' | 'admin' | 'member'; roleKnown?: boolean }
export interface BridgeMessage {
  id: string; time: number; chatType: 'private' | 'group'; peerId: string;
  sender: Contact; message: Segment[]; direction: 'incoming' | 'outgoing';
  source?: string; delivery?: string; observedAt?: number; partial?: boolean;
  serverMessageId?: string; serverMessageIds?: string[]; messageType?: number;
}
export interface SendParams { chatType: 'private' | 'group'; peerId: string; message: Segment[] }
export interface BackendStatus { online: boolean; good: boolean; mode: 'loopback' | 'protocol'; hookCount?: number; diagnostics?: unknown }
export interface ActionMap {
  'action.get_login_info': { params: Record<string, never>; result: Contact };
  'action.send_msg': { params: SendParams; result: BridgeMessage };
  'action.get_friend_list': { params: Record<string, never>; result: Contact[] };
  'action.get_group_list': { params: Record<string, never>; result: Group[] };
  'action.get_group_member_list': { params: { groupId: string }; result: Member[] };
  'action.get_msg': { params: { id: string }; result: BridgeMessage };
}
export type ActionName = keyof ActionMap;
export type Params<A extends ActionName> = ActionMap[A]['params'];
export type Result<A extends ActionName> = ActionMap[A]['result'];
export type BridgeEvent =
  | { type: 'event.message'; payload: BridgeMessage }
  | { type: 'event.notice'; payload: { noticeType: 'group_increase' | 'group_decrease'; groupId: string; userId: string; operatorId: string; time: number } }
  | { type: 'event.meta'; payload: { state: 'connected' | 'disconnected'; mode: BackendStatus['mode'] } }
  | { type: 'event.runtime'; payload: Record<string, unknown> }
  | { type: 'event.log'; payload: { level: string; message: string; time: number } };

export interface Backend {
  readonly mode: BackendStatus['mode'];
  start(): Promise<void>;
  close(): Promise<void>;
  status(): BackendStatus;
  assertReady(action: ActionName): void;
  call<A extends ActionName>(action: A, params: Params<A>): Promise<Result<A>>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
}
export class BridgeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message); this.name = 'BridgeError'; this.code = code; this.details = details;
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('ERR_INVALID_PARAMS', 'Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 1_000_000) throw new BridgeError('ERR_INVALID_PARAMS', `Invalid ${name}`);
  return value;
}
export function segments(value: unknown): Segment[] {
  if (!Array.isArray(value) || value.length > 1024) throw new BridgeError('ERR_INVALID_PARAMS', 'Expected message segments');
  return value.map((raw): Segment => {
    const s = object(raw), d = object(s.data);
    switch (s.type) {
      case 'text': if (typeof d.text !== 'string') break; return { type: 'text', data: { text: d.text } };
      case 'image':
      case 'face': {
        let nativeSticker: { md5: string } | undefined;
        if (d.nativeSticker !== undefined) {
          const native = object(d.nativeSticker);
          if (s.type !== 'face' || typeof native.md5 !== 'string' || !/^[a-f0-9]{32}$/.test(native.md5))
            throw new BridgeError('ERR_INVALID_PARAMS', '微信原生表情标识无效', { delivery: 'rejected' });
          nativeSticker = { md5: native.md5 };
          if (d.base64 === undefined) return { type: 'face', data: { nativeSticker } };
        }
        if (d.base64 !== undefined) {
          if (typeof d.base64 !== 'string' || !d.base64.length || d.base64.length > Math.ceil(MAX_SEND_IMAGE_BYTES / 3) * 4 || d.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(d.base64))
            throw new BridgeError('ERR_INVALID_PARAMS', '图片内容必须是标准 base64，单张不能超过 10 MiB');
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(d.mediaType)))
            throw new BridgeError('ERR_INVALID_PARAMS', '图片类型必须是 PNG、JPEG、GIF 或 WebP');
          return { type: s.type, data: { base64: d.base64, mediaType: String(d.mediaType), ...(nativeSticker ? { nativeSticker } : {}), ...(d.name === undefined ? {} : { name: artifactName(d.name) }) } };
        }
        return { type: s.type, data: { file: string(d.file, `${s.type}.file`), ...(d.url === undefined ? {} : { url: string(d.url, `${s.type}.url`) }), ...(d.resourceId === undefined ? {} : { resourceId: string(d.resourceId, `${s.type}.resourceId`) }) } };
      }
      case 'file': {
        let name: string;
        try { name = artifactName(d.name); } catch { throw new BridgeError('ERR_INVALID_PARAMS', '文件名无效，整条回复尚未发送', { delivery: 'rejected' }); }
        if (typeof d.base64 !== 'string' || !d.base64.length || d.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(d.base64))
          throw new BridgeError('ERR_INVALID_PARAMS', '文件发送需要有效的实际内容；不能使用本机路径或网址', { delivery: 'rejected' });
        if (d.mediaType !== undefined && (typeof d.mediaType !== 'string' || d.mediaType.length > 200 || /[\u0000-\u0020\u007f]/.test(d.mediaType)))
          throw new BridgeError('ERR_INVALID_PARAMS', '文件内容类型无效，整条回复尚未发送', { delivery: 'rejected' });
        return { type: 'file', data: { name, base64: d.base64, mediaType: d.mediaType || 'application/octet-stream' } };
      }
      case 'at': {
        if (d.name !== undefined && (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 256 || /[\u0000-\u001f\u007f]/.test(d.name)))
          throw new BridgeError('ERR_INVALID_PARAMS', '@ 对象昵称无效');
        return { type: 'at', data: { qq: string(String(d.qq ?? ''), 'at.qq'), ...(d.name === undefined ? {} : { name: String(d.name).trim() }) } };
      }
      case 'reply': return { type: 'reply', data: { id: string(String(d.id ?? ''), 'reply.id') } };
    }
    throw new BridgeError('ERR_INVALID_PARAMS', `Unsupported or invalid segment ${String(s.type)}`);
  });
}
export function validateParams<A extends ActionName>(action: A, raw: unknown): Params<A> {
  if (!ACTIONS.includes(action)) throw new BridgeError('ERR_IPC_METHOD', 'Unknown IPC action');
  const p = object(raw);
  let result: unknown;
  switch (action) {
    case 'action.send_msg':
      if (p.chatType !== 'private' && p.chatType !== 'group') throw new BridgeError('ERR_INVALID_PARAMS', 'Invalid chatType');
      result = { chatType: p.chatType, peerId: string(p.peerId, 'peerId'), message: segments(p.message) }; break;
    case 'action.get_group_member_list': result = { groupId: string(p.groupId, 'groupId') }; break;
    case 'action.get_msg': result = { id: string(p.id, 'id') }; break;
    default: result = {};
  }
  return result as Params<A>;
}
export const ACTIONS: ActionName[] = ['action.get_login_info', 'action.send_msg', 'action.get_friend_list', 'action.get_group_list', 'action.get_group_member_list', 'action.get_msg'];
