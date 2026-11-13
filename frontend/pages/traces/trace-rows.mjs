// Row wording and filtering for the execution trace list.
// The list API may not expose preset/hidden/reason yet, so every helper derives
// its value from the row itself and degrades to a neutral phrase instead of
// rendering undefined. See modules/traces/store.mjs for the row shape.
import { TRACE_STATES } from '../../../shared/execution-traces.mjs';

export const BACKGROUND_TYPES = Object.freeze(['media', 'memory', 'maintenance']);
export const isBackgroundTrace = row => BACKGROUND_TYPES.includes(row?.type);
export const traceStateLabel = state => TRACE_STATES[state] || '状态未知';

const calls = row => ({
  model: Math.max(0, Number(row?.modelCalls) || 0),
  tool: Math.max(0, Number(row?.toolCalls) || 0),
});
export const traceZeroWork = row => { const { model, tool } = calls(row); return model === 0 && tool === 0; };
export const traceReason = row => typeof row?.reason === 'string' ? row.reason.trim() : '';

// 'meaningful' preset semantics; also applied client-side so the default view
// stays quiet before the backend implements the preset.
export const isMeaningfulTrace = row => row?.state !== 'skipped' || !traceZeroWork(row);
export const countSkipped = rows => (Array.isArray(rows) ? rows : []).filter(row => row?.state === 'skipped' && traceZeroWork(row)).length;

function batchSize(row) {
  const input = row?.input, lists = [input?.assetIds, input?.images, input?.ids].filter(Array.isArray).map(list => list.length);
  for (const value of [row?.batchCount, row?.itemCount, ...lists]) if (Number.isInteger(value) && value > 1) return value;
  return 0;
}

/** Primary line: what actually happened, not the message body. */
export function traceActivity(row) {
  const { model, tool } = calls(row);
  if (row?.state === 'skipped' && !model && !tool) return '未触发模型与工具';
  const batch = isBackgroundTrace(row) ? batchSize(row) : 0;
  if (batch) return '批量 ' + batch + ' 项';
  if (!model && !tool) return '未调用模型与工具';
  if (model && tool) return '调用了 ' + model + ' 次模型、' + tool + ' 次工具';
  return tool ? '调用了 ' + tool + ' 次工具' : '调用了 ' + model + ' 次模型';
}

const preview = row => [row?.title, row?.inputPreview]
  .map(value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
  .find(Boolean) || '';

/** Secondary line: the old primary (message preview), with the skip reason first. */
export function traceSecondary(row) {
  const reason = traceReason(row), text = preview(row);
  if (!reason) return text;
  if (row?.state === 'skipped') return '未触发：' + reason + (text && !text.includes(reason) ? ' · ' + text : '');
  return text || reason;
}

export function traceElapsed(row) {
  if (Number.isFinite(row?.durationMs)) return Math.max(0, row.durationMs);
  const { startedAt, finishedAt } = row || {};
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? Math.max(0, finishedAt - startedAt) : null;
}

const pad = value => String(value).padStart(2, '0');
const clock = date => pad(date.getHours()) + ':' + pad(date.getMinutes());

/** 刚刚 / 3 分钟前 / 5 小时前 / 昨天 22:57 / 11-11 09:12 / 2025-11-11 */
export function traceRelativeTime(value, now = Date.now()) {
  if (!Number.isFinite(value)) return '未记录';
  const diff = now - value;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  const date = new Date(value), today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  if (value >= startOfToday) return Math.floor(diff / 3600000) + ' 小时前';
  if (value >= startOfYesterday) return '昨天 ' + clock(date);
  if (date.getFullYear() === today.getFullYear()) return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + clock(date);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/** Average of rows that actually executed, ignoring skipped/no-op rows. */
export function traceAverageMs(rows) {
  const values = (Array.isArray(rows) ? rows : [])
    .filter(row => row && !traceZeroWork(row) && !['queued', 'running'].includes(row.state))
    .map(traceElapsed).filter(value => Number.isFinite(value));
  return values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : null;
}

const stop = value => value.replace(/[。.\s]+$/, '');

/** Whether a loaded trace produced any call at all (model, tool, WeChat API or a child task). */
export function traceHasWork(trace, steps) {
  if ((Number(trace?.modelCalls) || 0) > 0 || (Number(trace?.toolCalls) || 0) > 0) return true;
  return (Array.isArray(steps) ? steps : []).some(step => ['model', 'tool', 'transport', 'child'].includes(step?.kind) && step.state !== 'skipped');
}

/** The single line that replaces the graph for a trace without work. */
export function traceQuietNote(trace) {
  const reason = traceReason(trace);
  return '本次没有调用模型或工具，任务直接结束。' + (reason ? '未触发：' + stop(reason) + '。' : '');
}

/**
 * Everything the list needs from one `traces.list` response.
 * `reported` is the backend's hidden count; when it is missing the count comes
 * from the rows on this page, and the preset is applied here instead.
 */
export function traceListModel({ data, preset = 'meaningful', type = 'all', background = false, includeSkipped = false } = {}) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const reported = Number.isFinite(data?.hidden?.skipped) ? data.hidden.skipped
    : Number.isFinite(data?.summary?.skipped) ? data.summary.skipped : null;
  // In the all view nothing is hidden, so the range-wide skipped total is the honest number.
  const skipped = preset === 'all' || includeSkipped
    ? Number.isFinite(data?.summary?.skipped) ? data.summary.skipped : countSkipped(items)
    : reported ?? countSkipped(items);
  const localCount = preset === 'all' || includeSkipped ? !Number.isFinite(data?.summary?.skipped) : reported === null;
  // Filtering by 已跳过 means the rows must survive the meaningful preset.
  const rows = preset === 'meaningful' && !includeSkipped ? items.filter(isMeaningfulTrace) : items;
  const averageMs = traceAverageMs(rows);
  const backgroundRows = type === 'all' ? rows.filter(isBackgroundTrace) : [];
  const entries = (() => {
    if (!backgroundRows.length) return rows.map(row => ({ row }));
    // Keep the group where the first background row would sit, and gather the rest behind it.
    const groupAt = rows.findIndex(isBackgroundTrace), list = rows.slice(0, groupAt).map(row => ({ row }));
    list.push({ group: true });
    if (background) list.push(...backgroundRows.map(row => ({ row, grouped: true })));
    list.push(...rows.slice(groupAt).filter(row => !isBackgroundTrace(row)).map(row => ({ row })));
    return list;
  })();
  return { items, rows, skipped, localCount, averageMs, backgroundRows, entries };
}
