import { defaults, object, historyLimit, clone } from "./helpers.mjs";
import { describeMessageImage, unavailableMessage } from '../../shared/message-content.mjs';
import { receivedFileMetadata } from '../../shared/received-files.mjs';
import { initializeState } from "./initialize.mjs";
import { migrateNamedDirectories } from "./initialize.mjs";
import { validateArchiveView } from "./archive.mjs";
import { writeArchiveSnapshot } from "./archive.mjs";
import { withSourceLocks } from "./archive.mjs";
import fs from 'node:fs';
import path from 'node:path';

import {
  ChannelError,
  emptySettings,
  validateSettings,
  validateModelChoice,
  validateGlobalPersona,
  validatePersonaEntry,
  validatePersonaList,
  PERSONA_LIMIT,
  validateModelConfig,
  validateConversationSettings,
  personaText,
  emptyNaturalState,
  validateNaturalState,
} from "../../shared/contracts.mjs";
import { sameDirectory, writableDirectory } from "./paths.mjs";
import { identity, conversationFolder, info, recordInfo } from "./keys.mjs";
import { CONFIG_FIELDS } from '../config/repository.mjs';
import { RoleCards } from './role-cards.mjs';
import { roleCardSettings, roleCardSettingsRevision } from '../../shared/role-card-settings.mjs';
import { revokedObjects, personAuthorized } from '../../shared/authorization.mjs';

/** Markers kept on a view; symbol keys never reach the archive JSON. */
const DIRTY = Symbol('unsaved changes');
const WRITTEN = Symbol('written structure');

/** Answers the archive layer's freshness check for a view that has unsaved state. */
const UNSAVED = '\u0000unsaved';

/**
 * Structural fingerprint of what a conversation can be edited through outside the
 * write paths below: the authorization purge replaces messages and records and
 * resets progress. It is far cheaper than serializing the archive and only has to
 * notice that something changed, so array identity, lengths and the small derived
 * states are enough.
 */
function fingerprint(view) {
  return {
    messages: view.messages,
    records: view.records,
    messagesLength: view.messages.length,
    recordsLength: view.records.length,
    progress: JSON.stringify(view.progress ?? null),
    natural: view.natural === undefined ? '' : JSON.stringify(view.natural),
  };
}
function sameFingerprint(written, current) {
  return Boolean(written) && written.messages === current.messages && written.records === current.records &&
    written.messagesLength === current.messagesLength && written.recordsLength === current.recordsLength &&
    written.progress === current.progress && written.natural === current.natural;
}
/** Claim and session maps hold numbers and the session objects of `data.sessions`. */
function sameEntries(before, after) {
  const keys = Object.keys(after);
  return Object.keys(before).length === keys.length &&
    keys.every((key) => Object.hasOwn(before, key) && before[key] === after[key]);
}

/**
 * The last snapshot written for each conversation. Keeping the revision of that
 * write, instead of a second full JSON copy of every view, is what lets a save skip
 * unchanged conversations without serializing them. `archive.mjs` still compares a
 * snapshot with the file, so `get` rebuilds one on demand: only for a view that
 * still matches what was written, and never for one with unsaved state (which could
 * not match a file anyway).
 */
class WrittenSnapshots extends Map {
  constructor(store) {
    super();
    this.store = store;
  }
  get(key) {
    if (!this.has(key)) return undefined;
    const view = this.store.views.get(key);
    if (!view || super.get(key) !== view.revision || this.store._changed(view)) return UNSAVED;
    return JSON.stringify(view);
  }
}

/**
 * config.yaml owns settings; channel.json owns the runtime/path index. Each conversation owns one
 * atomic snapshot containing its claims, observations, records and DSH IDs.
 * In-memory aggregates preserve the channel API without mixing archives.
 */
export class StateStore {
  constructor(root) {
    initializeState(this, root);
    this.roleCards = new RoleCards(this);
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
      this._committed(view);
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
  /** Put a snapshot back where the index points after a failed directory switch. */
  _restoreDirectory(view) {
    try {
      this._writeAt(view, this.data.conversations[view.key].directory);
      this._committed(view);
    } catch {
      // The next save must rewrite unconditionally rather than trust a snapshot the
      // index no longer points at.
      this.written.delete(view.key);
    }
  }
  /** Record that this conversation changed and the next save has to write it. */
  _touch(view) {
    view[DIRTY] = true;
  }
  /** Whether the view differs from the snapshot that was written last. */
  _changed(view) {
    return view[DIRTY] === true || !sameFingerprint(view[WRITTEN], fingerprint(view));
  }
  /** Whether `save()` still has to write this conversation. */
  _pending(view) {
    return this._changed(view) || !this.written.has(view.key);
  }
  /** Accept the current content as written and keep which revision it was. */
  _committed(view) {
    view[DIRTY] = false;
    view[WRITTEN] = fingerprint(view);
    this._writtenSnapshots().set(view.key, view.revision);
  }
  /**
   * State loading seeds `written` with a serialized copy of every conversation.
   * Compare each view once here instead of on every save, then keep revisions.
   */
  _writtenSnapshots() {
    if (this.written instanceof WrittenSnapshots) return this.written;
    const seeded = this.written,
      snapshots = new WrittenSnapshots(this);
    this.written = snapshots;
    for (const [key, snapshot] of seeded) {
      const view = this.views.get(key);
      if (!view) continue;
      // Loaded views can already be edited (interrupted sends are reset to
      // unknown), so only a view that still equals its snapshot starts clean.
      if (typeof snapshot === 'string' && JSON.stringify(view) === snapshot) this._committed(view);
      else {
        this._touch(view);
        snapshots.set(key, view.revision);
      }
    }
    return snapshots;
  }
  _rootSnapshot() {
    const snapshot = {
      ...this.data,
      seen: Object.fromEntries(Object.entries(this.data.seen).filter(([key]) => !this.claimOwners.has(key))),
      sessions: Object.fromEntries(Object.entries(this.data.sessions).filter(([key]) => !this.contextOwners.has(key))),
      records: this.data.records.filter((record) => !recordInfo(record)),
    };
    for (const field of CONFIG_FIELDS) delete snapshot[field];
    return snapshot;
  }
  _saveRoot() {
    const snapshot = this._rootSnapshot(),
      serialized = JSON.stringify(snapshot);
    // Only the indented copy that is actually written is serialized again; the
    // compact form is the one `rootWritten` (and a workspace migration) compares.
    // channel.json is message state, not configuration: `commit` verifies the files
    // on disk only when it replaces config.yaml, so an owner's manual YAML edit
    // stops the next configuration write instead of freezing auto replies.
    this.config.commit(this.config.snapshot(this.data), serialized !== this.rootWritten
      ? [{ file: this.file, bytes: Buffer.from(JSON.stringify(snapshot, null, 2) + '\n') }] : []);
    this.rootWritten = serialized;
  }
  _withSourceLocks(views, operation) {
    return withSourceLocks(this, views, operation);
  }
  save() {
    this._writtenSnapshots();
    for (const [key, view] of this.views) {
      const seen = Object.fromEntries(
          Object.entries(this.data.seen).filter(([claim]) => this.claimOwners.get(claim) === key)
        ),
        sessions = Object.fromEntries(
          Object.entries(this.data.sessions).filter(([context]) => this.contextOwners.get(context) === key)
        );
      // Claims and sessions are derived here, so a change in either marks the view.
      if (!sameEntries(view.seen, seen) || !sameEntries(view.sessions, sessions)) this._touch(view);
      view.seen = seen;
      view.sessions = sessions;
      // Unchanged conversations are skipped without serializing them; see
      // `_pending` and WrittenSnapshots.
      if (!this._pending(view)) continue;
      const revision = view.revision;
      view.revision++;
      try {
        this._writeAt(view, this.data.conversations[key].directory, this.written.has(key) ? revision : undefined);
        this._committed(view);
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
  groupMemberIndex(accountId) {
    const record = this.data.groupMemberIndex?.[accountId];
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  }
  /** Member ids of every currently authorized group plus everyone ever seen in
   * one, read synchronously from the refreshed index so authorization checks
   * never wait on the protocol. The owner can still deny one person: an explicit
   * revocation is recorded as an exclusion and survives the person remaining in
   * the group. `seen` exists so that losing membership only revokes access and
   * never deletes data because of an incomplete protocol read. */
  groupMemberSets(accountId) {
    const cached = this.groupMemberCache?.get(accountId);
    if (cached && cached.revision === this.groupMemberRevision) return cached;
    const ids = new Set(), seen = new Set(),
      record = this.groupMemberIndex(accountId),
      groups = this.data.accounts[accountId]?.groups;
    if (record && Array.isArray(groups)) {
      const excluded = new Set(this.data.groupMemberExclusions?.[accountId]?.excludedPersonIds || []),
        valid = personId => typeof personId === 'string' && !!personId && personId !== accountId &&
          !personId.endsWith('@chatroom') && !excluded.has(personId);
      for (const groupId of groups) {
        const entry = record.groups?.[groupId];
        if (!entry) continue;
        for (const personId of entry.ids || []) if (valid(personId)) ids.add(personId);
        for (const personId of entry.seen || entry.ids || []) if (valid(personId)) seen.add(personId);
      }
    }
    const value = { revision: this.groupMemberRevision, ids, seen };
    this.groupMemberCache = this.groupMemberCache ?? new Map();
    this.groupMemberCache.set(accountId, value);
    return value;
  }
  authorizedGroupMemberIds(accountId) {
    return this.groupMemberSets(accountId).ids;
  }
  isGroupMember(accountId, personId) {
    return this.authorizedGroupMemberIds(accountId).has(personId);
  }
  seenGroupMember(accountId, personId) {
    return this.groupMemberSets(accountId).seen.has(personId);
  }
  groupMemberIndexView(accountId) {
    const record = this.groupMemberIndex(accountId),
      groups = Array.isArray(this.data.accounts[accountId]?.groups) ? this.data.accounts[accountId].groups : [];
    return {
      syncedAt: Number.isFinite(record?.syncedAt) ? record.syncedAt : null,
      authorizedGroups: groups.length,
      indexedGroups: groups.filter(groupId => Array.isArray(record?.groups?.[groupId]?.ids)).length,
      members: this.authorizedGroupMemberIds(accountId).size,
      excluded: (this.data.groupMemberExclusions?.[accountId]?.excludedPersonIds || []).length,
    };
  }
  /** Replace the index of authorized groups only. A group that is no longer
   * authorized loses its entry, so its members cannot keep the derived access. */
  saveGroupMemberIndex(accountId, entries = {}, { syncedAt } = {}) {
    const before = this.data.groupMemberIndex,
      previous = this.groupMemberIndex(accountId),
      authorized = new Set(this.data.accounts[accountId]?.groups || []),
      next = {};
    for (const [groupId, value] of Object.entries(entries || {})) {
      if (!authorized.has(groupId) || !Array.isArray(value?.ids)) continue;
      const ids = [...new Set(value.ids.filter(personId => typeof personId === 'string' && personId.length > 0 &&
        personId.length <= 200 && personId !== accountId && !personId.endsWith('@chatroom') && !/[\s\u0000-\u001f]/u.test(personId)))],
        pointed = previous?.groups?.[groupId],
        // "Seen" remembers everyone confirmed in this group, so a member leaving
        // (or a partial read) revokes access without deleting their data.
        known = Array.isArray(pointed?.seen) ? pointed.seen : Array.isArray(pointed?.ids) ? pointed.ids : [];
      next[groupId] = { accountId, chatType: 'group', peerId: groupId,
        at: Number.isFinite(value.at) ? value.at : Date.now(), ids: ids.slice(0, 4000).sort(),
        seen: [...new Set([...known, ...ids])].sort().slice(0, 4000) };
    }
    const record = {
      ...(previous || {}),
      groups: next,
      syncedAt: Number.isFinite(syncedAt) ? syncedAt : Number.isFinite(previous?.syncedAt) ? previous.syncedAt : null,
    };
    this.data.groupMemberIndex = { ...this.data.groupMemberIndex, [accountId]: record };
    try {
      this.save();
    } catch (error) {
      this.data.groupMemberIndex = before;
      throw new ChannelError('STATE_WRITE_FAILED', '群成员名单未能保存，本次未扩大人物授权；请检查目录和权限');
    }
    this.groupMemberRevision++;
    this.groupMemberCache?.delete(accountId);
    return this.groupMemberIndexView(accountId);
  }
  modelChoice() {
    return clone(this.data.modelChoice ?? null);
  }
  /** Named personas sit beside the active one; `data.persona` mirrors the active entry. */
  personaEntries() {
    const stored = Array.isArray(this.data.personas) ? this.data.personas : [];
    if (stored.length)
      return stored.map(entry => ({ id: entry.id, name: entry.name, source: entry.source,
        createdAt: entry.createdAt, updatedAt: entry.updatedAt, persona: clone(entry.persona),
        ...(entry.provenance ? { provenance: clone(entry.provenance) } : {}) }));
    // Older workspaces hold a single persona; present it as one entry.
    const legacy = clone(this.data.persona ?? defaults.persona());
    return [{ id: 'default', name: legacy.name || '微信助手', source: 'manual', createdAt: 0, persona: legacy }];
  }
  activePersonaId() {
    const entries = this.personaEntries();
    return (entries.find(entry => entry.id === this.data.activePersonaId) || entries[0])?.id ?? null;
  }
  persona() {
    const stored = Array.isArray(this.data.personas) ? this.personaEntries() : [];
    if (stored.length) {
      const active = stored.find(entry => entry.id === this.activePersonaId());
      return clone(active?.persona ?? defaults.persona());
    }
    return clone(this.data.persona ?? defaults.persona());
  }
  personasView() {
    const entries = this.personaEntries();
    return {
      activeId: this.activePersonaId(),
      items: entries.map(entry => ({ id: entry.id, name: entry.name, source: entry.source,
        createdAt: entry.createdAt, updatedAt: entry.updatedAt || entry.createdAt,
        chars: Array.from(personaText(entry.persona)).length })),
    };
  }
  _writePersonas(list, activeId) {
    const personas = validatePersonaList(list);
    const active = personas.find(entry => entry.id === activeId) || personas[0];
    const before = { personas: this.data.personas, activePersonaId: this.data.activePersonaId, persona: this.data.persona };
    this.data.personas = personas;
    this.data.activePersonaId = active?.id ?? personas[0].id;
    this.data.persona = clone(active?.persona ?? defaults.persona());
    try {
      this.save();
    } catch (error) {
      this.data.personas = before.personas;
      if (before.activePersonaId === undefined) delete this.data.activePersonaId;
      else this.data.activePersonaId = before.activePersonaId;
      this.data.persona = before.persona;
      throw error;
    }
    return this.personasView();
  }
  _personaId(entries) {
    let index = 1;
    while (entries.some(entry => entry.id === `p${index}`)) index += 1;
    return `p${index}`;
  }
  createPersona({ persona: input, name, source = 'manual', provenance }) {
    const entries = this.personaEntries();
    if (entries.length >= PERSONA_LIMIT)
      throw new ChannelError('PERSONA_LIMIT', `最多保留 ${PERSONA_LIMIT} 个人设，请先删掉一个`);
    const persona = validateGlobalPersona(input);
    const id = this._personaId(entries);
    const entry = validatePersonaEntry({ id, name: name || persona.name || '新人设', source, createdAt: Date.now(), persona, provenance });
    return this._writePersonas([...entries, entry], id);
  }
  selectPersona(id) {
    const entries = this.personaEntries();
    if (!entries.some(entry => entry.id === id))
      throw new ChannelError('PERSONA_NOT_FOUND', '人设不存在，请刷新后重试');
    return this._writePersonas(entries, id);
  }
  deletePersona(id) {
    const entries = this.personaEntries();
    const remaining = entries.filter(entry => entry.id !== id);
    if (remaining.length === entries.length) throw new ChannelError('PERSONA_NOT_FOUND', '人设不存在，请刷新后重试');
    if (!remaining.length) throw new ChannelError('PERSONA_REQUIRED', '至少要保留一个人设');
    const activeId = this.activePersonaId() === id ? remaining[0].id : this.activePersonaId();
    return this._writePersonas(remaining, activeId);
  }
  conversationPersona(accountId, chatType, peerId) {
    return this.persona();
  }
  modelConfig() {
    return clone(this.data.modelConfig ?? defaults.model());
  }
  storageSettings() {
    return clone(this.data.storageSettings);
  }
  roleCardSettings() { return roleCardSettings(this.data.roleCardSettings); }
  roleCardSettingsView() {
    const settings = this.roleCardSettings();
    return { settings, revision: roleCardSettingsRevision(settings) };
  }
  setRoleCardSettings(input, revision) {
    const settings = roleCardSettings(input);
    if (revision !== this.roleCardSettingsView().revision)
      throw new ChannelError('ROLE_CARD_SETTINGS_CHANGED', '角色卡总设置已更新，请重新载入后保存；当前草稿保留');
    this._setting('roleCardSettings', settings, roleCardSettings);
    return this.roleCardSettingsView();
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
    const persona = validateGlobalPersona(input);
    // Keep writing the single legacy field until a real library exists: adding
    // `personas` here would change persisted data for owners who never asked for it.
    if (!Array.isArray(this.data.personas) || !this.data.personas.length)
      return this._setting('persona', persona, validateGlobalPersona);
    const entries = this.personaEntries(), activeId = this.activePersonaId();
    if (!activeId) return this.createPersona({ persona, source: 'manual' });
    return this._writePersonas(entries.map(entry => entry.id === activeId
      ? { ...entry, persona, updatedAt: Date.now() }
      : entry), activeId);
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
      before = this.data.accounts[accountId], revoked = revokedObjects(accountId, before, settings),
      previousRevocations = this.data.authorizationRevocations, previousEpochs = this.data.authorizationEpochs,
      previousExclusions = this.data.groupMemberExclusions?.[accountId],
      exclusions = new Set(Array.isArray(previousExclusions?.excludedPersonIds) ? previousExclusions.excludedPersonIds : []);
    // Revoking a person must also win over their group membership. Granting the
    // same person again through the private list removes the exclusion.
    for (const row of revoked) if (row.chatType === 'private') exclusions.add(row.peerId);
    for (const peerId of settings.privatePeers) exclusions.delete(peerId);
    if (revoked.length) {
      this.data.authorizationRevocations = [...previousRevocations, ...revoked].filter((row, index, rows) =>
        rows.findIndex(other => other.accountId === row.accountId && other.chatType === row.chatType && other.peerId === row.peerId) === index);
      this.data.authorizationEpochs = { ...previousEpochs, [accountId]: (previousEpochs[accountId] || 0) + 1 };
    }
    this.data.accounts[accountId] = settings;
    const changedExclusions = JSON.stringify(previousExclusions?.excludedPersonIds || []) !== JSON.stringify([...exclusions].sort());
    if (changedExclusions)
      this.data.groupMemberExclusions = { ...this.data.groupMemberExclusions, [accountId]: { excludedPersonIds: [...exclusions].sort() } };
    try {
      this.save();
    } catch (error) {
      if (before) this.data.accounts[accountId] = before;
      else delete this.data.accounts[accountId];
      this.data.authorizationRevocations = previousRevocations; this.data.authorizationEpochs = previousEpochs;
      if (changedExclusions) {
        if (previousExclusions === undefined) delete this.data.groupMemberExclusions[accountId];
        else this.data.groupMemberExclusions[accountId] = previousExclusions;
      }
      throw error;
    }
    this.groupMemberRevision++;
    this.groupMemberCache?.delete(accountId);
    this.onAuthorizationChange?.({ accountId, before, settings, revoked });
    return clone(settings);
  }
  conversationSettings(accountId, chatType, peerId) {
    const conversation = info(accountId, chatType, peerId);
    return validateConversationSettings(this.data.conversationConfigs[conversation.key] ?? this.config.data.conversationDefaults);
  }
  setConversationSettings(accountId, chatType, peerId, input) {
    if (input?.persona != null)
      throw new ChannelError('PERSONA_GLOBAL_ONLY', '所有会话共用默认助手，请在“默认助手”的全局自定义入口编辑');
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
        beforeDirectory = metadata.directory, beforeArchives = metadata.archiveDirectories;
      this.data.conversationConfigs[conversation.key] = config;
      if (!sameDirectory(directory, beforeDirectory)) metadata.archiveDirectories = [...new Set([...(beforeArchives || []), beforeDirectory])];
      metadata.directory = directory;
      try {
        this.save();
      } catch (error) {
        metadata.directory = beforeDirectory;
        if (beforeArchives === undefined) delete metadata.archiveDirectories; else metadata.archiveDirectories = beforeArchives;
        if (beforeConfig === undefined) delete this.data.conversationConfigs[conversation.key];
        else this.data.conversationConfigs[conversation.key] = beforeConfig;
        this._restoreDirectory(view);
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
        oldArchives = new Map(),
        destinations = new Map();
      for (const [key, view] of this.views) {
        const metadata = this.data.conversations[key],
          directory = this._directory(view, settings);
        oldDirectories.set(key, metadata.directory);
        oldArchives.set(key, metadata.archiveDirectories);
        destinations.set(key, directory);
        if (!sameDirectory(metadata.directory, directory)) this._writeAt(view, directory);
      }
      this.data.storageSettings = settings;
      for (const [key, directory] of destinations) {
        const metadata = this.data.conversations[key];
        if (!sameDirectory(metadata.directory, directory)) metadata.archiveDirectories = [...new Set([...(metadata.archiveDirectories || []), metadata.directory])];
        metadata.directory = directory;
      }
      try {
        this.save();
      } catch (error) {
        this.data.storageSettings = previous;
        for (const [key, directory] of oldDirectories) this.data.conversations[key].directory = directory;
        for (const [key, archives] of oldArchives) {
          if (archives === undefined) delete this.data.conversations[key].archiveDirectories;
          else this.data.conversations[key].archiveDirectories = archives;
        }
        for (const [key, view] of this.views) if (oldDirectories.has(key)) this._restoreDirectory(view);
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
          .map((segment) => segment.type === 'file' && receivedFileMetadata(segment.data)
            ? '[文件：' + receivedFileMetadata(segment.data).name + '（正文未读取）]' : '[' + (mediaNames[segment.type] || '非文本') + '消息]')
      ),
    ].join(' ');
    const entry = {
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
      ...(segments.some(segment => segment.type === 'file') ? { files: segments.filter(segment => segment.type === 'file').map(segment => receivedFileMetadata(segment.data)).filter(Boolean) } : {}),
      attachments: segments
        .filter((segment) => ['image', 'face'].includes(segment.type) && typeof segment.data?.resourceId === 'string')
        .map((segment) => ({ resourceId: segment.data.resourceId, type: segment.type })),
    };
    if (unavailableMessage(message)) entry.contentUnavailable = true;
    return entry;
  }
  describeImageReferences(input, image) {
    const view = this.views.get(info(input.accountId, input.chatType, input.peerId).key);
    if (view) {
      let changed = false;
      view.messages = view.messages.map(entry => {
        const next = describeMessageImage(entry, input, image);
        if (next !== entry) changed = true;
        return next;
      });
      if (changed) {
        this._touch(view);
        this.save();
      }
    }
    this.memory?.describeImageReferences(input, image);
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
        this._touch(view);
      }
      if (observation.progress !== undefined) {
        view.progress = clone(observation.progress);
        this._touch(view);
      }
      if (natural !== undefined) {
        view.natural = natural;
        this._touch(view);
      }
    }
    if (record) {
      this.data.records.push(record);
      if (view) {
        view.records.push(record);
        this._touch(view);
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
      if (natural !== undefined) {
        view.natural = natural;
        this._touch(view);
      }
      view.records.push(record);
      this._touch(view);
      if (record.contextKey) this.contextOwners.set(record.contextKey, target.key);
      if (Object.hasOwn(this.data.seen, record.key)) this.claimOwners.set(record.key, target.key);
    }
    this.save();
  }
  update(record, fields, observation = {}) {
    const natural = observation.natural === undefined ? undefined : validateNaturalState(observation.natural);
    if (observation.message && (observation.message.chatType !== record.chatType || observation.message.peerId !== record.peerId))
      throw new ChannelError('INVALID_CONVERSATION', '聊天消息与工作判断的会话不匹配');
    Object.assign(record, fields, { updatedAt: Date.now() });
    const target = recordInfo(record),
      view = target ? this.views.get(target.key) : undefined;
    // The record is part of the archive too; the assignment above is always a change.
    if (view) this._touch(view);
    if (view && natural !== undefined) view.natural = natural;
    let observed;
    if (view && observation.message && !view.messages.some(message => message.key === record.key)) {
      observed = this._observation(record.key, record.accountId, observation.message, record.createdAt);
      const positions = new Map(this.data.records.map((value, index) => [value.key, index]));
      const index = view.messages.findIndex(message => message.observedAt > record.createdAt ||
        message.observedAt === record.createdAt && positions.get(message.sourceKey ?? message.key) > positions.get(record.key));
      view.messages.splice(index < 0 ? view.messages.length : index, 0, observed);
      if (view.messages.length > historyLimit) view.messages = view.messages.slice(-historyLimit);
    }
    const confirmed = [];
    if (view && !record.toolProgress && !record.remoteQuery && !record.workRequest && !record.workJobId && !record.modeControl) {
      const validId = id => typeof id === 'string' && !!id && id !== '0';
      const ids = new Set((record.acknowledgedMessageIds ?? []).filter(validId));
      let receipts = Array.isArray(record.deliveryParts) ? record.deliveryParts.filter(part =>
        part?.state === 'acknowledged' && validId(part.serverMessageId) && ids.has(part.serverMessageId)) : [];
      // Legacy single ACK records remain readable, but ambiguous multi-ACK
      // records must never fabricate one aggregate bubble against ACK[0].
      if (!record.replyPlan && !receipts.length && record.state === 'sent' && ids.size === 1 && (record.reply || record.replyMedia))
        receipts = [{ index: 0, type: record.reply ? 'text' : record.replyMedia.kind === 'sticker' ? 'face' : 'image',
          state: 'acknowledged', serverMessageId: [...ids][0], text: record.reply, observedAt: record.sentAt ?? record.updatedAt }];
      for (const part of receipts) {
        const plan = record.replyPlan?.find(plan => plan.index === part.planIndex);
        // Native echoes can arrive BEFORE send resolves. Reconcile by reliable
        // server id, not record sourceKey, and never append the echo twice.
        const existing = view.messages.find(message => message.direction === 'outgoing' && message.messageId === part.serverMessageId);
        const media = ['image', 'face'].includes(part.type) ? plan?.media ?? record.replyMedia : undefined;
        const unambiguous = receipts.filter(receipt => receipt.planIndex === part.planIndex).length === 1;
        const text = typeof part.text === 'string' ? part.text : part.type === 'text' && unambiguous ? plan?.text : undefined;
        if (!existing && text === undefined && !media) continue;
        const observedAt = Number.isFinite(part.observedAt) ? part.observedAt : record.acknowledgedAt ?? record.sentAt ?? record.updatedAt;
        const serverTime = Number.isFinite(part.time) && part.time > 0 ? (part.time > 1e12 ? part.time : part.time * 1000) : undefined;
        const entry = {
          ...(existing ?? {}), key: existing?.key ?? 'reply:' + record.key + ':' + part.serverMessageId,
          sourceKey: record.key, messageId: part.serverMessageId, direction: 'outgoing',
          senderId: record.accountId, senderName: record.agentName || this.persona().name,
          // An actual native echo is authoritative for prefixes and wire chunks.
          text: existing?.text || text || `[${media?.kind === 'sticker' ? '表情包' : '图片'}：${media?.name || ''}]`,
          ...(media ? { attachments: [{ assetId: media.id, type: part.type,
            description: media.description || media.name, ...(media.generation ? { generation: clone(media.generation) } : {}) }] } : {}),
          time: serverTime ?? existing?.time ?? observedAt,
          ...(!serverTime && !existing ? { timeSource: 'ack-observed' } : {}),
          observedAt: existing?.observedAt ?? observedAt, kind: 'reply', replyTo: record.senderId, mode: record.mode || 'default',
        };
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(entry)) continue;
          Object.assign(existing, entry); confirmed.push(existing);
        } else { view.messages.push(entry); confirmed.push(entry); }
      }
      if (view.messages.length > historyLimit) view.messages = view.messages.slice(-historyLimit);
    }
    this.save();
    if (observed) this.memory?.append(target, observed);
    for (const entry of confirmed) this.memory?.append(target, entry);
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
    this._touch(view);
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
      this._touch(view);
      if (resetNatural && view.natural !== undefined) {
        view.natural = emptyNaturalState();
        this._touch(view);
      }
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
  conversationSelector(accountId, chatType, peerId) {
    const conversation = info(accountId, chatType, peerId),
      known = this.data.conversations[conversation.key];
    if (known && (known.key !== conversation.key || known.accountId !== accountId ||
        known.chatType !== chatType || known.peerId !== peerId))
      throw new ChannelError('INVALID_CONVERSATION', '会话档案标识不一致，请检查会话索引后重试');
    const settings = this.data.accounts[accountId];
    if (!known && !(chatType === 'group' ? settings?.groups : settings?.privatePeers)?.includes(peerId))
      throw new ChannelError('MEMORY_CONVERSATION_MISSING', '请先选择已授权或有历史记录的会话');
    return { ...conversation, name: known?.name || peerId };
  }
  conversationSelectors(accountId) {
    const settings = this.settings(accountId),
      entries = new Map(),
      authorized = { private: new Set(settings.privatePeers), group: new Set(settings.groups) };
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
      .map(({ key, chatType, peerId }) => ({ key, accountId, chatType, peerId,
        name: this.data.conversations[key]?.name || peerId,
        // A private conversation follows the person: an explicit grant or a
        // membership in an authorized group.
        authorized: chatType === 'group' ? authorized.group.has(peerId) : personAuthorized(this, accountId, peerId) }));
  }
  conversations(accountId) {
    return this.conversationSelectors(accountId)
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
          name: conversation.name,
          authorized: conversation.authorized,
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
