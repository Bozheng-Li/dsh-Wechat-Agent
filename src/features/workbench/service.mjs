import { runtimeFingerprint } from './diagnostics.mjs';
import { readDiagnostics } from './diagnostics.mjs';
import { runDiagnostics } from './diagnostics.mjs';
import { findRecoveryRecord } from './recovery.mjs';
import { deletedRecovery } from './recovery.mjs';
import { recoveryEntryKey } from './recovery.mjs';
import { recoveryDeleted } from './recovery.mjs';
import { recoveryBusy } from './recovery.mjs';
import { recoveryDraft } from './recovery.mjs';
import { recoverySnapshot } from './recovery.mjs';
import { listRecovery } from './recovery.mjs';
import { deleteRecovery } from './recovery.mjs';
import { recoveryAllowed } from './recovery.mjs';
import { prepareRecovery } from './recovery.mjs';
import { sendRecoveryDraft } from './recovery.mjs';
import { submitRecoveryDraft } from './recovery.mjs';
import { reminderView } from './digests.mjs';
import { listDigests } from './digests.mjs';
import { generateDigest } from './digests.mjs';
import { updateDigestTodo } from './digests.mjs';
import { answerKnowledge } from './knowledge-answer.mjs';

import { WorkbenchStore, fail } from './store.mjs';
import { KnowledgeLibrary } from '../knowledge/library.mjs';

export const WORKBENCH_ENDPOINTS = [
  'diagnostics.get',
  'diagnostics.run',
  'recovery.list',
  'recovery.prepare',
  'recovery.send',
  'recovery.discard',
  'recovery.delete',
  'digest.list',
  'digest.generate',
  'digest.todo',
  'digest.remind',
  'digest.delete',
  'knowledge.list',
  'knowledge.settings',
  'knowledge.index.rebuild',
  'knowledge.configure',
  'knowledge.delete',
  'knowledge.document',
  'knowledge.search',
  'knowledge.ask',
  'knowledge.upload.start',
  'knowledge.upload.chunk',
  'knowledge.upload.finish',
  'knowledge.upload.abort',
  'memory.fact.update',
  'memory.fact.resolve',
  'memory.fact.delete',
];

export class AgentWorkbench {
  constructor(channel, options = {}) {
    this.channel = channel;
    this.store = channel.store;
    this.runner = channel.runner;
    this.now = options.now || channel.now || Date.now;
    this.disk = new WorkbenchStore(this.store, 'workbench');
    this.knowledge = new KnowledgeLibrary(this.store, { now: this.now, ...options });
    this.recoverySends = new Map();
  }
  current(accountId) {
    if (this.channel.closed) fail('PLUGIN_STOPPING', '当前实例已停止，未继续处理旧任务');
    if (!accountId || this.channel.transport.status().account?.id !== accountId)
      fail('ACCOUNT_CHANGED', '微信账号已变化，请重新读取当前账号资料');
  }
  scope(input, requireAuthorized = true) {
    this.current(input.accountId);
    const peer = this.store
      .conversations(input.accountId)
      .find((peer) => peer.chatType === input.chatType && peer.peerId === input.peerId);
    if (!peer || (requireAuthorized && !peer.authorized))
      fail('CONVERSATION_NOT_AUTHORIZED', '请选择当前账号已授权的会话');
    return { accountId: input.accountId, chatType: peer.chatType, peerId: peer.peerId };
  }
  fingerprint(accountId) {
    return runtimeFingerprint(this, accountId);
  }
  diagnostics(accountId) {
    return readDiagnostics(this, accountId);
  }
  async diagnose(accountId, signal) {
    return runDiagnostics(this, accountId, signal);
  }
  record(scope, key) {
    return findRecoveryRecord(this, scope, key);
  }
  deletedRecovery(data) {
    return deletedRecovery(this, data);
  }
  recoveryEntryKey(scope, key) {
    return recoveryEntryKey(this, scope, key);
  }
  recoveryDeleted(deleted, scope, key) {
    return recoveryDeleted(this, deleted, scope, key);
  }
  recoveryBusy(scope, key) {
    return recoveryBusy(this, scope, key);
  }
  recoveryDraft(accountId, draft) {
    return recoveryDraft(this, accountId, draft);
  }
  recoverySnapshot(accountId, data = this.disk.load(accountId)) {
    return recoverySnapshot(this, accountId, data);
  }
  recoveryList(accountId) {
    return listRecovery(this, accountId);
  }
  deleteRecovery(input) {
    return deleteRecovery(this, input);
  }
  recoveryAllowed(original, mode, acknowledgedMissing = false) {
    return recoveryAllowed(this, original, mode, acknowledgedMissing);
  }
  async prepare(input, signal) {
    return prepareRecovery(this, input, signal);
  }
  async sendDraft(input, signal) {
    return sendRecoveryDraft(this, input, signal);
  }
  async submitRecoveryDraft(input, signal) {
    return submitRecoveryDraft(this, input, signal);
  }
  reminderView(task) {
    return reminderView(this, task);
  }
  listDigests(accountId) {
    return listDigests(this, accountId);
  }
  async generateDigest(input, signal) {
    return generateDigest(this, input, signal);
  }
  async todo(input, signal) {
    return updateDigestTodo(this, input, signal);
  }
  async answerKnowledge(input, signal, assertAllowed = () => {}, replyContext) {
    return answerKnowledge(this, input, signal, assertAllowed, replyContext);
  }
  async call(endpoint, input, signal) {
    this.current(input.accountId);
    signal.throwIfAborted();
    const accountId = input.accountId;
    if (endpoint === 'diagnostics.get') return this.diagnostics(accountId);
    if (endpoint === 'diagnostics.run') return this.diagnose(accountId, signal);
    if (endpoint === 'recovery.list') return this.recoveryList(accountId);
    if (endpoint === 'recovery.prepare') return this.prepare(input, signal);
    if (endpoint === 'recovery.send') return this.sendDraft(input, signal);
    if (endpoint === 'recovery.delete') return this.deleteRecovery(input);
    if (endpoint === 'recovery.discard') {
      const data = this.disk.load(accountId),
        draft = data.recovery.find((row) => row.id === input.draftId);
      if (!draft || draft.state !== 'draft') fail('RECOVERY_CHANGED', '草稿已使用或不存在');
      draft.state = 'discarded';
      this.disk.save(data);
      return { discarded: true };
    }
    if (endpoint === 'digest.list') return this.listDigests(accountId);
    if (endpoint === 'digest.generate') return this.generateDigest(input, signal);
    if (endpoint === 'digest.todo' || endpoint === 'digest.remind')
      return this.todo({ ...input, remind: endpoint === 'digest.remind' }, signal);
    if (endpoint === 'digest.delete') {
      const data = this.disk.load(accountId);
      if (input.revision !== data.revision) fail('WORKBENCH_CHANGED', '简报已更新，请重新读取后再删除');
      if (!data.summaries.some((row) => row.id === input.summaryId)) fail('DIGEST_NOT_FOUND', '简报不存在');
      data.summaries = data.summaries.filter((row) => row.id !== input.summaryId);
      this.disk.save(data);
      return this.listDigests(accountId);
    }
    if (endpoint === 'memory.fact.update') return this.channel.longMemory.updateFact(accountId, input);
    if (endpoint === 'memory.fact.resolve') return this.channel.longMemory.resolveFact(accountId, input);
    if (endpoint === 'memory.fact.delete') return this.channel.longMemory.deleteFacts(accountId, input);
    if (endpoint === 'knowledge.list') return this.knowledge.list(accountId);
    if (endpoint === 'knowledge.settings') return this.knowledge.configureSettings(accountId, input);
    if (endpoint === 'knowledge.index.rebuild')
      return this.knowledge.rebuild(accountId, signal, () => this.current(accountId));
    if (endpoint === 'knowledge.configure') return this.knowledge.configure(accountId, input);
    if (endpoint === 'knowledge.delete') return this.knowledge.remove(accountId, input);
    if (endpoint === 'knowledge.document') return this.knowledge.view(accountId, input.documentId);
    if (endpoint === 'knowledge.search')
      return this.knowledge.search(accountId, input, signal, () => this.current(accountId));
    if (endpoint === 'knowledge.upload.start') return this.knowledge.begin(accountId, input);
    if (endpoint === 'knowledge.upload.chunk') return this.knowledge.append(accountId, input);
    if (endpoint === 'knowledge.upload.finish')
      return this.knowledge.finish(accountId, input.uploadId, signal, () => this.current(accountId));
    if (endpoint === 'knowledge.upload.abort') return this.knowledge.abort(accountId, input.uploadId);
    if (endpoint === 'knowledge.ask') return this.answerKnowledge(input, signal);
    fail('UNKNOWN_OPERATION', '不支持的工作台操作');
  }
}
