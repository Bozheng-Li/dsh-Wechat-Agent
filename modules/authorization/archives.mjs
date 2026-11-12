import fs from 'node:fs';
import path from 'node:path';
import { identity, info } from '../../backend/storage/keys.mjs';
import { ownedPath } from './files.mjs';

/** Renaming or relocating a conversation keeps its previous snapshot. Only
 * copies with this conversation key and store ownership can be erased. */
export function archiveDirectories(store, scope) {
  const selector = info(scope.accountId, scope.chatType, scope.peerId), metadata = store.data.conversations[selector.key];
  const directories = new Set([metadata?.directory, ...(metadata?.archiveDirectories || []), ...(scope.archiveDirectories || [])].filter(Boolean));
  const parents = new Set([...directories].map(directory => path.dirname(directory)));
  for (const root of [path.join(store.root, 'storage/conversations'), store.data.storageSettings.recordsPath,
    store.data.conversationConfigs[selector.key]?.recordsPath].filter(Boolean))
    parents.add(path.join(root, '账号-' + identity([scope.accountId]).slice(0, 8)));
  for (const parent of parents) {
    if (!fs.existsSync(parent)) continue;
    ownedPath(path.dirname(parent), parent);
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.endsWith('--' + selector.key.slice(0, 10))) continue;
      const directory = ownedPath(parent, path.join(parent, entry.name));
      if (entry.isDirectory()) directories.add(directory);
    }
  }
  return [...directories].sort();
}

export function archiveCopies(store, scope) {
  const selector = info(scope.accountId, scope.chatType, scope.peerId), copies = [];
  for (const directory of archiveDirectories(store, scope)) {
    const file = ownedPath(directory, path.join(directory, 'conversation.json'));
    if (!fs.existsSync(file)) continue;
    const view = JSON.parse(fs.readFileSync(file, 'utf8'));
    store._validateView(view, selector); copies.push({ directory, file, view });
  }
  return copies;
}
