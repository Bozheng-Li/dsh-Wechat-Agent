import { inflateRawSync } from 'node:zlib';
import { MEDIA_LIBRARY_LIMITS, IMAGE_EXTENSIONS, UNSAFE_EXTENSIONS } from "./limits.mjs";
import { error } from "./validation.mjs";
import { crc32, inspectAssetImage } from "./image-format.mjs";

export function zipName(raw) {
  let name;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    try {
      name = new TextDecoder('gb18030', { fatal: true }).decode(raw);
    } catch {
      throw error('ASSET_ZIP_INVALID', 'ZIP 文件名编码无法读取，请用 UTF-8 重新打包');
    }
  }
  if (
    !name ||
    name.length > 1000 ||
    /[\u0000-\u001f\u007f:]/u.test(name) ||
    /^[\\/]/.test(name) ||
    name
      .replaceAll('\\', '/')
      .split('/')
      .some((part) => part === '..')
  )
    throw error('ASSET_ZIP_PATH', 'ZIP 包含越界或无效路径，未导入任何文件');
  return name.replaceAll('\\', '/');
}

export function readAssetZip(data) {
  if (!Buffer.isBuffer(data) || data.length > MEDIA_LIBRARY_LIMITS.uploadBytes || data.length < 22)
    throw error('ASSET_ZIP_INVALID', 'ZIP 为空、损坏或超过 32 MiB');
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) {
      end = at;
      break;
    }
  }
  if (
    end < 0 ||
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    data.readUInt16LE(end + 8) !== data.readUInt16LE(end + 10)
  )
    throw error('ASSET_ZIP_INVALID', '不支持分卷或损坏的 ZIP');
  const count = data.readUInt16LE(end + 10),
    centralSize = data.readUInt32LE(end + 12),
    centralOffset = data.readUInt32LE(end + 16);
  if (
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    count > MEDIA_LIBRARY_LIMITS.zipEntries ||
    centralOffset + centralSize !== end
  )
    throw error('ASSET_ZIP_INVALID', 'ZIP 条目过多，或使用了不支持的 ZIP64 格式');
  const entries = [],
    ranges = [];
  let at = centralOffset,
    expanded = 0,
    imageCount = 0,
    skipped = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw error('ASSET_ZIP_INVALID', 'ZIP 文件目录损坏');
    const flags = data.readUInt16LE(at + 8),
      method = data.readUInt16LE(at + 10),
      checksum = data.readUInt32LE(at + 16),
      compressed = data.readUInt32LE(at + 20),
      uncompressed = data.readUInt32LE(at + 24);
    const nameSize = data.readUInt16LE(at + 28),
      extraSize = data.readUInt16LE(at + 30),
      commentSize = data.readUInt16LE(at + 32),
      disk = data.readUInt16LE(at + 34),
      attributes = data.readUInt32LE(at + 38),
      local = data.readUInt32LE(at + 42);
    const next = at + 46 + nameSize + extraSize + commentSize;
    if (
      next > end ||
      disk ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      local === 0xffffffff ||
      flags & 0x2041 ||
      ![0, 8].includes(method)
    )
      throw error('ASSET_ZIP_INVALID', 'ZIP 含有加密文件、未知压缩方式或损坏条目');
    const nameBytes = data.subarray(at + 46, at + 46 + nameSize),
      name = zipName(nameBytes),
      unixMode = attributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000 || (unixMode & 0xf000 && ![0x8000, 0x4000].includes(unixMode & 0xf000)))
      throw error('ASSET_ZIP_LINK', 'ZIP 含有链接或特殊文件，未导入任何文件');
    if (UNSAFE_EXTENSIONS.test(name)) throw error('ASSET_ZIP_UNSAFE', 'ZIP 含有程序、脚本或链接文件，请只打包图片');
    expanded += uncompressed;
    if (expanded > MEDIA_LIBRARY_LIMITS.expandedBytes)
      throw error('ASSET_ZIP_TOO_LARGE', 'ZIP 解压后的总大小超过 64 MiB');
    const directory = name.endsWith('/') || (unixMode & 0xf000) === 0x4000;
    const selected = !directory && !name.startsWith('__MACOSX/') && IMAGE_EXTENSIONS.test(name);
    if (
      selected &&
      (++imageCount > MEDIA_LIBRARY_LIMITS.imagesPerImport || uncompressed > MEDIA_LIBRARY_LIMITS.imageBytes)
    )
      throw error('ASSET_ZIP_TOO_LARGE', '每次最多导入 300 张图片，单张最多 10 MiB');
    if (
      local + 30 > centralOffset ||
      data.readUInt32LE(local) !== 0x04034b50 ||
      data.readUInt16LE(local + 6) !== flags ||
      data.readUInt16LE(local + 8) !== method
    )
      throw error('ASSET_ZIP_INVALID', 'ZIP 数据区与目录不匹配');
    const localNameSize = data.readUInt16LE(local + 26),
      localExtraSize = data.readUInt16LE(local + 28),
      start = local + 30 + localNameSize + localExtraSize,
      stop = start + compressed;
    if (stop > centralOffset || !data.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes))
      throw error('ASSET_ZIP_INVALID', 'ZIP 文件名或长度校验失败');
    if (
      !(flags & 8) &&
      (data.readUInt32LE(local + 14) !== checksum ||
        data.readUInt32LE(local + 18) !== compressed ||
        data.readUInt32LE(local + 22) !== uncompressed)
    )
      throw error('ASSET_ZIP_INVALID', 'ZIP 数据长度校验失败');
    ranges.push([local, stop]);
    if (selected) entries.push({ name, checksum, method, compressed, uncompressed, start, stop });
    else if (!directory) skipped++;
    at = next;
  }
  if (at !== end) throw error('ASSET_ZIP_INVALID', 'ZIP 目录边界不正确');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index && range[0] < ranges[index - 1][1]))
    throw error('ASSET_ZIP_INVALID', 'ZIP 文件数据重叠');
  if (!entries.length) throw error('ASSET_ZIP_EMPTY', 'ZIP 中没有可导入的 PNG、JPEG、GIF 或 WebP 图片');
  const images = entries.map((entry) => {
    let content;
    try {
      content =
        entry.method === 0
          ? Buffer.from(data.subarray(entry.start, entry.stop))
          : inflateRawSync(data.subarray(entry.start, entry.stop), {
              maxOutputLength: Math.min(entry.uncompressed + 1, MEDIA_LIBRARY_LIMITS.imageBytes + 1),
            });
    } catch {
      throw error('ASSET_ZIP_INVALID', 'ZIP 解压失败或实际内容超过声明大小');
    }
    if (content.length !== entry.uncompressed || crc32(content) !== entry.checksum)
      throw error('ASSET_ZIP_INVALID', 'ZIP 图片的大小或 CRC 校验失败');
    return { name: entry.name, data: content, info: inspectAssetImage(content) };
  });
  return { images, skipped };
}
