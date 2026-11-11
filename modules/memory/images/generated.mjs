import { ChannelError, publicError } from '../../../shared/contracts.mjs';
import path from 'node:path';
import { artifactMetadata, imageArchiveMetadata } from '../../../shared/work-artifacts.mjs';
import { readWorkArtifact } from '../../work/artifacts.mjs';
import { workPath } from '../../work/policy.mjs';

const imageArtifact = artifact => artifactMetadata(artifact) && ['image/png', 'image/jpeg'].includes(artifact.mediaType);
const scopeOf = scope => ({ accountId: scope.accountId, chatType: scope.chatType, peerId: scope.peerId, collection: 'generated' });
const sameArtifact = (left, right) => left.sha256 === right.sha256 && left.path === (right.sourcePath ?? right.path);

function deliveredAt(store, job, delivery) {
  if (Number.isSafeInteger(delivery.sentAt) && delivery.sentAt > 0) return delivery.sentAt;
  const record = store.data.records.findLast(record => ['accountId', 'chatType', 'peerId'].every(key => record[key] === job[key]) &&
    record.acknowledgedMessageIds?.includes(delivery.serverMessageId));
  // Legacy task archives already contain exact image ACKs. Use the receipt's
  // record time, or a conservative task update time when it was pruned.
  return record?.sentAt ?? record?.acknowledgedAt ?? record?.updatedAt ?? job.delivery.confirmedAt ?? job.updatedAt;
}

/** Index verified task output bytes in a separate, conversation-owned memory.
 * This never calls an image provider or fetches a WeChat quotation. */
export class GeneratedImageMemory {
  constructor(images, workStore) { this.images = images; this.workStore = workStore; }
  sources(scope, jobs = this.workStore.list(scopeOf(scope))) {
    return jobs.filter(job => ['accountId', 'chatType', 'peerId'].every(key => job[key] === scope[key])).flatMap(job => {
      const artifacts = new Map();
      for (const archive of job.imageArchives ?? [])
        if (imageArchiveMetadata(archive, job.id)) artifacts.set(archive.sourcePath + ':' + archive.sha256, archive);
      for (const artifact of job.result?.artifacts ?? [])
        if (imageArtifact(artifact) && !artifacts.has(artifact.path + ':' + artifact.sha256))
          artifacts.set(artifact.path + ':' + artifact.sha256, artifact);
      return [...artifacts.values()].map(artifact => {
        const operation = job.operations.find(op => op.result.ok && op.result.artifacts?.some(value => sameArtifact(value, artifact))),
          provider = operation?.tool === 'wechat_work_generate_image' ? operation.result : null,
          deliveries = (job.delivery?.artifacts ?? []).filter(value => sameArtifact(value, artifact) && value.state === 'sent' &&
            value.serverMessageId && job.delivery.acknowledgedMessageIds?.includes(value.serverMessageId)).slice(0, 8),
          serverMessageIds = deliveries.map(value => value.serverMessageId),
          generation = { jobId: job.id, fileName: artifact.name, requesterId: job.senderId,
            deliveryState: serverMessageIds.length ? 'sent' : 'not-confirmed', serverMessageIds,
            ...(deliveries.length ? { sentAt: Math.max(...deliveries.map(value => deliveredAt(this.images.store, job, value))) } : {}),
            ...(typeof provider?.providerName === 'string' ? { providerName: provider.providerName.slice(0, 4000) } : {}),
            ...(typeof provider?.model === 'string' ? { model: provider.model.slice(0, 4000) } : {}),
            prompt: String(provider?.prompt ?? job.imageRequest?.prompt ?? job.request).slice(0, 4000) },
          attachment = { type: 'image', resourceId: (artifact.sourcePath ?? artifact.path) + ':' + artifact.sha256, generation },
          entry = { messageId: 'work-image-' + job.id, senderId: job.accountId,
            senderName: this.images.store.persona().name || 'Agent', direction: 'outgoing',
            text: [job.request, '文件：' + artifact.name].join('\n'),
            time: operation?.at ?? job.finishedAt ?? job.startedAt ?? job.createdAt, attachments: [attachment] };
        return { job, artifact, entry, attachment };
      });
    });
  }
  entries(scope) { return this.sources(scope).map(source => source.entry); }
  read({ job, artifact }) {
    if (artifact.state === 'saved') {
      try { return readWorkArtifact(job.workspaceRoot, artifact.path, { ...artifact, name: path.posix.basename(artifact.path) }).segment.data; }
      catch { /* A retained task original may still be usable; its digest must match. */ }
    }
    const relative = artifact.sourcePath ?? artifact.path;
    return readWorkArtifact(workPath(job.workspaceRoot, job.folder), relative, { ...artifact, path: relative }).segment.data;
  }
  async sync(scope, signal = new AbortController().signal, assertAllowed = () => {}, { jobs, before, currentJobId } = {}) {
    const input = scopeOf(scope), initial = this.images.load(input),
      result = { saved: 0, skipped: 0, failed: 0, failures: [] };
    if (!initial.settings.enabled) return result;
    for (const source of this.sources(scope, jobs)) {
      signal.throwIfAborted(); assertAllowed();
      if (before !== undefined && source.entry.time > before && source.job.id !== currentJobId) continue;
      const state = this.images.load(input);
      if (state.generation !== initial.generation)
        throw new ChannelError('IMAGE_MEMORY_CHANGED', '生成图片记忆已清空，已停止补入旧图片');
      const id = this.images.imageId(state, source.entry, source.attachment);
      if (state.deleted[id]) { result.skipped++; continue; }
      if (state.items[id]) {
        this.images.updateGeneration(input, id, source.attachment.generation);
        result.skipped++; continue;
      }
      try {
        const content = this.read(source);
        signal.throwIfAborted(); assertAllowed();
        const saved = await this.images.capture(input, source.entry, source.attachment,
          { data: content.base64, mediaType: source.artifact.mediaType, quality: 'original' }, signal,
          { generation: initial.generation });
        if (saved) result.saved++; else result.skipped++;
      } catch (error) {
        signal.throwIfAborted();
        if (['AUTH_CHANGED', 'ACCOUNT_CHANGED', 'IMAGE_MEMORY_CHANGED'].includes(error.code)) throw error;
        result.failed++;
        const reason = publicError(error, '生成图片未能加入记忆，原任务文件保留').message,
          failure = result.failures.find(item => item.reason === reason);
        if (failure) failure.count++; else result.failures.push({ reason, count: 1 });
      }
    }
    if (result.failed) this.images.errors.set(initial.key, `有 ${result.failed} 张生成图片未能加入记忆：${result.failures[0].reason}`);
    else this.images.errors.delete(initial.key);
    return result;
  }
  async captureJob(job) {
    try { return await this.sync(job, undefined, undefined, { jobs: [job] }); }
    catch (error) {
      // A memory outage must not turn a successfully generated file into a
      // failed task or prevent its independently verified WeChat delivery.
      try {
        this.images.errors.set(this.images.selector(scopeOf(job)).key,
          publicError(error, '生成图片记忆暂时无法保存，原任务图片保留').message);
      } catch { /* The old conversation may have been removed while work stopped. */ }
      return null;
    }
  }
}
