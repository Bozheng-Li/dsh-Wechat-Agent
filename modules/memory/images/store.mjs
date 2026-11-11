import { resourcePath } from "../../../backend/platform/resources.mjs";
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { ChannelError } from "../../../shared/contracts.mjs";
import { conversationKey } from "../../../backend/storage/keys.mjs";
import { atomicJson } from "../../../backend/storage/atomic-json.ts";
import { inspectAssetImage } from "../../media/image-format.mjs";
import { DEFAULT_MEMORY_RETENTION_DAYS, defaultMemoryExpiry } from "../../../shared/memory-policy.mjs";
import { IMAGE_MEMORY_COLLECTIONS, imageMemoryCollection, imageMemoryByteLimit, generatedImageMetadata, imageGenerationAt } from '../../../shared/image-memory.mjs';
import { referencedMessageId } from '../../../shared/message-references.mjs';

const sha = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
const fail = (code, message) => new ChannelError(code, message);
const ordinary = (value) => value && typeof value === 'object' && !Array.isArray(value);
const normalized = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase();
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const noSignal = () => new AbortController().signal;
const sourceTime = (value) =>
  Number.isFinite(value) && value > 0 ? Math.trunc(value < 1e12 ? value * 1000 : value) : null;
// Unsent group task images retain the work task's requester boundary. Owner
// management passes no sender; confirmed group images are visible in that room.
const visibleTo = (input, item, before = input.beforeTime ?? Infinity) => input.collection !== 'generated' || !input.senderId ||
  item.generation?.requesterId === input.senderId || imageGenerationAt(item.generation, before)?.deliveryState === 'sent';

export function validateImageMemorySettings(settings) {
  if (
    !ordinary(settings) ||
    typeof settings.enabled !== 'boolean' ||
    (settings.retentionDays !== null &&
      (!Number.isSafeInteger(settings.retentionDays) || settings.retentionDays < 1 || settings.retentionDays > 36500))
  )
    throw fail('INVALID_IMAGE_MEMORY_SETTINGS', '请选择是否保存图片，保留期限为 1–36500 天或长期保存');
  return { enabled: settings.enabled, retentionDays: settings.retentionDays };
}

// Validate ancestors as well as the leaf, including Windows junctions.
function plain(file, directory = false, missing = true) {
  const absolute = path.resolve(file);
  for (let current = absolute; ; current = path.dirname(current)) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat?.isSymbolicLink() || (stat && current !== absolute && !stat.isDirectory()))
      throw fail('IMAGE_MEMORY_INVALID', '图片记忆路径包含重定向链接或无效目录，未读取其他位置');
    if (current === absolute && ((stat && !(directory ? stat.isDirectory() : stat.isFile())) || (!stat && !missing)))
      throw fail('IMAGE_MEMORY_UNAVAILABLE', '保存的图片文件已不存在或无法读取');
    if (path.dirname(current) === current) break;
  }
}
function imageBytes(image, collection) {
  const data = image?.data, maxBytes = imageMemoryByteLimit(collection);
  if (
    typeof data !== 'string' ||
    !data ||
    data.length > Math.ceil(maxBytes / 3) * 4 ||
    data.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw fail('IMAGE_MEMORY_INVALID', `图片记忆需要有效的图片内容，单张最多 ${maxBytes / 1024 / 1024} MiB`);
  const bytes = Buffer.from(data, 'base64');
  let info;
  try {
    info = inspectAssetImage(bytes, { maxBytes });
  } catch {
    throw fail('IMAGE_MEMORY_INVALID', '图片无法解码或超过保存范围，未将其当作已保存');
  }
  if (image.mediaType !== info.mediaType) throw fail('IMAGE_MEMORY_INVALID', '图片内容与格式不匹配，未保存');
  return { bytes, info };
}
function thumbnail(data, signal, pythonPath) {
  const script = resourcePath('runtime', 'make_image_memory_thumbnail.py');
  if (!fs.existsSync(script) || (path.isAbsolute(pythonPath) && !fs.existsSync(pythonPath)))
    throw fail('IMAGE_THUMBNAIL_UNAVAILABLE', '缩略图组件尚未就绪；已保存的图片仍可打开');
  return new Promise((resolve, reject) => {
    let child,
      timer,
      failure,
      done = false,
      size = 0;
    const chunks = [];
    const complete = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(Buffer.concat(chunks));
    };
    const stop = (error) => {
      failure ??= error;
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    };
    const abort = () => stop(signal.reason);
    try {
      child = spawn(pythonPath, ['-B', script], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      timer = setTimeout(
        () => stop(fail('IMAGE_THUMBNAIL_UNAVAILABLE', '生成缩略图超时；已保存的图片仍可打开')),
        15000
      );
      child.once('error', () =>
        complete(fail('IMAGE_THUMBNAIL_UNAVAILABLE', '缩略图组件无法启动；已保存的图片仍可打开'))
      );
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) stop(fail('IMAGE_THUMBNAIL_UNAVAILABLE', '缩略图过大；已保存的图片仍可打开'));
        else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('close', (code) =>
        complete(
          failure ||
            (code !== 0 ? fail('IMAGE_THUMBNAIL_UNAVAILABLE', '缩略图未能生成；已保存的图片仍可打开') : undefined)
        )
      );
      child.stdin.end(data);
    } catch {
      complete(fail('IMAGE_THUMBNAIL_UNAVAILABLE', '缩略图组件无法启动；已保存的图片仍可打开'));
    }
  });
}

/** Owned copies, independent of WeChat cache and text-window compaction. */
export class ImageMemory {
  constructor(store, { now = Date.now, pythonPath, thumbnailMaker } = {}) {
    this.store = store;
    this.now = now;
    this.root = path.join(store.root, 'storage/memory/images');
    this.errors = new Map();
    const bundledPython = resourcePath('runtime', 'python', 'python.exe');
    this.pythonPath = pythonPath || (fs.existsSync(bundledPython) ? bundledPython : 'python');
    this.thumbnailMaker = thumbnailMaker || ((data, signal) => thumbnail(data, signal, this.pythonPath));
  }
  start({ intervalMs = 60000 } = {}) {
    if (this.timer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
      throw new TypeError('Invalid image-memory cleanup interval');
    this.sweep();
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref?.();
  }
  close() {
    clearInterval(this.timer);
    this.timer = null;
  }
  sweep() {
    const accounts = new Set([
      ...Object.keys(this.store.data.accounts),
      ...Object.values(this.store.data.conversations).map((peer) => peer.accountId),
    ]);
    this.sweepError = null;
    for (const accountId of accounts) {
      let peers;
      try {
        peers = this.store.conversations(accountId);
      } catch {
        this.sweepError = '部分会话的图片期限未能检查，请检查会话记录与目录权限';
        continue;
      }
      for (const peer of peers) for (const collection of IMAGE_MEMORY_COLLECTIONS) {
        const scope = this.selector({ ...peer, collection });
        try {
          const index = path.join(this.directory(scope), 'index.json');
          plain(index);
          if (!fs.existsSync(index)) continue;
          const state = this.load(scope); // Expiry is enforced even without a list or model read.
          this.cleanupState(state, Object.keys(state.deleted)); // Retry earlier file-cleanup failures.
        } catch (error) {
          this.errors.set(
            scope.key,
            error instanceof ChannelError ? error.message : '到期图片未能清理，请检查磁盘空间和目录权限'
          );
        }
      }
    }
  }
  selector(input) {
    if (
      !input ||
      typeof input.accountId !== 'string' ||
      !input.accountId ||
      !['group', 'private'].includes(input.chatType) ||
      typeof input.peerId !== 'string'
    )
      throw fail('INVALID_IMAGE_MEMORY_SCOPE', '请先选择图片所属账号和会话');
    const collection = imageMemoryCollection(input.collection),
      conversation = conversationKey(input.accountId, input.chatType, input.peerId),
      key = collection === 'generated' ? sha([conversation, 'generated']) : conversation;
    const known = this.store.conversations(input.accountId).find((peer) => peer.key === conversation);
    if (!known) throw fail('MEMORY_CONVERSATION_MISSING', '请先选择已授权或有历史记录的会话');
    return { accountId: input.accountId, chatType: input.chatType, peerId: input.peerId, key,
      ...(collection === 'generated' ? { collection } : {}) };
  }
  directory(scope) {
    const root = scope.collection === 'generated' ? path.join(this.store.root, 'storage/memory/generated-images') : this.root;
    return path.join(root, sha([scope.accountId]), scope.key);
  }
  file(scope, id, preview = false, digest) {
    if (!validId(id)) throw fail('INVALID_IMAGE_MEMORY_ID', '图片记忆标识无效，请重新选择');
    digest ??= preview ? scope.items?.[id]?.thumbnailDigest : scope.items?.[id]?.digest;
    if (!validId(digest)) throw fail('IMAGE_MEMORY_INVALID', '图片文件摘要无效，未读取');
    const file = path.join(this.directory(scope), id + '.' + digest + (preview ? '.thumbnail.png' : '.image'));
    plain(file);
    return file;
  }
  load(input) {
    const scope = this.selector(input),
      file = path.join(this.directory(scope), 'index.json');
    plain(file);
    let state;
    try {
      state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw fail('IMAGE_MEMORY_INVALID', '图片记忆索引无法读取，原有文件保留，请检查编码和权限');
    }
    state ??= {
      version: 1,
      retentionVersion: 1,
      ownerStoreId: this.store.data.storeId,
      ...scope,
      revision: 0,
      generation: 'initial',
      settings: this.store.config.section('imageMemory')[scope.key] ?? this.store.config.section('imageMemoryDefaults'),
      items: {},
      deleted: {},
    };
    if (state.configurationVersion === 1)
      state.settings = this.store.config.section('imageMemory')[scope.key] ?? this.store.config.section('imageMemoryDefaults');
    if (
      state.version !== 1 ||
      state.ownerStoreId !== this.store.data.storeId ||
      (state.collection ?? 'conversation') !== (scope.collection ?? 'conversation') ||
      ['key', 'accountId', 'chatType', 'peerId'].some((key) => state[key] !== scope[key]) ||
      !ordinary(state.items) ||
      !ordinary(state.deleted) ||
      !ordinary(state.settings) ||
      !Number.isSafeInteger(state.revision) ||
      typeof state.generation !== 'string' ||
      typeof state.settings.enabled !== 'boolean' ||
      (state.settings.retentionDays !== null &&
        (!Number.isSafeInteger(state.settings.retentionDays) ||
          state.settings.retentionDays < 1 ||
          state.settings.retentionDays > 36500))
    )
      throw fail('IMAGE_MEMORY_INVALID', '图片记忆格式或归属不匹配，未混用其他账号和会话');
    for (const [id, item] of Object.entries(state.items)) {
      if (
        !validId(id) ||
        !ordinary(item) ||
        item.id !== id ||
        !validId(item.digest) ||
        !Number.isSafeInteger(item.capturedAt) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 1 ||
        item.bytes > imageMemoryByteLimit(scope.collection) ||
        (scope.collection === 'generated' && !generatedImageMetadata(item.generation)) ||
        typeof item.description !== 'string' ||
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mediaType) ||
        !['original', 'full', 'thumbnail', 'unknown'].includes(item.quality) ||
        (item.expiresAt !== null && (!Number.isSafeInteger(item.expiresAt) || item.expiresAt < 0)) ||
        (item.hasThumbnail && !validId(item.thumbnailDigest))
      )
        throw fail('IMAGE_MEMORY_INVALID', '图片记忆条目损坏，原文件保留');
    }
    if (state.retentionVersion !== 1) {
      if (state.settings.retentionDays === null) {
        state.settings.retentionDays = DEFAULT_MEMORY_RETENTION_DAYS;
        for (const item of Object.values(state.items)) {
          item.retentionStartedAt = this.now();
          item.expiresAt = defaultMemoryExpiry(item.retentionStartedAt);
        }
      }
      state.retentionVersion = 1;
      this.save(state);
    }
    if (state.configurationVersion !== 1) this.save(state);
    const expired = Object.values(state.items)
      .filter((item) => item.expiresAt !== null && item.expiresAt <= this.now())
      .map((item) => item.id);
    if (expired.length) this.removeState(state, expired, 'expired');
    return state;
  }
  save(state) {
    const directory = this.directory(state);
    plain(directory, true);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'index.json');
    plain(file);
    state.revision++;
    try {
      const { settings, ...snapshot } = state;
      this.store.config.update('imageMemory', { ...this.store.config.section('imageMemory'), [state.key]: settings }, this.store.data,
        [{ file, bytes: Buffer.from(JSON.stringify({ ...snapshot, configurationVersion: 1 }, null, 2) + '\n') }]);
      state.configurationVersion = 1;
    } catch (error) {
      state.revision--;
      if (error instanceof ChannelError && ['CONFIG_CHANGED', 'CONFIG_RECOVERY_FAILED'].includes(error.code)) throw error;
      throw fail('STATE_WRITE_FAILED', '图片记忆未能保存，请检查磁盘空间和目录权限');
    }
  }
  writeBytes(file, bytes) {
    plain(path.dirname(file), true);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    plain(file);
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } catch {
      throw fail('STATE_WRITE_FAILED', '图片文件未能保存，请检查磁盘空间和目录权限');
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
  imageId(scope, entry, attachment) {
    if (
      typeof entry?.messageId !== 'string' ||
      !entry.messageId ||
      typeof attachment?.resourceId !== 'string' ||
      !attachment.resourceId
    )
      throw fail('INVALID_IMAGE_MEMORY_ID', '图片缺少原消息归属，未保存');
    return sha([scope.key, entry.messageId, attachment.resourceId]);
  }
  needsCapture(input, entry, attachment) {
    const state = this.load(input),
      id = this.imageId(state, entry, attachment);
    return state.settings.enabled && !state.deleted[id] && !state.items[id];
  }
  async capture(input, entry, attachment, image, signal = noSignal(), { generation } = {}) {
    signal.throwIfAborted();
    let state = this.load(input);
    const id = this.imageId(state, entry, attachment);
    if (!state.settings.enabled || state.deleted[id] || (generation !== undefined && state.generation !== generation))
      return null;
    const startedGeneration = state.generation;
    if (state.collection === 'generated' && !generatedImageMetadata(attachment.generation))
      throw fail('IMAGE_MEMORY_INVALID', '生成图片缺少有效任务来源，未保存');
    const { bytes, info } = imageBytes(image, state.collection),
      previous = state.items[id],
      quality = ['original', 'full', 'thumbnail'].includes(image.quality) ? image.quality : 'unknown';
    const ranks = { original: 3, full: 2, thumbnail: 1, unknown: 0 };
    if (previous && ranks[previous.quality] > ranks[quality]) {
      if (attachment.description && previous.description !== attachment.description) {
        previous.description = attachment.description;
        this.save(state);
      }
      return previous;
    }
    if (previous?.hasThumbnail && previous.digest === sha(bytes) && previous.quality === quality) {
      this.content(input, id);
      if (attachment.description && previous.description !== attachment.description) {
        previous.description = attachment.description;
        this.save(state);
      }
      return previous;
    }
    const item = {
      id,
      messageId: entry.messageId,
      resourceId: attachment.resourceId,
      type: attachment.type === 'face' ? 'face' : 'image',
      senderId: String(entry.senderId || ''),
      senderName: String(entry.senderName || entry.senderId || ''),
      sourceText: String(entry.text || '').slice(0, 4000),
      time: sourceTime(entry.time),
      capturedAt: previous?.capturedAt ?? this.now(),
      description: String(attachment.description || previous?.description || '').slice(0, 4000),
      quality,
      ...info,
      bytes: bytes.length,
      digest: sha(bytes),
      hasThumbnail: false,
      expiresAt: null,
      ...(state.collection === 'generated' ? { generation: { ...attachment.generation } } : {}),
    };
    item.expiresAt =
      state.settings.retentionDays === null ? null : item.capturedAt + state.settings.retentionDays * 86400000;
    // Save the pixels and index before optional preview work. A converter outage
    // must never discard the original or delay its availability until a retry.
    this.writeBytes(this.file(state, id, false, item.digest), bytes);
    state.items[id] = item;
    this.save(state);
    let preview, previewError;
    try {
      preview = await this.thumbnailMaker(bytes, signal);
      const result = inspectAssetImage(preview);
      if (result.mediaType !== 'image/png' || result.width > 384 || result.height > 384 || preview.length > 1024 * 1024)
        throw new Error('invalid thumbnail');
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      previewError = error instanceof ChannelError ? error.message : '缩略图未能生成；已保存的图片仍可打开';
    }
    signal.throwIfAborted();
    state = this.load(input);
    if (
      !state.items[id] ||
      state.deleted[id] ||
      !state.settings.enabled ||
      state.generation !== startedGeneration ||
      state.items[id].digest !== item.digest
    )
      return null;
    if (preview && !previewError) {
      this.writeBytes(this.file(state, id, true, sha(preview)), preview);
      state.items[id].hasThumbnail = true;
      state.items[id].thumbnailDigest = sha(preview);
    } else state.items[id].thumbnailError = previewError;
    this.save(state);
    this.errors.delete(state.key);
    return state.items[id];
  }
  describe(input, id, description) {
    const state = this.load(input),
      item = state.items[id];
    if (!item || state.deleted[id]) return;
    item.description = String(description || '').slice(0, 4000);
    this.save(state);
    this.store.describeImageReferences?.(input, item);
  }
  byMessage(input, messageId, { before = Infinity, senderId, includeDisabled = false } = {}) {
    const id = referencedMessageId(messageId, input.peerId);
    if (!id) return [];
    const state = this.load(input);
    if (!includeDisabled && !state.settings.enabled) return [];
    return Object.values(state.items).filter(item => visibleTo(input, item, before) && item.type === 'image' &&
      (item.time ?? item.capturedAt) <= before && (!senderId || senderId === input.peerId || item.senderId === senderId) &&
      (referencedMessageId(item.messageId, input.peerId) === id ||
        imageGenerationAt(item.generation, before)?.serverMessageIds?.some(value => referencedMessageId(value, input.peerId) === id)));
  }
  updateGeneration(input, id, generation) {
    if (input.collection !== 'generated' || !generatedImageMetadata(generation))
      throw fail('IMAGE_MEMORY_INVALID', '生成图片来源无效');
    const state = this.load(input), item = state.items[id];
    if (!item || state.deleted[id] || JSON.stringify(item.generation) === JSON.stringify(generation)) return;
    item.generation = { ...generation };
    this.save(state);
  }
  list(input, { query = '', offset = 0, limit = 20, after, before, type } = {}) {
    if (
      typeof query !== 'string' ||
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      [after, before].some((value) => value != null && (!Number.isSafeInteger(value) || value < 0)) ||
      (after != null && before != null && after > before) ||
      (type !== undefined && !['image', 'face'].includes(type))
    )
      throw fail('INVALID_IMAGE_MEMORY_QUERY', '请使用简短关键词、有效时间范围及分页');
    const state = this.load(input),
      all = Object.values(state.items).filter(item => visibleTo(input, item, before ?? input.beforeTime ?? Infinity)),
      terms = [
        ...new Set(
          normalized(query)
            .split(/[\s,，;；、]+/u)
            .filter(Boolean)
        ),
      ];
    const items = all
      .map((item) => ({
        ...item,
        ...(item.generation ? { generation: imageGenerationAt(item.generation, before ?? input.beforeTime ?? Infinity) } : {}),
        score: terms.filter((term) =>
          normalized([item.description, item.sourceText, item.senderName,
            ...(state.collection === 'generated' ? [item.generation.prompt, item.generation.fileName,
              item.generation.model, item.generation.providerName, item.generation.jobId] : [])].join(' ')).includes(term)
        ).length,
      }))
      .filter(
        (item) =>
          (!type || item.type === type) &&
          (!terms.length || item.score > 0) &&
          (after == null || (item.time ?? item.capturedAt) >= after) &&
          (before == null || (item.time ?? item.capturedAt) <= before ||
            (state.collection === 'generated' && input.currentJobId && item.generation?.jobId === input.currentJobId))
      )
      .sort(
        (a, b) => b.score - a.score || (b.time ?? b.capturedAt) - (a.time ?? a.capturedAt) || a.id.localeCompare(b.id)
      );
    return {
      ...this.selector(input),
      settings: state.settings,
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
      hasMore: offset + limit < items.length,
      storedCount: all.length,
      storedBytes: all.reduce((sum, item) => sum + item.bytes, 0),
      path: this.directory(state),
      error: this.errors.get(state.key) || this.sweepError || null,
    };
  }
  content(input, id, { preview = false } = {}) {
    const state = this.load(input),
      item = state.items[id];
    if (!item || state.deleted[id] || !visibleTo(input, item)) throw fail('IMAGE_MEMORY_UNAVAILABLE', '这张图片记忆已删除、到期或不属于当前会话');
    if (preview && !item.hasThumbnail)
      throw fail('IMAGE_THUMBNAIL_UNAVAILABLE', item.thumbnailError || '此图片暂无缩略图，可打开已保存图片');
    const file = this.file(state, id, preview);
    plain(file, false, false);
    const stat = fs.statSync(file);
    if (stat.size > (preview ? 1024 * 1024 : imageMemoryByteLimit(state.collection)))
      throw fail('IMAGE_MEMORY_INVALID', '图片文件大小异常，未读取');
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== (preview ? item.thumbnailDigest : item.digest))
      throw fail('IMAGE_MEMORY_CHANGED', '保存的图片已被外部修改，未使用旧记录');
    return {
      ...item,
      ...(item.generation ? { generation: imageGenerationAt(item.generation, input.beforeTime ?? Infinity) } : {}),
      mediaType: preview ? 'image/png' : item.mediaType,
      data: bytes.toString('base64'),
      reference: { ...this.selector(input), ...(input.collection === 'generated' && input.senderId ? { senderId: input.senderId } : {}),
        ...(input.beforeTime === undefined ? {} : { beforeTime: input.beforeTime }), id, digest: item.digest },
    };
  }
  assertReference(reference) {
    const state = this.load(reference),
      item = state.items[reference.id];
    if (!state.settings.enabled || !item || item.digest !== reference.digest)
      throw fail('IMAGE_MEMORY_CHANGED', '图片记忆已删除、到期或停用，未继续使用旧图片');
    this.content(reference, reference.id);
  }
  removeState(state, ids, reason = 'deleted') {
    for (const id of ids) {
      if (!validId(id)) throw fail('INVALID_IMAGE_MEMORY_ID', '图片记忆标识无效');
      const item = state.items[id];
      state.deleted[id] = { ...state.deleted[id], at: this.now(), reason,
        ...(item ? { messageId: item.messageId, ...(item.generation?.serverMessageIds ? { serverMessageIds: item.generation.serverMessageIds } : {}) } : {}) };
      delete state.items[id];
    }
    this.save(state); // Tombstones remain authoritative even if file cleanup fails.
    this.cleanupState(state, ids);
  }
  cleanupState(state, ids) {
    if (!ids.length) return;
    const directory = this.directory(state);
    plain(directory, true, false);
    for (const name of fs.readdirSync(directory)) {
      const match = /^([a-f0-9]{64})\.[a-f0-9]{64}\.(?:image|thumbnail\.png)$/.exec(name);
      if (!match || !ids.includes(match[1])) continue;
      const file = path.join(directory, name);
      plain(file, false, false);
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.errors.set(state.key, '图片已停止参与记忆，部分文件未能清理，请检查磁盘权限后重新删除');
          throw fail('STATE_WRITE_FAILED', this.errors.get(state.key));
        }
      }
    }
    this.errors.delete(state.key);
  }
  remove(input, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => !validId(id)))
      throw fail('INVALID_IMAGE_MEMORY_ID', '请选择要删除的图片记忆');
    const state = this.load(input);
    if (ids.some((id) => !state.items[id] && !state.deleted[id]))
      throw fail('IMAGE_MEMORY_UNAVAILABLE', '图片记忆不存在或不属于当前会话');
    this.removeState(state, ids);
    return this.list(input);
  }
  clear(input, entries = []) {
    const state = this.load(input),
      ids = new Set(Object.keys(state.items));
    state.generation = randomUUID();
    for (const entry of entries)
      for (const attachment of entry.attachments || [])
        if (entry.messageId && attachment.resourceId) {
          const id = this.imageId(state, entry, attachment);
          ids.add(id);
          state.deleted[id] = { ...state.deleted[id], messageId: entry.messageId,
            ...(attachment.generation?.serverMessageIds ? { serverMessageIds: attachment.generation.serverMessageIds } : {}) };
        }
    this.removeState(state, [...ids]);
    return this.list(input);
  }
  configure(input, settings) {
    settings = validateImageMemorySettings(settings);
    const state = this.load(input);
    state.settings = settings;
    for (const item of Object.values(state.items))
      item.expiresAt =
        settings.retentionDays === null
          ? null
          : (item.retentionStartedAt ?? item.capturedAt) + settings.retentionDays * 86400000;
    this.save(state);
    return this.list(input);
  }
  async importExisting(input, entries, transport, signal, assertAllowed = () => {}) {
    const initial = this.load(input);
    if (!initial.settings.enabled) throw fail('IMAGE_MEMORY_DISABLED', '请先开启此会话的图片记忆');
    const unique = new Map();
    for (const entry of entries)
      for (const attachment of entry.attachments || [])
        if (entry.messageId && attachment.resourceId)
          unique.set(this.imageId(this.selector(input), entry, attachment), { entry, attachment });
    const result = { saved: 0, skipped: 0, failed: 0, failures: [] };
    for (const { entry, attachment } of unique.values()) {
      signal.throwIfAborted();
      assertAllowed();
      if (this.load(input).generation !== initial.generation)
        throw fail('IMAGE_MEMORY_CHANGED', '图片记忆已清空，已停止保存旧来源');
      if (!this.needsCapture(input, entry, attachment)) {
        result.skipped++;
        continue;
      }
      try {
        const image = await transport.media(
          {
            accountId: input.accountId,
            peerId: input.peerId,
            messageId: entry.messageId,
            resourceId: attachment.resourceId,
            preferOriginal: true,
          },
          signal
        );
        signal.throwIfAborted();
        assertAllowed();
        if (await this.capture(input, entry, attachment, image, signal, { generation: initial.generation }))
          result.saved++;
        else result.skipped++;
      } catch (error) {
        signal.throwIfAborted();
        if (error?.code === 'AUTH_CHANGED' || error?.code === 'ACCOUNT_CHANGED') throw error;
        result.failed++;
        const reason = error instanceof ChannelError ? error.message : '未取得这条消息的图片内容';
        const failure = result.failures.find((item) => item.reason === reason);
        if (failure) failure.count++;
        else result.failures.push({ reason, count: 1 });
      }
    }
    return result;
  }
}
