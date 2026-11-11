import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { validateAudienceSelection } from '../../shared/moments-audience.mjs';
import { matchingMomentPublication } from '../../shared/moments-publication.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { workPath } from '../work/policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new ChannelError('MOMENTS_STATE_INVALID', message); };

export function ownerPublicationRecord(channel, query, accountId, requestId) {
  if (typeof accountId !== 'string' || typeof requestId !== 'string' || !requestId || requestId.length > 2000 || query?.action !== 'publish')
    fail('发布核对缺少实际账号、原始内容或操作编号');
  validateAudienceSelection(query);
  const scopeKey = identity([accountId, 'owner', accountId, accountId]);
  const clientId = 'sns_' + digest([channel.store.data.storeId, scopeKey, requestId, 'publish']);
  const file = workPath(channel.store.root, 'storage/moments/actions/' + clientId + '.json');
  let bytes, record;
  try { bytes = fs.readFileSync(file); record = JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('原发布操作记录无法读取，未重新提交'); }
  if (record.version !== 1 || record.clientId !== clientId || record.ownerStoreId !== channel.store.data.storeId || record.scopeKey !== scopeKey ||
      record.inputHash !== digest(query) || record.action !== 'publish' || !Number.isSafeInteger(record.createdAt) ||
      !['pending', 'succeeded', 'rejected', 'unknown'].includes(record.state)) fail('发布操作记录与当前账号或原始内容不符');
  return { record, file, bytes };
}

function confirmedDeletion(channel, accountId, postId, after, validateReceipt) {
  const directory = workPath(channel.store.root, 'storage/moments/actions');
  // Legacy journals hash JSON.stringify(query), so either exact field order
  // can describe the same deletion. Both still bind the action and post ID.
  const inputHashes = new Set([digest({ action: 'delete', postId }), digest({ postId, action: 'delete' })]);
  for (const name of fs.readdirSync(directory).filter(name => /^sns_[a-f0-9]{64}\.json$/.test(name))) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { continue; }
    if (record.version !== 1 || record.ownerStoreId !== channel.store.data.storeId || record.clientId + '.json' !== name ||
        record.action !== 'delete' || record.state !== 'succeeded' || !inputHashes.has(record.inputHash) ||
        record.result?.accountId !== accountId || record.result?.postId !== postId || !Number.isSafeInteger(record.finishedAt) || record.finishedAt < after) continue;
    try { validateReceipt(record.result, { action: 'delete', postId }, accountId); }
    catch { continue; }
    return { postId, confirmedAt: record.finishedAt, delivery: record.result.delivery, source: 'saved-wechat-receipt', clientId: record.clientId };
  }
  return null;
}

/** Reconcile one original operation using only reads and saved acknowledgments.
 * A failed read is never a proof of deletion or a reason to republish. */
export async function recoverOwnerPublication(channel, query, accountId, requestId, signal, check, validateReceipt) {
  check();
  const stored = ownerPublicationRecord(channel, query, accountId, requestId);
  if (!stored) return { kind: 'unknown', message: '原发布操作记录不可用，暂时无法核对这条动态。' };
  const { record, file, bytes } = stored;
  if (record.state === 'succeeded') { validateReceipt(record.result, query, accountId); return { kind: 'published', receipt: record.result }; }
  if (record.state === 'rejected' || channel.moments?.writes?.has(record.clientId)) return { kind: 'unknown', message: '这次发布尚不能核对为成功。' };
  const publication = matchingMomentPublication(record.publication, query, accountId);
  const start = record.createdAt - 2000, end = (record.finishedAt ?? record.createdAt + 300000) + 2000;
  const matches = post => momentsId(post.id) && (post.accountId ?? post.author?.userId) === accountId &&
    post.text === query.text && post.imageCount === (query.images?.length ?? 0) &&
    Number.isSafeInteger(post.createdAt) && post.createdAt * 1000 >= start && post.createdAt * 1000 <= end;
  const candidates = new Map();
  if (publication) candidates.set(publication.postId, { id: publication.postId, accountId, text: query.text,
    imageCount: publication.imageCount, createdAt: publication.createdAt });
  // Legacy records lack the expanded label snapshot. Match only unique text
  // posts in the original submission interval, never the nearest recent post.
  if (!publication && !query.images?.length && query.text?.trim()) {
    for (const post of Object.values(channel.momentsAutomation?.data.posts ?? {})) if (matches(post)) candidates.set(post.id, post);
    let cursor;
    for (let page = 0; page < 5 && !candidates.size && typeof channel.transport.readMoments === 'function'; page++) {
      check();
      const response = await channel.transport.readMoments({ accountId, scopeKey: 'moments-reconcile:' + record.clientId,
        query: { action: 'timeline', limit: 20, ...(cursor ? { cursor } : {}) } }, signal);
      check();
      if (response?.accountId !== accountId) fail('微信核对结果来自其他账号');
      for (const post of response.items ?? []) if (matches(post)) candidates.set(post.id, post);
      cursor = response.nextCursor;
      if (!cursor || !response.items?.length || response.items.every(post => post.createdAt * 1000 < start)) break;
    }
  }
  if (candidates.size !== 1) return { kind: 'unknown', message: candidates.size
    ? '同一时段有多条相同内容，不能确定哪条属于这次发布。'
    : '尚未找到能与原始内容和提交时间对应的动态，保留原记录。' };
  const post = [...candidates.values()][0];
  const save = update => {
    check();
    if (!fs.readFileSync(file).equals(bytes)) fail('核对期间发布回执已变化，请刷新后重查');
    atomicBytes(file, Buffer.from(JSON.stringify({ ...record, ...update }, null, 2) + '\n'));
  };
  const deleted = confirmedDeletion(channel, accountId, post.id, record.createdAt, validateReceipt);
  if (deleted) {
    const result = { kind: 'deleted', postId: post.id, createdAt: post.createdAt, deletion: deleted,
      audienceConfirmed: false, message: '已核对到这条动态的微信删除回执；当时的屏蔽范围未确认。' };
    save({ reconciliation: { ...result, checkedAt: channel.now() } }); return result;
  }
  if (typeof channel.transport.readMomentsPublication !== 'function')
    return { kind: 'unknown', message: '当前微信组件尚未提供发布核对，请更新组件。' };
  check();
  let current;
  try { current = await channel.transport.readMomentsPublication({ accountId, scopeKey: 'moments-reconcile:' + record.clientId, query: { postId: post.id } }, signal); }
  catch (error) {
    check();
    if (error.code !== 'ERR_MOMENTS_REJECTED' && error.code !== 'ERR_MOMENTS_TARGET_UNAVAILABLE') throw error;
    const result = { kind: publication ? 'published-unverified' : 'unknown', postId: post.id,
      message: '这条动态目前无法读取，尚不能确认当前可见范围或是否已删除。' };
    save({ reconciliation: { ...result, checkedAt: channel.now() } }); return result;
  }
  check();
  if (current?.accountId !== accountId || current.postId !== post.id) fail('发布核对返回了其他账号或动态');
  if (current.deleted === true) {
    const result = { kind: 'deleted', postId: post.id, createdAt: post.createdAt, audienceConfirmed: false,
      deletion: { postId: post.id, confirmedAt: channel.now(), delivery: 'verified-existing', source: 'wechat-sns-live' },
      message: '微信已确认这条动态删除；当时的屏蔽范围未确认。' };
    save({ reconciliation: { ...result, checkedAt: channel.now() } }); return result;
  }
  if (!current.contentAvailable || !matches({ ...current, id: current.postId }))
    return { kind: 'unknown', message: '微信返回的内容或发布时间与原发布记录不符，未错误关联。' };
  const selection = validateAudienceSelection(query);
  // An old label's present-day members cannot prove its members at publication.
  const expected = publication?.submittedBlockedUserIds ?? (!selection.blockedLabelIds.length ? selection.blockedUserIds : null);
  if (!expected || expected.length && (!current.audienceComplete || expected.some(id => !current.blockedUserIds?.includes(id)))) {
    const result = { kind: 'published-unverified', postId: post.id, createdAt: current.createdAt,
      message: expected ? '已找到发布的动态，但微信尚未确认全部指定屏蔽对象。' : '已找到发布的动态；旧记录未保存当时的标签成员，屏蔽范围仍无法核实。' };
    save({ reconciliation: { ...result, checkedAt: channel.now() } }); return result;
  }
  const receipt = { accountId, action: 'publish', postId: post.id, createdAt: current.createdAt, text: current.text, imageCount: current.imageCount,
    delivery: 'verified-existing', readbackConfirmed: true, audienceConfirmed: true, audienceSource: 'wechat-sns-live',
    audienceFetchedAt: new Date(channel.now()).toISOString(), audienceSelection: selection, blockedLabelIds: selection.blockedLabelIds,
    submittedBlockedUserIds: expected, blockedUserIds: current.blockedUserIds ?? [] };
  validateReceipt(receipt, query, accountId);
  save({ state: 'succeeded', result: receipt, reconciledAt: channel.now(), reconciliation: { kind: 'published', checkedAt: channel.now() } });
  return { kind: 'published', receipt, message: '已从微信核对这条动态及指定屏蔽对象。' };
}
