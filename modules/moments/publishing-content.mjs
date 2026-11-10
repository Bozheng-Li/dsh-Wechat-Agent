import { ChannelError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { personaInstructions } from '../../prompts/reply/compose.mjs';
import { publicLanguageInstructions } from '../../prompts/reply/language.mjs';

const normalize = text => String(text).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function similarMomentsText(left, right) {
  const a = normalize(left), b = normalize(right);
  if (!a || !b) return false; if (a === b) return true; if (Math.min(a.length, b.length) < 20) return false;
  const grams = text => new Set(Array.from({ length: text.length - 2 }, (_, i) => text.slice(i, i + 3))), x = grams(a), y = grams(b);
  const overlap = [...x].filter(item => y.has(item)).length;
  return overlap / (x.size + y.size - overlap) >= 0.8;
}
export async function generateMomentsContent(channel, settings, recentPosts, at, signal, check) {
  check(); let research = null;
  if (settings.research) {
    const provider = channel.runner.search?.forConfig(channel.store.modelConfig());
    if (!provider?.search) throw new ChannelError('MOMENTS_RESEARCH_UNAVAILABLE', '本计划要求联网取材，但搜索服务尚未就绪，未生成或发布');
    const result = await provider.search({ query: settings.researchQuery.trim() || settings.themes.join(' ').slice(0, 240), maxResults: 5 }, AbortSignal.any([signal, AbortSignal.timeout(30000)])); check();
    const sources = (result.sources ?? []).filter(source => { try { return ['http:', 'https:'].includes(new URL(source.url).protocol); } catch { return false; } }).slice(0, 5)
      .map(source => ({ title: String(source.title ?? '').slice(0, 300), url: String(source.url).slice(0, 4096), snippet: String(source.snippet ?? '').slice(0, 1500) }));
    if (!sources.length) throw new ChannelError('MOMENTS_RESEARCH_EMPTY', '联网取材没有取得可核对的来源，本轮未发布');
    research = { content: String(result.content ?? '').slice(0, 8000), sources };
  }
  const result = await channel.runner.run({ mode: 'moments-publish', tools: [], allowEmptyReply: true, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    systemOverride: [readPrompt('moments/publish.md'), personaInstructions(channel.store.persona()), publicLanguageInstructions()].join('\n\n'),
    text: JSON.stringify({ themes: settings.themes, style: settings.style, instruction: settings.instructions, maxChars: settings.maxChars,
      scheduledAt: new Date(at).toISOString(), timezone: settings.schedule.timezone, image: settings.image.mode === 'ai', imageInstructions: settings.image.instructions,
      recentPosts: recentPosts.slice(0, 20).map(text => String(text).slice(0, 2000)), research }) });
  check(); let generated;
  try { generated = JSON.parse(String(result?.text ?? '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim()); } catch {}
  if (!generated || typeof generated !== 'object' || Array.isArray(generated) || Object.keys(generated).some(key => !['theme', 'text', 'imagePrompt'].includes(key)) ||
      !settings.themes.includes(generated.theme) || typeof generated.text !== 'string' || !generated.text.trim() || generated.text.trim().length > settings.maxChars ||
      typeof generated.imagePrompt !== 'string' || generated.imagePrompt.length > 12000 || settings.image.mode === 'ai' && !generated.imagePrompt.trim())
    throw new ChannelError('MOMENTS_CONTENT_INVALID', 'AI 没有返回符合主题、字数和配图要求的完整内容，未发布；本次不自动重复生成');
  const text = generated.text.trim();
  if (recentPosts.some(previous => similarMomentsText(previous, text))) throw new ChannelError('MOMENTS_CONTENT_DUPLICATE', '生成内容与近期动态过于相似，已跳过本次发布；未自动重复生成');
  return { theme: generated.theme, text, imagePrompt: generated.imagePrompt.trim(), sources: research?.sources ?? [] };
}
