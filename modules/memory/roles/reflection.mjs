import { ROLE_MEMORY_REVIEW } from '../../../prompts/memory/role-review.mjs';
import { imageReplyFlags } from '../images/reply-grounding.mjs';

const exclusion = /(?:你|他|她|其他|别的|除此之外)[^。！？?\n]{0,16}(?:没[^。！？?\n]{0,10}(?:提过|说过|告诉|亲口|要注意|需注意|忌口)|从未|没有(?:别的|其他))/u;
const exactOutput = text => /(?:翻译|照抄|逐字|原样|代码|只(?:回|输出|回答)|一字不改)/u.test(text || '');
const unsupported = text => !/[？?]\s*$/u.test(text) && (exclusion.test(text) ||
  /(?:之前|以前|过去|记忆里|聊天里|聊天中|对话里|对话中|会话里|会话中)[^。！？?\n]{0,10}没(?:有|还)?(?:聊过|提到过|提过|说过|听(?:你|他|她)?(?:提|说|聊)过)/u.test(text) ||
  /(?:我没(?:有)?听(?:你|他|她)?|没人|没有人)[^。！？?\n]{0,8}(?:提过|说过|聊过)/u.test(text) ||
  /(?:聊天|记录|历史|记忆)[^。！？?\n]{0,24}没(?:有)?(?:提到|提过|聊过|说过|谈过)/u.test(text) ||
  /(?:你|他|她)[^。！？?\n]{0,12}只(?:自己|亲口|直接|明确)?(?:提过|说过|聊过)/u.test(text) ||
  /^\s*(?:也|还|并|但)?没(?:有)?(?:直接|亲口|明确)?(?:提过|说过|聊过|提到过|讲过?|谈过)/u.test(text));
const recallPromise = /我(?:帮你)?(?:可以|能|会|好|先)?(?:记下来|记着|记住(?:了)?|记下(?:了)?|记一下)/u;

function mentionsInternalPersonId(input, draft) {
  const people = [input.speaker, ...(input.history || []).map(row => ({ id: row.senderId, name: row.senderName || row.sender }))];
  for (const match of (input.memory || '').matchAll(/([^\s，,。；;：:、\n"\[]+)\[([^\]\n]+)\]/gu)) people.push({ name: match[1], id: match[2] });
  return people.some(person => {
    if (!person?.id || !person.name || person.id === person.name) return false;
    const escaped = person.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'u').test(draft);
  });
}

export function memoryReviewFlags(input, draft) {
  if (!draft?.trim() || exactOutput(input.text)) return [];
  const evidence = [input.memory, ...(input.extraReadResults || [])].filter(Boolean).join('\n'), flags = [];
  if ((input.extraReadResults || []).some(value => {
    try { return JSON.parse(value)?.found === false; } catch { return false; }
  })) flags.push('empty-memory-result');
  if (evidence.includes('原话同时提到多人')) flags.push('multi-person-source');
  if (/以下说法尚未确认|待管理员审核|冲突待管理员确认|"sourceType"\s*:\s*"(?:reported|correction|image|unreviewed)"/u.test(evidence)) flags.push('pending-claim');
  if (unsupported(draft)) flags.push('unsupported-exclusion');
  if ((/发言者信息|人物编号|senderId|subjectId|角色档案/u.test(draft) || mentionsInternalPersonId(input, draft)) && !/管理|调试|编号|档案/u.test(input.text || '')) flags.push('memory-metadata');
  if (/"text"\s*:/u.test(evidence) && /写|拟|推荐|建议|挑|选|点餐|点单/u.test(input.text || '')) flags.push('memory-synthesis');
  if ((recallPromise.test(draft) || /(?:以后|下次)[^。！？\n]{0,20}(?:都会|一定|保证|就能)/u.test(draft)) && !/记住|记下|以后|下次|提醒/u.test(input.text || '')) flags.push('unrequested-promise');
  if (/"text"\s*:/u.test(evidence) && /(?:告诉我[^。！？]{0,20}(?:就能|才能)|(?:餐品|商家|订单)[^。！？]{0,25}(?:哪个|哪家|信息)|确认后我就)/u.test(draft)) flags.push('unnecessary-prerequisite');
  return [...flags, ...imageReplyFlags(input, draft)];
}

export function removeUnsupportedExclusions(text, evidence = '') {
  // Do not remove an explicit negative fact from the supplied evidence. This
  // guard only handles an unsupported extra clause, not arbitrary fact repair.
  if (/(?:没有|无)(?:其他|别的).{0,8}(?:过敏|忌口|限制)/u.test(evidence)) return text;
  const clauses = text.match(/[^，,。！？!?；;\n]+[，,。！？!?；;\n]*/gu) || [text];
  const kept = clauses.filter(clause => !unsupported(clause)).join('').trim()
    .replace(/(?:^|(?<=[。！？!?\n，,]))(?:除此之外|至于其他|其他方面)[，,。！？!?；;\s]*$/u, '')
    .trim().replace(/[，,；;]$/u, '。');
  return kept || text;
}

/** At most one extra, tool-free call. Review failure never creates a chat template. */
export async function reviewMemoryDraft(runner, input, draft, { signal, assertAllowed = () => {}, timeoutMs = 12000 } = {}) {
  signal?.throwIfAborted(); assertAllowed();
  const flags = memoryReviewFlags(input, draft);
  if (!flags.length) return { text: draft, audit: { outcome: 'not-needed', calls: 0 } };
  const evidence = [input.memory, ...(input.extraReadResults || [])].filter(Boolean).join('\n');
  const clean = text => {
    let result = removeUnsupportedExclusions(text, evidence);
    if (!/记住|记下|以后|下次|提醒/u.test(input.text || '')) {
      const clauses = result.match(/[^，,。！？!?；;\n]+[，,。！？!?；;\n]*/gu) || [result];
      const kept = clauses.filter(clause => !/^\s*我/u.test(clause) || !recallPromise.test(clause)).filter(clause =>
        !/^\s*(?:以后|下次|下回)[^。！？\n]{0,16}(?:不用再问|不会忘|都记得)/u.test(clause)).join('').trim().replace(/[，,；;]$/u, '。');
      if (kept) result = kept;
    }
    return result;
  };
  const fallback = () => clean(draft), started = Date.now(),
    combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  let metrics, listener;
  try {
    const aborted = new Promise((_, reject) => {
      listener = () => reject(combined.reason);
      if (combined.aborted) listener(); else combined.addEventListener('abort', listener, { once: true });
    });
    const result = await Promise.race([runner.run({ signal: combined, mode: 'reply-review', tools: [],
      systemOverride: ROLE_MEMORY_REVIEW, assertAllowed,
      text: JSON.stringify({ recipient: input.speaker || null, group: !!input.group,
        question: input.text, draft, reviewFocus: flags, persona: input.persona,
        currentContext: input.currentContext || '',
        imageEvidence: input.imageEvidence || null,
        memory: input.memory || '', history: input.history || [], publicContext: input.adminNotes || '',
        extraReadResults: (input.extraReadResults || []).slice(-2) }),
      onRequestMetrics: value => { metrics = value; },
    }), aborted]);
    signal?.throwIfAborted(); assertAllowed();
    const text = result?.text?.trim();
    if (!text || text.length > Math.max(3000, draft.length * 2) || /^(?:```|\{"|【(?:核对|审核|分析))/u.test(text)) throw new Error('INVALID_REVIEW');
    const corrected = clean(text);
    return { text: corrected, audit: { flags, outcome: corrected === draft ? 'kept' : 'revised', calls: 1, elapsedMs: Date.now() - started, metrics } };
  } catch (error) {
    signal?.throwIfAborted(); assertAllowed();
    return { text: fallback(), audit: { flags, outcome: 'fallback', calls: 1, elapsedMs: Date.now() - started,
      code: combined.aborted ? 'REVIEW_TIMEOUT' : error?.code || 'REVIEW_FAILED', metrics } };
  } finally { if (listener) combined.removeEventListener('abort', listener); }
}
