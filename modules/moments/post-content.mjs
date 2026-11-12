import { createHash } from 'node:crypto';

// Emoji labels and links alone do not provide a topic for a text-only reply.
export const readableInteractionText = text => typeof text === 'string' && /[\p{L}\p{N}]/u.test(text
  .replace(/https?:\/\/\S+/gi, '').replace(/\[[^\]\r\n]{1,24}\]/g, '').replace(/\/[a-zA-Z:;()~*<>@#&!^\\-]{1,12}/g, ''));

// Counts and comments can change without changing the content being answered.
export const interactionContentHash = post => createHash('sha256').update(JSON.stringify([post.id, post.author.userId,
  post.createdAt, post.text, post.imageCount, post.contentAvailable, post.media?.map(item => [item.id, item.type]) ?? []])).digest('hex');
