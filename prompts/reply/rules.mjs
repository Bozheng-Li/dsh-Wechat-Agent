import { readPrompt, renderPrompt } from '../loader.mjs';
export const NATURAL_REPLY_RULES = readPrompt("reply/defaults.md");
export const CURRENT_TURN_REPLY_RULES = readPrompt("reply/current-turn.md");
export const CONFIGURED_CONVERSATION_REPLY_TASK = readPrompt("reply/configured-task.md");
export const DEFAULT_CONVERSATION_REPLY_TASK = renderPrompt("reply/default-task.md", [CONFIGURED_CONVERSATION_REPLY_TASK]);
export const EXPLICIT_CHAT_REPLY_TASK = readPrompt("reply/chat-task.md");
export const CONTINUING_CHAT_REPLY_TASK = readPrompt("reply/continuing-chat.md");
