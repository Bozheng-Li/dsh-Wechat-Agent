import fs from 'node:fs';
import path from 'node:path';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { ChannelError } from '../../shared/contracts.mjs';
import { WORK_STATES, workPath } from './policy.mjs';
import { workOutcome } from './outcome.mjs';
import { artifactMetadata, imageArchiveMetadata, WORK_ARTIFACT_LIMITS } from '../../shared/work-artifacts.mjs';
import { validWorkImageRequest } from '../../shared/work-image-request.mjs';

const deliveryStates = new Set(['not-ready', 'pending', 'sending', 'sent', 'failed', 'unknown', 'partial', 'suppressed']);
const id = value => typeof value === 'string' && /^[a-f0-9]{12}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Recognizing historical operation records never grants permission to execute a tool.
const tools = new Set(['wechat_work_read', 'wechat_work_write', 'wechat_work_list', 'wechat_work_exec', 'wechat_work_ssh_connect', 'wechat_work_ssh_exec', 'wechat_work_vscode_connect', 'wechat_work_status', 'wechat_work_output', 'wechat_work_generate_image',
  'wechat_work_tasks', 'wechat_work_task', 'wechat_work_history', 'wechat_work_start', 'wechat_work_parallel', 'wechat_work_continue', 'wechat_work_cancel',
  'wechat_moments_read', 'wechat_moments_comments', 'wechat_moments_audience', 'wechat_moments_like', 'wechat_moments_comment', 'wechat_moments_reply', 'wechat_moments_publish', 'wechat_moments_delete',
  'wechat_moments_plan', 'wechat_moments_draft', 'wechat_moments_reply_schedule',
  'wechat_web_search', 'wechat_moments_images', 'wechat_moments_like_recent', 'wechat_moments_interact']);
const retryStates = new Set(['pending', 'sending', 'sent', 'partial', 'unknown', 'failed', 'cancelled', 'suppressed']);
const validIds = values => Array.isArray(values) && values.every(value => typeof value === 'string' && value && value !== '0');
const validRetry = (value, job) => object(value) && id(value.id) && value.recordKey === `work-result-${job.id}-retry-${value.id}` &&
  retryStates.has(value.state) && value.source === 'owner' && value.confirmedNotReceived === true && Number.isSafeInteger(value.startedAt) && value.startedAt >= 0 &&
  (value.finishedAt === undefined || Number.isSafeInteger(value.finishedAt) && value.finishedAt >= value.startedAt) &&
  Array.isArray(value.artifacts) && value.artifacts.length > 0 && value.artifacts.length <= WORK_ARTIFACT_LIMITS.count && value.artifacts.every(artifactMetadata) &&
  object(value.previousDelivery) && deliveryStates.has(value.previousDelivery.state) && validIds(value.previousDelivery.acknowledgedMessageIds) &&
  Array.isArray(value.previousDelivery.deliveryParts) && Array.isArray(value.previousDelivery.artifacts) && value.previousDelivery.artifacts.every(artifactMetadata) &&
  (value.acknowledgedMessageIds === undefined || validIds(value.acknowledgedMessageIds)) &&
  (value.deliveryParts === undefined || Array.isArray(value.deliveryParts));
export class WorkStore {
  constructor(store, now = Date.now) {
    this.file = workPath(store.root, 'storage/work/index.json');
    this.owner = store.data.storeId;
    this.now = now;
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new ChannelError('WORK_STATE_INVALID', '工作任务记录无法读取，请保留文件并检查，未重新执行任务'); }
    this.data = data ?? { version: 1, ownerStoreId: this.owner, jobs: [] };
    if (this.data.version !== 1 || this.data.ownerStoreId !== this.owner || !Array.isArray(this.data.jobs) ||
        (this.data.projectMigrations !== undefined && (!Array.isArray(this.data.projectMigrations) ||
          this.data.projectMigrations.some(value => !object(value) ||
            ['sourceSessionId', 'sessionId', 'projectCwd', 'taskCwd'].some(key => typeof value[key] !== 'string' || !value[key]) ||
            !path.isAbsolute(value.projectCwd) || !path.isAbsolute(value.taskCwd) || !/^[a-f0-9]{64}$/.test(value.sourceSha256 ?? '') ||
            !Number.isSafeInteger(value.sourceEventCount) || value.sourceEventCount < 0 || !Number.isSafeInteger(value.at) || value.at < 0) ||
          new Set(this.data.projectMigrations.map(value => value.sourceSessionId)).size !== this.data.projectMigrations.length)) ||
        this.data.jobs.some(job => !id(job.id) || !/^(?:微信agent\/)?work\/[a-f0-9]{12}$/.test(job.folder) || !WORK_STATES.has(job.state) ||
          (job.connectionAccess !== undefined && typeof job.connectionAccess !== 'boolean') ||
          (job.nativeExecution !== undefined && typeof job.nativeExecution !== 'boolean') ||
          (job.conversationTurn !== undefined && typeof job.conversationTurn !== 'boolean') ||
          (job.imageRequest !== undefined && !validWorkImageRequest(job.imageRequest)) ||
          (job.imageArchives !== undefined && (!Array.isArray(job.imageArchives) || job.imageArchives.some(value => !imageArchiveMetadata(value, job.id)))) ||
          (job.sessionHistory !== undefined && (!object(job.sessionHistory) || !['visible', 'stored', 'unavailable'].includes(job.sessionHistory.state))) ||
          (job.warnings !== undefined && (!Array.isArray(job.warnings) || job.warnings.some(value => !object(value) || !Number.isSafeInteger(value.operation) || value.operation < 1 || value.operation > (job.operations?.length ?? 0) || typeof value.recovered !== 'boolean' || typeof value.auxiliary !== 'boolean' || typeof value.message !== 'string'))) ||
          !deliveryStates.has(job.delivery?.state) || !Array.isArray(job.operations) || job.operations.some(op => !object(op) || !tools.has(op.tool) || !object(op.result) || typeof op.result.ok !== 'boolean') ||
          (job.delivery.acknowledgedMessageIds !== undefined && (!Array.isArray(job.delivery.acknowledgedMessageIds) || job.delivery.acknowledgedMessageIds.some(value => typeof value !== 'string' || !value || value === '0'))) ||
          (job.delivery.retryAttempts !== undefined && (!Array.isArray(job.delivery.retryAttempts) || job.delivery.retryAttempts.some(value => !validRetry(value, job)) ||
            new Set(job.delivery.retryAttempts.map(value => value.id)).size !== job.delivery.retryAttempts.length)) ||
          (job.result !== undefined && (!object(job.result) || typeof job.result.text !== 'string' || !Array.isArray(job.result.files) || job.result.files.some(file => !object(file) || typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0))) ||
          (job.result?.artifacts !== undefined && (!Array.isArray(job.result.artifacts) || job.result.artifacts.length > WORK_ARTIFACT_LIMITS.count || job.result.artifacts.some(value => !artifactMetadata(value)))) ||
          (job.result?.originalText !== undefined && typeof job.result.originalText !== 'string') ||
          !['private', 'group'].includes(job.chatType) || ['accountId', 'peerId', 'senderId', 'request', 'workspaceRoot'].some(key => typeof job[key] !== 'string' || !job[key]) ||
          ['createdAt', 'updatedAt'].some(key => !Number.isSafeInteger(job[key]) || job[key] < 0)) ||
        new Set(this.data.jobs.map(job => job.id)).size !== this.data.jobs.length)
      throw new ChannelError('WORK_STATE_INVALID', '工作任务记录格式或归属不正确，未重新执行任务');
    const recovered = structuredClone(this.data);
    for (const job of recovered.jobs) {
      if (['succeeded', 'partial'].includes(job.state) || job.state === 'failed' && job.error?.code === 'WORK_OPERATION_FAILED' && job.result?.text) {
        const outcome = workOutcome(job.nativeExecution ? '' : job.request, job.operations);
        if (job.state !== outcome.state || JSON.stringify(job.warnings ?? []) !== JSON.stringify(outcome.warnings) || JSON.stringify(job.error) !== JSON.stringify(outcome.error)) {
          // Keep the original classification for audit; confirmed WeChat
          // records are never rewritten or resent by this compatibility pass.
          if (job.state !== outcome.state && !job.previousOutcome) job.previousOutcome = { state: job.state, ...(job.error ? { error: job.error } : {}), reclassifiedAt: now() };
          Object.assign(job, outcome);
          if (!outcome.error) delete job.error;
          job.updatedAt = now();
        }
      }
      if (['queued', 'running'].includes(job.state)) {
        job.state = 'interrupted'; job.error = { code: 'WORK_INTERRUPTED', message: '应用停止时任务未完成，未自动重放命令；可检查文件后继续任务' };
        job.updatedAt = now();
      }
      if (['pending', 'sending'].includes(job.delivery.state)) {
        job.delivery = { ...job.delivery, state: job.delivery.state === 'sending' ? 'unknown' : 'suppressed', reason: '上次回传未完成，未自动重发；请查询任务结果' };
        if (job.delivery.artifacts) job.delivery.artifacts = job.delivery.artifacts.map(value => ({ ...value, state: value.state === 'sent' ? 'sent' : job.delivery.state }));
        if (job.delivery.retryAttempts) job.delivery.retryAttempts = job.delivery.retryAttempts.map(value => ['pending', 'sending'].includes(value.state)
          ? { ...value, state: value.state === 'sending' ? 'unknown' : 'cancelled', finishedAt: now(), reason: '上次文件补发未完成，未自动重发；请检查送达情况' } : value);
      }
    }
    if (JSON.stringify(recovered) !== JSON.stringify(this.data)) this.commit(recovered);
  }
  commit(next) {
    try { workPath(path.dirname(this.file), 'index.json'); atomicBytes(this.file, Buffer.from(JSON.stringify(next, null, 2) + '\n')); }
    catch { throw new ChannelError('STATE_WRITE_FAILED', '工作任务状态保存失败，已停止执行；请检查磁盘和目录权限'); }
    this.data = next;
  }
  add(job) { const next = structuredClone(this.data); next.jobs.push(job); this.commit(next); return this.get(job.id); }
  get(jobId) {
    const job = this.data.jobs.find(value => value.id === jobId);
    if (!job) throw new ChannelError('WORK_NOT_FOUND', '没有找到这个工作任务');
    return structuredClone(job);
  }
  update(jobId, patch) {
    const next = structuredClone(this.data), job = next.jobs.find(value => value.id === jobId);
    if (!job) throw new ChannelError('WORK_NOT_FOUND', '没有找到这个工作任务');
    Object.assign(job, patch, { updatedAt: this.now() }); this.commit(next); return this.get(jobId);
  }
  rebindSession(sourceSessionId, sessionId, details) {
    const next = structuredClone(this.data), migration = { sourceSessionId, sessionId, ...details, at: this.now() };
    next.projectMigrations ??= [];
    const recorded = next.projectMigrations.find(value => value.sourceSessionId === sourceSessionId);
    if (recorded && recorded.sessionId !== sessionId)
      throw new ChannelError('WORK_MIGRATION_CONFLICT', '原会话已经归并到其他目标，未覆盖现有对应关系');
    if (!recorded) next.projectMigrations.push(migration);
    for (const job of next.jobs) if (job.sessionId === sourceSessionId) {
      job.sessionId = sessionId; job.updatedAt = this.now();
    }
    this.commit(next);
  }
  list(selector = {}) {
    return this.data.jobs.filter(job => ['accountId', 'chatType', 'peerId', 'senderId'].every(key => selector[key] === undefined || selector[key] === job[key]))
      .map(job => structuredClone(job)).reverse();
  }
}
