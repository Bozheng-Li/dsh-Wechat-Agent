import { BridgeError } from '@napcat-wechat/protocol';
import type { Credential } from './session.js';
import { bytes, fields, fv, ld, num, signed, encodeCgiBody, decodeCgiBody } from './wire.js';
import { RECEIVED_FILE_LIMITS } from '../../../shared/received-files.mjs';

export const FILE_DOWNLOAD_CHUNK_BYTES = 64 * 1024;
export interface FileDownload { baseRequest: Buffer; appId: string; mediaId: string; username: string; total: number; messageId: string }
const fail = (message: string): never => { throw new BridgeError('ERR_FILE_DOWNLOAD_PROTOCOL', message); };

// DownloadAppAttach's response has different field numbers from UploadAppAttach.
// Layout: nsky99/wechatclient, pkg/wechat_sdk/mmpb/pb/DownloadAppAttach.proto.
export function fileDownloadRequest(file: FileDownload, start: number): Buffer {
  if (!file.mediaId || file.mediaId.length > 16384 || !/^[\w@.:-]{1,256}$/.test(file.username) ||
      !/^[1-9]\d{0,19}$/.test(file.messageId) || BigInt(file.messageId) > 0xffffffffffffffffn ||
      !Number.isSafeInteger(file.total) || file.total < 1 || file.total > RECEIVED_FILE_LIMITS.bytes ||
      !Number.isSafeInteger(start) || start < 0 || start >= file.total)
    throw new BridgeError('ERR_FILE_DOWNLOAD_INVALID', '附件下载标识、长度或分片位置无效');
  return Buffer.concat([ld(1, file.baseRequest), ld(2, file.appId), fv(3, 0), ld(4, file.mediaId), ld(5, file.username),
    fv(6, file.total), fv(7, start), fv(8, Math.min(FILE_DOWNLOAD_CHUNK_BYTES, file.total - start)),
    fv(11, 0), fv(12, 0), fv(13, BigInt(file.messageId))]);
}

export function fileDownloadResponse(body: Buffer, file: FileDownload, start: number): Buffer {
  const fs = fields(body), ret = signed(num(fields(bytes(fs, 1)), 1));
  if (ret === undefined) fail('微信附件响应缺少状态，未使用返回内容');
  if (ret !== 0) throw new BridgeError('ERR_FILE_DOWNLOAD_REJECTED', `微信未提供该附件（ret=${ret}），文件可能已过期或不支持此下载方式`, { ret });
  const app = bytes(fs, 2).toString('utf8'), mediaId = bytes(fs, 3).toString('utf8'), username = bytes(fs, 4).toString('utf8');
  const data = fields(bytes(fs, 8)), content = bytes(data, 2), length = num(fs, 7);
  if (app && app !== file.appId || mediaId && mediaId !== file.mediaId || username && username !== file.username ||
      num(fs, 5) !== BigInt(file.total) || num(fs, 6) !== BigInt(start) || !content.length ||
      content.length > Math.min(FILE_DOWNLOAD_CHUNK_BYTES, file.total - start) || length !== BigInt(content.length) || num(data, 1) !== length)
    fail('微信附件响应的来源、总长、分片位置或数据长度不匹配，未保存不完整文件');
  return content;
}

/** PC shortlink CGI 221. No chat message is sent and chat's longlink stays idle. */
export async function downloadFileChunk(account: Credential, body: Buffer, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  signal.throwIfAborted();
  const key = account.body_key ? Buffer.from(account.body_key, 'hex') : undefined, s08 = account.s08 ? Buffer.from(account.s08, 'hex') : undefined;
  const request = encodeCgiBody(221, body, account.uin, account.token, key, s08);
  let response;
  try { response = await fetcher('http://short.weixin.qq.com/cgi-bin/micromsg-bin/downloadappattach', {
    method: 'POST', redirect: 'error', signal, body: request,
    headers: { 'content-type': 'application/octet-stream', 'user-agent': 'MicroMessenger Client', accept: '*/*', 'cache-control': 'no-cache' },
  }); } catch { signal.throwIfAborted(); throw new BridgeError('ERR_FILE_DOWNLOAD_NETWORK', '微信附件下载连接失败，请稍后重试'); }
  if (!response.ok || !response.body) {
    await response.body?.cancel(); throw new BridgeError('ERR_FILE_DOWNLOAD_NETWORK', '微信暂未提供附件，请检查连接或文件是否已过期');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > FILE_DOWNLOAD_CHUNK_BYTES + 32768) fail('微信附件响应超过分片上限，未使用异常数据');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal.throwIfAborted();
  let decoded;
  // The PC attachment service echoes the authenticated request's checksum,
  // as UploadAppAttach does. Verified by the live synthetic Word round trip.
  try { decoded = decodeCgiBody(Buffer.concat(chunks), key, s08, request); }
  catch { fail('微信附件响应未通过完整性校验，未保存文件'); }
  if (decoded!.uin !== account.uin || decoded!.innerCmd !== 221) fail('微信附件响应的账号或请求类型不匹配');
  return decoded!.body;
}
