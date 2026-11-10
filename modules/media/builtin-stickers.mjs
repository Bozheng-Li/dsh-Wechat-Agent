import { resourcePath } from "../../backend/platform/resources.mjs";
import fs from 'node:fs';
import path from 'node:path';

import { createHash } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";

const defaultRoot = resourcePath('assets', 'stickers');
const invalid = () =>
  new ChannelError('ASSET_PACK_INVALID', '内置表情包目录不完整，请重新安装完整插件包；已有素材和设置会保留');

export class BuiltinStickerCatalog {
  constructor(root = defaultRoot) {
    this.root = path.resolve(root);
    try {
      const manifest = JSON.parse(fs.readFileSync(this.localFile('manifest.json'), 'utf8'));
      if (
        manifest.version !== 1 ||
        !Array.isArray(manifest.packs) ||
        !manifest.source?.license ||
        !manifest.source?.url?.startsWith('https://')
      )
        throw invalid();
      this.source = manifest.source;
      this.packs = manifest.packs;
      this.assets = new Map();
      const packIds = new Set();
      for (const pack of this.packs) {
        if (
          !/^builtin-[a-z0-9-]{1,60}$/.test(pack.id) ||
          packIds.has(pack.id) ||
          typeof pack.name !== 'string' ||
          !Array.isArray(pack.items) ||
          !pack.items.length
        )
          throw invalid();
        packIds.add(pack.id);
        for (const item of pack.items) {
          if (
            !/^[a-f0-9]{64}$/.test(item.id) ||
            this.assets.has(item.id) ||
            typeof item.name !== 'string' ||
            typeof item.description !== 'string' ||
            !Array.isArray(item.tags) ||
            item.file !== pack.id + '/' + path.basename(item.file || '') ||
            !/^[a-z0-9_-]+\.png$/.test(path.basename(item.file)) ||
            item.mediaType !== 'image/png' ||
            item.extension !== 'png' ||
            !Number.isSafeInteger(item.bytes) ||
            item.bytes < 33 ||
            item.bytes > 10 * 1024 * 1024
          )
            throw invalid();
          this.assets.set(item.id, { ...item, packId: pack.id });
        }
      }
    } catch (failure) {
      if (failure instanceof ChannelError) throw failure;
      throw invalid();
    }
  }
  localFile(name) {
    const file = path.resolve(this.root, name),
      relative = path.relative(this.root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw invalid();
    let current = file;
    while (true) {
      if (fs.lstatSync(current).isSymbolicLink()) throw invalid();
      if (current === this.root) break;
      current = path.dirname(current);
    }
    return file;
  }
  get(packId) {
    const pack = this.packs.find((pack) => pack.id === packId);
    if (!pack) throw new ChannelError('ASSET_PACK_NOT_FOUND', '这组表情包不存在，请刷新后重试');
    return pack;
  }
  read(packId, assetId) {
    this.get(packId);
    const asset = this.assets.get(assetId);
    if (!asset || asset.packId !== packId) throw new ChannelError('ASSET_NOT_FOUND', '这张图片不属于所选内置表情包');
    try {
      const file = this.localFile(asset.file),
        stat = fs.statSync(file);
      if (!stat.isFile() || stat.size !== asset.bytes) throw invalid();
      const content = fs.readFileSync(file);
      if (createHash('sha256').update(content).digest('hex') !== asset.id) throw invalid();
      return { ...asset, content };
    } catch (failure) {
      if (failure instanceof ChannelError) throw failure;
      throw invalid();
    }
  }
  preview(packId, assetId) {
    const { content, ...asset } = this.read(packId, assetId);
    return { ...asset, data: content.toString('base64') };
  }
}
