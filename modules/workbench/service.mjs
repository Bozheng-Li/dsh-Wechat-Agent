import { runtimeFingerprint } from "../diagnostics/service.mjs";
import { readDiagnostics } from "../diagnostics/service.mjs";
import { runDiagnostics } from "../diagnostics/service.mjs";
import { findRecoveryRecord } from "../recovery/service.mjs";
import { deletedRecovery } from "../recovery/service.mjs";
import { recoveryEntryKey } from "../recovery/service.mjs";
import { recoveryDeleted } from "../recovery/service.mjs";
import { recoveryBusy } from "../recovery/service.mjs";
import { recoveryDraft } from "../recovery/service.mjs";
import { recoverySnapshot } from "../recovery/service.mjs";
import { listRecovery } from "../recovery/service.mjs";
import { deleteRecovery } from "../recovery/service.mjs";
import { recoveryAllowed } from "../recovery/service.mjs";
import { prepareRecovery } from "../recovery/service.mjs";
import { sendRecoveryDraft } from "../recovery/service.mjs";
import { submitRecoveryDraft } from "../recovery/service.mjs";
import { reminderView } from "../digests/service.mjs";
import { listDigests } from "../digests/service.mjs";
import { generateDigest } from "../digests/service.mjs";
import { updateDigestTodo } from "../digests/service.mjs";

import { WorkbenchStore, fail } from "./store.mjs";

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
    fail('UNKNOWN_OPERATION', '不支持的工作台操作');
  }
}
