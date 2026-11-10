import fs from 'node:fs';
import path from 'node:path';
import { ChannelError, AGENT_WORKSPACE_NAME } from '../../shared/contracts.mjs';
import { absoluteDirectory, sameDirectory } from '../../backend/storage/paths.mjs';

export const WECHAT_PROJECT_TITLES = Object.freeze({ chat: '微信聊天', work: '微信工作' });

/** Keep the existing directory name; project titles are independent of paths. */
export function prepareAgentWorkspace(basePath) {
  try {
    const base = fs.realpathSync(absoluteDirectory(basePath, '工作空间路径'));
    const directory = path.join(base, AGENT_WORKSPACE_NAME);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw Error('Redirected agent workspace');
    fs.mkdirSync(directory, { recursive: true });
    const resolved = fs.realpathSync(directory);
    if (!sameDirectory(path.dirname(resolved), base) || !fs.statSync(resolved).isDirectory()) throw Error('Invalid child directory');
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    return resolved;
  } catch {
    throw new ChannelError('AGENT_WORKSPACE_UNAVAILABLE', '无法使用工作目录下的“微信agent”文件夹，请检查目录、权限或重定向链接');
  }
}

export async function registerAgentWorkspace(ctx, directory, kind = 'chat') {
  const title = WECHAT_PROJECT_TITLES[kind];
  if (!title) throw new ChannelError('AGENT_WORKSPACE_REGISTRATION_FAILED', '微信项目类型无效，未登记项目');
  try {
    const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry');
    if (!registry) return null;
    const workspace = await registry.create(directory, title);
    if (workspace.title !== title) await workspace.setTitle(title);
    return workspace;
  } catch {
    throw new ChannelError('AGENT_WORKSPACE_REGISTRATION_FAILED', `“${title}”项目无法登记到 DSH，请检查宿主的工作区服务`);
  }
}
