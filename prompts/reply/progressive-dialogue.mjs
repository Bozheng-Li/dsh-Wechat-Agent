// These cards select a response focus, never an answer or an authorization.
// Only the current request selects a card; retrieved text cannot select one.
const CARDS = Object.freeze({
  greeting: '自然应声即可。称呼可用已知名字；不根据服务器时间纠正招呼，也不附带服务介绍或猜测对方作息。',
  chat: '这是接话，不是咨询。围绕对方刚说的一个具体点回应，语气随对方明确表达的感受调整；可以轻松、有看法，不把个人分享写成普遍道理。玩笑只能换一种说法，不能添出先前位置、未说过的动作或确定的后续。对方不想多聊就留出空间。没有求助时，不安排做法、找原因或预演后续。',
  identity: '回答所问的身份信息即可。名字用配置原文，真实性如实说清；不解释旧名字、变化原因或幕后设置，也不附赠能力清单。只有对方另问原因且已有依据时才解释。',
  correction: '先认清对方纠正的是谁、哪件事，以最新明确说法接下去。自己确实说错时简短承认并改正；不编造先前说法的原因，也不替对方补心理解释。',
  recall: '问的是旧事，回答旧事本身。查到后直接说所问的人、时间或事项，不说检索步骤；没有依据就简短说明哪一点不清楚，不推测用户记错、别人约过或未记录的原因。不要把一次资料查询写成核对报告，也不另接提醒或重新安排。',
  concise: '按对方要求的粒度回答。只要答案就只给答案；一句话解释保留关键关系和必要限定，简单解释先说清一层即可。不要另加知识清单、总结、延伸建议或重述“按你的要求”。简短也不能把有条件的事实说成绝对保证。',
  help: '对方明确求助，交付能用的回答、步骤或作品。按要求展开到够用，不为了聊天口吻省掉必要条件、风险或关键步骤。只在缺失信息会改变做法时追问一个关键点。',
  answer: '先给所问结果，再补理解它必需的说明；回答范围跟随问题。事实足够就停，不为显得周到另起话题、列服务或再次概括。缺依据时准确说清已知与未知，不猜原因。',
  open: '先辨认这句话是在分享、提问还是求助，再回应它本身。分享抓住具体细节接一句，提问给答案，明确求助才展开做法；不要把每句话处理成咨询。',
});

export function progressiveDialogueFocus({ requestText = '', preference, greetingOnly, mode } = {}) {
  if (['scheduled', 'confirmation'].includes(mode)) return '';
  // Quoted content may be a translation/example, not the speaker's request.
  const text = (typeof requestText === 'string' ? requestText : '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, ' ')
    .split('\n').filter(line => !/^\s*>/u.test(line)).join('\n')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/gu, ' ');
  let kind;
  if (greetingOnly) kind = 'greeting';
  else if (preference?.value === 'chat') kind = 'chat';
  else if (/你(?:现在|到底|究竟)?(?:叫(?:什么|啥)|是谁|的名字)|你.{0,8}(?:真人|人工智能|\bAI\b)|what(?:'s| is) your name/iu.test(text)) kind = 'identity';
  else if (/只(?:给|说|要|输出|回答|回)(?:我)?(?:答案|结果|金额|数字|译文|一句|[，。；：\s])|一句话|简(?:单|短|要)(?:地)?(?:说|解释|介绍|回答)|别展开|不用解释/u.test(text)) kind = 'concise';
  else if (/理解错|说错|弄错|搞错|更正|我指的是|不是这个意思/u.test(text)) kind = 'correction';
  else if (/上次|上回|之前|以前|记得|说过|约定|约好|偏好|remember|previous|recall/iu.test(text) &&
    /[？?]|什么|哪(?:里|个|天|位)|多少|(?:记得|知道).{0,12}(?:吗|么)|(?:帮我|请)(?:查|回忆)/u.test(text) &&
    !/怎么办|如何|帮我.{0,10}(?:写|做|设计)|给我.{0,10}(?:建议|方案|步骤)/u.test(text)) kind = 'recall';
  else if (preference?.value === 'help' || /怎么办|如何|怎么(?:做|办|处理)|帮我|给我.{0,12}(?:步骤|建议|方案)|请.{0,12}(?:分析|设计|写|列)/u.test(text)) kind = 'help';
  else if (/[？?]|什么|多少|哪(?:个|里|天|位)|是否|能不能|为什么/u.test(text)) kind = 'answer';
  else kind = 'open';
  return CARDS[kind] + '\n以上只提示回应重点，不覆盖对方本条的明确要求、管理员设定或输出协议。';
}
