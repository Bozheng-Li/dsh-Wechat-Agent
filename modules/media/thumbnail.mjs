import { spawn } from 'node:child_process';
import { resourcePath } from '../../backend/platform/resources.mjs';
import { inspectAssetImage } from './image-format.mjs';
import { prepareStickerImage } from './sticker-image.mjs';
import { error } from './validation.mjs';

export async function assetThumbnail(library, accountId, assetId, signal = new AbortController().signal) {
  signal.throwIfAborted();
  const asset = library.getContent(accountId, assetId, { enabledOnly: false });
  if (['image/png', 'image/jpeg'].includes(asset.mediaType) && asset.bytes <= 300 * 1024 && asset.width <= 640 && asset.height <= 640)
    return { data: asset.nativeSticker ? prepareStickerImage(Buffer.from(asset.data, 'base64')).content.toString('base64') : asset.data, mediaType: asset.mediaType };
  const key = accountId + ':' + asset.id + ':' + (asset.contentSha256 || asset.id);
  library.thumbnails ??= new Map();
  if (library.thumbnails.has(key)) return library.thumbnails.get(key);
  const bytes = await new Promise((resolve, reject) => {
    const child = spawn(library.pythonPath, ['-B', resourcePath('runtime', 'make_image_memory_thumbnail.py')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, failure, settled = false;
    const stop = cause => { failure ||= cause; child.kill(); };
    const abort = () => stop(signal.reason || error('CANCELLED', '表情预览已取消'));
    const timer = setTimeout(() => stop(error('ASSET_THUMBNAIL_FAILED', '表情预览生成超时，可点击查看原图')), 10000);
    const finish = cause => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      cause ? reject(cause) : resolve(Buffer.concat(chunks));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) stop(error('ASSET_THUMBNAIL_FAILED', '表情预览过大')); else chunks.push(chunk); });
    child.stdin.on('error', () => {});
    child.once('error', () => finish(error('ASSET_THUMBNAIL_FAILED', '图片预览组件尚未就绪，可点击查看原图')));
    child.once('close', code => finish(failure || (code !== 0 ? error('ASSET_THUMBNAIL_FAILED', '表情预览暂不可用，可点击查看原图') : undefined)));
    child.stdin.end(Buffer.from(asset.data, 'base64'));
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const current = library.resolveAsset(accountId, assetId, { enabledOnly: false });
  if ((current.contentSha256 || current.id) !== (asset.contentSha256 || asset.id)) throw error('ASSET_CHANGED', '表情原图已更新，请重新读取预览');
  const info = inspectAssetImage(bytes);
  if (info.width > 384 || info.height > 384 || info.mediaType !== 'image/png') throw error('ASSET_THUMBNAIL_FAILED', '表情预览内容无效');
  const result = { data: bytes.toString('base64'), mediaType: info.mediaType };
  // Bound in-memory thumbnails independently of original assets on disk.
  while (library.thumbnails.size >= 48) library.thumbnails.delete(library.thumbnails.keys().next().value);
  library.thumbnails.set(key, result); return result;
}
