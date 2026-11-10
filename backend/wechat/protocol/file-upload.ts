import { BridgeError } from '@napcat-wechat/protocol';
import type { Credential } from './session.js';
import { encodeCgiBody, decodeCgiBody, fields, bytes, num, signed, fv, ld } from './wire.js';

// Public protobuf layouts: UploadAppAttach CGI 220; SendAppMsg CGI 222.
// Use authenticated shortlink CGIs, without guessing PC longlink routing IDs.
export const FILE_CHUNK_BYTES = 50_000;
const routes: Record<number, string> = { 220: 'uploadappattach', 222: 'sendappmsg' };
export interface FileUpload { clientId: string; from: string; total: number; md5: string; baseRequest: Buffer }
export interface FileMessage extends FileUpload { to: string; name: string; mediaId: string; time: number }
const fail = (message: string): never => { throw new BridgeError('ERR_FILE_PROTOCOL', message); };
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

export function fileUploadRequest(upload: FileUpload, start: number, chunk: Buffer): Buffer {
  if (!Number.isSafeInteger(start) || start < 0 || !chunk.length || chunk.length > FILE_CHUNK_BYTES || start + chunk.length > upload.total)
    throw new BridgeError('ERR_INVALID_PARAMS', '文件上传分片无效', { delivery: 'rejected' });
  return Buffer.concat([ld(1, upload.baseRequest), fv(3, 0), ld(4, upload.clientId), ld(5, upload.from),
    fv(6, upload.total), fv(7, start), fv(8, chunk.length), ld(9, Buffer.concat([fv(1, chunk.length), ld(2, chunk)])), fv(10, 4), ld(11, upload.md5)]);
}
export function fileUploadResponse(body: Buffer, upload: FileUpload, start: number, length: number): { complete: boolean; mediaId?: string } {
  const fs = fields(body), ret = signed(num(fields(bytes(fs, 1)), 1));
  if (ret === undefined) fail('文件上传回执缺少状态，未发送文件消息');
  if (ret !== 0) throw new BridgeError('ERR_FILE_REJECTED', `微信拒绝文件上传（ret=${ret}），未发送文件消息`, { ret, delivery: 'rejected' });
  const position = num(fs, 7), dataLength = num(fs, 8);
  const echoedChunk = position === BigInt(start) && dataLength === BigInt(length);
  const consumedChunk = position === BigInt(start + length) && (dataLength === 0n || dataLength === BigInt(length));
  // PC replies can advertise the next upload window, capped at 64 KiB,
  // rather than the length of the chunk just consumed. Keep the exact cursor
  // and request identity checks; this value never confirms a file message.
  const nextWindow = position === BigInt(start + length) &&
    dataLength === BigInt(Math.min(65_536, upload.total - start - length));
  if (bytes(fs, 4).toString('utf8') !== upload.clientId || bytes(fs, 5).toString('utf8') !== upload.from ||
      num(fs, 6) !== BigInt(upload.total) || !(echoedChunk || consumedChunk || nextWindow))
    fail('文件上传回执的账号、客户端标识、长度或分片位置不匹配，未发送文件消息');
  const complete = start + length === upload.total, mediaId = bytes(fs, 3).toString('utf8');
  if (complete && (!mediaId || mediaId.length > 4096 || /[\u0000-\u001f\u007f]/.test(mediaId))) fail('文件上传缺少有效附件 ID，未发送文件消息');
  return { complete, ...(complete ? { mediaId } : {}) };
}
export function fileMessageRequest(file: FileMessage): Buffer {
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1) : '';
  const content = '<appmsg appid="" sdkver="0"><title>' + xml(file.name) + '</title><des/><action/><type>6</type><content/><url/><lowurl/><appattach><totallen>' + file.total +
    '</totallen><attachid>' + xml(file.mediaId) + '</attachid><fileext>' + xml(extension) + '</fileext></appattach><extinfo/></appmsg>';
  const message = Buffer.concat([ld(1, file.from), fv(3, 0), ld(4, file.to), fv(5, 6), ld(6, content), fv(7, file.time), ld(8, file.clientId)]);
  return Buffer.concat([ld(1, file.baseRequest), ld(2, message), fv(4, file.time), ld(5, file.md5)]);
}
export function fileMessageResponse(body: Buffer, file: FileMessage): { id: string; time: number } {
  const fs = fields(body), ret = signed(num(fields(bytes(fs, 1)), 1));
  if (ret === undefined) fail('文件消息回执缺少状态，发送结果不明，未自动重发');
  if (ret !== 0) throw new BridgeError('ERR_FILE_REJECTED', `微信拒绝文件消息（ret=${ret}）`, { ret, delivery: 'rejected' });
  if (bytes(fs, 3).toString('utf8') !== file.from || bytes(fs, 4).toString('utf8') !== file.to || bytes(fs, 6).toString('utf8') !== file.clientId || num(fs, 8) !== 6n)
    fail('文件消息回执的账号、会话、客户端标识或类型不匹配，发送结果不明');
  const id = num(fs, 9) ?? num(fs, 5);
  if (!id || id < 1n) fail('文件消息缺少微信消息 ID，发送结果不明，未自动重发');
  return { id: id.toString(), time: Number(num(fs, 7) ?? BigInt(file.time)) };
}
export async function requestFileCgi(account: Credential, cmd: number, body: Buffer, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  if (!routes[cmd]) throw new BridgeError('ERR_INVALID_PARAMS', '不支持的文件协议请求');
  signal.throwIfAborted();
  const key = account.body_key ? Buffer.from(account.body_key, 'hex') : undefined, s08 = account.s08 ? Buffer.from(account.s08, 'hex') : undefined;
  const request = encodeCgiBody(cmd, body, account.uin, account.token, key, s08);
  const response = await fetcher('http://short.weixin.qq.com/cgi-bin/micromsg-bin/' + routes[cmd], { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/octet-stream', 'user-agent': 'MicroMessenger Client', accept: '*/*', 'cache-control': 'no-cache' },
    body: request });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new BridgeError('ERR_FILE_NETWORK', '微信文件请求失败，请检查连接和回执记录'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 128 * 1024) fail('微信文件回执超过上限，未使用异常响应');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let decoded;
  try { decoded = decodeCgiBody(Buffer.concat(chunks), key, s08, request); }
  catch { throw new BridgeError('ERR_FILE_PROTOCOL', '微信文件回执未通过请求校验，未自动重发；请核对任务送达状态'); }
  if (decoded.uin !== account.uin || decoded.innerCmd !== cmd) fail('微信文件回执的账号或请求类型不匹配');
  return decoded.body;
}
