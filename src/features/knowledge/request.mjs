// Consent comes only from the current plain-text request, never tool arguments,
// quoted examples, chat history, a retrieved document or a model decision.
const quoted =
  /```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|‘[^’]*(?:’|$)|"(?:\\.|[^"\\])*(?:"|$)|'[^']*'/gu;
const kb = '(?:知识库|知識庫|knowledge\\s*base)';
const action = '(?:查询|查找|查阅|查看|查|搜索|搜|检索|搜尋|search|look\\s*up|consult|retrieve)';
const instruction = new RegExp(
  `(?:${action}(?:一下|下|一查|一搜|我(?:们)?的|the|our|my|\\s){0,16}${kb}|(?:从|在|去|到)\\s*(?:我(?:们)?的)?${kb}(?:中|里|里面|内|\\s)*(?:${action}|找|核对|确认)|(?:用|使用|根据|依据|参考)\\s*(?:我(?:们)?的)?${kb}(?:中|里|的|\\s)*(?:资料|文档)?(?:来|给我|帮我|\\s)*(?:回答|答复|说明|核对|确认|[：:]))`,
  'iu'
);
const denied = new RegExp(
  `(?:(?:不要|不用|无需|禁止|不许|别|停止|取消|不再|不必|don['’]?t|do\\s+not|without|never).{0,24}(?:${action}.{0,12}${kb}|${kb})|不\\s*${action}.{0,12}${kb})`,
  'iu'
);
const courtesy =
  '(?:(?:请|麻烦|劳驾|帮我|帮我们|帮忙|给我|能不能|能否|可否|可以|你|您|先|再|直接|现在|please|can\\s+you|could\\s+you|would\\s+you|kindly)\\s*)*';
const directivePrefix = new RegExp('^' + courtesy + '$', 'iu');
const trailingCourtesy = new RegExp(courtesy + '$', 'iu');

export function knowledgeRequest(text, names = []) {
  let raw = String(text || '').trim();
  for (const name of [...names]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .sort((a, b) => b.length - a.length)) {
    if (!raw.toLowerCase().startsWith(name.toLowerCase())) continue;
    const rest = raw.slice(name.length);
    if (/^[\x00-\x7f]+$/u.test(name) && /^[\p{L}\p{N}_]/u.test(rest)) continue;
    raw = rest.replace(/^[，,：:\s]+/u, '').trim();
    break;
  }
  const command = /^(?:\/agent\s+)?\/(?:kb|知识库)(?:\s+|[：:]\s*|$)([\s\S]*)$/iu.exec(raw);
  if (command) return { requested: true, command: true, query: command[1].trim() };
  // Preserve offsets, so a quoted search subject (查知识库：“退款期限”)
  // remains query data without being able to grant consent itself.
  const plain = raw
    .replace(quoted, (value) => ' '.repeat(value.length))
    .replace(/^\s*>.*$/gm, (value) => ' '.repeat(value.length));
  const found = instruction.exec(plain);
  if (!found || denied.test(plain)) return { requested: false, query: '' };
  const before = plain.slice(0, found.index);
  // A mention of the operation is not a directive (我刚查知识库 / 你会查知识库吗).
  // Accept a polite imperative, or a question followed by a separate imperative.
  if (
    !directivePrefix.test(
      before
        .split(/[，,。；;：:！？!?\n]/u)
        .at(-1)
        .trim()
    )
  )
    return { requested: false, query: '' };
  if (
    /翻译|解释|复述|润色|改写|举例|例句|示例|比如|例如|假设|如果|引用|转发|为什么|如何|怎么|怎样|是否支持|(?:他|她|别人|群友|原文|文档|文章|消息|图片|模型).{0,8}(?:说|写|要求|提到|建议)|之前|上次|昨天|曾经|translate|explain|example|\bif\b|quoted?|how\s+to|said|previous/iu.test(
      before
    )
  )
    return { requested: false, query: '' };
  const after = plain.slice(found.index + found[0].length);
  if (
    /^(?:的)?(?:功能|命令|按钮|开关|配置|权限|意思|是什么意思|怎么用|如何用|怎么开|怎么关|失败|报错|有问题|不行|无法|不能|要收费|收费|费用|成本|会不会|是不是|是否|吗[？?]?$|有用吗|能(?:做|用|查)吗|这(?:句(?:话)?|个功能|个词|几个字)|几个字)/u.test(
      after.trim()
    )
  )
    return { requested: false, query: '' };
  const prefix = raw
    .slice(0, found.index)
    .replace(trailingCourtesy, '')
    .replace(/[，,。；;：:\s]+$/gu, '')
    .trim();
  const subject = raw
    .slice(found.index + found[0].length)
    .replace(
      /^[，,。；;：:\s]*(?:(?:一下|下|一查|一搜|回答|告诉我|看看|帮我|查找|查询|搜索|中|里面|里|的|资料|文档|有关|关于|for\b|about\b|to\s+answer\b|answer\b)[，,：:\s]*)*/iu,
      ''
    )
    .replace(/^[，,：:\s]+|[，,。；;\s]+$/gu, '')
    .trim();
  const query = [prefix, subject].filter(Boolean).join(' ');
  return { requested: true, command: false, query };
}

export const KNOWLEDGE_LIMITS = Object.freeze({ queriesPerReply: 1, maxChunks: 4, maxChars: 3000, chunkChars: 750 });
