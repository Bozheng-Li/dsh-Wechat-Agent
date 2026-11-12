import { BridgeError } from '@napcat-wechat/protocol';
import type { Credential } from './session.js';
import { bytes, fields, fv, ld, num, signed, encodeCgiBody, decodeCgiBody, type Field } from './wire.js';

// Public protobuf field layouts: ByboyCn/wechat7016, independently checked
// against the authenticated PC responses. URLs never leave the worker.
export const STICKER_LIMIT = 2000;
export const stickerMd5 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const fail = (message: string): never => { throw new BridgeError('ERR_STICKER_PROTOCOL', message); };
function one(list: Field[], tag: number, wire: number, required = true) {
  const selected = list.filter(field => field.tag === tag);
  if (selected.length > 1 || selected.length && selected[0].wire !== wire || required && !selected.length)
    fail('微信表情回执字段不完整或重复，未使用异常结果');
  return selected[0]?.value;
}
function status(list: Field[], tag = 1) {
  const base = one(list, tag, 2) as Buffer;
  const ret = signed(one(fields(base), 1, 0) as bigint);
  if (ret !== 0) throw new BridgeError('ERR_STICKER_REJECTED', `微信暂不接受这次表情操作（${ret}）`, { ret, delivery: 'rejected' });
}
export function stickerListRequest(index = 0): Buffer {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw new BridgeError('ERR_STICKER_QUERY', '表情分页位置无效');
  return fv(1, index);
}
export function stickerListResponse(body: Buffer, previousIndex = 0) {
  const list = fields(body); status(list);
  const index = Number(one(list, 2, 0)), end = one(list, 4, 0);
  if (!Number.isSafeInteger(index) || index < previousIndex || index > 0xffffffff || ![0n, 1n].includes(end as bigint) || end === 0n && index <= previousIndex)
    fail('微信表情分页没有前进，未把不完整列表当作同步成功');
  const digestFields = list.filter(field => field.tag === 3), imageFields = list.filter(field => field.tag === 5);
  if (digestFields.length > 500 || imageFields.length > 500 || [...digestFields, ...imageFields].some(field => field.wire !== 2)) fail('微信表情列表超过读取范围');
  const digests = digestFields.map(field => (field.value as Buffer).toString('utf8').toLowerCase());
  if (digests.some(value => !stickerMd5(value)) || new Set(digests).size !== digests.length) fail('微信表情列表的标识无效或重复');
  const urls = new Map<string, string>();
  for (const field of imageFields) {
    const image = fields(field.value as Buffer), md5 = (one(image, 1, 2) as Buffer).toString('utf8').toLowerCase();
    const url = (one(image, 2, 2, false) as Buffer | undefined)?.toString('utf8') ?? '';
    if (!stickerMd5(md5) || urls.has(md5) || url.length > 16384 || digests.length && !digests.includes(md5)) fail('微信表情图片与本页列表不匹配');
    urls.set(md5, url);
  }
  return { index, complete: end === 1n, items: (digests.length ? digests : [...urls.keys()]).map(md5 => ({ md5, url: urls.get(md5) || '' })) };
}

export interface StickerSend { md5: string; to: string; clientId: string; time: number; baseRequest: Buffer }
export function stickerSendRequest(input: StickerSend) {
  if (!stickerMd5(input.md5) || !/^[\w@.:-]{1,256}$/.test(input.to) || !/^[\w-]{1,128}$/.test(input.clientId) || !input.baseRequest.length)
    throw new BridgeError('ERR_STICKER_QUERY', '表情发送参数无效', { delivery: 'rejected' });
  // Type 1 reuses a server-known emoji by MD5. No fabricated local upload or
  // XML text message: the server itself emits a type-47 emoji message.
  const item = Buffer.concat([ld(1, input.md5), fv(2, 0), fv(3, 1), ld(4, Buffer.concat([fv(1, 0), ld(2, Buffer.alloc(0))])),
    fv(5, 1), ld(6, input.to), ld(9, input.clientId)]);
  return Buffer.concat([ld(1, input.baseRequest), fv(2, 1), ld(3, item), fv(4, input.time)]);
}
export function stickerSendResponse(body: Buffer, input: StickerSend) {
  const list = fields(body); status(list);
  if (one(list, 2, 0) !== 1n) fail('表情发送回执数量不匹配，结果不明');
  const item = fields(one(list, 3, 2) as Buffer), ret = signed(one(item, 1, 0) as bigint);
  if (ret !== 0) throw new BridgeError('ERR_STICKER_REJECTED', `微信未接受这张表情（${ret}）`, { ret, delivery: 'rejected' });
  const md5 = (one(item, 4, 2) as Buffer).toString('utf8').toLowerCase();
  const id = one(item, 6, 0, false) as bigint | undefined ?? one(item, 5, 0, false) as bigint | undefined;
  if (md5 !== input.md5 || !id || id < 1n || id > 0xffffffffffffffffn) fail('表情回执缺少匹配的表情标识或消息编号，结果不明');
  const start = one(item, 2, 0), total = one(item, 3, 0);
  if (start !== total || ![0n, 1n].includes(total as bigint)) fail('表情发送尚未得到完整回执，结果不明');
  return { id: id.toString(), time: input.time };
}

// BatchEmojiBackup appends server-known emoji to the account's backup list.
// There is deliberately no BackupEmojiOperate/delete opcode in this module.
export function stickerCollectRequest(md5: string) {
  if (!stickerMd5(md5)) throw new BridgeError('ERR_STICKER_QUERY', '请选择一张真实微信表情');
  return ld(1, md5);
}
export function stickerCollectResponse(body: Buffer, md5: string) {
  const list = fields(body); status(list);
  const pending = list.filter(field => field.tag === 2);
  if (pending.length > 1 || pending.some(field => field.wire !== 2 || (field.value as Buffer).toString('utf8').toLowerCase() !== md5)) fail('微信表情收藏回执不属于选中的表情');
  return { needsUpload: pending.length > 0 };
}

const routes: Record<number, string> = { 696: 'mmbatchemojibackup', 697: 'mmbatchemojidownload', 175: 'sendemoji' };
export async function requestStickerCgi(account: Credential, cmd: number, body: Buffer, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  if (!routes[cmd]) throw new BridgeError('ERR_STICKER_QUERY', '不支持的表情操作');
  signal.throwIfAborted();
  const key = account.body_key ? Buffer.from(account.body_key, 'hex') : undefined, s08 = account.s08 ? Buffer.from(account.s08, 'hex') : undefined;
  const request = encodeCgiBody(cmd, body, account.uin, account.token, key, s08);
  const response = await fetcher('http://short.weixin.qq.com/cgi-bin/micromsg-bin/' + routes[cmd], { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/octet-stream', 'user-agent': 'MicroMessenger Client', accept: '*/*', 'cache-control': 'no-cache' }, body: request });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new BridgeError('ERR_STICKER_NETWORK', '微信表情请求未完成，请检查连接'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 2 * 1024 * 1024) fail('微信表情响应超过读取上限'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let decoded;
  for (const responseChecksum of [false, true]) {
    try { decoded = decodeCgiBody(Buffer.concat(chunks), key, s08, request, { responseChecksum }); break; }
    catch { /* The PC supports request echoes and content-checksum envelopes. */ }
  }
  if (!decoded) return fail('微信表情响应没有通过账号和请求校验，未自动重试发送');
  if (decoded.uin !== account.uin || decoded.innerCmd !== cmd) fail('微信表情响应不属于当前账号或请求');
  return decoded.body;
}
