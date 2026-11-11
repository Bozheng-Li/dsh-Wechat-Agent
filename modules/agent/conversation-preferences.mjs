import { explicitConversationPreference } from "./reply-style.mjs";

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
    if ((entry.contextTextOmitted ?? entry.contextOmitted) || !Number.isFinite(time) || time <= 0 || time > at || at - time > PREFERENCE_WINDOW_MS)
      return undefined;
    const value = explicitConversationPreference(entry.text);
    if (value) return { value, source: 'recent' };
  }
  return undefined;
}

export { CONTINUING_CHAT_REPLY_TASK } from "../../prompts/reply/rules.mjs";
