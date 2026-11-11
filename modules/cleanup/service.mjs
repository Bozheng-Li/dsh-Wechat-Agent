import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { taskViews, taskHistoryVersion } from '../../shared/task-history.mjs';
import { workPath } from '../work/policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new ChannelError('CLEANUP_CHANGED', message); };
const evidenceNote = '仅从本地记录列表移除，不撤回微信内容；防重复执行与限额所需凭据继续保留。';

/** Owner-only cleanup. Confirmations freeze IDs and versions, never a moving query. */
export class OwnerCleanup {
  constructor(channel, scheduler = channel?.scheduler) { this.channel = channel; this.scheduler = scheduler; this.snapshots = new Map(); }
  collection(accountId, kind) {
    const automation = this.channel.momentsAutomation;
    const hidden = row => !!row.historyDeleted;
    const records = (manager, rows, { label, id = row => row.id, protectedRow = () => false, remove, note = evidenceNote }) => {
      if (!manager || manager.error) fail(manager?.error || '记录组件尚未就绪');
      return { label, note, rows: rows.filter(row => row.accountId === accountId && !hidden(row)).map(row => ({ id: id(row), version: digest(row), protected: protectedRow(row), row })),
        remove: selected => { for (const entry of selected) { entry.row.historyDeleted = true; remove?.(entry.row); } manager.save(); } };
    };
    if (kind === 'moments.publishing') {
      const manager = automation?.publishing;
      const collection = records(manager, Object.values(manager?.data.runs || {}), { label: '草稿与发布记录',
        protectedRow: row => ['generating', 'sending', 'unknown'].includes(row.state) || ['draft', 'failed'].includes(row.state) && manager.activeAccount === accountId,
        remove: row => { if (['draft', 'failed'].includes(row.state)) row.state = 'discarded'; if (row.state !== 'published') delete row.text; delete row.sources; delete row.imagePrompt; delete row.error; },
        note: evidenceNote + '未发布的草稿会放弃，正在处理及结果不明的记录保留。' });
      const remove = collection.remove;
      collection.remove = selected => {
        const images = selected.map(entry => entry.row.image).filter(Boolean);
        selected.forEach(entry => { delete entry.row.image; }); remove(selected);
        let warning = '';
        for (const image of images) try { fs.unlinkSync(workPath(this.channel.store.root, image.path)); } catch (error) { if (error.code !== 'ENOENT') warning = '记录已清理，部分配图文件暂未清除'; }
        return warning;
      };
      return collection;
    }
    if (kind === 'moments.likes.runs') return records(automation?.likes, Object.values(automation?.likes.data.runs || {}), {
      label: '点赞执行轮次', protectedRow: row => row.state === 'running', remove: row => { delete row.error; } });
    if (kind === 'moments.likes.records') return records(automation?.likes, Object.values(automation?.likes.data.records || {}), {
      label: '点赞处理记录', id: row => row.postId, protectedRow: row => ['sending', 'unknown'].includes(row.state), remove: row => { row.text = ''; delete row.error; } });
    if (kind === 'moments.replies') return records(automation, Object.values(automation?.data.replies || {}), {
      label: '评论回复记录', id: row => row.postId + ':' + row.commentId,
      protectedRow: row => ['generating', 'sending', 'unknown'].includes(row.state),
      remove: row => { delete row.text; delete row.commentText; delete row.author; delete row.error;
        if (row.origin === 'friend') { delete row.postText; delete row.postNickname; delete row.imageContext; row.ourComment.text = ''; row.incomingReply.text = ''; }
      } });
    if (kind === 'moments.interactions') return records(automation?.interactions, Object.values(automation?.interactions?.data.runs || {}), {
      label: '朋友圈互动记录', protectedRow: row => ['running', 'generating'].includes(row.state) ||
        row.rows.some(item => [item.like, item.comment].some(step => ['sending', 'unknown'].includes(step.state))),
      remove: row => { if (row.state === 'draft') row.state = 'discarded'; delete row.error; delete row.generationError; } });
    if (kind === 'moments.materials') {
      const manager = automation?.materials; if (!manager || manager.error) fail(manager?.error || '素材组件尚未就绪');
      return { label: '朋友圈素材', note: '删除所选素材及其本机图片文件，无法恢复。已发布朋友圈保留；已生成但未发布的草稿可能需要重新生成。已删除的聊天素材和网络图片不会再次自动导入。',
        rows: Object.values(manager.account(accountId).items).filter(row => !row.deleted).map(row => ({ id: row.id, version: digest(row), row,
          protected: manager.activeAccount === accountId || automation.publishing.activeAccount === accountId })),
        remove: selected => manager.removeMany(accountId, selected.map(({ row }) => ({ id: row.id, revision: row.revision }))).warning };
    }
    if (kind === 'tasks.history') {
      const manager = this.scheduler; if (!manager || manager.error) fail(manager?.error || '定时任务组件尚未就绪');
      const tasks = manager.data.tasks.filter(task => task.accountId === accountId);
      return { label: '任务历史记录', note: evidenceNote + '当前任务和循环计划会继续运行；执行中的记录保留。',
        rows: taskViews(tasks, manager.data.runs).history.map(entry => ({ id: entry.task.id, row: entry.task, version: digest([entry.task, entry.runs]),
          protected: entry.task.state === 'running' || entry.state === 'settling' || ['unknown', 'partial'].includes(entry.result) || entry.runs.some(run => ['running', 'sending', 'generating'].includes(run.state)) })),
        remove: selected => {
          for (const { row } of selected) {
            row.historyClearedVersion = taskHistoryVersion(row, manager.data.runs);
            for (const run of manager.data.runs) if (run.taskId === row.id) run.historyDeleted = true;
          }
          manager.save();
        } };
    }
    if (kind === 'digests') {
      const manager = this.channel.workbench; if (!manager) fail('简报组件尚未就绪');
      const data = manager.disk.load(accountId);
      return { label: '历史简报', note: '删除简报、引用与其中的待办记录，无法恢复。已经创建的定时提醒继续运行，可以到定时任务页管理。',
        rows: data.summaries.map(row => ({ id: row.id, version: digest(row), row, protected: false })),
        remove: selected => { const ids = new Set(selected.map(entry => entry.id)); data.summaries = data.summaries.filter(row => !ids.has(row.id)); manager.disk.save(data); } };
    }
    throw new ChannelError('CLEANUP_INVALID', '不支持清理这类记录');
  }
  preview(accountId, { kind, ids }) {
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 5000 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id || id.length > 256)))
      throw new ChannelError('CLEANUP_INVALID', '请选择有效记录');
    const collection = this.collection(accountId, kind), chosen = ids ? collection.rows.filter(row => ids.includes(row.id)) : collection.rows;
    if (ids && chosen.length !== ids.length) fail('所选记录已删除或不属于当前账号，请刷新列表');
    const entries = chosen.filter(row => !row.protected).map(({ id, version }) => ({ id, version }));
    const now = Date.now(); for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id);
    while (this.snapshots.size >= 100) this.snapshots.delete(this.snapshots.keys().next().value);
    const token = randomUUID(); this.snapshots.set(token, { accountId, kind, entries, expiresAt: now + 10 * 60000 });
    return { token, kind, label: collection.label, note: collection.note, count: entries.length, protectedCount: chosen.length - entries.length, scope: ids ? '所选记录' : '当前账号的全部记录' };
  }
  remove(accountId, { token }) {
    const snapshot = this.snapshots.get(token);
    if (!snapshot || snapshot.accountId !== accountId || snapshot.expiresAt <= Date.now()) fail('清理确认已失效，请重新预览范围');
    if (snapshot.result) return snapshot.result;
    const collection = this.collection(accountId, snapshot.kind), rows = new Map(collection.rows.map(row => [row.id, row]));
    const selected = snapshot.entries.map(entry => {
      const current = rows.get(entry.id);
      if (!current || current.protected || current.version !== entry.version) fail('记录已更新或开始执行，本次未清理；请重新确认范围');
      return current;
    });
    const warning = selected.length ? collection.remove(selected) : '';
    snapshot.result = { deleted: selected.length, ...(warning ? { warning } : {}) }; return snapshot.result;
  }
}
