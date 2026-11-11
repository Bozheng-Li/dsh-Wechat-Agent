import { ChannelError } from './contracts.mjs';

const action = /点赞|点(?:一|个|一下|一个|[一二两三四五1-5]个)?赞|赞(?:一下|一个|下)|求(?:个)?赞|\blike\b/iu;
const normalized = value => typeof value === 'string' ? value.normalize('NFKC').trim() : '';

// This only recognizes a current-message request. Quoted examples, retrieved
// posts and old messages are never passed here as an authorization source.
function unquoted(value) {
  return normalized(value).replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g, '')
    .replace(/^\s*>.*$/gmu, '');
}
function clauses(value) {
  return unquoted(value)
    .split(/[。！？!?；;\n]/u).map(text => text.trim()).filter(text => text && !text.startsWith('>'));
}

function direct(text) {
  if (!action.test(text) || /如何|怎么|怎样|教程|实现|功能|工具|代码|脚本|机制|原理|比如|例如|假设|假如|如果|转述|转发|有人说|他说|她说|朋友说|对方说/iu.test(text)) return false;
  if (/(?:不要|别|不许|不用|无需|不需要|不必|不想|禁止|取消|停止|(?:没|没有|未|从未)(?:让|叫|要求|请求)).{0,40}(?:点赞|点.{0,4}赞|赞一下|赞下)|(?:do not|don't|stop).{0,15}\blike\b/iu.test(text)) return false;
  if (!/朋友圈|动态|moments/iu.test(text) && /视频|文章|回答|方案|评论|微博|抖音|小红书|公众号|知乎|B站/iu.test(text)) return false;
  return /(?:帮|替|给|请|麻烦|能不能|可以|求).{0,40}(?:点赞|点.{0,5}赞|赞(?:一下|下|一个))|(?:朋友圈|动态).{0,20}(?:点赞|点.{0,5}赞|赞一下|求(?:个)?赞)|(?:点赞|赞一下|赞下).{0,15}(?:我|朋友圈|动态)|(?:please|can you|could you|help).{0,20}\blike\b.{0,30}(?:my|post|moments)/iu.test(text);
}

export function isMomentsLikeRequest(value) {
  const text = unquoted(value), firstAction = text.search(action);
  if (firstAction < 0) return false;
  // A forwarding heading can introduce several sentences without quote marks.
  // Past requests are context, not a fresh instruction to repeat the action.
  if (/转述|转发|引用|复述|原话|消息内容|(?:这是|以下是).{0,24}(?:消息|聊天|对话)|(?:昨天|前天|刚才|之前|以前|上次|当时|曾经|原先|早先|先前|刚刚).{0,12}(?:说|讲|提到|问过|请求过|要求过).{0,30}(?:点赞|点.{0,4}赞|赞一下|赞下)/u.test(text)) return false;
  const after = text.slice(firstAction);
  // A later standalone withdrawal cancels an earlier request in this message.
  // "不用评论" keeps the like request; "算了不用了" withdraws the action.
  if (/算了|撤回(?:刚才的)?(?:请求|指令)|取消(?:刚才的)?(?:点赞|请求|指令)|(?:别|不要|不用|无需|不必|不需要|暂停|停止)(?:再|先|马上|立即|继续)?(?:操作|执行|动手|行动|处理|开始|提交)|(?:[。！？!?；;，,\n])\s*(?:不用了|不要了|别点(?:赞)?了|不点(?:赞)?了|不用(?:再)?点(?:赞)?了|不要(?:再)?点(?:赞)?了)(?:[。！？!?；;，,\s]|$)/u.test(after)) return false;
  return clauses(value).some(direct);
}

export function isSelfMomentsLikeRequest(value) {
  if (!isMomentsLikeRequest(value)) return false;
  return clauses(value).some(text => direct(text) &&
    !/(?:帮我|替我).{0,5}给(?!我)|(?:给|帮|替)(?:他|她|别人|朋友)|(?:他的|她的|别人的)/u.test(text) &&
    (/我的(?:最新|最近|刚发的|刚发|这条|那条|[一二两三四五1-5]条)*(?:朋友圈|动态)|(?:帮我|给我|替我)(?:在|的|去|把|最近|最新|刚发的|刚发|那|这|条|个|一|二|两|三|四|五|[1-5]|朋友圈|动态|点|个|小|一下|一波|\s)*(?:点赞|赞)|(?:赞一下|赞下|点赞)我|(?:朋友圈|动态).{0,12}求(?:个)?赞|\blike\b.{0,8}\bmy\b/iu.test(text)));
}

export function momentsLikeRequestCount(value) {
  const text = clauses(value).filter(direct).join(' ');
  const match = /(?:最近|最新|前|这|那)?\s*([一二两三四五六七八九十]|\d{1,3})\s*(?:条|篇|个赞)/u.exec(text) || /点\s*([一二两三四五六七八九十]|\d{1,3})\s*个?赞/u.exec(text);
  if (!match) return 1;
  return Number(match[1]) || { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[match[1]];
}

export function momentsLikeRequestArgs(input = {}, requestText) {
  if (/随机|抽(?:取|选)|\brandom\b|\bshuffle\b/iu.test(clauses(requestText).filter(direct).join(' ')))
    throw new ChannelError('MOMENTS_LIKE_SELECTION_UNSUPPORTED', '这条请求要求随机挑选，不能改成最新动态；管理员请用朋友圈分轮互动工具按实际范围处理');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['subject', 'user', 'count'].includes(key)) ||
      input.subject !== undefined && (!['speaker', 'account', 'contact'].includes(input.subject) || input.subject !== 'contact' && input.user !== undefined || input.subject === 'contact' && !input.user) ||
      input.user !== undefined && (typeof input.user !== 'string' || !input.user.trim() || input.user.length > 150))
    throw new ChannelError('MOMENTS_LIKE_REQUEST_INVALID', '请选择请求者本人或一个明确好友，使用最新动态数量，不填写动态编号');
  const requested = momentsLikeRequestCount(requestText), count = input.count ?? requested;
  if (!Number.isInteger(count) || count < 1 || count > 5 || count > requested || /所有|全部|\ball\b/iu.test(clauses(requestText).filter(direct).join(' ')))
    throw new ChannelError('MOMENTS_LIKE_REQUEST_INVALID', '单次可点赞明确要求的最新 1–5 条；未指定数量时只处理最新一条，不扩大数量或自动遍历全部动态');
  return { user: input.subject === 'account' ? '机器人' : input.subject === 'speaker' ? '发起人' : normalized(input.user || '发起人'), count,
    ...(input.subject === undefined ? {} : { subject: input.subject }) };
}
