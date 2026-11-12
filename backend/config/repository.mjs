import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { resourcePath } from '../platform/resources.mjs';
import { atomicBytes } from '../storage/atomic-text.mjs';
import { commitConfigurationFiles } from './transaction.mjs';
import { ChannelError, validateSettings, validatePersona, validateGlobalPersona, validateModelChoice, validateModelConfig, validateConversationSettings, workSettings, remoteSettings } from '../../shared/contracts.mjs';
import { imageGenerationSettings } from '../../shared/image-generation.mjs';
import { roleCardSettings } from '../../shared/role-card-settings.mjs';
import { timeSettings } from '../../shared/time-settings.mjs';

export const CONFIG_FIELDS = ['connectionWanted', 'accounts', 'modelChoice', 'modelConfig', 'persona', 'storageSettings', 'roleCardSettings', 'conversationConfigs', 'modelConfigVersion', 'personaTemplatesVersion'];
const allowed = new Set(['version', 'ownerStoreId', ...CONFIG_FIELDS, 'conversationDefaults', 'memory', 'imageMemoryDefaults', 'imageMemory', 'mediaDefaults', 'media', 'prompts', 'work', 'remote', 'imageGeneration', 'timeSettings']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const signature = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
function optional(file) { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function plain(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('outside workspace');
  for (let current = file; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('directory link'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === root) break;
  }
  return file;
}
function document(bytes) {
  if (bytes.length > 16 * 1024 * 1024) throw Error('configuration too large');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const doc = parseDocument(text, { uniqueKeys: true, strict: true });
  if (doc.errors.length) throw Error('invalid YAML');
  const data = doc.toJS({ maxAliasCount: 20 });
  if (!object(data) || data.version !== 1 || Object.keys(data).some(key => !allowed.has(key))) throw Error('invalid configuration');
  return { doc, data };
}

export class ConfigurationRepository {
  constructor(root, storeId, legacy = {}) {
    this.root = root;
    this.file = path.join(root, 'config.yaml');
    this.storeId = storeId;
    this.promptSignatures = new Map();
    try {
      plain(root, this.file);
      const current = optional(this.file);
      this.signature = signature(current);
      const defaults = document(fs.readFileSync(resourcePath('config.yaml'))).data;
      const parsed = document(current ?? fs.readFileSync(resourcePath('config.yaml')));
      this.doc = parsed.doc;
      if (parsed.data.ownerStoreId != null && parsed.data.ownerStoreId !== storeId) throw Error('wrong owner');
      if (legacy.configurationVersion === 1 && !current) throw Error('missing active configuration');
      const data = { ...defaults, ...parsed.data };
      // Existing YAML/JSON without a marker predates the single global assistant.
      data.personaTemplatesVersion = current ? parsed.data.personaTemplatesVersion ?? 1
        : legacy.personaTemplatesVersion ?? (Object.hasOwn(legacy, 'persona') || Object.keys(legacy.conversationConfigs ?? {}).length ? 1 : defaults.personaTemplatesVersion);
      if (legacy.configurationVersion !== 1) for (const field of CONFIG_FIELDS)
        if (Object.hasOwn(legacy, field)) data[field] = legacy[field];
      if (legacy.configurationVersion !== 1 && legacy.modelConfig && legacy.modelConfigVersion === undefined)
        data.modelConfig = { ...data.modelConfig, ...(data.modelConfig.maxTokens === 4096 ? { maxTokens: null } : {}), searchProvider: data.modelConfig.searchProvider ?? 'dsh' };
      this.data = this.validate(data);
      this.written = current ? JSON.stringify(this.data) : null;
      this.needsMigration = legacy.configurationVersion !== 1;
    } catch (error) {
      if (error instanceof ChannelError && ['CONFIG_PROMPT_INVALID', 'PERSONA_GLOBAL_ONLY'].includes(error.code)) throw error;
      throw new ChannelError('CONFIG_INVALID', 'config.yaml 无法读取、格式无效或归属不匹配，未重置授权；请检查 YAML、提示词文件和目录权限后重新启用插件');
    }
  }
  prompt(file) {
    try {
      if (typeof file !== 'string' || !file.startsWith('prompts/') || !file.endsWith('.md')) throw Error();
      const absolute = plain(this.root, path.resolve(this.root, file));
      const bytes = fs.readFileSync(absolute);
      if (bytes.length > 160000) throw Error();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
      this.promptSignatures.set(absolute, signature(bytes));
      return text;
    } catch { throw new ChannelError('CONFIG_PROMPT_INVALID', '配置引用的 prompts 文件无法读取或不是有效 UTF-8；原配置和正文保留，请检查文件后重新启用插件'); }
  }
  persona(input) {
    if (!object(input)) throw Error();
    const next = { ...input };
    for (const field of ['prompt', 'background', 'personality', 'style']) {
      if (next[field + 'File'] !== undefined) { next[field] = this.prompt(next[field + 'File']); delete next[field + 'File']; }
    }
    return validatePersona(next);
  }
  validate(input) {
    const next = clone(input);
    if (typeof next.connectionWanted !== 'boolean' || !object(next.accounts) || !object(next.conversationConfigs) || !object(next.storageSettings)) throw Error();
    next.ownerStoreId = this.storeId;
    next.work = workSettings(next.work);
    next.remote = remoteSettings(next.remote);
    next.imageGeneration = imageGenerationSettings(next.imageGeneration ?? {});
    next.roleCardSettings = roleCardSettings(next.roleCardSettings);
    next.timeSettings = timeSettings(next.timeSettings);
    next.persona = validateGlobalPersona(this.persona(next.persona));
    if (!Number.isSafeInteger(next.personaTemplatesVersion) || next.personaTemplatesVersion < 1) throw Error('invalid persona version');
    next.modelChoice = validateModelChoice(next.modelChoice);
    next.modelConfig = validateModelConfig(next.modelConfig);
    next.accounts = Object.fromEntries(Object.entries(next.accounts).map(([id, settings]) => {
      if (!object(settings)) throw Error();
      const value = { ...settings, prompt: settings.promptFile === undefined ? settings.prompt ?? '' : this.prompt(settings.promptFile) };
      delete value.promptFile;
      return [id, validateSettings(value)];
    }));
    const resolvePaths = settings => ({ ...settings, ...(settings.recordsPath ? { recordsPath: path.resolve(this.root, settings.recordsPath) } : {}) });
    next.conversationConfigs = Object.fromEntries(Object.entries(next.conversationConfigs).map(([key, settings]) => [key, validateConversationSettings(resolvePaths({ ...settings, ...(settings.persona ? { persona: this.persona(settings.persona) } : {}) }))]));
    next.conversationDefaults = validateConversationSettings(resolvePaths({ ...next.conversationDefaults,
      ...(next.conversationDefaults.persona ? { persona: this.persona(next.conversationDefaults.persona) } : {}) }));
    if (next.personaTemplatesVersion >= 3 && (next.conversationDefaults.persona || Object.values(next.conversationConfigs).some(settings => settings.persona)))
      throw new ChannelError('PERSONA_GLOBAL_ONLY', '所有会话共用默认助手；请在全局自定义入口编辑，并移除 YAML 中的会话独立人设');
    for (const field of ['workspacePath', 'recordsPath']) {
      if (typeof next.storageSettings[field] !== 'string' || !next.storageSettings[field]) throw Error();
      next.storageSettings[field] = path.resolve(this.root, next.storageSettings[field]);
    }
    if (!object(next.memory) || !Number.isSafeInteger(next.memory.windowChars) || next.memory.windowChars < 1000 || typeof next.memory.windowCustomized !== 'boolean' || !Number.isSafeInteger(next.memory.retentionDays) || next.memory.retentionDays < 1 || next.memory.retentionDays > 36500) throw Error();
    if (!object(next.imageMemory) || !object(next.media) || !object(next.prompts) || typeof next.prompts.identity !== 'string' || !next.prompts.identity.startsWith('prompts/') || !next.prompts.identity.endsWith('.md')) throw Error();
    const imageSettings = value => object(value) && typeof value.enabled === 'boolean' && (value.retentionDays === null || Number.isSafeInteger(value.retentionDays) && value.retentionDays >= 1 && value.retentionDays <= 36500);
    const mediaSettings = value => object(value) && typeof value.enabled === 'boolean' && Number.isInteger(value.probability) && value.probability >= 0 && value.probability <= 100 && Number.isInteger(value.minGapMessages) && value.minGapMessages >= 0 && value.minGapMessages <= 100 && ['captureIncoming', 'preferNative', 'autoDescribe'].every(key => value[key] === undefined || typeof value[key] === 'boolean');
    if (!imageSettings(next.imageMemoryDefaults) || Object.values(next.imageMemory).some(value => !imageSettings(value)) || !mediaSettings(next.mediaDefaults) || Object.values(next.media).some(value => !object(value) || !mediaSettings(value.settings) || !object(value.packs) || !object(value.assets) || [...Object.values(value.packs), ...Object.values(value.assets)].some(enabled => typeof enabled !== 'boolean'))) throw Error();
    plain(this.root, path.resolve(this.root, next.prompts.identity));
    return next;
  }
  assertCurrent() {
    if (signature(optional(this.file)) !== this.signature || [...this.promptSignatures].some(([file, hash]) => signature(optional(file)) !== hash))
      throw new ChannelError('CONFIG_CHANGED', 'config.yaml 或人设文件已由外部修改，未覆盖新内容；请重新启用插件载入配置后再保存');
  }
  snapshot(state) {
    const next = clone(this.data);
    for (const field of CONFIG_FIELDS) if (Object.hasOwn(state, field)) next[field] = clone(state[field]);
    return next;
  }
  writePrompt(text, folder) {
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 24);
    const relative = `prompts/${folder}/${digest}.md`;
    const file = plain(this.root, path.join(this.root, relative));
    const existing = optional(file);
    if (existing && !existing.equals(Buffer.from(text))) throw Error('prompt collision');
    if (!existing) atomicBytes(file, Buffer.from(text));
    this.pendingPromptSignatures.set(file, signature(Buffer.from(text)));
    return relative;
  }
  encode(data) {
    this.pendingPromptSignatures = new Map();
    const next = clone(data);
    const persona = (value, folder) => {
      const result = { name: value.name, aliases: value.aliases };
      for (const field of ['prompt', 'background', 'personality', 'style']) if (Object.hasOwn(value, field)) {
        if (value[field]) result[field + 'File'] = this.writePrompt(value[field], folder + '/' + field);
        else result[field] = '';
      }
      return result;
    };
    next.persona = persona(next.persona, 'personas/default');
    next.accounts = Object.fromEntries(Object.entries(next.accounts).map(([id, settings]) => {
      const { prompt, ...rest } = settings;
      return [id, { ...rest, ...(prompt ? { promptFile: this.writePrompt(prompt, 'accounts/' + createHash('sha256').update(id).digest('hex').slice(0, 16)) } : { prompt: '' }) }];
    }));
    next.conversationConfigs = Object.fromEntries(Object.entries(next.conversationConfigs).map(([key, settings]) => [key, { ...settings, ...(settings.persona ? { persona: persona(settings.persona, 'personas/conversations/' + key) } : {}) }]));
    if (next.conversationDefaults.persona) next.conversationDefaults.persona = persona(next.conversationDefaults.persona, 'personas/conversations/default');
    next.ownerStoreId = this.storeId;
    const doc = this.doc.clone();
    for (const key of Object.keys(next)) doc.set(key, next[key]);
    for (const key of Object.keys(this.doc.toJS({ maxAliasCount: 20 }))) if (!Object.hasOwn(next, key)) doc.delete(key);
    return { doc, bytes: Buffer.from(doc.toString({ lineWidth: 0 })) };
  }
  commit(data, related = []) {
    this.assertCurrent();
    const changed = this.written !== JSON.stringify(data) || this.needsMigration;
    let encoded;
    try {
      encoded = changed ? this.encode(data) : null;
      const updates = [...related, ...(encoded ? [{ file: this.file, bytes: encoded.bytes }] : [])];
      commitConfigurationFiles(this.root, updates);
    }
    catch (error) {
      if (error instanceof ChannelError) throw error;
      throw new ChannelError('STATE_WRITE_FAILED', '配置未能保存，原设置保留；请检查 config.yaml、磁盘和目录权限');
    }
    if (encoded) {
      this.doc = encoded.doc;
      this.signature = signature(encoded.bytes);
      this.data = clone(data);
      this.promptSignatures = this.pendingPromptSignatures;
      this.written = JSON.stringify(data);
      this.needsMigration = false;
    }
  }
  section(name) { return clone(this.data[name]); }
  update(name, value, state, related = []) {
    if (!['memory', 'imageMemory', 'media'].includes(name)) throw Error('Unknown configuration section');
    const next = this.snapshot(state);
    next[name] = clone(value);
    this.commit(next, related);
  }
}

/** Keep the existing storage-interface contract usable by isolated feature adapters. */
export function configurationFor(store) {
  return store.config ??= new ConfigurationRepository(path.resolve(store.root), store.data.storeId,
    { ...store.data, ...(fs.existsSync(path.join(store.root, 'config.yaml')) ? { configurationVersion: 1 } : {}) });
}
