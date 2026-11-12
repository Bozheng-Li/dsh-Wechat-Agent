import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { workPath } from '../work/policy.mjs';
import { ownedPath, removeManagedDirectory, unlinkOwned } from './files.mjs';
import { purgeMomentsData } from './moments.mjs';
import { revokedMessageKeys, relatedRecord } from './records.mjs';
import { artifactMetadata } from '../../shared/work-artifacts.mjs';
import { workArtifacts } from '../work/artifacts.mjs';
import { stateBackupScopes, purgeStateBackups } from './backups.mjs';

/** Discover existing scopes without exposing unauthorised content to a model.
 * This also covers authorisations removed while the application was stopped. */
export function storedObjectScopes(channel) {
  const scopes = new Map(), accounts = new Set(Object.keys(channel.store.data.accounts));
  const add = scope => {
    if (!scope?.accountId || !['private', 'group'].includes(scope.chatType) || !scope.peerId) return;
    if (scope.peerId === scope.accountId || scope.peerId.endsWith('@chatroom') !== (scope.chatType === 'group')) return;
    accounts.add(scope.accountId); scopes.set(identity([scope.accountId, scope.chatType, scope.peerId]), {
      accountId: scope.accountId, chatType: scope.chatType, peerId: scope.peerId });
  };
  const person = (accountId, peerId) => add({ accountId, chatType: 'private', peerId });
  for (const scope of [...stateBackupScopes(channel.store), ...Object.values(channel.store.data.conversations), ...Object.values(channel.memory.index.conversations),
    ...channel.imageMemory.storedScopes()]) add(scope);
  for (const job of channel.work.store.data.jobs) add(job);
  for (const task of channel.scheduler?.data.tasks || []) add(task);
  const automation = channel.momentsAutomation;
  for (const rule of Object.values(automation.likes.data.accounts)) for (const id of rule.settings.userIds) person(rule.accountId, id);
  for (const record of Object.values(automation.likes.data.records)) person(record.accountId, record.userId);
  for (const rule of Object.values(automation.interactions.automation.data.accounts)) {
    add(rule.scope); if (rule.settings.source === 'user') person(rule.accountId, rule.settings.user);
  }
  for (const record of Object.values(automation.interactions.data.runs)) {
    add(record.scope); for (const row of record.rows) person(record.accountId, row.userId);
  }
  for (const account of Object.values(automation.materials.data.accounts))
    for (const source of [...account.settings.sources, ...Object.values(account.items).flatMap(item => item.sources)]) add({ ...source, accountId: account.accountId });
  for (const [accountId, record] of Object.entries(channel.library.data.accounts))
    for (const asset of record.assets) if (asset.sourceMessage) add({ ...asset.sourceMessage, accountId });
  for (const accountId of accounts) {
    for (const scope of channel.store.roleCards.storedScopes(accountId)) person(accountId, scope.personId);
    for (const source of channel.store.roleCards.storedSourceScopes(accountId)) add(source);
    const files = channel.longMemory.paths(accountId);
    if (fs.existsSync(files.file)) for (const section of channel.longMemory.document(accountId).sections) {
      add({ ...section, accountId });
      for (const fact of section.facts) {
        if (!['group', 'conversation'].includes(fact.subjectId)) person(accountId, fact.subjectId);
        person(accountId, fact.subjectReference?.ownerId);
      }
    }
  }
  return [...scopes.values()];
}

function purgeTasks(channel, scopes, keys) {
  const scheduler = channel.scheduler; if (!scheduler) return;
  const removed = new Set(scheduler.data.tasks.filter(task => relatedRecord(task, scopes, keys) ||
    scopes.some(scope => scope.accountId === task.accountId && scope.chatType === 'private' &&
      task.targets?.some(target => target.id === scope.peerId))).map(task => task.id));
  if (!removed.size) return;
  const previous = scheduler.data;
  scheduler.data = { ...previous, tasks: previous.tasks.filter(task => !removed.has(task.id)), runs: previous.runs.filter(run => !removed.has(run.taskId)) };
  try { scheduler.save(); } catch (error) { scheduler.data = previous; throw error; }
}

const artifactKey = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
const jobArtifacts = job => [...(job.result?.artifacts || []), ...(job.delivery?.artifacts || []), ...workArtifacts(job.operations || []),
  ...(job.imageArchives || []).map(row => ({ ...row, path: row.sourcePath }))].filter(artifactMetadata);

function purgeSharedWorkFiles(job, shared) {
  const directory = workPath(job.workspaceRoot, job.folder), retainedPaths = new Set(shared.flatMap(jobArtifacts).map(row => artifactKey(row.path)));
  unlinkOwned(directory, workPath(directory, '.wechat-work/' + job.id + '.md'));
  for (const artifact of jobArtifacts(job)) {
    if (retainedPaths.has(artifactKey(artifact.path))) continue;
    const file = ownedPath(directory, workPath(directory, artifact.path));
    if (!fs.existsSync(file)) continue;
    if (!fs.lstatSync(file).isFile()) throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '工作成果路径不是普通文件，未删除其他数据。');
    if (fs.statSync(file).size === artifact.bytes && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === artifact.sha256) unlinkOwned(directory, file);
  }
}

function purgeWork(channel, scopes, keys) {
  const work = channel.work, removed = work.store.data.jobs.filter(job => relatedRecord(job, scopes, keys) ||
    scopes.some(scope => scope.accountId === job.accountId && scope.workIds?.includes(job.id)));
  if (!removed.length) return;
  const ids = new Set(removed.map(job => job.id)), retained = work.store.data.jobs.filter(job => !ids.has(job.id));
  for (const job of removed) keys.get(job.accountId)?.add('work:' + job.id);
  for (const job of removed) {
    const generated = '微信agent/generated-images/' + job.id;
    if (/^[a-f0-9]{12}$/.test(job.id)) removeManagedDirectory(job.workspaceRoot, workPath(job.workspaceRoot, generated));
    if (!/^(?:微信agent\/)?work\/[a-f0-9]{12}$/.test(job.folder))
      throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '工作任务目录与归属记录不符，未删除其他文件。');
    const shared = retained.filter(other => path.resolve(other.workspaceRoot, other.folder).toLowerCase() === path.resolve(job.workspaceRoot, job.folder).toLowerCase());
    if (shared.length) { purgeSharedWorkFiles(job, shared); continue; }
    removeManagedDirectory(job.workspaceRoot, workPath(job.workspaceRoot, job.folder));
  }
  const sessions = new Set(removed.map(job => job.sessionId).filter(id => id && !retained.some(job => job.sessionId === id)));
  const next = { ...work.store.data, jobs: retained };
  if (next.projectMigrations) next.projectMigrations = next.projectMigrations.filter(row => !sessions.has(row.sessionId) && !sessions.has(row.sourceSessionId));
  work.store.commit(next);
  for (const id of ids) work.chatSnapshots.delete(id);
}

function purgeMedia(channel, scopes, keys) {
  const { library } = channel, deleted = new Map(), detached = new Map();
  for (const [accountId, record] of Object.entries(library.data.accounts)) {
    const related = record.assets.filter(asset => asset.sourceMessage && relatedRecord(asset.sourceMessage, scopes, keys, accountId));
    const remove = related.filter(asset => !asset.nativeSticker?.favorite);
    const keep = record.assets.filter(asset => !remove.includes(asset));
    for (const asset of remove) {
      const file = library.file(accountId, asset);
      if (asset.bytes && !keep.some(other => library.file(accountId, other) === file)) unlinkOwned(library.root, file);
    }
    if (remove.length) deleted.set(accountId, new Set(remove.map(asset => asset.id)));
    if (related.length !== remove.length) detached.set(accountId, new Set(related.filter(asset => !remove.includes(asset)).map(asset => asset.id)));
  }
  if (!deleted.size && !detached.size) return;
  library.mutate(next => {
    for (const [accountId, record] of Object.entries(next.accounts)) {
      record.assets = record.assets.filter(asset => !deleted.get(accountId)?.has(asset.id));
      for (const asset of record.assets) if (detached.get(accountId)?.has(asset.id)) delete asset.sourceMessage;
    }
  });
}

function purgeWorkbench(channel, scopes, keys) {
  for (const accountId of new Set(scopes.map(scope => scope.accountId))) {
    const disk = channel.workbench.disk, file = disk.path(accountId);
    if (!fs.existsSync(file)) continue;
    const data = disk.load(accountId), summaries = data.summaries.filter(row => !relatedRecord(row, scopes, keys, accountId)),
      recovery = data.recovery.filter(row => !relatedRecord(row, scopes, keys, accountId));
    if (summaries.length !== data.summaries.length || recovery.length !== data.recovery.length) {
      data.summaries = summaries; data.recovery = recovery; data.diagnostics = null;
      disk.save(data, data.revision, { authorizationCleanup: true });
    }
  }
}

function purgeConfiguration(channel, scopes) {
  const { store } = channel, image = { ...store.config.section('imageMemory') };
  for (const scope of scopes) {
    const key = identity([scope.accountId, scope.chatType, scope.peerId]);
    delete store.data.conversationConfigs[key]; delete image[key]; delete image[identity([key, 'generated'])];
  }
  if (JSON.stringify(image) !== JSON.stringify(store.config.section('imageMemory'))) store.config.update('imageMemory', image, store.data);
  const remote = store.config.section('remote'), people = new Set(scopes.filter(scope => scope.chatType === 'private').map(scope => scope.peerId));
  // Account authorisation is independent; administrators on another account retain their settings.
  const stillAuthorized = id => Object.values(store.data.accounts).some(settings => settings.privatePeers.includes(id));
  const globalAdminIds = remote.globalAdminIds.filter(id => !people.has(id) || stillAuthorized(id));
  if (globalAdminIds.length !== remote.globalAdminIds.length) {
    const next = store.config.snapshot(store.data);
    next.remote = { ...remote, globalAdminIds };
    store.config.commit(next);
  }
  for (const [key, config] of Object.entries(store.data.conversationConfigs)) {
    const accountId = store.data.conversations[key]?.accountId;
    if (!accountId || !config.adminIds) continue;
    config.adminIds = config.adminIds.filter(id => !scopes.some(scope => scope.accountId === accountId && scope.chatType === 'private' && scope.peerId === id));
  }
}

export async function purgeFeatureData(channel, scopes) {
  const keys = revokedMessageKeys(channel, scopes);
  purgeStateBackups(channel, scopes, keys);
  purgeTasks(channel, scopes, keys); purgeWork(channel, scopes, keys);
  purgeMedia(channel, scopes, keys); purgeWorkbench(channel, scopes, keys);
  await purgeMomentsData(channel, scopes, keys);
  await channel.traces?.revoke(scopes, keys);
  purgeConfiguration(channel, scopes);
  for (const scope of scopes) for (const [id, person] of channel.personMemory.jobs)
    if (scope.chatType === 'private' && scope.accountId === person.accountId && scope.peerId === person.personId) channel.personMemory.jobs.delete(id);
}
