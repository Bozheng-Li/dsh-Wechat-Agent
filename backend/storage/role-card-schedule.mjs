import { createHash } from 'node:crypto';
import { roleCardSettingsRevision } from '../../shared/role-card-settings.mjs';

export const sourceFingerprint = source => createHash('sha256').update(JSON.stringify(source.kind === 'moments'
  ? { id: source.id, kind: source.kind, accountId: source.accountId, postId: source.postId, commentId: source.commentId,
    senderId: source.senderId, time: source.time, text: source.text } : source)).digest('hex');

// A review owns a finite snapshot. Messages received while it runs belong to
// the next accumulation, even when the snapshot needs several model batches.
export function scheduleRoleCard(doc, settings, now) {
  const revision = roleCardSettingsRevision(settings);
  if (doc.scheduleRevision !== revision) {
    if (!doc.reviewBatch?.manual) delete doc.reviewBatch;
    doc.retryAt = null;
    doc.scheduleRevision = revision;
  }
  doc.pendingAt ??= {};
  doc.urgentPending ??= {};
  const fingerprints = new Map(doc.pending.map(source => [source.id, sourceFingerprint(source)]));
  for (const source of doc.pending) doc.pendingAt[source.id] ??= now;
  for (const id of Object.keys(doc.pendingAt)) if (!fingerprints.has(id)) delete doc.pendingAt[id];
  for (const [id, fingerprint] of Object.entries(doc.urgentPending))
    if (fingerprints.get(id) !== fingerprint) delete doc.urgentPending[id];
  if (doc.reviewBatch) {
    for (const [id, fingerprint] of Object.entries(doc.reviewBatch.sources))
      if (fingerprints.get(id) !== fingerprint) delete doc.reviewBatch.sources[id];
    if (!Object.keys(doc.reviewBatch.sources).length && !doc.reviewBatch.refresh) delete doc.reviewBatch;
  }
  let due = null;
  if (doc.reviewBatch && (settings.enabled || doc.reviewBatch.manual) ||
      doc.refreshRequested && (settings.enabled || doc.refreshManual)) due = now;
  else if (settings.enabled && doc.pending.length) {
    if (Object.keys(doc.urgentPending).length ||
        settings.trigger === 'messages' && doc.pending.length >= settings.messageThreshold) due = now;
    else if (settings.trigger === 'time') due = Math.min(...Object.values(doc.pendingAt)) + settings.intervalMinutes * 60000;
  }
  doc.nextAt = due == null ? null : Math.max(due, doc.retryAt ?? 0);
  return doc;
}

export function beginRoleCardReview(doc, settings, now) {
  scheduleRoleCard(doc, settings, now);
  if (doc.nextAt == null || doc.nextAt > now) return null;
  doc.reviewBatch ??= {
    sources: Object.fromEntries(doc.pending.map(source => [source.id, sourceFingerprint(source)])),
    manual: !!(doc.refreshRequested && doc.refreshManual),
    refresh: !!doc.refreshRequested,
    refreshToken: doc.refreshToken,
  };
  return structuredClone(doc);
}
