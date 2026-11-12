import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectAssetImage } from './image-format.mjs';
import { prepareStickerImage } from './sticker-image.mjs';
import { MEDIA_LIBRARY_LIMITS } from './limits.mjs';
import { error } from './validation.mjs';

export const WECHAT_FAVORITES = 'wechat-favorites';
export const CHAT_STICKERS = 'wechat-chat';
export const RETIRED_PACKS = new Set(['builtin-fluent-cats', 'builtin-fluent-animals', 'builtin-fluent-moods']);
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
export const validStickerMd5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// Only the old bundled packs are retired. Identical owner uploads, their
// names and their enabled settings remain under the owner's control.
export function retireBuiltinStickers(library) {
  const removed = [];
  for (const [accountId, record] of Object.entries(library.data.accounts))
    for (const asset of record.assets) if (RETIRED_PACKS.has(asset.packId)) removed.push({ accountId, asset });
  if (!removed.length && !Object.values(library.data.accounts).some(record => Object.keys(record.packs || {}).some(key => RETIRED_PACKS.has(key)))) return;
  library.mutate(data => {
    for (const record of Object.values(data.accounts)) {
      const count = record.assets.filter(asset => RETIRED_PACKS.has(asset.packId)).length;
      record.assets = record.assets.filter(asset => !RETIRED_PACKS.has(asset.packId));
      for (const key of RETIRED_PACKS) if (record.packs) delete record.packs[key];
      if (count) record.retiredBuiltinCount = (record.retiredBuiltinCount || 0) + count;
    }
  });
  for (const { accountId, asset } of removed) {
    const file = library.file(accountId, asset);
    if (library.account(accountId).assets.some(item => library.file(accountId, item) === file)) continue;
    try { library.assertLocal(file); fs.unlinkSync(file); } catch (failure) { if (failure.code !== 'ENOENT') library.retiredFileWarning = true; }
  }
}

export function saveWechatSticker(library, accountId, input) {
  const { md5, source, content, favorite = false } = input;
  if (md5 !== undefined && !validStickerMd5(md5) || !['favorite', 'chat'].includes(source) || !md5 && !content)
    throw error('STICKER_INVALID', '表情来源或标识无效');
  const record = library.account(accountId);
  const contentHash = content && hash(content), id = md5 ? hash('wechat-sticker:' + md5) : contentHash;
  if ([md5, id, contentHash].some(key => key && record.deletedStickers?.includes(key))) return { skipped: true, deleted: true };
  const previous = record.assets.find(asset => asset.nativeSticker?.md5 === md5 && md5 || asset.id === id || contentHash &&
    (asset.contentSha256 || asset.id) === contentHash && (!md5 || !asset.nativeSticker || asset.nativeSticker.md5 === md5));
  const info = content ? md5 ? prepareStickerImage(content).info : inspectAssetImage(content) : {};
  if (content && md5 && input.quality === 'original' && hash(content, 'md5') !== md5)
    throw error('STICKER_CONTENT_MISMATCH', '表情原图与微信标识不匹配，未保存错误内容');
  const keepContent = !!previous?.bytes && (!content || previous.previewQuality === 'original' && input.quality !== 'original');
  const fileInfo = keepContent ? { mediaType: previous.mediaType, extension: previous.extension, width: previous.width, height: previous.height,
    bytes: previous.bytes, contentSha256: previous.contentSha256, previewQuality: previous.previewQuality } : content ? {
      ...info, bytes: content.length, contentSha256: contentHash, previewQuality: input.quality || 'unknown',
    } : { mediaType: null, extension: null, width: 0, height: 0, bytes: 0 };
  const isFavorite = favorite || previous?.nativeSticker?.favorite === true;
  const nativeSticker = md5 ? { md5, favorite: isFavorite } : previous?.nativeSticker;
  const packId = previous && ![WECHAT_FAVORITES, CHAT_STICKERS].includes(previous.packId) ? previous.packId : isFavorite ? WECHAT_FAVORITES : CHAT_STICKERS;
  const asset = {
    ...previous,
    id: previous?.id || id, name: previous?.name || (source === 'favorite' ? '收藏表情 ' : '聊天表情 ') + String(input.ordinal || record.assets.length + 1).padStart(3, '0'),
    description: previous?.description || '', usage: previous?.usage || '', tags: previous?.tags || [], kind: previous?.kind || 'sticker', enabled: previous?.enabled ?? true,
    packId, ...fileInfo, ...(nativeSticker ? { nativeSticker } : {}), source: previous?.source || source,
    ...(previous?.sourceMessage || input.message ? { sourceMessage: previous?.sourceMessage || {
      peerId: input.message.peerId, chatType: input.message.chatType, messageId: input.message.serverMessageId || input.message.id,
      senderId: input.message.sender?.id || input.message.senderId || '',
      receivedAt: input.message.observedAt || library.now(),
    } } : {}),
    createdAt: previous?.createdAt || library.now(), updatedAt: library.now(), revision: (previous?.revision || 0) + 1,
    descriptionError: previous?.descriptionError || null,
  };
  if (previous && previous.bytes === asset.bytes && previous.contentSha256 === asset.contentSha256 && previous.nativeSticker?.md5 === asset.nativeSticker?.md5 && previous.nativeSticker?.favorite === asset.nativeSticker?.favorite && !!previous.sourceMessage === !!asset.sourceMessage)
    return { asset: structuredClone(previous), duplicate: true };
  const totalBytes = record.assets.reduce((sum, item) => sum + item.bytes, 0) - (previous?.bytes || 0) + asset.bytes;
  if (totalBytes > MEDIA_LIBRARY_LIMITS.accountBytes || !previous && record.assets.length >= MEDIA_LIBRARY_LIMITS.accountAssets)
    throw error('ASSET_QUOTA', '当前账号表情库已满，请清理不再使用的素材');
  let created;
  try {
    if (content && !keepContent) {
      fs.mkdirSync(library.folder(accountId), { recursive: true, mode: 0o700 });
      const file = library.file(accountId, asset); library.assertLocal(file, false);
      if (fs.existsSync(file)) {
        if (hash(fs.readFileSync(file)) !== contentHash) throw error('ASSET_CONTENT_INVALID', '已保存表情的内容不一致，未覆盖');
      } else { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); created = file; }
    }
    library.mutate(data => {
      const next = library.account(accountId, true, data); next.packs ??= {};
      next.packs[packId] ??= { name: packId === WECHAT_FAVORITES ? '微信收藏' : '聊天收集', enabled: true };
      const index = next.assets.findIndex(item => item.id === asset.id);
      if (index >= 0) next.assets[index] = asset; else next.assets.push(asset);
    });
  } catch (failure) { if (created) { try { fs.unlinkSync(created); } catch {} } throw failure; }
  return { asset: structuredClone(asset), imported: !previous, updated: !!previous };
}

export function reconcileFavorites(library, accountId, md5s, fetchedAt) {
  const current = new Set(md5s);
  library.mutate(data => {
    const record = library.account(accountId, true, data);
    for (const asset of record.assets) if (asset.nativeSticker?.favorite && !current.has(asset.nativeSticker.md5)) {
      asset.nativeSticker.favorite = false; asset.revision++; asset.updatedAt = library.now();
    }
    record.stickerSync = { state: 'ready', count: current.size, fetchedAt };
  });
}
