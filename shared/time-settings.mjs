import { ChannelError } from './contracts.mjs';

const number = (key, label, min, max, help = '', nullable = false) => ({ key, label, type: 'number', min, max, help, nullable });
const time = (key, label) => ({ key, label, type: 'time' });
export const TIME_FIELDS = {
  runtime: [
    number('conversationTimeoutSeconds', '聊天与会话记忆处理超时（秒）', 10, 3600),
    number('searchTimeoutSeconds', '单次联网搜索超时（秒）', 5, 600),
    number('momentsReplyTimeoutMinutes', '朋友圈定时回复总超时（分钟）', 1, 1440),
    number('momentsLikeTimeoutMinutes', '朋友圈点赞总超时（分钟）', 1, 1440),
    number('momentsPublishTimeoutMinutes', '朋友圈发布总超时（分钟）', 1, 1440, '包含取材、正文、配图和发布；为纯文字回退预留最多 5 分钟。'),
    number('momentsMaterialTimeoutMinutes', '朋友圈素材整理超时（分钟）', 1, 1440),
    number('momentsImageTimeoutMinutes', '朋友圈素材图片处理超时（分钟）', 1, 1440),
    number('momentsInteractionReadTimeoutSeconds', '朋友圈互动读取超时（秒）', 10, 3600),
    number('momentsCommentTimeoutMinutes', '朋友圈互动评论生成超时（分钟）', 1, 1440),
    number('momentsInteractionTimeoutMinutes', '朋友圈互动执行超时（分钟）', 1, 1440),
    number('manualInteractionIntervalSeconds', '手动朋友圈互动逐条间隔（秒）', 0, 60),
    number('manualInteractionLookbackDays', '手动朋友圈互动查看最近天数', 0, 30, '0 表示不限时间。'),
  ],
  role: [number('intervalMinutes', '角色卡整理间隔（分钟）', 1, 10080, '选择按时间整理时生效；没有新增消息时跳过。'), number('timeoutMinutes', '角色卡每次整理超时（分钟）', 1, 1440)],
  work: [number('commandTimeoutSeconds', '工作命令执行超时（秒）', 1, 300)],
  memory: [number('retentionDays', '记忆默认保留天数', 1, 36500, '用于后续新增的会话和长期记忆。')],
  images: [number('retentionDays', '图片记忆保留天数', 1, 36500, '留空表示长期保存。', true)],
  provider: [number('timeoutSeconds', '生图接口调用超时（秒）', 10, 3600, '接口请求与图片下载共用此时限。')],
  natural: [
    { key: 'intervalMode', label: '自然陪聊检查方式', type: 'select', options: [['random', '区间内随机'], ['fixed', '固定间隔']] },
    number('minMinutes', '自然陪聊最短检查间隔（分钟）', 1, 1440),
    number('maxMinutes', '自然陪聊最长检查间隔（分钟）', 1, 1440),
    number('fixedMinutes', '自然陪聊固定检查间隔（分钟）', 1, 1440),
    number('followupSeconds', '连续对话窗口（秒）', 0, 600, '0 表示关闭连续接话。'),
    number('minGapMinutes', '主动发言最短间隔（分钟）', 1, 60),
    { key: 'activeHours', label: '只在活跃时段主动参与', type: 'checkbox' },
    time('startTime', '活跃时段开始 · 北京时间'), time('endTime', '活跃时段结束 · 北京时间'),
  ],
  replies: [number('intervalMinutes', '评论抓取间隔（分钟）', 1, 1440), number('lookbackDays', '评论处理最近天数', 1, 365)],
  likes: [number('intervalMinutes', '好友点赞检查间隔（分钟）', 5, 1440), number('lookbackDays', '好友点赞查看最近天数', 1, 30)],
  interactions: [number('intervalMinutes', '自动互动检查间隔（分钟）', 5, 1440), number('lookbackDays', '自动互动查看最近天数', 1, 30), number('intervalSeconds', '自动互动逐条间隔（秒）', 0, 60)],
  materials: [number('intervalMinutes', '朋友圈素材整理间隔（分钟）', 15, 1440)],
  publishing: [number('minGapMinutes', '自动发布最短间隔（分钟）', 0, 1440), time('automatic.startTime', '自动安排开始时间'), time('automatic.endTime', '自动安排结束时间'),
    { key: 'automatic.timezone', label: '自动安排时区', type: 'text', help: '例如 Asia/Shanghai。' }, number('automatic.content.graceMinutes', '自动安排允许延迟发布（分钟）', 1, 1440)],
  plan: [number('graceMinutes', '此计划允许延迟发布（分钟）', 1, 1440, '超过此时限跳过旧时段，不补发。')],
};

export const TIME_DEFAULTS = Object.freeze({ conversationTimeoutSeconds: 180, searchTimeoutSeconds: 45, momentsReplyTimeoutMinutes: 5, momentsLikeTimeoutMinutes: 5,
  momentsPublishTimeoutMinutes: 60, momentsMaterialTimeoutMinutes: 30, momentsImageTimeoutMinutes: 5,
  momentsInteractionReadTimeoutSeconds: 90, momentsCommentTimeoutMinutes: 5, momentsInteractionTimeoutMinutes: 30,
  manualInteractionIntervalSeconds: 3, manualInteractionLookbackDays: 7 });

export const timeValue = (value, key) => key.split('.').reduce((current, part) => current?.[part], value);
export const preserveTimeValues = (kind, draft, current) => withTimeValues(draft,
  Object.fromEntries(TIME_FIELDS[kind].filter(field => timeValue(current, field.key) !== undefined).map(field => [field.key, timeValue(current, field.key)])));
export function assertOnlyTimeChanges(kind, next, previous) {
  if (JSON.stringify(preserveTimeValues(kind, next, previous)) !== JSON.stringify(previous))
    throw new ChannelError('INVALID_TIME_SETTINGS', '此入口只能修改时间设置');
}
export function withTimeValues(original, values) {
  const next = structuredClone(original);
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split('.'), last = parts.pop();
    const parent = parts.reduce((current, part) => current[part], next);
    parent[last] = value;
  }
  return next;
}
export function validateTimeValues(kind, values) {
  const fields = TIME_FIELDS[kind];
  if (!fields || !values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length || Object.keys(values).some(key => !fields.some(field => field.key === key)))
    throw new ChannelError('INVALID_TIME_SETTINGS', '时间设置包含不支持的字段');
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) continue;
    const value = values[field.key];
    const valid = field.type === 'number' ? field.nullable && value === null || Number.isSafeInteger(value) && value >= field.min && value <= field.max
      : field.type === 'checkbox' ? typeof value === 'boolean'
      : field.type === 'select' ? field.options.some(([option]) => option === value)
      : field.type === 'time' ? typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
      : typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
    if (!valid) throw new ChannelError('INVALID_TIME_SETTINGS', field.label + '的值无效');
  }
  return values;
}
export function timeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChannelError('INVALID_TIME_SETTINGS', '请提供有效的时间设置');
  validateTimeValues('runtime', { ...TIME_DEFAULTS, ...input });
  return { ...TIME_DEFAULTS, ...input };
}
export function timeLimitMs(store, key) {
  const value = store?.config?.data?.timeSettings?.[key] ?? TIME_DEFAULTS[key];
  return value * (key.endsWith('Minutes') ? 60000 : 1000);
}
export const timeDurationLabel = ms => ms % 3600000 === 0 ? (ms / 3600000) + ' 小时' : (ms / 60000) + ' 分钟';
export function timeOperationTimeoutMs(settings, endpoint) {
  const keys = {
    'moments.plans.preview': 'momentsPublishTimeoutMinutes', 'moments.drafts.publish': 'momentsPublishTimeoutMinutes',
    'moments.drafts.reconcile': 'momentsPublishTimeoutMinutes', 'moments.write': 'momentsPublishTimeoutMinutes',
    'moments.materials.organize': 'momentsMaterialTimeoutMinutes', 'moments.materials.describe': 'momentsImageTimeoutMinutes',
    'moments.materials.generate': 'momentsImageTimeoutMinutes', 'moments.materials.download': 'momentsImageTimeoutMinutes',
    'moments.likes.run': 'momentsLikeTimeoutMinutes', 'moments.interactions.preview': 'momentsInteractionReadTimeoutSeconds',
    'moments.interactions.generate': 'momentsCommentTimeoutMinutes',
  };
  const key = keys[endpoint];
  if (!key) return 300000;
  return timeLimitMs({ config: { data: { timeSettings: settings } } }, key) + 15000;
}
