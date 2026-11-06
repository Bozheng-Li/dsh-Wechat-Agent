import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageMime } from './media.ts';
import { ChannelError } from '../../contracts.mjs';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function inside(root, file) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !fs.lstatSync(file).isSymbolicLink();
}
function allowedMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ChannelError('IMAGE_UNAVAILABLE', '微信仅提供了加密资源标识，暂未取得图片内容'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/(^|\.)(qpic\.cn|weixin\.qq\.com|wx\.qq\.com|wxapp\.tc\.qq\.com)$/.test(url.hostname))
    throw new ChannelError('IMAGE_URL_INVALID', '图片资源地址不是可读取的微信媒体地址');
  url.protocol = 'https:';
  return url;
}
export async function loadObservedMedia({ directory, peerId, messageId, resourceId, signal, fetcher = fetch }) {
  if (!/^[a-f0-9]{64}$/.test(resourceId || '') || typeof peerId !== 'string' || typeof messageId !== 'string')
    throw new ChannelError('IMAGE_ID_INVALID', '图片的消息标识无效');
  const descriptorFile = path.join(directory, resourceId + '.json');
  if (!fs.existsSync(descriptorFile) || !inside(directory, descriptorFile)) throw new ChannelError('IMAGE_UNAVAILABLE', '这条图片的原始资源已不存在');
  let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8')); }
  catch { throw new ChannelError('IMAGE_INVALID', '图片资源描述无法读取'); }
  if (descriptor.messageId !== `${peerId}:${messageId}`) throw new ChannelError('IMAGE_OWNER_MISMATCH', '图片不属于当前会话和消息，未读取');
  const local = path.join(directory, resourceId + '.image');
  let content;
  if (fs.existsSync(local)) {
    if (!inside(directory, local) || fs.statSync(local).size > MAX_IMAGE_BYTES) throw new ChannelError('IMAGE_INVALID', '图片文件不在当前账号目录中，或超过 10 MiB');
    content = fs.readFileSync(local);
  } else {
    const resource = descriptor.resources?.find(item => /^https?:\/\//i.test(item.reference));
    if (!resource) throw new ChannelError('IMAGE_UNAVAILABLE', '微信没有下发可解码的图片，只保留了加密 CDN 标识；目前无法理解这张图，不能根据占位文字猜测');
    let url = allowedMediaUrl(resource.reference), response;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    for (let hop = 0; hop < 3; hop++) {
      response = await fetcher(url, { signal: combined, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || hop === 2) throw new ChannelError('IMAGE_DOWNLOAD_FAILED', '微信图片地址跳转失败');
        url = allowedMediaUrl(new URL(location, url).href); continue;
      }
      break;
    }
    if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new ChannelError('IMAGE_DOWNLOAD_FAILED', '微信图片下载失败，可能已过期'); }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_IMAGE_BYTES) throw new ChannelError('IMAGE_TOO_LARGE', '图片超过 10 MiB，未交给模型'); chunks.push(value); }
    } finally { await reader.cancel(); }
    content = Buffer.concat(chunks);
    if (resource.size && content.length !== resource.size || resource.md5 && createHash('md5').update(content).digest('hex') !== resource.md5)
      throw new ChannelError('IMAGE_INTEGRITY_FAILED', '图片大小或摘要与这条消息不符，未交给模型');
    try { imageMime(content); } catch { throw new ChannelError('IMAGE_ENCRYPTED', '下载的媒体仍为加密内容，暂时无法理解，原始资源描述已保留'); }
    signal.throwIfAborted(); fs.writeFileSync(local, content, { mode: 0o600 });
  }
  let mediaType;
  try { mediaType = imageMime(content); } catch { throw new ChannelError('IMAGE_INVALID', '图片内容无法解码为 PNG、JPEG、GIF 或 WebP'); }
  signal.throwIfAborted();
  return { data: content.toString('base64'), mediaType };
}
