import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { identity, info } from '../../backend/storage/keys.mjs';
import { atomicJson } from '../../backend/storage/atomic-json.ts';
import { authorizationMatches } from '../../shared/authorization.mjs';
import { ownedPath, removeOwnedDirectory, unlinkOwned } from './files.mjs';
import { archiveCopies } from './archives.mjs';

export function purgeConversationData(channel, scopes) {
  const { store, memory, imageMemory } = channel, owner = store.data.storeId;
  // Image and memory files can exist before a chat archive is created. Always
  // visit the revoked scope, even when it has no conversation.json metadata.
  const removed = scopes.map(scope => {
    const selector = info(scope.accountId, scope.chatType, scope.peerId), row = store.data.conversations[selector.key];
    if (row && (row.key !== selector.key || row.accountId !== scope.accountId || row.chatType !== scope.chatType || row.peerId !== scope.peerId))
      throw new Error('会话档案的归属不匹配，未删除其他数据');
    return { ...scope, ...selector, ...row };
  });
  for (const row of removed) {
    const selector = info(row.accountId, row.chatType, row.peerId), key = selector.key;
    const indexed = memory.index.conversations[key];
    if (indexed) {
      const file = memory.file({ ...selector, name: row.name });
      removeOwnedDirectory(memory.root, path.dirname(file), 'memory.json', owner);
      delete memory.index.conversations[key]; memory.errors.delete(key);
    }
    for (const collection of ['received', 'generated']) {
      const imageKey = collection === 'generated' ? identity([key, 'generated']) : key;
      const root = collection === 'generated' ? path.join(store.root, 'storage/memory/generated-images') : imageMemory.root;
      const directory = imageMemory.directory({ ...selector, key: imageKey, ...(collection === 'generated' ? { collection } : {}) });
      removeOwnedDirectory(root, directory, 'index.json', owner); imageMemory.errors.delete(imageKey);
    }
    const view = store.views.get(key);
    if (view) {
      store._validateView(view, selector);
      for (const claim of Object.keys(view.seen)) { delete store.data.seen[claim]; store.claimOwners.delete(claim); }
      for (const context of Object.keys(view.sessions)) { delete store.data.sessions[context]; store.contextOwners.delete(context); }
      const records = new Set(view.records); store.data.records = store.data.records.filter(record => !records.has(record));
    }
    for (const { directory, file } of archiveCopies(store, row)) {
      unlinkOwned(directory, file);
      if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
    }
    store.views.delete(key); store.written.delete(key);
    delete store.data.conversations[key]; delete store.data.conversationConfigs[key];
  }
  const people = scopes.filter(scope => scope.chatType === 'private');
  for (const metadata of Object.values(store.data.conversations)) {
    if (!people.some(scope => scope.accountId === metadata.accountId)) continue;
    const matched = row => people.some(scope => authorizationMatches({ ...row, accountId: metadata.accountId }, scope));
    const deleted = new Set(), view = store.views.get(metadata.key); let affected = false;
    for (const copy of archiveCopies(store, metadata)) {
      if (path.resolve(copy.directory) === path.resolve(metadata.directory)) continue;
      const saved = copy.view;
      if (![...saved.messages, ...saved.records].some(matched)) continue;
      const keys = new Set([...saved.messages, ...saved.records].filter(matched).map(row => row.key));
      for (const key of keys) deleted.add(key);
      saved.messages = saved.messages.filter(row => !matched(row)); saved.records = saved.records.filter(row => !matched(row));
      saved.seen = Object.fromEntries(Object.entries(saved.seen).filter(([key]) => !keys.has(key)));
      saved.sessions = {}; saved.progress = { count: 0, target: null }; delete saved.natural; saved.revision++;
      atomicJson(copy.file, saved);
    }
    if (view) {
      for (const row of [...view.messages, ...view.records].filter(matched)) if (row.key) deleted.add(row.key);
      affected = deleted.size > 0;
      view.messages = view.messages.filter(row => !matched(row)); view.records = view.records.filter(row => !matched(row));
      store.data.records = store.data.records.filter(row => !people.some(scope =>
        authorizationMatches({ ...row, accountId: row.accountId || metadata.accountId }, scope)));
    }
    if (memory.index.conversations[metadata.key]) {
      const file = memory.file(metadata);
      if (fs.existsSync(file)) {
        const doc = JSON.parse(fs.readFileSync(ownedPath(memory.root, file), 'utf8'));
        if (doc.ownerStoreId !== owner || doc.key !== metadata.key) throw Error('会话记忆的归属不匹配，未删除其他数据');
        const archive = path.join(path.dirname(file), 'archive'), archived = [];
        if (fs.existsSync(archive)) for (const entry of fs.readdirSync(archive, { withFileTypes: true })) {
          if (!entry.name.endsWith('.json')) continue;
          const target = ownedPath(memory.root, path.join(archive, entry.name)), saved = JSON.parse(fs.readFileSync(target, 'utf8'));
          if (saved.ownerStoreId !== owner || saved.key !== metadata.key) throw Error('会话归档的归属不匹配，未删除其他数据');
          if (saved.entries.some(matched)) affected = true;
          for (const row of saved.entries.filter(matched)) deleted.add(row.key);
          archived.push({ target, saved });
        }
        if (doc.entries.some(matched)) affected = true;
        for (const row of doc.entries.filter(matched)) deleted.add(row.key);
        if (affected) {
          for (const { target, saved } of archived) {
            saved.entries = saved.entries.filter(row => !matched(row)); saved.summary = ''; saved.summaryExpiresAt = null;
            saved.seen = saved.seen.filter(key => !deleted.has(key)); saved.generation = randomUUID();
            atomicJson(target, saved);
          }
          doc.entries = doc.entries.filter(row => !matched(row)); doc.summary = ''; doc.summaryExpiresAt = null;
          doc.generation = randomUUID(); doc.seen = doc.seen.filter(key => !deleted.has(key)); doc.revision++; doc.updatedAt = channel.now();
          atomicJson(file, doc);
        }
      }
    }
    if (view) {
      for (const key of deleted) { delete store.data.seen[key]; delete view.seen[key]; store.claimOwners.delete(key); }
      if (affected) {
        for (const context of Object.keys(view.sessions)) { delete store.data.sessions[context]; store.contextOwners.delete(context); }
        view.sessions = {}; view.progress = { count: 0, target: null }; delete view.natural;
      }
    }
  }
  memory.saveIndex(); store.save();
  return removed.length;
}
