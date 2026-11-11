import { BridgeError } from '@napcat-wechat/protocol';
import type { Credential } from "./session.js";
import { encodeCgiBody, decodeCgiBody, IMAGE_DOWNLOAD_CHUNK_BYTES } from "./wire.js";

const IMAGE_ENDPOINT = 'http://short.weixin.qq.com/cgi-bin/micromsg-bin/getmsgimg';
const MAX_RESPONSE_BYTES = IMAGE_DOWNLOAD_CHUNK_BYTES + 8192;

/** Read-only CGI 109. Its encrypted request is independent of chat's longlink. */
export async function downloadImageChunk(account: Credential, body: Buffer, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  signal.throwIfAborted();
  const key = account.body_key ? Buffer.from(account.body_key, 'hex') : undefined;
  const s08 = account.s08 ? Buffer.from(account.s08, 'hex') : undefined;
  const request = encodeCgiBody(109, body, account.uin, account.token, key, s08);
  let response: Response;
  try {
    response = await fetcher(IMAGE_ENDPOINT, { method: 'POST', redirect: 'manual', signal,
      headers: { 'content-type': 'application/octet-stream', 'user-agent': 'MicroMessenger Client', accept: '*/*', 'cache-control': 'no-cache' }, body: request });
  } catch {
    signal.throwIfAborted();
    throw new BridgeError('ERR_IMAGE_DOWNLOAD', '微信高清图片下载暂时失败，请稍后重试');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new BridgeError('ERR_IMAGE_DOWNLOAD', '微信暂未提供高清图片，资源可能已过期');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new BridgeError('ERR_PROTOCOL', '微信图片响应超过分片上限，未读取异常内容');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  signal.throwIfAborted();
  // GetMsgImg uses response checksums (including the observed zero/zero
  // envelope), not the request-checksum echo used by file-upload ACKs.
  const decoded = decodeCgiBody(Buffer.concat(chunks), key, s08, request, { responseChecksum: true });
  if (decoded.uin !== account.uin || decoded.innerCmd !== 109)
    throw new BridgeError('ERR_PROTOCOL', '微信图片响应的账号或请求类型不匹配，未使用返回内容');
  return decoded.body;
}
