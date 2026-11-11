import { ChannelError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { personaInstructions } from '../../prompts/reply/compose.mjs';
import { publicLanguageInstructions } from '../../prompts/reply/language.mjs';

export async function generateInteractionComments(channel, rows, instructions, signal, check) {
  check();
  const response = await channel.runner.run({ mode: 'moments-interaction', tools: [], signal,
    systemOverride: [readPrompt('moments/interactions.md'), personaInstructions(channel.store.persona()), publicLanguageInstructions()].join('\n\n'),
    text: JSON.stringify({ instruction: instructions, posts: rows.map(row => ({ postId: row.postId, text: row.text, imageCount: row.imageCount,
      imageContext: row.imageContext?.complete ? row.imageContext.images.map(image => ({ index: image.index, description: image.description })) : [] })) }) });
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
