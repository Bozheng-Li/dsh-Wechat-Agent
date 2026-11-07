import { resourcePath } from '../../platform/resources.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { ChannelError } from '../../shared/contracts.mjs';
import { BuiltinStickerCatalog } from './builtin-stickers.mjs';
import { MEDIA_LIBRARY_LIMITS, IMAGE_TYPES, IMAGE_EXTENSIONS } from './limits.mjs';
import { error, accountId, decodeBase64, plain, normalizeKind } from './validation.mjs';
import { inspectAssetImage } from './image-format.mjs';
import { readAssetZip } from './zip.mjs';

export const SETTINGS = Object.freeze({ enabled: true, probability: 20, minGapMessages: 3 });

export const UPLOADED_PACK = 'user-uploads';

export const assetPack = (asset) => asset.packId || UPLOADED_PACK;

export const validPackId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);

export const clone = (value) => structuredClone(value);

export const sha = (data) => createHash('sha256').update(data).digest('hex');

export function atomic(file, data) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    throw error('STATE_WRITE_FAILED', '素材库未能保存，请检查磁盘空间和目录权限');
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (failure) {
      if (failure.code !== 'ENOENT') {
      }
    }
  }
}

export function settings(input) {
  if (
    !input ||
    typeof input.enabled !== 'boolean' ||
    !Number.isInteger(input.probability) ||
    input.probability < 0 ||
    input.probability > 100 ||
    !Number.isInteger(input.minGapMessages) ||
    input.minGapMessages < 0 ||
    input.minGapMessages > 100
  )
    throw error('ASSET_SETTINGS_INVALID', '请设置是否开启，自动使用概率 0–100%，以及至少间隔 0–100 条消息');
  return { enabled: input.enabled, probability: input.probability, minGapMessages: input.minGapMessages };
}

export class MediaLibrary {
  constructor(store, { now = Date.now, pythonPath, conversionTimeoutMs = 15000, builtinCatalog } = {}) {
    this.store = store;
    this.now = now;
    this.root = path.resolve(store.root, 'storage/assets');
    this.indexFile = path.join(this.root, 'index.json');
    this.uploads = new Map();
    this.completedUploads = new Map();
    this.jobs = new Map();
    this.builtins = builtinCatalog ?? new BuiltinStickerCatalog();
    this.runtimePath = resourcePath('runtime');
    this.pythonPath = pythonPath || path.join(this.runtimePath, 'python/python.exe');
    this.conversionTimeoutMs = conversionTimeoutMs;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.assertLocal(this.root);
    try {
      this.assertLocal(this.indexFile, false);
      this.data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw error('ASSET_INDEX_INVALID', '素材库索引无法读取，未重置已有素材');
    }
    this.data ??= { version: 1, ownerStoreId: store.data.storeId, revision: 0, accounts: {} };
    if (
      this.data.version !== 1 ||
      this.data.ownerStoreId !== store.data.storeId ||
      !this.data.accounts ||
      typeof this.data.accounts !== 'object' ||
      Array.isArray(this.data.accounts)
    )
      throw error('ASSET_INDEX_INVALID', '素材库格式或归属有误');
    for (const record of Object.values(this.data.accounts)) {
      if (!record || !Array.isArray(record.assets)) throw error('ASSET_INDEX_INVALID', '素材库条目格式有误');
      settings(record.settings);
      if (
        record.packs !== undefined &&
        (!record.packs ||
          typeof record.packs !== 'object' ||
          Array.isArray(record.packs) ||
          Object.entries(record.packs).some(
            ([id, pack]) =>
              !validPackId(id) || !pack || typeof pack.enabled !== 'boolean' || typeof pack.name !== 'string'
          ))
      )
        throw error('ASSET_INDEX_INVALID', '素材分组设置损坏，未重置已有设置');
      for (const asset of record.assets)
        if (
          !/^[a-f0-9]{64}$/.test(asset.id) ||
          !IMAGE_TYPES.has(asset.mediaType) ||
          !['png', 'jpg', 'gif', 'webp'].includes(asset.extension) ||
          typeof asset.enabled !== 'boolean' ||
          typeof asset.name !== 'string' ||
          typeof asset.description !== 'string' ||
          !Array.isArray(asset.tags) ||
          (asset.packId !== undefined && !validPackId(asset.packId))
        )
          throw error('ASSET_INDEX_INVALID', '素材条目损坏，未读取任意路径');
    }
  }
  assertLocal(file, required = true) {
    const relative = path.relative(this.root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw error('ASSET_PATH_INVALID', '素材不在当前素材库目录中');
    let current = file;
    while (true) {
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw error('ASSET_PATH_INVALID', '素材目录不能使用重定向链接');
      } catch (failure) {
        if (failure.code !== 'ENOENT' || (required && current === file)) throw failure;
      }
      if (current === this.root) break;
      current = path.dirname(current);
    }
  }
  account(id, create = false, data = this.data) {
    accountId(id);
    if (create && !Object.hasOwn(data.accounts, id))
      Object.defineProperty(data.accounts, id, {
        value: { settings: { ...SETTINGS }, assets: [] },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return Object.hasOwn(data.accounts, id) ? data.accounts[id] : { settings: { ...SETTINGS }, assets: [] };
  }
  folder(id) {
    accountId(id);
    return path.join(this.root, sha(id).slice(0, 24));
  }
  file(id, asset) {
    return path.join(this.folder(id), asset.id + '.' + asset.extension);
  }
  mutate(action) {
    const next = clone(this.data);
    const result = action(next);
    next.revision++;
    this.assertLocal(this.indexFile, false);
    atomic(this.indexFile, next);
    this.data = next;
    return result;
  }
  packEnabled(record, packId) {
    return record.packs?.[packId]?.enabled ?? !packId.startsWith('builtin-');
  }
  assetEnabled(record, asset) {
    return asset.enabled && this.packEnabled(record, assetPack(asset));
  }
  packs(id) {
    const record = this.account(id);
    const known = new Set(this.builtins.packs.map((pack) => pack.id));
    const imported = new Map(
      Object.entries(record.packs || {}).filter(([id]) => !known.has(id) && !id.startsWith('builtin-'))
    );
    for (const asset of record.assets)
      if (!known.has(assetPack(asset)) && !imported.has(assetPack(asset)))
        imported.set(assetPack(asset), { name: '我导入的图片', enabled: true });
    const counts = (packId) => {
      const assets = record.assets.filter((asset) => assetPack(asset) === packId);
      return {
        installed: assets.length,
        enabledAssets: assets.filter((asset) => this.assetEnabled(record, asset)).length,
      };
    };
    return [
      ...this.builtins.packs.map((pack) => ({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        builtin: true,
        enabled: this.packEnabled(record, pack.id),
        total: pack.items.length,
        ...counts(pack.id),
        source: this.builtins.source,
        previews: pack.items.slice(0, 3).map(({ id, name }) => ({ id, name })),
      })),
      ...[...imported].map(([id, pack]) => ({
        id,
        name: pack.name,
        builtin: false,
        enabled: this.packEnabled(record, id),
        ...counts(id),
      })),
    ];
  }
  validatePackSetting(id, packId, enabled) {
    if (!validPackId(packId) || typeof enabled !== 'boolean')
      throw error('ASSET_PACK_INVALID', '请选择素材分组并设置是否启用');
    const pack = this.packs(id).find((value) => value.id === packId);
    if (!pack) throw error('ASSET_PACK_NOT_FOUND', '这组素材不存在，请刷新后重试');
    return {
      ...pack,
      assetIds: this.account(id)
        .assets.filter((asset) => assetPack(asset) === packId)
        .map((asset) => asset.id),
    };
  }
  configurePack(id, packId, enabled) {
    const pack = this.validatePackSetting(id, packId, enabled);
    if (pack.builtin && enabled) {
      const images = this.builtins.get(packId).items.map((item) => {
        const { content } = this.builtins.read(packId, item.id);
        return {
          name: path.basename(item.file),
          data: content,
          info: inspectAssetImage(content),
          metadata: { name: item.name, description: item.description, tags: item.tags },
        };
      });
      return { ...this.importImages(id, { images, kind: 'sticker', pack, enablePack: true }), packId, enabled: true };
    }
    this.mutate((data) => {
      const record = this.account(id, true, data);
      record.packs ??= {};
      record.packs[packId] = { name: pack.name, enabled };
    });
    return { packId, enabled };
  }
  configure(id, input) {
    const next = settings(input);
    this.mutate((data) => {
      this.account(id, true, data).settings = next;
    });
    return this.list(id);
  }
  list(id, { query = '', kind, packId, enabled, offset = 0, limit = 24 } = {}) {
    const record = this.account(id),
      normalized = String(query).normalize('NFKC').trim().toLocaleLowerCase();
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw error('ASSET_PAGE_INVALID', '素材分页范围无效');
    const matching = record.assets
      .filter(
        (asset) =>
          (!kind || asset.kind === kind) &&
          (!packId || assetPack(asset) === packId) &&
          (enabled === undefined || this.assetEnabled(record, asset) === enabled) &&
          (!normalized ||
            [asset.name, asset.description, ...asset.tags]
              .join('\n')
              .normalize('NFKC')
              .toLocaleLowerCase()
              .includes(normalized))
      )
      .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      items: matching
        .slice(offset, offset + limit)
        .map((asset) => ({
          ...clone(asset),
          packId: assetPack(asset),
          packEnabled: this.packEnabled(record, assetPack(asset)),
          effectiveEnabled: this.assetEnabled(record, asset),
        })),
      total: matching.length,
      offset,
      limit,
      settings: clone(record.settings),
      revision: this.data.revision,
      packs: clone(this.packs(id)),
      counts: {
        all: record.assets.length,
        enabled: record.assets.filter((asset) => this.assetEnabled(record, asset)).length,
        described: record.assets.filter((asset) => asset.description).length,
        bytes: record.assets.reduce((sum, asset) => sum + asset.bytes, 0),
      },
      progress: clone(this.jobs.get(id) || null),
      path: this.folder(id),
      limits: MEDIA_LIBRARY_LIMITS,
    };
  }
  search(id, query = '', { kind, limit = 12 } = {}) {
    if (!this.account(id).settings.enabled) return [];
    return this.list(id, { query, kind, enabled: true, limit: Math.min(50, Math.max(1, limit)) }).items;
  }
  resolveAsset(id, assetId, { enabledOnly = true } = {}) {
    if (!/^[a-f0-9]{64}$/.test(assetId || '')) throw error('ASSET_NOT_FOUND', '这张素材不存在');
    const record = this.account(id),
      asset = record.assets.find((value) => value.id === assetId);
    if (!asset || (enabledOnly && (!record.settings.enabled || !this.assetEnabled(record, asset))))
      throw error('ASSET_NOT_FOUND', '这张素材不存在、所属分组或素材已停用，或不属于当前账号');
    return clone(asset);
  }
  getContent(id, assetId, options) {
    const asset = this.resolveAsset(id, assetId, options),
      file = this.file(id, asset);
    try {
      this.assertLocal(file);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size !== asset.bytes || stat.size > MEDIA_LIBRARY_LIMITS.imageBytes)
        throw error('ASSET_CONTENT_INVALID', '素材文件大小已变化');
      const content = fs.readFileSync(file);
      if (sha(content) !== asset.id) throw error('ASSET_CONTENT_INVALID', '素材内容已改变，未读取被替换的文件');
      return { ...asset, data: content.toString('base64') };
    } catch (failure) {
      if (failure instanceof ChannelError) throw failure;
      throw error('ASSET_CONTENT_MISSING', '素材文件无法读取，可能已被移动或删除');
    }
  }
  async prepareSendContent(id, assetId, signal = new AbortController().signal) {
    signal.throwIfAborted();
    const asset = this.getContent(id, assetId);
    if (['image/png', 'image/jpeg'].includes(asset.mediaType)) return asset;
    const script = path.join(this.runtimePath, 'prepare_reply_image.py');
    if (!fs.existsSync(script) || (path.isAbsolute(this.pythonPath) && !fs.existsSync(this.pythonPath)))
      throw error('ASSET_CONVERTER_MISSING', '图片转换组件尚未就绪，请安装完整插件包；当前可发送 PNG 或 JPEG');
    const source = Buffer.from(asset.data, 'base64');
    const converted = await new Promise((resolve, reject) => {
      let child,
        finished = false,
        bytes = 0,
        failure,
        timer;
      const parts = [];
      const complete = (cause) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        cause ? reject(cause) : resolve(Buffer.concat(parts));
      };
      const stop = (cause) => {
        failure ??= cause;
        if (child && child.exitCode === null && child.signalCode === null) child.kill();
      };
      const abort = () => stop(signal.reason || error('CANCELLED', '图片转换已取消'));
      try {
        child = spawn(this.pythonPath, ['-B', script], {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        timer = setTimeout(
          () => stop(error('ASSET_CONVERSION_TIMEOUT', '图片转换超时，未继续发送')),
          this.conversionTimeoutMs
        );
        timer.unref?.();
        child.once('error', () =>
          complete(error('ASSET_CONVERTER_MISSING', '图片转换组件无法启动，请重新安装完整插件包'))
        );
        child.stdout.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MEDIA_LIBRARY_LIMITS.imageBytes)
            stop(error('ASSET_CONVERTED_TOO_LARGE', '转换后的图片超过 10 MiB，未继续发送'));
          else parts.push(chunk);
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          if (stderr.length < 200) stderr += chunk.toString('utf8').slice(0, 200 - stderr.length);
        });
        child.stdin.on('error', () => {});
        child.once('close', (code) => {
          if (failure) complete(failure);
          else if (code !== 0)
            complete(
              error(
                stderr.includes('OUTPUT_TOO_LARGE') ? 'ASSET_CONVERTED_TOO_LARGE' : 'ASSET_CONVERSION_FAILED',
                stderr.includes('OUTPUT_TOO_LARGE')
                  ? '转换后的图片超过 10 MiB，未继续发送'
                  : 'GIF 或 WebP 不能转换为有效静态图片，请检查素材或换一张'
              )
            );
          else complete();
        });
        child.stdin.end(source);
      } catch {
        complete(error('ASSET_CONVERTER_MISSING', '图片转换组件无法启动，请重新安装完整插件包'));
      }
    });
    signal.throwIfAborted();
    const info = inspectAssetImage(converted);
    if (info.mediaType !== 'image/png') throw error('ASSET_CONVERSION_FAILED', '转换组件没有返回有效 PNG，未继续发送');
    // Recheck owner settings and deletion after asynchronous conversion.
    this.resolveAsset(id, assetId);
    return {
      ...asset,
      ...info,
      bytes: converted.length,
      data: converted.toString('base64'),
      sourceMediaType: asset.mediaType,
      staticFrame: true,
    };
  }
  import(id, input) {
    accountId(id);
    const name = plain(input?.name, '文件名', 1000, false),
      kind = normalizeKind(input.kind),
      data = decodeBase64(input.data, MEDIA_LIBRARY_LIMITS.uploadBytes);
    if (!/\.zip$/i.test(name) && !IMAGE_EXTENSIONS.test(name))
      throw error('ASSET_IMAGE_INVALID', '请选择 ZIP、PNG、JPEG、GIF 或 WebP 文件');
    const bundle = /\.zip$/i.test(name)
      ? readAssetZip(data)
      : { images: [{ name, data, info: inspectAssetImage(data) }], skipped: 0 };
    const packName =
      name
        .replaceAll('\\', '/')
        .split('/')
        .at(-1)
        .replace(/\.zip$/i, '')
        .trim()
        .slice(0, 120) || '导入的表情包';
    const pack = /\.zip$/i.test(name)
      ? { id: 'import-' + sha(packName.normalize('NFKC')).slice(0, 24), name: packName }
      : { id: UPLOADED_PACK, name: '我导入的图片' };
    return this.importImages(id, { ...bundle, kind, pack });
  }
  importImages(id, { images, skipped = 0, kind, pack, enablePack }) {
    const previous = this.account(id),
      known = new Set(previous.assets.map((asset) => asset.id)),
      added = [],
      duplicateIds = [];
    let bytes = previous.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    for (const image of images) {
      const hash = sha(image.data);
      if (known.has(hash)) {
        duplicateIds.push(hash);
        continue;
      }
      known.add(hash);
      bytes += image.data.length;
      const basename =
        image.name
          .replaceAll('\\', '/')
          .split('/')
          .at(-1)
          .replace(/\.[^.]+$/, '')
          .trim()
          .slice(0, 120) || '未命名图片';
      const folders = image.name
        .replaceAll('\\', '/')
        .split('/')
        .slice(0, -1)
        .filter(Boolean)
        .slice(-3)
        .map((value) => value.slice(0, 40));
      added.push({
        content: image.data,
        asset: {
          id: hash,
          name: image.metadata?.name ?? basename,
          description: image.metadata?.description ?? '',
          tags: image.metadata?.tags ?? [...new Set(folders)],
          kind,
          enabled: true,
          packId: pack.id,
          ...image.info,
          bytes: image.data.length,
          originalName: image.name.slice(0, 1000),
          createdAt: this.now(),
          updatedAt: this.now(),
          revision: 1,
          descriptionError: null,
        },
      });
    }
    if (
      bytes > MEDIA_LIBRARY_LIMITS.accountBytes ||
      previous.assets.length + added.length > MEDIA_LIBRARY_LIMITS.accountAssets
    )
      throw error('ASSET_QUOTA', '当前账号素材库最多 2000 张、512 MiB，请先清理不再使用的素材');
    const created = [];
    fs.mkdirSync(this.folder(id), { recursive: true, mode: 0o700 });
    this.assertLocal(this.folder(id));
    try {
      for (const { asset, content } of added) {
        const file = this.file(id, asset);
        this.assertLocal(file, false);
        if (fs.existsSync(file)) {
          if (sha(fs.readFileSync(file)) !== asset.id)
            throw error('ASSET_CONTENT_INVALID', '同名素材文件内容异常，未覆盖');
        } else {
          fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
          created.push(file);
        }
      }
      if (added.length || enablePack !== undefined)
        this.mutate((next) => {
          const record = this.account(id, true, next);
          record.packs ??= {};
          record.packs[pack.id] = { name: pack.name, enabled: enablePack ?? this.packEnabled(record, pack.id) };
          record.assets.push(...added.map((value) => value.asset));
        });
    } catch (failure) {
      for (const file of created) {
        try {
          this.assertLocal(file);
          fs.unlinkSync(file);
        } catch {}
      }
      throw failure;
    }
    return {
      imported: added.length,
      duplicates: duplicateIds.length,
      skipped,
      assetIds: added.map((value) => value.asset.id),
      duplicateIds,
      total: this.account(id).assets.length,
    };
  }
  edit(id, assetId, patch) {
    const previous = this.resolveAsset(id, assetId, { enabledOnly: false });
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => !['name', 'description', 'tags', 'kind', 'enabled', 'revision'].includes(key))
    )
      throw error('ASSET_METADATA_INVALID', '素材设置格式无效');
    if (patch.revision !== undefined && patch.revision !== previous.revision)
      throw error('ASSET_CHANGED', '素材已被更新，请重新打开后编辑');
    const value = { ...previous };
    if (patch.name !== undefined) value.name = plain(patch.name, '素材名称', 120, false);
    if (patch.description !== undefined) {
      value.description = plain(patch.description, '素材含义', 1600);
      value.descriptionError = null;
    }
    if (patch.tags !== undefined) {
      if (!Array.isArray(patch.tags) || patch.tags.length > 16)
        throw error('ASSET_METADATA_INVALID', '每张素材最多 16 个标签');
      value.tags = [...new Set(patch.tags.map((tag) => plain(tag, '标签', 40, false)))];
    }
    if (patch.kind !== undefined) value.kind = normalizeKind(patch.kind);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw error('ASSET_METADATA_INVALID', '请选择是否启用这张素材');
      value.enabled = patch.enabled;
    }
    value.revision++;
    value.updatedAt = this.now();
    this.mutate((next) => {
      const assets = this.account(id, true, next).assets;
      assets[assets.findIndex((asset) => asset.id === assetId)] = value;
    });
    return clone(value);
  }
  remove(id, assetIds) {
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 300)
      throw error('ASSET_SELECTION_INVALID', '请选择 1–300 张要删除的素材');
    const targets = [...new Set(assetIds)].map((assetId) => this.resolveAsset(id, assetId, { enabledOnly: false })),
      ids = new Set(targets.map((asset) => asset.id));
    this.mutate((next) => {
      const record = this.account(id, true, next);
      record.assets = record.assets.filter((asset) => !ids.has(asset.id));
    });
    let retainedFiles = 0;
    for (const asset of targets) {
      try {
        const file = this.file(id, asset);
        this.assertLocal(file);
        fs.unlinkSync(file);
      } catch (failure) {
        if (failure.code !== 'ENOENT') retainedFiles++;
      }
    }
    return { removed: targets.length, retainedFiles };
  }
  beginUpload(id, input) {
    accountId(id);
    const name = plain(input?.name, '文件名', 1000, false),
      kind = normalizeKind(input.kind),
      size = input.size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MEDIA_LIBRARY_LIMITS.uploadBytes)
      throw error('ASSET_TOO_LARGE', '单次上传最多 32 MiB');
    if (this.uploads.size >= 8) throw error('ASSET_UPLOAD_BUSY', '同时上传的文件过多，请完成当前上传后再试');
    const uploadId = randomUUID(),
      directory = path.join(this.root, 'uploads');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertLocal(directory);
    for (const entry of fs.readdirSync(directory))
      if (/^[a-f0-9-]{36}\.part$/.test(entry)) {
        const file = path.join(directory, entry);
        this.assertLocal(file);
        if (this.now() - fs.statSync(file).mtimeMs > 86400000) fs.unlinkSync(file);
      }
    const file = path.join(directory, uploadId + '.part');
    fs.writeFileSync(file, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    this.uploads.set(uploadId, {
      id: uploadId,
      accountId: id,
      name,
      kind,
      size,
      received: 0,
      file,
      startedAt: this.now(),
    });
    return { uploadId, chunkBytes: MEDIA_LIBRARY_LIMITS.chunkBytes, received: 0, total: size };
  }
  upload(id, uploadId) {
    accountId(id);
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.accountId !== id)
      throw error('ASSET_UPLOAD_MISSING', '上传已结束或不属于当前账号，请重新选择文件');
    return upload;
  }
  appendUpload(id, uploadId, input) {
    const upload = this.upload(id, uploadId),
      content = decodeBase64(input?.data, MEDIA_LIBRARY_LIMITS.chunkBytes),
      offset = input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + content.length > upload.size)
      throw error('ASSET_UPLOAD_INVALID', '上传分块范围无效');
    this.assertLocal(upload.file);
    const stat = fs.statSync(upload.file);
    if (stat.size !== upload.received) throw error('ASSET_UPLOAD_INVALID', '上传临时文件已变化，请重新上传');
    if (offset < upload.received && offset + content.length <= upload.received) {
      const previous = Buffer.alloc(content.length),
        descriptor = fs.openSync(upload.file, 'r');
      try {
        fs.readSync(descriptor, previous, 0, previous.length, offset);
      } finally {
        fs.closeSync(descriptor);
      }
      if (!previous.equals(content)) throw error('ASSET_UPLOAD_INVALID', '重试分块与已接收内容不一致');
    } else {
      if (offset !== upload.received) throw error('ASSET_UPLOAD_INVALID', '上传分块顺序不正确，请重试当前分块');
      fs.appendFileSync(upload.file, content);
      upload.received += content.length;
    }
    return { uploadId, received: upload.received, total: upload.size };
  }
  finishUpload(id, uploadId) {
    const completed = this.completedUploads.get(uploadId);
    if (completed?.accountId === id) return clone(completed.result);
    const upload = this.upload(id, uploadId);
    if (upload.received !== upload.size) throw error('ASSET_UPLOAD_INCOMPLETE', '文件尚未上传完整');
    this.assertLocal(upload.file);
    try {
      if (fs.statSync(upload.file).size !== upload.size)
        throw error('ASSET_UPLOAD_INVALID', '上传临时文件长度已改变，请重新上传');
      const result = this.import(id, {
        name: upload.name,
        kind: upload.kind,
        data: fs.readFileSync(upload.file).toString('base64'),
      });
      this.completedUploads.set(uploadId, { accountId: id, result });
      while (this.completedUploads.size > 100) this.completedUploads.delete(this.completedUploads.keys().next().value);
      return clone(result);
    } finally {
      this.abortUpload(id, uploadId);
    }
  }
  abortUpload(id, uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return { cancelled: false };
    if (upload.accountId !== accountId(id)) throw error('ASSET_UPLOAD_MISSING', '上传不属于当前账号');
    this.assertLocal(upload.file, false);
    try {
      fs.unlinkSync(upload.file);
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw error('ASSET_UPLOAD_INVALID', '上传已取消，临时文件暂未清理');
    }
    this.uploads.delete(uploadId);
    return { cancelled: true };
  }
  async describe(id, assetIds, runner, signal) {
    accountId(id);
    if (this.jobs.get(id)?.running) throw error('ASSET_ANALYSIS_BUSY', '当前账号已有素材正在理解，请等待完成');
    const ids =
      assetIds === undefined
        ? this.account(id)
            .assets.filter((asset) => !asset.description)
            .map((asset) => asset.id)
        : assetIds;
    if (!Array.isArray(ids) || ids.length > 300) throw error('ASSET_SELECTION_INVALID', '每次最多理解 300 张素材');
    const selected = [...new Set(ids)].map((assetId) => this.resolveAsset(id, assetId, { enabledOnly: false })),
      targets = selected.filter((asset) => asset.kind === 'image'),
      stickers = selected.length - targets.length;
    if (targets.length && typeof runner.describeImages !== 'function' && typeof runner.describeImage !== 'function')
      throw error('ASSET_VISION_UNAVAILABLE', '当前模型没有可用的图像理解接口');
    const progress = {
      running: true,
      total: selected.length,
      completed: stickers,
      succeeded: 0,
      failed: 0,
      skipped: stickers,
      skippedStickers: stickers,
      startedAt: this.now(),
      finishedAt: null,
      error: null,
    };
    this.jobs.set(id, progress);
    try {
      for (let at = 0; at < targets.length; at += 4) {
        signal.throwIfAborted();
        const batch = targets.slice(at, at + 4),
          loaded = batch.map((asset) => {
            try {
              return { asset, image: this.getContent(id, asset.id, { enabledOnly: false }) };
            } catch (failure) {
              return { asset, failure };
            }
          });
        const usable = loaded.filter((item) => item.image);
        let captions = [],
          modelError;
        if (usable.length) {
          try {
            captions =
              typeof runner.describeImages === 'function'
                ? await runner.describeImages(
                    usable.map((item) => ({ data: item.image.data, mediaType: item.image.mediaType })),
                    signal
                  )
                : await Promise.all(usable.map((item) => runner.describeImage(item.image, signal)));
          } catch (failure) {
            if (signal.aborted) throw failure;
            modelError = failure;
          }
        }
        signal.throwIfAborted();
        const committed = { completed: 0, succeeded: 0, failed: 0, skipped: 0 };
        this.mutate((next) => {
          const record = this.account(id, true, next);
          for (const item of loaded) {
            const asset = record.assets.find((value) => value.id === item.asset.id);
            committed.completed++;
            if (!asset || asset.revision !== item.asset.revision || asset.description !== item.asset.description) {
              committed.skipped++;
              continue;
            }
            const caption = captions[usable.findIndex((value) => value.asset.id === asset.id)],
              failure = item.failure || modelError;
            if (!failure && typeof caption === 'string' && caption.trim() && caption.length <= 1600) {
              asset.description = caption.trim();
              asset.descriptionError = null;
              asset.describedAt = this.now();
              committed.succeeded++;
            } else {
              asset.descriptionError =
                failure instanceof ChannelError ? failure.message : '未能理解这张素材，可检查模型后重试或手动填写含义';
              committed.failed++;
            }
            asset.revision++;
            asset.updatedAt = this.now();
          }
        });
        for (const key of Object.keys(committed)) progress[key] += committed[key];
      }
    } catch (failure) {
      progress.error = signal.aborted
        ? '素材理解已停止，已完成的结果保留'
        : failure instanceof ChannelError
          ? failure.message
          : '素材理解未完成，已有结果保留';
      throw failure;
    } finally {
      progress.running = false;
      progress.finishedAt = this.now();
    }
    return clone(progress);
  }
  close() {
    for (const upload of [...this.uploads.values()]) this.abortUpload(upload.accountId, upload.id);
  }
}
