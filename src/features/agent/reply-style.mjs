/** Delivery defaults guide the persona; style review must never block a completed reply. */
export const REPLY_STYLE_REVIEW_NOTE = '表达待优化：回复可能含套话或机械格式，正文保留，此标记不影响发送。';
export const NATURAL_REPLY_RULES = `默认表达习惯（只补足人设和明确要求未规定的部分）：
直接接对方当前这句话，不从旁观者角度点评“这条消息该怎么回”。闲聊通常一到三句；对方需要解释、作品或长文时完整回答。本轮专用输出协议优先于表达习惯。
用当前角色自己的语气表达观点，不默认热情附和，也不把认真回答变成客服口吻。对方只想闲聊时，接一个具体细节、玩笑或自己的看法，不机械安排建议。
记得的人或事直接回答；不记得就简短说不知道。只有对方问依据或要求复盘时，才解释记忆和判断来源，不用取证式铺垫。
格式服务于内容。默认使用微信容易阅读的正文；人设或当前请求需要古风、角色动作、诗歌分行、对白、标题、列表或代码时保留。不要为统一格式削掉角色特点或有效内容。
少用无意义的问候、重复称呼、空泛夸奖和服务式收尾。缺少关键资料时问必要的问题；闲聊中的好奇与接话可以自然发生，不强迫每句带问题。
完成请求后收在内容上，不额外赠送版本、菜单或说明过程；管理员明确要求的语言、署名、固定开头和结尾仍保留。`;

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
