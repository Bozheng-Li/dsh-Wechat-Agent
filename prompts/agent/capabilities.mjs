export const CAPABILITY_SUMMARIES = Object.freeze({
  memory: '查询当前会话旧事实、约定和偏好',
  images: '读取当前或历史图片的笔记，必要时核对画面',
  search: '搜索最新公开资料及来源',
  reminders: '管理当前会话明确要求的定时提醒',
  media: '选择图片或表情素材回复',
  'moments-read': '读取朋友圈、评论和可见范围名单',
  'moments-write': '按明确请求点赞、评论、回复、发布或删除朋友圈',
  'moments-plan': '管理朋友圈自动发布、草稿和定时评论计划',
  'work-sessions': '查看、继续、创建、取消或并行调度工作任务',
  connections: '查询远端状态，连接 SSH 或编辑器',
  'image-generation': '按要求生成图片',
});

export function capabilityCatalog(groups, execute) {
  return { name: 'wechat_capabilities',
    description: '按需加载本轮已授权能力的完整工具定义。已显示的工具可直接用；需要以下能力而工具尚未显示时，选择模块编号加载，再按新工具参数执行。加载本身不执行操作、不授予权限。普通闲聊无需加载。\n' +
      groups.map(group => `${group.id}: ${group.summary}`).join('\n'),
    parameters: { type: 'object', properties: { modules: { type: 'array', items: { type: 'string', enum: groups.map(group => group.id) }, minItems: 1, maxItems: groups.length } }, required: ['modules'], additionalProperties: false },
    execute };
}
