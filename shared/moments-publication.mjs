import { createHash } from 'node:crypto';
import { audienceUserId, validateAudienceSelection } from './moments-audience.mjs';

export const publicationTextHash = text => createHash('sha256').update(text).digest('hex');
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const users = value => Array.isArray(value) && value.length <= 50000 && value.every(audienceUserId) && new Set(value).size === value.length;

/** Only validated publication metadata crosses IPC. No wire packets, image
 * payloads, provider URLs or login credentials belong in an error record. */
export function publicMomentPublication(value) {
  if (!value || !audienceUserId(value.accountId) || typeof value.postId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.postId) || BigInt(value.postId) > 0xffffffffffffffffn ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 || typeof value.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.textHash) ||
      !Number.isInteger(value.imageCount) || value.imageCount < 0 || value.imageCount > 9 || !users(value.submittedBlockedUserIds) ||
      value.returnedBlockedUserIds !== null && !users(value.returnedBlockedUserIds)) return null;
  let selection;
  try { selection = validateAudienceSelection({ action: 'publish', ...value.audienceSelection }); } catch { return null; }
  if (!value.audienceSelection || !['wechat-contacts-live', 'submitted-identifiers'].includes(value.audienceSource) ||
      value.audienceSource === 'wechat-contacts-live' && (typeof value.audienceFetchedAt !== 'string' || !Number.isFinite(Date.parse(value.audienceFetchedAt))) ||
      selection.blockedLabelIds.length && value.audienceSource !== 'wechat-contacts-live') return null;
  return { accountId: value.accountId, postId: value.postId, createdAt: value.createdAt, textHash: value.textHash,
    imageCount: value.imageCount, submittedBlockedUserIds: [...value.submittedBlockedUserIds],
    returnedBlockedUserIds: value.returnedBlockedUserIds === null ? null : [...value.returnedBlockedUserIds],
    audienceSelection: selection, audienceSource: value.audienceSource,
    ...(value.audienceSource === 'wechat-contacts-live' ? { audienceFetchedAt: value.audienceFetchedAt } : {}) };
}

export function matchingMomentPublication(value, query, accountId) {
  const publication = publicMomentPublication(value);
  const selection = validateAudienceSelection(query);
  return publication && publication.accountId === accountId && publication.textHash === publicationTextHash(query.text) &&
    publication.imageCount === (query.images?.length ?? 0) && same(publication.audienceSelection.blockedUserIds, selection.blockedUserIds) &&
    same(publication.audienceSelection.blockedLabelIds, selection.blockedLabelIds) &&
    selection.blockedUserIds.every(id => publication.submittedBlockedUserIds.includes(id)) ? publication : null;
}
