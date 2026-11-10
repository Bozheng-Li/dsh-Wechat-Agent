import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { WORK_ARTIFACT_LIMITS, artifactName, artifactMetadata } from '../../shared/work-artifacts.mjs';
import { inspectAssetImage } from '../media/image-format.mjs';
import { workPath } from './policy.mjs';
import { workFiles } from './result.mjs';

const formats = { '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
export function readWorkArtifact(cwd, relative, expected, sendAs = expected?.kind ?? 'auto') {
  const target = workPath(cwd, relative), normalized = path.relative(cwd, target).replaceAll('\\', '/');
  if (normalized.split('/').some(part => part.toLowerCase() === '.wechat-work')) throw new ChannelError('WORK_ARTIFACT_INVALID', '任务内部记录不能作为工作成果回传');
  const name = artifactName(path.basename(target)), extension = path.extname(name).toLowerCase();
  if (!['auto', 'file', 'image'].includes(sendAs)) throw new ChannelError('WORK_ARTIFACT_INVALID', '请选择自动、文件附件或图片回传方式');
  let bytes;
  try {
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 1 || !Number.isSafeInteger(stat.size)) throw new ChannelError('WORK_ARTIFACT_SIZE', '成果文件为空或不是有效的普通文件');
      bytes = fs.readFileSync(descriptor);
      if (bytes.length !== stat.size) throw new ChannelError('WORK_ARTIFACT_CHANGED', '成果文件正在变化，请保存完成后重新登记');
    } finally { fs.closeSync(descriptor); }
    workPath(cwd, normalized);
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError('WORK_ARTIFACT_UNAVAILABLE', '成果文件无法读取，请检查文件是否已生成并保留在任务目录');
  }
  let kind = 'file', mediaType = formats[extension] || 'application/octet-stream';
  if (sendAs === 'image' || sendAs === 'auto' && /^\.(?:png|jpe?g)$/.test(extension)) {
    const info = inspectAssetImage(bytes, { maxBytes: bytes.length });
    if (!['image/png', 'image/jpeg'].includes(info.mediaType) || !/^\.(?:png|jpe?g)$/.test(extension) || info.mediaType !== (extension === '.png' ? 'image/png' : 'image/jpeg'))
      throw new ChannelError('WORK_ARTIFACT_INVALID', '图片格式与扩展名不一致');
    kind = bytes.length > WORK_ARTIFACT_LIMITS.imageBytes ? 'file' : 'image'; mediaType = info.mediaType;
  }
  const metadata = { path: normalized, name, kind, bytes: bytes.length, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (expected && (!artifactMetadata(expected) || Object.keys(metadata).some(key => metadata[key] !== expected[key])))
    throw new ChannelError('WORK_ARTIFACT_CHANGED', '成果文件在登记后已变化，旧内容尚未回传；请核对后继续任务并重新登记');
  return { metadata, segment: { type: kind, data: { name, mediaType, base64: bytes.toString('base64') } } };
}
export function workArtifacts(operations) {
  const selected = new Map();
  for (const operation of operations) if (operation.result.ok && ['wechat_work_output', 'wechat_work_generate_image'].includes(operation.tool))
    for (const artifact of operation.result.artifacts ?? []) {
      if (!artifactMetadata(artifact)) throw new ChannelError('WORK_ARTIFACT_INVALID', '成果登记记录无效，未回传附件');
      selected.set(artifact.path.toLowerCase(), artifact);
    }
  const artifacts = [...selected.values()];
  if (artifacts.length > WORK_ARTIFACT_LIMITS.count)
    throw new ChannelError('WORK_ARTIFACT_LIMIT', '一次任务最多回传 8 个成果');
  return artifacts;
}

/** Native DSH may use its own file tools instead of the WeChat output tool. */
export function nativeWorkFileSnapshot(cwd) {
  return new Map(workFiles(cwd).map(file => [file.path, fileRevision(workPath(cwd, file.path))]));
}

function fileRevision(target) {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024);
    let length;
    while ((length = fs.readSync(descriptor, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

export function nativeWorkArtifacts(cwd, text, before = new Map()) {
  const returned = String(text ?? '').replaceAll('\\', '/').toLowerCase();
  const candidates = workFiles(cwd).filter(file => {
    const target = workPath(cwd, file.path), revision = fileRevision(target);
    if (before.has(file.path) && before.get(file.path) === revision) return false;
    const name = path.basename(file.path).toLowerCase();
    return returned.includes(name) || /\.(?:png|jpe?g|webp|gif|docx|xlsx|pptx|pdf|csv|zip|7z|tar|gz)$/i.test(name);
  });
  if (candidates.length > WORK_ARTIFACT_LIMITS.count)
    throw new ChannelError('WORK_ARTIFACT_LIMIT', 'DSH 已生成文件，但一次最多回传 8 个成果；文件保留在任务目录');
  return candidates.map(file => readWorkArtifact(cwd, file.path).metadata);
}
