import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ChannelError, publicError, workSettings } from '../../shared/contracts.mjs';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { workAuthorized, workAdministrator, taskDirectory, workPath } from './policy.mjs';
import { DshWorkRunner } from './runner.mjs';
import { WorkStore } from './store.mjs';
import { workFiles, workResult, workStateLabels, workDeliveryLabels } from './result.mjs';
import { WORK_HELP, workConnectionRequest, remoteInspectionRequest } from './commands.mjs';
import { workOutcome } from './outcome.mjs';
import { parseRemoteIntent } from '../remote/intent/index.mjs';
import { ImageGenerationService } from './image-generation.mjs';
import { workArtifacts, readWorkArtifact } from './artifacts.mjs';
import { workImageRequest } from '../../shared/work-image-request.mjs';
import { workDialogueState, workDialogueHistory } from './dialogue.mjs';
import { WORK_TURN_TASK_LIMIT } from '../tools/index.mjs';
import { polishWorkResult } from './polish.mjs';
import { workImageSnapshot, archiveWorkImages, archiveChangedWorkImages, mergeImageArchives } from './image-storage.mjs';
import { retryArtifacts, retryWorkDelivery } from './delivery.mjs';
import { consolidateWorkProjects, migrateWorkProjectSession } from './projects.mjs';
import { sameDirectory } from '../../backend/storage/paths.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { workPresentation } from './presentation.mjs';
import { GeneratedImageMemory } from '../memory/images/generated.mjs';
import { imageMemoryTool } from '../memory/images/tool.mjs';
import { workConversationMemoryTool } from '../memory/query/work-tool.mjs';
import { personRoleCardTool } from '../memory/roles/tool.mjs';
import { WorkProgressReporter } from './progress.mjs';

const matches = (job, scope = {}) => ['accountId', 'chatType', 'peerId', 'senderId'].every(key => scope[key] === undefined || scope[key] === job[key]);
const folderKey = job => {
  const value = path.resolve(job.workspaceRoot, job.folder);
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
export class WorkService {
  constructor(channel, runner) {
    this.channel = channel; this.store = new WorkStore(channel.store, channel.now);
    this.runner = runner ?? new DshWorkRunner(channel.runner); this.closed = false; this.pending = [];
    this.active = new Map(); this.held = new Set(); this.changed = Promise.withResolvers();
    this.deliveries = new Map();
    this.imageGeneration = new ImageGenerationService(channel.runner?.ctx, channel.store);
    this.generatedImages = new GeneratedImageMemory(channel.imageMemory, this.store);
    this.chatSnapshots = new Map();
  }
  assertAllowed(job, signal, { artifactRecovery = false, retryId } = {}) {
    if (retryId) { retryArtifacts(job, retryId); artifactRecovery = true; }
    signal?.throwIfAborted();
    this.channel.store.config.assertCurrent();
    const status = this.channel.transport.status();
    if (this.closed || this.channel.closed || this.channel.fault || !status.online || status.account?.id !== job.accountId ||
        !workAuthorized(this.channel.store, job, { artifactRecovery }) || [...this.channel.pauses.values()].some(pause => matches(job, pause.selector)))
      throw new ChannelError('WORK_NOT_AUTHORIZED', '工作模式、发起成员授权或微信连接已变化，未继续执行或回传');
    if (job.connectionAccess && !workAdministrator(this.channel.store, job))
      throw new ChannelError('WORK_NOT_AUTHORIZED', '此工作任务的管理员连接权限已撤销，未继续执行或回传');
    if (job.state === 'running' && job.operations?.length >= 200) throw new ChannelError('WORK_OPERATION_LIMIT', '工作任务已达到 200 次工具操作，已停止；请检查结果后继续任务');
  }
  owned(jobId, scope) {
    const job = this.store.get(jobId);
    if (!matches(job, scope)) throw new ChannelError('WORK_NOT_FOUND', '此会话或发起人没有这个工作任务');
    return job;
  }
  view(job) { return { ...job, cwd: taskDirectory(this.channel.store, job.folder) }; }
  capacity() {
    return { ...workSettings(this.channel.store.config.data.work), running: this.active.size,
      queued: this.pending.length };
  }
  async prepareProjects(signal) {
    this.projects = await consolidateWorkProjects(this.channel.runner.ctx, this.store, this.channel.store.ensureWorkspace(), signal);
    return this.projects;
  }
  list(scope) { return { jobs: this.store.list(scope).slice(0, 200).map(job => this.view(job)), capacity: this.capacity(), ...(this.projects ? { projects: this.projects } : {}) }; }
  get(jobId, scope) { return this.view(this.owned(jobId, scope)); }
  dialogueTask(scope) {
    const root = this.channel.store.storageSettings().workspacePath;
    const current = this.store.list(scope).find(job => job.conversationTurn === true && sameDirectory(job.workspaceRoot, root));
    if (current) return current;
    // Old installations recorded the top-level task on the accepted input.
    // Parallel children are deliberately not a conversation's current task.
    for (const record of [...this.channel.store.data.records].reverse()) {
      if (!matches(record, scope) || record.mode !== 'work' || record.workJobId) continue;
      for (const id of [...(record.createdWorkJobIds ?? [])].reverse()) {
        const job = this.store.data.jobs.find(value => value.id === id && matches(value, scope) && sameDirectory(value.workspaceRoot, root));
        if (job) return this.store.get(id);
      }
    }
    return null;
  }
  folderBusy(job) {
    const key = folderKey(job);
    return [...this.active.values(), ...this.deliveries.values()].some(value => folderKey(value.job) === key);
  }
  create(scope, request, previousId, { defer = false, imageRequest, conversationTurn = false, conversationSnapshot } = {}) {
    this.assertAllowed(scope);
    if (typeof request !== 'string' || !request.trim() || request.length > 12000)
      throw new ChannelError('WORK_REQUEST_INVALID', '工作要求应为 1–12000 字');
    // Tools follow the verified administrator, not a keyword guess about the
    // message. The Agent decides whether the current request needs a tool.
    const selectedImage = imageRequest === undefined ? undefined : workImageRequest(imageRequest);
    const connectionAccess = !selectedImage && workAdministrator(this.channel.store, scope);
    if (this.pending.length >= 20) throw new ChannelError('WORK_QUEUE_FULL', '工作队列已满，请等待已有任务完成');
    const previous = previousId ? this.owned(previousId, scope) : null;
    const id = randomBytes(6).toString('hex'), folder = previous?.folder ?? `微信agent/work/${id}`;
    const workspaceRoot = path.resolve(this.channel.store.storageSettings().workspacePath), cwd = taskDirectory(this.channel.store, folder);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const requestedAt = scope.requestedAt ?? this.channel.now();
    let chatSnapshot = conversationSnapshot && structuredClone(conversationSnapshot);
    if (!chatSnapshot && this.channel.memory?.snapshot) {
      try {
        chatSnapshot = this.channel.memory.snapshot(scope, scope.requestKey);
        chatSnapshot.entries = chatSnapshot.entries.filter(entry => (entry.observedAt ?? entry.time) <= requestedAt);
        // A later compaction may cover material not yet visible to this request.
        if (chatSnapshot.updatedAt > requestedAt) chatSnapshot.summary = '';
      } catch (error) {
        if (!(error instanceof ChannelError)) throw error;
        // A damaged optional memory must not prevent unrelated native work.
        chatSnapshot = { unavailable: publicError(error, '当前会话记忆不可读取').message };
      }
    }
    const job = this.store.add({ id, ...scope, requestedAt, request: request.trim(), folder, workspaceRoot, connectionAccess,
      ...(selectedImage ? { imageRequest: selectedImage } : {}),
      ...(previous ? { continues: previous.id } : {}),
      ...(conversationTurn ? { conversationTurn: true } : {}),
      sessionId: previous?.workspaceRoot === workspaceRoot ? previous.sessionId : null,
      state: 'queued', delivery: { state: 'not-ready' }, operations: [], createdAt: this.channel.now(), updatedAt: this.channel.now() });
    if (chatSnapshot) this.chatSnapshots.set(id, structuredClone(chatSnapshot));
    if (defer) this.held.add(id);
    this.pending.push(id); this.notify(); this.drain(); return this.view(job);
  }
  release(ids) {
    for (const id of ids) this.held.delete(id);
    this.notify(); this.drain();
  }
  notify() { this.changed.resolve(); this.changed = Promise.withResolvers(); }
  handle(command, scope, options) {
    if (command.action === 'help') return WORK_HELP;
    this.assertAllowed(scope);
    if (command.action === 'input-required') return '当前是工作模式，请用文字说明要执行的任务。';
    if (command.action === 'status' && command.all === true) {
      const jobs = this.store.list(scope), recent = jobs.slice(0, 12);
      if (!jobs.length) return '你目前没有工作任务。';
      return [`你有 ${jobs.length} 项工作${jobs.length > recent.length ? `，下面是最近 ${recent.length} 项` : ''}：`,
        ...recent.map(job => `${workStateLabels[job.state]}：${job.request.replace(/\s+/g, ' ').slice(0, 100)}${job.request.length > 100 ? '…' : ''}（${workDeliveryLabels[job.delivery.state]}）`)].join('\n');
    }
    const id = command.id ?? this.store.list(scope)[0]?.id;
    if (['status', 'cancel'].includes(command.action) && !id) return '此会话中你还没有工作任务。';
    if (command.action === 'status') {
      const job = this.get(id, scope);
      return [`工作任务 ${job.id} · ${workStateLabels[job.state]}`, `回传：${workDeliveryLabels[job.delivery.state]}`,
        ['queued', 'running'].includes(job.state) ? '结果出来后会发到这个会话。' : workResult(job, job.cwd)].join('\n');
    }
    if (command.action === 'cancel') { const job = this.cancel(id, scope); return `工作任务 ${id}：${workStateLabels[job.state]}${job.state === 'running' ? '，正在停止执行' : ''}。`; }
    const previousId = command.action === 'continue' ? command.id
      : options?.conversationTurn && !command.newSession ? this.dialogueTask(scope)?.id : undefined;
    const job = this.create(scope, command.request, previousId, options);
    options?.onCreated?.(job);
    if (job.continues && this.folderBusy(job) && !this.active.has(job.id))
      return '收到，等前一项处理并回传完，我接着做。';
    if (!this.active.has(job.id) && this.active.size >= this.capacity().maxConcurrent) return '收到了，现在还在排队，前面的任务空出位置后就开始。';
    return job.continues ? '好，我接着处理，完成后把结果发你。'
      : remoteInspectionRequest(job.request) ? '好，我来查一下，拿到结果后发你。' : '好，我来处理，完成后把结果发你。';
  }
  drain() {
    if (this.closed || this.channel.fault) return;
    while (this.active.size < this.capacity().maxConcurrent) {
      const seenFolders = new Set();
      const index = this.pending.findIndex(id => {
        const job = this.store.get(id), key = folderKey(job), earlier = seenFolders.has(key);
        seenFolders.add(key);
        return !earlier && !this.held.has(id) && !this.folderBusy(job);
      });
      if (index < 0) break;
      const [id] = this.pending.splice(index, 1), job = this.store.get(id);
      if (job.state !== 'queued') continue;
      const finished = Promise.withResolvers();
      const active = { id, job, controller: new AbortController(), finished: finished.promise };
      this.active.set(id, active);
      active.pending = this.execute(id, active).catch(error => this.channel.fail(error)).finally(() => {
        this.active.delete(id); this.chatSnapshots.delete(id); finished.resolve(); this.notify(); this.drain();
      });
      this.notify();
    }
  }
  async execute(id, active) {
    let job = this.store.get(id);
    if (job.state !== 'queued') return;
    const cwd = taskDirectory(this.channel.store, job.folder);
    const { controller } = active;
    const save = patch => {
      try { return this.store.update(id, patch); }
      catch (error) { controller.abort(error); this.channel.fail(error); throw error; }
    };
    const limits = workSettings(this.channel.store.config.data.work);
    let createdTaskCount = 0;
    let producedResult;
    let progress;
    const imageSnapshot = workImageSnapshot(cwd);
    const saveImages = async artifacts => {
      const archives = archiveWorkImages(job, cwd, artifacts);
      if (archives.length) {
        job = save({ imageArchives: mergeImageArchives(job.imageArchives, archives) });
        await this.generatedImages.captureJob(job);
      }
    };
    try {
      this.assertAllowed(job, controller.signal);
      if (job.continues) {
        let previous = this.owned(job.continues, job);
        const visited = new Set([job.id]);
        while (!previous.sessionId && previous.continues && !visited.has(previous.id)) {
          visited.add(previous.id); previous = this.owned(previous.continues, job);
        }
        if (previous.sessionId && sameDirectory(previous.workspaceRoot, job.workspaceRoot)) job = save({ sessionId: previous.sessionId });
      }
      const ctx = this.channel.runner.ctx;
      const stored = job.sessionId && ctx?.sessionPersistence?.stat ? await ctx.sessionPersistence.stat(job.sessionId, { signal: controller.signal }) : null;
      if (stored && !sameDirectory(stored.header.cwd ?? '', job.workspaceRoot)) {
        for (;;) {
          this.assertAllowed(job, controller.signal);
          try {
            const migrated = await migrateWorkProjectSession(ctx, this.store, job.sessionId, cwd, job.workspaceRoot, controller.signal);
            job = this.store.get(id);
            if (migrated.sessionId !== job.sessionId) job = save({ sessionId: migrated.sessionId });
            break;
          } catch (error) {
            if (error?.code !== 'WORK_SESSION_BUSY') throw error;
            await delay(100, undefined, { signal: controller.signal });
          }
        }
      }
      job = save({ state: 'running', startedAt: this.channel.now() });
      progress = active.progress = new WorkProgressReporter(this, id, controller.signal);
      const result = await this.runner.run({ request: job.request, cwd, workspaceRoot: job.workspaceRoot, sessionId: job.sessionId, signal: controller.signal, limits, connectionAccess: job.connectionAccess === true,
        presentation: workPresentation(this.channel,job),
        ...(job.imageRequest ? { imageRequest: structuredClone(job.imageRequest) } : {}),
        imageGeneration: this.imageGeneration,
        memoryTools: [personRoleCardTool(this.channel, { ...job, requestedAt: job.requestedAt ?? job.createdAt },
          () => this.assertAllowed(job, controller.signal)),
          ...(this.chatSnapshots.has(job.id) ? [workConversationMemoryTool(this.channel, job, this.chatSnapshots.get(job.id),
            () => this.assertAllowed(job, controller.signal))] : [])],
        imageMemoryTools: ['generated'].map(collection =>
          imageMemoryTool(this.channel.imageMemory, this.channel.runner,
            { ...job, collection, currentJobId: job.id }, () => this.assertAllowed(job, controller.signal),
            { maxTime: job.requestedAt ?? job.createdAt,
              ...(collection === 'generated' ? { prepare: signal => this.generatedImages.sync(job, signal, () => this.assertAllowed(job, controller.signal),
                { before: job.requestedAt ?? job.createdAt, currentJobId: job.id }) } : {}) })),
        moments: job.connectionAccess && this.channel.moments.available(job) ? {
          subjects: this.channel.moments.subjects(job),
          read: (query, signal) => this.channel.moments.read(query, job, signal, () => this.assertAllowed(job, signal)),
          ...(this.channel.moments.imagesAvailable(job) ? { readImages: (query, signal) => this.channel.moments.readImages(query, job, signal, () => this.assertAllowed(job, signal)) } : {}),
          ...(this.channel.moments.audienceAvailable(job) ? { audience: signal => this.channel.moments.audience(job, signal, () => this.assertAllowed(job, signal)) } : {}),
          ...(this.channel.moments.writeAvailable(job) ? { write: (query, signal, operationKey) => this.channel.moments.write(query, job, job.id, signal, () => this.assertAllowed(job, signal), operationKey) } : {}),
          ...(this.channel.moments.likeRecentAvailable(job, job.request) ? { likeRecent: (query, signal) => this.channel.moments.likeRecent(query, job, job.id, job.request, signal, () => this.assertAllowed(job, signal)) } : {}),
          ...(this.channel.momentsAutomation?.publishing ? { manage: (args, signal, operationKey) => this.channel.moments.managePublishing(args, job, job.id, signal, () => this.assertAllowed(job, signal), operationKey) } : {}),
          ...(this.channel.momentsAutomation?.interactions ? { manageInteractions: (args, signal) => this.channel.moments.manageInteractions(args, job, job.id, signal, () => this.assertAllowed(job, signal)) } : {}),
        } : undefined,
        sessionManagement: { channel: this.channel, scope: job, signal: controller.signal, request: job.request,
          readDialogue: workDialogueHistory(this.channel, { record: { createdAt: job.createdAt } }, job),
          taskState: taskId => workDialogueState(this.channel, job, taskId), createdTaskCount: () => createdTaskCount,
          createTask: (request, previousId, options) => {
            if (createdTaskCount >= WORK_TURN_TASK_LIMIT) throw new ChannelError('WORK_QUEUE_FULL', '本任务最多安排八项独立工作');
            const scope = Object.fromEntries(['accountId', 'chatType', 'peerId', 'senderId', 'senderName', 'requestedAt', 'requestKey'].map(key => [key, job[key]]));
            const child = this.create(scope, request, previousId, { ...options, conversationSnapshot: this.chatSnapshots.get(job.id) }); createdTaskCount++;
            return { task: { id: child.id, request: child.request, state: child.state }, capacity: this.capacity() };
          } },
        queryStatus: job.connectionAccess ? (query, signal) => {
          const [command] = parseRemoteIntent(JSON.stringify({ queries: [query] }), job.request);
          return this.channel.remote.query(command, job, signal);
        } : undefined,
        assertAllowed: () => this.assertAllowed(job, controller.signal),
        onSession: (sessionId, { native = false } = {}) => { job = save({ sessionId, ...(native ? { nativeExecution: true } : {}) }); },
        onSessionHistory: sessionHistory => { job = save({ sessionHistory }); },
        onProgress: event => progress.observe(event),
        onBeforeTool: name => progress.observe({ kind: 'tool-start', tool: name, at: this.channel.now() }),
        onOperation: async operation => {
          const recorded = structuredClone(operation);
          if (recorded.result.text?.length > 2000) recorded.result = { ...recorded.result, text: recorded.result.text.slice(0, 2000), textTruncated: true };
          job = save({ operations: [...job.operations, { ...recorded, at: this.channel.now() }] });
          progress.observe({ kind: 'tool-result', tool: recorded.tool, at: this.channel.now(), failed: recorded.result.ok === false });
          if (recorded.result.ok && ['wechat_work_output', 'wechat_work_generate_image'].includes(recorded.tool))
            await saveImages(recorded.result.artifacts ?? []);
        } });
      await progress.stop();
      if (result.requestMetrics?.length) job = save({ requestMetrics: result.requestMetrics });
      producedResult = { text: result.text, ...(result.native ? { originalText: result.text } : {}), files: workFiles(cwd), artifacts: [] };
      const artifacts = workArtifacts([...job.operations, ...(result.artifacts?.length
        ? [{ tool: 'wechat_work_output', result: { ok: true, artifacts: result.artifacts } }] : [])]);
      producedResult.artifacts = artifacts;
      await saveImages(artifacts);
      this.assertAllowed(job, controller.signal);
      const polished = result.native ? await polishWorkResult(this.channel.runner, result.text, job.request, controller.signal,workPresentation(this.channel,job)) : { text: result.text };
      this.assertAllowed(job, controller.signal);
      job = this.store.update(id, { ...workOutcome(result.native ? '' : job.request, job.operations), finishedAt: this.channel.now(),
        ...(result.native ? { nativeExecution: true } : {}),
        result: { text: polished.text, ...(result.native ? { originalText: result.text, polish: polished.polish } : {}), files: workFiles(cwd), artifacts } });
    } catch (error) {
      if (error?.code === 'STATE_WRITE_FAILED') throw error;
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const retainedResult = producedResult ?? { text: '', files: workFiles(cwd) };
      if (!producedResult) {
        try {
          const artifacts = workArtifacts(job.operations);
          if (artifacts.length) retainedResult.artifacts = artifacts;
        } catch { /* Preserve the execution error; invalid registrations are never sent. */ }
      }
      job = this.store.update(id, { state: reason?.code === 'WORK_TIMEOUT' ? 'failed' : controller.signal.aborted || reason?.code === 'WORK_NOT_AUTHORIZED' ? 'cancelled' : 'failed', finishedAt: this.channel.now(),
        error: publicError(reason, 'DSH 工作执行失败，请查看任务记录'), result: retainedResult });
    } finally {
      await progress?.stop();
      const archives = archiveChangedWorkImages(job, cwd, imageSnapshot);
      if (archives.length) job = save({ imageArchives: mergeImageArchives(job.imageArchives, archives) });
      if (job.imageArchives?.length) await this.generatedImages.captureJob(job);
    }
    atomicBytes(workPath(cwd, `.wechat-work/${id}.md`), Buffer.from(workResult(job, cwd, { full: true })));
    if (controller.signal.aborted || job.state === 'cancelled') {
      this.store.update(id, { delivery: { state: 'suppressed', reason: '任务已停止，结果保留供查询' } }); return;
    }
    this.deliver(job, cwd);
  }
  deliver(job, cwd) {
    const controller = new AbortController();
    const pending = (async () => {
      try {
        this.assertAllowed(job, controller.signal);
        const artifacts = (job.result?.artifacts ?? []).map(value => ({ ...value, state: 'pending' }));
        this.store.update(job.id, { delivery: { state: 'pending', artifacts } });
        let content = workResult(job,cwd);
        if ((job.result?.polish?.state !== 'applied' || content !== job.result.text) && typeof this.channel.runner.polishReport === 'function')
          content = await this.channel.runner.polishReport(content,job.request,controller.signal,workPresentation(this.channel,job));
        const record = await this.channel.submitScheduled({ ...job, recordKey: `work-result-${job.id}`, workJobId: job.id,
          source: 'work', kind: 'message', workStyled: true, content }, controller.signal);
        const mediaParts = (record.deliveryParts ?? []).filter(value => value.type !== 'text');
        const deliveries = artifacts.map((value, index) => {
          const part = mediaParts[index], matched = part?.name === value.name && part.sha256 === value.sha256 && part.type === value.kind && part.bytes === value.bytes;
          const acknowledged = matched && part.state === 'acknowledged' && typeof part.serverMessageId === 'string' && part.serverMessageId && part.serverMessageId !== '0' &&
            record.acknowledgedMessageIds?.includes(part.serverMessageId) && mediaParts.filter(value => value.state === 'acknowledged' && value.serverMessageId === part.serverMessageId).length === 1;
          let state = 'failed';
          if (acknowledged) state = 'sent';
          else if (matched && part.state === 'not-sent') state = 'not-sent';
          else if (matched && ['acknowledged', 'unknown'].includes(part.state) || ['unknown', 'partial'].includes(record.state)) state = 'unknown';
          else if (record.state === 'cancelled') state = 'suppressed';
          return { ...value, state, ...(state === 'sent' ? { serverMessageId: part.serverMessageId, sentAt: record.sentAt ?? record.acknowledgedAt ?? record.updatedAt ?? this.channel.now() } : {}) };
        });
        this.store.update(job.id, { delivery: { state: record.state === 'sent' ? 'sent' : record.state === 'partial' ? 'partial' :
          record.state === 'unknown' ? 'unknown' : record.state === 'cancelled' ? 'suppressed' : 'failed', recordKey: record.key,
          acknowledgedMessageIds: record.acknowledgedMessageIds ?? [], deliveryParts: record.deliveryParts ?? [], artifacts: deliveries, reason: record.reason ?? '' } });
        await this.generatedImages.captureJob(this.store.get(job.id));
      } catch (error) {
        if (error?.code === 'STATE_WRITE_FAILED') throw error;
        this.store.update(job.id, { delivery: { state: 'suppressed', reason: publicError(error, '工作结果未回传，请查询任务').message } });
      }
    })().catch(error => this.channel.fail(error)).finally(() => { this.deliveries.delete(job.id); this.notify(); this.drain(); });
    this.deliveries.set(job.id, { job, controller, pending });
  }
  retryDelivery(id, scope, options) { return retryWorkDelivery(this, id, scope, options); }
  prepareArtifacts(id, scope, signal, retryId) {
    const job = this.owned(id, scope); this.assertAllowed(job, signal, { retryId });
    const cwd = taskDirectory(this.channel.store, job.folder);
    const prepared = (retryId ? retryArtifacts(job, retryId) : job.result?.artifacts ?? []).map(value => readWorkArtifact(cwd, value.path, value));
    this.assertAllowed(job, signal, { retryId }); return prepared;
  }
  sending(id, retryId) {
    const job = this.store.get(id);
    if (retryId) {
      retryArtifacts(job, retryId);
      this.store.update(id, { delivery: { ...job.delivery, state: 'sending',
        retryAttempts: job.delivery.retryAttempts.map(value => value.id === retryId ? { ...value, state: 'sending' } : value) } });
    } else this.store.update(id, { delivery: { ...job.delivery, state: 'sending', recordKey: `work-result-${id}` } });
  }
  cancel(id, scope) {
    const job = this.owned(id, scope);
    if (this.active.has(id)) this.active.get(id).controller.abort(new ChannelError('WORK_CANCELLED', '用户取消了工作任务，已生成文件保留'));
    else if (job.state === 'queued') {
      this.pending = this.pending.filter(value => value !== id);
      this.held.delete(id);
      this.chatSnapshots.delete(id);
      const cancelled = this.store.update(id, { state: 'cancelled', delivery: { state: 'suppressed', reason: '用户取消，未执行' } });
      this.notify(); this.drain(); return cancelled;
    }
    this.deliveries.get(id)?.controller.abort(new ChannelError('WORK_CANCELLED', '用户取消了工作结果回传'));
    return this.store.get(id);
  }
  cancelAll(reason, scope) {
    for (const job of this.store.list(scope).filter(job => ['queued', 'running'].includes(job.state))) this.cancel(job.id, scope);
    for (const delivery of this.deliveries.values()) if (matches(delivery.job, scope)) delivery.controller.abort(new ChannelError('WORK_CANCELLED', reason));
  }
  async whenIdle(scope) {
    this.drain();
    for (;;) {
      const active = [...this.active.values()].filter(value => matches(value.job, scope));
      const queued = this.pending.some(id => matches(this.store.get(id), scope));
      const deliveries = [...this.deliveries.values()].filter(value => matches(value.job, scope));
      if (!active.length && !queued && !deliveries.length) return;
      await Promise.race([this.changed.promise, ...active.map(value => value.finished), ...deliveries.map(value => value.pending)]);
    }
  }
  async close() { this.closed = true; this.cancelAll('应用停止，未自动重放任务'); await this.whenIdle(); this.chatSnapshots.clear(); }
}
