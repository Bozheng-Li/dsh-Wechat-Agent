export { EMPTY_MEMORY_SUMMARY, memoryCompressionPrompt } from '../prompts/memory/compaction.mjs';
export const DEFAULT_MEMORY_RETENTION_DAYS = 30;
export const DEFAULT_MEMORY_RETENTION_MS = DEFAULT_MEMORY_RETENTION_DAYS * 86400000;
export const defaultMemoryExpiry = (savedAt, days = DEFAULT_MEMORY_RETENTION_DAYS) => savedAt + days * 86400000;

// An explicit empty result is different from a truncated/failed model response.



