import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ConfigurationRepository, CONFIG_FIELDS } from '../config/repository.mjs';
import { recoverConfigurationTransaction } from '../config/transaction.mjs';
import {
  ChannelError,
  validateSettings,
  validateModelChoice,
  validatePersona,
  validateModelConfig,
  validateConversationSettings,
} from "../../shared/contracts.mjs";
import { absoluteDirectory, sameDirectory } from "./paths.mjs";
import { identity, info, recordInfo } from "./keys.mjs";
import { read } from "./json.mjs";
import { object, pendingStates } from "./helpers.mjs";
import { migratePersonaTemplates } from "./persona-migrations.mjs";

export function initializeState(store, root) {
  store.root = path.resolve(root);
  recoverConfigurationTransaction(store.root);
  store.file = path.join(store.root, 'storage/state/channel.json');
  store.views = new Map();
  store.claimOwners = new Map();
  store.contextOwners = new Map();
  store.written = new Map();
  const saved = read(store.file, true);
  if (
    saved &&
    (![1, 2].includes(saved.version) ||
      (saved.configurationVersion !== 1 && !object(saved.accounts)) ||
      !object(saved.seen) ||
      !object(saved.sessions) ||
      !Array.isArray(saved.records))
  )
    throw new ChannelError('STATE_INVALID', '微信插件状态格式无效，未重置已有授权');
  store.data = saved ?? { version: 2, connectionWanted: false, accounts: {}, seen: {}, sessions: {}, records: [] };
  const authorizationMigrating = store.data.authorizationRevocations === undefined || store.data.authorizationEpochs === undefined;
  store.data.authorizationRevocations ??= [];
  store.data.authorizationEpochs ??= {};
  const migrating = saved?.version === 1;
  store.data.storeId ??= migrating ? identity(['wechat-agent-v2', store.root, saved]) : randomUUID();
  store.config = new ConfigurationRepository(store.root, store.data.storeId, store.data);
  for (const field of CONFIG_FIELDS) if (Object.hasOwn(store.config.data, field)) store.data[field] = structuredClone(store.config.data[field]);
  const configurationMigrating = saved?.configurationVersion !== 1;
  if (configurationMigrating && saved) {
    const original = fs.readFileSync(store.file);
    const backup = path.join(path.dirname(store.file), `channel.before-yaml-${createHash('sha256').update(original).digest('hex').slice(0, 12)}.backup.json`);
    try { fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !fs.readFileSync(backup).equals(original))
        throw new ChannelError('STATE_WRITE_FAILED', '原配置备份失败，未开始 YAML 迁移；请检查存储目录和权限');
    }
  }
  store.data.configurationVersion = 1;
  store.data.storageSettings ??= {
    workspacePath: path.join(store.root, 'workspace'),
    recordsPath: path.join(store.root, 'storage/conversations'),
  };
  store.data.conversationConfigs ??= {};
  store.data.conversations ??= {};
  if (
    !object(store.data.conversations) ||
    !object(store.data.conversationConfigs) ||
    typeof store.data.storeId !== 'string'
  )
    throw new ChannelError('STATE_INVALID', '微信插件的会话索引无效，未重置已有数据');
  store.data.storageSettings.workspacePath = absoluteDirectory(
    store.data.storageSettings.workspacePath,
    '工作空间路径'
  );
  store.data.storageSettings.recordsPath = absoluteDirectory(store.data.storageSettings.recordsPath, '会话记录路径');
  if (store.data.modelChoice !== undefined) store.data.modelChoice = validateModelChoice(store.data.modelChoice);
  if (store.data.persona !== undefined) store.data.persona = validatePersona(store.data.persona);
  // Only the legacy fixed default becomes automatic. The version marker
  // keeps a newly saved manual 4096 unchanged on subsequent reloads.
  const modelConfigMigrating = store.data.modelConfigVersion === undefined;
  if (store.data.modelConfig !== undefined)
    store.data.modelConfig = validateModelConfig({
      ...store.data.modelConfig,
      ...(modelConfigMigrating && store.data.modelConfig.maxTokens === 4096 ? { maxTokens: null } : {}),
      searchProvider: store.data.modelConfig.searchProvider ?? 'dsh',
    });
  store.data.modelConfigVersion ??= 2;
  for (const settings of Object.values(store.data.accounts)) validateSettings(settings);
  for (const [key, config] of Object.entries(store.data.conversationConfigs))
    store.data.conversationConfigs[key] = validateConversationSettings(config);
  const personaTemplatesMigrating = migratePersonaTemplates(store);
  if (migrating) {
    const backup = path.join(path.dirname(store.file), 'channel.v1.backup.json');
    try {
      fs.copyFileSync(store.file, backup, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST')
        throw new ChannelError('STATE_WRITE_FAILED', '旧版状态备份失败，未开始迁移；请检查目录权限');
    }
    for (const record of store.data.records) {
      const conversation = recordInfo(record);
      if (!conversation) continue; // Preserve unidentifiable legacy records.
      const view = store._allocate(conversation);
      view.records.push(record);
      if (Object.hasOwn(store.data.seen, record.key)) store.claimOwners.set(record.key, conversation.key);
      if (record.contextKey) store.contextOwners.set(record.contextKey, conversation.key);
    }
    store.data.version = 2;
  } else {
    for (const [key, metadata] of Object.entries(store.data.conversations)) {
      const conversation = info(metadata.accountId, metadata.chatType, metadata.peerId);
      if (conversation.key !== key || typeof metadata.directory !== 'string')
        throw new ChannelError('STATE_INVALID', '会话索引与账号不匹配，未载入其他会话的数据');
      const view = read(path.join(absoluteDirectory(metadata.directory), 'conversation.json'));
      store._validateView(view, conversation);
      store.views.set(key, view);
      store.written.set(key, JSON.stringify(view));
      for (const [claim, at] of Object.entries(view.seen)) {
        store.data.seen[claim] = at;
        store.claimOwners.set(claim, key);
      }
      for (const [context, session] of Object.entries(view.sessions)) {
        store.data.sessions[context] = session;
        store.contextOwners.set(context, key);
      }
      store.data.records.push(...view.records);
    }
    store.data.records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  // A real server acknowledgement survives shutdown. Any unfinished send
  // remains uncertain and can never be automatically replayed.
  let changed = migrating || !saved || modelConfigMigrating || personaTemplatesMigrating || configurationMigrating || authorizationMigrating;
  const recoveryTime = migrating ? Math.trunc(fs.statSync(store.file).mtimeMs) : Date.now();
  for (const record of store.data.records) {
    if (!pendingStates.has(record.state)) continue;
    const uncertain = record.state === 'sending';
    record.state = uncertain ? 'unknown' : 'cancelled';
    record.reason = uncertain ? '上次运行在发送期间中断，结果不明，未自动重发' : '上次运行中断，未自动重放消息';
    record.updatedAt = recoveryTime;
    delete store.data.sessions[record.contextKey];
    changed = true;
  }
  if (changed) store.save();
  else store.rootWritten = JSON.stringify(store._rootSnapshot());
  store.migrateNamedDirectories();
}

export function migrateNamedDirectories(store) {
  const moving = [...store.views.values()].filter(
    (view) => !sameDirectory(store.data.conversations[view.key].directory, store._directory(view))
  );
  if (!moving.length) return;
  store._withSourceLocks(moving, () => {
    const before = moving.map((view) => [view.key, store.data.conversations[view.key].directory, store.data.conversations[view.key].archiveDirectories]);
    for (const view of moving) store._writeAt(view, store._directory(view));
    for (const view of moving) {
      const metadata = store.data.conversations[view.key];
      metadata.archiveDirectories = [...new Set([...(metadata.archiveDirectories || []), metadata.directory])];
      metadata.directory = store._directory(view);
    }
    try {
      store._saveRoot();
    } catch (error) {
      for (const [key, directory, archives] of before) {
        store.data.conversations[key].directory = directory;
        if (archives === undefined) delete store.data.conversations[key].archiveDirectories;
        else store.data.conversations[key].archiveDirectories = archives;
      }
      throw error;
    }
  });
}
