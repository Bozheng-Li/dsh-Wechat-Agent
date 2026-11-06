export const CHANNEL = '/wechat-agent';
export const VERSION = '0.2.0-preview.1';
export const MAX_TEXT = 12000;

export class ChannelError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ChannelError'; this.code = code; this.details = details; }
}

export function emptySettings() { return { enabled: false, privatePeers: [], groups: [], prompt: '' }; }

export function emptyPersona() { return { name: '微信助手', aliases: [], background: '', personality: '', style: '' }; }
export function validatePersona(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChannelError('INVALID_PERSONA', '人设格式不正确');
  const field = (key, max, required = false) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || required && (!value.trim() || /[\r\n]/.test(value)))
      throw new ChannelError('INVALID_PERSONA', `请检查人设中的${key === 'name' ? '名字' : '提示词'}，最多 ${max} 字`);
    return value.trim();
  };
  const name = field('name', 80, true);
  if (!Array.isArray(input.aliases) || input.aliases.length > 12 || input.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 80 || /[\u0000-\u001f\u007f]/.test(alias)))
    throw new ChannelError('INVALID_PERSONA', '昵称别名最多 12 个，每个 1–80 字，不能包含换行');
  return { name, aliases: [...new Set(input.aliases.map(alias => alias.trim()))], background: field('background', 2000), personality: field('personality', 6000), style: field('style', 2000) };
}

export function validateModelConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isInteger(input.maxTokens) || input.maxTokens < 256 || input.maxTokens > 8192)
    throw new ChannelError('INVALID_MODEL_CONFIG', '回复输出上限应为 256–8192 的整数');
  if (input.temperature !== null && (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
    throw new ChannelError('INVALID_MODEL_CONFIG', '温度应在 0–2 之间，留空表示跟随模型默认');
  return { maxTokens: input.maxTokens, temperature: input.temperature };
}

export function validateConversationSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['default', 'nickname', 'participate'].includes(input.mode))
    throw new ChannelError('INVALID_CONVERSATION', '请选择默认回复、昵称唤醒或主动参与模式');
  if (!Number.isInteger(input.minMessages) || !Number.isInteger(input.maxMessages) || input.minMessages < 5 || input.maxMessages > 20 || input.minMessages > input.maxMessages)
    throw new ChannelError('INVALID_CONVERSATION', '主动参与的消息间隔须满足 5 ≤ 最少条数 ≤ 最多条数 ≤ 20');
  if (typeof input.recordsPath !== 'string' || input.recordsPath.length > 2048 || /[\u0000-\u001f\u007f]/.test(input.recordsPath))
    throw new ChannelError('INVALID_PATH', '请输入有效的会话记录目录，留空则使用默认目录');
  return { mode: input.mode, minMessages: input.minMessages, maxMessages: input.maxMessages, recordsPath: input.recordsPath.trim() };
}

export function validateModelChoice(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['provider', 'model'].includes(key)) ||
      ['provider', 'model'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 300 || /[\u0000-\u001f\u007f]/.test(value[key])))
    throw new ChannelError('INVALID_MODEL', '请从 DSH 模型列表中选择，或选择跟随 DSH 默认模型');
  return { provider: value.provider.trim(), model: value.model.trim() };
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean')
    throw new ChannelError('INVALID_SETTINGS', '回复设置格式不正确');
  const peers = (value, group) => {
    if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !id || id.length > 150 || /\s/.test(id) || id.endsWith('@chatroom') !== group))
      throw new ChannelError('INVALID_PEERS', group ? '群 ID 必须以 @chatroom 结尾，每行一个，最多 200 个' : '私聊 ID 每行一个，不能包含空格或群 ID，最多 200 个');
    return [...new Set(value)].sort();
  };
  if (typeof input.prompt !== 'string' || input.prompt.length > 4000)
    throw new ChannelError('INVALID_PROMPT', '回复要求最多 4000 字');
  return { enabled: input.enabled, privatePeers: peers(input.privatePeers, false), groups: peers(input.groups, true), prompt: input.prompt.trim() };
}

export function publicError(error, fallback = '操作失败，请稍后重试') {
  // Only our error vocabulary crosses the UI boundary. Provider/network errors
  // may contain credentials, request bodies or local filenames.
  return error instanceof ChannelError
    ? { code: error.code, message: error.message, details: {} }
    : { code: 'OPERATION_FAILED', message: fallback, details: {} };
}

export function eligible(settings, message) {
  return settings?.enabled && (message.chatType === 'group' ? settings.groups : settings.privatePeers)?.includes(message.peerId);
}

export function nicknameMentioned(text, names) {
  const normalized = String(text).normalize('NFKC').toLocaleLowerCase();
  return names.some(value => {
    const name = typeof value === 'string' ? value.trim().normalize('NFKC').toLocaleLowerCase() : '';
    if (!name) return false;
    let at = normalized.indexOf(name);
    while (at !== -1) {
      // Latin nicknames must not trigger inside a larger word (Ann / Anna).
      const boundary = character => !character || !/[\p{L}\p{N}_]/u.test(character);
      if (!/^[\x00-\x7f]+$/.test(name) || boundary(normalized[at - 1]) && boundary(normalized[at + name.length])) return true;
      at = normalized.indexOf(name, at + name.length);
    }
    return false;
  });
}

export function messageText(message, account, { mode = 'default', persona = emptyPersona() } = {}) {
  if (!Array.isArray(message.message) || message.message.some(s => !['text', 'at', 'reply'].includes(s.type)))
    return { reason: '预览版只处理文本，图片、语音和文件消息未交给模型' };
  let text = message.message.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('').trim();
  const mentioned = message.message.some(s => s.type === 'at' && s.data?.qq === account.id);
  if (mentioned) {
    // WeChat keeps the display mention in text as well as the native at-list.
    // Strip only a leading mention delimited by WeChat's special space.
    text = text.replace(/^@[^\r\n\u2005]{1,150}\u2005\s*/u, '').trim();
  }
  const command = /^\/agent(?:\s|$)/i.test(text);
  const nickname = mode === 'nickname' && nicknameMentioned(text, [persona.name, ...(persona.aliases || []), account.nickname]);
  if (message.chatType === 'group' && mode !== 'participate' && !mentioned && !command && !nickname)
    return { reason: mode === 'nickname' ? '群消息没有呼叫 Agent 名字，也未 @ 当前账号或使用 /agent' : '群消息未 @ 当前账号，也未使用 /agent' };
  if (command) text = text.replace(/^\/agent\s*/i, '').trim();
  if (!text) return { reason: '消息没有可回答的正文' };
  if (text.length > MAX_TEXT) return { reason: `消息超过 ${MAX_TEXT} 字，未交给模型` };
  return { text };
}
