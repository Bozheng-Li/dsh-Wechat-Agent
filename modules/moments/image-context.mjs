import { createHash } from 'node:crypto';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { prepareMomentsVisionImage } from './image-stream.mjs';
import { interactionContentHash, readableInteractionText } from './post-content.mjs';
import { authorizationEpoch, assertAuthorizationEpoch } from '../../shared/authorization.mjs';
import { filterAuthorizedMomentsImages } from './read.mjs';

export const momentsImageContextVersion = 1;
const visionBatchSize = 3;
const invalid = () => { throw new ChannelError('MOMENTS_IMAGE_CONTEXT', '朋友圈图片、正文或作者与本次目标不一致，未用于评论'); };
export const readableMomentsImages = context => (context?.images ?? []).filter(image => image.readable === true && typeof image.description === 'string' && image.description.trim());
export const momentsCommentBasis = (text, context) => readableMomentsImages(context).length ? 'images' : readableInteractionText(text) ? 'text' : null;
export const recoverableMomentsImageError = error => !['MOMENTS_IMAGE_CONTEXT', 'ERR_MOMENTS_ACCOUNT_CHANGED', 'ACCOUNT_CHANGED',
  'ERR_MOMENTS_TARGET_UNAVAILABLE', 'ERR_MOMENTS_PROTOCOL', 'MOMENTS_INTERACTION_READ',
  'OBJECT_NOT_AUTHORIZED', 'AUTHORIZATION_CHANGED', 'MOMENTS_AUTHORIZATION_UNVERIFIED'].includes(error?.code);
export function momentsImageFailure(error, stage = 'read') {
  const value = error?.name === 'TimeoutError'
    ? { code: 'MOMENTS_IMAGE_TIMEOUT', message: '配图读取超时，已跳过未读到的图片' }
    : publicError(error, '配图读取失败，已跳过未读到的图片');
  return { code: value.code, message: value.message, stage };
}
export async function readMomentsImageContext(channel, { accountId, scopeKey, postId, expectedHash }, signal, check) {
  const epoch = authorizationEpoch(channel.store, accountId), callerCheck = check;
  check = () => { callerCheck(); signal?.throwIfAborted(); assertAuthorizationEpoch(channel.store, accountId, epoch); };
  check(); if (!momentsId(postId)) invalid();
  if (channel.store.modelConfig?.().vision === false)
    throw new ChannelError('MOMENTS_IMAGE_VISION_DISABLED', '图片理解已在设置中关闭，未读取画面或生成图片评论');
  if (typeof channel.transport.readMomentsImages !== 'function')
    throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '当前组件尚不支持读取朋友圈图片，未根据图片张数猜测内容');
  // Leave time for bounded image downloads and several small vision batches.
  const combined = channel.authorization?.combine(accountId, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(360000)])) ??
    AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(360000)]);
  const params = { accountId, scopeKey, query: { postId } };
  const raw = await channel.transport.readMomentsImages(params, combined); check(); combined.throwIfAborted();
  const result = filterAuthorizedMomentsImages(channel, params, raw);
  const post = result?.post;
  if (result?.accountId !== accountId || result.postId !== postId || result.source !== 'wechat-sns-images-live' || typeof result.complete !== 'boolean' ||
      post?.id !== postId || typeof post.author?.userId !== 'string' || !post.author.userId || !post.contentAvailable || post.deleted ||
      typeof post.text !== 'string' || !Number.isSafeInteger(post.createdAt) || !Number.isInteger(post.imageCount) || post.imageCount < 0 || post.imageCount > 9 ||
      !Array.isArray(result.items) || result.items.length !== post.imageCount || result.imageCount !== post.imageCount ||
      result.complete !== result.items.every(image => !image?.error)) invalid();
  const contentHash = interactionContentHash(post);
  if (expectedHash && contentHash !== expectedHash) invalid();
  channel.personMemory?.captureMoments(accountId, { accountId, source: 'wechat-sns-live', action: 'detail', items: [post] },
    { action: 'detail', postId });
  const photos = post.media?.filter(row => row.type === 'image') ?? [];
  if (photos.length !== post.imageCount) invalid();
  let total = 0, attemptedImageCount = 0;
  const prepared = [], descriptions = result.items.map((image, offset) => {
    if (!image || image.index !== offset + 1 || image.mediaId !== photos[offset].id) invalid();
    const row = { index: offset + 1, mediaId: image.mediaId, readable: false, description: '' };
    if (image.error) {
      if (typeof image.error.code !== 'string' || !/^ERR_MOMENTS_IMAGE_[A-Z_]+$/.test(image.error.code) ||
          typeof image.error.message !== 'string' || !image.error.message.trim() || image.error.message.length > 300 ||
          ['data', 'bytes', 'mediaType', 'sha256'].some(key => Object.hasOwn(image, key))) invalid();
      row.error = { ...publicError(new ChannelError(image.error.code, image.error.message)), stage: 'download' };
      delete row.error.details; row.description = row.error.message; return row;
    }
    try {
      if (typeof image.data !== 'string' || image.data.length > 14 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(image.sha256))
        throw new ChannelError('MOMENTS_IMAGE_INVALID', '图片数据或校验信息不完整，已跳过这张图');
      const bytes = Buffer.from(image.data, 'base64'); total += bytes.length;
      if (total > 30 * 1024 * 1024 || bytes.toString('base64') !== image.data || bytes.length !== image.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== image.sha256)
        throw new ChannelError('MOMENTS_IMAGE_INVALID', '图片数据未通过大小或完整性检查，已跳过这张图');
      row.sha256 = image.sha256;
      // Only the verified raster stream reaches vision, excluding CDN trailers.
      const { content, info } = prepareMomentsVisionImage(bytes);
      if (info.mediaType !== image.mediaType)
        throw new ChannelError('MOMENTS_IMAGE_INVALID', '图片格式与内容不一致，已跳过这张图');
      prepared.push({ row, image: { type: 'image', data: content.toString('base64'), mediaType: info.mediaType } });
    } catch (error) { row.error = momentsImageFailure(error, 'prepare'); row.description = row.error.message; }
    return row;
  });
  for (let offset = 0; offset < prepared.length; offset += visionBatchSize) {
    check(); const batch = prepared.slice(offset, offset + visionBatchSize);
    try {
      combined.throwIfAborted();
      const batchSignal = AbortSignal.any([combined, AbortSignal.timeout(60000)]);
      attemptedImageCount += batch.length;
      const response = await channel.runner.run({ mode: 'moments-image-read', tools: [], images: batch.map(item => item.image),
        signal: batchSignal, assertAllowed: check, allowEmptyReply: true, systemOverride: readPrompt('moments/image-read.md'),
        text: JSON.stringify({ postId, text: post.text, imageCount: batch.length }) });
      check(); batchSignal.throwIfAborted(); let value;
      try { value = JSON.parse(String(response?.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch {}
      const rows = value && Object.keys(value).every(key => key === 'images') && Array.isArray(value.images) ? value.images : [];
      for (const [index, item] of batch.entries()) {
        const matches = rows.filter(row => row?.index === index + 1), row = matches[0];
        if (matches.length !== 1 || !row || typeof row.readable !== 'boolean' || typeof row.description !== 'string' ||
            !row.description.trim() || row.description.length > 1500 || Object.keys(row).some(key => !['index', 'description', 'readable'].includes(key))) {
          item.row.error = { code: 'MOMENTS_IMAGE_DESCRIPTION', message: '图片理解未返回这张图的有效信息，已跳过', stage: 'vision' };
          item.row.description = item.row.error.message; continue;
        }
        item.row.readable = row.readable; item.row.description = row.description.trim();
        if (!row.readable) item.row.error = { code: 'MOMENTS_IMAGE_UNREADABLE', message: '这张图的主要内容未能辨认，已跳过', stage: 'vision' };
      }
    } catch (error) {
      check(); signal?.throwIfAborted();
      if (!recoverableMomentsImageError(error)) throw error;
      for (const item of batch) { item.row.error = momentsImageFailure(error, 'vision'); item.row.description = item.row.error.message; }
    }
  }
  check();
  signal?.throwIfAborted(); const readableImageCount = readableMomentsImages({ images: descriptions }).length;
  return { version: momentsImageContextVersion, accountId, postId, source: 'wechat-sns-images-live', contentHash,
    author: { userId: post.author.userId, nickname: post.author.nickname ?? '' }, createdAt: post.createdAt, text: post.text,
    imageCount: descriptions.length, complete: readableImageCount === descriptions.length, mediaContentIncluded: attemptedImageCount > 0, readAt: channel.now(),
    readableImageCount, failedImageCount: descriptions.length - readableImageCount, images: descriptions };
}
