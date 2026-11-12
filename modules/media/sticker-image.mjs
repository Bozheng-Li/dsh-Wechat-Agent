import { inspectAssetImage } from './image-format.mjs';
import { prepareWechatImageStream } from './wechat-image-stream.mjs';
import { MEDIA_LIBRARY_LIMITS } from './limits.mjs';
import { error } from './validation.mjs';

const invalid = () => { throw error('STICKER_IMAGE_INVALID', '表情图片不完整或附加内容异常，未保存错误图片'); };
function gifEnd(bytes) {
  if (bytes.length < 14) return;
  let at = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frame = false;
  const blocks = () => {
    while (at < bytes.length) {
      const size = bytes[at++]; if (size === 0) return true;
      if (at + size > bytes.length) return false; at += size;
    }
    return false;
  };
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3b) return frame ? at : undefined;
    if (marker === 0x21) { if (at >= bytes.length) return; at++; if (!blocks()) return; }
    else if (marker === 0x2c) {
      if (at + 9 > bytes.length) return;
      const packed = bytes[at + 8]; at += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (at >= bytes.length) return; at++;
      if (!blocks()) return; frame = true;
    } else return;
  }
}

// Keep the server-verified file for native identity. Decode previews and image
// fallbacks from the complete raster stream, excluding WeChat's short trailer.
export function prepareStickerImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MEDIA_LIBRARY_LIMITS.imageBytes) invalid();
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return prepareWechatImageStream(bytes);
  let end = bytes.length;
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) end = gifEnd(bytes);
  else if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    end = undefined;
    for (let at = 8; at + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(at), next = at + size + 12;
      if (next > bytes.length) break;
      if (bytes.toString('ascii', at + 4, at + 8) === 'IEND') { end = next; break; }
      at = next;
    }
  } else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    end = bytes.readUInt32LE(4) + 8;
  if (!Number.isSafeInteger(end) || end < 1 || end > bytes.length || bytes.length - end > 64 * 1024) invalid();
  const content = bytes.subarray(0, end);
  return { content, info: inspectAssetImage(content), trailerBytes: bytes.length - end };
}
