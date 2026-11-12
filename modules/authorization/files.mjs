import fs from 'node:fs';
import path from 'node:path';
import { ChannelError } from '../../shared/contracts.mjs';

export function ownedPath(root, target) {
  const base = path.resolve(root), resolved = path.resolve(target), relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '撤销授权的数据路径超出所属目录，未删除其他文件。');
  for (let current = resolved; current !== base; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '撤销授权的数据目录含重定向，未删除其他文件。');
  }
  if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink())
    throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '所属数据目录含重定向，未删除其他文件。');
  return resolved;
}

export function removeOwnedDirectory(root, directory, proofFile, ownerStoreId) {
  const target = ownedPath(root, directory);
  if (!fs.existsSync(target)) return;
  const proof = ownedPath(target, path.join(target, proofFile));
  if (!fs.existsSync(proof)) {
    if (!fs.readdirSync(target).length) fs.rmdirSync(target);
    else throw new ChannelError('AUTHORIZATION_CLEANUP_OWNER', '待清理目录缺少归属记录，相关功能保持停用，未删除其他文件。');
    return;
  }
  const value = JSON.parse(fs.readFileSync(proof, 'utf8'));
  if (value.ownerStoreId !== ownerStoreId)
    throw new ChannelError('AUTHORIZATION_CLEANUP_OWNER', '撤销授权的数据归属不匹配，未删除其他实例的文件。');
  removeManagedDirectory(root, target);
}

// Callers must first validate an owned index and the exact managed folder name.
export function removeManagedDirectory(root, directory) {
  const target = ownedPath(root, directory);
  if (!fs.existsSync(target)) return;
  if (!fs.lstatSync(target).isDirectory()) throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '待清理的数据目录无效。');
  const verify = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const child = ownedPath(target, path.join(folder, entry.name));
      if (entry.isSymbolicLink()) throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '数据内含重定向，未继续删除。');
      if (entry.isDirectory()) verify(child);
    }
  };
  verify(target);
  fs.rmSync(target, { recursive: true, force: true });
}

export function unlinkOwned(root, file) {
  const target = ownedPath(root, file);
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isFile()) throw new ChannelError('AUTHORIZATION_CLEANUP_PATH', '待删除的数据不是普通文件。');
    fs.unlinkSync(target);
  }
}
