import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';

const policy = 'moments-content-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Review the proposal before spending on an image, then the actual pixels.
 * A saved approval is usable only for the exact content, image and materials. */
export async function reviewMomentsContent(channel, run, image, signal, check) {
  check();
  const refs = run.materialContextRefs || run.selectedMaterials || [], store = channel.momentsAutomation?.materials;
  if (refs.length) store.assertSelection(run.accountId, refs);
  const materials = (run.selectedMaterials || []).map(ref => {
    const item = store.item(run.accountId, ref.id);
    return { id: ref.id, revision: item.revision, title: item.fields.title, text: item.fields.text, origin: item.origin };
  });
  const phase = image ? 'image' : 'proposal';
  const input = { phase, theme: run.theme, text: run.text, imagePrompt: run.imagePrompt || '',
    imageMode: run.settings.image.mode, imagePlanned: !!image || run.settings.image.mode === 'ai' || !!run.imageMaterialId,
    themes: run.settings.themes, instruction: run.settings.instructions, imageInstructions: run.settings.image.instructions, materials };
  const fingerprint = hash([policy, input, refs, image ? run.image.sha256 : null]);
  if (run.contentReviews?.[phase]?.fingerprint === fingerprint) return false;
  const result = await channel.runner.run({ mode: 'moments-content-review', tools: [], signal, allowEmptyReply: true,
    systemOverride: readPrompt('moments/content-review.md'), text: JSON.stringify(input),
    ...(image ? { images: [{ type: 'image', data: image.data, mediaType: image.mediaType }] } : {}) });
  check(); if (refs.length) store.assertSelection(run.accountId, refs);
  let review;
  try { review = JSON.parse(String(result?.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch {}
  if (!review || Array.isArray(review) || Object.keys(review).some(key => !['ok', 'reason'].includes(key)) ||
      typeof review.ok !== 'boolean' || typeof review.reason !== 'string' || review.reason.length > 240 || !review.ok && !review.reason.trim())
    throw new ChannelError('MOMENTS_CONTENT_REVIEW_FAILED', '未取得有效的正文与配图检查结果，草稿已保留，未发布');
  if (!review.ok) throw new ChannelError('MOMENTS_CONTENT_MISMATCH', '内容检查未通过：' + review.reason.trim() + '；草稿已保留，未发布');
  run.contentReviews = { ...run.contentReviews, [phase]: { fingerprint, reviewedAt: channel.now() } };
  return true;
}
