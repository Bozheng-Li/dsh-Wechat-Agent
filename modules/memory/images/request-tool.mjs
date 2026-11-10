import { promptText } from "../../../prompts/loader.mjs";
import { createHash } from 'node:crypto';
import { ChannelError } from "../../../shared/contracts.mjs";
import { defaultMemoryExpiry } from "../../../shared/memory-policy.mjs";

const IMAGE_NOTE_PAGE_CHARS = 4000;
const IMAGE_CATALOG_CHARS = 6000;
const shortSource = (value, maximum) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, maximum);

function progressiveCatalog(catalog, currentKey) {
  const rows = [];
  for (const { entry, image, imageId, position } of catalog) {
    const row = { imageId, position, current: entry.key === currentKey,
      sender: shortSource(entry.senderName || entry.senderId, 64),
      time: Number.isFinite(entry.time) ? entry.time : null,
      summary: shortSource(image.description || '尚未按需查看', 80),
      hasNote: !!image.description,
      quality: ['original', 'full', 'thumbnail'].includes(image.quality) ? image.quality : 'unknown' };
    // Current pictures come first; unusually large source labels cannot make
    // this discovery index grow beyond the per-request catalog allowance.
    if (JSON.stringify([...rows, row]).length > IMAGE_CATALOG_CHARS) break;
    rows.push(row);
  }
  return rows;
}

function imageNotePage(imageId, description, args) {
  const offset = args.offset ?? 0;
  const revision = createHash('sha256').update(imageId + '\n' + description).digest('hex');
  if ((offset > 0 && !args.revision) || (args.revision && args.revision !== revision))
    throw new ChannelError('IMAGE_NOTE_CHANGED', '图像笔记已更新或缺少版本，请从 offset 0 重新读取');
  if (offset > description.length)
    throw new ChannelError('INVALID_IMAGE_REQUEST', '图像笔记偏移超出范围，请从 offset 0 重新读取');
  let end = Math.min(description.length, offset + IMAGE_NOTE_PAGE_CHARS);
  if (end < description.length && /[\uD800-\uDBFF]/u.test(description[end - 1]) && /[\uDC00-\uDFFF]/u.test(description[end])) end--;
  const nextOffset = end < description.length ? end : null;
  return { observation: description.slice(offset, end), offset, nextOffset, revision, totalChars: description.length,
    truncated: offset > 0 || nextOffset !== null,
    ...(nextOffset !== null ? { guidance: '笔记尚未完整返回；需要后续细节时沿用 imageId、revision，以 nextOffset 作为 offset 继续 read。' } : {}) };
}

/** Only photos in this turn's frozen room snapshot can be requested. */
export function conversationImageTool(
  memory,
  runner,
  transport,
  scope,
  assertAllowed,
  { snapshot, currentKey, onRead = () => {}, promptStrategy = 'legacy' } = {}
) {
  const progressive = promptStrategy === 'progressive-v1';
  const candidates = snapshot.entries.flatMap((entry) =>
    (entry.attachments || [])
      .filter((image) => image.type === 'image' && entry.messageId && image.resourceId)
      .map((image, position) => ({
        entry,
        image,
        position: position + 1,
        imageId: createHash('sha256')
          .update(JSON.stringify([entry.key, image.resourceId]))
          .digest('hex'),
      }))
  );
  // Put this message first, then recent photos. Availability alone is never a
  // request to analyze them. Older saved images have their own search tool.
  const catalog = [
    ...candidates.filter((item) => item.entry.key === currentKey),
    ...candidates.filter((item) => item.entry.key !== currentKey).reverse(),
  ].slice(0, 12);
  if (!catalog.length) return null;
  const index = progressive ? progressiveCatalog(catalog, currentKey) : null;
  const visibleIds = progressive ? new Set(index.map(row => row.imageId)) : null;
  const results = new Map();
  const notes = new Map();
  const assertCurrent = (candidate) => {
    const doc = memory.load(scope);
    const attachment = doc.entries
      .find((entry) => entry.key === candidate.entry.key && entry.messageId === candidate.entry.messageId)
      ?.attachments?.find((image) => image.resourceId === candidate.image.resourceId);
    if (
      doc.generation !== snapshot.generation ||
      (memory.expiry?.(candidate.entry.rememberedAt ?? snapshot.createdAt) ??
        defaultMemoryExpiry(candidate.entry.rememberedAt ?? snapshot.createdAt)) <= memory.now()
    )
      throw new ChannelError('IMAGE_CONTEXT_CHANGED', '这张图片已到期或会话记忆已修改，不能继续使用旧来源');
    if ((attachment || candidate.image).type !== 'image')
      throw new ChannelError('STICKER_VISION_SKIPPED', '表情包不调用图像理解');
    const archive = memory.images.load(scope);
    const savedId = memory.images.imageId(archive, candidate.entry, attachment || candidate.image);
    if (archive.deleted[savedId])
      throw new ChannelError('IMAGE_MEMORY_UNAVAILABLE', '这张图片已删除或到期，不能重新读取');
    return attachment;
  };
  return {
    name: 'wechat_read_image',
    description: progressive
      ? promptText("vision/tools.json", "images-request-progressive-description") + JSON.stringify(index)
      :
      promptText("vision/tools.json", "images-request-tool-description-1") +
      JSON.stringify(
        catalog.map(({ entry, image, imageId, position }) => ({
          imageId,
          messageId: entry.messageId,
          position,
          current: entry.key === currentKey,
          sender: entry.senderName || entry.senderId,
          time: entry.time,
          text: entry.text?.slice(0, 300),
          description: image.description || promptText("vision/tools.json", "images-request-tool-description-2"),
          quality: image.quality || 'unknown',
        }))
      ),
    parameters: {
      type: 'object',
      properties: {
        imageId: { type: 'string' },
        question: { type: 'string', minLength: 1, maxLength: 2000, description: promptText("vision/tools.json", "images-request-tool-description-3") },
        ...(progressive ? {
          action: { type: ['string', 'null'], enum: ['read', 'inspect', null], description: '默认 read 展开已有笔记；确需核对原图时 inspect 并提供 question' },
          offset: { type: ['integer', 'null'], minimum: 0, description: 'read 翻页使用 nextOffset' },
          revision: { type: ['string', 'null'], description: 'read 翻页沿用上一页 revision' },
        } : {}),
      },
      required: progressive ? ['imageId'] : ['imageId', 'question'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async (args, execution = {}) => {
      const signal = execution.signal || new AbortController().signal;
      try {
        signal.throwIfAborted();
        assertAllowed();
        const candidate = catalog.find((item) => item.imageId === args?.imageId);
        if (!candidate || (progressive && !visibleIds.has(args.imageId)) ||
          (!progressive && (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2000)) ||
          (progressive && ((args.action != null && !['read', 'inspect'].includes(args.action)) ||
            (args.question != null && (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2000)) ||
            (args.offset != null && (!Number.isSafeInteger(args.offset) || args.offset < 0)) ||
            (args.revision != null && (typeof args.revision !== 'string' || args.revision.length > 100)))))
          throw new ChannelError('INVALID_IMAGE_REQUEST', '请选择本轮图片列表中的图片并写明需要核对的问题');
        const attachment = progressive ? assertCurrent(candidate) : undefined;
        if (progressive && (args.action ?? 'read') === 'read') {
          const note = attachment?.description ? { description: attachment.description, quality: attachment.quality,
            imageMemoryId: attachment.imageMemoryId } : notes.get(args.imageId) ?? { description: candidate.image.description,
            quality: attachment?.quality || candidate.image.quality,
            imageMemoryId: attachment?.imageMemoryId || candidate.image.imageMemoryId };
          if (note.description) {
            const page = imageNotePage(args.imageId, note.description, args);
            if (note.imageMemoryId) onRead(memory.images.content(scope, note.imageMemoryId).reference);
            return JSON.stringify({ ok: true, imageId: args.imageId, source: 'saved-image-note',
              ...page, quality: note.quality || 'unknown',
              guidance: '这是已保存的图像笔记，不代表本次重新看图。' + (page.guidance || ''),
              ...(!['original', 'full'].includes(note.quality) ? { limitation: '笔记来源为缩略图或清晰度未核实，细节不能视为已确认' } : {}) });
          }
          if (args.offset || args.revision)
            throw new ChannelError('IMAGE_NOTE_CHANGED', '没有可翻页的图像笔记，请从第一页重新选择图片');
          if (!args.question) return JSON.stringify({ ok: true, imageId: args.imageId, source: 'saved-image-note',
            found: false, observation: '', guidance: '尚无图像笔记；确需看图时使用 inspect 并提供具体 question。' });
        }
        if (progressive && (args.offset || args.revision || typeof args.question !== 'string' || !args.question.trim()))
          throw new ChannelError('INVALID_IMAGE_REQUEST', '核对原图需要具体 question，不能附带笔记翻页参数');
        if (memory.store.modelConfig().vision === false)
          throw new ChannelError('VISION_DISABLED', '图像理解已关闭，不能查看图片');
        if (!progressive) assertCurrent(candidate);
        const cacheKey = JSON.stringify([args.imageId, args.question.trim()]);
        if (results.has(cacheKey)) return results.get(cacheKey);
        if (typeof transport.media !== 'function' || typeof runner.describeImage !== 'function')
          throw new ChannelError('VISION_UNAVAILABLE', '图片读取接口暂不可用，不能猜测画面');
        const read = await memory.enrich(scope, runner, transport, signal, {
          imageRequest: {
            key: candidate.entry.key,
            resourceId: candidate.image.resourceId,
            entry: candidate.entry,
            question: args.question.trim(),
          },
          executionSnapshot: execution.executionSnapshot,
        });
        signal.throwIfAborted();
        assertAllowed();
        assertCurrent(candidate);
        if (read?.error || !read?.description)
          throw new ChannelError('IMAGE_READ_FAILED', read?.error || '图片未完成按需读取，不能猜测画面');
        if (read.imageMemoryId) onRead(memory.images.content(scope, read.imageMemoryId).reference);
        if (progressive) notes.set(args.imageId, read);
        const result = JSON.stringify({
          ok: true,
          imageId: args.imageId,
          ...(progressive ? { source: 'visual-read', ...imageNotePage(args.imageId, read.description, {}) }
            : { observation: read.description }),
          quality: read.quality || 'unknown',
          ...(read.quality === 'thumbnail' || !['original', 'full'].includes(read.quality)
            ? { limitation: '仅取得缩略图或清晰度未核实，小字和画面细节可能看不清' }
            : {}),
        });
        results.set(cacheKey, result);
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        return JSON.stringify({
          ok: false,
          code: error instanceof ChannelError ? error.code : 'IMAGE_READ_FAILED',
          error: error instanceof ChannelError ? error.message : '图片未能完成按需读取，不能声称已经看图',
        });
      }
    },
  };
}
