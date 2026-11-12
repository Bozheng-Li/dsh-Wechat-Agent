export const CAPABILITY_SUMMARIES = Object.freeze({
  memory: '查询聊天记录与全局人物角色卡：同一人在私聊、群聊和朋友圈共用称呼、喜好和长期资料；可按需读取或安排后台 Agent 更新，聊天继续进行。当前输入没答案时先加载并查询，未查询不能声称没有记录',
  images: '分别查找会话图片与自己生成的图片；微信引用缺图也可读取已保存的生成图，必要时核对实际画面',
  search: '复杂、专业、需多源核验或有时效性的公开事实先联网查证，保留来源；默认接口不可用时自动回退另一个已配置接口一次',
  reminders: '管理当前会话明确要求的定时提醒',
  media: '读取自己表情库的含义和适用情景，再选择一张原生表情或图片自然回复；是否需要表情由模型按语境判断',
  'moments-like': '响应本条明确求赞：按原话与上下文确定动态作者，先读取再点赞；普通成员限本人，管理员可指定其他好友或机器人账号',
  'moments-interact': '管理员朋友圈互动：手动最近/随机/手选点赞评论；也可按明确请求设置自动检查间隔、最近几天、赞评各几条及跳过已赞已评，查看状态或停用',
  'moments-read': '读取朋友圈、实际图片、评论和可见范围名单；纯点赞无需读图，需要生成图片动态的评论时先读图',
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
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute };
}
