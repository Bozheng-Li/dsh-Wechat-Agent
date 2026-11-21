import { ChannelError } from './errors.mjs';
import { personaText } from '../prompts/personas/text.mjs';
import { personaFromPreset } from '../prompts/personas/catalog.mjs';
import { validateDefaultAudience } from './moments-audience.mjs';
import manifest from "../package.json" with { type: 'json' };

export const CHANNEL = '/wechat-agent';
export const VERSION = manifest.version;
export const AGENT_WORKSPACE_NAME = '微信agent';
export const MAX_TEXT = 12000;
export const DEFAULT_TAVILY_URL = 'https://api.tavily.com';
export const DEFAULT_DEEPSEEK_URL = 'https://api.deepseek.com/anthropic/v1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';

export { ChannelError };

export function searchBaseURL(input = DEFAULT_TAVILY_URL, label = 'Tavily') {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new ChannelError('INVALID_SEARCH_CONFIG', `请输入 ${label} 服务的 HTTPS 地址。`);
  }
  if (
    typeof input !== 'string' ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    input.length > 2048
  )
    throw new ChannelError(
      'INVALID_SEARCH_CONFIG',
      `${label} 地址必须使用 HTTPS，且不能包含账号、密码、查询参数或片段。`
    );
  return url.href.replace(/\/+$/, '');
}

/** 朋友圈发布可见范围：自定义屏蔽名单（默认，不自动屏蔽）或仅授权好友可见。 */
export const PUBLISH_SCOPES = ['blocked-list', 'authorized'];
export const DEFAULT_PUBLISH_SCOPE = 'blocked-list';

export function validatePublishScope(value) {
  if (!PUBLISH_SCOPES.includes(value))
    throw new ChannelError(
      'INVALID_PUBLISH_SCOPE',
      '朋友圈可见范围只能是“自定义屏蔽名单”或“仅授权好友可见”，未保存'
    );
  return value;
}

/** Older accounts never stored a scope; keep their publisher audience unchanged. */
export const publishScopeOf = settings =>
  PUBLISH_SCOPES.includes(settings?.publishScope) ? settings.publishScope : DEFAULT_PUBLISH_SCOPE;

export function emptySettings() {
  return { enabled: false, privatePeers: [], groups: [], prompt: '', publishScope: DEFAULT_PUBLISH_SCOPE,
    defaultBlockedUserIds: [], defaultBlockedLabelIds: [] };
}

export function emptyPersona(identity) {
  return personaFromPreset(undefined, identity);
}
export { personaText } from "../prompts/personas/text.mjs";
export function validatePersona(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ChannelError('INVALID_PERSONA', '人设格式不正确');
  const field = (key, max, required = false) => {
    const value = input[key];
    if (
      typeof value !== 'string' ||
      value.length > max ||
      /\u0000/.test(value) ||
      (required && (!value.trim() || /[\r\n]/.test(value)))
    )
      throw new ChannelError('INVALID_PERSONA', `请检查人设中的${key === 'name' ? '名字' : '提示词'}，最多 ${max} 字`);
    return value.trim();
  };
  const name = field('name', 80, true);
  if (
    !Array.isArray(input.aliases) ||
    input.aliases.length > 12 ||
    input.aliases.some(
      (alias) => typeof alias !== 'string' || !alias.trim() || alias.length > 80 || /[\u0000-\u001f\u007f]/.test(alias)
    )
  )
    throw new ChannelError('INVALID_PERSONA', '昵称别名最多 12 个，每个 1–80 字，不能包含换行');
  const aliases = [...new Set(input.aliases.map((alias) => alias.trim()))];
  const extras = {};
  if (Object.hasOwn(input, 'personaMode')) {
    if (!['standard', 'high-precision'].includes(input.personaMode))
      throw new ChannelError('INVALID_PERSONA', '人设调用模式只能是标准模式或高精度模式');
    extras.personaMode = input.personaMode;
  }
  if (Object.hasOwn(input, 'prompt')) return { name, aliases, ...extras, prompt: field('prompt', 16000) };
  return {
    name,
    aliases,
    ...extras,
    background: field('background', 4000),
    personality: field('personality', 8000),
    style: field('style', 12000),
  };
}

export function validateGlobalPersona(input) {
  const persona = validatePersona(input);
  return personaText(persona).trim() ? persona : emptyPersona(persona);
}

/** Named personas: the owner can keep several and switch the active one. */
export const PERSONA_LIMIT = 12;
export const PERSONA_SOURCES = ['manual', 'distilled'];

export function validatePersonaEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ChannelError('INVALID_PERSONA', '人设条目格式不正确');
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.id))
    throw new ChannelError('INVALID_PERSONA', '人设编号无效');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
    throw new ChannelError('INVALID_PERSONA', '请填写人设名称，最多 80 字');
  const source = PERSONA_SOURCES.includes(input.source) ? input.source : 'manual';
  const createdAt = Number.isSafeInteger(input.createdAt) && input.createdAt >= 0 ? input.createdAt : 0;
  // Earlier builds stored source metadata; retain it as notes, never as approval.
  const provenance = input.provenance && typeof input.provenance === 'object' ? structuredClone(input.provenance) : undefined;
  return { id: input.id, name: input.name.trim(), source, createdAt,
    ...(Number.isSafeInteger(input.updatedAt) && input.updatedAt >= 0 ? { updatedAt: input.updatedAt } : {}),
    ...(provenance ? { provenance } : {}),
    persona: validateGlobalPersona(input.persona) };
}

export function validatePersonaList(input) {
  if (!Array.isArray(input) || input.length > PERSONA_LIMIT)
    throw new ChannelError('INVALID_PERSONA', `最多保留 ${PERSONA_LIMIT} 个人设`);
  const list = input.map(validatePersonaEntry);
  if (!list.length) throw new ChannelError('INVALID_PERSONA', '至少需要一个人设');
  if (new Set(list.map(entry => entry.id)).size !== list.length)
    throw new ChannelError('INVALID_PERSONA', '人设编号重复');
  return list;
}


export function validateModelConfig(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.maxTokens != null && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1))
  )
    throw new ChannelError('INVALID_MODEL_CONFIG', '最大输出 Token 应为正整数，留空使用模型的最大输出额度');
  if (
    input.temperature !== null &&
    (typeof input.temperature !== 'number' ||
      !Number.isFinite(input.temperature) ||
      input.temperature < 0 ||
      input.temperature > 2)
  )
    throw new ChannelError('INVALID_MODEL_CONFIG', '温度应在 0–2 之间，留空表示跟随模型默认');
  for (const key of ['vision', 'webSearch'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new ChannelError('INVALID_MODEL_CONFIG', '图像理解和联网搜索需要选择开启或关闭');
  const searchProvider = input.searchProvider ?? 'tavily';
  const promptStrategy = input.promptStrategy ?? 'legacy';
  if (!['legacy', 'progressive-v1'].includes(promptStrategy))
    throw new ChannelError('INVALID_MODEL_CONFIG', '请选择完整上下文或按需加载模式');
  if (!['dsh', 'deepseek', 'tavily'].includes(searchProvider))
    throw new ChannelError('INVALID_SEARCH_CONFIG', '请选择 DeepSeek 搜索或 Tavily。');
  const deepseekModel = String(input.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL).trim();
  if (!deepseekModel || deepseekModel.length > 120 || /\s/.test(deepseekModel))
    throw new ChannelError('INVALID_SEARCH_CONFIG', 'DeepSeek 搜索模型名称最多 120 字，不能包含空格');
  return {
    maxTokens: input.maxTokens ?? null,
    temperature: input.temperature,
    promptStrategy,
    vision: input.vision ?? true,
    visionModel: validateModelChoice(input.visionModel ?? null),
    webSearch: input.webSearch ?? false,
    searchProvider,
    tavilyBaseURL: searchBaseURL(input.tavilyBaseURL),
    deepseekBaseURL: searchBaseURL(input.deepseekBaseURL ?? DEFAULT_DEEPSEEK_URL, 'DeepSeek'),
    deepseekModel,
  };
}

export function emptyNaturalSettings() {
  return {
    // New participation starts with message opportunities only. Legacy mode
    // permissions are restored by conversationNaturalSettings, never by the UI.
    messageEnabled: true,
    timerEnabled: false,
    followupEnabled: false,
    temperament: 'balanced',
    intervalMode: 'random',
    minMinutes: 30,
    maxMinutes: 60,
    fixedMinutes: 30,
    smartSkip: true,
    followupSeconds: 120,
    maxUnanswered: 2,
    minGapMinutes: 3,
    activeHours: true,
    startTime: '09:00',
    endTime: '23:00',
  };
}

export function validateNaturalSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ChannelError('INVALID_NATURAL_SETTINGS', '群聊参与设置格式不正确');
  const value = { ...emptyNaturalSettings(), ...input };
  if (!['quiet', 'balanced', 'lively'].includes(value.temperament) || !['random', 'fixed'].includes(value.intervalMode))
    throw new ChannelError('INVALID_NATURAL_SETTINGS', '请选择参与性格和主动开话题的间隔方式');
  if (
    ['minMinutes', 'maxMinutes', 'fixedMinutes'].some(
      (key) => !Number.isInteger(value[key]) || value[key] < 1 || value[key] > 1440
    ) ||
    value.minMinutes > value.maxMinutes
  )
    throw new ChannelError('INVALID_NATURAL_SETTINGS', '主动间隔应为 1–1440 分钟的整数，最少分钟不能超过最多分钟');
  if (['messageEnabled', 'timerEnabled', 'followupEnabled', 'smartSkip', 'activeHours'].some(key => typeof value[key] !== 'boolean'))
    throw new ChannelError('INVALID_NATURAL_SETTINGS', '请选择参与触发、智能跳过和活跃时段是否开启');
  for (const [key, min, max, label] of [
    ['followupSeconds', 0, 600, '连续对话窗口（秒）'],
    ['maxUnanswered', 1, 5, '无人接话次数'],
    ['minGapMinutes', 1, 60, '主动发言最短间隔（分钟）'],
  ])
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new ChannelError('INVALID_NATURAL_SETTINGS', `${label}应为 ${min}–${max} 的整数`);
  if (
    ['startTime', 'endTime'].some(
      (key) => typeof value[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[key])
    ) ||
    (value.activeHours && value.startTime === value.endTime)
  )
    throw new ChannelError('INVALID_NATURAL_SETTINGS', '活跃时段请填写不同的开始和结束时间；全天运行可关闭时段限制');
  return Object.fromEntries(Object.keys(emptyNaturalSettings()).map((key) => [key, value[key]]));
}

/** Preserve saved mode permissions before filling newly introduced defaults. */
export function conversationNaturalSettings(config = {}) {
  const input = config.natural;
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)))
    return validateNaturalSettings(input);
  const legacyNatural = config.mode === 'natural' &&
    !['messageEnabled', 'timerEnabled', 'followupEnabled'].some(key => Object.hasOwn(input ?? {}, key));
  return validateNaturalSettings({
    messageEnabled: true,
    timerEnabled: legacyNatural,
    followupEnabled: legacyNatural,
    ...input,
  });
}

export const participationMode = mode => ['participate', 'natural'].includes(mode);

/** Legacy participate is strictly count-only, even with latent natural settings. */
export function participationTriggers(config) {
  if (config.mode === 'participate') return { message: true, timer: false, followup: false };
  if (config.mode !== 'natural') return { message: false, timer: false, followup: false };
  const settings = conversationNaturalSettings(config);
  return { message: settings.messageEnabled, timer: settings.timerEnabled, followup: settings.followupEnabled };
}

export function emptyNaturalState() {
  return {
    configKey: '',
    scheduleKey: '',
    nextCheckAt: 0,
    lastCheckAt: 0,
    lastSentAt: 0,
    lastIncomingAt: 0,
    lastManualAt: 0,
    humanRevision: 0,
    unanswered: 0,
    backoff: 0,
    pendingKey: null,
    deliveryBlockedKey: null,
    lastReason: null,
    followup: { senderId: '', until: 0, remaining: 0, replyId: '', question: '', reply: '' },
  };
}

export function validateNaturalState(input) {
  const invalid = () => {
    throw new ChannelError('INVALID_NATURAL_STATE', '自然陪聊状态无法识别，已停止主动发言；请保留数据并检查记录');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const value = { ...emptyNaturalState(), ...input },
    followup = value.followup;
  if (
    ['configKey', 'scheduleKey'].some((key) => typeof value[key] !== 'string' || value[key].length > 100) ||
    [
      'nextCheckAt',
      'lastCheckAt',
      'lastSentAt',
      'lastIncomingAt',
      'lastManualAt',
      'humanRevision',
      'unanswered',
      'backoff',
    ].some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
    ['nextCheckAt', 'lastCheckAt', 'lastSentAt', 'lastIncomingAt', 'lastManualAt'].some(
      (key) => value[key] > 8640000000000000
    ) ||
    ['pendingKey', 'deliveryBlockedKey', 'lastReason'].some(
      (key) => value[key] !== null && (typeof value[key] !== 'string' || value[key].length > 300)
    ) ||
    !followup ||
    typeof followup !== 'object' ||
    Array.isArray(followup) ||
    ['senderId', 'replyId', 'question', 'reply'].some(
      (key) => typeof followup[key] !== 'string' || followup[key].length > MAX_TEXT
    ) ||
    !Number.isSafeInteger(followup.until) ||
    followup.until < 0 ||
    followup.until > 8640000000000000 ||
    !Number.isInteger(followup.remaining) ||
    followup.remaining < 0 ||
    followup.remaining > 3
  )
    invalid();
  return {
    ...Object.fromEntries(Object.keys(emptyNaturalState()).map((key) => [key, value[key]])),
    followup: { ...followup },
  };
}

export function validateConversationSettings(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !['default', 'nickname', 'participate', 'natural'].includes(input.mode)
  )
    throw new ChannelError('INVALID_CONVERSATION', '请选择默认回复、昵称唤醒、主动参与或自然陪聊模式');
  const intervalMode = input.intervalMode ?? 'random',
    fixedMessages = input.fixedMessages ?? input.minMessages;
  if (
    !['random', 'fixed'].includes(intervalMode) ||
    !Number.isInteger(fixedMessages) ||
    fixedMessages < 1 ||
    fixedMessages > 100 ||
    !Number.isInteger(input.minMessages) ||
    !Number.isInteger(input.maxMessages) ||
    input.minMessages < 1 ||
    input.maxMessages > 100 ||
    input.minMessages > input.maxMessages
  )
    throw new ChannelError('INVALID_CONVERSATION', '参与条数应为 1–100 的整数；随机区间的最少条数不能超过最多条数');
  if (
    typeof input.recordsPath !== 'string' ||
    input.recordsPath.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(input.recordsPath)
  )
    throw new ChannelError('INVALID_PATH', '请输入有效的会话记录目录，留空则使用默认目录');
  const memoryWindowChars = input.memoryWindowChars ?? null;
  if (memoryWindowChars !== null && (!Number.isSafeInteger(memoryWindowChars) || memoryWindowChars < 1000))
    throw new ChannelError(
      'INVALID_MEMORY_SETTINGS',
      '会话记忆窗口至少为 1000 字符，请填写有效整数；留空使用记忆库默认值'
    );
  if (input.allowChatTasks !== undefined && typeof input.allowChatTasks !== 'boolean')
    throw new ChannelError('INVALID_CONVERSATION', '请选择是否允许会话创建定时任务');
  const memoryMode = input.memoryMode ?? 'always';
  if (input.remoteEnabled !== undefined && typeof input.remoteEnabled !== 'boolean')
    throw new ChannelError('INVALID_ADMIN_IDS', '请选择是否允许此会话远程查询');
  const adminIds = administratorIds(input.adminIds);
  const executionMode = input.executionMode ?? 'chat', workSenderIds = input.workSenderIds ?? [];
  if (!['chat', 'work'].includes(executionMode) || !Array.isArray(workSenderIds) || workSenderIds.length > 200 ||
      workSenderIds.some(id => typeof id !== 'string' || !id || id.length > 150 || /[\s\u0000-\u001f\u007f]/.test(id) || id.endsWith('@chatroom')))
    throw new ChannelError('INVALID_WORK_SETTINGS', '请选择聊天或工作模式；允许执行的群成员 ID 每行一个，最多 200 个');
  if (!['always', 'on-demand'].includes(memoryMode))
    throw new ChannelError('INVALID_MEMORY_SETTINGS', '请选择每轮读取或按需读取长期记忆');
  return {
    mode: input.mode,
    intervalMode,
    fixedMessages,
    minMessages: input.minMessages,
    maxMessages: input.maxMessages,
    recordsPath: input.recordsPath.trim(),
    memoryWindowChars,
    allowChatTasks: input.allowChatTasks ?? true,
    persona: input.persona == null ? null : validatePersona(input.persona),
    memoryMode,
    executionMode,
    workSenderIds: [...new Set(workSenderIds)].sort(),
    remoteEnabled: input.remoteEnabled ?? false,
    adminIds,
    natural: conversationNaturalSettings(input),
  };
}

export function administratorIds(value = []) {
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !id || id.length > 150 ||
      !/^[a-z0-9_.-]+$/i.test(id)))
    throw new ChannelError('INVALID_ADMIN_IDS', '管理员请填写微信成员 ID，最多 200 个；不能使用群 ID、昵称列表或带空格的标识');
  return [...new Set(value)].sort();
}

export function remoteSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'globalAdminIds'))
    throw new ChannelError('INVALID_ADMIN_IDS', '远程权限配置无效，请检查全局管理员名单');
  return { globalAdminIds: administratorIds(value.globalAdminIds) };
}

export function workSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['timeoutSeconds', 'commandTimeoutSeconds', 'maxConcurrent'].includes(key)) ||
      !Number.isInteger(value.timeoutSeconds ?? 0) || ((value.timeoutSeconds ?? 0) !== 0 && ((value.timeoutSeconds ?? 0) < 30 || (value.timeoutSeconds ?? 0) > 3600)) ||
      !Number.isInteger(value.commandTimeoutSeconds ?? 60) || (value.commandTimeoutSeconds ?? 60) < 1 || (value.commandTimeoutSeconds ?? 60) > 300 ||
      !Number.isInteger(value.maxConcurrent ?? 2) || (value.maxConcurrent ?? 2) < 1 || (value.maxConcurrent ?? 2) > 8)
    throw new ChannelError('INVALID_WORK_SETTINGS', '工作总时间无限制（0），兼容旧超时设置 30–3600 秒；单次命令超时应为 1–300 秒，同时执行任务数应为 1–8');
  // Historical positive total deadlines remain readable, but never stop active work.
  return { timeoutSeconds: 0, commandTimeoutSeconds: value.commandTimeoutSeconds ?? 60, maxConcurrent: value.maxConcurrent ?? 2 };
}

export function validateModelChoice(value) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['provider', 'model', 'reasoningEffort'].includes(key)) ||
    ['provider', 'model'].some(
      (key) =>
        typeof value[key] !== 'string' ||
        !value[key].trim() ||
        value[key].length > 300 ||
        /[\u0000-\u001f\u007f]/.test(value[key])
    )
  )
    throw new ChannelError('INVALID_MODEL', '请从 DSH 模型列表中选择，或选择跟随 DSH 默认模型');
  const effort = value.reasoningEffort;
  if (
    effort !== undefined &&
    (typeof effort !== 'string' || !effort.trim() || effort.length > 300 || /[\u0000-\u001f\u007f]/.test(effort))
  )
    throw new ChannelError('INVALID_REASONING_EFFORT', '请从所选模型支持的推理强度中选择，或使用模型默认');
  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    ...(effort === undefined ? {} : { reasoningEffort: effort.trim() }),
  };
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean')
    throw new ChannelError('INVALID_SETTINGS', '回复设置格式不正确');
  const peers = (value, group) => {
    if (
      !Array.isArray(value) ||
      value.length > 200 ||
      value.some(
        (id) => typeof id !== 'string' || !id || id.length > 150 || /\s/.test(id) || id.endsWith('@chatroom') !== group
      )
    )
      throw new ChannelError(
        'INVALID_PEERS',
        group
          ? '群 ID 必须以 @chatroom 结尾，每行一个，最多 200 个'
          : '私聊 ID 每行一个，不能包含空格或群 ID，最多 200 个'
      );
    return [...new Set(value)].sort();
  };
  if (typeof input.prompt !== 'string' || input.prompt.length > 4000)
    throw new ChannelError('INVALID_PROMPT', '回复要求最多 4000 字');
  for (const key of ['schedules', 'moments'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new ChannelError('INVALID_SETTINGS', '自动功能开关格式不正确');
  const settings = {
    enabled: input.enabled,
    privatePeers: peers(input.privatePeers, false),
    groups: peers(input.groups, true),
    prompt: input.prompt.trim(),
    // 旧账号没有这个字段，缺省按“自定义屏蔽名单”保存，避免恢复自动屏蔽全部好友。
    publishScope: input.publishScope === undefined ? DEFAULT_PUBLISH_SCOPE : validatePublishScope(input.publishScope),
    // 账号级默认屏蔽名单只预填手动发布页；自动发布须显式勾选后才会使用。
    ...validateDefaultAudience(input),
  };
  // Older configurations only had the single master switch, so a missing flag
  // keeps following it until the user sets one explicitly.
  if (input.schedules !== undefined) settings.schedules = input.schedules;
  if (input.moments !== undefined) settings.moments = input.moments;
  return settings;
}

export const schedulesEnabled = (settings) => (settings?.schedules ?? settings?.enabled) === true;

export const momentsEnabled = (settings) => (settings?.moments ?? settings?.enabled) === true;

export function publicError(error, fallback = '操作失败，请稍后重试') {
  // Only our error vocabulary crosses the UI boundary. Provider/network errors
  // may contain credentials, request bodies or local filenames.
  return error instanceof ChannelError
    ? { code: error.code, message: error.message, details: {} }
    : { code: 'OPERATION_FAILED', message: fallback, details: {} };
}

export const authorizedPerson = (settings, personId) => typeof personId === 'string' && !!personId &&
  !personId.endsWith('@chatroom') && settings?.privatePeers?.includes(personId) === true;

export function authorizedConversation(settings, message) {
  return message?.chatType === 'group' ? settings?.groups?.includes(message.peerId) === true :
    message?.chatType === 'private' && authorizedPerson(settings, message.peerId);
}

export const eligible = (settings, message) => settings?.enabled === true && authorizedConversation(settings, message);

export function nicknameMentioned(text, names) {
  const normalized = String(text).normalize('NFKC').toLocaleLowerCase();
  return names.some((value) => {
    const name = typeof value === 'string' ? value.trim().normalize('NFKC').toLocaleLowerCase() : '';
    if (!name) return false;
    let at = normalized.indexOf(name);
    while (at !== -1) {
      // Latin nicknames must not trigger inside a larger word (Ann / Anna).
      const boundary = (character) => !character || !/[\p{L}\p{N}_]/u.test(character);
      if (!/^[\x00-\x7f]+$/.test(name) || (boundary(normalized[at - 1]) && boundary(normalized[at + name.length])))
        return true;
      at = normalized.indexOf(name, at + name.length);
    }
    return false;
  });
}

export function messageText(message, account, { mode = 'default', persona = emptyPersona() } = {}) {
  if (!Array.isArray(message.message)) return { reason: '消息没有可处理的内容' };
  const visual = message.message.some((s) => ['image', 'face'].includes(s.type));
  let text = message.message
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .trim();
  const mentioned = message.message.some((s) => s.type === 'at' && s.data?.qq === account.id);
  if (mentioned) {
    // WeChat keeps the display mention in text as well as the native at-list.
    // Strip the entire leading native-mention run, retaining /work below.
    text = text.replace(/^(?:@[^\r\n\u2005]{1,150}\u2005\s*)+/u, '').trim();
  }
  const workCommand = /^\/work(?:\s|$)/i.test(text);
  const command = /^\/(?:agent|pc|dsh)(?:\s|$)/i.test(text) || workCommand;
  const nickname =
    mode !== 'default' && nicknameMentioned(text, [persona.name, ...(persona.aliases || []), account.nickname]);
  if (
    message.chatType === 'group' &&
    !['participate', 'natural'].includes(mode) &&
    !mentioned &&
    !command &&
    !nickname
  )
    return {
      reason:
        mode === 'nickname'
          ? '群消息没有呼叫 Agent 名字，也未 @ 当前账号或使用 /agent'
          : '群消息未 @ 当前账号，也未使用 /agent',
    };
  if (command && !workCommand) text = text.replace(/^\/agent\s*/i, '').trim();
  if (!text && visual) text = '当前只收到图片或表情消息，没有文字问题。仅在上下文确有看图需求时按需查看普通图片；否则简短接话，不主动分析。表情包不调用图像理解。';
  if (!text) return { reason: '消息没有可回答的正文，当前支持文字、图片和表情包' };
  if (text.length > MAX_TEXT) return { reason: `消息超过 ${MAX_TEXT} 字，未交给模型` };
  return {
    text,
    trigger: mentioned
      ? 'mention'
      : command
        ? 'command'
        : nickname
          ? 'nickname'
          : message.chatType === 'private'
            ? 'private'
            : null,
  };
}
