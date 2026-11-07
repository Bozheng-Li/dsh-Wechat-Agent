import { personaText, emptyNaturalSettings } from '../../shared/contracts.mjs';
import { splitLines } from './conversations.mjs';

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const personaDraft = (value = {}) => ({
  name: value.name || '微信助手',
  aliases: (value.aliases || []).join('\n'),
  prompt: personaText(value),
});

export const modelDraft = (value = {}) => ({
  maxTokens: value.maxTokens == null ? '' : String(value.maxTokens),
  temperature: value.temperature == null ? '' : String(value.temperature),
  vision: value.vision ?? true,
  visionModel: value.visionModel ?? null,
  webSearch: value.webSearch ?? false,
  searchProvider: value.searchProvider ?? 'tavily',
  tavilyBaseURL: value.tavilyBaseURL ?? 'https://api.tavily.com',
});

export const storageDraft = (value = {}) => ({ basePath: value.basePath || '' });

export const naturalNumbers = [
  'minMinutes',
  'maxMinutes',
  'fixedMinutes',
  'followupSeconds',
  'maxUnanswered',
  'minGapMinutes',
];

export const naturalDraft = (value = {}) =>
  Object.fromEntries(
    Object.entries({ ...emptyNaturalSettings(), ...value }).map(([key, field]) => [
      key,
      naturalNumbers.includes(key) ? String(field) : field,
    ])
  );

export const naturalPayload = (value) =>
  Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, naturalNumbers.includes(key) ? Number(field) : field])
  );

export const configDraft = (value = {}, defaultPersona = {}) => ({
  mode: value.mode || 'default',
  intervalMode: value.intervalMode || 'random',
  fixedMessages: String(value.fixedMessages ?? value.minMessages ?? 5),
  minMessages: String(value.minMessages ?? 5),
  maxMessages: String(value.maxMessages ?? 20),
  recordsPath: value.recordsPath || '',
  memoryMode: value.memoryMode || 'always',
  memoryWindowChars: value.memoryWindowChars == null ? '' : String(value.memoryWindowChars),
  allowChatTasks: value.allowChatTasks ?? true,
  personaMode: value.persona ? 'custom' : 'default',
  persona: personaDraft(value.persona || defaultPersona),
  natural: naturalDraft(value.natural),
});

export const configPayload = ({ personaMode, persona, ...value }) => ({
  ...value,
  natural: naturalPayload(value.natural),
  fixedMessages: Number(value.fixedMessages),
  memoryWindowChars: value.memoryWindowChars.trim() === '' ? null : Number(value.memoryWindowChars),
  minMessages: Number(value.minMessages),
  maxMessages: Number(value.maxMessages),
  recordsPath: value.recordsPath.trim(),
  persona:
    personaMode === 'custom'
      ? { name: persona.name.trim(), aliases: splitLines(persona.aliases), prompt: persona.prompt }
      : null,
});

export const modelKey = (selection) => (selection ? JSON.stringify([selection.provider, selection.model]) : '');
