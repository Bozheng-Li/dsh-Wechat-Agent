import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageMime } from "./media.ts";
import { ChannelError } from "../../../shared/contracts.mjs";

import { prepareWechatImageStream } from '../../../modules/media/wechat-image-stream.mjs';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function inside(root, file) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !fs.lstatSync(file).isSymbolicLink();
}
function allowedMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ChannelError('IMAGE_UNAVAILABLE', '微信仅提供了加密资源标识，暂未取得图片内容'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/(^|\.)(qpic\.cn|weixin\.qq\.com|wx\.qq\.com|wxapp\.tc\.qq\.com|vweixinf\.tc\.qq\.com)$/.test(url.hostname))
    throw new ChannelError('IMAGE_URL_INVALID', '图片资源地址不是可读取的微信媒体地址');
  // WeChat advertises this emoji CDN over HTTP. Its HTTPS certificate does
  // not cover the hostname, so a forced upgrade makes valid resources fail.
  // Preserve the advertised protocol only for this exact CDN; HTTPS requests
  // still keep normal certificate verification.
  if (url.hostname !== 'vweixinf.tc.qq.com') url.protocol = 'https:';
  return url;
}
async function downloadResource(resource, signal, fetcher) {
  let url = allowedMediaUrl(resource.reference), response;
  for (let hop = 0; hop < 3; hop++) {
    response = await fetcher(url, { signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || hop === 2) throw new ChannelError('IMAGE_DOWNLOAD_FAILED', '微信图片地址跳转失败');
      url = allowedMediaUrl(new URL(location, url).href); continue;
    }
    break;
  }
  if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new ChannelError('IMAGE_DOWNLOAD_FAILED', '微信图片下载失败，可能已过期'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_IMAGE_BYTES) throw new ChannelError('IMAGE_TOO_LARGE', '图片超过 10 MiB，未交给模型'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const content = Buffer.concat(chunks);
  if (resource.size && content.length !== resource.size || resource.md5 && createHash('md5').update(content).digest('hex') !== resource.md5)
    throw new ChannelError('IMAGE_INTEGRITY_FAILED', '图片大小或摘要与这条消息不符，未交给模型');
  try { imageMime(content); } catch { throw new ChannelError('IMAGE_ENCRYPTED', '下载的媒体仍为加密内容，暂时无法理解'); }
  return content;
}
export async function loadObservedMedia({ directory, peerId, messageId, resourceId, signal, fetcher = fetch, downloadOriginal, preferOriginal = false }) {
  signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(resourceId || '') || typeof peerId !== 'string' || typeof messageId !== 'string')
    throw new ChannelError('IMAGE_ID_INVALID', '图片的消息标识无效');
  const descriptorFile = path.join(directory, resourceId + '.json');
  if (!fs.existsSync(descriptorFile) || !inside(directory, descriptorFile)) throw new ChannelError('IMAGE_UNAVAILABLE', '这条图片的原始资源已不存在');
  let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8')); }
  catch { throw new ChannelError('IMAGE_INVALID', '图片资源描述无法读取'); }
  if (descriptor.messageId !== `${peerId}:${messageId}`) throw new ChannelError('IMAGE_OWNER_MISMATCH', '图片不属于当前会话和消息，未读取');
  const local = path.join(directory, resourceId + '.image');
  const cacheFile = quality => path.join(directory, `${resourceId}.${quality}.image`);
  const readLocal = file => {
    if (!fs.existsSync(file)) return null;
    if (!inside(directory, file) || !fs.statSync(file).isFile() || fs.statSync(file).size > MAX_IMAGE_BYTES)
      throw new ChannelError('IMAGE_INVALID', '图片文件不在当前账号目录中，或超过 10 MiB');
    return fs.readFileSync(file);
  };
  const result = (content, quality) => {
    const sourceBytes = content.length;
    // Keep the complete downloaded cache intact; remove only validated JPEG
    // trailer metadata from the pixels sent to storage and vision.
    if (content[0] === 0xff && content[1] === 0xd8) content = prepareWechatImageStream(content).content;
    let mediaType;
    try { mediaType = imageMime(content); } catch { throw new ChannelError('IMAGE_INVALID', '图片内容无法解码为 PNG、JPEG、GIF 或 WebP'); }
    signal.throwIfAborted();
    return { data: content.toString('base64'), mediaType, quality, bytes: content.length,
      ...(sourceBytes !== content.length ? { sourceBytes, trailerBytes: sourceBytes - content.length } : {}),
      ...(quality === 'thumbnail' ? { qualityNote: '目前只取得微信随消息提供的缩略图，细小文字和画面细节尚未核实。' } : {}) };
  };
  const save = (content, quality) => {
    if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_IMAGE_BYTES || !['original', 'full'].includes(quality))
      throw new ChannelError('IMAGE_INVALID', '高清图片内容或大小无效');
    const image = result(content, quality), file = cacheFile(quality), temporary = file + '.' + randomUUID() + '.tmp';
    if (fs.existsSync(file) && !inside(directory, file)) throw new ChannelError('IMAGE_INVALID', '高清图缓存路径无效');
    try {
      fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
      signal.throwIfAborted(); fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return image;
  };
  const cachedOriginal = readLocal(cacheFile('original'));
  if (cachedOriginal) return result(cachedOriginal, 'original');
  const cachedFull = readLocal(cacheFile('full'));
  if (cachedFull && !preferOriginal) return result(cachedFull, 'full');
  const resources = Array.isArray(descriptor.resources) ? descriptor.resources : [];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  let lastError;
  const tryUrls = async quality => {
    for (const resource of resources.filter(item => item.quality === quality && /^https?:\/\//i.test(item.reference)).slice(0, 4)) {
      try {
        deadline.throwIfAborted();
        const content = await downloadResource(resource, deadline, fetcher);
        return quality === 'thumbnail' ? result(content, quality) : save(content, quality === 'medium' ? 'full' : 'original');
      } catch (error) { signal.throwIfAborted(); lastError = error; }
    }
    return null;
  };
  const original = await tryUrls('original'); if (original) return original;
  if (downloadOriginal && descriptor.kind !== 'emoji' && !deadline.aborted) {
    try {
      const acquired = await downloadOriginal({ peerId, messageId, ...descriptor.download, signal: deadline });
      return save(acquired.content, acquired.quality);
    } catch (error) { signal.throwIfAborted(); lastError = error; }
  }
  if (cachedFull) return result(cachedFull, 'full');
  const medium = await tryUrls('medium'); if (medium) return medium;
  const content = readLocal(local);
  if (content) return result(content, descriptor.inlineBytes > 0 && descriptor.kind !== 'emoji' ? 'thumbnail' : 'unknown');
  const thumbnail = await tryUrls('thumbnail'); if (thumbnail) return thumbnail;
  if (lastError instanceof ChannelError) throw lastError;
  throw new ChannelError('IMAGE_UNAVAILABLE', '微信高清图暂未取得，也没有可读取的预览图；资源可能过期，请重新发送图片');
}
