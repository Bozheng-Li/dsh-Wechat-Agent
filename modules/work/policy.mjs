import fs from 'node:fs';
import path from 'node:path';
import { ChannelError, eligible } from '../../shared/contracts.mjs';

export const WORK_STATES = new Set(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']);
export { workSettings } from '../../shared/contracts.mjs';
export function workAdministrator(store, scope) {
  if (!scope || !['private', 'group'].includes(scope.chatType) || !scope.senderId || scope.senderId === scope.accountId ||
      scope.senderId.endsWith('@chatroom') || (scope.chatType === 'private' && scope.senderId !== scope.peerId) ||
      !eligible(store.settings(scope.accountId), scope)) return false;
  const config = store.conversationSettings(scope.accountId, scope.chatType, scope.peerId);
  return config.remoteEnabled === true && (config.adminIds.includes(scope.senderId) ||
    (store.config.section('remote')?.globalAdminIds ?? []).includes(scope.senderId));
}
export function workAuthorized(store, scope, { artifactRecovery = false } = {}) {
  const settings = store.settings(scope.accountId), config = store.conversationSettings(scope.accountId, scope.chatType, scope.peerId);
  return settings.enabled && (scope.chatType === 'group' ? settings.groups : settings.privatePeers).includes(scope.peerId) &&
    (config.executionMode === 'work' || artifactRecovery && WORK_STATES.has(scope.state) && !['queued', 'running'].includes(scope.state)) && scope.senderId !== scope.accountId && !scope.senderId?.endsWith('@chatroom') &&
    (scope.chatType === 'private' ? scope.senderId === scope.peerId : config.workSenderIds.includes(scope.senderId) || workAdministrator(store, scope));
}
/** Resolve only ordinary paths under the selected task directory, including Windows junctions. */
export function workPath(root, relative = '.') {
  if (typeof relative !== 'string' || relative.length > 2000 || /[\u0000-\u001f\u007f]/.test(relative) || relative.includes(':') || path.isAbsolute(relative))
    throw new ChannelError('WORK_PATH_INVALID', '工作文件请使用任务目录内的相对路径');
  const file = path.resolve(root, relative), inside = path.relative(path.resolve(root), file);
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))
    throw new ChannelError('WORK_PATH_INVALID', '工作文件超出任务目录');
  for (let current = file; ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current !== file && !stat.isDirectory())) throw Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ChannelError('WORK_PATH_INVALID', '工作路径包含目录链接或无效目录');
    }
    if (path.dirname(current) === current) break;
  }
  return file;
}
export function taskDirectory(store, folder) {
  if (!/^(?:微信agent\/)?work\/[a-f0-9]{12}$/.test(folder)) throw new ChannelError('WORK_STATE_INVALID', '工作任务目录记录无效');
  return workPath(store.storageSettings().workspacePath, folder);
}
