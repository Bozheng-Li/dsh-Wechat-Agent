import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../../shared/contracts.mjs';
import { atomicBytes } from '../../storage/atomic-text.mjs';
import { RECEIVED_FILE_LIMITS, receivedFileName } from '../../../shared/received-files.mjs';

const hash = (content, algorithm = 'sha256') => createHash(algorithm).update(content).digest('hex');
function localFile(directory, filename) {
  const target = path.join(directory, filename);
  if (fs.existsSync(target)) {
    const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(target));
    if (path.isAbsolute(relative) || relative.startsWith('..') || !relative || fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isFile())
      throw new ChannelError('FILE_CACHE_INVALID', '附件缓存路径无效，未读取其他位置的文件');
  }
  return target;
}

export async function loadObservedFile({ directory, resourceId, peerId, messageId, signal, assertCurrent, download }) {
  signal.throwIfAborted(); assertCurrent();
  if (!/^[a-f0-9]{64}$/.test(resourceId ?? '') || resourceId !== hash(`${peerId}:${messageId}`))
    throw new ChannelError('FILE_SOURCE_INVALID', '附件标识不属于这条会话消息');
  const descriptorFile = localFile(directory, resourceId + '.json');
  let file, descriptorBytes;
  try {
    if (fs.statSync(descriptorFile).size > 65536) throw Error();
    descriptorBytes = fs.readFileSync(descriptorFile); file = JSON.parse(descriptorBytes.toString('utf8'));
  } catch { throw new ChannelError('FILE_UNAVAILABLE', '未保存这条文件消息的附件信息，请在当前会话重新发送原文件'); }
  if (file.version !== 1 || file.resourceId !== resourceId || file.peerId !== peerId || file.messageId !== messageId ||
      file.direction !== 'incoming' || typeof file.name !== 'string' || receivedFileName(file.name) !== file.name)
    throw new ChannelError('FILE_SOURCE_INVALID', '附件描述与收到的原消息不匹配');
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > RECEIVED_FILE_LIMITS.bytes)
    throw new ChannelError('FILE_SIZE_UNSUPPORTED', '目前支持有明确长度且不超过 20 MiB 的非空微信附件');
  const target = localFile(directory, resourceId + '.file');
  const integrityFile = localFile(directory, resourceId + '.integrity.json'), source = hash(descriptorBytes);
  const verify = content => {
    if (!Buffer.isBuffer(content) || content.length !== file.bytes || file.md5 && hash(content, 'md5') !== file.md5)
      throw new ChannelError('FILE_INTEGRITY_FAILED', '附件长度或 MD5 校验失败，未把损坏或不完整内容交给 DSH');
    return content;
  };
  let content, cached = false;
  if (fs.existsSync(target) && fs.existsSync(integrityFile)) {
    let integrity;
    try {
      if (fs.statSync(integrityFile).size > 2048) throw Error();
      integrity = JSON.parse(fs.readFileSync(integrityFile, 'utf8'));
      if (integrity.version !== 1 || integrity.source !== source || integrity.bytes !== file.bytes || !/^[a-f0-9]{64}$/.test(integrity.sha256)) throw Error();
    } catch { throw new ChannelError('FILE_INTEGRITY_FAILED', '已保存附件的来源或完整性记录已变化，未读取旧缓存'); }
    if (fs.statSync(target).size !== file.bytes) throw new ChannelError('FILE_INTEGRITY_FAILED', '已保存附件的大小已变化，请清理该缓存后重试');
    content = verify(fs.readFileSync(target));
    if (hash(content) !== integrity.sha256) throw new ChannelError('FILE_INTEGRITY_FAILED', '已保存附件的 SHA-256 校验失败，未把变化后的内容交给 DSH');
    cached = true;
  } else {
    // Opaque CDN locators are not ordinary URLs or interchangeable CGI IDs.
    if (!file.attachId || file.attachId.startsWith('@cdn_'))
      throw new ChannelError('FILE_DOWNLOAD_UNSUPPORTED', file.cdnUrl || file.attachId
        ? '这条附件只有 CDN 专用资源标识，当前下载协议尚不支持；未将其当作普通链接或已读文件'
        : '微信未提供可用的附件下载标识，请重新发送原文件');
    content = verify(await download(file));
    signal.throwIfAborted(); assertCurrent();
    if (!fs.readFileSync(descriptorFile).equals(descriptorBytes)) throw new ChannelError('FILE_SOURCE_INVALID', '下载期间附件来源信息已变化，请重新读取原文件');
    atomicBytes(target, content);
    atomicBytes(integrityFile, Buffer.from(JSON.stringify({ version: 1, source, bytes: content.length, sha256: hash(content) })));
  }
  signal.throwIfAborted(); assertCurrent();
  return { name: file.name, bytes: content.length, sha256: hash(content), data: content.toString('base64'), cached };
}
