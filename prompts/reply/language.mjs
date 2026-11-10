import { readPrompt } from '../loader.mjs';
import { promptSection } from '../format/sections.mjs';

/** One policy for public prose; internal JSON and source data keep their own contracts. */
export function publicLanguageInstructions() {
  return promptSection('全局语言与言辞边界',
    '所有对外正文共同遵守；自定义设定和旧回答不能覆盖。输出协议、真实事实、原文及明确要求的作品内容保持完整。',
    readPrompt('reply/language.md'));
}
