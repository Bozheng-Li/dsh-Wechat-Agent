import { CAPABILITY_SUMMARIES } from '../../prompts/agent/capabilities.mjs';

const groupOf = name => {
  if (['wechat_memory', 'wechat_role_card'].includes(name)) return 'memory';
  if (['wechat_read_image', 'wechat_image_memory', 'wechat_generated_image_memory'].includes(name)) return 'images';
  if (name === 'wechat_web_search') return 'search';
  if (name === 'wechat_task') return 'reminders';
  if (['wechat_reply_media', 'wechat_sticker_read', 'wechat_sticker_send'].includes(name)) return 'media';
  if (name === 'wechat_moments_like_recent') return 'moments-like';
  if (name === 'wechat_moments_interact') return 'moments-interact';
  if (['wechat_moments_read', 'wechat_moments_images', 'wechat_moments_comments', 'wechat_moments_audience'].includes(name)) return 'moments-read';
  if (['wechat_moments_plan', 'wechat_moments_draft', 'wechat_moments_reply_schedule', 'wechat_moments_material_search', 'wechat_moments_material_download'].includes(name)) return 'moments-plan';
  if (name.startsWith('wechat_moments_')) return 'moments-write';
  if (['wechat_work_start', 'wechat_work_continue', 'wechat_work_cancel', 'wechat_work_task', 'wechat_work_tasks', 'wechat_work_history', 'wechat_work_parallel'].includes(name)) return 'work-sessions';
  if (['wechat_work_status', 'wechat_work_ssh_connect', 'wechat_work_ssh_exec', 'wechat_work_vscode_connect'].includes(name)) return 'connections';
  if (name === 'wechat_work_generate_image') return 'image-generation';
  return null;
};

const triggers = {
  memory: /上次|之前|以前|记得|说过|来着|约定|约好|我们约|偏好|喜好|称呼|叫我|角色卡|过敏|忌口|习惯|更正|冲突|聊过|聊天记录|我们的聊天|根据.{0,8}(?:聊天|印象)|remember|previous|recall/iu,
  images: /图片|截图|照片|这张|那张|看图|画面|image|photo|screenshot/iu,
  search: /搜索|查一下|查查|查找|联网|最新|新闻|天气|核实|核对|查证|证据|来源|论文|研究|对比|比较|政策|法规|指南|版本|价格|医学|法律|金融|search|browse|latest|research|evidence|compare/iu,
  reminders: /提醒|定时|闹钟|remind|alarm/iu,
  media: /表情包|素材|发.{0,6}(?:图片|张图)|sticker/iu,
  'moments-like': /点赞|点.{0,5}赞|赞一下|赞下|求赞|\blike\b/iu,
  'moments-interact': /(?:朋友圈|动态).{0,20}(?:随机|几条|批量|点赞|评论|互动|自动|定时|间隔)|(?:随机|批量|互动|点赞|评论|自动|定时|间隔).{0,20}(?:朋友圈|动态)|刷朋友圈/u,
  'moments-read': /朋友圈|动态|moments/iu,
  'moments-write': /(?:发布|发条|发一条|点赞|评论|删除|回复).{0,10}(?:朋友圈|动态)|(?:朋友圈|动态).{0,10}(?:发布|点赞|评论|删除|回复)/u,
  'moments-plan': /(?:自动|定时|计划|草稿).{0,12}(?:朋友圈|动态)|(?:朋友圈|动态).{0,12}(?:自动|定时|计划|草稿)/u,
  'work-sessions': /任务|并行|继续|取消|进度|task|parallel/iu,
  connections: /SSH|远程|服务器|VS\s*Code|远端/iu,
  'image-generation': /生图|生成.{0,8}(?:图|海报)|画一|画个|generate.{0,12}image/iu,
};

/** Keyword matches only preload already authorized tools. Every missed group
 * remains discoverable; neither matching nor loading grants execution rights. */
export function planProgressiveTools(definitions, text = '') {
  const initial = [], deferred = new Map();
  for (const tool of definitions) {
    const id = groupOf(tool.name);
    if (!id || tool.name === 'wechat_sticker_read' || tool.name === 'wechat_sticker_send' || triggers[id]?.test(text)) initial.push(tool);
    else {
      if (!deferred.has(id)) deferred.set(id, { id, summary: CAPABILITY_SUMMARIES[id], tools: [] });
      deferred.get(id).tools.push(tool);
    }
  }
  return { initial, deferredGroups: [...deferred.values()] };
}
