import path from 'node:path';
import { ChannelError } from '../../shared/contracts.mjs';
import { workPath } from './policy.mjs';

const modes = new Set(['read-only', 'workspace-write', 'danger-full-access']);
export function workExecutionPolicy(resolvePolicy, shell, cwd, exec) {
  const service = shell?.ctx?.get?.('sandboxPolicy') ?? shell?.ctx?.sandboxPolicy;
  const policy = resolvePolicy ? resolvePolicy(exec) : service?.resolve?.({ session: exec?.agent?.session });
  if (!policy || !modes.has(policy.mode) || !path.isAbsolute(policy.workspaceRoot ?? ''))
    throw new ChannelError('WORK_PERMISSION_UNAVAILABLE', 'DSH 没有提供此会话的实际执行权限，命令未执行；请检查 DSH 权限策略组件');
  return structuredClone(policy);
}

/** File access follows the same live DSH session policy as native commands. */
export function workFilePath(cwd, value = '.', policy = { mode: 'workspace-write', workspaceRoot: cwd }, write = false) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value) ||
      value.includes(':') && !/^[a-z]:[\\/]/i.test(value))
    throw new ChannelError('WORK_PATH_INVALID', '工作文件路径无效，请使用普通文件路径');
  const target = path.resolve(cwd, value);
  if (target.split(path.sep).some(part => part.toLowerCase() === '.wechat-work'))
    throw new ChannelError('WORK_PATH_INVALID', '任务记录目录由程序管理，请选择其他文件');
  if (write && policy.mode === 'read-only') throw new ChannelError('WORK_PERMISSION_DENIED', '此 DSH 会话当前为只读权限，文件未修改');
  const root = !write || policy.mode === 'danger-full-access' ? path.parse(target).root : path.resolve(policy.workspaceRoot);
  return workPath(root, path.relative(root, target));
}
