import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";

/**
 * A lock file is created empty and filled immediately afterwards, so an
 * unreadable lock is either a writer that crashed between those two steps or a
 * writer that is still initialising. Reaping the first is the only way to
 * recover without hand-editing files; reaping the second would let two
 * instances run at once. The age of the file separates the two cases.
 */
const LOCK_GRACE_MS = 5000;

/** ok: parsed owner. missing: gone. unreadable: empty/truncated/non-object. */
function readOwner(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const owner = JSON.parse(text);
    return owner && typeof owner === 'object' ? { state: 'ok', owner } : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

function isStale(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs >= LOCK_GRACE_MS;
  } catch {
    return true;
  }
}

function reap(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function createExclusive(file, payload) {
  try {
    fs.writeFileSync(file, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

export function archiveLock(directory, ownerStoreId, key) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(path.dirname(directory)).isSymbolicLink())
    throw new ChannelError('CONVERSATION_PATH_CONFLICT', '会话目录包含重定向链接，未向其他目录写入数据');
  const file = path.join(directory, '.wechat-agent-write.lock'),
    token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createExclusive(file, { ownerStoreId, key, pid: process.pid, token }))
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
        } catch (error) {
          if (error.code !== 'ENOENT')
            throw new ChannelError('STATE_WRITE_FAILED', `会话文件已写入但目录锁无法释放（${file}），请检查权限后重新启用插件`);
        }
      };
    const observed = readOwner(file);
    if (observed.state === 'missing') continue;
    if (observed.state === 'unreadable') {
      if (isStale(file) && reap(file)) continue;
      throw new ChannelError('STATE_WRITE_FAILED', `会话目录锁暂时不可读（${file}）；请稍后重试，若持续出现可删除该文件后重新启用插件`);
    }
    const owner = observed.owner;
    if (owner.ownerStoreId !== ownerStoreId || owner.key !== key)
      throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标会话目录由其他数据实例使用，未覆盖已有记录');
    if (alive(owner.pid))
      throw new ChannelError(
        'STATE_WRITE_FAILED',
        '会话目录正由另一个实例写入，自动回复已暂停；请只保留一个使用该目录的实例'
      );
    // Reap only a dead writer belonging to this exact store and conversation.
    reap(file);
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
    if (createExclusive(file, { pid: process.pid, token }))
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
    const observed = readOwner(file);
    if (observed.state === 'missing') continue;
    if (observed.state === 'unreadable') {
      if (isStale(file) && reap(file)) continue;
      throw new ChannelError('OWNER_BUSY', `微信插件的实例锁暂时不可读（${file}）；请稍后重新启用插件，若持续出现可删除该文件后重新启用`);
    }
    const owner = observed.owner;
    if (alive(owner.pid) || alive(owner.workerPid))
      throw new ChannelError('OWNER_BUSY', '另一个 DSH 实例正在使用微信插件；请先在该实例停用插件');
    reap(file);
  }
  throw new ChannelError('OWNER_BUSY', '微信插件正在重载，请稍后重试');
}
