import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";
import { read } from "./json.mjs";

export function archiveLock(directory, ownerStoreId, key) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(path.dirname(directory)).isSymbolicLink())
    throw new ChannelError('CONVERSATION_PATH_CONFLICT', '会话目录包含重定向链接，未向其他目录写入数据');
  const file = path.join(directory, '.wechat-agent-write.lock'),
    token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify({ ownerStoreId, key, pid: process.pid, token }));
      fs.closeSync(handle);
      handle = undefined;
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
        } catch (error) {
          if (error.code !== 'ENOENT')
            throw new ChannelError('STATE_WRITE_FAILED', '会话文件已写入但目录锁无法释放，请检查权限后重新启用插件');
        }
      };
    } catch (error) {
      if (handle !== undefined) {
        try {
          fs.closeSync(handle);
        } catch {}
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      if (error.code !== 'EEXIST') throw error;
      const owner = read(file);
      if (owner?.ownerStoreId !== ownerStoreId || owner.key !== key)
        throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标会话目录由其他数据实例使用，未覆盖已有记录');
      if (alive(owner.pid))
        throw new ChannelError(
          'STATE_WRITE_FAILED',
          '会话目录正由另一个实例写入，自动回复已暂停；请只保留一个使用该目录的实例'
        );
      // Reap only a dead writer belonging to this exact store and conversation.
      fs.unlinkSync(file);
    }
  }
  throw new ChannelError('STATE_WRITE_FAILED', '会话目录正在被占用，未继续处理消息');
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export function acquireLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'owner.lock');
  const token = randomUUID();
  const write = (workerPid) =>
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, workerPid, token }), { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return {
        worker(pid) {
          write(pid);
        },
        release() {
          try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new ChannelError('OWNER_BUSY', '微信插件的实例锁尚未释放，请稍后重新启用插件');
      }
      if (alive(owner.pid) || alive(owner.workerPid))
        throw new ChannelError('OWNER_BUSY', '另一个 DSH 实例正在使用微信插件；请先在该实例停用插件');
      fs.unlinkSync(file);
    }
  }
  throw new ChannelError('OWNER_BUSY', '微信插件正在重载，请稍后重试');
}
