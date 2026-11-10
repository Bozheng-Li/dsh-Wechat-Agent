import { readPrompt } from '../../prompts/loader.mjs';
import { publicError, ChannelError } from '../../shared/contracts.mjs';
import { publicText } from '../../backend/wechat/ai/public-output.ts';
import { workPresentation, workPresentationPrompt, finishWorkPresentation } from './presentation.mjs';

export const WORK_PROGRESS_INTERVAL_MS = 5 * 60 * 1000;

/** Observe this exact native session without submitting work or retaining reasoning/images. */
export function observeWorkProgress(ctx, agent, onProgress = () => {}) {
  if (typeof ctx?.on !== 'function') return () => {};
  const disposers = [];
  const toolNames = new Map();
  let lastStreamAt = 0;
  disposers.push(ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return;
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? [];
      const text = publicText(blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')).slice(0,600);
      const tools = blocks.filter(block => block.type === 'tool-call').map(block => block.name).slice(0,8);
      for (const block of blocks.filter(block => block.type === 'tool-call')) toolNames.set(block.id, block.name);
      if (text || tools.length) onProgress({ kind: 'assistant', at: event.time, text, tools });
    } else if (event.type === 'tool/result') {
      // Native results can contain credentials, screenshots or long command output.
      // Only the tool identity and explicit error flag enter progress review.
      const message = event.data?.message;
      const callId = message?.toolCallId ?? message?.source?.callId;
      onProgress({ kind: 'tool-result', at: event.time, tool: toolNames.get(callId) ?? '',
        failed: message?.isError === true || Boolean(event.data?.error) });
      toolNames.delete(callId);
    }
  }));
  disposers.push(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent || frame?.type !== 'chunk' ||
        !['text-delta','reasoning-delta','tool-call-delta'].includes(frame.chunk?.type)) return;
    const now = Date.now();
    if (now - lastStreamAt >= 1000) { lastStreamAt = now; onProgress({ kind: 'model-active', at: now }); }
  }));
  return () => { for (const dispose of disposers.reverse()) dispose?.(); };
}

/** A separate, tool-free Agent reviews bounded evidence; it never follows up the working Agent. */
export async function summarizeWorkProgress(runner, evidence, signal, presentation) {
  try {
    const result = await runner.run({ mode: 'work-progress', tools: [],
      systemOverride: [readPrompt('work/progress.md'),workPresentationPrompt(presentation)].filter(Boolean).join('\n\n'), text: JSON.stringify(evidence), signal });
    signal.throwIfAborted();
    const text = publicText(result?.text ?? '').trim();
    if (!text || text.length > 200 || /```|<thinking>|\b\d+(?:\.\d+)?\s*%/.test(text))
      throw new ChannelError('WORK_PROGRESS_INVALID', '进度摘要不符合简短事实回报要求');
    return { text: finishWorkPresentation(text,presentation), review: { state: 'summarized' } };
  } catch (error) {
    signal.throwIfAborted();
    return { text: '任务尚未结束，暂时无法整理最新进度；完成后会把结果发给你。',
      review: { state: 'fallback', error: publicError(error, '进度整理暂不可用') } };
  }
}

/** One bounded review/delivery at a time, cancelled before the final result is sent. */
export class WorkProgressReporter {
  constructor(service, id, signal) {
    this.service = service; this.id = id; this.signal = signal; this.events = []; this.sequence = 0;
    this.closed = false;
    this.timer = setInterval(() => { void this.tick(); }, WORK_PROGRESS_INTERVAL_MS);
    this.timer.unref?.();
  }
  observe(event) {
    if (this.closed) return;
    this.lastActivityAt = event.at;
    if (event.kind === 'model-active') return;
    this.events.push(event); if (this.events.length > 12) this.events.shift();
  }
  tick() {
    if (this.closed || this.pending || this.signal.aborted) return this.pending;
    const { service, id } = this;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.signal, this.controller.signal, AbortSignal.timeout(30000)]);
    this.pending = (async () => {
      const job = service.store.get(id);
      if (job.state !== 'running') return;
      service.assertAllowed(job, signal);
      const sequence = ++this.sequence;
      const evidence = { request: job.request, state: job.state, elapsedSeconds: Math.floor((service.channel.now()-job.startedAt)/1000),
        lastActivityAt: this.lastActivityAt ?? null, observations: structuredClone(this.events),
        operations: job.operations.slice(-8).map(value => ({ tool: value.tool, at: value.at, ok: value.result.ok })) };
      const summary = await summarizeWorkProgress(service.channel.runner, evidence, signal,workPresentation(service.channel,job));
      signal.throwIfAborted();
      const current = service.store.get(id);
      if (this.closed || current.state !== 'running') return;
      service.assertAllowed(current, signal);
      const recordKey = `work-progress-${id}-${sequence}`;
      const record = await service.channel.submitScheduled({ ...current, recordKey, workJobId: id, workProgress: true,
        source: 'work', kind: 'message', content: summary.text }, signal);
      // Sending intent and server ACKs belong to the normal durable message record.
      // Preserve its actual outcome even if execution ended during the network write.
      service.store.update(id, { progress: { sequence, at: service.channel.now(), text: summary.text, review: summary.review,
        state: record.state, recordKey, acknowledgedMessageIds: record.acknowledgedMessageIds ?? [] } });
    })().catch(error => {
      if (error?.code === 'STATE_WRITE_FAILED') { service.channel.fail(error); return; }
      if (this.closed || this.signal.aborted) return;
      service.store.update(id, { progress: { sequence: this.sequence, at: service.channel.now(), state: 'failed',
        error: publicError(error, '本次进度检查未完成，下个周期重新查看') } });
    }).finally(() => { this.pending = undefined; this.controller = undefined; });
    return this.pending;
  }
  async stop() {
    this.closed = true; clearInterval(this.timer);
    this.controller?.abort(new ChannelError('WORK_PROGRESS_ENDED', '工作已结束，未继续发送旧进度'));
    await this.pending;
  }
}
