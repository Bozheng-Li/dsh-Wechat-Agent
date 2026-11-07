import { digest } from './store.mjs';

export const safeIds = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && id && id !== '0');
export const recordVersion = (record) =>
  digest([
    record.key,
    record.state,
    record.updatedAt,
    record.reply,
    record.replyDraft,
    record.replyMedia,
    record.acknowledgedMessageIds,
  ]);
export const modes = ['retry', 'text', 'image', 'regenerate'];
export const recoveryStates = ['failed', 'unknown', 'partial', 'cancelled'];
export const internal = (runner, text, signal, systemOverride) =>
  runner.run({ text, signal, systemOverride, mode: 'workbench' });
export const timestamp = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0;
};
