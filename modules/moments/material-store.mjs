import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson } from '../../backend/storage/atomic-json.ts';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { ChannelError } from '../../shared/contracts.mjs';
import { materialFields, materialId, materialObject, materialSettings, materialSourceKey } from '../../shared/moments-materials.mjs';
import { inspectAssetImage } from '../media/image-format.mjs';
import { workPath } from '../work/policy.mjs';

export const materialHash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const materialRevision = () => randomUUID();
export class MomentsMaterialStore {
  constructor(channel) {
    this.channel = channel; this.now = channel.now; this.data = { version: 1, ownerStoreId: channel.store.data.storeId, accounts: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (data.version !== 1 || data.ownerStoreId !== channel.store.data.storeId || !materialObject(data.accounts)) throw Error();
      for (const [key, account] of Object.entries(data.accounts)) {
        if (typeof account.accountId !== 'string' || !account.accountId || key !== materialHash(account.accountId) || !materialObject(account.items) || !materialObject(account.seen) || !materialObject(account.suppressed) || typeof account.revision !== 'string' ||
          !Number.isSafeInteger(account.nextRunAt) || Object.values(account.seen).some(value => value !== true) || Object.values(account.suppressed).some(value => value !== true)) throw Error();
        account.settings = materialSettings(account.settings);
        if (account.generations !== undefined && (!materialObject(account.generations) || Object.entries(account.generations).some(([id, attempt]) =>
          !/^[a-f0-9]{64}$/.test(id) || !materialObject(attempt) || !['running', 'failed', 'saved'].includes(attempt.state) || !/^[a-f0-9]{64}$/.test(attempt.inputHash) ||
          !Number.isSafeInteger(attempt.at) || attempt.state === 'saved' && !materialId(attempt.materialId)))) throw Error();
        for (const [id, item] of Object.entries(account.items)) {
          if (!materialId(id) || item.id !== id || typeof item.revision !== 'string' || !['manual', 'chat', 'web', 'generated'].includes(item.origin) || !['text', 'image'].includes(item.kind) ||
            !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.updatedAt) || !Array.isArray(item.sources) || !materialObject(item.uses)) throw Error();
          materialFields(item.fields);
          if (item.origin === 'chat' && !item.sources.length || item.kind === 'image' && !item.image || item.kind === 'text' && item.image) throw Error();
          for (const source of item.sources) {
            materialSettings({ sources: [{ chatType: source.chatType, peerId: source.peerId }] });
            if (!Number.isSafeInteger(source.at)) throw Error();
          }
          for (const [runId, use] of Object.entries(item.uses)) if (!materialObject(use) || use.runId !== runId || typeof use.revision !== 'string' || !Number.isSafeInteger(use.at) ||
            use.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(use.contentHash)) throw Error();
          if (item.image && (!new RegExp('^storage/moments/material-images/' + key + '/' + id + '\\.(png|jpg)$').test(item.image.path) || !/^[a-f0-9]{64}$/.test(item.image.sha256))) throw Error();
        }
        if (account.lastRun?.state === 'running') account.lastRun = { ...account.lastRun, state: 'interrupted', error: '上次整理中断，原素材保留；下次只处理尚未整理的内容' };
      }
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') this.error = '朋友圈素材库无法读取或归属不符，原文件保留；请检查后再使用'; }
  }
  file() { return workPath(this.channel.store.root, 'storage/moments/materials.json'); }
  assert() { if (this.error) throw new ChannelError('MOMENTS_MATERIAL_STATE', this.error); }
  save() {
    this.assert(); try { atomicJson(this.file(), this.data); }
    catch { this.error = '朋友圈素材库保存失败，请检查目录权限和磁盘空间'; throw new ChannelError('MOMENTS_MATERIAL_STATE', this.error); }
  }
  account(accountId, create = false) {
    const key = materialHash(accountId), existing = this.data.accounts[key];
    if (existing) return existing;
    const value = { accountId, revision: materialRevision(), settings: materialSettings(), items: {}, seen: {}, suppressed: {}, nextRunAt: 0, lastRun: null };
    if (create) this.data.accounts[key] = value; return value;
  }
  peers(accountId) { return this.channel.store.conversations(accountId).filter(peer => peer.authorized).map(({ chatType, peerId, name }) => ({ chatType, peerId, name })); }
  sourceAllowed(accountId, source) {
    const selected = new Set(this.account(accountId).settings.sources.map(materialSourceKey));
    const settings = this.channel.store.settings(accountId);
    return selected.has(materialSourceKey(source)) && (source.chatType === 'group' ? settings.groups : settings.privatePeers).includes(source.peerId);
  }
  eligible(accountId, item) {
    return !item.deleted && item.fields.enabled && (!item.fields.expiresAt || item.fields.expiresAt > this.now()) &&
      (item.origin !== 'chat' || item.sources.every(source => this.sourceAllowed(accountId, source)));
  }
  contentHash(item) { return materialHash([item.fields.text, item.fields.url, item.image?.sha256 || null]); }
  used(item) { return Object.values(item.uses).some(use => use.revision === item.revision || use.contentHash === this.contentHash(item)); }
  publicItem(accountId, item, peers = this.peers(accountId)) {
    return { id: item.id, revision: item.revision, kind: item.kind, origin: item.origin, ...item.fields,
      createdAt: item.createdAt, updatedAt: item.updatedAt, uses: Object.values(item.uses), available: this.eligible(accountId, item), webSource: item.webSource || null, generatedSource: item.generatedSource || null,
      usedCurrentVersion: this.used(item), selectable: this.eligible(accountId, item) && !!item.fields.text && !this.used(item),
      sources: item.sources.map(source => ({ chatType: source.chatType, peerId: source.peerId,
        name: peers.find(peer => materialSourceKey(peer) === materialSourceKey(source))?.name || source.peerId, at: source.at })),
      image: item.image ? { mediaType: item.image.mediaType, width: item.image.width, height: item.image.height } : null };
  }
  list(accountId) {
    const account = this.account(accountId), peers = this.peers(accountId);
    return { settings: structuredClone(account.settings), revision: account.revision, nextRunAt: account.nextRunAt, lastRun: structuredClone(account.lastRun),
      peers, error: this.error || null,
      items: Object.values(account.items).filter(item => !item.deleted).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(item => this.publicItem(accountId, item, peers)) };
  }
  item(accountId, id) {
    this.assert(); const item = this.account(accountId).items[id];
    if (!materialId(id) || !item || item.deleted) throw new ChannelError('MOMENTS_MATERIAL_MISSING', '素材不存在、已删除或不属于当前账号'); return item;
  }
  configure(accountId, input) {
    this.assert(); const settings = materialSettings(input), peers = new Set(this.peers(accountId).map(materialSourceKey));
    if (settings.sources.some(source => !peers.has(materialSourceKey(source)))) throw new ChannelError('MOMENTS_MATERIAL_SOURCE', '取材范围中有未授权或已移除的会话，请重新选择');
    const account = this.account(accountId, true); account.settings = settings; account.revision = materialRevision();
    account.nextRunAt = settings.enabled ? this.now() + settings.intervalMinutes * 60000 : 0; this.save(); return this.list(accountId);
  }
  put(accountId, { id, revision, requestId, fields, imageData }) {
    this.assert(); const account = this.account(accountId, true), previous = id ? this.item(accountId, id) : null;
    if (previous && previous.revision !== revision) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '素材已更新，请重新打开后编辑');
    if (!previous && (typeof requestId !== 'string' || !requestId || requestId.length > 200)) throw new ChannelError('MOMENTS_MATERIAL_INVALID', '新增素材缺少操作编号');
    const values = materialFields(fields), selected = id || materialHash([accountId, 'material', requestId]).slice(0, 32);
    if (previous?.origin === 'generated') values.imageOrigin = 'ai';
    const fingerprint = materialHash({ fields: values, image: imageData ? materialHash(imageData) : null });
    if (!previous && account.items[selected]) {
      if (account.items[selected].requestHash !== fingerprint || account.items[selected].deleted) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '该保存操作已有不同内容，请刷新素材列表');
      return this.publicItem(accountId, account.items[selected]);
    }
    if (!previous && Object.values(account.items).filter(item => !item.deleted).length >= 500) throw new ChannelError('MOMENTS_MATERIAL_LIMIT', '每个账号最多保留 500 条素材，请先清理不用的素材');
    if (previous && imageData !== undefined) throw new ChannelError('MOMENTS_MATERIAL_INVALID', '更换图片请新增素材，避免改变已生成草稿的配图');
    let image = previous?.image;
    if (imageData !== undefined) {
      if (typeof imageData !== 'string' || imageData.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageData)) throw new ChannelError('MOMENTS_MATERIAL_IMAGE', '请选择有效 PNG/JPEG 图片，每张最多 10 MiB');
      const bytes = Buffer.from(imageData, 'base64'), info = inspectAssetImage(bytes, { maxBytes: 10 * 1024 * 1024 });
      if (!['image/png', 'image/jpeg'].includes(info.mediaType)) throw new ChannelError('MOMENTS_MATERIAL_IMAGE', '朋友圈素材图片暂只支持 PNG/JPEG');
      const relative = `storage/moments/material-images/${materialHash(accountId)}/${selected}.${info.mediaType === 'image/png' ? 'png' : 'jpg'}`;
      const target = workPath(this.channel.store.root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); atomicBytes(target, bytes);
      image = { path: relative, sha256: materialHash(bytes), mediaType: info.mediaType, width: info.width, height: info.height };
    }
    if (!image && !values.text) throw new ChannelError('MOMENTS_MATERIAL_INVALID', '文字素材还需要填写内容');
    // Metadata edits and toggling availability must not recycle already posted content.
    if (previous) for (const use of Object.values(previous.uses)) if (use.revision === previous.revision) use.contentHash ??= this.contentHash(previous);
    const item = { id: selected, revision: materialRevision(), kind: image ? 'image' : 'text', origin: previous?.origin || 'manual', fields: values,
      createdAt: previous?.createdAt || this.now(), updatedAt: this.now(), sources: previous?.sources || [], uses: previous?.uses || {},
      ...(image ? { image } : {}), ...(previous?.webSource ? { webSource: previous.webSource } : {}), ...(previous?.generatedSource ? { generatedSource: previous.generatedSource } : {}), requestHash: previous?.requestHash || fingerprint, ...(previous?.fingerprint ? { fingerprint: previous.fingerprint } : {}) };
    account.items[selected] = item; this.save(); return this.publicItem(accountId, item);
  }
  remove(accountId, id, revision) {
    return this.removeMany(accountId, [{ id, revision }]);
  }
  removeMany(accountId, entries) {
    const selected = entries.map(({ id, revision }) => {
      const item = this.item(accountId, id);
      if (item.revision !== revision) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '素材已更新，请重新读取后删除');
      return item;
    });
    const images = [];
    for (const item of selected) {
    const account = this.account(accountId); if (item.fingerprint) account.suppressed[item.fingerprint] = true;
    const image = item.image;
    if (image) images.push(image);
    if (item.origin === 'web' && image) account.suppressed['web:' + image.sha256] = true;
    item.deleted = true; item.fields = materialFields({ title: '已删除素材', enabled: false }); item.sources = [];
    item.kind = 'text'; item.origin = 'manual'; delete item.image; delete item.webSource; delete item.generatedSource; item.revision = materialRevision();
    }
    this.save();
    // The tombstone is persisted before its image is removed, so failures never resurrect it.
    let warning;
    for (const image of images) { try { fs.unlinkSync(workPath(this.channel.store.root, image.path)); } catch (error) { if (error.code !== 'ENOENT') warning = '素材已移除，部分原图片文件暂未清理'; } }
    if (warning) return { ...this.list(accountId), warning };
    return this.list(accountId);
  }
  image(accountId, id) {
    const item = this.item(accountId, id); if (!item.image) throw new ChannelError('MOMENTS_MATERIAL_IMAGE', '这条素材没有图片');
    const target = workPath(this.channel.store.root, item.image.path), stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new ChannelError('MOMENTS_MATERIAL_IMAGE', '素材图片不可用');
    const bytes = fs.readFileSync(target);
    if (materialHash(bytes) !== item.image.sha256) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '素材图片已改变，未继续使用');
    return { bytes, ...item.image, data: bytes.toString('base64') };
  }
  candidates(accountId) {
    this.assert(); return Object.values(this.account(accountId).items)
      .filter(item => this.eligible(accountId, item) && item.fields.text && !this.used(item))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40).map(item => ({ id: item.id, revision: item.revision, kind: item.kind,
        title: item.fields.title, text: item.fields.text, url: item.fields.url, origin: item.origin, imageUse: item.fields.imageUse, imageOrigin: item.fields.imageOrigin }));
  }
  assertSelection(accountId, selection = []) {
    for (const ref of selection) {
      const item = this.item(accountId, ref.id);
      if (!this.eligible(accountId, item) || this.used(item) || item.revision !== ref.revision) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '选用素材已更新、使用、停用、过期或撤回取材授权，请重新生成草稿', { snsDelivery: 'not-sent' });
    }
  }
  markUsed(accountId, runId, selection = []) {
    if (!selection.length) return; this.assert();
    for (const ref of selection) { const item = this.account(accountId).items[ref.id]; if (item) item.uses[runId] ??= { runId, at: this.now(), revision: ref.revision, ...(item.revision === ref.revision ? { contentHash: this.contentHash(item) } : {}) }; }
    this.save();
  }
}
