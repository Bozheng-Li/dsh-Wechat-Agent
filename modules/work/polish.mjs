import { readPrompt } from '../../prompts/loader.mjs';
import { publicError } from '../../shared/contracts.mjs';
import { workPresentationPrompt, finishWorkPresentation } from './presentation.mjs';

const numbers = text => String(text).match(/[+-]?\d+(?:[.,]\d+)*(?:e[+-]?\d+)?%?/gi) ?? [];
const code = text => String(text).match(/```[\s\S]*?```/g) ?? [];
const links = text => [...String(text).matchAll(/\]\(([^\n]+?)\)/g)].map(match => match[1]);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Cosmetic API work never changes a native DSH outcome or its file bytes. */
export async function polishWorkResult(runner, originalText, request, signal, presentation) {
  if (!originalText?.trim() || typeof runner?.run !== 'function')
    return { text: originalText, polish: { state: 'skipped' } };
  try {
    const result = await runner.run({ mode: 'work-result', text: JSON.stringify({ request, result: originalText }),
      systemOverride: [readPrompt('work/result-polish.md'),workPresentationPrompt(presentation)].filter(Boolean).join('\n\n'), tools: [],
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    signal.throwIfAborted();
    const text = result?.text?.trim();
    if (!text || !equal(numbers(text), numbers(originalText)) || !equal(code(text), code(originalText)) || !equal(links(text), links(originalText)))
      return { text: originalText, polish: { state: 'fallback', reason: '润色结果没有完整保留原数字、代码或链接，已回传 DSH 原文' } };
    return { text: finishWorkPresentation(text,presentation), polish: { state: 'applied' } };
  } catch (error) {
    signal.throwIfAborted();
    return { text: originalText, polish: { state: 'fallback', error: publicError(error, '文字润色暂时不可用，已回传 DSH 原文') } };
  }
}
