import fs from 'node:fs';
import path from 'node:path';
import { identity } from '../../backend/storage/keys.mjs';
import { atomicJson } from '../../backend/storage/atomic-json.ts';
import { authorizationMatches } from '../../shared/authorization.mjs';
import { ownedPath } from './files.mjs';
import { relatedRecord } from './records.mjs';

/** Only snapshots written by this store's configuration migrations are managed.
 * Other stores' snapshots and unrelated files are never adopted or removed. */
function stateBackups(store) {
  const directory = path.join(store.root, 'storage/state');
  if (!fs.existsSync(directory)) return [];
  ownedPath(store.root, directory);
  const backups = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/^channel\.(?:(?:before-yaml|personas-v1)-[a-f0-9]{12}|v1)\.backup\.json$/.test(entry.name)) continue;
    const file = ownedPath(directory, path.join(directory, entry.name));
    if (!entry.isFile()) throw new Error('旧配置快照不是普通文件，未读取或重定向清理');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const owner = data.storeId || (data.version === 1 ? identity(['wechat-agent-v2', store.root, data]) : '');
    if (![1, 2].includes(data.version) || owner !== store.data.storeId) continue;
    backups.push({ directory, file, data });
  }
  return backups;
}

export function stateBackupScopes(store) {
  const scopes = new Map();
  const add = scope => {
    if (!scope?.accountId || !['private', 'group'].includes(scope.chatType) || !scope.peerId) return;
    if (scope.peerId === scope.accountId || scope.peerId.endsWith('@chatroom') !== (scope.chatType === 'group')) return;
    scopes.set(identity([scope.accountId, scope.chatType, scope.peerId]), { accountId: scope.accountId, chatType: scope.chatType, peerId: scope.peerId });
  };
  for (const { data } of stateBackups(store)) {
    for (const scope of Object.values(data.conversations || {})) add(scope);
    for (const [accountId, settings] of Object.entries(data.accounts || {}))
      for (const [field, chatType] of [['privatePeers', 'private'], ['groups', 'group']])
        for (const peerId of settings[field] || []) add({ accountId, chatType, peerId });
    for (const record of data.records || []) {
      add(record);
      if (record.senderId) add({ accountId: record.accountId, chatType: 'private', peerId: record.senderId });
    }
  }
  return [...scopes.values()];
}

export function purgeStateBackups(channel, scopes, keys) {
  const revokedKeys = new Set(scopes.map(scope => identity([scope.accountId, scope.chatType, scope.peerId])));
  const matches = (value, accountId) => scopes.some(scope => authorizationMatches({ ...value, accountId: value.accountId ?? accountId }, scope) ||
    value.scope && authorizationMatches({ ...value.scope, accountId: value.scope.accountId ?? accountId }, scope));
  const clean = (value, accountId, field = '') => {
    if (Array.isArray(value)) return value.flatMap(item => {
      if (typeof item === 'string' && ['privatePeers', 'groups', 'adminIds', 'participants', 'people'].includes(field) && scopes.some(scope =>
        scope.accountId === accountId && scope.peerId === item)) return [];
      const next = clean(item, accountId); return next === undefined ? [] : [next];
    });
    if (!value || typeof value !== 'object') return value;
    const account = value.accountId ?? accountId;
    if (matches(value, account)) return undefined;
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const next = clean(child, field === 'accounts' ? key : account, key);
      return next === undefined ? [] : [[key, next]];
    }));
  };
  for (const backup of stateBackups(channel.store)) {
    const previous = backup.data, next = structuredClone(previous), removedClaims = new Set(), removedContexts = new Set();
    for (const record of next.records || []) if (relatedRecord(record, scopes, keys)) {
      if (record.key) removedClaims.add(record.key);
      if (record.contextKey) removedContexts.add(record.contextKey);
    }
    if (Array.isArray(next.records)) next.records = next.records.filter(record => !relatedRecord(record, scopes, keys));
    for (const key of removedClaims) if (next.seen) delete next.seen[key];
    for (const key of removedContexts) if (next.sessions) delete next.sessions[key];
    for (const field of ['conversations', 'conversationConfigs', 'personas', 'imageMemory'])
      for (const key of Object.keys(next[field] || {})) if (revokedKeys.has(key) || scopes.some(scope =>
        identity([identity([scope.accountId, scope.chatType, scope.peerId]), 'generated']) === key)) delete next[field][key];
    for (const [key, config] of Object.entries(next.conversationConfigs || {})) {
      const accountId = next.conversations?.[key]?.accountId;
      if (accountId) next.conversationConfigs[key] = clean(config, accountId);
    }
    const sanitized = clean(next);
    if (JSON.stringify(sanitized) === JSON.stringify(previous)) continue;
    // Keep the original store owner verifiable after a legacy snapshot is redacted.
    sanitized.storeId = channel.store.data.storeId;
    ownedPath(backup.directory, backup.file); atomicJson(backup.file, sanitized);
  }
}
