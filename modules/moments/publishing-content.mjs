import { ChannelError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { personaInstructions } from '../../prompts/reply/compose.mjs';
import { publicLanguageInstructions } from '../../prompts/reply/language.mjs';
import { visibleMomentsText } from '../../shared/moments-publishing.mjs';

const normalize = text => String(text).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}\p{S}]/gu, '');
export function similarMomentsText(left, right) {
  if (String(left).trim() && String(left).normalize('NFKC').trim() === String(right).normalize('NFKC').trim()) return true;
  const a = normalize(left), b = normalize(right);
  if (!a || !b) return false; if (a === b) return true; if (Math.min(a.length, b.length) < 20) return false;
  const grams = text => new Set(Array.from({ length: text.length - 2 }, (_, i) => text.slice(i, i + 3))), x = grams(a), y = grams(b);
  const overlap = [...x].filter(item => y.has(item)).length;
  return overlap / (x.size + y.size - overlap) >= 0.8;
}
export async function generateMomentsContent(channel, settings, recentPosts, at, signal, check, onStage = () => {}) {
  check(); let research = null;
  const materialStore = channel.momentsAutomation?.materials;
  let materials = settings.useMaterials || settings.image.mode === 'library'
    ? (materialStore?.candidates(channel.transport.status().account.id) ?? []).filter(item => settings.useMaterials || item.kind === 'image') : [];
  if (settings.research) {
    onStage('research');
    const provider = channel.runner.search?.forConfig(channel.store.modelConfig());
    if (!provider?.search) throw new ChannelError('MOMENTS_RESEARCH_UNAVAILABLE', '本计划要求联网取材，但搜索服务尚未就绪，未生成或发布');
    const result = await provider.search({ query: settings.researchQuery.trim() || settings.themes.join(' ').slice(0, 240) || '科技 艺术 生活 有趣发现', maxResults: 5 }, signal); check();
    const sources = (result.sources ?? []).filter(source => { try { return ['http:', 'https:'].includes(new URL(source.url).protocol); } catch { return false; } }).slice(0, 5)
      .map(source => ({ title: String(source.title ?? '').slice(0, 300), url: String(source.url).slice(0, 4096), snippet: String(source.snippet ?? '').slice(0, 1500) }));
    if (!sources.length) throw new ChannelError('MOMENTS_RESEARCH_EMPTY', '联网取材没有取得可核对的来源，本轮未发布');
    research = { content: String(result.content ?? '').slice(0, 8000), sources };
  }
  // Research, text and images share the operation's five-minute deadline.
  onStage('text');
  const originalRefs = materials.map(item => ({ id: item.id, revision: item.revision }));
  const imported = [], webTools = settings.useMaterials || settings.image.mode === 'library' ? materialStore?.webTools(channel.transport.status().account.id, signal, check, imported) || [] : [];
  const result = await channel.runner.run({ mode: 'moments-publish', tools: webTools, allowEmptyReply: true, signal,
    systemOverride: [readPrompt('moments/publish.md'), personaInstructions(channel.store.persona()), publicLanguageInstructions()].join('\n\n'),
    text: JSON.stringify({ themes: settings.themes, style: settings.style, instruction: settings.instructions, maxChars: settings.maxChars,
      scheduledAt: new Date(at).toISOString(), timezone: settings.schedule.timezone, image: settings.image.mode === 'ai', imageInstructions: settings.image.instructions,
      imageMode: settings.image.mode, materials, recentPosts: recentPosts.slice(0, 20).map(text => String(text).slice(0, 2000)), research }) });
  check();
  if (imported.length) {
    const current = materialStore.candidates(channel.transport.status().account.id);
    const allowed = new Set([...materials.map(item => item.id), ...imported.map(item => item.id)]);
    materials = current.filter(item => allowed.has(item.id) && (settings.useMaterials || item.kind === 'image'));
  }
  let generated;
  try { generated = JSON.parse(String(result?.text ?? '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim()); } catch {}
  if (generated?.skip === true && !settings.themes.length && typeof generated.reason === 'string' && generated.reason.trim() && generated.reason.length <= 200)
    throw new ChannelError('MOMENTS_NOTHING_TO_SHARE', '这次暂无合适内容，已跳过；不会为了凑次数发布');
  if (!generated || typeof generated !== 'object' || Array.isArray(generated) || Object.keys(generated).some(key => !['theme', 'text', 'imagePrompt', 'materialIds', 'imageMaterialId'].includes(key)) ||
      typeof generated.theme !== 'string' || !generated.theme.trim() || generated.theme.length > 200 || settings.themes.length && !settings.themes.includes(generated.theme) || !visibleMomentsText(generated.text) || generated.text.trim().length > settings.maxChars ||
      typeof generated.imagePrompt !== 'string' || generated.imagePrompt.length > 12000 || settings.image.mode === 'ai' && !generated.imagePrompt.trim())
    throw new ChannelError('MOMENTS_CONTENT_INVALID', 'AI 没有返回符合主题、字数和配图要求的完整内容，未发布；本次不自动重复生成');
  const selected = generated.materialIds ?? [], imageId = generated.imageMaterialId || '';
  if (!Array.isArray(selected) || selected.length > 3 || selected.some(id => !materials.some(item => item.id === id)) ||
    typeof imageId !== 'string' || imageId && (settings.image.mode !== 'library' || !materials.some(item => item.id === imageId && item.kind === 'image' && item.imageUse === 'publish')))
    throw new ChannelError('MOMENTS_CONTENT_INVALID', 'AI 选择了不可用的素材或图片，未发布');
  const selectedMaterials = [...new Set([...selected, ...(imageId ? [imageId] : [])])].map(id => {
    const item = materials.find(item => item.id === id); return { id, revision: item.revision, title: item.title, kind: item.kind };
  });
  const text = generated.text.trim();
  if (recentPosts.some(previous => similarMomentsText(previous, text))) throw new ChannelError('MOMENTS_CONTENT_DUPLICATE', '生成内容与近期动态过于相似，已跳过本次发布；未自动重复生成');
  return { theme: generated.theme, text, imagePrompt: generated.imagePrompt.trim(), selectedMaterials, imageMaterialId: imageId,
    materialContextRefs: [...new Map([...materials.map(item => ({ id: item.id, revision: item.revision })), ...originalRefs].map(ref => [ref.id, ref])).values()],
    sources: [...(research?.sources ?? []), ...materials.filter(item => selected.includes(item.id) && item.url).map(item => ({ title: item.title, url: item.url }))] };
}
