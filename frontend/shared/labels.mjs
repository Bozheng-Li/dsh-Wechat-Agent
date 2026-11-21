export const stateLabels = {
  queued: '等待处理',
  generating: '正在生成',
  sending: '等待微信回执',
  sent: '微信已确认',
  cancelled: '已取消',
  failed: '处理失败',
  unknown: '发送结果不明',
  partial: '部分已确认',
  skipped: '未触发回复',
  observed: '已读取',
  waiting: '等待参与',
};

export const loginLabels = {
  idle: '尚未登录',
  requesting: '正在获取二维码',
  waiting: '请用手机微信扫码',
  scanned: '已扫码，请在手机确认',
  confirmed: '正在认证',
  authenticating: '正在认证',
  'session-ready': '正在连接微信',
  connecting: '正在连接微信',
  expired: '二维码已过期',
  cancelled: '登录已取消',
  failed: '登录失败',
  offline: '微信离线',
  online: '微信已连接',
};

export const modeLabels = { default: '默认回复', nickname: '昵称唤醒', participate: '参与群聊（旧版按消息）', natural: '参与群聊' };

export const groupReplyModes = [
  ['default', '默认回复', '群内 @ 当前微信账号，或以 /agent 开头提问时回复。'],
  ['nickname', '昵称唤醒', '在默认回复基础上，增加 Agent 名字与昵称唤醒。'],
  ['natural', '参与群聊', '保留全部直接唤醒；下方明确选择新消息、冷场和接续机会，由模型判断是否值得参与。'],
];

export const pageLabels = {
  traces: '任务执行轨迹',
  diagnostics: '运行检查',
  recovery: '发送恢复',
  'memory-review': '记忆维护',
  digests: '群聊简报',
  overview: '概览',
  authorization: '会话授权',
  records: '处理记录',
  settings: '设置',
  automation: '自动功能',
  time: '时间设置',
  administrators: '管理员与远程查询',
  model: '模型设置',
  'image-generation': '图片生成',
  identity: '全局身份',
  persona: '默认助手',
  storage: '数据目录',
  conversation: '会话设置',
  changelog: '更新日志',
  memory: '记忆库',
  tasks: '定时任务',
  work: '工作任务',
  moments: '朋友圈',
  assets: '表情与图片素材',
};
