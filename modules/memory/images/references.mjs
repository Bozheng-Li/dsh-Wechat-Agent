import { ChannelError } from '../../../shared/contracts.mjs';
import { referencedMessageId } from '../../../shared/message-references.mjs';

/** Resolve exact quoted message IDs inside one account/room. Quoted text and
 * resource locators never grant permissions or select arbitrary local files. */
export async function resolveMessageReferences(channel, scope, entry, signal, assertAllowed = () => {}) {
  if (!entry?.references?.length) return [];
  const before = entry.observedAt ?? entry.time ?? channel.now(), references = structuredClone(entry.references),
    generation = channel.memory.load(scope).generation;
  const check = () => {
    signal.throwIfAborted(); assertAllowed();
    if (channel.memory.load(scope).generation !== generation) throw new ChannelError('MEMORY_CHANGED', '会话记忆已清空，未写回旧图片引用');
  };
  if (references.some(ref => ref.messageType === 3 || ref.messageType === undefined)) {
    try { await channel.work.generatedImages.sync(scope, signal, assertAllowed, { before }); }
    catch (error) { signal.throwIfAborted(); if (['AUTH_CHANGED', 'ACCOUNT_CHANGED'].includes(error.code)) throw error; }
  }
  for (const ref of references) {
    check();
    const id = referencedMessageId(ref.messageId, scope.peerId);
    if (id && (ref.messageType === undefined || ref.messageType === 1 && !ref.content)) {
      const original = channel.memory.load(scope).entries.find(source => referencedMessageId(source.messageId, scope.peerId) === id &&
        (source.observedAt ?? source.time) <= before && (!ref.senderId || ref.senderId === scope.peerId || ref.senderId === source.senderId));
      if (original) {
        ref.senderId ||= original.senderId;
        ref.senderName ||= original.senderName;
        if (ref.messageType === undefined && original.attachments?.some(image => image.type === 'image')) ref.messageType = 3;
        else if (!original.mediaOnly && !original.contentUnavailable && !original.attachments?.length) {
          ref.messageType = 1;
          ref.content = String(original.bodyText ?? original.text).slice(0, 6000);
        }
      }
      if (ref.messageType === undefined && ['conversation', 'generated'].some(collection =>
        channel.imageMemory.byMessage({ ...scope, collection }, id, { before, senderId: ref.senderId }).length)) ref.messageType = 3;
    }
    if (ref.messageType !== 3 && !ref.content) ref.unavailable = '未保存该原消息编号对应的正文，不能凭附近消息补写引用';
    if (ref.messageType !== 3) continue;
    const images = []; let blocked = false;
    for (const collection of ['conversation', 'generated']) {
      const input = { ...scope, collection };
      try {
        const state = channel.imageMemory.load(input);
        if (Object.values(state.deleted).some(value => [value.messageId, ...(value.serverMessageIds ?? [])]
          .some(value => id && referencedMessageId(value, scope.peerId) === id))) blocked = true;
        // A deleted previously linked image must not be fetched again through
        // the quote's CDN, including indices from before source tombstones.
        if (ref.images?.some(image => image.collection === collection && (!state.items[image.id] || state.deleted[image.id]))) blocked = true;
        // Older tombstones did not store the original message ID. Recover the
        // exact source identity from retained history/task archives instead of
        // fetching a second copy with the quote's different resource ID.
        const sources = collection === 'conversation'
          ? channel.store.history(scope.accountId, scope.chatType, scope.peerId, 1000)
          : channel.work.generatedImages.entries(scope);
        for (const source of sources) for (const attachment of source.attachments ?? []) {
          if (attachment.type !== 'image' || !attachment.resourceId || !source.messageId) continue;
          if (![source.messageId, ...(attachment.generation?.serverMessageIds ?? [])]
            .some(value => id && referencedMessageId(value, scope.peerId) === id)) continue;
          if (state.deleted[channel.imageMemory.imageId(state, source, attachment)]) blocked = true;
        }
        const matches = channel.imageMemory.byMessage(input, id, { before, senderId: ref.senderId, includeDisabled: true });
        const known = channel.imageMemory.byMessage({ ...input, senderId: undefined }, id, { includeDisabled: true });
        if (known.length && !matches.length) blocked = true;
        if (matches.length && !state.settings.enabled) { blocked = true; continue; }
        for (const item of matches) {
          try {
            channel.imageMemory.content(input, item.id);
            images.push({ id: item.id, collection, digest: item.digest, description: item.description, quality: item.quality });
          } catch { blocked = true; }
        }
      } catch (error) {
        if (!(error instanceof ChannelError)) throw error;
        blocked = true;
      }
    }
    if (!images.length && !blocked && ref.resourceId && typeof channel.transport.media === 'function') {
      const input = { ...scope, collection: 'conversation' }, initial = channel.imageMemory.load(input);
      const source = { messageId: id || entry.messageId, senderId: ref.senderId, senderName: ref.senderName,
        text: '微信引用图片', time: entry.time }, attachment = { type: 'image', resourceId: ref.resourceId };
      if (initial.settings.enabled) try {
        const bytes = await channel.transport.media({ accountId: scope.accountId, peerId: scope.peerId,
          messageId: entry.messageId, resourceId: ref.resourceId, preferOriginal: true }, signal);
        check();
        const saved = await channel.imageMemory.capture(input, source, attachment, bytes, signal, { generation: initial.generation });
        if (saved) images.push({ id: saved.id, collection: 'conversation', digest: saved.digest, description: saved.description, quality: saved.quality });
      } catch (error) {
        check();
        ref.unavailable = error instanceof ChannelError ? error.message : '引用图片资源暂不可读取';
      }
    }
    ref.images = images;
    if (images.length) delete ref.unavailable;
    else ref.unavailable = blocked ? '原图已删除、到期、停用或不可读取，不能恢复或猜测画面'
      : ref.unavailable || '未找到该引用对应的原图；保留原消息编号，不能凭文字猜测画面';
  }
  check();
  channel.store.updateMessageReferences(scope, entry.key, references);
  return references;
}

/** Archive quotes from ordinary group conversation too, without calling vision. */
export async function resolvePendingMessageReferences(channel, scope, signal, assertAllowed) {
  const pending = channel.memory.load(scope).entries.filter(entry => entry.references?.some(ref =>
    ref.messageType === 3 && !Array.isArray(ref.images) || ref.messageType === undefined && !ref.unavailable ||
    ref.messageType === 1 && !ref.content && !ref.unavailable));
  for (const entry of pending) await resolveMessageReferences(channel, { ...scope, senderId: entry.senderId }, entry, signal, assertAllowed);
}

/** Queued work keeps its original bindings, but must recheck availability when
 * execution starts. It cannot revive an old CDN resource from a saved task. */
export function refreshReferenceImages(images, scope, references) {
  return references.map(ref => {
    if (!ref.images?.length) return ref;
    const available = ref.images.flatMap(saved => {
      const input = { ...scope, collection: saved.collection };
      try {
        if (!images.load(input).settings.enabled) return [];
        const item = images.content(input, saved.id);
        if (item.digest !== saved.digest) return [];
        return [{ ...saved, description: item.description, quality: item.quality }];
      } catch (error) {
        if (!(error instanceof ChannelError)) throw error;
        return [];
      }
    });
    return { ...ref, images: available, ...(!available.length ? { unavailable: '原图已删除、到期、停用或不可读取，不能恢复或猜测画面' } : {}) };
  });
}
