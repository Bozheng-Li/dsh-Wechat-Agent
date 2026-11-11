import { ChannelError } from '../../shared/contracts.mjs';
import { inspectAssetImage } from './image-format.mjs';

const maxBytes = 10 * 1024 * 1024;
const invalid = () => { throw new ChannelError('WECHAT_IMAGE_INVALID', '微信图片数据不完整，未交给图像理解'); };

// WeChat chat/SNS downloads can append metadata after JPEG EOI (24 observed bytes).
// Walk the JPEG markers: an EOI-looking pair inside EXIF or a comment is data.
function jpegStreamEnd(data) {
  let offset = 2, scan = false, sawScan = false;
  while (offset < data.length) {
    if (scan) {
      offset = data.indexOf(0xff, offset);
      if (offset < 0) return;
    } else if (data[offset] !== 0xff) return;
    while (data[offset] === 0xff) offset++;
    if (offset >= data.length) return;
    const marker = data[offset++];
    if (scan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) return sawScan ? offset : undefined;
    if (marker === 0x01) continue;
    if (marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > data.length) return;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return;
    scan = marker === 0xda || scan && marker === 0xdc;
    sawScan ||= marker === 0xda;
    offset += length;
  }
}

export function prepareWechatImageStream(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) invalid();
  let content = bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const end = jpegStreamEnd(bytes);
    if (!end || bytes.length - end > 64 * 1024) invalid();
    content = bytes.subarray(0, end);
  }
  return { content, info: inspectAssetImage(content, { maxBytes }), trailerBytes: bytes.length - content.length };
}
