import { ChannelError } from '../../shared/contracts.mjs';
import { accountId, error } from './validation.mjs';
import { prepareStickerImage } from './sticker-image.mjs';

export function stickerDescriptions(text, count) {
  let values;
  try { values = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {}
  if (!Array.isArray(values) || values.length !== count || values.some(value => !value ||
    typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1000 ||
    typeof value.usage !== 'string' || !value.usage.trim() || value.usage.length > 600 ||
    typeof value.name !== 'string' || !value.name.trim() || value.name.length > 40 ||
    !Array.isArray(value.tags) || value.tags.length > 8 || value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)))
    throw error('STICKER_DESCRIPTION_INVALID', '表情说明与图片不匹配，未保存猜测的使用情景');
  return values.map(value => ({ name: value.name.trim(), description: value.description.trim(), usage: value.usage.trim(), tags: [...new Set(value.tags.map(tag => tag.trim()))] }));
}

// Understanding saved stickers is separate from reading incoming chat images.
// The background service and the owner's explicit action share the same
// revision checks, so a late model response cannot undo edits or deletion.
export async function describeAssets(library, id, assetIds, runner, signal, { assertAllowed = () => {}, onlyMissing = false } = {}) {
  accountId(id); signal.throwIfAborted(); assertAllowed();
  if (library.jobs.get(id)?.running) throw error('ASSET_ANALYSIS_BUSY', '当前账号已有素材正在理解，请等待完成');
  const ids = assetIds ?? library.account(id).assets.filter(asset => !asset.description || asset.kind === 'sticker' && !asset.usage).slice(0, 300).map(asset => asset.id);
  if (!Array.isArray(ids) || ids.length > 300) throw error('ASSET_SELECTION_INVALID', '每次最多理解 300 张素材');
  const selected = [...new Set(ids)].map(assetId => library.resolveAsset(id, assetId, { enabledOnly: false }));
  const targets = selected.filter(asset => asset.bytes > 0);
  if (targets.some(asset => asset.kind === 'sticker') && typeof runner.describeStickers !== 'function')
    throw error('ASSET_VISION_UNAVAILABLE', '当前模型尚未提供表情理解接口，可手动填写含义和适用情景');
  if (targets.some(asset => asset.kind === 'image') && typeof runner.describeImages !== 'function' && typeof runner.describeImage !== 'function')
    throw error('ASSET_VISION_UNAVAILABLE', '当前模型没有可用的图像理解接口');
  const progress = { running: true, total: selected.length, completed: selected.length - targets.length,
    succeeded: 0, failed: 0, skipped: selected.length - targets.length, skippedNoPreview: selected.length - targets.length,
    startedAt: library.now(), finishedAt: null, error: null };
  library.jobs.set(id, progress);
  let activeTargets = [];
  try {
    for (const kind of ['sticker', 'image']) {
      const group = targets.filter(asset => asset.kind === kind);
      for (let at = 0; at < group.length; at += 4) {
        signal.throwIfAborted(); assertAllowed();
        activeTargets = group.slice(at, at + 4);
        const loaded = await Promise.all(activeTargets.map(async asset => {
          try {
            const image = kind === 'sticker' ? await library.thumbnail(id, asset.id, signal) : library.getContent(id, asset.id, { enabledOnly: false });
            const data = asset.nativeSticker ? prepareStickerImage(Buffer.from(image.data, 'base64')).content.toString('base64') : image.data;
            return { asset, image: { data, mediaType: image.mediaType } };
          } catch (failure) { return { asset, failure }; }
        }));
        signal.throwIfAborted(); assertAllowed();
        const usable = loaded.filter(item => item.image);
        let captions = [], modelError;
        if (usable.length) try {
          captions = kind === 'sticker' ? await runner.describeStickers(usable.map(item => item.image), signal)
            : typeof runner.describeImages === 'function' ? await runner.describeImages(usable.map(item => item.image), signal)
              : await Promise.all(usable.map(item => runner.describeImage(item.image, signal)));
          if (kind === 'sticker') captions = stickerDescriptions(JSON.stringify(captions), usable.length);
        } catch (failure) { if (signal.aborted) throw failure; modelError = failure; }
        signal.throwIfAborted(); assertAllowed();
        const committed = { completed: 0, succeeded: 0, failed: 0, skipped: 0 };
        library.mutate(next => {
          const record = library.account(id, true, next);
          for (const item of loaded) {
            const asset = record.assets.find(value => value.id === item.asset.id); committed.completed++;
            if (!asset || asset.revision !== item.asset.revision) { committed.skipped++; continue; }
            const caption = captions?.[usable.findIndex(value => value.asset.id === asset.id)], failure = item.failure || modelError;
            const valid = kind === 'sticker' ? !!caption?.description : typeof caption === 'string' && caption.trim() && caption.length <= 1600;
            if (!failure && valid) {
              if (kind === 'sticker') {
                if (!onlyMissing || !asset.description) asset.description = caption.description;
                if (!onlyMissing || !asset.usage) asset.usage = caption.usage;
                if (!asset.tags.length) asset.tags = caption.tags;
                if (/^(?:收藏|聊天)表情 \d+$/u.test(asset.name)) asset.name = caption.name;
              } else asset.description = caption.trim();
              asset.descriptionError = null; asset.describedAt = library.now(); committed.succeeded++;
            } else {
              asset.descriptionError = failure instanceof ChannelError ? failure.message : '未能理解这张素材，可重试或手动填写含义与适用情景';
              committed.failed++;
            }
            asset.descriptionAttemptedAt = library.now(); asset.revision++; asset.updatedAt = library.now();
          }
        });
        for (const key of Object.keys(committed)) progress[key] += committed[key];
      }
    }
  } catch (failure) {
    if (signal.aborted && signal.reason?.name === 'TimeoutError') {
      let allowed = false; try { assertAllowed(); allowed = true; } catch {}
      if (allowed) library.mutate(next => {
        const record = library.account(id, true, next);
        for (const original of activeTargets) {
          const asset = record.assets.find(value => value.id === original.id);
          if (!asset || asset.revision !== original.revision) continue;
          asset.descriptionError = '素材理解超时，可稍后重试或手动填写含义与适用情景';
          asset.descriptionAttemptedAt = library.now(); asset.revision++; asset.updatedAt = library.now();
        }
      });
    }
    progress.error = signal.aborted ? '素材理解已停止，已完成的结果保留' : failure instanceof ChannelError ? failure.message : '素材理解未完成，已有结果保留';
    throw failure;
  } finally { progress.running = false; progress.finishedAt = library.now(); }
  return structuredClone(progress);
}
