import { factualSearchInstructions } from '../../prompts/agent/factual-search.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ChannelError } from '../../shared/contracts.mjs';
import { completedText } from '../agent/output.mjs';
import { workModelTools, registerModelTools } from '../tools/index.mjs';
import { createWorkConnections } from './connections.mjs';
import { registerAgentWorkspace } from '../agent/workspace.mjs';
import { publishWorkSessionHistory } from './session-history.mjs';
import { nativeWorkFileSnapshot, nativeWorkArtifacts, workArtifacts } from './artifacts.mjs';
import { sameDirectory } from '../../backend/storage/paths.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { observeWorkProgress } from './progress.mjs';
import { workPresentationPrompt } from './presentation.mjs';
import { publicLanguageInstructions } from '../../prompts/reply/language.mjs';
import { planProgressiveTools } from '../tools/progressive.mjs';
import { observeModelRequests } from '../agent/request-metrics.mjs';

async function waitForIdle(agent, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([agent.whenIdle(), cancelled]); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Native DSH agent, scoped separately from the chat runner and its sessions. */
export class DshWorkRunner {
  constructor(chatRunner) { this.chatRunner = chatRunner; this.ctx = chatRunner.ctx; }
  async run({ request, cwd, workspaceRoot, sessionId, signal, limits, connectionAccess = false, queryStatus, imageGeneration, imageRequest, imageMemoryTools, memoryTools, sessionManagement, moments, assertAllowed, onSession, onSessionHistory, onOperation, onProgress, onBeforeTool, presentation }) {
    const sessionCwd = path.resolve(workspaceRoot ?? cwd);
    // Work is a native DSH submission. Chat model, persona and output controls
    // belong to the chat API and must not replace the desktop's work preset.
    const agentOptions = structuredClone(this.ctx.agentDefaultModel?.currentSelection?.() ?? this.chatRunner.defaultSelection());
    const modelConfig = structuredClone(this.chatRunner.getRuntimeSettings?.()?.modelConfig ?? {});
    const promptStrategy = modelConfig.promptStrategy ?? 'legacy';
    const requestMetrics = [];
    let handle, borrowed = false;
    const toolDisposers = [];
    const operations = [], recordOperation = async operation => { operations.push(structuredClone(operation)); await onOperation(operation); };
    const presets = this.ctx.get?.('agentPresets') ?? this.ctx.agentPresets;
    const setup = async (ctx, agent) => {
      const style = publicLanguageInstructions() + '\n\n' + workPresentationPrompt(presentation) + (memoryTools?.length
        ? '\n任务要求根据微信聊天、对方偏好或彼此印象制作成果时，先用 wechat_memory 按需核对聊天依据；原生工作历史不等于微信聊天。按指定画风画人时区分画风与原作角色；没有外貌依据的画像是创作想象，不能声称还原了对方真实长相。' : '');
      if (style && ctx.systemPrompt?.section) {
        const dispose = ctx.systemPrompt.section({ name:'wechat-work-presentation',order:100,interpolate:false,
          text: style+'\n人设仅约束本次与你对话的文字、操作说明与进度回报，不改变工具权限和执行判断。文档、代码及其他成果按用户任务要求制作，不加入角色表演或虚构事实。' });
        if (typeof dispose === 'function') toolDisposers.push(dispose);
      }
      // DSH presets can isolate shell from the global service realm. Bind the
      // Agent explicitly, then query its retained composition through the SDK.
      if (presets?.mount) {
        const presetId = ctx.get?.('sessionProjections')?.stateOf(agent.session, 'agentPreset') ?? agent.session.header.agentPreset;
        if (!presets.composedPreset?.(ctx)) await presets.mount(ctx, presetId ?? undefined);
      }
      const policy = presets?.serviceFor?.(agent, 'sandboxPolicy') ?? ctx.get?.('sandboxPolicy') ?? ctx.sandboxPolicy;
      const resolvePolicy = () => {
        if (!policy?.resolve) throw new ChannelError('WORK_PERMISSION_UNAVAILABLE', 'DSH 会话权限策略不可用，未执行文件或命令操作');
        return policy.resolve({ session: agent.session });
      };
      const definitions = workModelTools({ surface: 'native', cwd, request, shell: presets?.serviceFor?.(agent, 'shell') ?? ctx.get?.('shell') ?? ctx.shell, resolvePolicy, limits, assertAllowed, onOperation: recordOperation, imageGeneration, imageRequest, imageMemoryTools, memoryTools, sessionManagement,
        queryStatus: connectionAccess ? queryStatus : undefined, moments: connectionAccess ? moments : undefined,
        connections: connectionAccess ? createWorkConnections({ cwd, request, assertAllowed, commandTimeoutMs: limits.commandTimeoutSeconds * 1000 }) : undefined });
      if (modelConfig.webSearch && !imageRequest && typeof this.chatRunner.searchTool === 'function') {
        // Keep the desktop's single-provider search from bypassing this turn's
        // explicit plugin routing. This restriction is local and disposed below.
        if (ctx.tools.get?.('web_search')) {
          const stopHostSearch = ctx.tools.restrict?.({ deny: ['web_search'] });
          if (typeof stopHostSearch === 'function') toolDisposers.push(stopHostSearch);
        }
        // Preset-local tools cannot be hidden with a global-tool restriction.
        const guardHostSearch = ctx.tools.guard?.(execution => execution.name === 'web_search'
          ? '此微信工作任务请使用 wechat_web_search，它按插件设置检索并在失败时回退。' : undefined);
        if (typeof guardHostSearch === 'function') toolDisposers.push(guardHostSearch);
        const search = this.chatRunner.searchTool(modelConfig, { assertAllowed });
        definitions.push({ ...search, execute: async (args, execution) => {
          const value = await search.execute(args, execution);
          await recordOperation({ tool: search.name, result: JSON.parse(value) });
          return value;
        } });
        const dispose = ctx.systemPrompt?.section?.({ name: 'wechat-factual-search', order: 80, interpolate: false,
          text: factualSearchInstructions(true, true) });
        if (typeof dispose === 'function') toolDisposers.push(dispose);
      }
      const plan = promptStrategy === 'progressive-v1' ? planProgressiveTools(definitions, request) : { initial: definitions, deferredGroups: [] };
      registerModelTools(ctx, plan.initial, { deferredGroups: plan.deferredGroups, assertAllowed, onBeforeTool, native: true, inherit: true, agent,
        onDispose: disposer => toolDisposers.push(disposer) });
      const stopMetrics = observeModelRequests(ctx, { strategy: promptStrategy, mode: 'work', rows: requestMetrics });
      if (typeof stopMetrics === 'function') toolDisposers.push(stopMetrics);
    };
    const id = sessionId || randomUUID();
    try {
      assertAllowed(); signal.throwIfAborted();
      // The immutable header identifies the shared project. Native DSH's
      // working-directory projection keeps execution in this task's folder.
      const workspace = await registerAgentWorkspace(this.ctx, sessionCwd, 'work');
      const create = () => this.ctx.agents.create({ sessionId: id, agentOptions, setup, signal,
        meta: { cwd: sessionCwd, ...(presets?.defaultId ? { agentPreset: presets.defaultId } : {}) } });
      if (!sessionId) handle = await create();
      else for (;;) {
        assertAllowed(); signal.throwIfAborted();
        const existing = this.ctx.agents.get?.(id);
        if (existing) {
          await waitForIdle(existing, signal);
          if (this.ctx.agents.get?.(id) !== existing) continue;
          if (existing.status === 'running' || existing.inbox?.hasPending || existing.inbox?.size > 0) continue;
          if (!sameDirectory(existing.session.header?.cwd ?? '', sessionCwd))
            throw new ChannelError('WORK_CWD_CHANGED', '原 DSH 会话尚未归并到微信工作项目，未另建空会话');
          handle = { agent: existing }; borrowed = true;
          break;
        }
        try { handle = await this.ctx.agents.resume({ resumeSessionId: id, agentOptions, setup, signal }); break; }
        catch (error) {
          if (error?.name !== 'SessionAlreadyOwnedError') throw error;
          // A writer may be opening or closing. Wait for its public Agent or
          // for the original writer to be released; keep the exact session ID.
          await delay(100, undefined, { signal });
        }
      }
      const agent = handle.agent;
      let submitted = false, from, beforeFiles, stopProgress;
      const cancel = () => { if (submitted) agent.cancel({ kind: 'user' }, { keepInbox: true }); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const submit = async () => {
          assertAllowed(); signal.throwIfAborted();
          if (borrowed) await setup(agent.ctx, agent);
          if (!sameDirectory(agent.session.header?.cwd ?? '', sessionCwd))
            throw new ChannelError('WORK_CWD_CHANGED', 'DSH 会话的项目归属与微信工作项目不一致，未执行');
          const workingDirectory = presets?.serviceFor?.(agent, 'workingDirectory') ?? agent.ctx?.get?.('workingDirectory') ?? this.ctx.get?.('workingDirectory');
          if (!sameDirectory(cwd, sessionCwd) && !workingDirectory?.ensure)
            throw new ChannelError('WORK_CWD_UNAVAILABLE', 'DSH 无法设置此会话的任务执行目录，未提交命令');
          if (!sessionId && workingDirectory && !sameDirectory(workingDirectory.get(agent.session), cwd))
            agent.session.append('working-directory/change', { cwd: path.resolve(cwd) });
          if (workingDirectory?.ensure) {
            const effectiveCwd = await workingDirectory.ensure(agent, signal);
            if (!sessionId && !sameDirectory(effectiveCwd, cwd))
              throw new ChannelError('WORK_CWD_CHANGED', 'DSH 未能保持任务执行目录，未提交命令');
          }
          await workspace?.attachSession(id);
          await onSession(id, { native: true });
          from = agent.session.seq; beforeFiles = nativeWorkFileSnapshot(cwd);
          if (!sessionId) {
            let titles;
            try { titles = agent.ctx?.get?.('sessionTitle') ?? agent.ctx?.sessionTitle; } catch {}
            if (titles?.rename) await titles.rename(agent.session, '微信工作 · ' + request.replace(/\s+/g, ' ').slice(0, 65));
          }
          assertAllowed(); signal.throwIfAborted();
          stopProgress = observeWorkProgress(this.ctx, agent, onProgress);
          agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: request }], source: { kind: 'user' } }));
          submitted = true;
        };
        if (borrowed && agent.runMaintenance) for (;;) {
          await waitForIdle(agent, signal);
          let entered = false;
          try { await agent.runMaintenance(async () => { entered = true; await submit(); }); break; }
          catch (error) {
            if (entered || this.ctx.agents.get?.(id) !== agent) throw error;
            // Another desktop turn won the idle boundary. No tools or message
            // were installed; wait and retry the same public maintenance gate.
            await delay(25, undefined, { signal });
          }
        }
        else await submit();
        await agent.whenIdle(); signal.throwIfAborted(); assertAllowed();
        const text = completedText(agent.session.snapshotEvents(from));
        const artifacts = workArtifacts(operations).length ? [] : nativeWorkArtifacts(cwd, text, beforeFiles);
        return { text, sessionId: id, native: true, artifacts, requestMetrics };
      } finally { stopProgress?.(); signal.removeEventListener('abort', cancel); }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ChannelError) throw new ChannelError(error.code, error.message.replace(/；未发送回复$/, ''));
      throw new ChannelError('WORK_AGENT_FAILED', 'DSH 工作会话未完成，请查看任务状态或 DSH 会话；未将其标记为完成');
    } finally {
      if (handle) {
        if (!borrowed) handle.agent.cancel({ kind: 'disposed' });
        await handle.agent.whenIdle();
      }
      let releaseError;
      for (const dispose of toolDisposers.reverse()) { try { await dispose(); } catch (error) { releaseError ??= error; } }
      if (handle) {
        try { if (!borrowed) await handle.dispose(); }
        finally { const history = await publishWorkSessionHistory(this.ctx, id); await onSessionHistory?.(history); }
      }
      if (releaseError) throw new ChannelError('WORK_TOOLS_RELEASE_FAILED', '本轮 DSH 工具未能完整释放，结果保留；请检查会话后继续');
    }
  }
}
