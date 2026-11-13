import { randomUUID } from 'node:crypto';
import { ChannelError, eligible, publicError } from '../../shared/contracts.mjs';
import { validStickerMd5 } from './wechat-stickers.mjs';
import { decodeBase64 } from './validation.mjs';
import { MEDIA_LIBRARY_LIMITS } from './limits.mjs';

export class WechatStickerService {
  constructor(channel) {
    this.channel = channel;
    this.controller = new AbortController();
    this.syncing = new Map(); this.nextSync = new Map(); this.progress = new Map();
    this.pending = new Map(); this.tail = Promise.resolve();
    this.describing = new Map(); this.descriptionTimers = new Map();
    this.connection = new AbortController(); this.connectionId = null;
    this.onStatus = () => { try { this.tick(); } catch {} };
    channel.transport.on?.('status', this.onStatus);
    this.timer = setInterval(this.onStatus, 30000); this.timer.unref?.();
    queueMicrotask(this.onStatus);
  }
  check(accountId, signal = this.controller.signal) {
    signal.throwIfAborted(); this.controller.signal.throwIfAborted();
    const status = this.channel.transport.status();
    if (this.channel.closed || !status.online || status.account?.id !== accountId)
      throw new ChannelError('ACCOUNT_CHANGED', '微信账号或连接已变化，表情操作已停止');
    return status;
  }
  updateConnection() {
    const status = this.channel.transport.status(), id = status.online ? status.account?.id : null;
    if (id !== this.connectionId) {
      this.connection.abort(new ChannelError('ACCOUNT_CHANGED', '微信连接已变化，旧表情操作已停止'));
      this.connection = new AbortController(); this.connectionId = id;
    }
  }
  signalFor(accountId, external) {
    this.updateConnection(); this.check(accountId, external || this.controller.signal);
    return AbortSignal.any([this.controller.signal, this.connection.signal,
      ...(this.channel.authorization ? [this.channel.authorization.combine(accountId)] : []), ...(external ? [external] : [])]);
  }
  view(accountId) {
    return { ...(this.channel.library.account(accountId).stickerSync || { state: 'idle' }),
      ...(this.progress.get(accountId) || {}), syncing: this.syncing.has(accountId),
      pending: [...this.pending.values()].filter(item => item.accountId === accountId).length,
      describing: this.describing.has(accountId),
      nativeAvailable: typeof this.channel.transport.readStickers === 'function' && this.channel.transport.status().nativeStickersReady !== false };
  }
  tick() {
    if (this.controller.signal.aborted || this.channel.closed) return;
    this.updateConnection();
    const status = this.channel.transport.status(), id = status.account?.id;
    if (status.online && id) this.scheduleDescriptions(id);
    if (typeof this.channel.transport.readStickers !== 'function') return;
    if (!status.online || !id || this.syncing.has(id) || (this.nextSync.get(id) || 0) > this.channel.now()) return;
    this.nextSync.set(id, this.channel.now() + 10 * 60 * 1000);
    // Chat capture remains useful when the native favorites endpoint is absent.
    void this.sync(id).catch(() => {}).then(() => this.collectRecent(id)).catch(() => {});
  }
  descriptionAllowed(accountId, signal) {
    this.check(accountId, signal);
    if (!this.channel.library.account(accountId).settings.autoDescribe || this.channel.store.modelConfig().vision !== true)
      throw new ChannelError('STICKER_DESCRIPTION_DISABLED', '自动整理表情含义已关闭');
  }
  scheduleDescriptions(accountId) {
    if (this.controller.signal.aborted || this.describing.has(accountId) || this.descriptionTimers.has(accountId) ||
      typeof this.channel.runner?.describeStickers !== 'function') return;
    const timer = setTimeout(() => {
      this.descriptionTimers.delete(accountId); void this.describePending(accountId).catch(() => {});
    }, 750);
    timer.unref?.(); this.descriptionTimers.set(accountId, timer);
  }
  describePending(accountId) {
    if (this.describing.has(accountId)) return this.describing.get(accountId);
    const pending = (async () => {
      const signal = this.signalFor(accountId);
      for (;;) {
        this.descriptionAllowed(accountId, signal);
        if (this.channel.library.jobs.get(accountId)?.running) return;
        const assets = this.channel.library.account(accountId).assets.filter(asset => asset.kind === 'sticker' && asset.bytes > 0 &&
          this.channel.library.assetEnabled(this.channel.library.account(accountId), asset) && (!asset.description || !asset.usage) &&
          (!asset.descriptionAttemptedAt || !asset.descriptionError || this.channel.now() - asset.descriptionAttemptedAt >= 10 * 60 * 1000) &&
          (!asset.sourceMessage || asset.nativeSticker?.favorite || eligible(this.channel.store.settings(accountId), asset.sourceMessage))).slice(0, 4);
        if (!assets.length) return;
        const assertAllowed = () => {
          this.descriptionAllowed(accountId, signal);
          if (assets.some(asset => asset.sourceMessage && !asset.nativeSticker?.favorite && !eligible(this.channel.store.settings(accountId), asset.sourceMessage)))
            throw new ChannelError('AUTH_CHANGED', '来源会话已撤销授权，未保存新的表情说明');
        };
        await this.channel.library.describe(accountId, assets.map(asset => asset.id), this.channel.runner,
          AbortSignal.any([signal, AbortSignal.timeout(120000)]), { onlyMissing: true, assertAllowed });
      }
    })().finally(() => this.describing.delete(accountId));
    this.describing.set(accountId, pending); return pending;
  }
  enqueue(accountId, key, task) {
    if (this.pending.has(key)) return this.pending.get(key).promise;
    if (this.pending.size >= MEDIA_LIBRARY_LIMITS.accountAssets) return Promise.resolve({ skipped: true, reason: '待保存的表情过多，本轮排队已满' });
    const item = { accountId };
    const promise = this.tail.then(async () => {
      await new Promise(resolve => setImmediate(resolve));
      this.check(accountId); return task();
    })
      .catch(failure => {
        if (!this.controller.signal.aborted && !['ACCOUNT_CHANGED', 'CANCELLED'].includes(failure.code)) {
          const previous = this.progress.get(accountId) || {};
          this.progress.set(accountId, { ...previous, failed: (previous.failed || 0) + 1, lastError: publicError(failure, '表情原图暂未保存，可重新收集').message });
        }
        return { failed: true };
      }).finally(() => this.pending.delete(key));
    item.promise = promise; this.pending.set(key, item); this.tail = promise;
    return promise;
  }
  sync(accountId, externalSignal) {
    if (this.syncing.has(accountId)) return this.syncing.get(accountId);
    const signal = this.signalFor(accountId, externalSignal);
    const promise = (async () => {
      this.check(accountId, signal);
      if (!this.channel.transport.readStickers) throw new ChannelError('STICKER_UNAVAILABLE', '当前微信组件尚不支持读取收藏表情，可以收集聊天中的表情图片');
      const snapshot = await this.channel.transport.readStickers({ accountId }, signal);
      this.check(accountId, signal);
      if (snapshot?.complete !== true || !Array.isArray(snapshot.items) || snapshot.items.length > MEDIA_LIBRARY_LIMITS.accountAssets || snapshot.items.some(item => !validStickerMd5(item.md5)))
        throw new ChannelError('STICKER_SYNC_INCOMPLETE', '未取得完整的微信收藏列表，原有表情保留');
      let imported = 0, skipped = 0, previews = 0;
      this.progress.set(accountId, { failed: 0, lastError: null });
      for (const [index, item] of snapshot.items.entries()) {
        // A large favorites list must yield between local commits so ordinary
        // incoming chat events can continue to be handled.
        await new Promise(resolve => setImmediate(resolve)); this.check(accountId, signal);
        const result = this.channel.library.saveWechatSticker(accountId, { md5: item.md5, source: 'favorite', favorite: true, ordinal: index + 1 });
        if (result.skipped) { skipped++; continue; }
        if (result.imported) imported++;
        if (!result.asset.bytes && item.previewAvailable && this.channel.transport.readStickerContent) {
          previews++;
          this.enqueue(accountId, accountId + ':favorite:' + item.md5, async () => {
            const signal = this.signalFor(accountId);
            const media = await this.channel.transport.readStickerContent({ accountId, md5: item.md5 }, signal);
            this.check(accountId);
            if (media.stickerMd5 !== item.md5) throw new ChannelError('STICKER_CONTENT_MISMATCH', '返回的表情原图不属于选中的表情');
            const favorite = this.channel.library.account(accountId).assets.find(asset => asset.nativeSticker?.md5 === item.md5)?.nativeSticker.favorite === true;
            const saved = this.channel.library.saveWechatSticker(accountId, { md5: item.md5, source: 'favorite', favorite,
              content: decodeBase64(media.data, MEDIA_LIBRARY_LIMITS.imageBytes), quality: media.quality });
            this.scheduleDescriptions(accountId); return saved;
          });
        }
      }
      this.channel.library.reconcileFavorites(accountId, snapshot.items.map(item => item.md5), snapshot.fetchedAt || this.channel.now());
      this.nextSync.set(accountId, this.channel.now() + 6 * 60 * 60 * 1000);
      this.scheduleDescriptions(accountId);
      return { count: snapshot.items.length, imported, skipped, previews };
    })().catch(failure => {
      this.nextSync.set(accountId, this.channel.now() + 10 * 60 * 1000);
      if (!signal.aborted) this.progress.set(accountId, { ...(this.progress.get(accountId) || {}), state: 'unavailable', lastError: publicError(failure, '微信收藏暂未同步，已有表情仍保留').message });
      throw failure;
    }).finally(() => this.syncing.delete(accountId));
    this.syncing.set(accountId, promise); return promise;
  }
  canCollect(accountId, message) {
    return ['incoming', 'outgoing'].includes(message?.direction) && message.source === 'longlink:NewSync' &&
      Array.isArray(message.message) && message.message.some(segment => segment.type === 'face' && segment.data?.resourceId) &&
      this.channel.library.account(accountId).settings.captureIncoming && eligible(this.channel.store.settings(accountId), message);
  }
  capture(accountId, message, { historical = false } = {}) {
    if (this.controller.signal.aborted || !this.canCollect(accountId, message)) return Promise.resolve({ skipped: true, reason: '该聊天未启用表情收集，或不是可收集的表情消息' });
    const age = this.channel.now() - message.time * 1000;
    if (!historical && (!Number.isFinite(age) || age < -60000 || age > 600000)) return Promise.resolve({ skipped: true, reason: '这张表情不在最近可收集的时间范围内' });
    const face = message.message.find(segment => segment.type === 'face' && segment.data?.resourceId);
    const md5 = validStickerMd5(face.data.stickerMd5) ? face.data.stickerMd5 : undefined;
    return this.enqueue(accountId, accountId + ':chat:' + (md5 || face.data.resourceId), async () => {
      if (!this.canCollect(accountId, message)) return { skipped: true, reason: '来源会话已撤销授权或关闭收集，未保存这张表情' };
      let saved;
      if (md5) {
        saved = this.channel.library.saveWechatSticker(accountId, { md5, source: 'chat', message });
        if (saved.skipped || saved.asset.bytes) { this.scheduleDescriptions(accountId); return saved; }
      }
      if (!this.channel.transport.media) return saved || { skipped: true, reason: '微信组件暂不支持读取表情原图' };
      const media = await this.channel.transport.media({ accountId, peerId: message.peerId, messageId: message.serverMessageId || message.id, resourceId: face.data.resourceId, preferOriginal: true, preserveStickerOriginal: true }, this.signalFor(accountId));
      this.check(accountId);
      if (!this.canCollect(accountId, message)) return { skipped: true, reason: '来源会话已撤销授权或关闭收集，未保存这张表情' };
      if (md5 && media.stickerMd5 && md5 !== media.stickerMd5) throw new ChannelError('STICKER_CONTENT_MISMATCH', '聊天表情原图与消息标识不匹配');
      const result = this.channel.library.saveWechatSticker(accountId, { md5: md5 || (validStickerMd5(media.stickerMd5) ? media.stickerMd5 : undefined),
        source: 'chat', message, content: decodeBase64(media.data, MEDIA_LIBRARY_LIMITS.imageBytes), quality: media.quality });
      this.scheduleDescriptions(accountId); return result;
    });
  }
  async collectRecent(accountId, signal = this.controller.signal) {
    this.check(accountId, signal);
    if (!this.channel.transport.recentStickers) throw new ChannelError('STICKER_UNAVAILABLE', '当前微信组件尚未提供最近聊天表情');
    const messages = await this.channel.transport.recentStickers({ accountId }, signal); this.check(accountId, signal);
    if (!Array.isArray(messages) || messages.length > 5000) throw new ChannelError('STICKER_INVALID', '聊天表情列表无效');
    const selected = messages.filter(message => this.canCollect(accountId, message)).slice(-300);
    for (const message of selected) this.capture(accountId, message, { historical: true });
    return { queued: selected.length };
  }
  async sendTest(accountId, assetId, signal = this.controller.signal) {
    const status = this.check(accountId, signal), library = this.channel.library;
    const recent = this.channel.store.data.records.filter(record => record.accountId === accountId && record.mode === 'sticker-test' && record.state === 'sent').slice(-1).map(record => record.replyMedia?.id);
    const asset = assetId ? library.resolveAsset(accountId, assetId) : library.randomSticker(accountId, { excludeIds: recent, random: this.channel.random });
    if (!asset) throw new ChannelError('STICKER_EMPTY', '还没有可用表情，请先同步微信收藏或收集聊天表情');
    const segment = await library.prepareSendSegment(accountId, asset.id, signal, { nativeReady: status.nativeStickersReady !== false });
    this.check(accountId, signal);
    const record = { key: 'sticker-test:' + randomUUID(), accountId, peerId: 'filehelper', chatType: 'private', senderId: accountId,
      sender: '本机所有者', mode: 'sticker-test', question: '试发表情到文件传输助手', createdAt: this.channel.now(), updatedAt: this.channel.now(), state: 'sending', sendAttempted: true,
      replyMedia: { id: asset.id, name: asset.name, kind: asset.kind, description: asset.description } };
    this.channel.store.remember(record.key, record.createdAt, record);
    try {
      const result = await this.channel.transport.send({ accountId, chatType: 'private', peerId: 'filehelper', message: [segment] }, signal);
      if (result?.delivery !== 'server-ack' || !Array.isArray(result.serverMessageIds) || result.serverMessageIds.length !== 1 || result.serverMessageIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) ||
        result.deliveryParts !== undefined && (!Array.isArray(result.deliveryParts) || result.deliveryParts.some(part => !part || typeof part !== 'object')))
        throw new ChannelError('SEND_UNKNOWN', '表情试发没有收到完整回执，结果不明，未自动重发', { delivery: 'unknown' });
      this.channel.store.update(record, { state: 'sent', sentAt: this.channel.now(), acknowledgedMessageIds: result.serverMessageIds, deliveryParts: result.deliveryParts });
      return { sent: true, destination: '文件传输助手', name: asset.name, native: result.messageType === 47 || result.deliveryParts?.some(part => part.type === 'face'), serverMessageIds: result.serverMessageIds };
    } catch (failure) {
      const details = failure.details || {}, rejected = ['not-sent', 'rejected'].includes(details.delivery);
      this.channel.store.update(record, { state: rejected ? 'failed' : 'unknown', reason: publicError(failure, '试发结果不明，请先在文件传输助手核对').message,
        delivery: details.delivery || 'unknown', acknowledgedMessageIds: details.acknowledgedMessageIds || [], deliveryParts: details.deliveryParts });
      throw failure;
    }
  }
  async favorite(accountId, assetId, signal = this.controller.signal) {
    this.check(accountId, signal);
    const library = this.channel.library, asset = library.resolveAsset(accountId, assetId, { enabledOnly: false });
    if (!asset.nativeSticker || !this.channel.transport.favoriteSticker) throw new ChannelError('STICKER_UNAVAILABLE', '只有从微信取得的表情可以直接收藏到微信；自行导入的图片保留在本机');
    const result = await this.channel.transport.favoriteSticker({ accountId, md5: asset.nativeSticker.md5 }, signal);
    this.check(accountId, signal);
    if (result?.saved !== true) throw new ChannelError('STICKER_FAVORITE_UNKNOWN', '微信尚未确认收藏，请同步后核对');
    library.resolveAsset(accountId, assetId, { enabledOnly: false });
    library.saveWechatSticker(accountId, { md5: asset.nativeSticker.md5, source: 'favorite', favorite: true });
    return result;
  }
  async whenIdle() { await Promise.allSettled([...this.syncing.values()]); await this.tail; await Promise.allSettled([...this.describing.values()]); }
  async close() {
    clearInterval(this.timer); this.channel.transport.off?.('status', this.onStatus); this.controller.abort();
    for (const timer of this.descriptionTimers.values()) clearTimeout(timer); this.descriptionTimers.clear();
    await this.whenIdle();
  }
}
