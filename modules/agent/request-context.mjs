import { randomUUID } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";

/** Rebase only the model-visible surface before admitting a new WeChat turn.
 * The append-only native transcript stays intact. This turn's reviewed history
 * and memory arrive in its user message; all subsequent tool steps stay native. */
export function resetWechatSessionContext(session, { turn, step } = {}) {
  const nodes = session.surface?.nodes;
  if (!Array.isArray(nodes) || typeof session.deriveMessages !== 'function' || typeof session.append !== 'function')
    throw new ChannelError('MODEL_CONTEXT_INVALID', '宿主未提供会话上下文接口，未生成回复；请检查 DSH 版本');
  if (nodes.length < 2) return;
  if (session.deriveMessages()[0]?.role !== 'system' || !Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step) || step < 1)
    throw new ChannelError('MODEL_CONTEXT_INVALID', '未能确认会话的系统上下文，未生成回复；请重试当前消息');
  // DSH protects the system head. An empty system replacement is omitted by
  // deriveMessages, and shadows prior dialogue without erasing audit events.
  session.append('system/message', { turn, step, message: {
    id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' },
  } }, {
    surfaceOp: { op: 'replace', startSeq: nodes[1], endSeq: nodes.at(-1) },
    sourceEventSeqs: nodes.slice(1),
  });
}
