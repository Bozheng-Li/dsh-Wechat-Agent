import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError, AGENT_WORKSPACE_NAME } from '../../shared/contracts.mjs';
import { sameDirectory } from '../../backend/storage/paths.mjs';
import { registerAgentWorkspace } from '../agent/workspace.mjs';
import { publishWorkSessionHistory } from './session-history.mjs';

const digest = events => createHash('sha256').update(JSON.stringify(events)).digest('hex');
const busy = agent => agent && (agent.status !== 'idle' || agent.inbox?.hasPending || agent.inbox?.size > 0);

async function snapshot(ctx, id, signal) {
  signal?.throwIfAborted();
  // A live Agent keeps its persistence writer open even while idle. Opening
  // another read handle would wait for that writer for the Agent's lifetime.
  if (ctx.agents.get?.(id)) throw new ChannelError('WORK_SESSION_BUSY', '原 DSH 会话仍由桌面持有，释放后再归并');
  const deadline = AbortSignal.timeout(5000), readSignal = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
  let handle;
  try {
    handle = await ctx.sessionPersistence.open(id, 'read', { signal: readSignal });
    const stored = await handle.read(0, undefined, { signal: readSignal }), agent = ctx.agents.get?.(id);
    if (busy(agent)) throw new ChannelError('WORK_SESSION_BUSY', '原 DSH 会话仍在执行，等待空闲后归并');
    return { header: structuredClone(agent?.session.header ?? handle.header), inheritedEventCount: handle.inheritedEventCount,
      events: agent ? agent.session.snapshotEvents() : stored.events };
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new ChannelError('WORK_SESSION_BUSY', '原 DSH 会话或继承历史仍被占用，稍后再归并');
    throw error;
  } finally { await handle?.close(); }
}

/** Copy a legacy log through the public storage API; never start a model loop. */
export async function migrateWorkProjectSession(ctx, store, sourceId, taskCwd, projectCwd, signal) {
  const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry');
  if (!registry || !ctx.sessionPersistence?.create) return { sessionId: sourceId, state: 'unsupported' };
  signal?.throwIfAborted();
  const live = ctx.agents.get?.(sourceId);
  if (live) {
    if (busy(live) || !sameDirectory(live.session.header.cwd ?? '', projectCwd))
      throw new ChannelError('WORK_SESSION_BUSY', '原 DSH 会话仍由桌面持有，释放后再归并');
    const project = await registerAgentWorkspace(ctx, projectCwd, 'work');
    signal?.throwIfAborted();
    await project.attachSession(sourceId);
    return { sessionId: sourceId, state: 'current' };
  }
  const source = await snapshot(ctx, sourceId, signal);
  const project = await registerAgentWorkspace(ctx, projectCwd, 'work');
  if (sameDirectory(source.header.cwd ?? '', projectCwd)) {
    await project.attachSession(sourceId);
    return { sessionId: sourceId, state: 'current' };
  }
  const linkedTask = store.data.jobs.some(job => job.sessionId === sourceId &&
    sameDirectory(job.workspaceRoot, projectCwd) && sameDirectory(path.resolve(job.workspaceRoot, job.folder), taskCwd));
  const sharedLegacy = linkedTask && sameDirectory(source.header.cwd ?? '', path.join(projectCwd, AGENT_WORKSPACE_NAME));
  if (!sameDirectory(source.header.cwd ?? '', taskCwd) && !sharedLegacy)
    throw new ChannelError('WORK_PROJECT_MISMATCH', '旧会话不属于这个任务目录，未改动其项目或历史');
  const sourceSha256 = digest(source.events), suffix = createHash('sha256')
    .update(JSON.stringify(['wechat-project-copy-v1', sourceId, path.resolve(projectCwd), sourceSha256])).digest('hex').slice(0, 32);
  const targetId = `${suffix.slice(0, 8)}-${suffix.slice(8, 12)}-${suffix.slice(12, 16)}-${suffix.slice(16, 20)}-${suffix.slice(20)}`;
  const wasArchived = registry.archivedSessionIds.includes(sourceId);
  let writer, archived = false;
  try {
    const existing = await ctx.sessionPersistence.stat(targetId, { signal });
    writer = existing ? await ctx.sessionPersistence.open(targetId, 'write', { signal })
      : await ctx.sessionPersistence.create({ ...source.header, id: targetId, cwd: path.resolve(projectCwd) },
        { inheritedEventCount: source.inheritedEventCount, signal });
    const prior = (await writer.read(0, undefined, { signal })).events;
    if (!sameDirectory(writer.header.cwd ?? '', projectCwd) || writer.header.parentSession !== source.header.parentSession ||
        writer.header.isSeeded !== source.header.isSeeded || writer.inheritedEventCount !== source.inheritedEventCount ||
        digest(prior.slice(0, source.events.length)) !== digest(source.events.slice(0, Math.min(prior.length, source.events.length))))
      throw new ChannelError('WORK_MIGRATION_CONFLICT', '归并目标与原会话历史不一致，已保留双方记录');
    if (prior.length < source.events.length) await writer.append(source.events.slice(prior.length), { signal });
    if (!source.events.some(event => event.type === 'working-directory/change') && prior.length <= source.events.length)
      await writer.append([{ type: 'working-directory/change', seq: source.events.length, time: Date.now(),
        data: { cwd: path.resolve(taskCwd) } }], { signal });
    await writer.flush({ signal }); await writer.close(); writer = undefined;
    const target = await snapshot(ctx, targetId, signal);
    if (digest(target.events.slice(0, source.events.length)) !== sourceSha256)
      throw new ChannelError('WORK_MIGRATION_CONFLICT', '归并后的历史校验未通过，原会话保留');
    if (digest((await snapshot(ctx, sourceId, signal)).events) !== sourceSha256)
      throw new ChannelError('WORK_SESSION_BUSY', '原会话在归并期间有新内容，稍后重新归并');
    await project.attachSession(targetId);
    // The host refuses active sessions here. Never use stopActivity to force
    // another desktop task to stop, and never rewrite an immutable header.
    await registry.archiveSession(sourceId); archived = !wasArchived;
    if (digest((await snapshot(ctx, sourceId, signal)).events) !== sourceSha256)
      throw new ChannelError('WORK_SESSION_BUSY', '原会话在归并期间有新内容，已保留原会话');
    if (wasArchived) await registry.archiveSession(targetId);
    else await registry.unarchiveSession(targetId);
    store.rebindSession(sourceId, targetId, { sourceSha256, sourceEventCount: source.events.length,
      projectCwd: path.resolve(projectCwd), taskCwd: path.resolve(taskCwd) });
    await publishWorkSessionHistory(ctx, targetId);
    return { sessionId: targetId, sourceSessionId: sourceId, state: 'migrated', sourceEventCount: source.events.length, sourceSha256 };
  } catch (error) {
    if (archived) await registry.unarchiveSession(sourceId).catch(() => {});
    if (await ctx.sessionPersistence.stat(targetId).catch(() => null)) await registry.archiveSession(targetId).catch(() => {});
    if (error?.name === 'WorkspaceActiveSessionError')
      throw new ChannelError('WORK_SESSION_BUSY', '原 DSH 会话仍有活动，未停止或替换该会话');
    throw error;
  } finally { await writer?.close(); }
}

/** Only task projects proven by this store's folders are eligible for removal. */
export async function consolidateWorkProjects(ctx, store, workspaceRoot, signal) {
  const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry');
  if (!registry?.list || !ctx.sessionPersistence?.create) return { state: 'unsupported', migrated: 0, removedProjects: [], pending: [] };
  const directories = new Set(store.data.jobs.filter(job => sameDirectory(job.workspaceRoot, workspaceRoot))
    .map(job => path.resolve(workspaceRoot, job.folder)));
  const legacyProjects = registry.list().filter(project => [...directories].some(directory => sameDirectory(project.path, directory)));
  const candidates = new Map();
  for (const job of store.data.jobs) if (job.sessionId && sameDirectory(job.workspaceRoot, workspaceRoot))
    candidates.set(job.sessionId, path.resolve(workspaceRoot, job.folder));
  for (const project of legacyProjects) for (const id of project.sessionIds) candidates.set(id, project.path);
  const pending = [], removedProjects = []; let migrated = 0;
  // Host-registered fixed-project members were already checked on attachment.
  // Their inherited logs can have a live parent writer; startup needs no copy
  // and must not acquire persistence locks just to confirm their membership.
  const currentIds = new Set(registry.list().filter(project => sameDirectory(project.path, workspaceRoot)).flatMap(project => project.sessionIds));
  for (const [id, cwd] of candidates) {
    signal?.throwIfAborted();
    if (currentIds.has(id)) continue;
    try { if ((await migrateWorkProjectSession(ctx, store, id, cwd, workspaceRoot, signal)).state === 'migrated') migrated++; }
    catch (error) {
      if (signal?.aborted || error?.code === 'STATE_WRITE_FAILED') throw error;
      pending.push({ sessionId: id, code: error?.code ?? error?.name ?? 'WORK_MIGRATION_FAILED' });
    }
  }
  for (const project of legacyProjects) {
    signal?.throwIfAborted();
    if (project.sessionIds.every(id => registry.archivedSessionIds.includes(id) &&
        store.data.projectMigrations?.some(value => value.sourceSessionId === id))) {
      await registry.delete(project.id); removedProjects.push(project.id);
    }
  }
  return { state: pending.length ? 'partial' : 'ready', migrated, removedProjects, pending };
}
