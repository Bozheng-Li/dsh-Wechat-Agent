import { createHash, randomUUID } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { BridgeError } from '@napcat-wechat/protocol';
import type { Credential } from './session.js';
import { validateImageBaseRequest } from './image-session.js';
import { bytes, fields, fv, ld, num, signed, encodeCgiBody, decodeCgiBody, type Field } from './wire.js';

// Field layouts independently implemented from the public Sns* protobufs.
// PC 3.9 probes verified CGI 211/212 and the SNS zero-checksum envelope.
const routes = { timeline: { cmd: 211, route: 'mmsnstimeline' }, user: { cmd: 212, route: 'mmsnsuserpage' }, detail: { cmd: 210, route: 'mmsnsobjectdetail' }, comments: { cmd: 210, route: 'mmsnsobjectdetail' } };
const MAX_RESPONSE = 4 * 1024 * 1024, CURSOR_MS = 10 * 60 * 1000;
export type MomentsAction = keyof typeof routes;
export interface MomentsQuery { action?: MomentsAction; userId?: string; postId?: string; cursor?: string; limit?: number }
interface PageRequest { action: MomentsAction; userId?: string; postId?: string; maxId?: string; firstPageMd5?: string; session?: Buffer }
const fail = (message: string): never => { throw new BridgeError('ERR_MOMENTS_PROTOCOL', message); };
const uint64 = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const wxid = (value: unknown): value is string => typeof value === 'string' && /^[\w.:-]{1,256}$/.test(value);
const one = (list: Field[], tag: number, wire: number, required = false) => {
  const values = list.filter(field => field.tag === tag);
  if (values.length > 1 || values.some(field => field.wire !== wire) || required && values.length !== 1) fail('朋友圈响应字段缺失、重复或类型不匹配');
  return values[0]?.value;
};
const text = (list: Field[], tag: number, limit: number, required = false) => {
  const value = one(list, tag, 2, required) as Buffer | undefined;
  if (!value) return '';
  if (value.length > limit * 4) fail('朋友圈文本字段异常过长');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value).slice(0, limit); }
  catch { return fail('朋友圈文本编码无效'); }
};
const integer = (list: Field[], tag: number, required = false) => one(list, tag, 0, required) as bigint | undefined;
const count = (list: Field[], tag: number, required = false) => {
  const value = integer(list, tag, required);
  if (value !== undefined && value > 0xffffffffn) fail('朋友圈计数字段无效');
  return value === undefined ? undefined : Number(value);
};
export function validateMomentsQuery(raw: unknown): Required<Pick<MomentsQuery, 'action' | 'limit'>> & MomentsQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BridgeError('ERR_INVALID_MOMENTS_QUERY', '朋友圈读取参数应为对象');
  const query = raw as Record<string, unknown>;
  if (Object.keys(query).some(key => !['action', 'userId', 'postId', 'cursor', 'limit'].includes(key))) throw new BridgeError('ERR_INVALID_MOMENTS_QUERY', '朋友圈读取包含不支持的参数');
  const action = query.action ?? 'timeline', limit = query.limit ?? 10;
  const detail = action === 'detail' || action === 'comments';
  if (typeof action !== 'string' || !Object.hasOwn(routes, action) || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > (action === 'comments' ? 50 : 20) ||
      query.userId !== undefined && (!wxid(query.userId) || action !== 'user') ||
      query.postId !== undefined && (!uint64(query.postId) || !detail) || detail && !uint64(query.postId) ||
      query.cursor !== undefined && (typeof query.cursor !== 'string' || !/^[a-f0-9-]{36}$/.test(query.cursor) || action === 'detail'))
    throw new BridgeError('ERR_INVALID_MOMENTS_QUERY', '请选择朋友圈动态、用户主页、单条详情或评论区；普通读取 1–20 条，评论区 1–50 条，详情和评论区需要真实动态编号');
  return { ...query, action, limit } as Required<Pick<MomentsQuery, 'action' | 'limit'>> & MomentsQuery;
}
export function momentsRequest(base: Buffer, query: PageRequest): Buffer {
  if (query.action === 'detail' || query.action === 'comments') return Buffer.concat([ld(1, base), fv(2, BigInt(query.postId!)), fv(3, 0)]);
  if (query.action === 'user') return Buffer.concat([ld(1, base), ld(2, query.firstPageMd5 ?? ''), ld(3, query.userId!), fv(4, BigInt(query.maxId ?? '0')), fv(5, 0), fv(6, 0), fv(7, 0)]);
  return Buffer.concat([ld(1, base), ld(2, query.firstPageMd5 ?? ''), fv(3, BigInt(query.maxId ?? '0')), fv(4, 0), fv(5, 0), fv(6, 0),
    ...(query.session?.length ? [ld(7, Buffer.concat([fv(1, query.session.length), ld(2, query.session)]))] : []), fv(8, 1)]);
}
function bufferField(list: Field[], tag: number): Buffer | undefined {
  const value = one(list, tag, 2) as Buffer | undefined;
  if (!value) return undefined;
  const wrapped = fields(value), payload = one(wrapped, 2, 2, true) as Buffer, size = integer(wrapped, 1, true);
  if (size !== BigInt(payload.length)) fail('朋友圈正文或分页数据长度不匹配');
  return payload;
}
const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, processEntities: true });
const asText = (value: unknown, max = 10000) => typeof value === 'string' ? value.slice(0, max) :
  value && typeof value === 'object' && '#text' in value ? asText((value as Record<string, unknown>)['#text'], max) : '';
const array = (value: unknown): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
/** PC SNS preserves legacy text forms that the WeChat client renders normally.
 * E412 is the live-verified legacy representation of U+1F602 (joy). */
export const normalizeSnsText = (value: string) => value.replace(/&#(?:x0*a|0*10);/gi, '\n').replace(/&#(?:x0*d|0*13);/gi, '\r').replace(/\ue412/g, '😂');
function parseContent(content: Buffer, id: string, userId: string) {
  if (content.length > 512 * 1024) fail('朋友圈正文超过解析范围');
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { return fail('朋友圈正文编码无效'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) fail('朋友圈正文 XML 无效');
  const parsed = xmlParser.parse(xml), root = parsed?.TimelineObject;
  if (!root || typeof root !== 'object' || Array.isArray(root)) fail('朋友圈正文缺少 TimelineObject');
  const xmlId = asText(root.id), xmlUser = asText(root.username);
  if (xmlId && xmlId !== id || xmlUser && xmlUser !== userId) fail('朋友圈正文的动态编号或作者与响应不一致');
  // PC SNS serializes line breaks as numeric entity text inside contentDesc.
  // Decode only the observed whitespace forms, not arbitrary embedded markup.
  const rawText = normalizeSnsText(asText(root.contentDesc, 512 * 1024)), contentObject = root.ContentObject ?? {};
  const media = array(contentObject.mediaList?.media).slice(0, 100).map(item => {
    const typeCode = asText(item.type, 20), size = item.size ?? {};
    const dimension = (value: unknown) => /^\d{1,6}$/.test(String(value)) ? Number(value) : undefined;
    return { id: asText(item.id, 128), type: typeCode === '2' ? 'image' : typeCode === '6' ? 'video' : 'other', typeCode,
      title: asText(item.title, 300), description: asText(item.description, 1000),
      ...(dimension(size['@_width']) ? { width: dimension(size['@_width']) } : {}),
      ...(dimension(size['@_height']) ? { height: dimension(size['@_height']) } : {}) };
  });
  // CDN URLs can carry download credentials. They remain outside model output.
  const link = asText(contentObject.contentUrl, 8192); let linkHost;
  try { const url = new URL(link); if (['https:', 'http:'].includes(url.protocol)) linkHost = url.hostname; } catch {}
  return { text: rawText.slice(0, 10000), ...(rawText.length > 10000 ? { textTruncated: true } : {}), media,
    imageCount: media.filter(item => item.type === 'image').length,
    ...(linkHost ? { link: { host: linkHost, title: asText(contentObject.title, 500), description: asText(contentObject.description, 1000) } } : {}) };
}
function comment(value: Buffer) {
  const list = fields(value);
  return { userId: text(list, 1, 256), nickname: text(list, 2, 150), text: normalizeSnsText(text(list, 5, 4000)), createdAt: count(list, 6),
    ...(integer(list, 12) || integer(list, 7) ? { id: (integer(list, 12) || integer(list, 7))!.toString() } : {}),
    ...(text(list, 9, 256) ? { replyToUserId: text(list, 9, 256) } : {}),
    ...(integer(list, 11) || integer(list, 8) ? { replyToCommentId: (integer(list, 11) || integer(list, 8))!.toString() } : {}), deleted: !!count(list, 13) };
}
export function parseSnsObject(value: Buffer, interactionLimit = 50) {
  const list = fields(value), idValue = integer(list, 1, true), userId = text(list, 2, 256, true), createdAt = count(list, 4, true);
  if (!idValue || !wxid(userId) || !createdAt) fail('朋友圈动态缺少有效编号、作者或时间');
  const id = idValue.toString(), content = bufferField(list, 5);
  const likes = list.filter(field => field.tag === 9), comments = list.filter(field => field.tag === 12);
  if ([...likes, ...comments].some(field => field.wire !== 2) || likes.length > 500 || comments.length > 500 ||
      count(list, 8) !== undefined && count(list, 8) !== likes.length || count(list, 11) !== undefined && count(list, 11) !== comments.length)
    fail('朋友圈可见评论或点赞列表数量不匹配');
  return { id, author: { userId, nickname: text(list, 3, 150) }, createdAt, contentAvailable: !!content?.length,
    ...(content?.length ? parseContent(content, id, userId) : { text: '', media: [], imageCount: 0 }),
    deleted: !!count(list, 25), likedByCurrentAccount: !!count(list, 6), likeCount: count(list, 7), commentCount: count(list, 10),
    likes: likes.slice(0, 50).map(field => comment(field.value as Buffer)), comments: comments.slice(0, interactionLimit).map(field => comment(field.value as Buffer)),
    visibleLikeEntries: likes.length, visibleCommentEntries: comments.length,
    ...(likes.length > 50 || comments.length > interactionLimit ? { interactionsTruncated: true } : {}) };
}
export type Moment = ReturnType<typeof parseSnsObject>;
export function momentsResponse(body: Buffer, request: PageRequest) {
  if (body.length > MAX_RESPONSE) fail('朋友圈解压响应超过解析范围');
  const list = fields(body), base = fields(one(list, 1, 2, true) as Buffer), ret = signed(integer(base, 1, true));
  if (ret !== 0) throw new BridgeError('ERR_MOMENTS_REJECTED', `微信拒绝朋友圈读取（ret=${ret}），未视为朋友圈为空`, { ret });
  const detail = request.action === 'detail' || request.action === 'comments', objectTag = detail ? 2 : 4, objects = list.filter(field => field.tag === objectTag);
  if (objects.some(field => field.wire !== 2) || objects.length > 100 ||
      detail && objects.length !== 1 || !detail && count(list, 3, true) !== objects.length)
    fail('朋友圈动态数量与响应声明不一致');
  const items = objects.map(field => parseSnsObject(field.value as Buffer, request.action === 'comments' ? 500 : 50));
  if (new Set(items.map(item => item.id)).size !== items.length ||
      detail && items[0]?.id !== request.postId ||
      request.action === 'user' && items.some(item => item.author.userId !== request.userId)) fail('朋友圈响应含重复动态或错误目标');
  return { items, firstPageMd5: detail ? '' : text(list, 2, 256),
    ...(request.action === 'timeline' ? { session: bufferField(list, 11) } : {}) };
}
export async function requestMomentsCgi(account: Credential, page: PageRequest, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const { cmd, route } = routes[page.action];
  return momentsResponse(await requestSnsCgi(account, cmd, route, base => momentsRequest(base, page), signal, fetcher), page);
}
/** A single authenticated SNS request. Mutation callers never retry here. */
export async function requestSnsCgi(account: Credential, cmd: number, route: string, makeBody: (base: Buffer) => Buffer, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  signal.throwIfAborted();
  if (!account.image_base_request) throw new BridgeError('ERR_MOMENTS_CREDENTIAL', '当前微信登录缺少完整朋友圈认证参数，请重新检查登录交接');
  const base = validateImageBaseRequest(Buffer.from(account.image_base_request, 'hex'), account);
  const key = account.body_key ? Buffer.from(account.body_key, 'hex') : undefined, s08 = account.s08 ? Buffer.from(account.s08, 'hex') : undefined;
  const request = encodeCgiBody(cmd, makeBody(base), account.uin, account.token, key, s08);
  let response;
  try { response = await fetcher('http://short.weixin.qq.com/cgi-bin/micromsg-bin/' + route, { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/octet-stream', 'user-agent': 'MicroMessenger Client', accept: '*/*', 'cache-control': 'no-cache' }, body: request }); }
  catch { signal.throwIfAborted(); throw new BridgeError('ERR_MOMENTS_NETWORK', '朋友圈请求未取得响应，请检查微信连接'); }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new BridgeError('ERR_MOMENTS_NETWORK', '朋友圈请求未取得有效响应，请检查微信连接'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > MAX_RESPONSE) fail('朋友圈网络响应超过解析范围'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let decoded;
  try { decoded = decodeCgiBody(Buffer.concat(chunks), key, s08, request, { responseChecksum: true }); }
  catch { signal.throwIfAborted(); fail('朋友圈响应账号、请求类型或内容校验失败，未使用异常数据'); }
  return decoded!.body;
}
const accountKey = (account: Credential) => createHash('sha256').update(JSON.stringify([account.uin, account.wxid, account.token, account.body_key, account.s08])).digest('hex');
interface Cursor { accountKey: string; scopeKey: string; page: PageRequest; pending: Moment[]; expires: number; fetchedAt: number;
  comments?: ReturnType<typeof comment>[]; commentsMeta?: { postId: string; commentCount?: number; visibleCommentEntries: number } }
export class MomentsReader {
  readonly cursors = new Map<string, Cursor>();
  constructor(readonly getAccount: () => Credential | undefined, readonly assertConnected: () => void,
    readonly request = requestMomentsCgi, readonly now = Date.now) {}
  clear() { this.cursors.clear(); }
  async read(raw: unknown, scopeKey: string, signal: AbortSignal) {
    const query = validateMomentsQuery(raw), account = this.getAccount(); this.assertConnected(); signal.throwIfAborted();
    if (!account) throw new BridgeError('ERR_MOMENTS_CREDENTIAL', '微信登录会话不可用');
    const key = accountKey(account), userId = query.action === 'user' ? query.userId ?? account.wxid : undefined;
    for (const [id, cursor] of this.cursors) if (cursor.expires <= this.now() || cursor.accountKey !== key) this.cursors.delete(id);
    const previous = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!previous || previous.accountKey !== key || previous.scopeKey !== scopeKey ||
        previous.page.action !== query.action || previous.page.userId !== userId || previous.page.postId !== query.postId))
      throw new BridgeError('ERR_MOMENTS_CURSOR', '朋友圈分页已过期或属于其他账号、发起人或读取目标，请重新读取首页');
    const page = previous?.page ?? { action: query.action, userId, postId: query.postId };
    const assertCurrent = () => { signal.throwIfAborted(); this.assertConnected();
      const current = this.getAccount(); if (!current || accountKey(current) !== key) throw new BridgeError('ERR_MOMENTS_ACCOUNT_CHANGED', '读取期间微信账号或登录会话已变化，未返回旧账号朋友圈'); };
    assertCurrent();
    if (query.action === 'comments') {
      let available = previous?.comments, meta = previous?.commentsMeta, fetchedAt = previous?.fetchedAt;
      if (!available) {
        const response = await this.request(account, page, signal); assertCurrent();
        const post = response.items[0];
        if (!post?.contentAvailable || post.deleted) throw new BridgeError('ERR_MOMENTS_TARGET_UNAVAILABLE', '目标动态不可见或已删除，未读取评论');
        available = post.comments; meta = { postId: post.id, commentCount: post.commentCount, visibleCommentEntries: post.visibleCommentEntries }; fetchedAt = this.now();
      }
      const items = available.slice(0, query.limit), pending = available.slice(query.limit); let nextCursor;
      if (pending.length) {
        while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!);
        nextCursor = randomUUID(); this.cursors.set(nextCursor, { accountKey: key, scopeKey, page, pending: [], comments: pending, commentsMeta: meta!, expires: this.now() + CURSOR_MS, fetchedAt: fetchedAt! });
      }
      return { accountId: account.wxid, action: query.action, ...meta, source: 'wechat-sns-live', scope: 'current-account-visible',
        fetchedAt: new Date(fetchedAt!).toISOString(), items, nextCursor: nextCursor ?? null, mediaContentIncluded: false };
    }
    let available = previous?.pending ?? [], nextPage = page, fetchedAt = previous?.fetchedAt ?? this.now();
    if (!available.length) {
      const result = await this.request(account, page, signal); assertCurrent(); available = result.items; fetchedAt = this.now();
      const maxId = available.reduce<bigint | undefined>((lowest, item) => lowest === undefined || BigInt(item.id) < lowest ? BigInt(item.id) : lowest, undefined)?.toString();
      if (maxId && page.maxId && BigInt(maxId) >= BigInt(page.maxId)) fail('朋友圈分页未向历史推进，请重新读取首页');
      nextPage = { ...page, ...(maxId ? { maxId } : {}), firstPageMd5: result.firstPageMd5, session: result.session };
    }
    const items = available.slice(0, query.limit), pending = available.slice(query.limit); let nextCursor;
    assertCurrent();
    if (query.action !== 'detail' && available.length) {
      while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!);
      nextCursor = randomUUID(); this.cursors.set(nextCursor, { accountKey: key, scopeKey, page: nextPage, pending, expires: this.now() + CURSOR_MS, fetchedAt });
    }
    return { accountId: account.wxid, action: query.action, ...(userId ? { userId } : {}), source: 'wechat-sns-live', scope: 'current-account-visible',
      fetchedAt: new Date(fetchedAt).toISOString(), items, nextCursor: nextCursor ?? null,
      mediaContentIncluded: false, ...(nextCursor ? { pagination: '继续读取才能确认是否还有更早动态' } : {}) };
  }
}
