/** Delivery defaults guide the persona; style review must never block a completed reply. */
export const REPLY_STYLE_REVIEW_NOTE = '表达待优化：回复可能含套话或机械格式，正文保留，此标记不影响发送。';
export const NATURAL_REPLY_RULES = `默认表达习惯（只补足人设和明确要求未规定的部分）：
直接接对方当前这句话，不从旁观者角度点评“这条消息该怎么回”。闲聊通常一到三句；对方需要解释、作品或长文时完整回答。本轮专用输出协议优先于表达习惯。
用当前角色自己的语气表达观点，不默认热情附和，也不把认真回答变成客服口吻。
记得的人或事直接回答；不记得就简短说不知道。只有对方问依据或要求复盘时，才解释记忆和判断来源，不用取证式铺垫。
格式服务于内容。默认使用微信容易阅读的正文；人设或当前请求需要古风、角色动作、诗歌分行、对白、标题、列表或代码时保留。不要为统一格式削掉角色特点或有效内容。
少用无意义的问候、重复称呼、空泛夸奖和服务式收尾。缺少关键资料时问必要的问题；闲聊中的好奇与接话可以自然发生，不强迫每句带问题。
完成请求后收在内容上，不额外赠送版本、菜单或说明过程；管理员明确要求的语言、署名、固定开头和结尾仍保留。`;

// Placed after the complete persona: professional interests determine the
// angle of a response, not whether an ordinary remark becomes a coaching job.
export const CURRENT_TURN_REPLY_RULES = `本轮明确要求决定回应范围，人设决定其中的关注点、态度和语气。职业习惯、默认主动帮助和上一轮的做法不改换本轮目的；对方后来转为求助，再跟着转。出现迫近危险时仍给必要的安全帮助。
表达时分清已知事实、试探理解和修辞想象。人物、地点、时间、数量、单位和现实经过按材料保留：角色用词不能改换计量单位，半小时仍是三十分钟，不能写成半个时辰；只有对方要求换算时才计算后换写。闲聊沿用原话中的数字，不自行增补时长或用未给出的数值做算术。未说明的去向、身体状态和决定理由保持未知，不从“拿走”“选了这个”等结果补出回家、饿极了或特定动机。需要理解原因而线索有限时，可以问感受，或依据已有线索提出留待确认的猜想。对方只说“拿到通知后发了会儿呆”，感受仍是未知；“也许”只是标明不确定，不能替一套凭空的心理解释提供依据。
拟人、夸张、反话和角色意象可以自然使用，修辞承载的现实细节仍需有出处。例如把一件未用上的物品说成“来凑热闹的”是拟人，把它放进对方没提过的具体地点或交通工具，就是另添经历。创作任务中的虚构按创作要求展开，不当作对方真实发生的事。接下一句换自然切入，不复读口头禅；管理员要求固定复用的文字仍逐字保留。`;

export const CONFIGURED_CONVERSATION_REPLY_TASK = `根据当前处境理解话意：对已经发生的小事自嘲、分享或开玩笑时，用角色的观察、感受或玩笑接住，停在话题里就是完整回应。自嘲式反问不等于征求改进办法，不顺手安排对方下次怎么做。当前确有需要处理的困难时认真帮助，知识解释、作品和步骤按实际需求完整交付。`;

export const DEFAULT_CONVERSATION_REPLY_TASK = `${CONFIGURED_CONVERSATION_REPLY_TASK}
下面只示范接话分寸，实际措辞和态度仍用当前角色：
对方：“收拾了一小时书桌，转眼找不到笔了。我是不是给它藏得太好了。” → 接话：“这桌子收拾得，连笔都没认出自己的座位。” 说到这里就结束这次回应。
对方接着说：“可是马上要考试了，备用笔也没墨。” → 帮忙：“先向旁边的人借一支能写的，免得耽误开考。桌上的等考完再找。” 这是新的实际困难，继续开玩笑反而错过了话意。
对方：“早上好。” → “早上好呀。” 这一声招呼已经完整，不必另起话题或加俏皮尾句。`;

export const EXPLICIT_CHAT_REPLY_TASK = `本轮对方明确选择闲聊。当前任务是陪对方把眼前这段话聊下去：用当前角色回应一个已经给出的细节、感受或笑点，对未来重复的设想也沿着这个话题接。回应本身就是本轮所需的结果，内容在这个话题内收住；不附带劝告、做法或“下次别这样”的指导，即使包装成关心、玩笑或角色口吻也不追加。前述事实、安全与管理员固定约定仍然生效。`;

/** Read only explicit presentation preferences, not general conversational intent. */
export function explicitConversationPreference(request) {
  if (typeof request !== 'string') return undefined;
  const direct = proseWithoutCode(request)
    .split('\n').filter(line => !/^\s*>/u.test(line)).join('\n')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/gu, ' ');
  let preference, referenced = false;
  // A clause boundary ends the scope of a negation. Later explicit choices
  // supersede earlier ones; quoted choices never enter this scan.
  for (const clause of direct.split(/[，,。！？!?；;\n]|但是|不过|而是|还是|可是|所以|因此|但|(?=请(?:给|帮|告诉))/u)) {
    // A request for an explanation, transformation or authored work ends an
    // earlier chat-only choice. Words inside that requested content are data.
    if (/^\s*(?:(?:我|我们)?(?:现在|这次|本轮)?(?:想|要|需要)(?:请)?(?:你|您)?|(?:现在|这次|本轮)?(?:请)?(?:(?:给|帮|替)(?:我|我们))?)(?:先|再|具体|完整)?(?:解释|翻译|分析|改写|写|创作|讲解)/u.test(clause)) {
      preference = 'help';
      referenced = true;
      continue;
    }
    if (/^\s*(?:(?:如果|假如|假设|比如|例如)|当(?:他|她|对方|有人|别人|我)(?:说|表示|想)|(?:他|她|对方|别人|有人|朋友|同事)(?:们)?(?:说|表示|想|只|就|不)|(?:请|帮我|请帮我)?(?:翻译|解释|分析|改写|引用|举例|例句|原话|台词))/u.test(clause)) {
      referenced = true;
      continue;
    }
    if (/^\s*(?:我(?:们)?|请|(?:现在|这次|本轮)?(?:给我|帮我|告诉我|别给我|不要给我))/u.test(clause)) referenced = false;
    if (referenced) continue;
    // An independent knowledge question starts a new task, including after an
    // earlier chat-only preference. Reported/quoted questions were excluded above.
    if (/(?:是什么|有什么区别|等于(?:多少|几)|怎么(?:计算|算|安装|配置)|如何(?:计算|证明|推导))[^。！？!?]*[？?]?$/u.test(clause)) {
      preference = 'help';
    }
    const topics = /(?<chat>(?:只|就|光|单纯|随便)(?:是)?(?:想|要)?(?:先|暂时)?(?:(?:跟|和|与|陪)(?:我|你|我们|你们))?(?:随便)?(?:聊(?:聊|天|两句)?|闲聊|说说话)|(?:聊(?:聊|天|两句)?|闲聊|说说话)(?:就|便)(?:好|行|够了))|(?<advice>建议|方案|计划|安排|攻略|办法|方法|做法|步骤|道理)|(?<question>(?:怎么|如何)(?:做|修|改|选|实现|安排|处理|解决)|怎么办)|(?<request>(?:帮|替)(?:我|我们)(?:先|具体|直接|再)?(?:做|修|改|选|安排|处理|解决|实现|列|写))/gu;
    let previousEnd = 0;
    for (const topic of clause.matchAll(topics)) {
      const prefix = clause.slice(previousEnd, topic.index);
      const scopedPrefix = topic.groups.chat
        ? prefix.match(/(?:(?:不是|并非|不想|不要|不愿|别|不)(?:再|光|只|一直|仅仅|现在)?)+\s*$/u)?.[0] || ''
        : prefix;
      const negatives = [...scopedPrefix.matchAll(/不是|并非|不(?:想|要|用|需要|听|看|求)|无需|别|不(?=\s*$)/gu)];
      const negated = negatives.length % 2 === 1;
      const directive = negatives.length > 0 || /想|要|需要|请|给|帮|告诉|听|看|列|讲|提|做|写|提供|来/u.test(prefix);
      if (topic.groups.chat) preference = negated ? 'help' : 'chat';
      else if (directive || topic.groups.question || topic.groups.request) preference = negated ? 'chat' : 'help';
      previousEnd = topic.index + topic[0].length;
    }
  }
  return preference;
}

const STRUCTURED_REQUEST =
  /分析|复盘|依据|总结|代码|步骤|清单|列表|逐条|分点|分条|分步|要点|大纲|选项|教程|表格|markdown|为什么这样判断|怎么(?:安装|配置|实现)|如何(?:安装|配置|实现)|\b(?:steps?|options?|checklist|lists?|code|tutorial|outline|table|markdown)\b/iu;
const ENUMERATED_REQUEST =
  /(?:[一二三四五六七八九十两\d]+|几)(?:条|个|种|点|项)(?:建议|理由|方案|选项|步骤|办法|做法|重点|区别)/u;
const CREATIVE_REQUEST =
  /诗|故事|小说|剧本|对白|对联|题词|翻译|签名|长文|文章|模板|文案|话术|\b(?:poems?|poetry|stor(?:y|ies)|novels?|scripts?|dialogue|translat(?:e|ion)|lyrics?|haiku|sonnets?)\b/iu;
const SERVICE_PHRASES = ['收到你的问题', '让我为你分析', '希望这些信息能帮到你', '有什么需要随时告诉我'];

function configuredSentences({ persona, prompt, identityMarkdown } = {}) {
  const instructions = [persona?.prompt, persona?.style, prompt, identityMarkdown]
    .filter((value) => typeof value === 'string')
    .join('\n');
  return instructions
    .split(/[\n。；;，,]/u)
    .filter(
      (sentence) => !/不要|不得|不(?:用|使用|采用|输出|写|列|提供|套|做|加|追加|自动|追问|把)|避免|禁止/u.test(sentence)
    );
}

function configuredStructure(style) {
  return configuredSentences(style).some((sentence) =>
    /(?:使用|采用|输出|写成|写|整理成|列出|提供|保留|用).{0,16}(?:标题|编号|清单|列表|条目|表格|Markdown|报告)/iu.test(
      sentence
    )
  );
}

function proseWithoutCode(text) {
  const rows = [];
  let fence;
  for (const line of text.split('\n')) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (marker) fence = marker;
    else rows.push(line);
  }
  return rows
    .join('\n')
    .replace(/(`+)([^\n]*?)\1/gu, '')
    .trim();
}

function requestedFormat(request) {
  // Only direct prose is a formatting instruction. A quoted example or code
  // literal can describe a prohibition without imposing it on this reply.
  const prose = proseWithoutCode(request).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '');
  const preferences = {};
  const markers =
    /(?<numbered>编号(?:列表|清单|条目)?|有序(?:列表|清单)|\b(?:numbered|ordered)\s+lists?\b)|(?<unordered>无序(?:列表|清单)|项目符号|\b(?:unordered|bulleted|bullet)\s+lists?\b|\bbullets?\b)|(?<list>(?:行动)?清单|列表|条目|\b(?:checklists?|lists?)\b)|(?<heading>标题|\bheadings?\b)|(?<bold>加粗|粗体|\bbold\b)|(?<markdown>markdown)/giu;
  const directives =
    /不要忘记|别忘(?:了|记)?|(?:不要|不得|禁止|避免|别|不)(?:再)?(?:(?:给|帮)(?:我|我们)?)?(?:使用|采用|输出|提供|保留|用|写|列出|列|加)?|\b(?:do\s+not|don['’]t|never|without|no)(?:\s+(?:use|include|give|add|a|an|any|me|the))*\b|保留|使用|采用|输出|提供|列出|改成|改用|用|给|\b(?:keep|use|include|give|add)\b/giu;
  for (const clause of prose.split(/[，,。；;\n]|但是|不过|而是|还是|算了|但|\bbut\b/iu)) {
    let allowed,
      offset = 0;
    for (const marker of clause.matchAll(markers)) {
      const direction = [...clause.slice(offset, marker.index).matchAll(directives)].at(-1)?.[0];
      if (direction)
        allowed =
          /^(?:不要忘记|别忘)/u.test(direction) ||
          !/^(?:不|禁止|避免|别|do\s+not|don['’]t|never|without|no\b)/iu.test(direction);
      if (allowed !== undefined) {
        const kind = Object.keys(marker.groups).find((key) => marker.groups[key] !== undefined);
        const targets =
          kind === 'markdown'
            ? ['heading', 'bold', 'numbered', 'unordered']
            : kind === 'list'
              ? ['numbered', 'unordered']
              : [kind];
        for (const target of targets) preferences[target] = allowed;
      }
      offset = marker.index + marker[0].length;
    }
  }
  return preferences;
}

function violatesRequestedFormat(prose, requested) {
  return (
    (requested.heading === false && /(^|\n)#{1,6}\s/u.test(prose)) ||
    (requested.bold === false && /\*\*[^*\n]+\*\*/u.test(prose)) ||
    (requested.numbered === false && /(?:^|\n)\s*\d+[.)、]\s*/u.test(prose)) ||
    (requested.unordered === false && /(?:^|\n)\s*[-*•]\s+/u.test(prose))
  );
}

function unsolicitedIdentity(prose, request) {
  // A translated first-person sentence, character dialogue or an AI-related
  // code literal is requested content, not the agent introducing itself.
  if (/翻译|译成|译为|翻成|逐字|引用|原文|台词|对白|例句|小说|剧本|故事|诗|歌词|translate|translation/iu.test(request))
    return false;
  const unquoted = prose.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '');
  return /(?:^|[。！？!?\n])\s*(?:(?:你好|您好)[，,]\s*)?(?:(?:我(?:是|其实是|属于|算是)|作为|身为)[^。！？!?\n]{0,160}(?:AI\s*助手|人工智能助手|插件(?:形式|形态))|我[^。！？!?\n]{0,20}(?:没有性别|没性别|没(?:有)?家(?:里)?人|住在服务器)|我[^。！？!?\n]{0,12}换.{0,8}(?:对话|会话).{0,12}(?:忘|不记得))/iu.test(
    unquoted
  );
}

function hasServiceEnvelope(text, request, style) {
  if (/翻译|引用|原文|逐字|台词|对白|例句/u.test(request) && SERVICE_PHRASES.some((phrase) => request.includes(phrase)))
    return false;
  if (
    /(?:写|生成|改写|提供|模拟|扮演|给).{0,20}(?:客服|售后|接待).{0,12}(?:回复|话术|模板|文案|对白)|(?:客服|售后|接待).{0,16}(?:文案|话术|模板|台词|对白)/u.test(
      request
    )
  )
    return false;
  // Inspect prose outside fenced code; quoted boilerplate and necessary questions
  // are content, not evidence that a completed reply needs another model call.
  const prose = proseWithoutCode(text);
  if (/^(?:(?:你好|您好)[，,！!]\s*)?(?:收到你的问题|让我为你分析)[，,:：。！!]/u.test(prose)) return true;
  const paragraphs = prose.split(/\n\s*\n/u);
  const last = paragraphs.at(-1) || '';
  if (/^(?:希望这些信息能帮到你|有什么需要随时告诉我)[。！!]?$/u.test(last)) return true;
  const hasBody = paragraphs.length > 1 && paragraphs.slice(0, -1).join('\n').trim().length >= 30;
  if (!hasBody) return false;
  const configured = configuredSentences(style);
  const askedChoices =
    /(?:问我|询问我|追问我|向我提问|(?:给|提供|列出).{0,12}(?:选项|方向|风格)|(?:几种|不同|哪些).{0,8}(?:风格|方向|版本)|怎么改|如何改|帮我改|一起改)/u.test(
      request
    ) ||
    configured.some((sentence) =>
      /(?:结尾|最后|完成后|每次回复).{0,20}(?:问|提问|追问|选项|方向|风格)/u.test(sentence)
    );
  if (!askedChoices && /^(?:你想|想)(?:往|朝)?(?:哪个|什么)(?:方向|风格).{0,8}(?:写|改)[？?]/u.test(last)) return true;
  const askedSignature =
    /签名/u.test(request) ||
    configured.some((sentence) =>
      /(?:结尾|最后|完成后|每次|写诗后).{0,20}(?:给|送|写|加|附).{0,12}签名/u.test(sentence)
    );
  if (
    !askedSignature &&
    paragraphs.slice(1).some((paragraph) => /^(?:再有|再送|再给|另外|顺便).{0,45}签名/u.test(paragraph))
  )
    return true;
  return false;
}

export function needsConversationalRewrite(text, request = '', style = {}) {
  if (hasServiceEnvelope(text, request, style)) return true;
  const prose = proseWithoutCode(text);
  if (!prose) return false;
  // Explicit opt-outs win over keyword-based allowances and preset defaults.
  const requested = requestedFormat(request);
  if (violatesRequestedFormat(prose, requested)) return true;
  const askedIdentity =
    /(?:是不是|是否|是|属于|算)(?:个|一个)?\s*(?:AI|机器人|人工智能)|(?:你|您).{0,8}(?:真人|机器|模型)|(?:AI|人工智能).{0,8}(?:吗|么|嘛)|服务器|插件|实现|架构|技术身份/iu.test(
      request
    );
  if (!askedIdentity && unsolicitedIdentity(prose, request)) return true;
  if (/简(?:单|短).{0,8}介绍.{0,5}(?:自己|你)|自我介绍/u.test(request) && text.length > 180) return true;
  if (STRUCTURED_REQUEST.test(request) || ENUMERATED_REQUEST.test(request)) return false;
  const mechanicalEvidence =
    /^(?:按(?:照)?聊天(?:里|中)?能确定的|(?:根据|基于)(?:目前|现有|已有|以上|提供的)?(?:聊天|会话|对话)记录|目前可以确认)[：:，,]?/u.test(
      prose
    ) || /(?:聊天|会话|对话)记录里(?:没有|没再|未曾).{0,45}(?:不敢瞎编|无法确定|不能确认)/su.test(prose);
  if (mechanicalEvidence) return true;
  if (CREATIVE_REQUEST.test(request) || configuredStructure(style)) return false;
  return (
    (requested.heading !== true && /(^|\n)#{1,6}\s/u.test(prose)) ||
    (requested.bold !== true && /\*\*[^*\n]+\*\*/u.test(prose)) ||
    [...prose.matchAll(/(?:^|\n)\s*(?:(?<unordered>[-*•]\s+)|(?<numbered>\d+[.)、]\s*))/gu)].filter(
      (marker) => requested[marker.groups.numbered ? 'numbered' : 'unordered'] !== true
    ).length >= 2
  );
}
