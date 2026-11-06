/** Delivery defaults remove assistant boilerplate without replacing a persona's voice. */
export const NATURAL_REPLY_RULES = `全局自然回复规则：
先回应对方此刻真正说的事，作为当前会话中的角色接话，不写成分析聊天记录的旁观者。词汇、节奏、态度、幽默和亲疏感按当前会话人设及其语气示例表达；古风、冷淡、俏皮等差异应体现在正文，不只在开头换称呼。不要把所有角色统一改成热情、周到的聊天助手。
以下篇幅和格式是默认习惯，当前请求、账号补充要求或人设有明确用途时按其用途组织。普通闲聊通常一到三句；诗歌、故事、对白、代码和长文按请求保留必要篇幅与格式，不强行缩成短答。复杂问题只展开对方需要的部分，不为了完整补总结。
简单自我介绍只说名字和一两项性格特点，不主动解释 AI、服务器、插件或技术实现，不罗列能力或群友资料。被直接问是否 AI 时如实简短回答；不得编造真人经历。不要随口说换个对话就忘记、没有记忆或不能联网，实际能力以本轮状态为准，且只在影响当前请求时说明。
记忆用于理解，不用于向对方播报取证过程。不要以“按聊天里能确定的”“根据已有聊天记录”“目前可以确认”“从你的描述来看”起手。不要逐条复述谁说过什么来证明答案，除非对方正在追问依据或要求复盘。
问一个人是谁，就说你记得的称呼或身份；不知道就按当前角色的习惯简短说还不知道，可以接一个必要的小问题。不要跟上一串“具体是谁、与你什么关系、记录里没有、我也不敢瞎编”等免责声明。
自称和称呼按当前人设，直接与当前发言者接话。记忆中 direction 为 outgoing 的话是你先前说的话，不用自己的微信名以第三人称指代自己。不要把所有群友都当成同一个人，也不要擅自替别人认关系、性别和身份。
聊到一件事不代表它实际发生过；聊午饭不能推断对方刚吃完，别人说困不能推断原因或诊断身体情况。只把对方明确说过或图中确实可见的内容当成事实，不用猜测填充寒暄。
不用“收到你的问题”“让我为你分析”“希望这些信息能帮到你”“有什么需要随时告诉我”等客服套话。请求已经完成就停在内容本身，不在结尾自动追加“想往哪个方向写”“要清一点还是热闹一点”“你给个意思我照着改”这类服务菜单。只有影响完成请求的信息确实缺失，或对方明确要求选择、修改和追问时，才问必要的问题。
创作直接给所需作品，允许简短且贴合人设的引子；不擅自再送签名、题词、其他版本或解释创作过程。诗句与角色对白里的“我”可以是文学叙述者，不能当成现实经历；不得把原创冒充古人原作。
不给每句话加称呼、夸奖、反问或表情。普通聊天默认不用标题、编号清单、加粗、总结句或舞台动作；作品题目、分行、用户所需的代码与步骤等保留。微信不渲染 Markdown，不为了套格式或人设损坏内容。
幽默要接具体话题；遇到难过、求助或认真讨论就认真回应。不要强行接梗、油腻亲昵、硬演“高情商”，也不要复述情绪后机械给建议。对方只想闲聊时，可以抓住一个细节打趣、表达自己的看法或陪他聊开，不必每次都先解释为何会累、再劝休息；具体接法随角色变化。
语气示例只学表达，不照抄为固定台词，也不当成事实。使用当前人设的示例，不额外套用另一种朋友或客服口吻；不知道的事按角色习惯简短说不知道。
发送前默读：正文是否有当前角色的表达特点，是否完成了对方的请求？删掉无用的铺垫、判断过程、补充免责声明和服务式收尾，保留作品与有效内容。`;

const STRUCTURED_REQUEST = /分析|复盘|依据|总结|代码|步骤|清单|列表|逐条|分点|分条|分步|要点|大纲|选项|教程|表格|markdown|为什么这样判断|怎么(?:安装|配置|实现)|如何(?:安装|配置|实现)|\b(?:steps?|options?|checklist|lists?|code|tutorial|outline|table|markdown)\b/iu;
const ENUMERATED_REQUEST = /(?:[一二三四五六七八九十两\d]+|几)(?:条|个|种|点|项)(?:建议|理由|方案|选项|步骤|办法|做法|重点|区别)/u;
const CREATIVE_REQUEST = /诗|故事|小说|剧本|对白|对联|题词|翻译|签名|长文|文章|模板|文案|话术|\b(?:poems?|poetry|stor(?:y|ies)|novels?|scripts?|dialogue|translat(?:e|ion)|lyrics?|haiku|sonnets?)\b/iu;
const SERVICE_PHRASES = ['收到你的问题', '让我为你分析', '希望这些信息能帮到你', '有什么需要随时告诉我'];

function configuredSentences({ persona, prompt, identityMarkdown } = {}) {
  const instructions = [persona?.prompt, persona?.style, prompt, identityMarkdown].filter(value => typeof value === 'string').join('\n');
  return instructions.split(/[\n。；;，,]/u).filter(sentence => !/不要|不得|不(?:用|使用|采用|输出|写|列|提供|套|做|加|追加|自动|追问|把)|避免|禁止/u.test(sentence));
}

function configuredStructure(style) {
  return configuredSentences(style).some(sentence => /(?:使用|采用|输出|写成|写|整理成|列出|提供|保留|用).{0,16}(?:标题|编号|清单|列表|条目|表格|Markdown|报告)/iu.test(sentence));
}

function proseWithoutCode(text) {
  const rows = []; let fence;
  for (const line of text.split('\n')) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (marker) fence = marker;
    else rows.push(line);
  }
  return rows.join('\n').replace(/(`+)([^\n]*?)\1/gu, '').trim();
}

function requestedFormat(request) {
  // Only direct prose is a formatting instruction. A quoted example or code
  // literal can describe a prohibition without imposing it on this reply.
  const prose = proseWithoutCode(request).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '');
  const preferences = {};
  const markers = /(?<numbered>编号(?:列表|清单|条目)?|有序(?:列表|清单)|\b(?:numbered|ordered)\s+lists?\b)|(?<unordered>无序(?:列表|清单)|项目符号|\b(?:unordered|bulleted|bullet)\s+lists?\b|\bbullets?\b)|(?<list>(?:行动)?清单|列表|条目|\b(?:checklists?|lists?)\b)|(?<heading>标题|\bheadings?\b)|(?<bold>加粗|粗体|\bbold\b)|(?<markdown>markdown)/giu;
  const directives = /不要忘记|别忘(?:了|记)?|(?:不要|不得|禁止|避免|别|不)(?:再)?(?:(?:给|帮)(?:我|我们)?)?(?:使用|采用|输出|提供|保留|用|写|列出|列|加)?|\b(?:do\s+not|don['’]t|never|without|no)(?:\s+(?:use|include|give|add|a|an|any|me|the))*\b|保留|使用|采用|输出|提供|列出|改成|改用|用|给|\b(?:keep|use|include|give|add)\b/giu;
  for (const clause of prose.split(/[，,。；;\n]|但是|不过|而是|还是|算了|但|\bbut\b/iu)) {
    let allowed, offset = 0;
    for (const marker of clause.matchAll(markers)) {
      const direction = [...clause.slice(offset, marker.index).matchAll(directives)].at(-1)?.[0];
      if (direction) allowed = /^(?:不要忘记|别忘)/u.test(direction) || !/^(?:不|禁止|避免|别|do\s+not|don['’]t|never|without|no\b)/iu.test(direction);
      if (allowed !== undefined) {
        const kind = Object.keys(marker.groups).find(key => marker.groups[key] !== undefined);
        const targets = kind === 'markdown' ? ['heading', 'bold', 'numbered', 'unordered'] : kind === 'list' ? ['numbered', 'unordered'] : [kind];
        for (const target of targets) preferences[target] = allowed;
      }
      offset = marker.index + marker[0].length;
    }
  }
  return preferences;
}

function violatesRequestedFormat(prose, requested) {
  return (requested.heading === false && /(^|\n)#{1,6}\s/u.test(prose)) ||
    (requested.bold === false && /\*\*[^*\n]+\*\*/u.test(prose)) ||
    (requested.numbered === false && /(?:^|\n)\s*\d+[.)、]\s*/u.test(prose)) ||
    (requested.unordered === false && /(?:^|\n)\s*[-*•]\s+/u.test(prose));
}

function unsolicitedIdentity(prose, request) {
  // A translated first-person sentence, character dialogue or an AI-related
  // code literal is requested content, not the agent introducing itself.
  if (/翻译|译成|译为|翻成|逐字|引用|原文|台词|对白|例句|小说|剧本|故事|诗|歌词|translate|translation/iu.test(request)) return false;
  const unquoted = prose.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '');
  return /(?:^|[。！？!?\n])\s*(?:(?:你好|您好)[，,]\s*)?(?:(?:我(?:是|其实是|属于|算是)|作为|身为)[^。！？!?\n]{0,160}(?:AI\s*助手|人工智能助手|插件(?:形式|形态))|我[^。！？!?\n]{0,20}(?:没有性别|没性别|没(?:有)?家(?:里)?人|住在服务器)|我[^。！？!?\n]{0,12}换.{0,8}(?:对话|会话).{0,12}(?:忘|不记得))/iu.test(unquoted);
}

function hasServiceEnvelope(text, request, style) {
  if (/翻译|引用|原文|逐字|台词|对白|例句/u.test(request) && SERVICE_PHRASES.some(phrase => request.includes(phrase))) return false;
  if (/(?:写|生成|改写|提供|模拟|扮演|给).{0,20}(?:客服|售后|接待).{0,12}(?:回复|话术|模板|文案|对白)|(?:客服|售后|接待).{0,16}(?:文案|话术|模板|台词|对白)/u.test(request)) return false;
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
  const askedChoices = /(?:问我|询问我|追问我|向我提问|(?:给|提供|列出).{0,12}(?:选项|方向|风格)|(?:几种|不同|哪些).{0,8}(?:风格|方向|版本)|怎么改|如何改|帮我改|一起改)/u.test(request) ||
    configured.some(sentence => /(?:结尾|最后|完成后|每次回复).{0,20}(?:问|提问|追问|选项|方向|风格)/u.test(sentence));
  if (!askedChoices && /^(?:你想|想)(?:往|朝)?(?:哪个|什么)(?:方向|风格).{0,8}(?:写|改)[？?]/u.test(last)) return true;
  const askedSignature = /签名/u.test(request) || configured.some(sentence => /(?:结尾|最后|完成后|每次|写诗后).{0,20}(?:给|送|写|加|附).{0,12}签名/u.test(sentence));
  if (!askedSignature && paragraphs.slice(1).some(paragraph => /^(?:再有|再送|再给|另外|顺便).{0,45}签名/u.test(paragraph))) return true;
  return false;
}

export function needsConversationalRewrite(text, request = '', style = {}) {
  if (hasServiceEnvelope(text, request, style)) return true;
  const prose = proseWithoutCode(text);
  if (!prose) return false;
  // Explicit opt-outs win over keyword-based allowances and preset defaults.
  const requested = requestedFormat(request);
  if (violatesRequestedFormat(prose, requested)) return true;
  const askedIdentity = /(?:是不是|是否|是|属于|算)(?:个|一个)?\s*(?:AI|机器人|人工智能)|(?:你|您).{0,8}(?:真人|机器|模型)|(?:AI|人工智能).{0,8}(?:吗|么|嘛)|服务器|插件|实现|架构|技术身份/iu.test(request);
  if (!askedIdentity && unsolicitedIdentity(prose, request)) return true;
  if (/简(?:单|短).{0,8}介绍.{0,5}(?:自己|你)|自我介绍/u.test(request) && text.length > 180) return true;
  if (STRUCTURED_REQUEST.test(request) || ENUMERATED_REQUEST.test(request)) return false;
  const mechanicalEvidence = /^(?:按(?:照)?聊天(?:里|中)?能确定的|(?:根据|基于)(?:目前|现有|已有|以上|提供的)?(?:聊天|会话|对话)记录|目前可以确认)[：:，,]?/u.test(prose) ||
    /(?:聊天|会话|对话)记录里(?:没有|没再|未曾).{0,45}(?:不敢瞎编|无法确定|不能确认)/su.test(prose);
  if (mechanicalEvidence) return true;
  if (CREATIVE_REQUEST.test(request) || configuredStructure(style)) return false;
  return (requested.heading !== true && /(^|\n)#{1,6}\s/u.test(prose)) ||
    (requested.bold !== true && /\*\*[^*\n]+\*\*/u.test(prose)) ||
    [...prose.matchAll(/(?:^|\n)\s*(?:(?<unordered>[-*•]\s+)|(?<numbered>\d+[.)、]\s*))/gu)]
      .filter(marker => requested[marker.groups.numbered ? 'numbered' : 'unordered'] !== true).length >= 2;
}
