import { createHash } from 'node:crypto';
import { BridgeError } from '@napcat-wechat/protocol';
import { imageMime } from './media.js';

export interface SnsImageSource { index: number; mediaId: string; url: string }
// Credentials embedded in CDN URLs never become enumerable post fields, IPC
// metadata, model input or persisted interaction records.
const sources = new WeakMap<object, SnsImageSource[]>();
export const rememberSnsImages = (post: object, images: SnsImageSource[]) => sources.set(post, images);
export const snsImageSources = (post: object) => sources.get(post) ?? [];
const failure = (message: string): never => { throw new BridgeError('ERR_MOMENTS_IMAGE_READ', message); };
const maxBytes = 10 * 1024 * 1024;

export function snsImageUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return failure('朋友圈没有提供有效图片地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash || value.length > 8192 ||
      !/(^|\.)(qpic\.cn|qlogo\.cn)$/.test(url.hostname)) failure('朋友圈图片地址不属于受支持的微信图片服务');
  url.protocol = 'https:';
  return url;
}

export async function downloadSnsImage(source: SnsImageSource, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const url = snsImageUrl(source.url); signal.throwIfAborted();
  let response: Response;
  try { response = await fetcher(url, { signal, redirect: 'error', headers: { accept: 'image/*', 'user-agent': 'MicroMessenger Client' } }); }
  catch { signal.throwIfAborted(); return failure('朋友圈图片下载未取得响应，未声称看过图片'); }
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); return failure('朋友圈图片不可用或超过 10 MiB，未读取画面');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maxBytes) failure('朋友圈图片超过 10 MiB，已停止读取'); chunks.push(value); }
  } catch (error) { signal.throwIfAborted(); if (error instanceof BridgeError) throw error; return failure('朋友圈图片数据读取中断'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal.throwIfAborted(); const content = Buffer.concat(chunks); let mediaType: string;
  try { mediaType = imageMime(content); } catch { return failure('微信图片未返回可解析的画面，可能已过期或使用不支持的加密格式'); }
  return { index: source.index, mediaId: source.mediaId, data: content.toString('base64'), mediaType,
    bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}
