import { currentTrace, traceStep } from './context.mjs';
import { measureModelRequest, numericUsage } from '../agent/request-metrics.mjs';

function toolValue(value) {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch {} }
  return value;
}

/** Capture the request that actually reaches the adapter, isolated by native session. */
export function observeExecutionSession(ctx, { sessionId, agent, selection, mode, context = currentTrace() } = {}) {
  if (!context || typeof ctx.on !== 'function' || !sessionId) return () => {};
  const disposers = [];
  disposers.push(ctx.on('llm/stream', (request, next) => {
    if (request.sessionId !== sessionId) return next();
    const step = context.store.startStep(context, { kind: 'model', title: '模型生成 · ' + (mode || '回复'),
      input: { system: request.system, messages: request.messages, tools: request.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        maxTokens: request.maxTokens, temperature: request.temperature, reasoningEffort: request.reasoningEffort },
      metadata: { sessionId, provider: request.provider || selection?.provider,
        model: typeof request.model === 'string' ? request.model : request.model?.id || selection?.model, mode, ...measureModelRequest(request) } });
    if (!step) return next();
    return (async function* () {
      const blocks = new Map(); let usage, finish, failure, finished = false;
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'text-delta') {
            const previous = blocks.get(chunk.index) || { type: 'text', text: '' };
            previous.text += chunk.text || ''; blocks.set(chunk.index, previous);
          } else if (chunk.type === 'tool-call-delta') {
            const previous = blocks.get(chunk.index) || { type: 'tool-call', id: '', name: '', arguments: '' };
            previous.id = chunk.id || previous.id; previous.name = chunk.name || previous.name;
            previous.arguments += chunk.argumentsDelta || ''; blocks.set(chunk.index, previous);
          } else if (chunk.type === 'block-end' && ['text', 'tool-call'].includes(chunk.block?.type)) blocks.set(chunk.index, chunk.block);
          const measured = numericUsage(chunk.usage ?? (chunk.type === 'usage' ? chunk : undefined)); if (measured) usage = measured;
          if (chunk.type === 'finish') { finished = true; finish = chunk.reason; }
          yield chunk;
        }
      } catch (error) { failure = error; throw error; }
      finally {
        const cancelled = request.signal?.aborted || finish?.kind === 'aborted' || !finished && !failure;
        step.end({ state: cancelled ? 'cancelled' : failure || finish?.kind === 'error' ? 'failed' : 'completed', error: failure,
          output: { content: [...blocks.values()], finishReason: finish, usage }, metadata: { usage, finishReason: finish?.kind } });
      }
    })();
  }, { prepend: true }));
  disposers.push(ctx.on('tools/execute', (execution, next) => {
    if (agent && execution.agent !== agent) return next();
    if (!agent && execution.agent?.session?.id !== sessionId) return next();
    return traceStep(execution.name || '执行工具', next, { context, kind: 'tool',
      input: toolValue(execution.arguments), output: toolValue,
      metadata: { sessionId, tool: execution.name, callId: execution.id || execution.callId } });
  }, { prepend: true }));
  return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose(); };
}
