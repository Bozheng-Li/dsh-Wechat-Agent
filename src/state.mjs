import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson } from './wechat/protocol/session.ts';
import { ChannelError, emptySettings, validateSettings, validateModelChoice,
  validatePersona, validateModelConfig, validateConversationSettings } from './contracts.mjs';
import { absoluteDirectory, sameDirectory, writableDirectory } from './storage-paths.mjs';

export function identity(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
export function conversationKey(accountId, chatType, peerId) { return identity([accountId, chatType, peerId]); }

const defaults = {
  persona: () => ({ name: '微信助手', aliases: [], background: '', personality: '', style: '' }),
  model: () => ({ maxTokens: 4096, temperature: null }),
  conversation: () => ({ mode: 'default', minMessages: 5, maxMessages: 20, recordsPath: '' }),
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const pendingStates = new Set(['queued', 'generating', 'sending']);
const historyLimit = 1000;
const clone = value => structuredClone(value);

function info(accountId, chatType, peerId) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 200 || /[\s\u0000-\u001f]/.test(accountId) ||
      !['private', 'group'].includes(chatType) || typeof peerId !== 'string' || !peerId || peerId.length > 200 ||
      /[\s\u0000-\u001f]/.test(peerId) || peerId.endsWith('@chatroom') !== (chatType === 'group'))
    throw new ChannelError('INVALID_CONVERSATION', '会话标识不正确，请刷新会话列表后重试');
  return { key: conversationKey(accountId, chatType, peerId), accountId, chatType, peerId };
}
function recordInfo(record) {
  if (!record?.accountId || !record?.peerId || !record?.chatType) return null;
  return info(record.accountId, record.chatType, record.peerId);
}
function read(file, missing = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (missing && error.code === 'ENOENT') return undefined;
    throw new ChannelError('STATE_INVALID', '微信插件状态无法读取，已停止自动回复；请保留数据并检查文件权限');
  }
}
function write(file, value) {
  try { atomicJson(file, value); }
  catch { throw new ChannelError('STATE_WRITE_FAILED', '无法保存消息状态，已停止处理，避免重复发送；请检查磁盘和目录权限'); }
}

function archiveLock(directory, ownerStoreId, key) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(path.dirname(directory)).isSymbolicLink())
    throw new ChannelError('CONVERSATION_PATH_CONFLICT', '会话目录包含重定向链接，未向其他目录写入数据');
  const file = path.join(directory, '.wechat-agent-write.lock'), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify({ ownerStoreId, key, pid: process.pid, token }));
      fs.closeSync(handle); handle = undefined;
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') throw new ChannelError('STATE_WRITE_FAILED', '会话文件已写入但目录锁无法释放，请检查权限后重新启用插件'); }
      };
    } catch (error) {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch {}
        try { fs.unlinkSync(file); } catch {}
      }
      if (error.code !== 'EEXIST') throw error;
      const owner = read(file);
      if (owner?.ownerStoreId !== ownerStoreId || owner.key !== key)
        throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标会话目录由其他数据实例使用，未覆盖已有记录');
      if (alive(owner.pid)) throw new ChannelError('STATE_WRITE_FAILED', '会话目录正由另一个实例写入，自动回复已暂停；请只保留一个使用该目录的实例');
      // Reap only a dead writer belonging to this exact store and conversation.
      fs.unlinkSync(file);
    }
  }
  throw new ChannelError('STATE_WRITE_FAILED', '会话目录正在被占用，未继续处理消息');
}

/**
 * channel.json is the configuration/path index. Each conversation owns one
 * atomic snapshot containing its claims, observations, records and DSH IDs.
 * In-memory aggregates preserve the channel API without mixing archives.
 */
export class StateStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'storage/state/channel.json');
    this.views = new Map();
    this.claimOwners = new Map();
    this.contextOwners = new Map();
    this.written = new Map();
    const saved = read(this.file, true);
    if (saved && (![1, 2].includes(saved.version) || !object(saved.accounts) || !object(saved.seen) ||
        !object(saved.sessions) || !Array.isArray(saved.records)))
      throw new ChannelError('STATE_INVALID', '微信插件状态格式无效，未重置已有授权');
    this.data = saved ?? { version: 2, connectionWanted: false, accounts: {}, seen: {}, sessions: {}, records: [] };
    const migrating = saved?.version === 1;
    this.data.storeId ??= migrating ? identity(['wechat-agent-v2', this.root, saved]) : randomUUID();
    this.data.storageSettings ??= { workspacePath: path.join(this.root, 'workspace'), recordsPath: path.join(this.root, 'storage/conversations') };
    this.data.conversationConfigs ??= {};
    this.data.conversations ??= {};
    if (!object(this.data.conversations) || !object(this.data.conversationConfigs) || typeof this.data.storeId !== 'string')
      throw new ChannelError('STATE_INVALID', '微信插件的会话索引无效，未重置已有数据');
    this.data.storageSettings.workspacePath = absoluteDirectory(this.data.storageSettings.workspacePath, '工作空间路径');
    this.data.storageSettings.recordsPath = absoluteDirectory(this.data.storageSettings.recordsPath, '会话记录路径');
    if (this.data.modelChoice !== undefined) this.data.modelChoice = validateModelChoice(this.data.modelChoice);
    if (this.data.persona !== undefined) this.data.persona = validatePersona(this.data.persona);
    if (this.data.modelConfig !== undefined) this.data.modelConfig = validateModelConfig(this.data.modelConfig);
    for (const settings of Object.values(this.data.accounts)) validateSettings(settings);
    for (const config of Object.values(this.data.conversationConfigs)) validateConversationSettings(config);
    if (migrating) {
      const backup = path.join(path.dirname(this.file), 'channel.v1.backup.json');
      try { fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw new ChannelError('STATE_WRITE_FAILED', '旧版状态备份失败，未开始迁移；请检查目录权限'); }
      for (const record of this.data.records) {
        const conversation = recordInfo(record);
        if (!conversation) continue; // Preserve unidentifiable legacy records.
        const view = this._allocate(conversation);
        view.records.push(record);
        if (Object.hasOwn(this.data.seen, record.key)) this.claimOwners.set(record.key, conversation.key);
        if (record.contextKey) this.contextOwners.set(record.contextKey, conversation.key);
      }
      this.data.version = 2;
    } else {
      for (const [key, metadata] of Object.entries(this.data.conversations)) {
        const conversation = info(metadata.accountId, metadata.chatType, metadata.peerId);
        if (conversation.key !== key || typeof metadata.directory !== 'string')
          throw new ChannelError('STATE_INVALID', '会话索引与账号不匹配，未载入其他会话的数据');
        const view = read(path.join(absoluteDirectory(metadata.directory), 'conversation.json'));
        this._validateView(view, conversation);
        this.views.set(key, view);
        this.written.set(key, JSON.stringify(view));
        for (const [claim, at] of Object.entries(view.seen)) { this.data.seen[claim] = at; this.claimOwners.set(claim, key); }
        for (const [context, session] of Object.entries(view.sessions)) { this.data.sessions[context] = session; this.contextOwners.set(context, key); }
        this.data.records.push(...view.records);
      }
      this.data.records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    }
    // A real server acknowledgement survives shutdown. Any unfinished send
    // remains uncertain and can never be automatically replayed.
    let changed = migrating || !saved;
    const recoveryTime = migrating ? Math.trunc(fs.statSync(this.file).mtimeMs) : Date.now();
    for (const record of this.data.records) {
      if (!pendingStates.has(record.state)) continue;
      const uncertain = record.state === 'sending';
      record.state = uncertain ? 'unknown' : 'cancelled';
      record.reason = uncertain ? '上次运行在发送期间中断，结果不明，未自动重发' : '上次运行中断，未自动重放消息';
      record.updatedAt = recoveryTime;
      delete this.data.sessions[record.contextKey]; changed = true;
    }
    if (changed) this.save();
    else this.rootWritten = JSON.stringify(this._rootSnapshot());
  }
  _directory(conversation, storage = this.data.storageSettings, config = this.data.conversationConfigs[conversation.key]) {
    const base = config?.recordsPath || storage.recordsPath;
    return path.join(base, identity([conversation.accountId]).slice(0, 24), conversation.key);
  }
  _allocate(conversation) {
    let view = this.views.get(conversation.key);
    if (view) return view;
    const directory = this._directory(conversation);
    view = { version: 1, ownerStoreId: this.data.storeId, ...conversation, revision: 0,
      records: [], messages: [], seen: {}, sessions: {}, progress: { count: 0, target: null } };
    this.data.conversations[conversation.key] = { ...conversation, directory };
    this.views.set(conversation.key, view);
    return view;
  }
  _validateView(view, conversation) {
    if (!object(view) || view.version !== 1 || view.ownerStoreId !== this.data.storeId ||
        view.key !== conversation.key || view.accountId !== conversation.accountId ||
        view.chatType !== conversation.chatType || view.peerId !== conversation.peerId ||
        !Array.isArray(view.records) || !Array.isArray(view.messages) || !object(view.seen) || !object(view.sessions) ||
        !object(view.progress) || !Number.isInteger(view.revision) || view.revision < 0 ||
        view.records.some(record => recordInfo(record)?.key !== conversation.key))
      throw new ChannelError('CONVERSATION_DATA_MISMATCH', '该目录已有其他会话或无法识别的数据，未覆盖；请选择独立的保存路径');
  }
  _ensure(conversation) {
    let view = this.views.get(conversation.key);
    if (view) return view;
    view = this._allocate(conversation);
    try {
      this._writeAt(view, this.data.conversations[conversation.key].directory);
      this._saveRoot();
      this.written.set(conversation.key, JSON.stringify(view));
      return view;
    } catch (error) {
      this.views.delete(conversation.key);
      delete this.data.conversations[conversation.key];
      throw error;
    }
  }
  _writeAt(view, directory, expectedRevision) {
    const file = path.join(directory, 'conversation.json');
    let release;
    try {
      release = archiveLock(directory, this.data.storeId, view.key);
      const previous = read(file, true);
      if (previous) {
        this._validateView(previous, view);
        if (expectedRevision !== undefined && previous.revision !== expectedRevision)
          throw new ChannelError('STATE_WRITE_FAILED', '会话文件已被其他实例更新，未覆盖或重复处理；请重新启用插件读取最新记录');
        if (previous.revision > view.revision)
          throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标目录已有更新的会话记录，未覆盖；原保存路径保持不变');
        if (previous.revision === view.revision && JSON.stringify(previous) !== JSON.stringify(view))
          throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标目录存在内容不同的同版本会话记录，未覆盖；请选择其他目录');
        if (expectedRevision === undefined && previous.revision < view.revision) {
          const sourceRecords = new Map(view.records.map(record => [record.key, record]));
          const diverged = previous.records.some(record => {
            const source = sourceRecords.get(record.key);
            return !source || ['accountId', 'peerId', 'chatType', 'messageId', 'question', 'senderId', 'createdAt']
              .some(field => record[field] !== source[field]) || record.state === 'sent' &&
              (source.state !== 'sent' || source.reply !== record.reply ||
                (record.acknowledgedMessageIds ?? []).some(id => !source.acknowledgedMessageIds?.includes(id)));
          });
          if (diverged) throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标目录保留了当前来源没有的不同记录，未覆盖；请选择独立目录后核对历史数据');
        }
      } else if (expectedRevision !== undefined) {
        throw new ChannelError('STATE_WRITE_FAILED', '已使用的会话文件缺失，未创建空记录替代；请检查保存目录');
      } else if (fs.readdirSync(directory).some(name => name !== '.wechat-agent-write.lock')) {
        throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标会话目录不是空目录，未覆盖已有文件；请选择其他保存路径');
      }
      write(file, view);
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      throw new ChannelError('STATE_WRITE_FAILED', '会话文件无法写入，请检查保存目录的权限和磁盘空间；未继续回复');
    } finally { release?.(); }
  }
  _rootSnapshot() {
    return { ...this.data,
      seen: Object.fromEntries(Object.entries(this.data.seen).filter(([key]) => !this.claimOwners.has(key))),
      sessions: Object.fromEntries(Object.entries(this.data.sessions).filter(([key]) => !this.contextOwners.has(key))),
      records: this.data.records.filter(record => !recordInfo(record)),
    };
  }
  _saveRoot() {
    const snapshot = this._rootSnapshot(), serialized = JSON.stringify(snapshot);
    if (serialized !== this.rootWritten) { write(this.file, snapshot); this.rootWritten = serialized; }
  }
  _withSourceLocks(views, operation) {
    const releases = [];
    try {
      for (const view of [...views].sort((a, b) => a.key.localeCompare(b.key))) {
        const directory = this.data.conversations[view.key].directory;
        const file = path.join(directory, 'conversation.json');
        if (!fs.existsSync(file)) throw new ChannelError('STORAGE_SOURCE_CHANGED', '源会话文件已不存在，未切换保存路径；请检查目录并重新启用插件');
        releases.push(archiveLock(directory, this.data.storeId, view.key));
        const current = read(file);
        this._validateView(current, view);
        const expected = this.written.get(view.key);
        if (JSON.stringify(current) !== expected || JSON.stringify(view) !== expected)
          throw new ChannelError('STORAGE_SOURCE_CHANGED', '源会话记录已被其他实例更新或仍有未保存状态，未迁移；请重新启用插件读取最新记录');
      }
      return operation();
    } finally {
      let error;
      for (const release of releases.reverse()) {
        try { release(); } catch (failure) { error ??= failure; }
      }
      if (error) throw error;
    }
  }
  save() {
    for (const [key, view] of this.views) {
      view.seen = Object.fromEntries(Object.entries(this.data.seen).filter(([claim]) => this.claimOwners.get(claim) === key));
      view.sessions = Object.fromEntries(Object.entries(this.data.sessions).filter(([context]) => this.contextOwners.get(context) === key));
      const comparable = JSON.stringify(view);
      if (comparable === this.written.get(key)) continue;
      const revision = view.revision;
      view.revision++;
      try {
        this._writeAt(view, this.data.conversations[key].directory, this.written.has(key) ? revision : undefined);
        this.written.set(key, JSON.stringify(view));
      } catch (error) {
        view.revision = revision;
        if (error.code === 'STATE_WRITE_FAILED') throw error;
        throw new ChannelError('STATE_WRITE_FAILED', error instanceof ChannelError ? error.message : '会话文件无法保存，自动回复已暂停，请检查目录和磁盘');
      }
    }
    this._saveRoot();
  }
  settings(accountId) { return clone(this.data.accounts[accountId] ?? emptySettings()); }
  modelChoice() { return clone(this.data.modelChoice ?? null); }
  persona() { return clone(this.data.persona ?? defaults.persona()); }
  modelConfig() { return clone(this.data.modelConfig ?? defaults.model()); }
  storageSettings() { return clone(this.data.storageSettings); }
  ensureWorkspace() {
    const directory = this.data.storageSettings.workspacePath;
    if (!fs.existsSync(directory)) return writableDirectory(directory, '工作空间路径');
    try {
      if (!fs.statSync(directory).isDirectory()) throw new Error('Not a directory');
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      return fs.realpathSync(directory);
    } catch { throw new ChannelError('STORAGE_PATH_UNWRITABLE', '工作空间无法使用，请检查目录和权限，或在存储设置中选择其他目录'); }
  }
  _setting(field, input, validate) {
    const value = validate(input), previous = this.data[field];
    this.data[field] = value;
    try { this.save(); }
    catch (error) { if (previous === undefined) delete this.data[field]; else this.data[field] = previous; throw error; }
    return clone(value);
  }
  setPersona(input) { return this._setting('persona', input, validatePersona); }
  setModelConfig(input) { return this._setting('modelConfig', input, validateModelConfig); }
  setModelChoice(input) {
    try { return this._setting('modelChoice', input, validateModelChoice); }
    catch (error) {
      if (error.code !== 'STATE_WRITE_FAILED') throw error;
      throw new ChannelError('STATE_WRITE_FAILED', '模型选择未能保存，仍使用原选择；请检查磁盘和目录权限');
    }
  }
  configure(accountId, input) {
    const settings = validateSettings(input), before = this.data.accounts[accountId];
    this.data.accounts[accountId] = settings;
    try { this.save(); } catch (error) { if (before) this.data.accounts[accountId] = before; else delete this.data.accounts[accountId]; throw error; }
    return clone(settings);
  }
  conversationSettings(accountId, chatType, peerId) {
    const conversation = info(accountId, chatType, peerId);
    return clone(this.data.conversationConfigs[conversation.key] ?? defaults.conversation());
  }
  setConversationSettings(accountId, chatType, peerId, input) {
    const conversation = info(accountId, chatType, peerId);
    const config = validateConversationSettings(input);
    if (chatType !== 'group' && config.mode !== 'default')
      throw new ChannelError('INVALID_CONVERSATION_MODE', '昵称唤醒和主动参与仅适用于群聊');
    if (config.recordsPath) config.recordsPath = writableDirectory(config.recordsPath, '当前会话保存路径');
    const view = this._ensure(conversation), metadata = this.data.conversations[conversation.key];
    return this._withSourceLocks([view], () => {
      const directory = this._directory(conversation, this.data.storageSettings, config);
      if (!sameDirectory(directory, metadata.directory)) this._writeAt(view, directory);
      const beforeConfig = this.data.conversationConfigs[conversation.key], beforeDirectory = metadata.directory;
      this.data.conversationConfigs[conversation.key] = config;
      metadata.directory = directory;
      try { this.save(); }
      catch (error) {
        metadata.directory = beforeDirectory;
        if (beforeConfig === undefined) delete this.data.conversationConfigs[conversation.key];
        else this.data.conversationConfigs[conversation.key] = beforeConfig;
        throw error;
      }
      return clone(config);
    });
  }
  setStorageSettings(input) {
    if (!object(input) || Object.keys(input).some(key => !['workspacePath', 'recordsPath'].includes(key)))
      throw new ChannelError('INVALID_STORAGE_PATH', '存储设置格式不正确');
    const settings = {
      workspacePath: writableDirectory(input.workspacePath, '工作空间路径'),
      recordsPath: writableDirectory(input.recordsPath, '会话记录路径'),
    };
    return this._withSourceLocks(this.views.values(), () => {
      const previous = this.data.storageSettings, oldDirectories = new Map(), destinations = new Map();
      for (const [key, view] of this.views) {
        const metadata = this.data.conversations[key], directory = this._directory(view, settings);
        oldDirectories.set(key, metadata.directory);
        destinations.set(key, directory);
        if (!sameDirectory(metadata.directory, directory)) this._writeAt(view, directory);
      }
      this.data.storageSettings = settings;
      for (const [key, directory] of destinations) this.data.conversations[key].directory = directory;
      try { this.save(); }
      catch (error) {
        this.data.storageSettings = previous;
        for (const [key, directory] of oldDirectories) this.data.conversations[key].directory = directory;
        throw error;
      }
      return this.storageSettings();
    });
  }
  _observation(key, accountId, message, at) {
    const seconds = Number(message.time), time = Number.isFinite(seconds) ? seconds > 1000000000000 ? seconds : seconds * 1000 : at;
    const segments = Array.isArray(message.message) ? message.message : [];
    const text = Array.isArray(message.message)
      ? segments.filter(segment => segment.type === 'text').map(segment => typeof segment.data?.text === 'string' ? segment.data.text : '').join('').trim()
      : typeof message.text === 'string' ? message.text.trim() : '';
    const mediaOnly = !text;
    const mediaNames = { image: '图片', record: '语音', audio: '语音', video: '视频', file: '文件', location: '位置', face: '表情' };
    const placeholders = [...new Set(segments.filter(segment => !['text', 'at', 'reply'].includes(segment.type))
      .map(segment => '[' + (mediaNames[segment.type] || '非文本') + '消息]'))].join(' ');
    return { key, messageId: message.serverMessageId || message.id || key, direction: message.direction || 'incoming',
      senderId: message.sender?.id || accountId, senderName: message.sender?.nickname || message.sender?.id || accountId,
      text: text.slice(0, 12000) || placeholders, time, observedAt: at, kind: 'message', mediaOnly };
  }
  remember(key, at, record, observation = {}) {
    if (Object.hasOwn(this.data.seen, key)) return false;
    let seen = { ...this.data.seen, [key]: at };
    if (Object.keys(seen).length > 10000) {
      seen = Object.fromEntries(Object.entries(seen).filter(([, seenAt]) => seenAt >= at - 660000));
      if (Object.keys(seen).length > 10000)
        throw new ChannelError('DEDUPE_CAPACITY', '短时间内接收消息过多，已暂停自动回复以保留去重记录；请稍后重新启用插件');
    }
    const target = observation.message ? info(observation.accountId || record?.accountId, observation.message.chatType, observation.message.peerId) : recordInfo(record);
    if (record && target && recordInfo(record)?.key !== target.key)
      throw new ChannelError('INVALID_CONVERSATION', '消息记录与观察会话不匹配，未保存到其他会话');
    if (observation.progress !== undefined) {
      const progress = observation.progress;
      if (!object(progress) || !Number.isSafeInteger(progress.count) || progress.count < 0 ||
          progress.target !== null && (!Number.isSafeInteger(progress.target) || progress.target < 1 || progress.target > 10000))
        throw new ChannelError('INVALID_PROGRESS', '群聊计数状态不正确，未继续自动回复');
    }
    const view = target ? this._ensure(target) : undefined;
    this.data.seen = seen;
    if (view) {
      this.claimOwners.set(key, target.key);
      if (observation.message && !view.messages.some(message => message.key === key)) {
        view.messages.push(this._observation(key, target.accountId, observation.message, at));
        if (view.messages.length > historyLimit) view.messages = view.messages.slice(-historyLimit);
      }
      if (observation.progress !== undefined) {
        view.progress = clone(observation.progress);
      }
    }
    if (record) {
      this.data.records.push(record);
      if (view) {
        view.records.push(record);
        if (record.contextKey) this.contextOwners.set(record.contextKey, target.key);
      }
    }
    this.save();
    return true;
  }
  add(record) {
    const target = recordInfo(record), view = target ? this._ensure(target) : undefined;
    this.data.records.push(record);
    if (view) {
      view.records.push(record);
      if (record.contextKey) this.contextOwners.set(record.contextKey, target.key);
      if (Object.hasOwn(this.data.seen, record.key)) this.claimOwners.set(record.key, target.key);
    }
    this.save();
  }
  update(record, fields) {
    Object.assign(record, fields, { updatedAt: Date.now() });
    const target = recordInfo(record), view = target ? this.views.get(target.key) : undefined;
    if (view && record.state === 'sent' && typeof record.reply === 'string' && record.reply &&
        record.acknowledgedMessageIds?.length && !view.messages.some(message => message.sourceKey === record.key)) {
      view.messages.push({ key: 'reply:' + record.key, sourceKey: record.key,
        messageId: record.acknowledgedMessageIds[0], direction: 'outgoing',
        senderId: record.accountId, senderName: record.agentName || this.persona().name,
        text: record.reply, time: record.updatedAt, observedAt: record.updatedAt, kind: 'reply', replyTo: record.senderId,
        mode: record.mode || 'default' });
      if (view.messages.length > historyLimit) view.messages = view.messages.slice(-historyLimit);
    }
    this.save();
  }
  session(contextKey) { return this.data.sessions[contextKey]?.id; }
  saveSession(contextKey, id) {
    this.data.sessions[contextKey] = { id, at: Date.now() };
    // Each conversation keeps its own IDs; unrelated active peers are not evicted.
    this.save();
  }
  forgetSession(contextKey) { delete this.data.sessions[contextKey]; this.save(); }
  resetSessions(selector) {
    for (const key of Object.keys(this.data.sessions)) {
      if (selector) {
        const owner = this.contextOwners.get(key), view = owner ? this.views.get(owner) : undefined;
        if (!view || selector.accountId !== undefined && selector.accountId !== view.accountId ||
            selector.chatType !== undefined && selector.chatType !== view.chatType ||
            selector.peerId !== undefined && selector.peerId !== view.peerId) continue;
      }
      delete this.data.sessions[key];
    }
    this.save();
  }
  records(accountId) {
    return this.data.records.filter(record => record.accountId === accountId).slice(-60).reverse().map(({ contextKey, ...record }) => clone(record));
  }
  recordsPage(accountId, { chatType, peerId, offset = 0, limit = 50, anchor = null }) {
    const conversation = info(accountId, chatType, peerId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        anchor !== null && (typeof anchor !== 'string' || !anchor || anchor.length > 256 || /[\u0000-\u001f\u007f]/.test(anchor)))
      throw new ChannelError('INVALID_HISTORY_PAGE', '记录分页参数不正确');
    const view = this.views.get(conversation.key), all = view?.records ?? [];
    const total = anchor === null ? all.length : all.findIndex(record => record.key === anchor) + 1;
    if (anchor !== null && !total) throw new ChannelError('HISTORY_POSITION_CHANGED', '此前浏览的记录位置已失效，请刷新此会话记录后继续查看');
    // Anchor to an existing record instead of the moving head. Slice only the
    // requested page; its delivery states remain live while its position holds.
    const end = Math.max(0, total - offset);
    const records = all.slice(Math.max(0, end - limit), end).reverse().map(({ contextKey, ...record }) => clone(record));
    return { records, total, offset, limit, hasMore: offset + records.length < total,
      anchor: anchor ?? all.at(-1)?.key ?? null, newerCount: all.length - total,
      recordsPath: this.data.conversations[conversation.key]?.directory || this._directory(conversation) };
  }
  history(accountId, chatType, peerId, limit = 40) {
    const conversation = info(accountId, chatType, peerId);
    const count = Math.max(0, Math.min(historyLimit, Number.isSafeInteger(limit) ? limit : 40));
    // Protocol timestamps have only second precision. Keep append order so an
    // already acknowledged answer stays before a follow-up from that second.
    return clone((this.views.get(conversation.key)?.messages ?? []).slice(-count || Infinity));
  }
  progress(accountId, chatType, peerId) {
    return clone(this.views.get(info(accountId, chatType, peerId).key)?.progress ?? { count: 0, target: null });
  }
  resetProgress(accountId, chatType, peerId) {
    for (const view of this.views.values()) {
      if (accountId !== undefined && view.accountId !== accountId || chatType !== undefined && view.chatType !== chatType || peerId !== undefined && view.peerId !== peerId) continue;
      view.progress = { count: 0, target: null };
    }
    this.save();
  }
  rememberConversationName(accountId, chatType, peerId, name) {
    if (typeof name !== 'string' || !name.trim()) return;
    this.rememberConversationNames(accountId, chatType === 'group'
      ? { groups: [{ id: peerId, name }] } : { privatePeers: [{ id: peerId, name }] });
  }
  rememberConversationNames(accountId, contacts) {
    const settings = this.settings(accountId), before = clone(this.data.conversations), allocated = [];
    let changed = false;
    try {
      for (const [chatType, entries, authorized] of [
        ['private', contacts?.privatePeers, settings.privatePeers], ['group', contacts?.groups, settings.groups],
      ]) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry?.name !== 'string' || !entry.name.trim()) continue;
          const conversation = info(accountId, chatType, entry.id);
          if (!this.views.has(conversation.key) && !authorized.includes(entry.id)) continue;
          if (!this.views.has(conversation.key)) { this._allocate(conversation); allocated.push(conversation.key); }
          const metadata = this.data.conversations[conversation.key], name = entry.name.trim().slice(0, 300);
          if (metadata.name !== name) { metadata.name = name; changed = true; }
        }
      }
      if (changed) this.save();
    } catch (error) {
      this.data.conversations = before;
      for (const key of allocated) { this.views.delete(key); this.written.delete(key); }
      throw error;
    }
  }
  conversations(accountId) {
    const settings = this.settings(accountId), entries = new Map();
    for (const [chatType, peers] of [['private', settings.privatePeers], ['group', settings.groups]]) {
      for (const peerId of peers) { const conversation = info(accountId, chatType, peerId); entries.set(conversation.key, conversation); }
    }
    for (const metadata of Object.values(this.data.conversations)) if (metadata.accountId === accountId) entries.set(metadata.key, metadata);
    return [...entries.values()].map(conversation => {
      const view = this.views.get(conversation.key), records = view?.records ?? [], messages = view?.messages ?? [];
      const latestRecord = records.at(-1);
      return { key: conversation.key, accountId, chatType: conversation.chatType, peerId: conversation.peerId,
        name: this.data.conversations[conversation.key]?.name || conversation.peerId,
        authorized: (conversation.chatType === 'group' ? settings.groups : settings.privatePeers).includes(conversation.peerId),
        config: this.conversationSettings(accountId, conversation.chatType, conversation.peerId),
        recordsPath: this.data.conversations[conversation.key]?.directory || this._directory(conversation),
        recordCount: records.length, messageCount: messages.length,
        lastActivity: Math.max(latestRecord?.createdAt || 0, messages.at(-1)?.time || 0),
        lastState: latestRecord?.state ?? null, progress: clone(view?.progress ?? { count: 0, target: null }) };
    }).sort((a, b) => b.lastActivity - a.lastActivity || a.peerId.localeCompare(b.peerId));
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function acquireLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'owner.lock');
  const token = randomUUID();
  const write = workerPid => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, workerPid, token }), { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.closeSync(fd);
      return {
        worker(pid) { write(pid); },
        release() {
          try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new ChannelError('OWNER_BUSY', '微信插件的实例锁尚未释放，请稍后重新启用插件'); }
      if (alive(owner.pid) || alive(owner.workerPid))
        throw new ChannelError('OWNER_BUSY', '另一个 DSH 实例正在使用微信插件；请先在该实例停用插件');
      fs.unlinkSync(file);
    }
  }
  throw new ChannelError('OWNER_BUSY', '微信插件正在重载，请稍后重试');
}
