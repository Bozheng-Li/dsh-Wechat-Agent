import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ChannelError } from './contracts.mjs';
import { BuiltinStickerCatalog } from './builtin-stickers.mjs';

const MiB = 1024 * 1024;
export const MEDIA_LIBRARY_LIMITS = Object.freeze({ uploadBytes: 32 * MiB, imageBytes: 10 * MiB, expandedBytes: 64 * MiB,
  imagesPerImport: 300, zipEntries: 1000, accountBytes: 512 * MiB, accountAssets: 2000, chunkBytes: 256 * 1024 });
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/i;
const UNSAFE_EXTENSIONS = /\.(?:exe|com|dll|scr|msi|msp|bat|cmd|ps1|vbs|vbe|js|jse|mjs|cjs|hta|html?|svg|sh|py|jar|lnk|url|reg|app|dmg)$/i;
const SETTINGS = Object.freeze({ enabled: true, probability: 20, minGapMessages: 3 });
const UPLOADED_PACK = 'user-uploads';
const assetPack = asset => asset.packId || UPLOADED_PACK;
const validPackId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const clone = value => structuredClone(value);
const sha = data => createHash('sha256').update(data).digest('hex');
const error = (code, message) => new ChannelError(code, message);
function accountId(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f]/u.test(value)) throw error('ASSET_ACCOUNT_INVALID', '请先选择当前微信账号');
  return value;
}
function decodeBase64(value, limit) {
  if (typeof value !== 'string' || !value || value.length % 4 || value.length > Math.ceil(limit / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw error('ASSET_DATA_INVALID', '上传内容不是有效的图片数据');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > limit || data.toString('base64') !== value) throw error('ASSET_TOO_LARGE', '上传内容为空或超过大小限制');
  return data;
}
function plain(value, label, max, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || !allowEmpty && !value.trim())
    throw error('ASSET_METADATA_INVALID', `${label}${allowEmpty ? '' : '不能为空，且'}最多 ${max} 字`);
  return value.trim();
}
function normalizeKind(kind) { if (!['sticker', 'image'].includes(kind)) throw error('ASSET_KIND_INVALID', '请选择表情包或图片素材'); return kind; }
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); return value >>> 0; });
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 40000000)
    throw error('ASSET_DIMENSIONS_INVALID', '图片尺寸无效或过大，最多 8192 像素、4000 万像素');
  return { width, height };
}
/** Read only raster headers. Images are never interpreted as executable content. */
export function inspectAssetImage(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MEDIA_LIBRARY_LIMITS.imageBytes) throw error('ASSET_TOO_LARGE', '单张图片最多 10 MiB');
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR') {
    let offset = 8, ended = false, pixels = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset), end = offset + 12 + size;
      if (end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw error('ASSET_IMAGE_INVALID', 'PNG 图片数据损坏');
      const type = data.toString('ascii', offset + 4, offset + 8); pixels ||= type === 'IDAT';
      if (type === 'IEND') { ended = size === 0 && end === data.length; break; }
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
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
        return { mediaType: 'image/jpeg', extension: 'jpg', ...dimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)) };
      offset += length;
    }
    throw error('ASSET_IMAGE_INVALID', 'JPEG 图片的尺寸信息无效');
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length) {
    const type = data.toString('ascii', 12, 16); let width, height;
    if (type === 'VP8X') { width = data.readUIntLE(24, 3) + 1; height = data.readUIntLE(27, 3) + 1; }
    else if (type === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) { width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff; }
    else if (type === 'VP8L' && data[20] === 0x2f) { const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    return { mediaType: 'image/webp', extension: 'webp', ...dimensions(width, height) };
  }
  throw error('ASSET_IMAGE_INVALID', '只支持有效的 PNG、JPEG、GIF 和 WebP 图片');
}

function zipName(raw) {
  let name;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { try { name = new TextDecoder('gb18030', { fatal: true }).decode(raw); } catch { throw error('ASSET_ZIP_INVALID', 'ZIP 文件名编码无法读取，请用 UTF-8 重新打包'); } }
  if (!name || name.length > 1000 || /[\u0000-\u001f\u007f:]/u.test(name) || /^[\\/]/.test(name) || name.replaceAll('\\', '/').split('/').some(part => part === '..'))
    throw error('ASSET_ZIP_PATH', 'ZIP 包含越界或无效路径，未导入任何文件');
  return name.replaceAll('\\', '/');
}
export function readAssetZip(data) {
  if (!Buffer.isBuffer(data) || data.length > MEDIA_LIBRARY_LIMITS.uploadBytes || data.length < 22) throw error('ASSET_ZIP_INVALID', 'ZIP 为空、损坏或超过 32 MiB');
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break; }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== data.readUInt16LE(end + 10))
    throw error('ASSET_ZIP_INVALID', '不支持分卷或损坏的 ZIP');
  const count = data.readUInt16LE(end + 10), centralSize = data.readUInt32LE(end + 12), centralOffset = data.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || count > MEDIA_LIBRARY_LIMITS.zipEntries || centralOffset + centralSize !== end)
    throw error('ASSET_ZIP_INVALID', 'ZIP 条目过多，或使用了不支持的 ZIP64 格式');
  const entries = [], ranges = []; let at = centralOffset, expanded = 0, imageCount = 0, skipped = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw error('ASSET_ZIP_INVALID', 'ZIP 文件目录损坏');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), checksum = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), uncompressed = data.readUInt32LE(at + 24);
    const nameSize = data.readUInt16LE(at + 28), extraSize = data.readUInt16LE(at + 30), commentSize = data.readUInt16LE(at + 32), disk = data.readUInt16LE(at + 34), attributes = data.readUInt32LE(at + 38), local = data.readUInt32LE(at + 42);
    const next = at + 46 + nameSize + extraSize + commentSize;
    if (next > end || disk || compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff || flags & 0x2041 || ![0, 8].includes(method)) throw error('ASSET_ZIP_INVALID', 'ZIP 含有加密文件、未知压缩方式或损坏条目');
    const nameBytes = data.subarray(at + 46, at + 46 + nameSize), name = zipName(nameBytes), unixMode = attributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000 || (unixMode & 0xf000) && ![0x8000, 0x4000].includes(unixMode & 0xf000)) throw error('ASSET_ZIP_LINK', 'ZIP 含有链接或特殊文件，未导入任何文件');
    if (UNSAFE_EXTENSIONS.test(name)) throw error('ASSET_ZIP_UNSAFE', 'ZIP 含有程序、脚本或链接文件，请只打包图片');
    expanded += uncompressed;
    if (expanded > MEDIA_LIBRARY_LIMITS.expandedBytes) throw error('ASSET_ZIP_TOO_LARGE', 'ZIP 解压后的总大小超过 64 MiB');
    const directory = name.endsWith('/') || (unixMode & 0xf000) === 0x4000;
    const selected = !directory && !name.startsWith('__MACOSX/') && IMAGE_EXTENSIONS.test(name);
    if (selected && (++imageCount > MEDIA_LIBRARY_LIMITS.imagesPerImport || uncompressed > MEDIA_LIBRARY_LIMITS.imageBytes)) throw error('ASSET_ZIP_TOO_LARGE', '每次最多导入 300 张图片，单张最多 10 MiB');
    if (local + 30 > centralOffset || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method) throw error('ASSET_ZIP_INVALID', 'ZIP 数据区与目录不匹配');
    const localNameSize = data.readUInt16LE(local + 26), localExtraSize = data.readUInt16LE(local + 28), start = local + 30 + localNameSize + localExtraSize, stop = start + compressed;
    if (stop > centralOffset || !data.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)) throw error('ASSET_ZIP_INVALID', 'ZIP 文件名或长度校验失败');
    if (!(flags & 8) && (data.readUInt32LE(local + 14) !== checksum || data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== uncompressed)) throw error('ASSET_ZIP_INVALID', 'ZIP 数据长度校验失败');
    ranges.push([local, stop]);
    if (selected) entries.push({ name, checksum, method, compressed, uncompressed, start, stop }); else if (!directory) skipped++;
    at = next;
  }
  if (at !== end) throw error('ASSET_ZIP_INVALID', 'ZIP 目录边界不正确');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index && range[0] < ranges[index - 1][1])) throw error('ASSET_ZIP_INVALID', 'ZIP 文件数据重叠');
  if (!entries.length) throw error('ASSET_ZIP_EMPTY', 'ZIP 中没有可导入的 PNG、JPEG、GIF 或 WebP 图片');
  const images = entries.map(entry => {
    let content;
    try { content = entry.method === 0 ? Buffer.from(data.subarray(entry.start, entry.stop)) : inflateRawSync(data.subarray(entry.start, entry.stop), { maxOutputLength: Math.min(entry.uncompressed + 1, MEDIA_LIBRARY_LIMITS.imageBytes + 1) }); }
    catch { throw error('ASSET_ZIP_INVALID', 'ZIP 解压失败或实际内容超过声明大小'); }
    if (content.length !== entry.uncompressed || crc32(content) !== entry.checksum) throw error('ASSET_ZIP_INVALID', 'ZIP 图片的大小或 CRC 校验失败');
    return { name: entry.name, data: content, info: inspectAssetImage(content) };
  });
  return { images, skipped };
}

function atomic(file, data) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '-' + randomUUID() + '.tmp');
  try { fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  catch { throw error('STATE_WRITE_FAILED', '素材库未能保存，请检查磁盘空间和目录权限'); }
  finally { try { fs.unlinkSync(temporary); } catch (failure) { if (failure.code !== 'ENOENT') {} } }
}
function settings(input) {
  if (!input || typeof input.enabled !== 'boolean' || !Number.isInteger(input.probability) || input.probability < 0 || input.probability > 100 || !Number.isInteger(input.minGapMessages) || input.minGapMessages < 0 || input.minGapMessages > 100)
    throw error('ASSET_SETTINGS_INVALID', '请设置是否开启，自动使用概率 0–100%，以及至少间隔 0–100 条消息');
  return { enabled: input.enabled, probability: input.probability, minGapMessages: input.minGapMessages };
}

export class MediaLibrary {
  constructor(store, { now = Date.now, pythonPath, conversionTimeoutMs = 15000, builtinCatalog } = {}) {
    this.store = store; this.now = now; this.root = path.resolve(store.root, 'storage/assets'); this.indexFile = path.join(this.root, 'index.json'); this.uploads = new Map(); this.completedUploads = new Map(); this.jobs = new Map();
    this.builtins = builtinCatalog ?? new BuiltinStickerCatalog();
    this.runtimePath = fileURLToPath(new URL('../runtime/', import.meta.url)); this.pythonPath = pythonPath || path.join(this.runtimePath, 'python/python.exe'); this.conversionTimeoutMs = conversionTimeoutMs;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); this.assertLocal(this.root);
    try { this.assertLocal(this.indexFile, false); this.data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); }
    catch (failure) { if (failure.code !== 'ENOENT') throw error('ASSET_INDEX_INVALID', '素材库索引无法读取，未重置已有素材'); }
    this.data ??= { version: 1, ownerStoreId: store.data.storeId, revision: 0, accounts: {} };
    if (this.data.version !== 1 || this.data.ownerStoreId !== store.data.storeId || !this.data.accounts || typeof this.data.accounts !== 'object' || Array.isArray(this.data.accounts)) throw error('ASSET_INDEX_INVALID', '素材库格式或归属有误');
    for (const record of Object.values(this.data.accounts)) {
      if (!record || !Array.isArray(record.assets)) throw error('ASSET_INDEX_INVALID', '素材库条目格式有误');
      settings(record.settings);
      if (record.packs !== undefined && (!record.packs || typeof record.packs !== 'object' || Array.isArray(record.packs) || Object.entries(record.packs).some(([id, pack]) => !validPackId(id) || !pack || typeof pack.enabled !== 'boolean' || typeof pack.name !== 'string'))) throw error('ASSET_INDEX_INVALID', '素材分组设置损坏，未重置已有设置');
      for (const asset of record.assets) if (!/^[a-f0-9]{64}$/.test(asset.id) || !IMAGE_TYPES.has(asset.mediaType) || !['png', 'jpg', 'gif', 'webp'].includes(asset.extension) || typeof asset.enabled !== 'boolean' || typeof asset.name !== 'string' || typeof asset.description !== 'string' || !Array.isArray(asset.tags) || asset.packId !== undefined && !validPackId(asset.packId)) throw error('ASSET_INDEX_INVALID', '素材条目损坏，未读取任意路径');
    }
  }
  assertLocal(file, required = true) {
    const relative = path.relative(this.root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw error('ASSET_PATH_INVALID', '素材不在当前素材库目录中');
    let current = file;
    while (true) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw error('ASSET_PATH_INVALID', '素材目录不能使用重定向链接'); }
      catch (failure) { if (failure.code !== 'ENOENT' || required && current === file) throw failure; }
      if (current === this.root) break;
      current = path.dirname(current);
    }
  }
  account(id, create = false, data = this.data) {
    accountId(id);
    if (create && !Object.hasOwn(data.accounts, id)) Object.defineProperty(data.accounts, id, { value: { settings: { ...SETTINGS }, assets: [] }, enumerable: true, writable: true, configurable: true });
    return Object.hasOwn(data.accounts, id) ? data.accounts[id] : { settings: { ...SETTINGS }, assets: [] };
  }
  folder(id) { accountId(id); return path.join(this.root, sha(id).slice(0, 24)); }
  file(id, asset) { return path.join(this.folder(id), asset.id + '.' + asset.extension); }
  mutate(action) {
    const next = clone(this.data); const result = action(next); next.revision++;
    this.assertLocal(this.indexFile, false); atomic(this.indexFile, next); this.data = next; return result;
  }
  packEnabled(record, packId) {
    return record.packs?.[packId]?.enabled ?? !packId.startsWith('builtin-');
  }
  assetEnabled(record, asset) { return asset.enabled && this.packEnabled(record, assetPack(asset)); }
  packs(id) {
    const record = this.account(id);
    const known = new Set(this.builtins.packs.map(pack => pack.id));
    const imported = new Map(Object.entries(record.packs || {}).filter(([id]) => !known.has(id) && !id.startsWith('builtin-')));
    for (const asset of record.assets) if (!known.has(assetPack(asset)) && !imported.has(assetPack(asset))) imported.set(assetPack(asset), { name: '我导入的图片', enabled: true });
    const counts = packId => {
      const assets = record.assets.filter(asset => assetPack(asset) === packId);
      return { installed: assets.length, enabledAssets: assets.filter(asset => this.assetEnabled(record, asset)).length };
    };
    return [
      ...this.builtins.packs.map(pack => ({ id: pack.id, name: pack.name, description: pack.description, builtin: true, enabled: this.packEnabled(record, pack.id),
        total: pack.items.length, ...counts(pack.id), source: this.builtins.source, previews: pack.items.slice(0, 3).map(({ id, name }) => ({ id, name })) })),
      ...[...imported].map(([id, pack]) => ({ id, name: pack.name, builtin: false, enabled: this.packEnabled(record, id), ...counts(id) }))
    ];
  }
  validatePackSetting(id, packId, enabled) {
    if (!validPackId(packId) || typeof enabled !== 'boolean') throw error('ASSET_PACK_INVALID', '请选择素材分组并设置是否启用');
    const pack = this.packs(id).find(value => value.id === packId);
    if (!pack) throw error('ASSET_PACK_NOT_FOUND', '这组素材不存在，请刷新后重试');
    return { ...pack, assetIds: this.account(id).assets.filter(asset => assetPack(asset) === packId).map(asset => asset.id) };
  }
  configurePack(id, packId, enabled) {
    const pack = this.validatePackSetting(id, packId, enabled);
    if (pack.builtin && enabled) {
      const images = this.builtins.get(packId).items.map(item => {
        const { content } = this.builtins.read(packId, item.id);
        return { name: path.basename(item.file), data: content, info: inspectAssetImage(content), metadata: { name: item.name, description: item.description, tags: item.tags } };
      });
      return { ...this.importImages(id, { images, kind: 'sticker', pack, enablePack: true }), packId, enabled: true };
    }
    this.mutate(data => { const record = this.account(id, true, data); record.packs ??= {}; record.packs[packId] = { name: pack.name, enabled }; });
    return { packId, enabled };
  }
  configure(id, input) { const next = settings(input); this.mutate(data => { this.account(id, true, data).settings = next; }); return this.list(id); }
  list(id, { query = '', kind, packId, enabled, offset = 0, limit = 24 } = {}) {
    const record = this.account(id), normalized = String(query).normalize('NFKC').trim().toLocaleLowerCase();
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw error('ASSET_PAGE_INVALID', '素材分页范围无效');
    const matching = record.assets.filter(asset => (!kind || asset.kind === kind) && (!packId || assetPack(asset) === packId) && (enabled === undefined || this.assetEnabled(record, asset) === enabled) && (!normalized || [asset.name, asset.description, ...asset.tags].join('\n').normalize('NFKC').toLocaleLowerCase().includes(normalized))).sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name, 'zh-CN'));
    return { items: matching.slice(offset, offset + limit).map(asset => ({ ...clone(asset), packId: assetPack(asset), packEnabled: this.packEnabled(record, assetPack(asset)), effectiveEnabled: this.assetEnabled(record, asset) })), total: matching.length, offset, limit, settings: clone(record.settings), revision: this.data.revision, packs: clone(this.packs(id)),
      counts: { all: record.assets.length, enabled: record.assets.filter(asset => this.assetEnabled(record, asset)).length, described: record.assets.filter(asset => asset.description).length, bytes: record.assets.reduce((sum, asset) => sum + asset.bytes, 0) },
      progress: clone(this.jobs.get(id) || null), path: this.folder(id), limits: MEDIA_LIBRARY_LIMITS };
  }
  search(id, query = '', { kind, limit = 12 } = {}) {
    if (!this.account(id).settings.enabled) return [];
    return this.list(id, { query, kind, enabled: true, limit: Math.min(50, Math.max(1, limit)) }).items;
  }
  resolveAsset(id, assetId, { enabledOnly = true } = {}) {
    if (!/^[a-f0-9]{64}$/.test(assetId || '')) throw error('ASSET_NOT_FOUND', '这张素材不存在');
    const record = this.account(id), asset = record.assets.find(value => value.id === assetId);
    if (!asset || enabledOnly && (!record.settings.enabled || !this.assetEnabled(record, asset))) throw error('ASSET_NOT_FOUND', '这张素材不存在、所属分组或素材已停用，或不属于当前账号');
    return clone(asset);
  }
  getContent(id, assetId, options) {
    const asset = this.resolveAsset(id, assetId, options), file = this.file(id, asset);
    try { this.assertLocal(file); const stat = fs.statSync(file); if (!stat.isFile() || stat.size !== asset.bytes || stat.size > MEDIA_LIBRARY_LIMITS.imageBytes) throw error('ASSET_CONTENT_INVALID', '素材文件大小已变化');
      const content = fs.readFileSync(file); if (sha(content) !== asset.id) throw error('ASSET_CONTENT_INVALID', '素材内容已改变，未读取被替换的文件');
      return { ...asset, data: content.toString('base64') };
    } catch (failure) { if (failure instanceof ChannelError) throw failure; throw error('ASSET_CONTENT_MISSING', '素材文件无法读取，可能已被移动或删除'); }
  }
  async prepareSendContent(id, assetId, signal = new AbortController().signal) {
    signal.throwIfAborted(); const asset = this.getContent(id, assetId);
    if (['image/png', 'image/jpeg'].includes(asset.mediaType)) return asset;
    const script = path.join(this.runtimePath, 'prepare_reply_image.py');
    if (!fs.existsSync(script) || path.isAbsolute(this.pythonPath) && !fs.existsSync(this.pythonPath)) throw error('ASSET_CONVERTER_MISSING', '图片转换组件尚未就绪，请安装完整插件包；当前可发送 PNG 或 JPEG');
    const source = Buffer.from(asset.data, 'base64');
    const converted = await new Promise((resolve, reject) => {
      let child, finished = false, bytes = 0, failure, timer; const parts = [];
      const complete = cause => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); cause ? reject(cause) : resolve(Buffer.concat(parts)); };
      const stop = cause => { failure ??= cause; if (child && child.exitCode === null && child.signalCode === null) child.kill(); };
      const abort = () => stop(signal.reason || error('CANCELLED', '图片转换已取消'));
      try {
        child = spawn(this.pythonPath, ['-B', script], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        timer = setTimeout(() => stop(error('ASSET_CONVERSION_TIMEOUT', '图片转换超时，未继续发送')), this.conversionTimeoutMs); timer.unref?.();
        child.once('error', () => complete(error('ASSET_CONVERTER_MISSING', '图片转换组件无法启动，请重新安装完整插件包')));
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MEDIA_LIBRARY_LIMITS.imageBytes) stop(error('ASSET_CONVERTED_TOO_LARGE', '转换后的图片超过 10 MiB，未继续发送')); else parts.push(chunk); });
        let stderr = ''; child.stderr.on('data', chunk => { if (stderr.length < 200) stderr += chunk.toString('utf8').slice(0, 200 - stderr.length); });
        child.stdin.on('error', () => {});
        child.once('close', code => {
          if (failure) complete(failure);
          else if (code !== 0) complete(error(stderr.includes('OUTPUT_TOO_LARGE') ? 'ASSET_CONVERTED_TOO_LARGE' : 'ASSET_CONVERSION_FAILED', stderr.includes('OUTPUT_TOO_LARGE') ? '转换后的图片超过 10 MiB，未继续发送' : 'GIF 或 WebP 不能转换为有效静态图片，请检查素材或换一张'));
          else complete();
        });
        child.stdin.end(source);
      } catch { complete(error('ASSET_CONVERTER_MISSING', '图片转换组件无法启动，请重新安装完整插件包')); }
    });
    signal.throwIfAborted(); const info = inspectAssetImage(converted);
    if (info.mediaType !== 'image/png') throw error('ASSET_CONVERSION_FAILED', '转换组件没有返回有效 PNG，未继续发送');
    // Recheck owner settings and deletion after asynchronous conversion.
    this.resolveAsset(id, assetId);
    return { ...asset, ...info, bytes: converted.length, data: converted.toString('base64'), sourceMediaType: asset.mediaType, staticFrame: true };
  }
  import(id, input) {
    accountId(id); const name = plain(input?.name, '文件名', 1000, false), kind = normalizeKind(input.kind), data = decodeBase64(input.data, MEDIA_LIBRARY_LIMITS.uploadBytes);
    if (!/\.zip$/i.test(name) && !IMAGE_EXTENSIONS.test(name)) throw error('ASSET_IMAGE_INVALID', '请选择 ZIP、PNG、JPEG、GIF 或 WebP 文件');
    const bundle = /\.zip$/i.test(name) ? readAssetZip(data) : { images: [{ name, data, info: inspectAssetImage(data) }], skipped: 0 };
    const packName = name.replaceAll('\\', '/').split('/').at(-1).replace(/\.zip$/i, '').trim().slice(0, 120) || '导入的表情包';
    const pack = /\.zip$/i.test(name) ? { id: 'import-' + sha(packName.normalize('NFKC')).slice(0, 24), name: packName } : { id: UPLOADED_PACK, name: '我导入的图片' };
    return this.importImages(id, { ...bundle, kind, pack });
  }
  importImages(id, { images, skipped = 0, kind, pack, enablePack }) {
    const previous = this.account(id), known = new Set(previous.assets.map(asset => asset.id)), added = [], duplicateIds = [];
    let bytes = previous.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    for (const image of images) {
      const hash = sha(image.data); if (known.has(hash)) { duplicateIds.push(hash); continue; }
      known.add(hash); bytes += image.data.length;
      const basename = image.name.replaceAll('\\', '/').split('/').at(-1).replace(/\.[^.]+$/, '').trim().slice(0, 120) || '未命名图片';
      const folders = image.name.replaceAll('\\', '/').split('/').slice(0, -1).filter(Boolean).slice(-3).map(value => value.slice(0, 40));
      added.push({ content: image.data, asset: { id: hash, name: image.metadata?.name ?? basename, description: image.metadata?.description ?? '', tags: image.metadata?.tags ?? [...new Set(folders)], kind, enabled: true, packId: pack.id, ...image.info,
        bytes: image.data.length, originalName: image.name.slice(0, 1000), createdAt: this.now(), updatedAt: this.now(), revision: 1, descriptionError: null } });
    }
    if (bytes > MEDIA_LIBRARY_LIMITS.accountBytes || previous.assets.length + added.length > MEDIA_LIBRARY_LIMITS.accountAssets) throw error('ASSET_QUOTA', '当前账号素材库最多 2000 张、512 MiB，请先清理不再使用的素材');
    const created = []; fs.mkdirSync(this.folder(id), { recursive: true, mode: 0o700 }); this.assertLocal(this.folder(id));
    try {
      for (const { asset, content } of added) {
        const file = this.file(id, asset); this.assertLocal(file, false);
        if (fs.existsSync(file)) { if (sha(fs.readFileSync(file)) !== asset.id) throw error('ASSET_CONTENT_INVALID', '同名素材文件内容异常，未覆盖'); }
        else { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); created.push(file); }
      }
      if (added.length || enablePack !== undefined) this.mutate(next => {
        const record = this.account(id, true, next); record.packs ??= {};
        record.packs[pack.id] = { name: pack.name, enabled: enablePack ?? this.packEnabled(record, pack.id) };
        record.assets.push(...added.map(value => value.asset));
      });
    } catch (failure) { for (const file of created) { try { this.assertLocal(file); fs.unlinkSync(file); } catch {} } throw failure; }
    return { imported: added.length, duplicates: duplicateIds.length, skipped, assetIds: added.map(value => value.asset.id), duplicateIds, total: this.account(id).assets.length };
  }
  edit(id, assetId, patch) {
    const previous = this.resolveAsset(id, assetId, { enabledOnly: false });
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['name', 'description', 'tags', 'kind', 'enabled', 'revision'].includes(key))) throw error('ASSET_METADATA_INVALID', '素材设置格式无效');
    if (patch.revision !== undefined && patch.revision !== previous.revision) throw error('ASSET_CHANGED', '素材已被更新，请重新打开后编辑');
    const value = { ...previous };
    if (patch.name !== undefined) value.name = plain(patch.name, '素材名称', 120, false);
    if (patch.description !== undefined) { value.description = plain(patch.description, '素材含义', 1600); value.descriptionError = null; }
    if (patch.tags !== undefined) { if (!Array.isArray(patch.tags) || patch.tags.length > 16) throw error('ASSET_METADATA_INVALID', '每张素材最多 16 个标签'); value.tags = [...new Set(patch.tags.map(tag => plain(tag, '标签', 40, false)))]; }
    if (patch.kind !== undefined) value.kind = normalizeKind(patch.kind);
    if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw error('ASSET_METADATA_INVALID', '请选择是否启用这张素材'); value.enabled = patch.enabled; }
    value.revision++; value.updatedAt = this.now();
    this.mutate(next => { const assets = this.account(id, true, next).assets; assets[assets.findIndex(asset => asset.id === assetId)] = value; }); return clone(value);
  }
  remove(id, assetIds) {
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 300) throw error('ASSET_SELECTION_INVALID', '请选择 1–300 张要删除的素材');
    const targets = [...new Set(assetIds)].map(assetId => this.resolveAsset(id, assetId, { enabledOnly: false })), ids = new Set(targets.map(asset => asset.id));
    this.mutate(next => { const record = this.account(id, true, next); record.assets = record.assets.filter(asset => !ids.has(asset.id)); });
    let retainedFiles = 0;
    for (const asset of targets) { try { const file = this.file(id, asset); this.assertLocal(file); fs.unlinkSync(file); } catch (failure) { if (failure.code !== 'ENOENT') retainedFiles++; } }
    return { removed: targets.length, retainedFiles };
  }
  beginUpload(id, input) {
    accountId(id); const name = plain(input?.name, '文件名', 1000, false), kind = normalizeKind(input.kind), size = input.size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MEDIA_LIBRARY_LIMITS.uploadBytes) throw error('ASSET_TOO_LARGE', '单次上传最多 32 MiB');
    if (this.uploads.size >= 8) throw error('ASSET_UPLOAD_BUSY', '同时上传的文件过多，请完成当前上传后再试');
    const uploadId = randomUUID(), directory = path.join(this.root, 'uploads'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); this.assertLocal(directory);
    for (const entry of fs.readdirSync(directory)) if (/^[a-f0-9-]{36}\.part$/.test(entry)) { const file = path.join(directory, entry); this.assertLocal(file); if (this.now() - fs.statSync(file).mtimeMs > 86400000) fs.unlinkSync(file); }
    const file = path.join(directory, uploadId + '.part'); fs.writeFileSync(file, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    this.uploads.set(uploadId, { id: uploadId, accountId: id, name, kind, size, received: 0, file, startedAt: this.now() });
    return { uploadId, chunkBytes: MEDIA_LIBRARY_LIMITS.chunkBytes, received: 0, total: size };
  }
  upload(id, uploadId) {
    accountId(id); const upload = this.uploads.get(uploadId);
    if (!upload || upload.accountId !== id) throw error('ASSET_UPLOAD_MISSING', '上传已结束或不属于当前账号，请重新选择文件');
    return upload;
  }
  appendUpload(id, uploadId, input) {
    const upload = this.upload(id, uploadId), content = decodeBase64(input?.data, MEDIA_LIBRARY_LIMITS.chunkBytes), offset = input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + content.length > upload.size) throw error('ASSET_UPLOAD_INVALID', '上传分块范围无效');
    this.assertLocal(upload.file); const stat = fs.statSync(upload.file);
    if (stat.size !== upload.received) throw error('ASSET_UPLOAD_INVALID', '上传临时文件已变化，请重新上传');
    if (offset < upload.received && offset + content.length <= upload.received) {
      const previous = Buffer.alloc(content.length), descriptor = fs.openSync(upload.file, 'r');
      try { fs.readSync(descriptor, previous, 0, previous.length, offset); } finally { fs.closeSync(descriptor); }
      if (!previous.equals(content)) throw error('ASSET_UPLOAD_INVALID', '重试分块与已接收内容不一致');
    } else {
      if (offset !== upload.received) throw error('ASSET_UPLOAD_INVALID', '上传分块顺序不正确，请重试当前分块');
      fs.appendFileSync(upload.file, content); upload.received += content.length;
    }
    return { uploadId, received: upload.received, total: upload.size };
  }
  finishUpload(id, uploadId) {
    const completed = this.completedUploads.get(uploadId); if (completed?.accountId === id) return clone(completed.result);
    const upload = this.upload(id, uploadId);
    if (upload.received !== upload.size) throw error('ASSET_UPLOAD_INCOMPLETE', '文件尚未上传完整');
    this.assertLocal(upload.file);
    try {
      if (fs.statSync(upload.file).size !== upload.size) throw error('ASSET_UPLOAD_INVALID', '上传临时文件长度已改变，请重新上传');
      const result = this.import(id, { name: upload.name, kind: upload.kind, data: fs.readFileSync(upload.file).toString('base64') });
      this.completedUploads.set(uploadId, { accountId: id, result }); while (this.completedUploads.size > 100) this.completedUploads.delete(this.completedUploads.keys().next().value);
      return clone(result);
    } finally { this.abortUpload(id, uploadId); }
  }
  abortUpload(id, uploadId) {
    const upload = this.uploads.get(uploadId); if (!upload) return { cancelled: false };
    if (upload.accountId !== accountId(id)) throw error('ASSET_UPLOAD_MISSING', '上传不属于当前账号');
    this.assertLocal(upload.file, false); try { fs.unlinkSync(upload.file); } catch (failure) { if (failure.code !== 'ENOENT') throw error('ASSET_UPLOAD_INVALID', '上传已取消，临时文件暂未清理'); }
    this.uploads.delete(uploadId); return { cancelled: true };
  }
  async describe(id, assetIds, runner, signal) {
    accountId(id);
    if (this.jobs.get(id)?.running) throw error('ASSET_ANALYSIS_BUSY', '当前账号已有素材正在理解，请等待完成');
    if (typeof runner.describeImages !== 'function' && typeof runner.describeImage !== 'function') throw error('ASSET_VISION_UNAVAILABLE', '当前模型没有可用的图像理解接口');
    const ids = assetIds === undefined ? this.account(id).assets.filter(asset => !asset.description).map(asset => asset.id) : assetIds;
    if (!Array.isArray(ids) || ids.length > 300) throw error('ASSET_SELECTION_INVALID', '每次最多理解 300 张素材');
    const targets = [...new Set(ids)].map(assetId => this.resolveAsset(id, assetId, { enabledOnly: false }));
    const progress = { running: true, total: targets.length, completed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: this.now(), finishedAt: null, error: null }; this.jobs.set(id, progress);
    try {
      for (let at = 0; at < targets.length; at += 4) {
        signal.throwIfAborted(); const batch = targets.slice(at, at + 4), loaded = batch.map(asset => { try { return { asset, image: this.getContent(id, asset.id, { enabledOnly: false }) }; } catch (failure) { return { asset, failure }; } });
        const usable = loaded.filter(item => item.image); let captions = [], modelError;
        if (usable.length) {
          try { captions = typeof runner.describeImages === 'function' ? await runner.describeImages(usable.map(item => ({ data: item.image.data, mediaType: item.image.mediaType })), signal) : await Promise.all(usable.map(item => runner.describeImage(item.image, signal))); }
          catch (failure) { if (signal.aborted) throw failure; modelError = failure; }
        }
        signal.throwIfAborted();
        const committed = { completed: 0, succeeded: 0, failed: 0, skipped: 0 };
        this.mutate(next => {
          const record = this.account(id, true, next);
          for (const item of loaded) {
            const asset = record.assets.find(value => value.id === item.asset.id); committed.completed++;
            if (!asset || asset.description !== item.asset.description) { committed.skipped++; continue; }
            const caption = captions[usable.findIndex(value => value.asset.id === asset.id)], failure = item.failure || modelError;
            if (!failure && typeof caption === 'string' && caption.trim() && caption.length <= 1600) { asset.description = caption.trim(); asset.descriptionError = null; asset.describedAt = this.now(); committed.succeeded++; }
            else { asset.descriptionError = failure instanceof ChannelError ? failure.message : '未能理解这张素材，可检查模型后重试或手动填写含义'; committed.failed++; }
            asset.revision++; asset.updatedAt = this.now();
          }
        });
        for (const key of Object.keys(committed)) progress[key] += committed[key];
      }
    } catch (failure) { progress.error = signal.aborted ? '素材理解已停止，已完成的结果保留' : failure instanceof ChannelError ? failure.message : '素材理解未完成，已有结果保留'; throw failure; }
    finally { progress.running = false; progress.finishedAt = this.now(); }
    return clone(progress);
  }
  close() { for (const upload of [...this.uploads.values()]) this.abortUpload(upload.accountId, upload.id); }
}
