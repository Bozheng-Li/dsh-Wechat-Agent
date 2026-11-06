export const CHANNEL = '/wechat-agent';
export const VERSION = '0.1.0-preview.4';
export const MAX_TEXT = 12000;

export class ChannelError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ChannelError'; this.code = code; this.details = details; }
}

export function emptySettings() { return { enabled: false, privatePeers: [], groups: [], prompt: '' }; }

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

export function messageText(message, account) {
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
  if (message.chatType === 'group' && !mentioned && !command) return { reason: '群消息未 @ 当前账号，也未使用 /agent' };
  if (command) text = text.replace(/^\/agent\s*/i, '').trim();
  if (!text) return { reason: '消息没有可回答的正文' };
  if (text.length > MAX_TEXT) return { reason: `消息超过 ${MAX_TEXT} 字，未交给模型` };
  return { text };
}
