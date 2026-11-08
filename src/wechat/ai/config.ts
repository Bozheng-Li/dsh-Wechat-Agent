import { existsSync } from 'node:fs';
import { BridgeError, object } from '@napcat-wechat/protocol';
import { atomicJson, readJson } from '../protocol/session.js';

export interface AiConfig {
  enabled: boolean; baseUrl: string; apiKey: string; model: string; systemPrompt: string; temperature: number;
  maxTokens: number; contextTokens: number; maxTurns: number; idleMinutes: number; timeoutMs: number;
  privateMode: 'all' | 'prefix' | 'off'; prefix: string; privateAllowlist: string[];
  groupMention: boolean; groupKeywords: string[]; maxInboundAgeSeconds: number;
  assistantName: string; ownerWxid: string; readOnlyTools: boolean;
  conversations: { accountId: string; peerId: string; mode: 'active' | 'paused' | 'human'; botId?: string; personaId?: string }[];
}
export const AI_DEFAULTS: AiConfig = {
  enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', systemPrompt: '你是一个友善、准确、简洁的微信助手。',
  temperature: 0.7, maxTokens: 1024, contextTokens: 8192, maxTurns: 10, idleMinutes: 60, timeoutMs: 60000,
  privateMode: 'off', prefix: '/ai', privateAllowlist: [], groupMention: false, groupKeywords: [], maxInboundAgeSeconds: 120,
  assistantName: '微信助手', ownerWxid: '', readOnlyTools: true, conversations: [],
};
export function validateAi(raw: unknown): AiConfig {
  const c = { ...AI_DEFAULTS, ...object(raw) };
  for (const key of ['enabled', 'groupMention', 'readOnlyTools'] as const) if (typeof c[key] !== 'boolean') throw new BridgeError('ERR_AI_CONFIG', `Invalid ${key}`);
  for (const key of ['baseUrl', 'apiKey', 'model', 'systemPrompt', 'prefix', 'assistantName', 'ownerWxid'] as const) if (typeof c[key] !== 'string' || c[key].length > (key === 'systemPrompt' ? 16000 : 4096)) throw new BridgeError('ERR_AI_CONFIG', `Invalid ${key}`);
  let url: URL;
  try { url = new URL(c.baseUrl); } catch { throw new BridgeError('ERR_AI_CONFIG', 'Invalid AI Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BridgeError('ERR_AI_CONFIG', 'AI Base URL must be HTTP(S), without embedded credentials, query or fragment');
  c.baseUrl = c.baseUrl.replace(/\/+$/, '');
  for (const [key, min, max] of [['maxTokens', 64, 393216], ['contextTokens', 256, 1048576], ['maxTurns', 1, 100], ['idleMinutes', 1, 10080], ['timeoutMs', 1000, 300000], ['maxInboundAgeSeconds', 5, 600]] as const) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new BridgeError('ERR_AI_CONFIG', key === 'maxTokens' ? '最大输出 Token 必须是 64～393216（384K）的整数，且不能占满上下文总预算' : key === 'contextTokens' ? '上下文总预算必须是 256～1048576（1M）的整数' : `Invalid ${key}`);
  }
  if (typeof c.temperature !== 'number' || !Number.isFinite(c.temperature) || c.temperature < 0 || c.temperature > 2) throw new BridgeError('ERR_AI_CONFIG', 'Temperature must be between 0 and 2');
  if (!['all', 'prefix', 'off'].includes(c.privateMode) || c.privateMode === 'prefix' && !c.prefix.trim()) throw new BridgeError('ERR_AI_CONFIG', 'Prefix mode requires a prefix');
  for (const key of ['groupKeywords', 'privateAllowlist'] as const) if (!Array.isArray(c[key]) || c[key].length > 128 || !c[key].every(s => typeof s === 'string' && s.trim() && s.length <= 256)) throw new BridgeError('ERR_AI_CONFIG', `Invalid ${key}`);
  const minimumContextTokens = c.maxTokens + Buffer.byteLength(c.systemPrompt) + 65;
  if (c.contextTokens < minimumContextTokens) throw new BridgeError('ERR_AI_CONFIG', `上下文总预算 ${c.contextTokens} 不足：最大输出已预留 ${c.maxTokens}，加上系统提示词和开销，至少需要 ${minimumContextTokens}。请在模型接入页提高总预算，或降低最大输出。`, { minimumContextTokens, contextTokens: c.contextTokens, maxTokens: c.maxTokens });
  if (c.enabled && !c.model.trim()) throw new BridgeError('ERR_AI_CONFIG', 'A model is required before enabling AI');
  if (c.ownerWxid && !/^[\w.:-]{1,256}$/.test(c.ownerWxid)) throw new BridgeError('ERR_AI_CONFIG', '授权私聊 ID 无效，不能是群聊');
  if (c.enabled && !c.ownerWxid && !c.conversations.length) throw new BridgeError('ERR_AI_CONFIG', '请先明确授权会话');
  if (!Array.isArray(c.conversations) || c.conversations.length > 128) throw new BridgeError('ERR_AI_CONFIG', '会话策略格式不正确');
  c.conversations = c.conversations.map(raw => {
    const p = object(raw);
    if (typeof p.accountId !== 'string' || !/^[\w.:-]{1,256}$/.test(p.accountId) || typeof p.peerId !== 'string' || p.peerId.length > 256 || !/^[\w.:-]+(?:@chatroom)?$/.test(p.peerId) || !['active', 'paused', 'human'].includes(String(p.mode))) throw new BridgeError('ERR_AI_CONFIG', '会话策略无效');
    for (const key of ['botId', 'personaId'] as const) if (p[key] !== undefined && (typeof p[key] !== 'string' || p[key].length > 128)) throw new BridgeError('ERR_AI_CONFIG', '会话绑定 ID 无效');
    return { accountId: p.accountId, peerId: p.peerId, mode: p.mode as 'active' | 'paused' | 'human', ...(p.botId ? { botId: p.botId as string } : {}), ...(p.personaId ? { personaId: p.personaId as string } : {}) };
  });
  if (new Set(c.conversations.map(p => `${p.accountId}:${p.peerId}`)).size !== c.conversations.length) throw new BridgeError('ERR_AI_CONFIG', '会话策略不能重复');
  return c;
}
export class AiConfigStore {
  value: AiConfig;
  constructor(readonly file: string) {
    const raw = existsSync(file) ? object(readJson(file)) : {};
    // Legacy broad-reply settings stay on disk, but cannot arm the new engine.
    this.value = validateAi('conversations' in raw ? raw : { ...raw, enabled: false });
  }
  draft(raw: unknown) { const patch = object(raw); return validateAi({ ...this.value, ...patch, apiKey: patch.clearApiKey === true ? '' : typeof patch.apiKey === 'string' && patch.apiKey ? patch.apiKey : this.value.apiKey }); }
  save(config: AiConfig) { const next = validateAi(config); atomicJson(this.file, next); this.value = next; }
  publicConfig() { const { apiKey, ...rest } = this.value; return { ...rest, apiKeyConfigured: !!apiKey }; }
}
