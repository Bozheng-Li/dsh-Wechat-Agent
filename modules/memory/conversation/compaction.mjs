import { createHash } from 'node:crypto';
import { ChannelError } from '../../../shared/contracts.mjs';
import { EMPTY_MEMORY_SUMMARY } from '../../../shared/memory-policy.mjs';

export const MAX_COMPRESSION_INPUT_CHARS = 16000;

function textParts(text, limit) {
  if (limit < 2) throw new ChannelError('MEMORY_COMPRESSION_FAILED', '单条记忆的来源信息过长，原文已保留');
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + limit);
    // Keep an astral character intact at a chunk boundary.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function sourceUnits(line, limit) {
  if (line.length <= limit) return [line];
  let source;
  try { source = JSON.parse(line); } catch {}
  if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.text !== 'string')
    return textParts(line, limit);
  const { text, images, ...identity } = source;
  const units = [];
  // Long individual messages remain valid JSON with their original speaker,
  // timestamp and direction repeated on every fragment. Nothing is truncated.
  const base = { ...identity, text: '', fragment: true };
  const budget = Math.floor((limit - JSON.stringify(base).length) / 6);
  for (const part of textParts(text, budget)) units.push(JSON.stringify({ ...base, text: part }));
  for (const image of images ?? []) {
    const imageBase = { ...base, images: [{ ...image, description: '' }] };
    const imageBudget = Math.floor((limit - JSON.stringify(imageBase).length) / 6);
    const descriptions = image.description ? textParts(image.description, imageBudget) : [''];
    for (const description of descriptions)
      units.push(JSON.stringify({ ...base, images: [{ ...image, description }] }));
  }
  if (!units.length) units.push(JSON.stringify(base));
  if (units.some(unit => unit.length > limit))
    throw new ChannelError('MEMORY_COMPRESSION_FAILED', '单条记忆的来源信息过长，原文已保留');
  return units;
}

export function compressionBatches(material, limit = MAX_COMPRESSION_INPUT_CHARS) {
  if (material.length <= limit) return [material];
  const batches = [];
  let batch = '';
  for (const unit of material.split('\n').flatMap(line => sourceUnits(line, limit))) {
    if (batch && batch.length + unit.length + 1 > limit) {
      batches.push(batch);
      batch = '';
    }
    batch += (batch ? '\n' : '') + unit;
  }
  if (batch) batches.push(batch);
  return batches;
}

async function candidate(material, maximum, runner, signal, context) {
  let target = Math.min(maximum, Math.max(100, Math.floor(maximum * 0.65))), observedChars;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const summary = await runner.summarize(material, target, signal, { ...context, attempt, observedChars, maximum });
    signal.throwIfAborted();
    if (typeof summary === 'string' && summary.trim() === EMPTY_MEMORY_SUMMARY) return '';
    if (typeof summary === 'string' && summary.trim() && summary.trim().length <= maximum) return summary.trim();
    observedChars = typeof summary === 'string' ? summary.trim().length : 0;
    target = Math.min(maximum, Math.max(80, Math.floor(target * 0.5)));
  }
  throw new ChannelError('MEMORY_COMPRESSION_FAILED', '模型摘要仍为空或过长，原文已保留，将自动重试压缩');
}

export async function summarizeMemory(material, maximum, runner, signal, cache = new Map(), executionSnapshot) {
  if (typeof runner.summarize !== 'function')
    throw new ChannelError('MEMORY_COMPRESSION_FAILED', '模型暂不能压缩记忆，原文已保留，将自动重试');
  executionSnapshot ??= await runner.memoryExecutionSnapshot?.(signal);
  const batches = compressionBatches(material);
  if (batches.length === 1) return candidate(material, maximum, runner, signal, { executionSnapshot });
  const results = new Array(batches.length), controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let next = 0, failure;
  const worker = async () => {
    while (next < batches.length && !combined.aborted) {
      const index = next++, input = batches[index];
      const partMaximum = Math.max(1, Math.min(Math.floor(input.length * 0.65),
        Math.floor(MAX_COMPRESSION_INPUT_CHARS / 2), Math.floor(maximum / batches.length)));
      const key = createHash('sha256').update(JSON.stringify([input, partMaximum, executionSnapshot ?? null])).digest('hex');
      try {
        if (cache.has(key)) results[index] = cache.get(key);
        else {
          results[index] = await candidate(input, partMaximum, runner, combined, {
            executionSnapshot, batch: { index: index + 1, total: batches.length },
          });
          // Validated parts can survive a later transport failure. Cache keys
          // include the exact evidence and frozen model controls, never a revision guess.
          cache.set(key, results[index]);
          while (cache.size > 128) cache.delete(cache.keys().next().value);
        }
      } catch (error) {
        failure ??= error;
        controller.abort(error);
        throw error;
      }
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(2, batches.length) }, worker));
  signal.throwIfAborted();
  if (failure || workers.some(result => result.status === 'rejected')) throw failure;
  const merged = results.filter(Boolean).join('\n\n');
  if (!merged) return '';
  // Consolidate in reception order so a later explicit correction can replace
  // an earlier fact. Only the final validated summary is committed by the store.
  return summarizeMemory('以下摘要来自同一会话的连续资料片段，按原始接收顺序排列；合并重复内容，保留后面的明确更正：\n' + merged,
    maximum, runner, signal, cache, executionSnapshot);
}
