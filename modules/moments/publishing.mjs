import fs from 'node:fs';
import { timeLimitMs, timeDurationLabel, assertOnlyTimeChanges } from '../../shared/time-settings.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson } from '../../backend/storage/atomic-json.ts';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { validateAudienceSelection } from '../../shared/moments-audience.mjs';
import { momentsPublishingSettings, momentsPlanSettings, momentsPlanId, momentsRunId, nextMomentsOccurrence, visibleMomentsText,
  MOMENTS_TEXT_FALLBACK_RESERVE_MS } from '../../shared/moments-publishing.mjs';
import { workPath } from '../work/policy.mjs';
import { momentsImage } from './media.mjs';
import { generateMomentsContent, similarMomentsText } from './publishing-content.mjs';
import { reviewMaterialText } from './material-privacy.mjs';
import { reviewMomentsContent } from './publishing-review.mjs';
import { canOmitMomentsImage, omitMomentsImage, reviewMomentsTextOnly } from './publishing-fallback.mjs';
import { arrangeMoments, momentsDate } from './arrangement.mjs';

const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const states = new Set(['generating', 'draft', 'sending', 'published', 'published-unverified', 'deleted', 'failed', 'rejected', 'unknown', 'skipped', 'discarded']);
const unresolved = state => ['unknown', 'published-unverified'].includes(state);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Independent durable plans; an occurrence is consumed before calling AI. */
export class MomentsPublishing {
  constructor(channel) {
    this.channel = channel; this.now = channel.now; this.stopped = true;
    this.data = { version: 1, ownerStoreId: channel.store.data.storeId, accounts: {}, plans: {}, runs: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (data.version !== 1 || data.ownerStoreId !== channel.store.data.storeId || ![data.accounts, data.plans, data.runs].every(object)) throw Error();
      for (const [key, account] of Object.entries(data.accounts)) { if (typeof account.accountId !== 'string' || key !== hash(account.accountId) || typeof account.revision !== 'string') throw Error(); account.settings = momentsPublishingSettings(account.settings); }
      for (const [id, plan] of Object.entries(data.plans)) {
        if (!momentsPlanId(id) || plan.id !== id || typeof plan.accountId !== 'string' || typeof plan.revision !== 'string' || !Number.isSafeInteger(plan.nextRunAt) || plan.nextRunAt < 0 || !Number.isSafeInteger(plan.createdAt) || !Number.isSafeInteger(plan.updatedAt)) throw Error();
        momentsPlanSettings(plan.settings);
        if (plan.automatic && (!object(plan.automatic) || !/^20\d{2}-\d{2}-\d{2}$/.test(plan.automatic.date) || !Number.isInteger(plan.automatic.slot) || plan.automatic.slot < 0 || plan.automatic.slot > 7 || typeof plan.automatic.edited !== 'boolean' || typeof plan.automatic.suppressed !== 'boolean')) throw Error();
      }
      for (const [id, run] of Object.entries(data.runs)) {
        if (!momentsRunId(id) || run.id !== id || typeof run.accountId !== 'string' || !states.has(run.state) || !Number.isSafeInteger(run.createdAt) ||
            typeof run.requestId !== 'string' || !run.requestId || run.requestId.length > 2000 || run.inputHash !== hash(run.settings) || run.text !== undefined && (typeof run.text !== 'string' || run.text.length > 2000) ||
            run.textOnly !== undefined && typeof run.textOnly !== 'boolean') throw Error();
        momentsPlanSettings(run.settings);
        if (!Number.isSafeInteger(run.scheduledAt) || !Number.isSafeInteger(run.updatedAt) || !['preview', 'schedule'].includes(run.origin) || run.planId !== undefined && (!momentsPlanId(run.planId) || data.plans[run.planId]?.accountId !== run.accountId) ||
            run.image && (!object(run.image) || typeof run.image.path !== 'string' || !new RegExp('^storage/moments/publishing-media/' + id + '\\.(png|jpg)$').test(run.image.path) || !/^[a-f0-9]{64}$/.test(run.image.sha256)) ||
            (run.state === 'sending' || unresolved(run.state)) && (!object(run.query) || run.query.action !== 'publish' || run.query.text !== run.text ||
              (run.settings.useDefaultAudience === true
                ? !Array.isArray(run.query.blockedLabelIds) || !Array.isArray(run.query.blockedUserIds)
                : JSON.stringify(run.query.blockedLabelIds) !== JSON.stringify(run.settings.blockedLabelIds) || JSON.stringify(run.query.blockedUserIds) !== JSON.stringify(run.settings.blockedUserIds))) ||
            run.state === 'published' && (!Number.isSafeInteger(run.publishedAt) || !/^[1-9][0-9]{0,19}$/.test(run.postId) || !['server-ack','verified-existing'].includes(run.delivery)) ||
            run.state === 'deleted' && (!/^[1-9][0-9]{0,19}$/.test(run.postId) || !object(run.deletion) || run.deletion.postId !== run.postId ||
              !Number.isSafeInteger(run.deletion.confirmedAt) || !['server-ack', 'verified-existing'].includes(run.deletion.delivery))) throw Error();
        if (run.state === 'sending') { run.state = 'unknown'; run.error = '上次发布提交中断，结果不明，未重发；请核对回执'; }
        if (run.state === 'generating') { run.state = 'failed'; run.error = '上次生成中断，本时段不自动再次调用 AI；已有内容保留'; }
        if (unresolved(run.state) && run.planId) { const plan = data.plans[run.planId]; plan.settings.enabled = false; plan.nextRunAt = 0; plan.waitingReason = '上次发布或屏蔽范围尚未确认，计划已暂停，请核对回执';
          if (plan.automatic) { plan.automatic.edited = true; const account = data.accounts[hash(run.accountId)]; if (account) { account.settings.automatic.enabled = false; account.automaticWaitingReason = '上次发布结果不明，自动安排已暂停，请核对回执后再开启'; } } }
      }
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') this.error = '自动发布记录无法读取或归属无效；原文件保留，自动发布已停止'; }
  }
  file() { return workPath(this.channel.store.root, 'storage/moments/publishing.json'); }
  save() {
    if (this.error) throw new ChannelError('MOMENTS_PUBLISH_STATE', this.error);
    try { atomicJson(this.file(), this.data); }
    catch { this.error = '自动发布记录保存失败，已停止发布，请检查磁盘与目录权限'; this.controller?.abort(); throw new ChannelError('STATE_WRITE_FAILED', this.error); }
  }
  check(accountId, signal, allowOffline = false) {
    signal?.throwIfAborted();
    if (this.error) throw new ChannelError('MOMENTS_PUBLISH_STATE', this.error);
    const status = this.channel.transport.status();
    if (this.channel.closed || this.channel.fault || !allowOffline && !status.online || status.account?.id !== accountId) throw new ChannelError('ACCOUNT_CHANGED', '微信账号、连接或运行状态已变化，未继续自动发布');
  }
  account(accountId) { return this.data.accounts[hash(accountId)] ?? { accountId, settings: momentsPublishingSettings(), revision: '' }; }
  list(accountId) {
    const visible = Object.values(this.data.plans).filter(plan => plan.accountId === accountId && !plan.deleted && !plan.automatic?.suppressed);
    const upcoming = visible.filter(plan => !plan.automatic || plan.nextRunAt > this.now());
    const history = visible.filter(plan => plan.automatic && plan.nextRunAt <= this.now()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
    const plans = [...upcoming, ...history].sort((a, b) => (a.nextRunAt || Number.MAX_SAFE_INTEGER) - (b.nextRunAt || Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt);
    const runs = Object.values(this.data.runs).filter(run => run.accountId === accountId && !run.historyDeleted).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    return { ...copy(this.account(accountId)), plans: copy(plans), runs: runs.map(run => this.publicRun(run)),
      running: this.activeAccount === accountId, activePlanId: this.activeAccount === accountId ? this.activePlanId ?? null : null,
      operationStartedAt: this.activeAccount === accountId ? this.operationStartedAt : null, schedulerStarted: !this.stopped, error: this.error ?? null };
  }
  publicRun(run) { const { query, ...value } = run; return copy({ ...value, hasImage: !!run.image && !run.textOnly, image: run.image && !run.textOnly ? { providerName: run.image.providerName, model: run.image.model } : null }); }
  configure(accountId, input, signal, assertAllowed = () => {}, { timeOnly = false } = {}) {
    const check = () => { assertAllowed(); this.check(accountId, signal, timeOnly); }; check(); momentsPublishingSettings(input);
    const previous = this.account(accountId), automatic = previous.settings.automatic;
    const settings = momentsPublishingSettings({ ...previous.settings, ...input,
      automatic: { ...automatic, ...input.automatic, content: { ...automatic.content, ...input.automatic?.content,
        image: { ...automatic.content.image, ...input.automatic?.content?.image } } } });
    if (timeOnly) assertOnlyTimeChanges('publishing', settings, previous.settings);
    const apply = () => {
      check(); if (this.account(accountId).revision !== previous.revision) throw new ChannelError('MOMENTS_PLAN_CHANGED', '总设置已被修改，请刷新后重新保存');
      if (this.activeAccount === accountId) this.controller?.abort(new ChannelError('MOMENTS_PLAN_CHANGED', '自动发布总设置已变更，旧操作已停止'));
      this.data.accounts[hash(accountId)] = { ...previous, accountId, settings, revision: randomUUID(), automaticWaitingReason: null };
      const reflow = hash({ ...automatic, enabled: false }) !== hash({ ...settings.automatic, enabled: false }) || settings.minGapMinutes !== previous.settings.minGapMinutes || settings.maxPostsPer24Hours !== previous.settings.maxPostsPer24Hours;
      this.arrange(accountId, reflow); this.save(); return this.list(accountId);
    };
    return !timeOnly && settings.automatic.content.useDefaultAudience !== true &&
      (settings.automatic.content.blockedLabelIds.length || settings.automatic.content.blockedUserIds.length)
      ? this.validateAudience(accountId, settings.automatic.content, signal, check).then(apply) : apply();
  }
  async validateAudience(accountId, settings, signal, check) {
    const snapshot = await this.channel.moments.audienceOwner(accountId, signal, check); check();
    const contacts = new Set(snapshot.contacts.map(row => row.id)), labels = new Set(snapshot.labels.map(row => row.id));
    if (settings.blockedUserIds.some(id => !contacts.has(id)) || settings.blockedLabelIds.some(id => !labels.has(id))) throw new ChannelError('MOMENTS_AUDIENCE_CHANGED', '计划中的屏蔽对象已失效，请刷新并重新选择');
  }
  arrange(accountId, reflow = false) {
    const account = this.account(accountId);
    if (!account.settings.automatic.enabled) { this.arrangementKey = null; return; }
    const fingerprint = hash({ automatic: { ...account.settings.automatic, enabled: false }, minGapMinutes: account.settings.minGapMinutes, maxPostsPer24Hours: account.settings.maxPostsPer24Hours });
    reflow ||= account.arrangementFingerprint !== fingerprint;
    const key = accountId + ':' + momentsDate(this.now(), account.settings.automatic.timezone);
    if (!reflow && this.arrangementKey === key) return;
    const result = arrangeMoments(accountId, account.settings, Object.values(this.data.plans), Object.values(this.data.runs), this.now(), reflow);
    for (const plan of result.updates) this.data.plans[plan.id] = { ...plan, revision: randomUUID(), updatedAt: this.now() };
    account.arrangement = result.summary; account.arrangementFingerprint = fingerprint; this.arrangementKey = key;
    this.save();
  }
  plan(accountId, id) {
    const plan = this.data.plans[id];
    if (!momentsPlanId(id) || !plan || plan.deleted || plan.accountId !== accountId) throw new ChannelError('MOMENTS_PLAN_MISSING', '发布计划不存在或不属于当前账号');
    return plan;
  }
  async savePlan(accountId, input, id, requestId, signal, assertAllowed = () => {}, { timeOnly = false } = {}) {
    const check = () => { assertAllowed(); this.check(accountId, signal, timeOnly); }; check();
    const prior = id !== undefined ? this.plan(accountId, id).settings : null;
    if (prior && !object(input)) throw new ChannelError('MOMENTS_PLAN_INVALID', '请填写要修改的发布计划字段');
    const settings = momentsPlanSettings(prior ? { ...prior, ...input,
      ...(input.schedule !== undefined ? { schedule: object(input.schedule) ? { ...prior.schedule, ...input.schedule } : input.schedule } : {}),
      ...(input.image !== undefined ? { image: object(input.image) ? { ...prior.image, ...input.image } : input.image } : {}) } : input);
    if (timeOnly) {
      if (!prior) throw new ChannelError('MOMENTS_PLAN_MISSING', '请先在朋友圈中创建发布计划');
      assertOnlyTimeChanges('plan', settings, prior);
    }
    if (typeof requestId !== 'string' || !requestId || requestId.length > 2000) throw new ChannelError('MOMENTS_PLAN_INVALID', '发布计划缺少操作编号');
    const selected = id ?? hash([accountId, 'plan', requestId]).slice(0, 32), previous = this.data.plans[selected], previousRevision = previous?.revision;
    if (previous && previous.accountId !== accountId) throw new ChannelError('MOMENTS_PLAN_MISSING', '计划不属于当前账号');
    if (!id && previous && hash(settings) !== hash(previous.settings)) throw new ChannelError('MOMENTS_PLAN_CHANGED', '同一新建操作对应不同计划内容，请重新保存');
    if (!id && previous) return this.list(accountId);
    if (!previous && Object.values(this.data.plans).filter(plan => plan.accountId === accountId && !plan.deleted && !plan.automatic).length >= 20) throw new ChannelError('MOMENTS_PLAN_LIMIT', '每个账号最多保存 20 个手动发布计划，自动安排不占此上限');
    if (previous?.automatic && settings.schedule.type !== 'once') throw new ChannelError('MOMENTS_PLAN_INVALID', '自动生成的计划为单次计划；需要每天或每周重复时，请另加手动计划');
    const nextRunAt = timeOnly ? previous.nextRunAt : nextMomentsOccurrence(settings, this.now());
    if (!timeOnly && settings.enabled && !nextRunAt) throw new ChannelError('MOMENTS_PLAN_INVALID', '启用单次计划时请选择未来的日期和时间');
    if (!timeOnly && settings.useDefaultAudience !== true && (settings.blockedLabelIds.length || settings.blockedUserIds.length)) {
      await this.validateAudience(accountId, settings, signal, check);
    }
    check(); if (this.activeAccount === accountId && this.activePlanId === selected) this.controller?.abort(new ChannelError('MOMENTS_PLAN_CHANGED', '计划已修改，旧生成或发布已停止'));
    if (this.data.plans[selected]?.revision !== previousRevision) throw new ChannelError('MOMENTS_PLAN_CHANGED', '计划已被修改，请刷新后重新保存');
    this.data.plans[selected] = { id: selected, accountId, settings, nextRunAt: settings.enabled ? nextRunAt : 0, revision: randomUUID(), createdAt: previous?.createdAt ?? this.now(), updatedAt: this.now(), waitingReason: null,
      ...(previous?.automatic ? { automatic: { ...previous.automatic, edited: true, suppressed: false } } : {}) };
    this.arrange(accountId, true); this.save(); return this.list(accountId);
  }
  setEnabled(accountId, id, enabled) {
    this.check(accountId); if (typeof enabled !== 'boolean') throw new ChannelError('MOMENTS_PLAN_INVALID', '请选择开启或暂停计划');
    const plan = this.plan(accountId, id), next = enabled ? nextMomentsOccurrence(plan.settings, this.now()) : 0;
    if (enabled && !next) throw new ChannelError('MOMENTS_PLAN_INVALID', '该单次计划时间已过去，请修改时间后启用');
    if (this.activePlanId === id) this.controller?.abort();
    Object.assign(plan, { settings: { ...plan.settings, enabled }, nextRunAt: next, revision: randomUUID(), updatedAt: this.now(), waitingReason: null });
    if (plan.automatic) plan.automatic.edited = true;
    this.arrange(accountId, true); this.save(); return this.list(accountId);
  }
  removePlan(accountId, id) {
    this.check(accountId); const plan = this.plan(accountId, id); if (this.activePlanId === id) this.controller?.abort();
    Object.assign(plan, { deleted: true, nextRunAt: 0, settings: { ...plan.settings, enabled: false }, revision: randomUUID(), updatedAt: this.now() });
    this.arrange(accountId, true); this.save(); return this.list(accountId);
  }
  run(accountId, id) {
    const run = this.data.runs[id]; if (!momentsRunId(id) || !run || run.historyDeleted || run.accountId !== accountId) throw new ChannelError('MOMENTS_DRAFT_MISSING', '发布记录不存在或不属于当前账号'); return run;
  }
  recent(accountId) {
    const own = this.channel.momentsAutomation?.list(accountId).posts ?? [];
    const deleted = new Set(own.filter(post => post.deleted).map(post => post.id)), rows = new Map();
    for (const run of Object.values(this.data.runs)) if (run.accountId === accountId && ['published', 'published-unverified'].includes(run.state) && !deleted.has(run.postId))
      rows.set(run.postId, { text: run.text, createdAt: run.publishedAt });
    for (const post of own) if (!post.deleted) rows.set(post.id, { text: post.text, createdAt: post.createdAt * 1000 });
    return [...new Set([...rows.values()].sort((a, b) => b.createdAt - a.createdAt).map(row => row.text?.trim()).filter(Boolean))].slice(0, 20);
  }
  async operation(accountId, planId, signal, work) {
    this.check(accountId, signal); if (this.pending) throw new ChannelError('MOMENTS_PUBLISH_BUSY', '已有朋友圈内容正在生成或提交，请等它完成后操作');
    this.controller = new AbortController(); this.operationTimeoutMs = timeLimitMs(this.channel.store, 'momentsPublishTimeoutMinutes'); this.operationTimeout = AbortSignal.timeout(this.operationTimeoutMs);
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : []), this.operationTimeout]);
    this.activeAccount = accountId; this.activePlanId = planId; this.operationStartedAt = this.now();
    this.pending = Promise.resolve().then(() => work(combined)).finally(() => { this.pending = undefined; this.controller = undefined; this.activeAccount = undefined; this.activePlanId = undefined; this.operationStartedAt = undefined; this.operationTimeout = undefined; });
    return this.pending;
  }
  async generate(run, signal, check) {
    const stage = value => { check(); run.stage = value; run.updatedAt = this.now(); this.save(); };
    Object.assign(run, await generateMomentsContent(this.channel, run.settings, this.recent(run.accountId), run.scheduledAt, signal, check, stage)); run.updatedAt = this.now(); this.save();
    this.deadline(run);
    await this.reviewMaterials(run, signal, check, stage);
    stage(run.textOnly ? 'text-review' : 'content-review');
    if (run.textOnly ? await reviewMomentsTextOnly(this.channel, run, this.recent(run.accountId), signal, check)
      : await reviewMomentsContent(this.channel, run, null, signal, check)) this.save();
    if (!run.textOnly) try {
    if (run.imageMaterialId) {
      const materials = this.channel.momentsAutomation.materials;
      materials.assertSelection(run.accountId, run.materialContextRefs);
      const image = materials.image(run.accountId, run.imageMaterialId), extension = image.mediaType === 'image/png' ? '.png' : '.jpg';
      const relative = 'storage/moments/publishing-media/' + run.id + extension, target = workPath(this.channel.store.root, relative);
      check(); fs.mkdirSync(path.dirname(target), { recursive: true }); atomicBytes(target, image.bytes);
      run.image = { path: relative, sha256: hash(image.bytes), providerName: '朋友圈素材库', model: materials.item(run.accountId, run.imageMaterialId).fields.title }; this.save();
    }
    if (run.settings.image.mode === 'ai') {
      stage('image');
      const service = this.channel.work?.imageGeneration;
      if (!service?.generate) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '生图服务未加载，正文已保留但未发布');
      const catalog = service.catalog(), image = run.settings.image, provider = catalog.providers.find(row => row.providerId === (image.providerId || catalog.defaultProviderId));
      if (!provider || !catalog.enabled) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '所选生图接口未启用或已不存在，正文已保留但未发布');
      const budget = this.operationTimeoutMs ?? timeLimitMs(this.channel.store, 'momentsPublishTimeoutMinutes');
      const remaining = budget - (this.now() - this.operationStartedAt) - Math.min(MOMENTS_TEXT_FALLBACK_RESERVE_MS, budget / 4);
      if (remaining <= 0) throw new DOMException('Image budget exhausted', 'TimeoutError');
      const imageSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      const generated = await service.generate({ prompt: run.imagePrompt, providerId: provider.providerId, model: image.model || provider.defaultModel, ...(image.size ? { size: image.size } : {}) }, imageSignal,
        () => { check(); imageSignal.throwIfAborted(); }); check(); imageSignal.throwIfAborted();
      momentsImage(generated.bytes);
      const relative = 'storage/moments/publishing-media/' + run.id + generated.extension, target = workPath(this.channel.store.root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); atomicBytes(target, generated.bytes);
      run.image = { path: relative, sha256: hash(generated.bytes), providerName: generated.providerName, model: generated.model }; this.save();
    }
    if (run.image) {
      stage('image-review');
      if (await reviewMomentsContent(this.channel, run, this.contentImage(run.accountId, run.id), signal, check)) this.save();
    }
    } catch (error) {
      check();
      if (!canOmitMomentsImage(error)) throw error;
      omitMomentsImage(run, error); stage('text-review');
      if (await reviewMomentsTextOnly(this.channel, run, this.recent(run.accountId), signal, check)) this.save();
    }
    check(); this.deadline(run); run.state = 'draft'; run.error = null; run.errorCode = null; run.updatedAt = this.now(); this.save();
  }
  async reviewMaterials(run, signal, check, stage = () => {}) {
    const materials = this.channel.momentsAutomation?.materials, refs = run.materialContextRefs || run.selectedMaterials || [];
    if (!refs.length) return;
    materials.assertSelection(run.accountId, refs); check();
    const context = refs.map(ref => materials.item(run.accountId, ref.id));
    if (!context.some(item => item.origin === 'chat')) return;
    const fingerprint = hash([run.text, run.imagePrompt, refs]);
    if (run.materialReviewHash === fingerprint) return;
    stage('reviewing');
    const safe = await reviewMaterialText(this.channel, [{ id: 'draft', text: run.text, imagePrompt: run.imagePrompt || '' }], signal, check,
      context.map(item => ({ title: item.fields.title, text: item.fields.text })));
    materials.assertSelection(run.accountId, refs);
    if (!safe.has('draft')) throw new ChannelError('MOMENTS_MATERIAL_PRIVATE', '本次正文或配图要求未通过公开性检查，请修改后重新检查；未发布');
    run.materialReviewHash = fingerprint; this.save();
  }
  deadline(run) { if (run.origin === 'schedule' && this.now() > run.scheduledAt + run.settings.graceMinutes * 60000)
    throw new ChannelError('MOMENTS_PLAN_EXPIRED', '本时段已超过允许等待时间，已生成内容保留，未自动发布'); }
  contentImage(accountId, id) {
    this.check(accountId); const run = this.run(accountId, id);
    if (!run.image || !new RegExp('^storage/moments/publishing-media/' + id + '\\.(png|jpg)$').test(run.image.path)) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '本条记录没有可读取配图');
    const file = workPath(this.channel.store.root, run.image.path), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new ChannelError('MOMENTS_IMAGE_CHANGED', '保存的配图无效或大小已变化，未发布');
    const bytes = fs.readFileSync(file); if (hash(bytes) !== run.image.sha256) throw new ChannelError('MOMENTS_IMAGE_CHANGED', '保存的配图内容已变化，未发布');
    const image = momentsImage(bytes); return { ...image, mediaType: run.image.path.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }
  /** 账号级默认屏蔽名单按提交时的实时通讯录裁剪：失效编号不再让整条发布失败。 */
  async defaultAudience(run, signal, check) {
    const settings = this.channel.store.settings(run.accountId);
    const stored = validateAudienceSelection({ action: 'publish',
      blockedUserIds: settings.defaultBlockedUserIds ?? [], blockedLabelIds: settings.defaultBlockedLabelIds ?? [] });
    if (!stored.blockedUserIds.length && !stored.blockedLabelIds.length) return stored;
    const snapshot = await this.channel.moments.audienceOwner(run.accountId, signal, check); check();
    const contacts = new Set(snapshot.contacts.map(row => row.id)), labels = new Map(snapshot.labels.map(row => [row.id, row]));
    const complete = label => Array.isArray(label?.userIds) && label.memberCount === label.userIds.length &&
      label.userIds.every(id => contacts.has(id));
    return { blockedUserIds: stored.blockedUserIds.filter(id => contacts.has(id)),
      blockedLabelIds: stored.blockedLabelIds.filter(id => complete(labels.get(id))) };
  }
  query(run, audience) {
    if (!visibleMomentsText(run.text) || run.text.trim().length > run.settings.maxChars)
      throw new ChannelError('MOMENTS_CONTENT_INVALID', '草稿须有可见正文且在计划字数上限内，未发布');
    if (run.settings.image.mode === 'ai' && !run.image && !run.textOnly) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '配图尚未准备好');
    const blocked = audience ?? { blockedLabelIds: run.settings.blockedLabelIds, blockedUserIds: run.settings.blockedUserIds };
    return { action: 'publish', text: run.text, blockedLabelIds: blocked.blockedLabelIds, blockedUserIds: blocked.blockedUserIds,
      ...(run.image && !run.textOnly ? { images: [(({ data, width, height }) => ({ data, width, height }))(this.contentImage(run.accountId, run.id))] } : {}) };
  }
  async submit(run, signal, check) {
    await this.reviewMaterials(run, signal, check);
    // Old and edited drafts receive the same review as newly generated ones.
    if (!run.textOnly) try {
      if (run.settings.image.mode === 'ai' && !run.image) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '旧草稿的配图未生成');
      if (await reviewMomentsContent(this.channel, run, run.image ? this.contentImage(run.accountId, run.id) : null, signal, check)) this.save();
    } catch (error) {
      check();
      if (!canOmitMomentsImage(error) || !run.image && run.settings.image.mode !== 'ai') throw error;
      omitMomentsImage(run, error); this.save();
    }
    if (run.textOnly && await reviewMomentsTextOnly(this.channel, run, this.recent(run.accountId), signal, check)) this.save();
    await this.reviewMaterials(run, signal, check);
    const current = () => { check(); this.channel.momentsAutomation?.materials.assertSelection(run.accountId, run.materialContextRefs || run.selectedMaterials || []); };
    current();
    check(); if (this.recent(run.accountId).some(text => similarMomentsText(text, run.text))) throw new ChannelError('MOMENTS_CONTENT_DUPLICATE', '这份草稿与近期已发布内容过于相似，未提交');
    const audience = run.settings.useDefaultAudience === true ? await this.defaultAudience(run, signal, check)
      : { blockedLabelIds: run.settings.blockedLabelIds, blockedUserIds: run.settings.blockedUserIds };
    check();
    const query = this.query(run, audience); run.query = query; run.state = 'sending'; run.stage = 'sending'; run.updatedAt = this.now(); this.save();
    const receipt = await this.channel.moments.writeOwner(query, run.accountId, run.requestId, signal, current);
    this.published(run, receipt); return receipt;
  }
  published(run, receipt) {
    Object.assign(run, { state: 'published', postId: receipt.postId, delivery: receipt.delivery, publishedAt: this.now(), updatedAt: this.now(), error: null, errorCode: null }); delete run.query; this.save();
    try { this.channel.momentsAutomation?.materials.markUsed(run.accountId, run.id, run.selectedMaterials); }
    catch { run.materialsWarning = '微信已确认发布，素材使用记录暂未保存；请检查素材库状态'; this.save(); }
  }
  fail(run, error) {
    let receipt;
    try { receipt = run.query && this.channel.moments.lookupOwnerReceipt?.(run.query, run.accountId, run.requestId); } catch {}
    if (receipt) { this.published(run, receipt); return error; }
    const submitted = run.state === 'sending', rejected = ['not-sent', 'rejected'].includes(error?.details?.snsDelivery);
    if (error?.name === 'TimeoutError' && this.operationTimeout?.aborted) error = new ChannelError('MOMENTS_PUBLISH_TIMEOUT', submitted
      ? '等待发布确认时达到 ' + timeDurationLabel(this.operationTimeoutMs) + ' 上限，结果不明；请核对微信，未自动重发'
      : '本次生成达到 ' + timeDurationLabel(this.operationTimeoutMs) + ' 上限，已停止；已有内容保留，未发布，也不会自动重试');
    else if (error?.name === 'TimeoutError') error = new ChannelError('MOMENTS_REQUEST_TIMEOUT', submitted
      ? '发布确认请求超时，结果不明；请核对微信，未自动重发'
      : '生成请求超时，已有内容保留，未发布；服务自身的请求时限可能短于设定的总时限');
    else if (error?.name === 'AbortError') error = new ChannelError('MOMENTS_PUBLISH_CANCELLED', submitted
      ? '已取消等待发布确认，结果仍需在微信核对；未自动重发'
      : '本次生成已取消；已有内容保留，未发布');
    const failure = publicError(error, '本次内容未完成发布');
    let publication;
    try { publication = run.query && this.channel.moments.lookupOwnerPublication?.(run.query, run.accountId, run.requestId); } catch {}
    run.state = submitted ? rejected ? 'rejected' : publication ? 'published-unverified' : 'unknown' : error?.code === 'MOMENTS_NOTHING_TO_SHARE' ? 'skipped' : 'failed';
    if (publication) { run.postId = publication.postId; run.publishedAt = publication.createdAt * 1000; }
    run.error = failure.message; run.errorCode = failure.code; run.updatedAt = this.now();
    if (unresolved(run.state) && run.planId && this.data.plans[run.planId]) {
      const plan = this.data.plans[run.planId]; plan.settings.enabled = false; plan.nextRunAt = 0; plan.waitingReason = '上次发布结果不明，计划已暂停，请核对后手动开启';
      if (plan.automatic) { plan.automatic.edited = true; const account = this.account(run.accountId); account.settings.automatic.enabled = false; account.revision = randomUUID(); account.automaticWaitingReason = '上次发布结果不明，自动安排已暂停，请核对回执后再开启'; this.arrangementKey = null; }
    }
    if (!unresolved(run.state)) delete run.query; this.save(); return error;
  }
  async preview(accountId, input, requestId, signal, assertAllowed = () => {}) {
    const settings = momentsPlanSettings(input), id = hash([accountId, 'preview', requestId]), existing = this.data.runs[id];
    if (existing?.historyDeleted) throw new ChannelError('MOMENTS_DRAFT_MISSING', '该操作的草稿记录已删除，请新建生成操作');
    const check = () => { assertAllowed(); this.check(accountId, signal); }; check();
    if (typeof requestId !== 'string' || !requestId || requestId.length > 2000) throw new ChannelError('MOMENTS_PLAN_INVALID', '预览缺少实际操作编号');
    if (existing) { if (existing.inputHash !== hash(settings) || existing.accountId !== accountId) throw new ChannelError('MOMENTS_PLAN_CHANGED', '同一预览编号对应不同内容'); return this.publicRun(existing); }
    return this.operation(accountId, null, signal, async combined => {
      const verify = () => { assertAllowed(); this.check(accountId, combined); }, run = { id, accountId, requestId, inputHash: hash(settings), settings, scheduledAt: this.now(), createdAt: this.now(), updatedAt: this.now(), state: 'generating', origin: 'preview' };
      this.data.runs[id] = run; this.save();
      try { await this.generate(run, combined, verify); } catch (error) { throw this.fail(run, error); }
      return this.publicRun(run);
    });
  }
  editDraft(accountId, id, text) {
    this.check(accountId); const run = this.run(accountId, id);
    if (!['draft', 'failed'].includes(run.state) || this.pending || !visibleMomentsText(text) || text.trim().length > run.settings.maxChars) throw new ChannelError('MOMENTS_DRAFT_INVALID', '只能编辑尚未提交的草稿，正文须有可见内容且在计划字数上限内');
    Object.assign(run, { text: text.trim(), updatedAt: this.now() }); this.save(); return this.list(accountId);
  }
  discard(accountId, id) {
    this.check(accountId); const run = this.run(accountId, id);
    if (!['draft', 'failed'].includes(run.state) || this.pending) throw new ChannelError('MOMENTS_DRAFT_INVALID', '只能放弃尚未提交的草稿');
    run.state = 'discarded'; run.updatedAt = this.now(); this.save(); return this.list(accountId);
  }
  async publishDraft(accountId, id, signal, assertAllowed = () => {}) {
    assertAllowed(); this.check(accountId, signal); const run = this.run(accountId, id);
    if (run.state === 'published') return this.list(accountId);
    if (!['draft', 'failed'].includes(run.state) || !run.text) throw new ChannelError('MOMENTS_DRAFT_INVALID', '只有生成成功、尚未提交的草稿可以发布；结果不明不能重发');
    return this.operation(accountId, run.planId, signal, async combined => {
      const check = () => { assertAllowed(); this.check(accountId, combined); };
      try { await this.submit(run, combined, check); } catch (error) { throw this.fail(run, error); }
      return this.list(accountId);
    });
  }
  async reconcile(accountId, id, signal, assertAllowed = () => {}) {
    assertAllowed(); this.check(accountId, signal); const run = this.run(accountId, id);
    if (['published', 'deleted'].includes(run.state)) return { confirmed: true, outcome: run.state, ...this.list(accountId) };
    if (!unresolved(run.state) || !run.query) throw new ChannelError('MOMENTS_DRAFT_INVALID', '此记录无需核对未知回执');
    return this.operation(accountId, run.planId, signal, async combined => {
      const check = () => { assertAllowed(); this.check(accountId, combined); };
      const receipt = this.channel.moments.lookupOwnerReceipt?.(run.query, accountId, run.requestId);
      if (receipt) { this.published(run, receipt); return { confirmed: true, outcome: 'published', message: '已找到微信成功回执。', ...this.list(accountId) }; }
      const result = await this.channel.moments.reconcileOwnerPublication(run.query, accountId, run.requestId, combined, check); check();
      if (result.kind === 'published') this.published(run, result.receipt);
      else if (result.kind === 'deleted') {
        Object.assign(run, { state: 'deleted', postId: result.postId, deletion: result.deletion, publishedAt: result.createdAt * 1000,
          audienceWarning: result.message, error: null, errorCode: null, updatedAt: this.now() }); delete run.query; this.save();
      } else {
        if (result.kind === 'published-unverified') {
          run.state = 'published-unverified'; run.postId = result.postId;
          if (result.createdAt) run.publishedAt = result.createdAt * 1000;
        }
        run.error = result.message; run.updatedAt = this.now(); this.save();
      }
      return { confirmed: ['published', 'deleted'].includes(result.kind), outcome: result.kind, message: result.message, ...this.list(accountId) };
    });
  }
  cancel(accountId) { this.check(accountId); if (this.activeAccount === accountId) this.controller?.abort(); return this.list(accountId); }
  start() { if (this.timer || this.error) return; this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 10000); this.timer.unref?.(); }
  async close() { this.stopped = true; clearInterval(this.timer); this.timer = undefined; this.controller?.abort(); await this.whenIdle(); }
  async whenIdle() { await this.pending?.catch(() => {}); }
  tick() {
    if (this.pending) return this.pending;
    const status = this.channel.transport.status(), accountId = status.account?.id, account = this.account(accountId);
    if (this.stopped || this.error || !accountId) return Promise.resolve();
    this.arrange(accountId);
    if (!status.online || !status.momentsWriteReady || !this.channel.store.settings(accountId).enabled || !account.settings.enabled) return Promise.resolve();
    const plan = Object.values(this.data.plans).filter(plan => plan.accountId === accountId && !plan.deleted && !plan.automatic?.suppressed && (!plan.automatic || account.settings.automatic.enabled) && plan.settings.enabled && plan.nextRunAt > 0 && plan.nextRunAt <= this.now()).sort((a, b) => a.nextRunAt - b.nextRunAt || Number(!!a.automatic) - Number(!!b.automatic) || a.id.localeCompare(b.id))[0];
    if (!plan) return Promise.resolve();
    const scheduledAt = plan.nextRunAt, id = hash([accountId, plan.id, scheduledAt]), previous = this.data.runs[id];
    if (previous) { plan.nextRunAt = nextMomentsOccurrence(plan.settings, this.now()); this.save(); return Promise.resolve(); }
    if (this.now() > scheduledAt + plan.settings.graceMinutes * 60000) {
      this.data.runs[id] = { id, accountId, planId: plan.id, requestId: 'moments-scheduled:' + id, inputHash: hash(plan.settings), settings: copy(plan.settings), scheduledAt, createdAt: this.now(), updatedAt: this.now(), origin: 'schedule', state: 'skipped', error: '已超过允许等待时间，跳过旧时段，未补发' };
      plan.nextRunAt = nextMomentsOccurrence(plan.settings, this.now()); this.save(); return Promise.resolve();
    }
    const published = Object.values(this.data.runs).filter(run => run.accountId === accountId && run.origin === 'schedule' && ['published', 'published-unverified', 'deleted'].includes(run.state) && run.publishedAt > this.now() - 86400000).sort((a, b) => b.publishedAt - a.publishedAt);
    const waitingReason = published.length >= account.settings.maxPostsPer24Hours ? '已达到 24 小时发布上限，等待下一可用时段' : published[0]?.publishedAt + account.settings.minGapMinutes * 60000 > this.now() ? '与上一条自动发布的间隔不足，等待中' : null;
    if (waitingReason) { if (plan.waitingReason !== waitingReason) { plan.waitingReason = waitingReason; this.save(); } return Promise.resolve(); }
    const snapshot = copy(plan), revision = account.revision;
    return this.operation(accountId, plan.id, null, async signal => {
      const check = () => { this.check(accountId, signal); const current = this.data.plans[plan.id];
        if (this.stopped || !this.channel.store.settings(accountId).enabled || !this.account(accountId).settings.enabled || this.account(accountId).revision !== revision || !current?.settings.enabled || current.deleted || current.automatic?.suppressed || current.automatic && !this.account(accountId).settings.automatic.enabled || current.revision !== snapshot.revision)
          throw new ChannelError('MOMENTS_PLAN_CHANGED', '自动发布已暂停或计划变化，旧操作未继续'); };
      const run = { id, accountId, planId: plan.id, requestId: 'moments-scheduled:' + id, inputHash: hash(snapshot.settings), settings: snapshot.settings, scheduledAt, createdAt: this.now(), updatedAt: this.now(), origin: 'schedule', state: 'generating' };
      this.data.runs[id] = run; plan.nextRunAt = nextMomentsOccurrence(snapshot.settings, scheduledAt); plan.waitingReason = null; this.save();
      try { check(); await this.generate(run, signal, check); this.deadline(run); if (!snapshot.settings.reviewRequired) await this.submit(run, signal, check); }
      catch (error) { if (!this.error) this.fail(run, error); }
    });
  }
}
