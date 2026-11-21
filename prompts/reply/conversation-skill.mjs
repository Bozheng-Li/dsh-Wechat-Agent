import { readPrompt } from '../loader.mjs';

/** Server-side loading stays outside the browser-safe persona catalog tree. */
export const NATURAL_CONVERSATION_SKILL = readPrompt('personas/conversation-skill.md');
