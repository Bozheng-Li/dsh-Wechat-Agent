import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { atomicJson } from '../../backend/storage/atomic-json.ts';
import { workPath } from '../work/policy.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { relatedRecord } from './records.mjs';
import { ownedPath, unlinkOwned } from './files.mjs';

function commit(manager, next) {
  if (manager.error) throw new ChannelError('AUTHORIZATION_CLEANUP_STATE', manager.error);
  if (JSON.stringify(next) === JSON.stringify(manager.data)) return;
  atomicJson(manager.file(), next); manager.data = next;
}
const prune = (rows, related) => Object.fromEntries(Object.entries(rows).filter(([, row]) => !related(row)));

export async function purgeMomentsData(channel, scopes, keys) {
  const managers = channel.momentsAutomation, accounts = new Set(scopes.map(scope => scope.accountId)),
    people = (accountId, id) => scopes.some(scope => scope.accountId === accountId && scope.chatType === 'private' && scope.peerId === id),
    related = (row, accountId) => relatedRecord(row, scopes, keys, accountId);
  const posts = new Set();
  for (const [key, userId] of channel.momentOwners || []) if ([...accounts].some(accountId => key.startsWith(accountId + ':') && people(accountId, userId))) posts.add(key);
  for (const row of Object.values(managers.likes.data.records)) if (people(row.accountId, row.userId)) posts.add(row.accountId + ':' + row.postId);
  for (const run of Object.values(managers.interactions.data.runs)) for (const row of run.rows)
    if (people(run.accountId, row.userId)) posts.add(run.accountId + ':' + row.postId);
  const affected = (row, accountId = row.accountId) => related(row, accountId) || posts.has(accountId + ':' + (row.postId || row.id));

  const materials = structuredClone(managers.materials.data), removedMaterials = new Set(scopes.flatMap(scope =>
    (scope.materialIds || []).map(id => scope.accountId + ':' + id)));
  for (const account of Object.values(materials.accounts)) {
    if (!accounts.has(account.accountId)) continue;
    const removed = Object.values(account.items).filter(item => related(item, account.accountId));
    for (const item of removed) {
      if (item.image) unlinkOwned(channel.store.root, workPath(channel.store.root, item.image.path));
      removedMaterials.add(account.accountId + ':' + item.id); delete account.items[item.id];
      if (item.fingerprint) delete account.suppressed[item.fingerprint];
    }
    const sources = account.settings.sources.filter(source => !related(source, account.accountId));
    if (sources.length !== account.settings.sources.length || removed.length) {
      account.settings.sources = sources;
      if (!sources.length) { account.settings.enabled = false; account.nextRunAt = 0; }
      account.revision = randomUUID(); account.lastRun = null;
      account.seen = Object.fromEntries(Object.entries(account.seen).filter(([key]) => !keys.get(account.accountId)?.has(key)));
      if (account.generations) account.generations = prune(account.generations, row => removedMaterials.has(account.accountId + ':' + row.materialId));
    }
  }
  commit(managers.materials, materials);

  const likes = structuredClone(managers.likes.data);
  likes.records = prune(likes.records, affected);
  for (const rule of Object.values(likes.accounts)) {
    const userIds = rule.settings.userIds.filter(id => !people(rule.accountId, id));
    if (userIds.length !== rule.settings.userIds.length) {
      rule.settings.userIds = userIds; rule.revision = randomUUID();
      if (!userIds.length) { rule.settings.enabled = false; rule.nextRunAt = 0; }
    }
  }
  likes.runs = prune(likes.runs, affected); commit(managers.likes, likes);

  const interactions = structuredClone(managers.interactions.data);
  interactions.runs = prune(interactions.runs, run => related(run) || run.rows.some(row => affected(row, run.accountId)));
  commit(managers.interactions, interactions);
  const schedules = structuredClone(managers.interactions.automation.data);
  for (const [id, rule] of Object.entries(schedules.accounts)) {
    if (related(rule.scope, rule.accountId) || rule.settings.source === 'user' && people(rule.accountId, rule.settings.user))
      delete schedules.accounts[id];
  }
  commit(managers.interactions.automation, schedules);

  const automation = structuredClone(managers.data);
  for (const field of ['posts', 'replies', 'friendPosts']) automation[field] = prune(automation[field], affected);
  commit(managers, automation);

  const publishing = structuredClone(managers.publishing.data), materialRelated = row => {
    const id = row?.materialId || row?.id;
    return !!id && removedMaterials.has(row.accountId + ':' + id);
  };
  const relatedPublication = row => related(row) || [...(row.sources || []), ...(row.materialSources || []),
    ...(row.selectedMaterials || []), ...(row.materialContextRefs || []), { id: row.imageMaterialId }].some(source =>
      related(source, row.accountId) || materialRelated({ ...source, accountId: row.accountId }));
  const removedRuns = Object.values(publishing.runs).filter(relatedPublication);
  for (const run of removedRuns) if (run.image) unlinkOwned(channel.store.root, workPath(channel.store.root, run.image.path));
  publishing.runs = prune(publishing.runs, relatedPublication);
  for (const [id, plan] of Object.entries(publishing.plans)) {
    if (related(plan)) {
      for (const [runId, run] of Object.entries(publishing.runs)) if (run.planId === id) {
        if (run.image) unlinkOwned(channel.store.root, workPath(channel.store.root, run.image.path));
        delete publishing.runs[runId];
      }
      delete publishing.plans[id];
    }
  }
  commit(managers.publishing, publishing);

  const directory = workPath(channel.store.root, 'storage/moments/actions');
  const scopeKeys = new Set();
  for (const scope of scopes) {
    const senders = new Set([scope.accountId, scope.peerId]);
    for (const view of channel.store.views.values()) if (view.accountId === scope.accountId)
      for (const row of [...view.messages, ...view.records]) if (row.senderId) senders.add(row.senderId);
    for (const senderId of senders) scopeKeys.add(identity([scope.accountId, scope.chatType, scope.peerId, senderId]));
  }
  if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/^sns_[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const file = ownedPath(channel.store.root, path.join(directory, entry.name)), row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (row.ownerStoreId !== channel.store.data.storeId) throw new ChannelError('AUTHORIZATION_CLEANUP_OWNER', '朋友圈操作记录不属于当前实例，未删除其他文件。');
    if (affected(row, row.accountId || row.result?.accountId) || scopeKeys.has(row.scopeKey)) unlinkOwned(channel.store.root, file);
  }
  for (const [key, userId] of channel.momentOwners || []) if ([...accounts].some(accountId =>
    key.startsWith(accountId + ':') && (people(accountId, userId) || posts.has(key)))) channel.momentOwners.delete(key);
  for (const [key, userId] of channel.momentCommentOwners || []) if ([...accounts].some(accountId =>
    key.startsWith(accountId + ':') && (people(accountId, userId) || [...posts].some(post => key.startsWith(post + ':'))))) channel.momentCommentOwners.delete(key);
}
