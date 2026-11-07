import { resourcePath } from '../platform/resources.mjs';
import path from 'node:path';
import { homedir } from 'node:os';

import { CHANNEL, ChannelError, publicError } from '../shared/contracts.mjs';
import { acquireLock } from '../storage/locks.mjs';
import { sameDirectory } from '../storage/paths.mjs';
import { WechatRuntime } from './runtime.mjs';
import { readWorkspaceLocation, describeWorkspace, migrateWorkspaceRoot } from '../storage/workspace.mjs';
import { rpcHandler } from './rpc.mjs';
import { createPluginService } from './service.mjs';

export const inject = [
  'connection',
  'webServer',
  'agents',
  'agentDefaultModel',
  'llm',
  'tools',
  'systemPrompt',
  'sessionPersistence',
  'attachments',
  'web',
  'credentials',
];

export async function apply(ctx) {
  const configuredHome = process.env.DSH_HOME?.trim();
  const dshHome =
    configuredHome?.startsWith('~/') || configuredHome?.startsWith('~\\')
      ? path.join(homedir(), configuredHome.slice(2))
      : configuredHome || path.join(homedir(), '.dsh');
  const bootstrap = path.resolve(dshHome, 'wechat-agent');
  let resolvedRoot = bootstrap;
  const resources = resourcePath();
  let lock,
    current,
    service,
    startupError,
    disposed = false,
    closing;
  const runtimes = new Set();
  const lifetime = new AbortController();
  const close = () =>
    (closing ??= (async () => {
      disposed = true;
      lifetime.abort();
      try {
        await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
        await service?.drain();
        await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
      } finally {
        lock?.release();
      }
    })());
  // Cordis runs sibling disposers concurrently. This one owns the complete
  // drain -> child exit -> exclusive-lock release sequence.
  ctx.effect(() => close, 'wechat-agent shutdown');
  const open = async (root) => {
    lifetime.signal.throwIfAborted();
    const runtime = new WechatRuntime({ ctx, root, bootstrap, resources, ownerLock: lock, signal: lifetime.signal });
    runtimes.add(runtime);
    try {
      await runtime.ready();
      return runtime;
    } catch (error) {
      try {
        await runtime.close();
      } finally {
        runtimes.delete(runtime);
      }
      throw error;
    }
  };
  const relocateWorkspace = async (target, signal) => {
    signal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const previous = current;
    if (sameDirectory(previous.root, target) && !describeWorkspace(previous.root, previous.store).legacyPaths.length)
      return;
    let transfer, next;
    try {
      await previous.stop();
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      transfer = migrateWorkspaceRoot({ bootstrap, store: previous.store, targetRoot: target });
      next = await open(transfer.root);
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      transfer.commit();
      transfer = undefined;
    } catch (error) {
      try {
        await next?.close();
      } catch {
        /* Worker close is still awaited in its finally. */
      }
      if (next) runtimes.delete(next);
      try {
        transfer?.rollback();
        previous.releaseLock();
        runtimes.delete(previous);
        if (!disposed) {
          current = await open(previous.root);
          service.replaceRuntime(current);
          await current.activate();
        }
      } catch (recoveryError) {
        service.setStartupError(recoveryError);
        throw new ChannelError(
          'WORKSPACE_RECOVERY_FAILED',
          '目录切换未完成，原数据和已复制的数据均保留；恢复连接失败，请检查目录后重新启用插件'
        );
      }
      throw error;
    }
    current = next;
    service.replaceRuntime(next);
    try {
      previous.releaseLock();
      runtimes.delete(previous);
    } catch {
      next.scheduler.error = '新目录已生效，旧目录锁暂未能清理；请保留旧目录并检查文件占用';
    }
    // No new message is admitted to the network until the pointer and all
    // root-bound services agree on the committed destination.
    await current.activate();
  };
  try {
    lock = acquireLock(bootstrap);
    resolvedRoot = readWorkspaceLocation(bootstrap);
    current = await open(resolvedRoot);
    await current.activate();
  } catch (error) {
    startupError = publicError(error, '微信插件启动失败，请检查安装包或重新启用插件');
    try {
      await current?.close();
    } finally {
      lock?.release();
      lock = undefined;
    }
  }
  let dshSessionPath = null;
  try {
    const persistence = ctx.sessionPersistence;
    if (
      persistence?.name === 'session-persistence-jsonl' &&
      typeof persistence.root === 'string' &&
      path.isAbsolute(persistence.root)
    )
      dshSessionPath = persistence.root;
  } catch {}
  service = createPluginService({
    ctx,
    root: current?.root || resolvedRoot,
    ...current,
    relocateWorkspace,
    startupError,
    isDisposed: () => disposed,
    lifetime: lifetime.signal,
    dshSessionPath,
  });
  // rc.5's rpc getter retains the Connection service's dependency shadow;
  // register with our explicit owner so webServer and teardown belong here.
  if (!disposed)
    ctx.connection.register(
      ctx,
      CHANNEL,
      rpcHandler(service, () => disposed)
    );
}
