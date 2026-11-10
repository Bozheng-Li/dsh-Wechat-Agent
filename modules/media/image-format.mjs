import { MEDIA_LIBRARY_LIMITS } from "./limits.mjs";
import { error } from "./validation.mjs";

export const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function dimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 40000000
  )
    throw error('ASSET_DIMENSIONS_INVALID', '图片尺寸无效或过大，最多 8192 像素、4000 万像素');
  return { width, height };
}

/** Read only raster headers. Images are never interpreted as executable content. */
export function inspectAssetImage(data, { maxBytes = MEDIA_LIBRARY_LIMITS.imageBytes } = {}) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > maxBytes)
    throw error('ASSET_TOO_LARGE', `单张图片最多 ${maxBytes / 1024 / 1024} MiB`);
  if (
    data.length >= 33 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString('ascii', 12, 16) === 'IHDR'
  ) {
    let offset = 8,
      ended = false,
      pixels = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset),
        end = offset + 12 + size;
      if (end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4))
        throw error('ASSET_IMAGE_INVALID', 'PNG 图片数据损坏');
      const type = data.toString('ascii', offset + 4, offset + 8);
      pixels ||= type === 'IDAT';
      if (type === 'IEND') {
        ended = size === 0 && end === data.length;
        break;
      }
      offset = end;
    }
    if (!ended || !pixels || data.readUInt32BE(8) !== 13) throw error('ASSET_IMAGE_INVALID', 'PNG 图片不完整');
    return { mediaType: 'image/png', extension: 'png', ...dimensions(data.readUInt32BE(16), data.readUInt32BE(20)) };
  }
  if (data.length >= 14 && /^(GIF87a|GIF89a)$/.test(data.toString('ascii', 0, 6)) && data.at(-1) === 0x3b)
    return { mediaType: 'image/gif', extension: 'gif', ...dimensions(data.readUInt16LE(6), data.readUInt16LE(8)) };
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
        length >= 8
      )
        return {
          mediaType: 'image/jpeg',
          extension: 'jpg',
          ...dimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)),
        };
      offset += length;
    }
    throw error('ASSET_IMAGE_INVALID', 'JPEG 图片的尺寸信息无效');
  }
  if (
    data.length >= 30 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP' &&
    data.readUInt32LE(4) + 8 === data.length
  ) {
    const type = data.toString('ascii', 12, 16);
    let width, height;
    if (type === 'VP8X') {
      width = data.readUIntLE(24, 3) + 1;
      height = data.readUIntLE(27, 3) + 1;
    } else if (type === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      width = data.readUInt16LE(26) & 0x3fff;
      height = data.readUInt16LE(28) & 0x3fff;
    } else if (type === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    return { mediaType: 'image/webp', extension: 'webp', ...dimensions(width, height) };
  }
  throw error('ASSET_IMAGE_INVALID', '只支持有效的 PNG、JPEG、GIF 和 WebP 图片');
}
