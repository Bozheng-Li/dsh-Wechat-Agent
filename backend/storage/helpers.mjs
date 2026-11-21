import { emptyPersona, validateConversationSettings, DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_URL } from "../../shared/contracts.mjs";

export const defaults = {
  persona: emptyPersona,
  model: () => ({
    maxTokens: null,
    temperature: null,
    vision: true,
    visionModel: null,
    webSearch: false,
    searchProvider: 'tavily',
    tavilyBaseURL: 'https://api.tavily.com',
    deepseekBaseURL: DEFAULT_DEEPSEEK_URL,
    deepseekModel: DEFAULT_DEEPSEEK_MODEL,
  }),
  conversation: () =>
    validateConversationSettings({ mode: 'default', minMessages: 5, maxMessages: 20, recordsPath: '' }),
};
export const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export const pendingStates = new Set(['queued', 'generating', 'sending']);
export const historyLimit = 1000;
export const clone = (value) => structuredClone(value);
