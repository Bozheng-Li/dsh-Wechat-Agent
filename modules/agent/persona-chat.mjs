import { ChannelError, validateGlobalPersona } from '../../shared/contracts.mjs';

/** Owner-only preview: supplied text and local chat history, with no WeChat tools or memory. */
export function personaChatInput(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string' || !payload.text.trim() ||
      payload.text.length > 6000 || !Array.isArray(payload.messages ?? []) || (payload.messages?.length ?? 0) > 30)
    throw new ChannelError('PERSONA_CHAT_INVALID', '试聊消息应为 1–6000 字，请清空过长的测试对话后重试');
  const messages = payload.messages ?? [];
  if (messages.some(row => !row || !['user', 'assistant'].includes(row.role) ||
      typeof row.content !== 'string' || !row.content.trim() || row.content.length > 24000))
    throw new ChannelError('PERSONA_CHAT_INVALID', '试聊记录格式无效，请清空对话后重试');
  const selected = []; let budget = 24000;
  for (const row of messages.slice(-12).reverse()) {
    if (row.content.length > budget) break;
    selected.unshift({ role: row.role, content: row.content }); budget -= row.content.length;
  }
  return { text: payload.text.trim(), persona: validateGlobalPersona(payload.persona), messages: selected };
}

export async function previewPersonaChat(runner, payload, signal, assertLive = () => {}) {
  const input = personaChatInput(payload), start = Date.now();
  signal.throwIfAborted(); assertLive();
  const snapshot = await runner.memoryExecutionSnapshot(signal);
  snapshot.runtime.persona = input.persona;
  snapshot.runtime.modelConfig = { ...snapshot.runtime.modelConfig, webSearch: false };
  const history = input.messages.map((row, index) => ({ direction: row.role === 'user' ? 'incoming' : 'outgoing',
    senderId: row.role === 'user' ? 'persona-preview-owner' : 'persona-preview-assistant',
    senderName: row.role === 'user' ? '管理员' : input.persona.name, text: row.content, time: start - (input.messages.length - index) * 1000 }));
  const result = await runner.run({ text: input.text, persona: input.persona, mode: 'default', history,
    tools: [], executionSnapshot: snapshot, signal, assertAllowed: () => { signal.throwIfAborted(); assertLive(); },
    speaker: { id: 'persona-preview-owner', name: '管理员' },
    account: { id: 'persona-preview-assistant', nickname: input.persona.name } });
  signal.throwIfAborted(); assertLive();
  return { text: result.text, personaMode: result.personaMode ?? input.persona.personaMode ?? 'standard',
    elapsedMs: Date.now() - start, modelCalls: result.requestMetrics?.length ?? 0 };
}
