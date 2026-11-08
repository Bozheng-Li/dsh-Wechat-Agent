import { explicitConversationPreference } from './reply-style.mjs';

const PREFERENCE_WINDOW_MS = 30 * 60 * 1000;

/** Carry an explicit choice only through this speaker's recent conversation.
 * Memory summaries, other members and assistant replies cannot set it. */
export function conversationPreference(request, { history = [], speaker, now = new Date() } = {}) {
  const current = explicitConversationPreference(request);
  if (current) return { value: current, source: 'current' };
  if (!speaker?.id || !Array.isArray(history)) return undefined;
  const at = Number(now);
  if (!Number.isFinite(at)) return undefined;
  for (const entry of history.slice(-20).reverse()) {
    if (entry?.direction !== 'incoming' || entry.senderId !== speaker.id) continue;
    const rawTime = Number(entry.time);
    const time = rawTime < 1e12 ? rawTime * 1000 : rawTime;
    // An incomplete or undated message might contain a later change of mind.
    if (entry.contextOmitted || !Number.isFinite(time) || time <= 0 || time > at || at - time > PREFERENCE_WINDOW_MS)
      return undefined;
    const value = explicitConversationPreference(entry.text);
    if (value) return { value, source: 'recent' };
  }
  return undefined;
}

export const CONTINUING_CHAT_REPLY_TASK = `当前发言者在刚才这段对话中明确选择了只聊天、不提建议。当前消息若仍在延续这段闲聊，就用当前角色接已知细节、感受或笑点，不因“以后还这样呢”之类的追问自动改成指导；不附带劝告、改动做法或备选安排，即使用未来猜想、关心或玩笑包装也不追加。若这条消息已经提出新的知识问题、创作任务或求助，按新请求完整回答；迫近危险仍给必要帮助。这个偏好只属于当前发言者，不代表其他群成员。`;
