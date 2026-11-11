import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { materialFields, materialSourceKey, MATERIAL_ORGANIZE_TIMEOUT_MS } from '../../shared/moments-materials.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { MomentsMaterialStore, materialHash, materialRevision } from './material-store.mjs';
import { materialJSON, materialTextIsPublic, redactMaterialInput, reviewMaterialText } from './material-privacy.mjs';
import { downloadPublicImage } from './public-image.mjs';
import { momentsMaterialWebTools } from '../tools/moments-materials.mjs';

export class MomentsMaterials extends MomentsMaterialStore {
  constructor(channel, { downloadImage = downloadPublicImage } = {}) { super(channel); this.stopped = true; this.downloadImageBytes = downloadImage; }
  check(accountId, signal) {
    this.assert(); signal?.throwIfAborted(); const status = this.channel.transport.status();
    if (this.channel.closed || this.channel.fault || !status.online || status.account?.id !== accountId)
      throw new ChannelError('ACCOUNT_CHANGED', '微信连接或账号已变化，未继续处理朋友圈素材');
  }
  list(accountId) { return { ...super.list(accountId), running: this.activeAccount === accountId, runningKind: this.activeAccount === accountId ? this.activeKind : null }; }
  configure(accountId, input) { const result = super.configure(accountId, input); if (this.activeAccount === accountId) this.controller?.abort(); return result; }
  cancel(accountId) { this.assert(); if (this.activeAccount === accountId) this.controller?.abort(); return this.list(accountId); }
  webCheck(accountId, signal, check) {
    check(); this.check(accountId, signal);
    if (!this.account(accountId).settings.webImagesEnabled) throw new ChannelError('MOMENTS_MATERIAL_WEB_DISABLED', '素材库的按需联网取图尚未开启');
  }
  webTools(accountId, signal, check, imported = []) {
    const settings = this.account(accountId).settings, catalog = this.channel.work?.imageGeneration?.catalog?.();
    let searches = 0, downloads = 0, generations = 0;
    const combined = abort => AbortSignal.any([signal, abort].filter(Boolean));
    return momentsMaterialWebTools({ check, catalog: catalog ? { defaultProviderId: catalog.defaultProviderId, providers: catalog.providers?.map(({ providerId, name, models, defaultModel, size }) => ({ providerId, name, models, defaultModel, size })) } : null,
      search: settings.webImagesEnabled ? (args, abort) => { if (++searches > 3) throw new ChannelError('MOMENTS_MATERIAL_WEB_LIMIT', '本轮已搜索 3 次，请用已有结果或跳过'); return this.searchImages(accountId, args, combined(abort), check); } : undefined,
      download: settings.webImagesEnabled ? async (args, abort) => { if (++downloads > 2) throw new ChannelError('MOMENTS_MATERIAL_WEB_LIMIT', '本轮最多下载 2 张新素材'); const value = await this.downloadImage(accountId, args, combined(abort), check); imported.push(value.item); return value; } : undefined,
      generate: settings.generatedImagesEnabled && catalog?.enabled ? async (args, abort) => { if (++generations > 1) throw new ChannelError('MOMENTS_MATERIAL_GENERATE_LIMIT', '本轮已尝试生图，不再重复请求；请用已有素材或跳过配图');
        const value = await this.generateImage(accountId, args, 'agent-image-' + materialRevision(), combined(abort), check); imported.push(value.item); return value; } : undefined,
    });
  }
  async generateImage(accountId, args, requestId, signal, assertAllowed = () => {}) {
    const account = this.account(accountId, true), revision = account.revision;
    const check = () => { assertAllowed(); this.check(accountId, signal);
      if (!account.settings.generatedImagesEnabled || account.revision !== revision) throw new ChannelError('MOMENTS_MATERIAL_GENERATE_DISABLED', '素材库按需生图未开启或取材设置已变化'); };
    check();
    const service = this.channel.work?.imageGeneration;
    if (!service?.generate) throw new ChannelError('IMAGE_GENERATION_DISABLED', '生图接口尚未就绪，请在设置中配置');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200 || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000)
      throw new ChannelError('MOMENTS_MATERIAL_INVALID', '请填写有效的生图要求和操作编号');
    const fields = materialFields({ title: args.title, imageOrigin: 'ai' });
    if (!materialTextIsPublic(fields.title + '\n' + args.prompt, this.peers(accountId).flatMap(peer => [peer.name, peer.peerId])))
      throw new ChannelError('MOMENTS_MATERIAL_PRIVATE', '生图要求包含私人信息，未发送到生图接口');
    account.generations ??= {};
    const key = materialHash(requestId), inputHash = materialHash(args), prior = account.generations[key];
    if (prior) {
      if (prior.inputHash !== inputHash) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '相同生图操作的要求已改变，请新建操作');
      if (prior.state === 'saved') return { item: this.publicItem(accountId, this.item(accountId, prior.materialId)), reused: true };
      throw new ChannelError('MOMENTS_MATERIAL_GENERATE_ATTEMPTED', '这次生图已尝试过，未重复调用；请核对素材库或发起新的操作');
    }
    if (Object.values(account.items).filter(item => !item.deleted).length >= 500) throw new ChannelError('MOMENTS_MATERIAL_LIMIT', '素材库已满，请先清理不用的素材');
    const attempt = account.generations[key] = { inputHash, state: 'running', at: this.now() }; this.save();
    try {
      const generated = await service.generate({ prompt: args.prompt, ...(args.providerId ? { providerId: args.providerId } : {}), ...(args.model ? { model: args.model } : {}), ...(args.size ? { size: args.size } : {}) }, signal, check);
      check();
      const saved = this.put(accountId, { requestId: 'generated-' + key, fields, imageData: generated.bytes.toString('base64') });
      const item = this.item(accountId, saved.id);
      item.origin = 'generated'; item.generatedSource = { providerId: generated.providerId, providerName: generated.providerName, model: generated.model, prompt: args.prompt, generatedAt: this.now() };
      Object.assign(attempt, { state: 'saved', materialId: item.id }); this.save();
      let warning;
      try {
        const text = await this.channel.runner.describeImage({ type: 'image', data: generated.bytes.toString('base64'), mediaType: generated.mediaType, quality: 'original' }, signal,
          { question: '这是一张 AI 生成的朋友圈素材。仅描述画面中实际可见的主体、色彩、构图，不猜测身份、地点或经历，不转录私人信息。不要按生图提示词补写画面。' });
        check();
        if (typeof text !== 'string' || !text.trim() || text.length > 2000 || !materialTextIsPublic(text, this.peers(accountId).flatMap(peer => [peer.name, peer.peerId]))) throw new ChannelError('MOMENTS_MATERIAL_RESPONSE', '图片描述暂不可用');
        this.put(accountId, { id: item.id, revision: item.revision, fields: { ...item.fields, text } });
      } catch { check(); warning = '图片已保存，画面识别未完成；补充描述后才会参与自动选图。'; }
      return { item: this.publicItem(accountId, this.item(accountId, item.id)), reused: false, ...(warning ? { warning } : {}) };
    } catch (error) { if (attempt.state !== 'saved') { attempt.state = 'failed'; this.save(); } throw error; }
  }
  async searchImages(accountId, { query }, signal, check = () => {}) {
    this.webCheck(accountId, signal, check);
    const names = this.peers(accountId).flatMap(peer => [peer.name, peer.peerId]);
    if (typeof query !== 'string' || !query.trim() || query.length > 240 || !materialTextIsPublic(query, names)) throw new ChannelError('MOMENTS_MATERIAL_PRIVATE', '搜索只接受公开主题，不包含聊天原文或私人身份');
    const service = this.channel.runner.search?.forConfig(this.channel.store.modelConfig());
    if (!service?.search) throw new ChannelError('MOMENTS_RESEARCH_UNAVAILABLE', '搜索服务尚未配置');
    const result = await service.search({ query: query.trim(), maxResults: 5, includeImages: true }, signal);
    this.webCheck(accountId, signal, check);
    return { sources: (result.sources || []).slice(0, 5), images: (result.images || []).slice(0, 8), content: String(result.content || '').slice(0, 6000) };
  }
  async downloadImage(accountId, args, signal, check = () => {}) {
    this.webCheck(accountId, signal, check);
    const fields = materialFields({ title: args.title, text: args.description || '', url: args.sourceUrl || args.url, imageOrigin: 'unknown', imageUse: 'publish' });
    if (!materialTextIsPublic(fields.title + '\n' + fields.text, this.peers(accountId).flatMap(peer => [peer.name, peer.peerId]))) throw new ChannelError('MOMENTS_MATERIAL_PRIVATE', '图片标题或描述包含私人信息，未保存');
    const image = await this.downloadImageBytes(args.url, signal); this.webCheck(accountId, signal, check);
    const sha = materialHash(image.bytes), account = this.account(accountId, true);
    if (account.suppressed['web:' + sha]) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '这张网络图片已被删除，不再自动下载');
    const prior = Object.values(account.items).find(item => !item.deleted && item.image?.sha256 === sha);
    if (prior) return { item: this.publicItem(accountId, prior), reused: true };
    const saved = this.put(accountId, { requestId: 'web-image-' + sha, fields, imageData: image.bytes.toString('base64') }), item = this.item(accountId, saved.id);
    item.origin = 'web'; item.webSource = { url: args.url, finalUrl: image.url, sourceUrl: fields.url, downloadedAt: this.now() }; this.save();
    return { item: this.publicItem(accountId, item), reused: false };
  }
  async operation(accountId, signal, work, kind = 'organize') {
    this.check(accountId, signal); if (this.pending) throw new ChannelError('MOMENTS_MATERIAL_BUSY', '已有素材正在整理或识别，请稍后再试');
    this.activeAccount = accountId; this.activeKind = kind; this.controller = new AbortController();
    this.operationTimeout = AbortSignal.timeout(kind === 'organize' ? MATERIAL_ORGANIZE_TIMEOUT_MS : 300000);
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : []), this.operationTimeout]);
    this.pending = Promise.resolve().then(() => work(combined)).finally(() => { this.activeAccount = null; this.activeKind = null; this.controller = null; this.pending = null; this.operationTimeout = null; });
    return this.pending;
  }
  async describe(accountId, id, revision, signal) {
    const item = this.item(accountId, id);
    if (item.revision !== revision) throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '素材已更新，请重新打开');
    return this.operation(accountId, signal, async abort => {
      const image = this.image(accountId, id);
      const text = await this.channel.runner.describeImage({ type: 'image', data: image.data, mediaType: image.mediaType, quality: 'original' }, abort,
        { question: '为朋友圈素材记录图片中实际可见的主体、色彩和构图。不要辨认人物身份、转录姓名电话或聊天文字，不猜测拍摄者、地点、关系或经历。只写简短描述，不写朋友圈文案。' });
      this.check(accountId, abort);
      if (typeof text !== 'string' || !text.trim() || text.length > 2000 || !materialTextIsPublic(text)) throw new ChannelError('MOMENTS_MATERIAL_RESPONSE', '图片描述不可用，请手动补充；原图片保留');
      return this.put(accountId, { id, revision, fields: { ...item.fields, text } });
    }, 'describe');
  }
  gather(accountId) {
    const account = this.account(accountId), names = [], snapshots = [], records = [];
    if (!account.settings.sources.length) throw new ChannelError('MOMENTS_MATERIAL_SOURCE', '请先保存允许取材的会话，再整理素材');
    if (!this.channel.memory?.load) throw new ChannelError('MOMENTS_MATERIAL_SOURCE', '聊天记忆尚未就绪，未整理素材');
    for (const source of account.settings.sources) {
      if (!this.sourceAllowed(accountId, source)) throw new ChannelError('MOMENTS_MATERIAL_SOURCE', '取材会话已撤销授权，请更新素材整理范围');
      const doc = this.channel.memory.load({ accountId, ...source });
      snapshots.push({ source, generation: doc.generation, revision: doc.revision });
      names.push(source.peerId, this.peers(accountId).find(peer => materialSourceKey(peer) === materialSourceKey(source))?.name);
      // Compacted summaries can repeat already deleted ideas. Only consume original, keyed messages.
      const entries = doc.entries.slice(-100);
      for (const entry of entries) {
        names.push(entry.senderId, entry.senderName);
        if (typeof entry.key !== 'string' || !entry.key || typeof entry.text !== 'string' || !entry.text.trim() || entry.mediaOnly || entry.mode === 'work') continue;
        const key = materialHash([materialSourceKey(source), entry.key]);
        if (account.seen[key]) continue;
        const at = typeof entry.time === 'number' ? entry.time < 1e12 ? entry.time * 1000 : entry.time : this.now();
        records.push({ key, source, at, text: entry.text });
      }
    }
    let budget = 16000;
    const selected = records.sort((a, b) => b.at - a.at).filter(row => {
      if (row.text.length > 4000 || row.text.length > budget) return false; budget -= row.text.length; return true;
    }).slice(0, 100).map((row, index) => ({ ...row, id: 'source-' + index, text: redactMaterialInput(row.text, names) }));
    return { records: selected, snapshots, names };
  }
  async organize(accountId, requestId, signal, automatic = false) {
    this.check(accountId, signal);
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new ChannelError('MOMENTS_MATERIAL_INVALID', '整理操作缺少编号');
    const account = this.account(accountId, true);
    if (account.lastRun?.requestId === requestId && account.lastRun.state !== 'running') {
      if (['failed', 'interrupted'].includes(account.lastRun.state)) throw new ChannelError('MOMENTS_MATERIAL_ORGANIZE', account.lastRun.error);
      return this.list(accountId);
    }
    return this.operation(accountId, signal, async abort => {
      const revision = account.revision, startedAt = this.now(); let sourceSnapshots = [];
      const check = () => {
        this.check(accountId, abort);
        if (account.revision !== revision || automatic && (this.stopped || !account.settings.enabled || !this.channel.store.settings(accountId).enabled))
          throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '素材整理设置或运行状态已变化，旧结果未保存');
        for (const snapshot of sourceSnapshots) if (!this.sourceAllowed(accountId, snapshot.source) || this.channel.memory.load({ accountId, ...snapshot.source }).generation !== snapshot.generation)
          throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '原聊天记忆已清理、过期或撤权，本次整理结果未保存');
      };
      account.lastRun = { requestId, state: 'running', stage: 'reading', at: startedAt, added: 0, updated: 0, rejected: 0 }; this.save();
      try {
        check(); const gathered = this.gather(accountId), { records, names, snapshots } = gathered; sourceSnapshots = snapshots;
        if (!records.length) { account.lastRun.state = 'empty'; return this.list(accountId); }
        const existing = Object.values(account.items).filter(item => item.origin === 'chat' && this.eligible(accountId, item)).slice(-40)
          .map(item => ({ id: item.id, revision: item.revision, title: item.fields.title, text: item.fields.text }));
        account.lastRun.stage = 'organizing'; this.save();
        const result = materialJSON(await this.channel.runner.run({ mode: 'moments-materials', tools: this.webTools(accountId, abort, check), allowEmptyReply: true, signal: abort,
          systemOverride: readPrompt('moments/materials.md'), text: JSON.stringify({ now: new Date(this.now()).toISOString(),
            records: records.map(({ id, at, text }) => ({ id, at: new Date(at).toISOString(), text })), existing }) }));
        check();
        if (!result || Object.keys(result).some(key => key !== 'items') || !Array.isArray(result.items) || result.items.length > 8)
          throw new ChannelError('MOMENTS_MATERIAL_RESPONSE', '素材整理结果格式无效，原素材保留');
        const proposals = result.items.map((row, index) => {
          if (!row || Object.keys(row).some(key => !['title', 'text', 'sourceIds', 'updateId', 'expiresInDays'].includes(key)) ||
            !Array.isArray(row.sourceIds) || !row.sourceIds.length || row.sourceIds.length > 10 || row.sourceIds.some(id => !records.some(record => record.id === id)) ||
            row.updateId && !existing.some(item => item.id === row.updateId) ||
            row.expiresInDays !== null && (!Number.isInteger(row.expiresInDays) || row.expiresInDays < 1 || row.expiresInDays > 30))
            throw new ChannelError('MOMENTS_MATERIAL_RESPONSE', '素材整理引用或有效期无效，原素材保留');
          const fields = materialFields({ title: row.title, text: row.text, expiresAt: row.expiresInDays ? this.now() + row.expiresInDays * 86400000 : null });
          if (!fields.text || !materialTextIsPublic(fields.title + '\n' + fields.text, names)) return null;
          const refs = row.sourceIds.map(id => records.find(record => record.id === id));
          return { id: 'proposal-' + index, fields, refs, updateId: row.updateId || null };
        }).filter(Boolean);
        account.lastRun.stage = 'reviewing'; this.save();
        const safe = proposals.length ? await reviewMaterialText(this.channel, proposals.map(item => ({ id: item.id, title: item.fields.title, text: item.fields.text })), abort, check,
          records.map(({ id, text }) => ({ id, text }))) : new Set();
        check();
        for (const snapshot of snapshots) {
          if (!this.sourceAllowed(accountId, snapshot.source) || this.channel.memory.load({ accountId, ...snapshot.source }).generation !== snapshot.generation)
            throw new ChannelError('MOMENTS_MATERIAL_CHANGED', '原聊天记忆已清理、过期或撤权，本次整理结果未保存');
        }
        for (const proposal of proposals) {
          if (!safe.has(proposal.id)) continue;
          const fingerprint = materialHash([proposal.fields.title, proposal.fields.text]);
          if (account.suppressed[fingerprint] || Object.values(account.items).some(item => item.fingerprint === fingerprint)) continue;
          const previous = proposal.updateId ? account.items[proposal.updateId] : null;
          if (proposal.updateId && (!previous || !this.eligible(accountId, previous) || previous.revision !== existing.find(item => item.id === proposal.updateId)?.revision)) continue;
          if (!previous && Object.values(account.items).filter(item => !item.deleted).length >= 500) continue;
          const sources = [...new Map([...(previous?.sources || []), ...proposal.refs.map(ref => ({ ...ref.source, at: ref.at }))].map(source => [materialSourceKey(source), source])).values()];
          const id = previous?.id || materialHash([accountId, fingerprint]).slice(0, 32);
          account.items[id] = { id, revision: materialRevision(), kind: 'text', origin: 'chat', fields: proposal.fields, fingerprint,
            sources, uses: previous?.uses || {}, createdAt: previous?.createdAt || this.now(), updatedAt: this.now() };
          account.lastRun[previous ? 'updated' : 'added']++;
        }
        for (const record of records) account.seen[record.key] = true;
        Object.assign(account.lastRun, { state: 'done', rejected: result.items.length - safe.size, processed: records.length });
      } catch (error) {
        Object.assign(account.lastRun, { state: 'failed', error: error?.name === 'TimeoutError' ? this.operationTimeout?.aborted ? '整理达到 30 分钟上限，原素材保留' : '素材整理请求超时，原素材保留' : error?.name === 'AbortError' ? '本次整理已取消，原素材保留' : publicError(error, '素材整理失败，原素材保留').message });
        throw new ChannelError('MOMENTS_MATERIAL_ORGANIZE', account.lastRun.error);
      } finally { account.nextRunAt = account.settings.enabled ? this.now() + account.settings.intervalMinutes * 60000 : 0; if (!this.error) this.save(); }
      return this.list(accountId);
    });
  }
  start() { if (this.timer || this.error) return; this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30000); this.timer.unref?.(); }
  tick() {
    const status = this.channel.transport.status(), accountId = status.account?.id, account = accountId && this.account(accountId);
    if (this.stopped || this.pending || this.error || !status.online || !account?.settings.enabled || !this.channel.store.settings(accountId).enabled || !account.nextRunAt || account.nextRunAt > this.now() || this.channel.momentsAutomation?.publishing.pending)
      return Promise.resolve();
    return this.organize(accountId, 'automatic-' + account.nextRunAt, null, true);
  }
  async close() { this.stopped = true; clearInterval(this.timer); this.timer = null; this.controller?.abort(); await this.pending?.catch(() => {}); }
  async whenIdle() { await this.pending?.catch(() => {}); }
}
