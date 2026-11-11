import { randomBytes } from 'node:crypto';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { taskDirectory } from './policy.mjs';
import { readWorkArtifact } from './artifacts.mjs';

const sameArtifact = (a, b) => a?.path === b?.path && a?.kind === b?.kind && a?.name === b?.name && a?.bytes === b?.bytes && a?.sha256 === b?.sha256;
const samePart = (part, artifact) => part?.type === artifact.kind && part?.name === artifact.name && part?.bytes === artifact.bytes && part?.sha256 === artifact.sha256;
const validId = value => typeof value === 'string' && value.length > 0 && value !== '0';
const snapshot = delivery => ({ state: delivery.state, recordKey: delivery.recordKey,
  acknowledgedMessageIds: delivery.acknowledgedMessageIds ?? [], deliveryParts: delivery.deliveryParts ?? [], artifacts: delivery.artifacts ?? [], reason: delivery.reason ?? '' });

export function retryArtifacts(job, retryId) {
  const attempt = job.delivery.retryAttempts?.find(value => value.id === retryId);
  if (!attempt || attempt.source !== 'owner' || attempt.confirmedNotReceived !== true || !['pending', 'sending'].includes(attempt.state) || job.delivery.retryAttempts.at(-1).id !== retryId)
    throw new ChannelError('WORK_DELIVERY_CHANGED', '文件回传记录已变化，请刷新后再查看');
  const artifacts = attempt.artifacts.map(expected => job.result.artifacts.find(value => sameArtifact(value, expected)));
  if (artifacts.some(value => !value)) throw new ChannelError('WORK_DELIVERY_CHANGED', '待回传的工作成果已变化，未继续发送');
  return artifacts;
}

function mergeRetry(service, jobId, attemptId, record) {
  const job = service.store.get(jobId), attempt = job.delivery.retryAttempts.find(value => value.id === attemptId);
  const original = attempt.previousDelivery, parts = [...original.deliveryParts], originalMedia = original.deliveryParts.filter(value => value.type !== 'text');
  const received = (record.deliveryParts ?? []).filter(value => value.type !== 'text'), ids = record.acknowledgedMessageIds ?? [];
  const deliveries = job.result.artifacts.map((artifact, index) => {
    const retryIndex = attempt.artifacts.findIndex(value => sameArtifact(value, artifact));
    if (retryIndex < 0) return original.artifacts[index];
    const part = received[retryIndex], matched = samePart(part, artifact);
    const confirmed = matched && part.state === 'acknowledged' && validId(part.serverMessageId) && ids.includes(part.serverMessageId) &&
      received.filter(value => value.state === 'acknowledged' && value.serverMessageId === part.serverMessageId).length === 1 &&
      !original.acknowledgedMessageIds.includes(part.serverMessageId);
    const state = confirmed ? 'sent' : matched && part.state === 'not-sent' ? 'not-sent' :
      matched && ['unknown', 'acknowledged'].includes(part.state) || ['unknown', 'partial'].includes(record.state) || record.sendAttempted ? 'unknown' : record.state === 'cancelled' ? 'suppressed' : 'failed';
    const oldPart = originalMedia[index], partIndex = oldPart ? parts.indexOf(oldPart) : parts.length;
    // The original partial send stays in the attempt snapshot and its record.
    // Current delivery shows the separately verified retry for this artifact.
    parts[partIndex] = { index: oldPart?.index ?? partIndex, type: artifact.kind, name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256,
      state: confirmed ? 'acknowledged' : state === 'failed' || state === 'suppressed' ? 'not-sent' : state,
      ...(confirmed ? { serverMessageId: part.serverMessageId } : {}), retryRecordKey: attempt.recordKey };
    return { ...artifact, state, ...(confirmed ? { serverMessageId: part.serverMessageId, sentAt: record.sentAt ?? record.acknowledgedAt ?? record.updatedAt ?? service.channel.now() } : {}) };
  });
  const acknowledgedMessageIds = [...new Set([...original.acknowledgedMessageIds, ...deliveries.filter(value => value?.state === 'sent').map(value => value.serverMessageId)])];
  const complete = deliveries.every(value => value?.state === 'sent') && original.deliveryParts.some(value => value.type === 'text') &&
    parts.filter(value => value.type !== 'text').length === job.result.artifacts.length &&
    parts.every(value => value.state === 'acknowledged' && validId(value.serverMessageId) && acknowledgedMessageIds.includes(value.serverMessageId)) &&
    new Set(parts.map(value => value.serverMessageId)).size === parts.length;
  const finished = { ...attempt, state: record.state, finishedAt: service.channel.now(), acknowledgedMessageIds: ids,
    deliveryParts: record.deliveryParts ?? [], reason: record.reason ?? '' };
  return service.store.update(jobId, { delivery: { ...job.delivery, state: complete ? 'sent' : acknowledgedMessageIds.length ? 'partial' : record.state === 'unknown' ? 'unknown' : 'failed',
    artifacts: deliveries, deliveryParts: parts, acknowledgedMessageIds, reason: complete ? '' : record.reason ?? original.reason,
    lastRetryRecordKey: attempt.recordKey, retryAttempts: job.delivery.retryAttempts.map(value => value.id === attemptId ? finished : value) } });
}

/** Owner-initiated recovery of existing artifacts; never re-execute the task. */
export function retryWorkDelivery(service, jobId, scope, { expectedUpdatedAt, expectedRetryCount, confirmedNotReceived, signal } = {}) {
  let job = service.owned(jobId, scope);
  service.assertAllowed(job, signal, { artifactRecovery: true });
  if (service.active.has(jobId) || service.deliveries.has(jobId) || ['queued', 'running'].includes(job.state) || ['pending', 'sending'].includes(job.delivery.state))
    throw new ChannelError('WORK_DELIVERY_BUSY', '这个任务仍在执行或回传，请等待完成');
  if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt !== job.updatedAt ||
      !Number.isSafeInteger(expectedRetryCount) || expectedRetryCount !== (job.delivery.retryAttempts?.length ?? 0))
    throw new ChannelError('WORK_DELIVERY_CHANGED', '工作回传记录已变化，请刷新后再补发');
  const artifacts = job.result?.artifacts ?? [], original = snapshot(job.delivery);
  if (!artifacts.length) throw new ChannelError('WORK_ARTIFACT_MISSING', '这个任务没有已登记的成果文件');
  const originalMedia = original.deliveryParts.filter(value => value.type !== 'text');
  const selected = artifacts.filter((artifact, index) => {
    const delivery = original.artifacts[index], part = originalMedia[index];
    if (delivery?.state !== 'sent') return true;
    if (!sameArtifact(delivery, artifact) || !samePart(part, artifact) || part.state !== 'acknowledged' ||
        !validId(part.serverMessageId) || part.serverMessageId !== delivery.serverMessageId || !original.acknowledgedMessageIds.includes(part.serverMessageId))
      throw new ChannelError('WORK_DELIVERY_CHANGED', '已有文件回执无法核对，未重复发送，请先检查任务记录');
    return false;
  });
  if (!selected.length) throw new ChannelError('WORK_ALREADY_DELIVERED', '这个任务的文件都已获得微信确认');
  if (confirmedNotReceived !== true)
    throw new ChannelError('WORK_DELIVERY_CONFIRMATION', '请先确认未收到这些文件，再补发；回执不明的消息不会自动重发');
  const cwd = taskDirectory(service.channel.store, job.folder);
  // Read and verify every selected file before committing a retry. Confirmed
  // files are excluded even if they have since been moved or deleted.
  selected.forEach(value => readWorkArtifact(cwd, value.path, value));
  service.assertAllowed(job, signal, { artifactRecovery: true });
  const id = randomBytes(6).toString('hex'), recordKey = `work-result-${job.id}-retry-${id}`;
  const attempt = { id, recordKey, state: 'pending', startedAt: service.channel.now(), confirmedNotReceived: true,
    source: 'owner', artifacts: selected, previousDelivery: original };
  job = service.store.update(job.id, { delivery: { ...job.delivery, state: 'pending', retryAttempts: [...(job.delivery.retryAttempts ?? []), attempt] } });
  const controller = new AbortController();
  const pending = (async () => {
    try {
      service.assertAllowed(job, controller.signal, { retryId: id });
      const record = await service.channel.submitScheduled({ ...job, recordKey, workJobId: job.id, workRetryId: id,
        source: 'work', kind: 'message', content: '' }, controller.signal);
      mergeRetry(service, job.id, id, record);
    } catch (error) {
      if (error?.code === 'STATE_WRITE_FAILED') throw error;
      mergeRetry(service, job.id, id, { state: controller.signal.aborted ? 'cancelled' : 'failed',
        reason: publicError(error, '工作文件补发未完成，请查看任务记录').message });
    }
  })().catch(error => service.channel.fail(error)).finally(() => { service.deliveries.delete(job.id); service.notify(); service.drain(); });
  service.deliveries.set(job.id, { job, controller, pending });
  return service.view(job);
}
