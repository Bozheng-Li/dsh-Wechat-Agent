import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { generateMomentsContent } from './publishing-content.mjs';
import { reviewMomentsContent } from './publishing-review.mjs';

const imageFileErrors = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EIO', 'ENOSPC']);
export function canOmitMomentsImage(error) {
  if (error?.code === 'IMAGE_GENERATION_CHANGED') return false;
  return error?.name === 'TimeoutError' || /^(?:IMAGE_GENERATION_|MOMENTS_IMAGE_)/.test(error?.code || '') ||
    ['MOMENTS_MATERIAL_IMAGE', 'MOMENTS_CONTENT_MISMATCH', 'ASSET_IMAGE_INVALID', 'ASSET_TOO_LARGE', 'ASSET_DIMENSIONS_INVALID'].includes(error?.code) || imageFileErrors.has(error?.code);
}

export function omitMomentsImage(run, error) {
  if (imageFileErrors.has(error?.code)) error = new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '本地配图文件无法读取或保存');
  const failure = publicError(error, '配图暂不可用');
  const reason = error?.name === 'TimeoutError' ? '配图等待超时。' : failure.code === 'MOMENTS_CONTENT_MISMATCH' ? '图文匹配检查未通过。'
    : /NETWORK|HTTP|DOWNLOAD/.test(failure.code) ? '配图网络请求未完成。' : /UNAVAILABLE|UNCONFIGURED|DISABLED/.test(failure.code) ? '配图服务或文件暂不可用。' : '';
  run.textOnly = true;
  run.fallbacks = [...(run.fallbacks || []).filter(item => item.kind !== 'image'), {
    kind: 'image', code: failure.code,
    message: '配图失败，已改为纯文字。' + reason,
  }];
  if (error?.imageGeneration) {
    const { providerId, providerName, model, response, stage, networkCode, elapsedMs } = error.imageGeneration;
    run.imageGeneration = { providerId, providerName, model, response, stage, networkCode, elapsedMs };
  }
}

/** Reuse a standalone draft. At most one text-only revision removes references
 * to a missing image; it never researches, generates an image or publishes. */
export async function reviewMomentsTextOnly(channel, run, recentPosts, signal, check) {
  check();
  try { return await reviewMomentsContent(channel, run, null, signal, check); }
  catch (error) {
    check();
    if (error?.code !== 'MOMENTS_CONTENT_MISMATCH') throw error;
  }
  const original = run.text;
  const settings = { ...run.settings, research: false, useMaterials: false,
    image: { ...run.settings.image, mode: 'none', instructions: '' } };
  const revised = await generateMomentsContent(channel, settings, recentPosts, run.scheduledAt, signal, check, () => {}, { fallbackText: original });
  check();
  run.textBeforeFallback ??= original;
  run.text = revised.text; run.theme = revised.theme;
  await reviewMomentsContent(channel, run, null, signal, check);
  return true;
}
