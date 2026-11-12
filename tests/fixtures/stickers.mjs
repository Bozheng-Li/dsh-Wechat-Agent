import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const stickerDigest = (data, algorithm = 'md5') => createHash(algorithm).update(data).digest('hex');
export function stickerPng(rgb = [220, 66, 66], width = 2, height = 2) {
  const crc = data => { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (kind, data) => { const name = Buffer.from(kind), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
export const stickerGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export function stickerJpeg() {
  const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const pixels = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xc0, Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([1, 2, 3, 0xff, 0xd9])]);
  return { pixels, original: Buffer.concat([pixels, Buffer.from('wechat-cdn-extra-metadata')]) };
}
