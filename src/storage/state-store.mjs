import { defaults, object, historyLimit, clone } from './helpers.mjs';
import { initializeState } from './initialize.mjs';
import { migrateNamedDirectories } from './initialize.mjs';
import { validateArchiveView } from './archive.mjs';
import { writeArchiveSnapshot } from './archive.mjs';
import { withSourceLocks } from './archive.mjs';
import fs from 'node:fs';
import path from 'node:path';

import {
  ChannelError,
  emptySettings,
  validateSettings,
  validateModelChoice,
  validatePersona,
  validateModelConfig,
  validateConversationSettings,
  emptyNaturalState,
  validateNaturalState,
} from '../shared/contracts.mjs';
import { sameDirectory, writableDirectory } from './paths.mjs';
import { identity, conversationFolder, info, recordInfo } from './keys.mjs';
import { write } from './json.mjs';

/**
 * channel.json is the configuration/path index. Each conversation owns one
 * atomic snapshot containing its claims, observations, records and DSH IDs.
 * In-memory aggregates preserve the channel API without mixing archives.
 */
export class StateStore {
  constructor(root) {
    initializeState(this, root);
  }
  _directory(
    conversation,
    storage = this.data.storageSettings,
    config = this.data.conversationConfigs[conversation.key]
  ) {
    const base = config?.recordsPath || storage.recordsPath;
    return path.join(
      base,
      '账号-' + identity([conversation.accountId]).slice(0, 8),
      conversationFolder(conversation, this.data.conversations[conversation.key]?.name || conversation.name)
    );
  }
  migrateNamedDirectories() {
    return migrateNamedDirectories(this);
  }
  _allocate(conversation) {
    let view = this.views.get(conversation.key);
    if (view) return view;
    const directory = this._directory(conversation);
    view = {
      version: 1,
      ownerStoreId: this.data.storeId,
      ...conversation,
      revision: 0,
      records: [],
      messages: [],
      seen: {},
      sessions: {},
      progress: { count: 0, target: null },
    };
    this.data.conversations[conversation.key] = { ...conversation, directory };
    this.views.set(conversation.key, view);
    return view;
  }
  _validateView(view, conversation) {
    return validateArchiveView(this, view, conversation);
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
    return writeArchiveSnapshot(this, view, directory, expectedRevision);
  }
  _rootSnapshot() {
    return {
      ...this.data,
      seen: Object.fromEntries(Object.entries(this.data.seen).filter(([key]) => !this.claimOwners.has(key))),
      sessions: Object.fromEntries(Object.entries(this.data.sessions).filter(([key]) => !this.contextOwners.has(key))),
      records: this.data.records.filter((record) => !recordInfo(record)),
    };
  }
  _saveRoot() {
    const snapshot = this._rootSnapshot(),
      serialized = JSON.stringify(snapshot);
    if (serialized !== this.rootWritten) {
      write(this.file, snapshot);
      this.rootWritten = serialized;
    }
  }
  _withSourceLocks(views, operation) {
    return withSourceLocks(this, views, operation);
  }
  save() {
    for (const [key, view] of this.views) {
      view.seen = Object.fromEntries(
        Object.entries(this.data.seen).filter(([claim]) => this.claimOwners.get(claim) === key)
      );
      view.sessions = Object.fromEntries(
        Object.entries(this.data.sessions).filter(([context]) => this.contextOwners.get(context) === key)
      );
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
        throw new ChannelError(
          'STATE_WRITE_FAILED',
          error instanceof ChannelError ? error.message : '会话文件无法保存，自动回复已暂停，请检查目录和磁盘'
        );
      }
    }
    this._saveRoot();
  }
  settings(accountId) {
    return clone(this.data.accounts[accountId] ?? emptySettings());
  }
  modelChoice() {
    return clone(this.data.modelChoice ?? null);
  }
  persona() {
    return clone(this.data.persona ?? defaults.persona());
  }
  conversationPersona(accountId, chatType, peerId) {
    return this.conversationSettings(accountId, chatType, peerId).persona || this.persona();
  }
  modelConfig() {
    return clone(this.data.modelConfig ?? defaults.model());
  }
  storageSettings() {
    return clone(this.data.storageSettings);
  }
  ensureWorkspace() {
    const directory = this.data.storageSettings.workspacePath;
    if (!fs.existsSync(directory)) return writableDirectory(directory, '工作空间路径');
    try {
      if (!fs.statSync(directory).isDirectory()) throw new Error('Not a directory');
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      return fs.realpathSync(directory);
    } catch {
      throw new ChannelError(
        'STORAGE_PATH_UNWRITABLE',
        '工作空间无法使用，请检查目录和权限，或在存储设置中选择其他目录'
      );
    }
  }
  _setting(field, input, validate) {
    const value = validate(input),
      previous = this.data[field];
    this.data[field] = value;
    try {
      this.save();
    } catch (error) {
      if (previous === undefined) delete this.data[field];
      else this.data[field] = previous;
      throw error;
    }
    return clone(value);
  }
  setPersona(input) {
    return this._setting('persona', input, validatePersona);
  }
  setModelConfig(input) {
    return this._setting('modelConfig', input, validateModelConfig);
  }
  setModelChoice(input) {
    try {
      return this._setting('modelChoice', input, validateModelChoice);
    } catch (error) {
      if (error.code !== 'STATE_WRITE_FAILED') throw error;
      throw new ChannelError('STATE_WRITE_FAILED', '模型选择未能保存，仍使用原选择；请检查磁盘和目录权限');
    }
  }
  configure(accountId, input) {
    const settings = validateSettings(input),
      before = this.data.accounts[accountId];
    this.data.accounts[accountId] = settings;
    try {
      this.save();
    } catch (error) {
      if (before) this.data.accounts[accountId] = before;
      else delete this.data.accounts[accountId];
      throw error;
    }
    return clone(settings);
  }
  conversationSettings(accountId, chatType, peerId) {
    const conversation = info(accountId, chatType, peerId);
    return validateConversationSettings(this.data.conversationConfigs[conversation.key] ?? defaults.conversation());
  }
  setConversationSettings(accountId, chatType, peerId, input) {
    const conversation = info(accountId, chatType, peerId);
    const config = validateConversationSettings(input);
    if (chatType !== 'group' && config.mode !== 'default')
      throw new ChannelError('INVALID_CONVERSATION_MODE', '昵称唤醒、主动参与和自然陪聊仅适用于群聊');
    if (config.recordsPath) config.recordsPath = writableDirectory(config.recordsPath, '当前会话保存路径');
    const view = this._ensure(conversation),
      metadata = this.data.conversations[conversation.key];
    return this._withSourceLocks([view], () => {
      const directory = this._directory(conversation, this.data.storageSettings, config);
      if (!sameDirectory(directory, metadata.directory)) this._writeAt(view, directory);
      const beforeConfig = this.data.conversationConfigs[conversation.key],
        beforeDirectory = metadata.directory;
      this.data.conversationConfigs[conversation.key] = config;
      metadata.directory = directory;
      try {
        this.save();
      } catch (error) {
        metadata.directory = beforeDirectory;
        if (beforeConfig === undefined) delete this.data.conversationConfigs[conversation.key];
        else this.data.conversationConfigs[conversation.key] = beforeConfig;
        throw error;
      }
      return clone(config);
    });
  }
  setStorageSettings(input) {
    if (!object(input) || Object.keys(input).some((key) => !['workspacePath', 'recordsPath'].includes(key)))
      throw new ChannelError('INVALID_STORAGE_PATH', '存储设置格式不正确');
    const settings = {
      workspacePath: writableDirectory(input.workspacePath, '工作空间路径'),
      recordsPath: writableDirectory(input.recordsPath, '会话记录路径'),
    };
    return this._withSourceLocks(this.views.values(), () => {
      const previous = this.data.storageSettings,
        oldDirectories = new Map(),
        destinations = new Map();
      for (const [key, view] of this.views) {
        const metadata = this.data.conversations[key],
          directory = this._directory(view, settings);
        oldDirectories.set(key, metadata.directory);
        destinations.set(key, directory);
        if (!sameDirectory(metadata.directory, directory)) this._writeAt(view, directory);
      }
      this.data.storageSettings = settings;
      for (const [key, directory] of destinations) this.data.conversations[key].directory = directory;
      try {
        this.save();
      } catch (error) {
        this.data.storageSettings = previous;
        for (const [key, directory] of oldDirectories) this.data.conversations[key].directory = directory;
        throw error;
      }
      return this.storageSettings();
    });
  }
  _observation(key, accountId, message, at) {
    const seconds = Number(message.time),
      time = Number.isFinite(seconds) ? (seconds > 1000000000000 ? seconds : seconds * 1000) : at;
    const segments = Array.isArray(message.message) ? message.message : [];
    const text = Array.isArray(message.message)
      ? segments
          .filter((segment) => segment.type === 'text')
          .map((segment) => (typeof segment.data?.text === 'string' ? segment.data.text : ''))
          .join('')
          .trim()
      : typeof message.text === 'string'
        ? message.text.trim()
        : '';
    const mediaOnly = !text;
    const mediaNames = {
      image: '图片',
      record: '语音',
      audio: '语音',
      video: '视频',
      file: '文件',
      location: '位置',
      face: '表情',
    };
    const placeholders = [
      ...new Set(
        segments
          .filter((segment) => !['text', 'at', 'reply'].includes(segment.type))
          .map((segment) => '[' + (mediaNames[segment.type] || '非文本') + '消息]')
      ),
    ].join(' ');
    return {
      key,
      messageId: message.serverMessageId || message.id || key,
      direction: message.direction || 'incoming',
      senderId: message.sender?.id || accountId,
      senderName: message.sender?.nickname || message.sender?.id || accountId,
      text: text.slice(0, 12000) || placeholders,
      time,
      observedAt: at,
      kind: 'message',
      mediaOnly,
      attachments: segments
        .filter((segment) => ['image', 'face'].includes(segment.type) && typeof segment.data?.resourceId === 'string')
        .map((segment) => ({ resourceId: segment.data.resourceId, type: segment.type })),
    };
  }
  remember(key, at, record, observation = {}) {
    if (Object.hasOwn(this.data.seen, key)) return false;
    let seen = { ...this.data.seen, [key]: at };
    if (Object.keys(seen).length > 10000) {
      seen = Object.fromEntries(Object.entries(seen).filter(([, seenAt]) => seenAt >= at - 660000));
      if (Object.keys(seen).length > 10000)
        throw new ChannelError(
          'DEDUPE_CAPACITY',
          '短时间内接收消息过多，已暂停自动回复以保留去重记录；请稍后重新启用插件'
        );
    }
    const target = observation.message
      ? info(observation.accountId || record?.accountId, observation.message.chatType, observation.message.peerId)
      : recordInfo(record);
    if (record && target && recordInfo(record)?.key !== target.key)
      throw new ChannelError('INVALID_CONVERSATION', '消息记录与观察会话不匹配，未保存到其他会话');
    if (observation.progress !== undefined) {
      const progress = observation.progress;
      if (
        !object(progress) ||
        !Number.isSafeInteger(progress.count) ||
        progress.count < 0 ||
        (progress.target !== null &&
          (!Number.isSafeInteger(progress.target) || progress.target < 1 || progress.target > 10000))
      )
        throw new ChannelError('INVALID_PROGRESS', '群聊计数状态不正确，未继续自动回复');
    }
    const natural = observation.natural === undefined ? undefined : validateNaturalState(observation.natural);
    const view = target ? this._ensure(target) : undefined;
    this.data.seen = seen;
    if (view) {
      this.claimOwners.set(key, target.key);
      if (observation.message && !view.messages.some((message) => message.key === key)) {
        view.messages.push(this._observation(key, target.accountId, observation.message, at));
        if (view.messages.length > historyLimit) view.messages = view.messages.slice(-historyLimit);
      }
      if (observation.progress !== undefined) {
        view.progress = clone(observation.progress);
      }
      if (natural !== undefined) view.natural = natural;
    }
    if (record) {
      this.data.records.push(record);
      if (view) {
        view.records.push(record);
        if (record.contextKey) this.contextOwners.set(record.contextKey, target.key);
      }
    }
    this.save();
    if (view && observation.message)
      this.memory?.append(
        target,
        view.messages.find((entry) => entry.key === key)
      );
    return true;
  }
  add(record, observation = {}) {
    const natural = observation.natural === undefined ? undefined : validateNaturalState(observation.natural);
    const target = recordInfo(record),
      view = target ? this._ensure(target) : undefined;
    this.data.records.push(record);
    if (view) {
      if (natural !== undefined) view.natural = natural;
      view.records.push(record);
      if (record.contextKey) this.contextOwners.set(record.contextKey, target.key);
      if (Object.hasOwn(this.data.seen, record.key)) this.claimOwners.set(record.key, target.key);
    }
    this.save();
  }
  update(record, fields, observation = {}) {
    const natural = observation.natural === undefined ? undefined : validateNaturalState(observation.natural);
    Object.assign(record, fields, { updatedAt: Date.now() });
    const target = recordInfo(record),
      view = target ? this.views.get(target.key) : undefined;
    if (view && natural !== undefined) view.natural = natural;
    if (
      view &&
      record.state === 'sent' &&
      typeof record.reply === 'string' &&
      (record.reply || record.replyMedia) &&
      record.acknowledgedMessageIds?.length &&
      !view.messages.some((message) => message.sourceKey === record.key)
    ) {
      view.messages.push({
        key: 'reply:' + record.key,
        sourceKey: record.key,
        messageId: record.acknowledgedMessageIds[0],
        direction: 'outgoing',
        senderId: record.accountId,
        senderName: record.agentName || this.persona().name,
        text:
          record.reply || `[${record.replyMedia.kind === 'sticker' ? '表情包' : '图片'}：${record.replyMedia.name}]`,
        ...(record.replyMedia
          ? {
              attachments: [
                {
                  assetId: record.replyMedia.id,
                  type: record.replyMedia.kind === 'sticker' ? 'face' : 'image',
                  description: record.replyMedia.description || record.replyMedia.name,
                },
              ],
            }
          : {}),
        time: record.updatedAt,
        observedAt: record.updatedAt,
        kind: 'reply',
        replyTo: record.senderId,
        mode: record.mode || 'default',
      });
      if (view.messages.length > historyLimit) view.messages = view.messages.slice(-historyLimit);
    }
    this.save();
    if (view && record.state === 'sent') {
      const entry = view.messages.find((message) => message.sourceKey === record.key);
      if (entry) this.memory?.append(target, entry);
    }
  }
  session(contextKey) {
    return this.data.sessions[contextKey]?.id;
  }
  saveSession(contextKey, id) {
    this.data.sessions[contextKey] = { id, at: Date.now() };
    // Each conversation keeps its own IDs; unrelated active peers are not evicted.
    this.save();
  }
  forgetSession(contextKey) {
    delete this.data.sessions[contextKey];
    this.save();
  }
  resetSessions(selector) {
    for (const key of Object.keys(this.data.sessions)) {
      if (selector) {
        const owner = this.contextOwners.get(key),
          view = owner ? this.views.get(owner) : undefined;
        if (
          !view ||
          (selector.accountId !== undefined && selector.accountId !== view.accountId) ||
          (selector.chatType !== undefined && selector.chatType !== view.chatType) ||
          (selector.peerId !== undefined && selector.peerId !== view.peerId)
        )
          continue;
      }
      delete this.data.sessions[key];
    }
    this.save();
  }
  records(accountId) {
    return this.data.records
      .filter((record) => record.accountId === accountId)
      .slice(-60)
      .reverse()
      .map(({ contextKey, ...record }) => clone(record));
  }
  recordsPage(accountId, { chatType, peerId, offset = 0, limit = 50, anchor = null }) {
    const conversation = info(accountId, chatType, peerId);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (anchor !== null &&
        (typeof anchor !== 'string' || !anchor || anchor.length > 256 || /[\u0000-\u001f\u007f]/.test(anchor)))
    )
      throw new ChannelError('INVALID_HISTORY_PAGE', '记录分页参数不正确');
    const view = this.views.get(conversation.key),
      all = view?.records ?? [];
    const total = anchor === null ? all.length : all.findIndex((record) => record.key === anchor) + 1;
    if (anchor !== null && !total)
      throw new ChannelError('HISTORY_POSITION_CHANGED', '此前浏览的记录位置已失效，请刷新此会话记录后继续查看');
    // Anchor to an existing record instead of the moving head. Slice only the
    // requested page; its delivery states remain live while its position holds.
    const end = Math.max(0, total - offset);
    const records = all
      .slice(Math.max(0, end - limit), end)
      .reverse()
      .map(({ contextKey, ...record }) => clone(record));
    return {
      records,
      total,
      offset,
      limit,
      hasMore: offset + records.length < total,
      anchor: anchor ?? all.at(-1)?.key ?? null,
      newerCount: all.length - total,
      recordsPath: this.data.conversations[conversation.key]?.directory || this._directory(conversation),
    };
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
  naturalState(accountId, chatType, peerId) {
    return validateNaturalState(
      clone(this.views.get(info(accountId, chatType, peerId).key)?.natural ?? emptyNaturalState())
    );
  }
  setNaturalState(accountId, chatType, peerId, value) {
    const natural = validateNaturalState(value),
      view = this._ensure(info(accountId, chatType, peerId));
    const previous = view.natural;
    view.natural = natural;
    try {
      this.save();
    } catch (error) {
      if (previous === undefined) delete view.natural;
      else view.natural = previous;
      throw error;
    }
    return clone(natural);
  }
  resetProgress(accountId, chatType, peerId, { resetNatural = true } = {}) {
    for (const view of this.views.values()) {
      if (
        (accountId !== undefined && view.accountId !== accountId) ||
        (chatType !== undefined && view.chatType !== chatType) ||
        (peerId !== undefined && view.peerId !== peerId)
      )
        continue;
      view.progress = { count: 0, target: null };
      if (resetNatural && view.natural !== undefined) view.natural = emptyNaturalState();
    }
    this.save();
  }
  rememberConversationName(accountId, chatType, peerId, name) {
    if (typeof name !== 'string' || !name.trim()) return;
    this.rememberConversationNames(
      accountId,
      chatType === 'group' ? { groups: [{ id: peerId, name }] } : { privatePeers: [{ id: peerId, name }] }
    );
  }
  rememberConversationNames(accountId, contacts) {
    const settings = this.settings(accountId),
      before = clone(this.data.conversations),
      allocated = [];
    let changed = false;
    try {
      for (const [chatType, entries, authorized] of [
        ['private', contacts?.privatePeers, settings.privatePeers],
        ['group', contacts?.groups, settings.groups],
      ]) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry?.name !== 'string' || !entry.name.trim()) continue;
          const conversation = info(accountId, chatType, entry.id);
          if (!this.views.has(conversation.key) && !authorized.includes(entry.id)) continue;
          if (!this.views.has(conversation.key)) {
            this._allocate(conversation);
            allocated.push(conversation.key);
          }
          const metadata = this.data.conversations[conversation.key],
            name = entry.name.trim().slice(0, 300);
          if (metadata.name !== name) {
            metadata.name = name;
            changed = true;
          }
        }
      }
      if (changed) this.save();
    } catch (error) {
      this.data.conversations = before;
      for (const key of allocated) {
        this.views.delete(key);
        this.written.delete(key);
      }
      throw error;
    }
    if (changed) this.migrateNamedDirectories();
  }
  conversations(accountId) {
    const settings = this.settings(accountId),
      entries = new Map();
    for (const [chatType, peers] of [
      ['private', settings.privatePeers],
      ['group', settings.groups],
    ]) {
      for (const peerId of peers) {
        const conversation = info(accountId, chatType, peerId);
        entries.set(conversation.key, conversation);
      }
    }
    for (const metadata of Object.values(this.data.conversations))
      if (metadata.accountId === accountId) entries.set(metadata.key, metadata);
    return [...entries.values()]
      .map((conversation) => {
        const view = this.views.get(conversation.key),
          records = view?.records ?? [],
          messages = view?.messages ?? [];
        const latestRecord = records.at(-1);
        return {
          key: conversation.key,
          accountId,
          chatType: conversation.chatType,
          peerId: conversation.peerId,
          name: this.data.conversations[conversation.key]?.name || conversation.peerId,
          authorized: (conversation.chatType === 'group' ? settings.groups : settings.privatePeers).includes(
            conversation.peerId
          ),
          config: this.conversationSettings(accountId, conversation.chatType, conversation.peerId),
          recordsPath: this.data.conversations[conversation.key]?.directory || this._directory(conversation),
          recordCount: records.length,
          messageCount: messages.length,
          lastActivity: Math.max(latestRecord?.createdAt || 0, messages.at(-1)?.time || 0),
          lastState: latestRecord?.state ?? null,
          progress: clone(view?.progress ?? { count: 0, target: null }),
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity || a.peerId.localeCompare(b.peerId));
  }
}
