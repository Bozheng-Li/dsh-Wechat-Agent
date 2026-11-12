import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { emptyRoleCard, validateRoleCard, roleCardHasData, filledRoleCardFields } from '../../shared/role-card.mjs';
import { archiveLock } from './locks.mjs';
import { write } from './json.mjs';
import { roleCardSettings } from '../../shared/role-card-settings.mjs';
import { scheduleRoleCard, beginRoleCardReview, sourceFingerprint } from './role-card-schedule.mjs';
import { assertPersonAuthorized, personAuthorized } from '../../shared/authorization.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f]/u.test(value);
const revisionOf = doc => doc.updatedAt == null ? 'empty' : hash([doc.card, doc.evidence, doc.conflicts, doc.updatedAt]);
const changed = () => new ChannelError('ROLE_CARD_CHANGED', '人物资料已更新，请重新读取后保存；当前草稿保留');

/** One person per WeChat account, independent of the conversation they appear in. */
export class RoleCards {
  constructor(store) { this.store = store; this.errors = new Map(); }
  settings() { return this.store.roleCardSettings?.() ?? roleCardSettings(); }
  schedule(input, now) {
    return this.mutate(input, doc => structuredClone(scheduleRoleCard(doc, this.settings(), now)));
  }
  beginReview(input, now) {
    return this.mutate(input, doc => beginRoleCardReview(doc, this.settings(), now));
  }
  scope(input) {
    const personId = input?.personId || input?.senderId || (input?.chatType === 'private' ? input.peerId : '');
    if (!validId(input?.accountId) || !validId(personId) || personId === input.accountId || personId.endsWith('@chatroom') || ['group', 'conversation'].includes(personId))
      throw new ChannelError('ROLE_CARD_SCOPE', '请选择具有真实微信身份的人物；群聊本身不是人物');
    return { accountId: input.accountId, personId };
  }
  identity(input) {
    const scope = this.scope(input);
    return 'person-' + hash([scope.accountId, scope.personId]);
  }
  paths(input, legacy = false) {
    const scope = this.scope(input), root = path.join(this.store.root, 'storage/memory'),
      base = path.join(root, 'role-cards'), account = path.join(base, hash([scope.accountId])),
      directory = path.join(account, legacy ? 'role-' + hash([scope.accountId, 'private', scope.personId]) : this.identity(scope));
    for (const folder of [this.store.root, path.join(this.store.root, 'storage'), root, base, account, directory]) {
      if (fs.existsSync(folder) && (fs.lstatSync(folder).isSymbolicLink() || !fs.lstatSync(folder).isDirectory()))
        throw new ChannelError('ROLE_CARD_INVALID', '角色卡目录不可用，原有文件已保留');
    }
    const file = path.join(directory, 'card.json'), observationsFile = path.join(directory, 'observations.json');
    for (const target of [file, observationsFile]) {
      if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile() || fs.statSync(target).size > 16000000))
        throw new ChannelError('ROLE_CARD_INVALID', '人物资料文件不可用，原有文件已保留');
    }
    return { account, directory, file, observationsFile };
  }
  readFile(file) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new ChannelError('ROLE_CARD_INVALID', '人物角色卡无法读取，原有文件已保留');
    }
  }
  document(input, { allowUnauthorized = false } = {}) {
    const scope = this.scope(input);
    if (!allowUnauthorized) assertPersonAuthorized(this.store, scope.accountId, scope.personId);
    const roleId = this.identity(scope), paths = this.paths(scope), saved = this.readFile(paths.file) ?? this.readFile(paths.observationsFile);
    if (saved) {
      if (saved.version !== 2 || saved.ownerStoreId !== this.store.data.storeId || saved.roleId !== roleId ||
          JSON.stringify(this.scope(saved.scope)) !== JSON.stringify(scope) || !Array.isArray(saved.pending) ||
          !Array.isArray(saved.sources) || !Array.isArray(saved.encounters) || !Array.isArray(saved.aliases) ||
          !saved.evidence || !saved.seen || !Array.isArray(saved.changes) || !Array.isArray(saved.conflicts))
        throw new ChannelError('ROLE_CARD_INVALID', '人物角色卡的归属或格式不正确，未使用其他人的资料');
      saved.card = validateRoleCard(saved.card);
      return saved;
    }
    const doc = { version: 2, ownerStoreId: this.store.data.storeId, scope, roleId, card: emptyRoleCard(),
      evidence: {}, conflicts: [], aliases: [], encounters: [], sources: [], pending: [], seen: {}, changes: [],
      updatedAt: null, reviewedAt: null, nextAt: null, attempts: 0, error: null };
    // Only old private cards have an unambiguous person. Old group cards stay
    // on disk and are never copied onto every member or used as shared facts.
    const legacy = this.readFile(this.paths(scope, true).file);
    if (legacy) {
      if (legacy.version !== 1 || legacy.ownerStoreId !== doc.ownerStoreId || legacy.roleId !== 'role-' + hash([scope.accountId, 'private', scope.personId]) ||
          legacy.scope?.accountId !== scope.accountId || legacy.scope?.chatType !== 'private' || legacy.scope?.peerId !== scope.personId)
        throw new ChannelError('ROLE_CARD_INVALID', '旧角色卡归属不匹配，原有文件已保留');
      doc.card = validateRoleCard(legacy.card); doc.updatedAt = legacy.updatedAt;
      doc.migratedFrom = legacy.roleId;
      for (const [field, value] of Object.entries(doc.card)) if (value) doc.evidence[field] = { origin: 'owner', updatedAt: legacy.updatedAt, sources: [] };
    }
    return doc;
  }
  view(input) {
    const doc = this.document(input);
    return { scope: doc.scope, personId: doc.scope.personId, roleId: doc.roleId, card: doc.card, evidence: doc.evidence,
      conflicts: doc.conflicts, aliases: doc.aliases, encounters: doc.encounters, changes: doc.changes,
      revision: revisionOf(doc), inherited: !roleCardHasData(doc.card, doc.conflicts), updatedAt: doc.updatedAt,
      reviewedAt: doc.reviewedAt, pendingCount: doc.pending.length, nextAt: doc.nextAt,
      error: /operation was aborted due to timeout/i.test(doc.error || '')
        ? '上次后台整理超时，原有资料和聊天来源已保留；可重试或调整整理超时。' : doc.error,
      manualPending: !!(doc.refreshRequested && doc.refreshManual || doc.reviewBatch?.manual),
      ...(doc.migratedFrom ? { migratedFrom: doc.migratedFrom } : {}) };
  }
  mutate(input, operation) {
    const checked = this.scope(input);
    assertPersonAuthorized(this.store, checked.accountId, checked.personId);
    const scope = this.scope(input), { directory, file, observationsFile } = this.paths(scope),
      release = archiveLock(directory, this.store.data.storeId, this.identity(scope));
    try {
      const doc = this.document(scope), before = JSON.stringify(doc), result = operation(doc);
      if (before !== JSON.stringify(doc)) {
        // Keep source collection separate until actual person details exist.
        // Previously created cards stay on disk even when their fields are cleared.
        const target = roleCardHasData(doc.card, doc.conflicts) || fs.existsSync(file) ? file : observationsFile;
        try { write(target, doc); }
        catch { throw new ChannelError('ROLE_CARD_WRITE_FAILED', '人物角色卡暂未保存，聊天可继续，后台将重试'); }
        if (target === file) { try { fs.unlinkSync(observationsFile); } catch {} }
      }
      this.errors.delete(doc.roleId);
      return result;
    } finally { release(); }
  }
  checkSave(input, card, revision) {
    const next = validateRoleCard(card), current = this.view(input);
    if (typeof revision !== 'string' || current.revision !== revision) throw changed();
    return { card: next, changed: JSON.stringify(current.card) !== JSON.stringify(next) };
  }
  select(input) {
    const scope = this.scope(input), view = this.view(scope);
    const privatePeer = this.store.conversations(scope.accountId).some(peer => peer.chatType === 'private' && peer.peerId === scope.personId);
    if (!privatePeer && !view.encounters.length && view.inherited && !view.migratedFrom)
      throw new ChannelError('ROLE_CARD_PERSON_UNKNOWN', '尚无这位人物的聊天记录，请先从人物列表选择');
    return scope;
  }
  save(input, card, revision, now = Date.now()) {
    const next = validateRoleCard(card);
    this.mutate(input, doc => {
      if (revisionOf(doc) !== revision) throw changed();
      for (const [field, value] of Object.entries(next)) if (doc.card[field] !== value) {
        doc.changes.push({ field, before: doc.card[field], after: value, at: now, origin: 'owner' });
        doc.evidence[field] = { origin: 'owner', updatedAt: now, sources: [] };
        doc.conflicts = doc.conflicts.filter(conflict => conflict.field !== field);
      }
      if (JSON.stringify(doc.card) !== JSON.stringify(next)) doc.updatedAt = now;
      doc.card = next; doc.changes = doc.changes.slice(-24);
    });
    return this.view(input);
  }
  observe(input, source, now, { urgent = false } = {}) {
    return this.mutate(input, doc => {
      if (source.senderId !== doc.scope.personId || source.accountId !== doc.scope.accountId)
        throw new ChannelError('ROLE_CARD_SCOPE', '消息与人物不匹配');
      const digest = sourceFingerprint(source);
      if (doc.seen[source.id] === digest || doc.pending.some(row => row.id === source.id && sourceFingerprint(row) === digest)) return false;
      if (doc.pending.length >= 512) throw new ChannelError('ROLE_CARD_QUEUE_FULL', '人物资料待整理较多，保留聊天记录，稍后继续补入');
      doc.pending = doc.pending.filter(row => row.id !== source.id); doc.pending.push(source);
      doc.pendingAt ??= {}; doc.pendingAt[source.id] = now;
      if (urgent) {
        doc.urgentPending ??= {}; doc.urgentPending[source.id] = digest;
        doc.retryAt = null;
      }
      if (source.senderName && !doc.aliases.includes(source.senderName)) doc.aliases = [...doc.aliases, source.senderName].slice(-12);
      const encounter = doc.encounters.find(row => row.chatType === source.chatType && row.peerId === source.peerId);
      if (encounter) encounter.lastSeenAt = Math.max(encounter.lastSeenAt, source.time);
      else doc.encounters.push({ chatType: source.chatType, peerId: source.peerId, name: source.conversationName || source.peerId, lastSeenAt: source.time });
      scheduleRoleCard(doc, this.settings(), now);
      return true;
    });
  }
  request(input, now, { manual = false, token } = {}) {
    this.mutate(input, doc => {
      doc.refreshRequested = true; doc.refreshManual = manual || !!doc.refreshManual;
      doc.refreshToken = token; doc.retryAt = null; doc.error = null; doc.attempts = 0;
      scheduleRoleCard(doc, this.settings(), now);
    });
    return this.view(input);
  }
  commit(input, proposal, batch, revision, now, refreshToken) {
    this.mutate(input, doc => {
      if (revisionOf(doc) !== revision) throw changed();
      for (const update of proposal.updates) {
        const sourceAt = Math.max(...update.evidence.map(source => source.time));
        const priorAt = doc.evidence[update.field]?.sourceAt ?? doc.evidence[update.field]?.updatedAt ?? 0;
        if (sourceAt < priorAt) continue;
        const before = doc.card[update.field];
        doc.card[update.field] = update.value;
        const retained = before && update.value.includes(before) ? doc.evidence[update.field]?.sources || [] : [];
        doc.evidence[update.field] = { origin: 'agent', updatedAt: now, sourceAt,
          sources: [...new Map([...retained, ...update.evidence].map(source => [source.sourceId + ':' + source.quote, source])).values()].slice(-12) };
        doc.conflicts = doc.conflicts.filter(conflict => conflict.field !== update.field);
        if (before !== update.value) doc.changes.push({ field: update.field, before, after: update.value, at: now, origin: 'agent' });
        doc.updatedAt = now;
      }
      for (const conflict of proposal.conflicts) {
        if (Math.max(...conflict.evidence.map(source => source.time)) <
            (doc.evidence[conflict.field]?.sourceAt ?? doc.evidence[conflict.field]?.updatedAt ?? 0)) continue;
        doc.conflicts = doc.conflicts.filter(row => row.field !== conflict.field);
        doc.conflicts.push(conflict); doc.updatedAt = now;
      }
      const completed = new Map(batch.map(source => [source.id, sourceFingerprint(source)]));
      for (const [id, digest] of completed) doc.seen[id] = digest;
      doc.pending = doc.pending.filter(source => completed.get(source.id) !== sourceFingerprint(source));
      doc.sources = [...new Map([...doc.sources, ...batch].map(source => [source.id, source])).values()].sort((a, b) => a.time - b.time).slice(-64);
      doc.seen = Object.fromEntries(Object.entries(doc.seen).slice(-4096));
      doc.changes = doc.changes.slice(-24); doc.reviewedAt = now; doc.error = null; doc.attempts = 0;
      if (doc.refreshToken === refreshToken) { doc.refreshRequested = false; doc.refreshManual = false; }
      if (doc.reviewBatch && doc.reviewBatch.refreshToken === refreshToken) doc.reviewBatch.refresh = false;
      doc.retryAt = null;
      scheduleRoleCard(doc, this.settings(), now);
      if (doc.reviewBatch) { doc.retryAt = now + 1000; scheduleRoleCard(doc, this.settings(), now); }
    });
    return this.view(input);
  }
  retry(input, error, now) {
    this.mutate(input, doc => {
      doc.attempts++; doc.error = error.message || '人物资料整理失败，将自动重试';
      doc.retryAt = now + (error.code === 'ROLE_CARD_CHANGED' ? 1000 : Math.min(300000, 15000 * 2 ** Math.min(doc.attempts - 1, 5)));
      scheduleRoleCard(doc, this.settings(), now);
    });
    this.errors.set(this.identity(input), error.message);
  }
  list(accountId, { includePending = false } = {}) {
    const { account } = this.paths({ accountId, personId: '__directory__' });
    if (!fs.existsSync(account)) return [];
    const rows = [];
    for (const entry of fs.readdirSync(account, { withFileTypes: true })) {
      if (!entry.name.startsWith('person-') || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const directory = path.join(account, entry.name), file = path.join(directory, 'card.json'),
          observationsFile = path.join(directory, 'observations.json');
        if (!fs.existsSync(file) && !fs.existsSync(observationsFile)) continue;
        for (const target of [file, observationsFile]) if (fs.existsSync(target) &&
            (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile() || fs.statSync(target).size > 16000000))
          throw Error('人物资料文件不可用');
        const saved = this.readFile(file) ?? this.readFile(observationsFile);
        if (saved?.scope?.accountId !== accountId || this.identity(saved.scope) !== entry.name) throw Error('人物角色卡归属不匹配');
        if (!personAuthorized(this.store, accountId, saved.scope.personId)) continue;
        const view = this.view(saved.scope);
        if (includePending || roleCardHasData(view.card, view.conflicts)) rows.push(view);
      } catch (error) { this.errors.set(entry.name, error.message); }
    }
    return rows.sort((a, b) => filledRoleCardFields(b.card, b.conflicts).length - filledRoleCardFields(a.card, a.conflicts).length ||
      (b.updatedAt || 0) - (a.updatedAt || 0) || a.personId.localeCompare(b.personId));
  }
  storedScopes(accountId) {
    const { account } = this.paths({ accountId, personId: '__directory__' });
    if (!fs.existsSync(account)) return [];
    const scopes = new Map();
    for (const entry of fs.readdirSync(account, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^(?:person|role)-/.test(entry.name)) continue;
      const directory = path.join(account, entry.name), saved = this.readFile(path.join(directory, 'card.json')) ?? this.readFile(path.join(directory, 'observations.json'));
      if (!saved || saved.ownerStoreId !== this.store.data.storeId || saved.scope?.accountId !== accountId) continue;
      const personId = saved.scope.personId || (saved.scope.chatType === 'private' ? saved.scope.peerId : '');
      if (!personId) continue;
      const scope = this.scope({ accountId, personId });
      this.document(scope, { allowUnauthorized: true }); scopes.set(personId, scope);
    }
    return [...scopes.values()];
  }
  legacyGroupDocuments(accountId) {
    const { account } = this.paths({ accountId, personId: '__directory__' }), rows = [];
    if (!fs.existsSync(account)) return rows;
    for (const entry of fs.readdirSync(account, { withFileTypes: true })) {
      if (!/^role-[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory = path.join(account, entry.name), file = path.join(directory, 'card.json');
      if (entry.isSymbolicLink() || !entry.isDirectory() || fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()))
        throw new ChannelError('ROLE_CARD_INVALID', '旧群角色卡目录不可用，未读取其他位置');
      const doc = this.readFile(file);
      if (!doc || doc.scope?.chatType !== 'group' || doc.scope?.accountId !== accountId) continue;
      if (doc.version !== 1 || doc.ownerStoreId !== this.store.data.storeId || !doc.scope.peerId?.endsWith('@chatroom') ||
          doc.roleId !== entry.name || doc.roleId !== 'role-' + hash([accountId, 'group', doc.scope.peerId]))
        throw new ChannelError('ROLE_CARD_INVALID', '旧群角色卡归属不匹配，原有文件已保留');
      rows.push({ doc, file, directory });
    }
    return rows;
  }
  storedSourceScopes(accountId) {
    return [...this.legacyGroupDocuments(accountId).map(row => row.doc.scope), ...this.storedScopes(accountId).flatMap(scope => {
      const doc = this.document(scope, { allowUnauthorized: true });
      return [...doc.sources, ...doc.pending, ...doc.encounters].map(source => ({ accountId, chatType: source.chatType, peerId: source.peerId }));
    })];
  }
  revoke(scopes, now = Date.now()) {
    let removed = 0;
    for (const accountId of new Set(scopes.map(row => row.accountId))) for (const row of this.legacyGroupDocuments(accountId)) {
      // Legacy shared cards lack person provenance. They are no longer used;
      // a person's revocation also removes these unassigned historical facts.
      if (!scopes.some(scope => scope.accountId === accountId && (scope.chatType === 'private' || scope.peerId === row.doc.scope.peerId))) continue;
      fs.unlinkSync(row.file);
      if (!fs.readdirSync(row.directory).length) fs.rmdirSync(row.directory);
      removed++;
    }
    for (const accountId of new Set(scopes.map(row => row.accountId))) for (const scope of this.storedScopes(accountId)) {
      const related = scopes.filter(row => row.accountId === accountId), paths = this.paths(scope);
      const doc = this.document(scope, { allowUnauthorized: true });
      const removeFiles = () => {
        for (const target of [paths.file, paths.observationsFile]) if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(paths.directory) && !fs.readdirSync(paths.directory).length) fs.rmdirSync(paths.directory);
        this.errors.delete(doc.roleId); removed++;
      };
      if (related.some(row => row.chatType === 'private' && row.peerId === scope.personId)) {
        const legacy = this.paths(scope, true), saved = this.readFile(legacy.file);
        if (saved) {
          if (saved.ownerStoreId !== this.store.data.storeId || saved.scope?.accountId !== accountId ||
              saved.scope?.chatType !== 'private' || saved.scope?.peerId !== scope.personId) throw Error('旧人物卡的归属不匹配，未删除其他数据');
          fs.unlinkSync(legacy.file);
          if (!fs.readdirSync(legacy.directory).length) fs.rmdirSync(legacy.directory);
        }
        removeFiles(); continue;
      }
      const matches = source => related.some(row => row.chatType === source.chatType && row.peerId === source.peerId);
      if (![...doc.sources, ...doc.pending, ...doc.encounters].some(matches)) continue;
      doc.sources = doc.sources.filter(row => !matches(row)); doc.pending = doc.pending.filter(row => !matches(row));
      doc.encounters = doc.encounters.filter(row => !matches(row));
      doc.aliases = [...new Set([...doc.sources, ...doc.pending].map(row => row.senderName).filter(Boolean))].slice(-12);
      for (const [field, evidence] of Object.entries(doc.evidence)) if (evidence.origin === 'agent' && evidence.sources?.some(matches)) {
        doc.card[field] = ''; delete doc.evidence[field];
      }
      doc.conflicts = doc.conflicts.filter(row => !row.evidence?.some(matches));
      doc.changes = []; doc.seen = {}; doc.updatedAt = now; doc.error = null; doc.attempts = 0;
      delete doc.reviewBatch; delete doc.pendingAt; delete doc.urgentPending;
      doc.refreshRequested = false; doc.refreshManual = false; doc.retryAt = null;
      scheduleRoleCard(doc, this.settings(), now);
      if (!roleCardHasData(doc.card, doc.conflicts) && !doc.sources.length && !doc.pending.length) { removeFiles(); continue; }
      const target = roleCardHasData(doc.card, doc.conflicts) ? paths.file : paths.observationsFile;
      write(target, doc);
      const other = target === paths.file ? paths.observationsFile : paths.file;
      if (fs.existsSync(other)) fs.unlinkSync(other);
    }
    return removed;
  }
  persona(input, base) { return base; }
}
