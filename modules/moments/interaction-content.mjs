import { ChannelError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { personaInstructions } from '../../prompts/reply/compose.mjs';
import { publicLanguageInstructions } from '../../prompts/reply/language.mjs';
import { momentsPersonMemory } from '../memory/roles/tool.mjs';
import { ROLE_CARD_READING_PROMPT } from '../../prompts/memory/role-card.mjs';
import { readableMomentsImages } from './image-context.mjs';

export async function generateInteractionComments(channel, rows, instructions, signal, check, accountId = channel.transport?.status().account?.id) {
  check();
  const personMemory = momentsPersonMemory(channel, accountId, rows.map(row => ({ id: row.userId, name: row.nickname })), check, rows.map(row => row.text).join('\n'));
  const response = await channel.runner.run({ mode: 'moments-interaction', tools: personMemory.tools, signal, assertAllowed: check,
    systemOverride: [readPrompt('moments/interactions.md'), personaInstructions(channel.store.persona()), publicLanguageInstructions(), ROLE_CARD_READING_PROMPT].join('\n\n'),
    text: JSON.stringify({ instruction: instructions, personMemory: personMemory.context, posts: rows.map(row => ({ postId: row.postId, authorId: row.userId, text: row.text, imageCount: row.imageCount,
      imageContext: readableMomentsImages(row.imageContext).map(image => ({ index: image.index, description: image.description })),
      unreadImageCount: row.imageCount - readableMomentsImages(row.imageContext).length })) }) });
  check(); let result;
  try { result = JSON.parse(String(response?.text ?? '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim()); } catch {}
  if (!result || !Array.isArray(result.comments) || Object.keys(result).some(key => key !== 'comments') || result.comments.length !== rows.length ||
      new Set(result.comments.map(row => row?.postId)).size !== rows.length || result.comments.some(row => !row ||
        Object.keys(row).some(key => !['postId', 'text', 'skipReason'].includes(key)) || !rows.some(post => post.postId === row.postId) ||
        typeof row.text !== 'string' || row.text.length > 500 || typeof row.skipReason !== 'string' || row.skipReason.length > 200 ||
        !row.text.trim() && !row.skipReason.trim() || row.text.trim() && row.skipReason.trim()))
    throw new ChannelError('MOMENTS_INTERACTION_CONTENT', '模型未返回与每条动态对应的有效评论，未提交任何评论；可手动填写或重新生成');
  return new Map(result.comments.map(row => [row.postId, { text: row.text.trim(), skipReason: row.skipReason.trim() }]));
}
