import { randomUUID } from 'node:crypto';
import { publicText, wechatReplyInstructions } from './wechat/ai/public-output.ts';
import { ChannelError, MAX_TEXT } from './contracts.mjs';
import { availableModel } from './models.mjs';

export function completedText(events) {
  const end = events.findLast(event => event.type === 'turn/end');
  if (end?.data?.reason?.kind !== 'completed') {
    const reason = end?.data?.reason?.kind;
    throw new ChannelError('MODEL_INCOMPLETE', reason === 'max-tokens' ? '模型达到输出上限，未发送不完整的回复' : reason === 'aborted' ? '模型任务已取消，未发送回复' : 'DSH 模型任务未完成，请在 DSH 检查模型连接；未发送回复');
  }
  const final = events.findLast(event => event.type === 'assistant/message' && event.data?.turn === end.data.turn);
  const blocks = final?.data?.message?.content;
  if (!Array.isArray(blocks) || blocks.some(block => block.type === 'tool-call'))
    throw new ChannelError('MODEL_EMPTY', '模型没有返回可发送的最终正文');
  const text = publicText(blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join(''));
  if (!text) throw new ChannelError('MODEL_EMPTY', '模型没有返回可发送的最终正文');
  if (text.length > MAX_TEXT) throw new ChannelError('MODEL_TOO_LONG', '回复过长，未自动拆成大量微信消息');
  return text;
}

export class DshAgentRunner {
  constructor(ctx, getModelChoice = () => null) { this.ctx = ctx; this.getModelChoice = getModelChoice; }
  defaultSelection() {
    const selection = this.ctx.agentDefaultModel.currentSelection();
    if (!selection?.provider || !selection?.model) throw new ChannelError('MODEL_MISSING', '请先在 DSH 中选择可用的模型');
    return selection;
  }
  selection() { return this.getModelChoice() ?? this.defaultSelection(); }
  async run({ text, group, prompt, sessionId, signal, onSession }) {
    signal.throwIfAborted();
    // Capture once: picker/default changes apply to the next queued task,
    // without interrupting or silently rerouting the task already underway.
    const chosen = this.getModelChoice();
    const selected = chosen ?? this.defaultSelection();
    if (chosen) await availableModel(this.ctx, chosen, signal);
    const agentOptions = { ...selected, maxTokens: 4096 };
    const setup = (ctx) => {
      // Do not load the desktop/coding preset or grant host tools to WeChat.
      ctx.tools.restrict({ allow: [] });
      ctx.tools.guard(() => '微信插件预览版只提供文本对话，不执行桌面或文件工具');
      ctx.systemPrompt.suppressRuntimeContext();
      ctx.systemPrompt.section({
        name: 'wechat-agent', order: 0, complete: true, interpolate: false,
        text: `你是在微信中与用户对话的助手。${wechatReplyInstructions(group)}\n你只能根据对话中的文字作答，没有文件、图片、联网查询或操作电脑能力；不声称已执行这些操作。${prompt ? `\n账号管理员的回复要求：\n${prompt}` : ''}`
      });
    };
    signal.throwIfAborted();
    const id = sessionId || randomUUID();
    let handle;
    try {
      handle = sessionId
        ? await this.ctx.agents.resume({ resumeSessionId: id, agentOptions, setup, signal })
        : await this.ctx.agents.create({ sessionId: id, agentOptions, setup, signal });
      signal.throwIfAborted();
      await onSession?.(id);
      const agent = handle.agent;
      const from = agent.session.seq;
      const cancel = () => agent.cancel({ kind: 'user' });
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        // Same wire contract as dsh-llm.createUserMessage; no private DSH SDK
        // dependency is bundled, so the host owns every Cordis service.
        agent.followup(Object.freeze({
          id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
          source: { kind: 'wechat-agent' }
        }));
        await agent.whenIdle();
        signal.throwIfAborted();
        return { text: completedText(agent.session.snapshotEvents(from)), sessionId: id };
      } finally { signal.removeEventListener('abort', cancel); }
    } catch (error) {
      if (signal.aborted || error instanceof ChannelError) throw error;
      throw new ChannelError('DSH_AGENT_FAILED', 'DSH 会话未能完成，请检查模型配置或在 DSH 查看会话；未发送微信回复');
    } finally {
      if (handle) {
        handle.agent.cancel({ kind: 'disposed' });
        await handle.agent.whenIdle();
        await handle.dispose();
      }
    }
  }
}
