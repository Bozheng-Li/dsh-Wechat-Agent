import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { MOMENTS_SUBJECT_SCHEMA, momentsSubjectInstructions } from '../../shared/moments-subject.mjs';
export { isMomentsLikeRequest } from '../../shared/moments-like-request.mjs';

export function momentsLikeRequestTool({ like, subjects, assertAllowed = () => {}, onOperation }) {
  return { name: 'wechat_moments_like_recent',
    description: '响应当前发言者明确的朋友圈点赞请求，先按语境确定动态作者，读取该主页，再给最新 1–5 条动态点赞。' + momentsSubjectInstructions(subjects) + '普通会话只能选择发起人本人；已授权远程管理员可指定机器人账号或其他好友。未指定数量时省略 count；已赞占原位置，不顺延给旧动态补赞。最新几条求赞优先用本工具，不让朋友找动态编号；若管理员要求随机挑选或批量评论，改用本轮提供的 wechat_moments_interact，不能把随机改为最新。只有当前消息的明确请求可执行；历史或引用仅用于解析指代，本身不授权。只按每条微信回执报告完成，未知停止，不改目标或重复请求补点；返回不含最新总数时不得自行加一。',
    parameters: { type: 'object', properties: {
      subject: MOMENTS_SUBJECT_SCHEMA,
      user: { type: 'string', minLength: 1, maxLength: 150, description: 'contact 时填写已按上下文确认的准确昵称、备注或微信 ID；speaker/account 时省略。不填“我/你/他/她”。' },
      count: { type: 'integer', minimum: 1, maximum: 5, description: '只填当前用户明确要求的最新动态数；未说明时省略，由服务处理最新一条，不扩展范围。' },
    }, required: ['subject'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async (args, execution) => {
      assertAllowed(); execution.signal?.throwIfAborted(); let result;
      try {
        if (!args || !['speaker', 'account', 'contact'].includes(args.subject))
          throw new ChannelError('MOMENTS_SUBJECT_REQUIRED', '请先根据当前原话与上下文明确选择 subject，再请求点赞；未默认选取任何主页');
        result = await like(args, execution.signal);
      }
      catch (error) { execution.signal?.throwIfAborted(); assertAllowed(); result = { ok: false, ...publicError(error, '朋友圈点赞没有完成，未报告成功') }; }
      assertAllowed(); execution.signal?.throwIfAborted();
      await onOperation?.({ tool: 'wechat_moments_like_recent', result });
      return JSON.stringify(result);
    } };
}
