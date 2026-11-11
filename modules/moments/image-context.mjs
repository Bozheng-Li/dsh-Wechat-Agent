import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { prepareMomentsVisionImage } from './image-stream.mjs';
import { interactionContentHash } from './post-content.mjs';

export const momentsImageContextVersion = 1;
const invalid = () => { throw new ChannelError('MOMENTS_IMAGE_CONTEXT', '朋友圈图片、正文或作者与本次目标不一致，未用于评论'); };
export async function readMomentsImageContext(channel, { accountId, scopeKey, postId, expectedHash }, signal, check) {
  check(); if (!momentsId(postId)) invalid();
  if (channel.store.modelConfig?.().vision === false)
    throw new ChannelError('MOMENTS_IMAGE_VISION_DISABLED', '图片理解已在设置中关闭，未读取画面或生成图片评论');
  if (typeof channel.transport.readMomentsImages !== 'function')
    throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '当前组件尚不支持读取朋友圈图片，未根据图片张数猜测内容');
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]);
  const result = await channel.transport.readMomentsImages({ accountId, scopeKey, query: { postId } }, combined); check(); combined.throwIfAborted();
  const post = result?.post;
  if (result?.accountId !== accountId || result.postId !== postId || result.source !== 'wechat-sns-images-live' || result.complete !== true ||
      post?.id !== postId || typeof post.author?.userId !== 'string' || !post.author.userId || !post.contentAvailable || post.deleted ||
      typeof post.text !== 'string' || !Number.isSafeInteger(post.createdAt) || !Number.isInteger(post.imageCount) || post.imageCount < 0 || post.imageCount > 9 ||
      !Array.isArray(result.items) || result.items.length !== post.imageCount || result.imageCount !== post.imageCount) invalid();
  const contentHash = interactionContentHash(post);
  if (expectedHash && contentHash !== expectedHash) invalid();
  const photos = post.media?.filter(row => row.type === 'image') ?? [];
  if (photos.length !== post.imageCount) invalid();
  let total = 0;
  const images = result.items.map((image, offset) => {
    if (image.index !== offset + 1 || image.mediaId !== photos[offset].id || typeof image.data !== 'string' || image.data.length > 14 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(image.sha256)) invalid();
    const bytes = Buffer.from(image.data, 'base64'); total += bytes.length;
    if (total > 30 * 1024 * 1024 || bytes.toString('base64') !== image.data || bytes.length !== image.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256) invalid();
    // Verify the complete downloaded bytes above; send only the actual raster
    // stream to vision, excluding the SNS CDN's trailing JPEG metadata.
    const { content, info } = prepareMomentsVisionImage(bytes);
    if (info.mediaType !== image.mediaType) invalid();
    return { type: 'image', data: content.toString('base64'), mediaType: image.mediaType };
  });
  let descriptions = [];
  if (images.length) {
    const response = await channel.runner.run({ mode: 'moments-image-read', tools: [], images, signal: combined, allowEmptyReply: true,
      systemOverride: readPrompt('moments/image-read.md'), text: JSON.stringify({ postId, text: post.text, imageCount: images.length }) });
    check(); combined.throwIfAborted(); let value;
    try { value = JSON.parse(String(response?.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch {}
    if (!value || Object.keys(value).some(key => key !== 'images') || !Array.isArray(value.images) || value.images.length !== images.length ||
        value.images.some((row, index) => !row || row.index !== index + 1 || typeof row.readable !== 'boolean' ||
          typeof row.description !== 'string' || !row.description.trim() || row.description.length > 1500 ||
          Object.keys(row).some(key => !['index', 'description', 'readable'].includes(key))))
      throw new ChannelError('MOMENTS_IMAGE_DESCRIPTION', '图片理解没有返回逐图对应的有效信息，未混用画面生成评论');
    descriptions = value.images;
  }
  check();
  return { version: momentsImageContextVersion, accountId, postId, source: 'wechat-sns-images-live', contentHash,
    author: { userId: post.author.userId, nickname: post.author.nickname ?? '' }, createdAt: post.createdAt, text: post.text,
    imageCount: images.length, complete: descriptions.every(row => row.readable), mediaContentIncluded: images.length > 0, readAt: channel.now(),
    images: descriptions.map((row, index) => ({ index: row.index, mediaId: result.items[index].mediaId,
      sha256: result.items[index].sha256, readable: row.readable, description: row.description.trim() })) };
}
