import fs from 'node:fs';
import path from 'node:path';
import { ChannelError, validateNaturalState } from '../shared/contracts.mjs';
import { recordInfo } from './keys.mjs';
import { read, write } from './json.mjs';
import { archiveLock } from './locks.mjs';
import { object } from './helpers.mjs';

export function validateArchiveView(store, view, conversation) {
  if (
    !object(view) ||
    view.version !== 1 ||
    view.ownerStoreId !== store.data.storeId ||
    view.key !== conversation.key ||
    view.accountId !== conversation.accountId ||
    view.chatType !== conversation.chatType ||
    view.peerId !== conversation.peerId ||
    !Array.isArray(view.records) ||
    !Array.isArray(view.messages) ||
    !object(view.seen) ||
    !object(view.sessions) ||
    !object(view.progress) ||
    !Number.isInteger(view.revision) ||
    view.revision < 0 ||
    view.records.some((record) => recordInfo(record)?.key !== conversation.key)
  )
    throw new ChannelError(
      'CONVERSATION_DATA_MISMATCH',
      '该目录已有其他会话或无法识别的数据，未覆盖；请选择独立的保存路径'
    );
  if (view.natural !== undefined) validateNaturalState(view.natural);
}

export function writeArchiveSnapshot(store, view, directory, expectedRevision) {
  const file = path.join(directory, 'conversation.json');
  let release;
  try {
    release = archiveLock(directory, store.data.storeId, view.key);
    const previous = read(file, true);
    if (previous) {
      store._validateView(previous, view);
      if (expectedRevision !== undefined && previous.revision !== expectedRevision)
        throw new ChannelError(
          'STATE_WRITE_FAILED',
          '会话文件已被其他实例更新，未覆盖或重复处理；请重新启用插件读取最新记录'
        );
      if (previous.revision > view.revision)
        throw new ChannelError('CONVERSATION_PATH_CONFLICT', '目标目录已有更新的会话记录，未覆盖；原保存路径保持不变');
      if (previous.revision === view.revision && JSON.stringify(previous) !== JSON.stringify(view))
        throw new ChannelError(
          'CONVERSATION_PATH_CONFLICT',
          '目标目录存在内容不同的同版本会话记录，未覆盖；请选择其他目录'
        );
      if (expectedRevision === undefined && previous.revision < view.revision) {
        const sourceRecords = new Map(view.records.map((record) => [record.key, record]));
        const diverged = previous.records.some((record) => {
          const source = sourceRecords.get(record.key);
          return (
            !source ||
            ['accountId', 'peerId', 'chatType', 'messageId', 'question', 'senderId', 'createdAt'].some(
              (field) => record[field] !== source[field]
            ) ||
            (record.state === 'sent' &&
              (source.state !== 'sent' ||
                source.reply !== record.reply ||
                (record.acknowledgedMessageIds ?? []).some((id) => !source.acknowledgedMessageIds?.includes(id))))
          );
        });
        if (diverged)
          throw new ChannelError(
            'CONVERSATION_PATH_CONFLICT',
            '目标目录保留了当前来源没有的不同记录，未覆盖；请选择独立目录后核对历史数据'
          );
      }
    } else if (expectedRevision !== undefined) {
      throw new ChannelError('STATE_WRITE_FAILED', '已使用的会话文件缺失，未创建空记录替代；请检查保存目录');
    } else if (fs.readdirSync(directory).some((name) => name !== '.wechat-agent-write.lock')) {
      throw new ChannelError(
        'CONVERSATION_PATH_CONFLICT',
        '目标会话目录不是空目录，未覆盖已有文件；请选择其他保存路径'
      );
    }
    write(file, view);
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError('STATE_WRITE_FAILED', '会话文件无法写入，请检查保存目录的权限和磁盘空间；未继续回复');
  } finally {
    release?.();
  }
}

export function withSourceLocks(store, views, operation) {
  const releases = [];
  try {
    for (const view of [...views].sort((a, b) => a.key.localeCompare(b.key))) {
      const directory = store.data.conversations[view.key].directory;
      const file = path.join(directory, 'conversation.json');
      if (!fs.existsSync(file))
        throw new ChannelError(
          'STORAGE_SOURCE_CHANGED',
          '源会话文件已不存在，未切换保存路径；请检查目录并重新启用插件'
        );
      releases.push(archiveLock(directory, store.data.storeId, view.key));
      const current = read(file);
      store._validateView(current, view);
      const expected = store.written.get(view.key);
      if (JSON.stringify(current) !== expected || JSON.stringify(view) !== expected)
        throw new ChannelError(
          'STORAGE_SOURCE_CHANGED',
          '源会话记录已被其他实例更新或仍有未保存状态，未迁移；请重新启用插件读取最新记录'
        );
    }
    return operation();
  } finally {
    let error;
    for (const release of releases.reverse()) {
      try {
        release();
      } catch (failure) {
        error ??= failure;
      }
    }
    if (error) throw error;
  }
}
