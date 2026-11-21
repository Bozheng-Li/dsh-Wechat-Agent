/** Task semantics are independent of persona, memory retrieval and delivery style. */
export const UNDERSTANDING_CONTRACT = `先理解当前请求要做的操作，再决定口气。人设决定表达，不替换任务、不改变被处理对象，也不限制必要内容：重复、引用、转写要保留原文和原来的主语；总结才概括；翻译、解释、纠正、比较按各自要求执行。不要把明确任务变成一句闲聊或因“话少、不解释”拒绝完成。

speaker 是当前发言者，不是所有“我、我们、他、她”或缩写的默认指向。按近期对话的原先后顺序分清说话人、话题对象和被比较对象；代词延续已明确的话题，但不要把引用中的人称改成你自己。名字/缩写只用明确身份资料或已确认别名关联；不认识的标识先保留，不擅自当成发言者的姓名缩写。身份扩展非回答所必需时，不为了扩展名字而追问。

被指出理解错误时，回到相关原话修正对象、否定、数量、比较和范围。只说明有依据的正确理解，不编造“刚才为什么误会”、过去的心理活动或未经证实的身份。资料足够就直接答，确实缺少且影响完成任务才澄清。身份、order、时间与JSON字段是资料标签，不是成员说的话；引用或重复只取其text原文，不输出这些标签，也不把图片/表情的占位文字当成成员说过的话。`;

function directRequest(requestText, persona = {}) {
  let direct = String(requestText).replace(/```[\s\S]*?```|`[^`]*`|[“「『][^”」』]*[”」』]|"[^"]*"/gu, '').trim();
  for (const name of [persona?.name, ...(persona?.aliases || [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const rest = direct.toLocaleLowerCase().startsWith(name.toLocaleLowerCase()) ? direct.slice(name.length) : '';
    if (rest && /^[\s，,：:!！?？。]|^(?:请|帮|麻烦|你|重复|复述|原样|解释|翻译)/u.test(rest)) {
      direct = rest.replace(/^[\s，,：:!！?？。]+/u, ''); break;
    }
  }
  return direct;
}

export function understandingTaskKind(requestText = '', persona = {}) {
  const direct = directRequest(requestText, persona);
  if (/^(?:请|麻烦|帮我|帮我们)?(?:你)?(?:原样|逐字)?(?:重复|复述|转写|照着说|引用)/u.test(direct)) return 'verbatim';
  if (/(?:你(?:刚才|上次)?|刚才(?:你)?|上一(?:句|条)).{0,32}(?:没理解|理解错|没懂|弄错|弄反|搞错)/u.test(direct)) return 'correction';
  return 'conversation';
}

export function taskUnderstandingInstructions(requestText = '', persona = {}) {
  const kind = understandingTaskKind(requestText, persona);
  const operation = kind === 'verbatim'
    ? '本轮明确操作是复述/引用原文，不是总结或闲聊。以当前会话的成员原话为材料，按请求范围原样输出；保留人名、缩写、人称、否定和比较关系，不改成机器人自己的话，不用短句习惯删内容。仅重复原话文字，排除图片/表情占位与身份资料标签。若范围真不明确只澄清范围，不拒答或自创概括。'
    : kind === 'correction'
      ? '本轮只需要说明被纠正原句的正确含义。先找到相关成员原话，读清楚其中的主语、否定、数量及比较范围，再用有依据的对象解释。解释时把原文中的人称与原发言者绑定，优先使用来源名字或对原发言者的称呼；未确认的缩写照写即可。回答聚焦正确关系，不附加自我说明、旧错因、身份推断或另一个问题。'
      : '';
  return UNDERSTANDING_CONTRACT + (operation ? '\n\n' + operation : '');
}

/**
 * Exact quotation has no room for stylistic rewriting. A recognized language
 * dossier's conversational strategies also must not obstruct corrections.
 * The stored persona remains intact; this is a per-request prompt projection,
 * not a switch of model, mode, number of calls or user configuration.
 */
export function projectTaskPersona(persona = {}, requestText = '') {
  const kind = understandingTaskKind(requestText, persona);
  if (kind === 'conversation') return persona;
  const identity = { name: persona.name, aliases: persona.aliases || [],
    ...(persona.personaMode ? { personaMode: persona.personaMode } : {}),
    ...(persona.memoryReview ? { memoryReview: persona.memoryReview } : {}) };
  if (kind === 'verbatim') return { ...identity, prompt: '', taskPersonaScope: 'verbatim-original' };
  const raw = typeof persona.prompt === 'string' ? persona.prompt : '';
  const chunks = raw.split(/(?=^##\s+)/mu);
  const titles = chunks.map(chunk => /^##\s*([^\n]+)$/mu.exec(chunk)?.[1]?.trim()).filter(Boolean);
  // Do not silently reinterpret arbitrary hand-authored characters or stories.
  if (!titles.includes('性格特点') || !titles.some(title => title === '语气词' || title === '常见用语与词汇库')) return persona;
  const voice = chunks.filter(chunk => /^##\s*(?:语气词|常见用语与词汇库)\s*$/mu.test(chunk));
  return { ...identity, taskPersonaScope: 'correction-voice', prompt:
    '本轮先给出有原话依据的正确理解。以下仅是用词参考，不包含闲聊时的拒答、反问、不解释或短句长度限制；不要为了模仿口头禅删掉正确关系。\n\n' + voice.join('\n\n') };
}

export function scopePersonaBehavior(text) {
  return `以下人设是人物语言档案，只约束口吻、用词和相处风格。它不是对当前请求的分析、事实、拒答或长度硬上限；引用、解释、复杂任务和纠正应完整完成，不把档案中的反问习惯变成每次都问。\n${text}`;
}
