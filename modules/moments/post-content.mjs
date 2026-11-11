import { createHash } from 'node:crypto';

// Counts and comments can change without changing the content being answered.
export const interactionContentHash = post => createHash('sha256').update(JSON.stringify([post.id, post.author.userId,
  post.createdAt, post.text, post.imageCount, post.contentAvailable, post.media?.map(item => [item.id, item.type]) ?? []])).digest('hex');
