import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson } from '../../storage/atomic-json.ts';
import { ChannelError } from '../../shared/contracts.mjs';
import { conversationFolder, conversationKey, identity } from '../../storage/keys.mjs';
import { ImageMemory } from './image-memory.mjs';
import { DEFAULT_MEMORY_RETENTION_DAYS, defaultMemoryExpiry, EMPTY_MEMORY_SUMMARY } from '../../shared/memory-policy.mjs';

const clone = (value) => structuredClone(value);
function read(file) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ChannelError('MEMORY_INVALID', '记忆文件无法读取，请保留文件并检查 UTF-8 编码、内容和权限');
  }
}
function write(file, data) {
  try {
    atomicJson(file, data);
  } catch {
    throw new ChannelError('STATE_WRITE_FAILED', '记忆未能保存，请检查磁盘空间和记忆目录权限');
  }
}
const needsClearerImage = (image) =>
  image.type === 'image' && !!image.description && !['original', 'full'].includes(image.quality);
export function memoryText(doc) {
  const rows = doc.entries.map((entry) =>
    JSON.stringify({
      time: entry.time,
      speaker: entry.senderName || entry.senderId,
      senderId: entry.senderId,
      direction: entry.direction,
      text: entry.text,
      ...(entry.attachments?.length
        ? {
            images: entry.attachments.map((image) => ({
              type: image.type,
              description:
                image.type === 'face'
                  ? '表情包（不调用图像理解）'
                  : image.description || image.error || '图片已接收，尚未按需查看；不能猜测画面',
              ...(image.quality ? { quality: image.quality } : {}),
              ...(image.quality === 'thumbnail'
                ? { sourceNote: '仅有微信缩略图，小字和画面细节未核实。' }
                : needsClearerImage(image)
                  ? { sourceNote: '旧图像笔记的清晰度未核实，可重新获取清晰图片后理解。' }
                  : {}),
            })),
          }
        : {}),
    })
  );
  return [
    doc.summary && `已保存的会话记忆（压缩摘要，可能有信息损耗）：\n${doc.summary}`,
    rows.length && `最近的会话原文（按接收顺序）：\n${rows.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A separate, durable memory document. Chat archives are never rewritten by compaction. */
export class ConversationMemory {
  constructor(store, { now = Date.now } = {}) {
    this.store = store;
    this.now = now;
    this.root = path.join(store.root, 'storage/memory');
    this.indexFile = path.join(this.root, 'index.json');
    this.index = read(this.indexFile) ?? {
      version: 1,
      ownerStoreId: store.data.storeId,
      windowDefaultVersion: 2,
      windowCustomized: false,
      windowChars: 100000,
      conversations: {},
    };
    if (
      this.index.version !== 1 ||
      this.index.ownerStoreId !== store.data.storeId ||
      !this.index.conversations ||
      !Number.isSafeInteger(this.index.windowChars) ||
      this.index.windowChars < 1000
    )
      throw new ChannelError('MEMORY_INVALID', '记忆索引不属于当前插件数据，请检查记忆目录');
    if (this.index.windowDefaultVersion !== 2) {
      const oldDefault = this.index.windowChars === 32000 && this.index.windowCustomized !== true;
      if (oldDefault) this.index.windowChars = 100000;
      this.index.windowDefaultVersion = 2;
      this.index.windowCustomized = !oldDefault;
      write(this.indexFile, this.index);
    }
    this.errors = new Map();
    this.compacting = new Set();
    this.images = new ImageMemory(store, { now });
  }
  selector(input) {
    const key = conversationKey(input.accountId, input.chatType, input.peerId);
    const known = this.store.conversations(input.accountId).find((item) => item.key === key);
    if (!known) throw new ChannelError('MEMORY_CONVERSATION_MISSING', '请先选择已授权或有历史记录的会话');
    return { key, accountId: input.accountId, chatType: input.chatType, peerId: input.peerId, name: known.name };
  }
  file(selector) {
    const entry = this.index.conversations[selector.key];
    const folder =
      entry?.folder ||
      path.join('账号-' + identity([selector.accountId]).slice(0, 8), conversationFolder(selector, selector.name));
    const target = path.resolve(this.root, folder, 'memory.json'),
      relative = path.relative(this.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new ChannelError('MEMORY_INVALID', '记忆目录超出当前记忆库范围');
    return target;
  }
  load(input, { incomingKey } = {}) {
    const selector = this.selector(input),
      file = this.file(selector),
      known = this.index.conversations[selector.key];
    let doc = read(file);
    if (doc) {
      if (
        doc.version !== 1 ||
        doc.ownerStoreId !== this.store.data.storeId ||
        doc.key !== selector.key ||
        !Array.isArray(doc.entries) ||
        !Array.isArray(doc.seen) ||
        typeof doc.summary !== 'string' ||
        typeof doc.generation !== 'string'
      )
        throw new ChannelError('MEMORY_INVALID', '记忆文件格式或会话归属有误，未混用其他会话的记忆');
      if (doc.retentionVersion !== 1) {
        // Undated legacy window material gets one full month from adoption;
        // keep source timestamps and archives intact.
        for (const entry of doc.entries) entry.rememberedAt ??= this.now();
        doc.summaryExpiresAt = doc.summary ? defaultMemoryExpiry(this.now()) : null;
        doc.retentionVersion = 1;
        this.save(doc);
      }
      return this.expire(doc, true);
    }
    const history = this.store.history(selector.accountId, selector.chatType, selector.peerId, 1000).map((entry) => {
      if (!entry.attachments?.length && entry.mediaOnly && /图片|表情/u.test(entry.text)) {
        return {
          ...entry,
          attachments: [
            {
              type: /表情/u.test(entry.text) ? 'face' : 'image',
              resourceId: createHash('sha256').update(`${selector.peerId}:${entry.messageId}`).digest('hex'),
            },
          ],
        };
      }
      return entry;
    });
    doc = {
      version: 1,
      ownerStoreId: this.store.data.storeId,
      ...selector,
      generation: randomUUID(),
      revision: 0,
      summary: '',
      entries: known ? [] : clone(history).map((entry) => ({ ...entry, rememberedAt: this.now() })),
      seen: history.map((entry) => entry.key).filter((key) => !known || key !== incomingKey),
      retentionVersion: 1,
      summaryExpiresAt: null,
      compressions: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    write(file, doc);
    this.index.conversations[selector.key] = { ...selector, folder: path.relative(this.root, path.dirname(file)) };
    write(this.indexFile, this.index);
    return doc;
  }
  save(doc) {
    doc.revision++;
    doc.updatedAt = this.now();
    write(this.file(doc), doc);
  }
  expire(doc, persist = false) {
    const entries = doc.entries.filter(
      (entry) => defaultMemoryExpiry(entry.rememberedAt ?? doc.createdAt) > this.now()
    );
    const summaryExpired = !!doc.summary && (doc.summaryExpiresAt ?? defaultMemoryExpiry(doc.createdAt)) <= this.now();
    if (entries.length === doc.entries.length && !summaryExpired) return doc;
    const next = {
      ...doc,
      entries,
      summary: summaryExpired ? '' : doc.summary,
      summaryExpiresAt: summaryExpired ? null : doc.summaryExpiresAt,
      generation: randomUUID(),
    };
    if (persist) {
      this.archive(doc, 'before-expiry');
      this.save(next);
    }
    return next;
  }
  summaryExpiry(doc, covered) {
    return Math.min(
      ...[
        doc.summary ? (doc.summaryExpiresAt ?? defaultMemoryExpiry(doc.createdAt)) : null,
        ...covered.map((entry) => defaultMemoryExpiry(entry.rememberedAt ?? doc.createdAt)),
      ].filter((value) => value != null)
    );
  }
  seed() {
    for (const metadata of Object.values(this.store.data.conversations)) this.load(metadata);
  }
  append(input, entry) {
    const doc = this.load(input, { incomingKey: entry.key });
    if (!doc.seen.includes(entry.key)) {
      doc.entries.push({ ...clone(entry), rememberedAt: this.now() });
      doc.seen.push(entry.key);
      doc.seen = doc.seen.slice(-4000);
      this.save(doc);
      this.onAppend?.(input, entry);
    }
    if (memoryText(doc).length >= this.windowChars(input)) this.onPressure?.(input);
  }
  windowChars(input) {
    return (
      this.store.conversationSettings(input.accountId, input.chatType, input.peerId).memoryWindowChars ??
      this.index.windowChars
    );
  }
  setWindowChars(value) {
    if (!Number.isSafeInteger(value) || value < 1000)
      throw new ChannelError('INVALID_MEMORY_SETTINGS', '默认记忆窗口至少为 1000 字符，请填写有效整数');
    const before = { windowChars: this.index.windowChars, windowCustomized: this.index.windowCustomized };
    this.index.windowChars = value;
    this.index.windowCustomized = true;
    try {
      write(this.indexFile, this.index);
    } catch (error) {
      Object.assign(this.index, before);
      throw error;
    }
    for (const selector of Object.values(this.index.conversations))
      if (memoryText(this.load(selector)).length >= this.windowChars(selector)) this.onPressure?.(selector);
  }
  snapshot(input, beforeKey) {
    const doc = this.load(input);
    if (beforeKey) {
      const position = doc.entries.findIndex((entry) => entry.key === beforeKey);
      // A queued turn must not acquire later room messages. Its snapshot is
      // normally taken on receipt, before another compaction can cover it.
      if (position >= 0) doc.entries = doc.entries.slice(0, position);
    }
    return doc;
  }
  view(input) {
    const doc = this.load(input);
    const imageFailures = new Map();
    for (const entry of doc.entries)
      for (const image of entry.attachments || []) {
        if (image.type === 'image' && image.error && !image.description)
          imageFailures.set(image.error, (imageFailures.get(image.error) || 0) + 1);
      }
    return {
      ...doc,
      retentionDays: DEFAULT_MEMORY_RETENTION_DAYS,
      seen: undefined,
      path: this.file(doc),
      text: memoryText(doc),
      chars: memoryText(doc).length,
      failedImages: doc.entries.reduce(
        (count, entry) =>
          count +
          (entry.attachments || []).filter((image) => image.type === 'image' && image.error && !image.description)
            .length,
        0
      ),
      imageFailures: [...imageFailures].map(([reason, count]) => ({ reason, count })),
      imageMemoryError: this.images.errors.get(doc.key) || null,
      lowQualityImages: doc.entries.reduce(
        (count, entry) => count + (entry.attachments || []).filter(needsClearerImage).length,
        0
      ),
      windowChars: this.windowChars(input),
      compacting: this.compacting.has(doc.key),
      retryAt: this.retryState?.get(doc.key)?.nextAt || null,
      error: this.errors.get(doc.key) || null,
    };
  }
  list(accountId) {
    return this.store.conversations(accountId).map((peer) => {
      const doc = this.load(peer);
      return {
        key: peer.key,
        accountId,
        chatType: peer.chatType,
        peerId: peer.peerId,
        name: peer.name,
        authorized: peer.authorized,
        chars: memoryText(doc).length,
        windowChars: this.windowChars(peer),
        messageCount: doc.entries.length,
        compressions: doc.compressions,
        updatedAt: doc.updatedAt,
        path: this.file(doc),
        compacting: this.compacting.has(peer.key),
        error: this.errors.get(peer.key) || null,
      };
    });
  }
  edit(input, summary, expectedRevision) {
    if (typeof summary !== 'string' || summary.length > 100000 || /\u0000/.test(summary))
      throw new ChannelError('INVALID_MEMORY', '记忆正文最多 100000 字');
    const doc = this.load(input);
    if (expectedRevision !== doc.revision)
      throw new ChannelError('MEMORY_CHANGED', '记忆已收到新内容，请重新读取后再修改');
    this.archive(doc, 'before-edit');
    doc.summary = summary.trim();
    doc.summaryExpiresAt = doc.summary ? defaultMemoryExpiry(this.now()) : null;
    this.save(doc);
    return this.view(input);
  }
  clear(input) {
    const doc = this.load(input);
    // An explicit clear is not re-seeded from chat history on the next run.
    doc.summary = '';
    doc.summaryExpiresAt = null;
    doc.entries = [];
    doc.seen = this.store.history(doc.accountId, doc.chatType, doc.peerId, 1000).map((entry) => entry.key);
    doc.generation = randomUUID();
    doc.compressions = 0;
    this.save(doc);
    this.errors.delete(doc.key);
    return this.view(input);
  }
  archive(doc, reason) {
    const file = path.join(path.dirname(this.file(doc)), 'archive', `${this.now()}-${randomUUID()}-${reason}.json`);
    write(file, doc);
  }
  async summarizeWithin(material, maximum, runner, signal) {
    if (typeof runner.summarize !== 'function')
      throw new ChannelError('MEMORY_COMPRESSION_FAILED', '模型暂不能压缩记忆，原文已保留，将自动重试');
    let target = Math.max(100, Math.floor(maximum * 0.65)),
      observedChars;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const summary = await runner.summarize(material, target, signal, { attempt, observedChars, maximum });
      signal.throwIfAborted();
      if (typeof summary === 'string' && summary.trim() === EMPTY_MEMORY_SUMMARY) return '';
      if (typeof summary === 'string' && summary.trim() && summary.trim().length <= maximum) return summary.trim();
      observedChars = typeof summary === 'string' ? summary.trim().length : 0;
      // Every retry keeps the original evidence. Re-summarizing a bad candidate
      // would amplify its omissions and inventions before committing them.
      target = Math.max(80, Math.floor(target * 0.5));
    }
    throw new ChannelError('MEMORY_COMPRESSION_FAILED', '模型摘要仍为空或过长，原文已保留，将自动重试压缩');
  }
  async fitSnapshot(doc, runner, signal) {
    doc = this.expire(doc);
    const limit = this.windowChars(doc);
    if (memoryText(doc).length < limit) return doc;
    let keep = [],
      size = 0;
    for (const entry of [...doc.entries].reverse()) {
      const length = JSON.stringify(entry).length;
      if (size + length > limit * 0.3) break;
      keep.unshift(entry);
      size += length;
    }
    const maximum = Math.max(300, Math.floor(limit * 0.5));
    const covered = doc.entries.slice(0, doc.entries.length - keep.length);
    const summary = await this.summarizeWithin(
      memoryText({ summary: doc.summary, entries: covered }),
      maximum,
      runner,
      signal
    );
    signal.throwIfAborted();
    if (typeof summary !== 'string' || summary.length > maximum)
      throw new ChannelError('MEMORY_COMPRESSION_FAILED', '记忆摘要不符合窗口要求，原文已保留');
    return { ...doc, summary: summary.trim(), summaryExpiresAt: summary ? this.summaryExpiry(doc, covered) : null, entries: keep };
  }
  async enrich(input, runner, transport, signal, { retryFailed = false, imageRequest, executionSnapshot } = {}) {
    signal.throwIfAborted();
    const initial = this.load(input),
      generation = initial.generation;
    if (typeof transport.media !== 'function') return;
    // Receipt, maintenance and compaction only archive pixels. A scoped tool
    // request or an explicit retry of a failed photo may invoke vision.
    const understanding =
      !!(imageRequest || retryFailed) &&
      this.store.modelConfig().vision !== false &&
      typeof runner.describeImage === 'function';
    const requested = (entry, attachment) =>
      attachment.type === 'image' &&
      understanding &&
      (imageRequest
        ? entry.key === imageRequest.key && attachment.resourceId === imageRequest.resourceId
        : (!!attachment.error && !attachment.description) || needsClearerImage(attachment));
    let imageGeneration;
    try {
      imageGeneration = this.images.load(input).generation;
    } catch {}
    const sources =
      imageRequest?.entry && !initial.entries.some((entry) => entry.key === imageRequest.key)
        ? [...initial.entries, imageRequest.entry]
        : initial.entries;
    let requestResult;
    const pending = sources.flatMap((entry) =>
      (entry.attachments || [])
        .filter((attachment) => {
          if (imageRequest && (entry.key !== imageRequest.key || attachment.resourceId !== imageRequest.resourceId))
            return false;
          let archive = false;
          try {
            archive =
              !!attachment.resourceId &&
              !!entry.messageId &&
              (!attachment.imageMemoryAttempted || retryFailed) &&
              (!!attachment.description || !attachment.error || retryFailed) &&
              this.images.needsCapture(input, entry, attachment);
          } catch (error) {
            this.images.errors.set(
              initial.key,
              error instanceof ChannelError ? error.message : '图片记忆暂时无法保存，文字理解继续保留'
            );
          }
          return requested(entry, attachment) || archive;
        })
        .map((attachment) => ({ entry, attachment }))
    );
    for (let offset = 0; offset < pending.length; offset += 4) {
      const batch = pending.slice(offset, offset + 4);
      const acquired = await Promise.allSettled(
        batch.map(({ entry, attachment }) =>
          transport.media(
            {
              accountId: input.accountId,
              peerId: input.peerId,
              messageId: entry.messageId,
              resourceId: attachment.resourceId,
              preferOriginal: !!imageRequest || retryFailed,
            },
            signal
          )
        )
      );
      signal.throwIfAborted();
      if (this.load(input).generation !== generation)
        throw new ChannelError('MEMORY_CHANGED', '记忆已被清空，已取消旧图像理解');
      const archived = await Promise.allSettled(
        batch.map(async ({ entry, attachment }, index) => {
          if (acquired[index].status !== 'fulfilled') return null;
          return this.images.capture(input, entry, attachment, acquired[index].value, signal, {
            generation: imageGeneration,
          });
        })
      );
      signal.throwIfAborted();
      const unchanged = new Set(
        acquired.flatMap((result, i) =>
          !imageRequest &&
          result.status === 'fulfilled' &&
          result.value.quality === 'thumbnail' &&
          batch[i].attachment.description &&
          batch[i].attachment.quality === 'thumbnail'
            ? [i]
            : []
        )
      );
      const valid = acquired.flatMap((result, i) =>
        requested(batch[i].entry, batch[i].attachment) && result.status === 'fulfilled' && !unchanged.has(i)
          ? [{ image: result.value, i }]
          : []
      );
      let descriptions = [],
        modelError;
      if (valid.length) {
        try {
          descriptions = imageRequest
            ? [
                await runner.describeImage(valid[0].image, signal, {
                  question: imageRequest.question,
                  executionSnapshot,
                }),
              ]
            : typeof runner.describeImages === 'function'
              ? await runner.describeImages(
                  valid.map((item) => item.image),
                  signal
                )
              : await Promise.all(valid.map((item) => runner.describeImage(item.image, signal)));
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          modelError = error;
        }
      }
      signal.throwIfAborted();
      const current = this.load(input);
      if (current.generation !== generation) throw new ChannelError('MEMORY_CHANGED', '记忆已被清空，已取消旧图像理解');
      for (let index = 0; index < batch.length; index++) {
        const { entry, attachment } = batch[index],
          result = acquired[index];
        const description = descriptions[valid.findIndex((item) => item.i === index)];
        const failure =
          result.status === 'rejected' ? result.reason : requested(entry, attachment) ? modelError : undefined;
        if (imageRequest)
          requestResult = {
            description,
            quality: result.status === 'fulfilled' ? result.value.quality : 'unknown',
            error: failure
              ? failure instanceof ChannelError
                ? failure.message
                : '图片未能完成按需理解，不能猜测画面'
              : !description
                ? '图片未能完成按需理解，不能猜测画面'
                : null,
            imageMemoryId: archived[index].status === 'fulfilled' ? archived[index].value?.id : undefined,
          };
        const target = current.entries
          .find((item) => item.key === entry.key)
          ?.attachments?.find((item) => item.resourceId === attachment.resourceId);
        if (!target) continue;
        if (archived[index].status === 'fulfilled' && archived[index].value) {
          target.imageMemoryAttempted = true;
          target.imageMemoryId = archived[index].value.id;
          delete target.imageMemoryError;
        } else if (archived[index].status === 'rejected') {
          target.imageMemoryAttempted = true;
          target.imageMemoryError =
            archived[index].reason instanceof ChannelError
              ? archived[index].reason.message
              : '图片记忆未能保存，文字描述继续保留';
          this.images.errors.set(initial.key, target.imageMemoryError);
        }
        target.lastAttemptAt = this.now();
        target.attempts = (target.attempts || 0) + 1;
        if (result.status === 'fulfilled') {
          target.quality = ['original', 'full', 'thumbnail'].includes(result.value.quality)
            ? result.value.quality
            : 'unknown';
          if (Number.isSafeInteger(result.value.bytes) && result.value.bytes > 0)
            target.imageBytes = result.value.bytes;
        }
        if (description) {
          target.description = description;
          delete target.error;
          try {
            if (target.imageMemoryId) this.images.describe(input, target.imageMemoryId, description);
          } catch (error) {
            this.images.errors.set(initial.key, error instanceof ChannelError ? error.message : '图片记忆描述未能更新');
          }
        } else if (unchanged.has(index)) target.error = '仍只取得微信缩略图，保留已有笔记；请发送原图后再理解细节';
        else if (failure || (requested(entry, attachment) && !target.description))
          target.error =
            failure instanceof ChannelError ? failure.message : '图片未能完成理解，不能根据占位文字猜测内容';
        else if (!requested(entry, attachment) && result.status === 'fulfilled' && !target.description)
          delete target.error;
      }
      this.save(current);
      if (imageRequest && requestResult?.description && requestResult.imageMemoryId)
        this.images.describe(input, requestResult.imageMemoryId, requestResult.description);
    }
    return requestResult;
  }
  async compact(input, runner, signal) {
    const key = this.selector(input).key;
    if (this.compacting.has(key)) return;
    this.compacting.add(key);
    try {
      for (let round = 0; round < 4; round++) {
        signal.throwIfAborted();
        const doc = this.load(input),
          limit = this.windowChars(input);
        if (memoryText(doc).length < limit) {
          this.errors.delete(key);
          return;
        }
        let keep = [],
          size = 0;
        for (const entry of [...doc.entries].reverse()) {
          const length = JSON.stringify(entry).length;
          if (size + length > limit * 0.3) break;
          keep.unshift(entry);
          size += length;
        }
        const covered = doc.entries.slice(0, doc.entries.length - keep.length);
        if (!covered.length && !doc.summary) return;
        const maximum = Math.max(300, Math.floor(limit * 0.5));
        const summary = await this.summarizeWithin(
          memoryText({ summary: doc.summary, entries: covered }),
          maximum,
          runner,
          signal
        );
        signal.throwIfAborted();
        const current = this.load(input);
        // Newly completed image notes may keep the same message key. Reject
        // a stale summary whenever any covered content changed, while still
        // allowing later appended messages to remain after the compacted part.
        if (
          current.generation !== doc.generation ||
          current.summary !== doc.summary ||
          covered.some((entry, i) => JSON.stringify(current.entries[i]) !== JSON.stringify(entry))
        )
          throw new ChannelError('MEMORY_CHANGED', '记忆已被修改，本次压缩未覆盖新内容');
        this.archive(doc, 'before-compaction');
        current.summary = summary.trim();
        current.summaryExpiresAt = summary ? this.summaryExpiry(doc, covered) : null;
        current.entries = current.entries.slice(covered.length);
        current.compressions++;
        current.lastCompactedAt = this.now();
        this.save(current);
        if (memoryText(current).length < limit) {
          this.errors.delete(key);
          return;
        }
      }
      throw new ChannelError('MEMORY_COMPRESSION_FAILED', '压缩期间仍有新消息超过窗口，剩余内容已保留，将自动继续压缩');
    } catch (error) {
      this.errors.set(key, error instanceof ChannelError ? error.message : '记忆压缩失败，原文已保留');
      throw error;
    } finally {
      this.compacting.delete(key);
    }
  }
}
