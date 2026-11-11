import { readPrompt } from '../../prompts/loader.mjs';
import { publicError } from '../../shared/contracts.mjs';
import { workPresentationPrompt, finishWorkPresentation } from './presentation.mjs';

const numbers = text => String(text).match(/[+-]?\d+(?:[.,]\d+)*(?:e[+-]?\d+)?%?/gi) ?? [];
const code = text => String(text).match(/```[\s\S]*?```/g) ?? [];
const links = text => [...String(text).matchAll(/\]\(([^\n]+?)\)/g)].map(match => match[1]);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// These are direct status statements, not a general-purpose Chinese factual
// classifier. Preserve a small set of explicit negative/pending facts verbatim;
// an uncertain cosmetic rewrite can always return the authoritative original.
const statusKinds = [
  { kind: 'execution',
    protected: /(?:尚未|暂未|还未|还没(?:有)?|未|没有|没)(?:实际|正式|全部|完全)?(?:开始(?:执行|运行|处理)?|启动|创建|执行(?:命令|任务|工作)?|运行(?:验证|测试)?|完成|结束|处理完|做完)|(?:仍在|还在)?(?:排队|等待执行)|(?:执行|运行|处理|保存|创建)失败|已取消|正在停止|取消中/gu,
    positive: /(?:已经|已)(?:全部|完全|顺利|成功|正式)?(?:开始(?:执行|运行|处理)?|启动|创建|执行|运行|完成|结束|处理完|做完)|正在(?:执行|运行|处理)|(?:全部|都)?(?:完成了|做完了|做好了|处理完了|搞定了)/gu },
  { kind: 'lookup',
    protected: /(?:尚未|暂未|仍未|还未|还没(?:有)?|未|没有|没)(?:能|能够)?(?:查询到|查到|检索到|搜索到|找到|读到|读取到)(?:相关)?(?:结果|信息|资料|记录|内容|答案)?/gu,
    positive: /(?:已经|已)(?:成功)?(?:查询到|查到|检索到|搜索到|找到|读到|读取到)|(?:查询|查|检索|搜索|找|读取)到了/gu },
  { kind: 'delivery',
    protected: /(?:等待|等候|待)(?:微信|服务端)?(?:回传|发送|送达|回执|确认回执)|(?:尚未|暂未|还未|还没(?:有)?|未|没有|没)(?:回传|发送|送达|收到(?:微信|服务端)?(?:回执|确认)|取得(?:微信|服务端)?(?:回执|确认))|(?:发送|回传|送达)失败|(?:发送|送达|回传|回执)(?:结果)?(?:不明|未知|未确认)/gu,
    positive: /(?:已经|已)(?:全部|成功)?(?:回传|发送|送达|发出|发给|传回|收到(?:微信|服务端)?(?:回执|确认)|取得(?:微信|服务端)?(?:回执|确认))|(?:微信|服务端)(?:已经|已)?确认(?:送达|收到)?/gu },
];
const literal = /(`+)[\s\S]*?\1|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/gu;
const blank = value => value.replace(/[^\r\n]/g, ' ');
function normalizedClause(value) {
  // Preserve quoted names and inline paths byte-for-byte while allowing prose spacing.
  return value.replace(literal, text => '\0' + Array.from(text).map(char => char.codePointAt(0).toString(16)).join('-') + '\0')
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').replace(/\*\*|__/g, '').replace(/\s+/gu, '');
}
function normalizedStatus(text) {
  // A small, explicit equivalence set permits everyday wording without
  // equating different phases (not started is not the same as not finished).
  return text.replace(/^(?:尚未|暂未|仍未|还未|还没有|还没|没有|没)/u, '未')
    .replace(/^未(?:实际|正式)?开始(?:执行|运行|处理)?$/u, '未开始')
    .replace(/^未(?:能|能够)?查询到/u, '未查到').replace(/^未(?:能|能够)查到/u, '未查到')
    .replace(/^(?:仍在|还在)?排队$/u, '排队')
    .replace(/^(?:等候|待)(?=(?:微信|服务端)?(?:回传|发送|送达|回执|确认回执))/u, '等待');
}
function statusClauses(text) {
  const original = String(text);
  const masked = original.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, blank)
    .replace(/^\s*>.*$/gm, blank).replace(literal, blank).replace(/\*\*|__/g, blank);
  return [...masked.matchAll(/[^，,。！？!?；;\r\n]+/gu)].map(match => ({
    masked: match[0], original: original.slice(match.index, match.index + match[0].length),
  })).filter(clause => clause.masked.trim());
}
function statusStatements(text, field) {
  return statusClauses(text).flatMap(clause => statusKinds.flatMap(({ kind, [field]: pattern }) =>
    [...clause.masked.matchAll(pattern)].filter(match => {
      const before = clause.masked.slice(0, match.index), after = clause.masked.slice(match.index + match[0].length);
      return !/(?:如果|假如|假设|一旦|只要|若|比如|例如|示例|例子|术语|解释|介绍|讲解|描述|讨论|状态机)/u.test(before) &&
        !/^\s*(?:[-*•]|\d+[.)、])?\s*当/u.test(before) &&
        !/(?:不代表|不等于|并非|不是|是否|能否|(?:未|尚未|无法|不能|没有|没)(?:确认|确定|证明)).{0,12}$/u.test(before) &&
        !/^(?:的)?(?:时候|时|后|前|则|就)/u.test(after);
    }).map(match => ({ kind, text: match[0], clause: clause.original.trim(),
      clauseKey: normalizedClause(clause.original.slice(0, match.index) + '\0' + normalizedStatus(match[0]) + '\0' + clause.original.slice(match.index + match[0].length)),
      subject: normalizedClause(clause.original.slice(0, match.index)) }))));
}
function preservesStatuses(originalText, text, protectedStatuses) {
  if (!protectedStatuses.length) return true;
  const after = statusStatements(text, 'protected');
  for (const { kind, clauseKey } of protectedStatuses) {
    const index = after.findIndex(row => row.kind === kind && row.clauseKey === clauseKey);
    if (index < 0) return false;
    after.splice(index, 1);
  }
  const beforePositive = statusStatements(originalText, 'positive'), afterPositive = statusStatements(text, 'positive');
  for (const fact of protectedStatuses) if (fact.subject && afterPositive.some(row => row.kind === fact.kind && row.subject === fact.subject &&
    !beforePositive.some(prior => prior.kind === row.kind && prior.subject === row.subject && prior.text === row.text))) return false;
  return [...new Set(protectedStatuses.map(row => row.kind))].every(kind =>
    afterPositive.filter(row => row.kind === kind).length <= beforePositive.filter(row => row.kind === kind).length);
}

/** Cosmetic API work never changes a native DSH outcome or its file bytes. */
export async function polishWorkResult(runner, originalText, request, signal, presentation) {
  if (!originalText?.trim() || typeof runner?.run !== 'function')
    return { text: originalText, polish: { state: 'skipped' } };
  try {
    const protectedStatuses = statusStatements(originalText, 'protected');
    const result = await runner.run({ mode: 'work-result', text: JSON.stringify({ request, result: originalText,
      ...(protectedStatuses.length ? { protectedStatus: protectedStatuses.map(row => row.text),
        protectedFacts: [...new Set(protectedStatuses.map(row => row.clause))] } : {}) }),
      systemOverride: [readPrompt('work/result-polish.md'),workPresentationPrompt(presentation)].filter(Boolean).join('\n\n'), tools: [],
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    signal.throwIfAborted();
    const text = result?.text?.trim();
    if (!text || !equal(numbers(text), numbers(originalText)) || !equal(code(text), code(originalText)) || !equal(links(text), links(originalText)))
      return { text: originalText, polish: { state: 'fallback', reason: '润色结果没有完整保留原数字、代码或链接，已回传 DSH 原文' } };
    if (!preservesStatuses(originalText, text, protectedStatuses))
      return { text: originalText, polish: { state: 'fallback', reason: '润色改变了受保护的工作状态，已回传 DSH 原文' } };
    return { text: finishWorkPresentation(text,presentation), polish: { state: 'applied' } };
  } catch (error) {
    signal.throwIfAborted();
    return { text: originalText, polish: { state: 'fallback', error: publicError(error, '文字润色暂时不可用，已回传 DSH 原文') } };
  }
}
