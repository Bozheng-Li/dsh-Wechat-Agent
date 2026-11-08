import { publicText } from '../../wechat/ai/public-output.ts';
import { ChannelError } from '../../shared/contracts.mjs';

export function completedText(events, allowEmpty = false, selectReplyText) {
  const end = events.findLast((event) => event.type === 'turn/end');
  if (end?.data?.reason?.kind !== 'completed') {
    const reason = end?.data?.reason?.kind;
    const failureCode = end?.data?.reason?.error?.code;
    const failureMessage =
      reason === 'error' && failureCode === 'TRANSPORT'
        ? '模型请求传输失败，未使用不完整的输出，请稍后重试'
        : reason === 'error' && failureCode === 'TIMEOUT'
          ? '模型请求超时，未使用不完整的输出，请稍后重试'
          : reason === 'error' && failureCode === 'ACCOUNT_QUOTA'
            ? '模型账号余额或额度不足，请在 DSH 检查当前模型账号；未发送不完整回复'
            : reason === 'error' && failureCode === 'QUOTA'
              ? '模型服务的请求额度或调用频率已达上限，请等待恢复或在 DSH 检查配额；未发送回复'
            : reason === 'error' && failureCode === 'INVALID_REQUEST'
              ? '模型拒绝了请求参数，请检查所选模型的推理强度、温度及输出设置；未发送回复'
            : 'DSH 模型任务未完成，请在 DSH 检查模型连接；未发送回复';
    throw new ChannelError(
      'MODEL_INCOMPLETE',
      reason === 'max-tokens'
        ? '模型达到输出上限，未发送不完整的回复'
        : reason === 'aborted'
          ? '模型任务已取消，未发送回复'
          : failureMessage
    );
  }
  const final = events.findLast((event) => event.type === 'assistant/message' && event.data?.turn === end.data.turn);
  const blocks = final?.data?.message?.content;
  if (!Array.isArray(blocks) || blocks.some((block) => block.type === 'tool-call'))
    throw new ChannelError('MODEL_EMPTY', '模型没有返回可发送的最终正文');
  const raw = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  // Media selection may supply a caption or intentionally omit text. Validate
  // and review the actual delivery, not the model's unused tool commentary.
  const selected = typeof selectReplyText === 'function' ? selectReplyText(raw) : raw;
  if (typeof selected !== 'string') throw new ChannelError('MODEL_EMPTY', '模型没有返回可发送的最终正文');
  const text = publicText(selected);
  if (!text && !allowEmpty) throw new ChannelError('MODEL_EMPTY', '模型没有返回可发送的最终正文');
  // The provider owns the output budget. The WeChat transport segments complete
  // text and accounts for each ACK; an input/context bound must not reject it.
  return text;
}
