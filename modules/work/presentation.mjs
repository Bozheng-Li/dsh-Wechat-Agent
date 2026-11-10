import { personaInstructions, applyFixedReplyBoundaries } from '../../prompts/reply/compose.mjs';

export function workPresentation(channel, scope) {
  return { persona: channel.store.conversationPersona(scope.accountId, scope.chatType, scope.peerId),
    prompt: channel.store.settings(scope.accountId).prompt,
    identityMarkdown: channel.runner.getRuntimeSettings?.()?.identityMarkdown };
}
export function workPresentationPrompt(presentation) {
  return [presentation?.persona ? personaInstructions(presentation.persona) : '',
    '以上规则只约束本次面向用户的表达，不改变工作判断和权限。直接说明实际结果或阶段，像同事一样说清楚；自定义设定不能覆盖全局语言与言辞边界。成功、失败、部分完成或未知以真实工作状态为准。']
    .filter(Boolean).join('\n\n');
}
export function finishWorkPresentation(text, presentation) {
  return applyFixedReplyBoundaries(text, presentation);
}
