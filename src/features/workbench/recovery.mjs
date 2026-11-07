import { randomUUID } from 'node:crypto';
import { eligible } from '../../shared/contracts.mjs';
import { digest, scopeKey, checkedText, fail } from './store.mjs';
import { recordVersion, modes, recoveryStates } from './helpers.mjs';

export function findRecoveryRecord(workbench, scope, key) {
  const record = workbench.store.views.get(scopeKey(scope))?.records.find((record) => record.key === key);
  if (!record) fail('RECOVERY_NOT_FOUND', '这条记录不存在或不属于当前会话');
  return record;
}

export function deletedRecovery(workbench, data) {
  const keys = data.recoveryDeleted ?? [];
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key))
    fail('WORKBENCH_STORAGE_INVALID', '恢复记录的删除状态损坏，请检查资料文件');
  return new Set(keys);
}

export function recoveryEntryKey(workbench, scope, key) {
  return 'scope:' + scopeKey(scope) + ':' + key;
}

export function recoveryDeleted(workbench, deleted, scope, key) {
  return deleted.has(workbench.recoveryEntryKey(scope, key)) || deleted.has(key);
}

export function recoveryBusy(workbench, scope, key) {
  return [workbench.channel.active, ...workbench.channel.queue].some(
    (item) =>
      item?.record &&
      ['accountId', 'chatType', 'peerId'].every((field) => item.record[field] === scope[field]) &&
      (item.record.key === key || item.record.recoveryOf === key)
  );
}

export function recoveryDraft(workbench, accountId, draft) {
  if (draft.accountId !== accountId) fail('WORKBENCH_STORAGE_INVALID', '恢复草稿的账号归属不匹配，请检查资料文件');
  const record = workbench.store.views
    .get(scopeKey(draft))
    ?.records.find((record) => record.key === 'recovery:' + draft.id);
  const busy =
    workbench.recoverySends.has(accountId + ':' + draft.id) || workbench.recoveryBusy(draft, 'recovery:' + draft.id);
  return {
    ...draft,
    state: record?.state || (draft.state === 'submitting' && !busy ? 'interrupted' : draft.state),
    busy,
    revision: digest([draft, record && recordVersion(record)]),
  };
}

export function recoverySnapshot(workbench, accountId, data = workbench.disk.load(accountId)) {
  const deleted = workbench.deletedRecovery(data);
  const records = workbench.store
    .conversations(accountId)
    .flatMap((peer) =>
      (workbench.store.views.get(peer.key)?.records || [])
        .filter(
          (record) => recoveryStates.includes(record.state) && !workbench.recoveryDeleted(deleted, record, record.key)
        )
        .map((record) => ({
          ...record,
          conversationName: peer.name,
          revision: recordVersion(record),
          authorized: peer.authorized,
          busy: workbench.recoveryBusy(record, record.key),
        }))
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const drafts = data.recovery
    .filter(
      (draft) =>
        !workbench.recoveryDeleted(deleted, draft, draft.originalKey) &&
        !workbench.recoveryDeleted(deleted, draft, 'recovery:' + draft.id)
    )
    .map((draft) => workbench.recoveryDraft(accountId, draft));
  return {
    data,
    records,
    drafts,
    revision: data.revision,
    recordsRevision: digest(records.map((record) => [workbench.recoveryEntryKey(record, record.key), record.revision])),
    draftsRevision: digest(drafts.map((draft) => [draft.id, draft.revision])),
    counts: {
      all: records.length,
      ...Object.fromEntries(
        recoveryStates.map((state) => [state, records.filter((record) => record.state === state).length])
      ),
    },
  };
}

export function listRecovery(workbench, accountId) {
  const { data, records, drafts, ...snapshot } = workbench.recoverySnapshot(accountId);
  return {
    ...snapshot,
    records: records.slice(0, 100),
    drafts: drafts.slice(-50).reverse(),
    draftCount: drafts.length,
  };
}

export function deleteRecovery(workbench, input) {
  if (input.confirmDelete !== true) fail('RECOVERY_CONFIRM_REQUIRED', '请确认要删除的恢复记录或历史');
  const snapshot = workbench.recoverySnapshot(input.accountId),
    { data } = snapshot;
  if (input.revision !== data.revision) fail('WORKBENCH_CHANGED', '恢复资料已更新，请重新读取后再删除');
  if (
    [
      input.records !== undefined,
      input.recordFilter !== undefined,
      input.draftIds !== undefined,
      input.clearDrafts === true,
    ].filter(Boolean).length !== 1
  )
    fail('INVALID_INPUT', '请选择一种恢复记录删除范围');
  let selectedRecords = [],
    selectedDrafts = [];
  if (input.records !== undefined) {
    if (
      !Array.isArray(input.records) ||
      !input.records.length ||
      input.records.length > 100 ||
      new Set(
        input.records.map(
          (row) => row && workbench.recoveryEntryKey({ ...row, accountId: input.accountId }, row.recordKey)
        )
      ).size !== input.records.length
    )
      fail('INVALID_INPUT', '请选择有效且不重复的恢复记录');
    selectedRecords = input.records.map((row) => {
      const record = snapshot.records.find(
        (record) => record.key === row?.recordKey && record.chatType === row.chatType && record.peerId === row.peerId
      );
      if (!record || record.revision !== row.revision) fail('RECOVERY_CHANGED', '恢复记录已变化，请重新读取后再删除');
      return record;
    });
  } else if (input.recordFilter !== undefined) {
    if (!['all', ...recoveryStates].includes(input.recordFilter)) fail('INVALID_INPUT', '请选择有效的恢复分类');
    if (input.recordsRevision !== snapshot.recordsRevision)
      fail('RECOVERY_CHANGED', '待处理记录已更新，请重新读取后再清理');
    selectedRecords = snapshot.records.filter(
      (record) => input.recordFilter === 'all' || record.state === input.recordFilter
    );
  } else if (input.clearDrafts === true) {
    if (input.draftsRevision !== snapshot.draftsRevision)
      fail('RECOVERY_CHANGED', '恢复历史已更新，请重新读取后再清理');
    selectedDrafts = snapshot.drafts;
  } else {
    if (
      !Array.isArray(input.draftIds) ||
      !input.draftIds.length ||
      input.draftIds.length > 100 ||
      new Set(input.draftIds).size !== input.draftIds.length
    )
      fail('INVALID_INPUT', '请选择有效且不重复的恢复历史');
    selectedDrafts = input.draftIds.map((id) => {
      const draft = snapshot.drafts.find((draft) => draft.id === id);
      if (!draft || draft.revision !== input.draftRevisions?.[id])
        fail('RECOVERY_CHANGED', '恢复历史已变化，请重新读取后再删除');
      return draft;
    });
  }
  if (!selectedRecords.length && !selectedDrafts.length) fail('RECOVERY_NOT_FOUND', '所选分类没有可删除的记录');
  const keys = new Set(selectedRecords.map((record) => workbench.recoveryEntryKey(record, record.key)));
  selectedDrafts = [
    ...new Map(
      [
        ...selectedDrafts,
        ...snapshot.drafts.filter(
          (draft) =>
            keys.has(workbench.recoveryEntryKey(draft, draft.originalKey)) ||
            keys.has(workbench.recoveryEntryKey(draft, 'recovery:' + draft.id))
        ),
      ].map((draft) => [draft.id, draft])
    ).values(),
  ];
  if (selectedRecords.some((record) => record.busy) || selectedDrafts.some((draft) => draft.busy))
    fail('RECOVERY_BUSY', '所选恢复操作正在处理或等待微信回执，结束后才能删除');
  const ids = new Set(selectedDrafts.map((draft) => draft.id));
  for (const draft of selectedDrafts) keys.add(workbench.recoveryEntryKey(draft, 'recovery:' + draft.id));
  data.recoveryDeleted = [...new Set([...workbench.deletedRecovery(data), ...keys])];
  data.recovery = data.recovery.filter((draft) => !ids.has(draft.id));
  // Keep transport receipts and deduplication records in the conversation archive.
  // Deleting a recovery entry must never make a sent or uncertain attempt retryable.
  workbench.disk.save(data);
  return {
    ...workbench.recoveryList(input.accountId),
    deletedRecords: selectedRecords.length,
    deletedDrafts: selectedDrafts.length,
  };
}

export function recoveryAllowed(workbench, original, mode, acknowledgedMissing = false) {
  if (!['failed', 'unknown', 'partial', 'cancelled'].includes(original.state))
    fail('RECOVERY_ALREADY_SENT', '这条回复不需要恢复，已确认的消息不会重发');
  const kinds = mode === 'image' ? ['image'] : mode === 'text' || mode === 'regenerate' ? ['text'] : ['text', 'image'];
  if ((original.state === 'partial' || original.acknowledgedMessageIds?.length) && !original.deliveryParts?.length)
    fail(
      'RECOVERY_AMBIGUOUS',
      '旧记录只有部分回执，无法确认对应文字还是图片；请在微信核对并复制需要的内容，不能直接重发'
    );
  if (original.deliveryParts?.some((part) => kinds.includes(part.type) && part.state === 'acknowledged'))
    fail('RECOVERY_ALREADY_SENT', '选择的内容已存在微信回执，不能重复发送；可只选择未确认的图片或文字');
  const uncertain =
    original.state === 'unknown' ||
    original.deliveryParts?.some((part) => kinds.includes(part.type) && part.state === 'unknown');
  if (uncertain && !acknowledgedMissing)
    fail('RECOVERY_CONFIRM_REQUIRED', '发送结果不明；需要先在微信核对，并明确确认所选内容尚未收到');
  return kinds;
}

export async function prepareRecovery(workbench, input, signal) {
  const scope = workbench.scope(input),
    original = workbench.record(scope, input.recordKey);
  if (workbench.recoveryDeleted(workbench.deletedRecovery(workbench.disk.load(scope.accountId)), scope, original.key))
    fail('RECOVERY_DELETED', '这条恢复记录已删除，未创建新的草稿');
  if (input.revision !== recordVersion(original) || !modes.includes(input.mode))
    fail('RECOVERY_CHANGED', '记录已变化或恢复方式无效，请重新读取');
  workbench.recoveryAllowed(original, input.mode, input.confirmUnreceived === true);
  let text = input.mode === 'image' ? '' : original.reply || original.replyDraft || '';
  const asset = ['retry', 'image'].includes(input.mode) ? original.replyMedia : null;
  if (input.mode === 'regenerate') {
    const result = await workbench.runner.run({
      text: checkedText(original.question, '原始问题', 20000),
      group: scope.chatType === 'group',
      prompt: workbench.store.settings(scope.accountId).prompt,
      persona: workbench.store.conversationPersona(scope.accountId, scope.chatType, scope.peerId),
      adminNotes: workbench.channel.longMemory.adminNotes(scope),
      memory: workbench.channel.longMemory.prompt(scope, { includeGlobal: false }),
      signal,
    });
    text = result.text;
  }
  signal.throwIfAborted();
  workbench.scope(scope);
  if (input.revision !== recordVersion(original)) fail('RECOVERY_CHANGED', '生成草稿期间原记录已变化，请重新读取');
  if (asset) workbench.channel.library.resolveAsset(scope.accountId, asset.id);
  if (!text && !asset) fail('RECOVERY_EMPTY', '没有可恢复的内容，可选择重新生成文字');
  const data = workbench.disk.load(scope.accountId);
  if (workbench.recoveryDeleted(workbench.deletedRecovery(data), scope, original.key))
    fail('RECOVERY_DELETED', '生成期间恢复记录已删除，未保存旧草稿');
  const draft = {
    id: randomUUID(),
    ...scope,
    originalKey: original.key,
    originalRevision: input.revision,
    mode: input.mode,
    text,
    asset: asset ? { ...asset } : null,
    confirmUnreceived: input.confirmUnreceived === true,
    state: 'draft',
    createdAt: workbench.now(),
    expiresAt: workbench.now() + 900000,
  };
  data.recovery = [...data.recovery.slice(-99), draft];
  workbench.disk.save(data);
  return draft;
}

export async function sendRecoveryDraft(workbench, input, signal) {
  const key = input.accountId + ':' + input.draftId;
  workbench.recoverySends.set(key, (workbench.recoverySends.get(key) || 0) + 1);
  try {
    return await workbench.submitRecoveryDraft(input, signal);
  } finally {
    const remaining = workbench.recoverySends.get(key) - 1;
    if (remaining) workbench.recoverySends.set(key, remaining);
    else workbench.recoverySends.delete(key);
  }
}

export async function submitRecoveryDraft(workbench, input, signal) {
  let data = workbench.disk.load(input.accountId),
    draft = data.recovery.find((value) => value.id === input.draftId);
  if (!draft) fail('RECOVERY_NOT_FOUND', '恢复草稿不存在');
  const scope = workbench.scope(draft),
    key = 'recovery:' + draft.id;
  const prior = workbench.store.views.get(scopeKey(scope))?.records.find((record) => record.key === key);
  if (prior) return { state: prior.state, record: prior, repeated: true };
  if (draft.state !== 'draft' || draft.expiresAt < workbench.now())
    fail('RECOVERY_EXPIRED', '草稿已失效或已使用，请重新准备');
  if (input.confirmSend !== true) fail('RECOVERY_CONFIRM_REQUIRED', '请确认预览内容和接收会话后再发送');
  const original = workbench.record(scope, draft.originalKey);
  if (workbench.recoveryDeleted(workbench.deletedRecovery(data), scope, original.key))
    fail('RECOVERY_DELETED', '原恢复记录已删除，未继续发送');
  if (draft.originalRevision !== recordVersion(original)) fail('RECOVERY_CHANGED', '原消息状态已改变，请重新准备');
  const kinds = workbench.recoveryAllowed(original, draft.mode, draft.confirmUnreceived);
  const related =
    workbench.store.views.get(scopeKey(scope))?.records.filter((record) => record.recoveryOf === original.key) || [];
  if (
    related.some(
      (record) =>
        (!['failed', 'cancelled'].includes(record.state) || (record.sendAttempted && record.delivery !== 'rejected')) &&
        (!record.recoveryKinds || record.recoveryKinds.some((kind) => kinds.includes(kind)))
    )
  )
    fail('RECOVERY_ALREADY_ATTEMPTED', '相同内容已有恢复操作或结果待核对，不能重复发送');
  if (!eligible(workbench.store.settings(scope.accountId), scope))
    fail('AUTH_CHANGED', '自动回复或会话授权已关闭，未发送');
  if (draft.asset) workbench.channel.library.resolveAsset(scope.accountId, draft.asset.id);
  signal.throwIfAborted();
  draft.state = 'submitting';
  workbench.disk.save(data);
  let record;
  try {
    record = await workbench.channel.submitScheduled(
      {
        ...scope,
        id: draft.id,
        recordKey: key,
        senderId: scope.accountId,
        senderName: '管理员',
        content: draft.text,
        kind: 'message',
        targets: [],
        recovery: { sourceKey: original.key, kinds, asset: draft.asset },
      },
      signal
    );
  } catch (error) {
    const observed = workbench.store.views.get(scopeKey(scope))?.records.find((value) => value.key === key);
    if (!observed && error?.code === 'TASK_QUEUE_FULL') {
      const current = workbench.disk.load(scope.accountId),
        saved = current.recovery.find((value) => value.id === draft.id);
      if (saved?.state === 'submitting') {
        saved.state = 'draft';
        saved.lastError = '队列未接受本次恢复，尚未发送；可稍后重试';
        workbench.disk.save(current);
      }
    }
    throw error;
  }
  workbench.current(scope.accountId);
  data = workbench.disk.load(scope.accountId);
  draft = data.recovery.find((value) => value.id === input.draftId);
  draft.state = record.state;
  draft.recordKey = key;
  workbench.disk.save(data);
  return { state: record.state, record };
}
