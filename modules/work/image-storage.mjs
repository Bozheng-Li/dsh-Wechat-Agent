import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { artifactMetadata } from '../../shared/work-artifacts.mjs';
import { inspectAssetImage } from '../media/image-format.mjs';
import { readWorkArtifact } from './artifacts.mjs';
import { workFiles } from './result.mjs';
import { workPath } from './policy.mjs';

export const GENERATED_IMAGES_DIRECTORY = '微信agent/generated-images';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const imageFile = value => /\.(?:png|jpe?g)$/i.test(value.path) && ['image/png', 'image/jpeg'].includes(value.mediaType);
const imageFiles = cwd => workFiles(cwd).filter(file => /\.(?:png|jpe?g)$/i.test(file.path) && file.bytes > 0);

export function workImageSnapshot(cwd) {
  return new Map(imageFiles(cwd).map(file => {
    try { return [file.path, digest(fs.readFileSync(workPath(cwd, file.path)))]; }
    catch { return [file.path, null]; }
  }));
}
function sameImage(root, relative, expected) {
  const target = workPath(root, relative);
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    return stat.isFile() && stat.size === expected.bytes && digest(fs.readFileSync(descriptor)) === expected.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function versionPath(relative, sha256, attempt) {
  if (!attempt) return relative;
  const extension = path.extname(relative), suffix = '-' + sha256 + (attempt > 1 ? '-' + attempt : '');
  const stem = path.basename(relative, extension).slice(0, 240 - extension.length - suffix.length);
  return path.posix.join(path.posix.dirname(relative), stem + suffix + extension);
}
function archiveImage(job, cwd, artifact) {
  if (!artifactMetadata(artifact) || !/^[a-f0-9]{12}$/.test(job.id))
    throw new ChannelError('WORK_ARTIFACT_INVALID', '图片存档的成果记录无效，原任务文件保留');
  const prefix = `${GENERATED_IMAGES_DIRECTORY}/${job.id}/`;
  const archiveSource = prefix.length + artifact.path.length <= 2000 ? artifact.path : artifact.name;
  let relative = prefix + archiveSource;
  let temporary;
  let descriptor;
  try {
    const root = path.resolve(job.workspaceRoot);
    if (path.resolve(cwd) !== workPath(root, job.folder))
      throw new ChannelError('WORK_PATH_INVALID', '图片的任务目录与原工作主目录不一致，未保存到其他工作区');
    const previous = job.imageArchives?.find(value => value.sourcePath === artifact.path && value.sha256 === artifact.sha256 &&
      value.state === 'saved' && value.path.startsWith(prefix));
    if (previous && sameImage(root, previous.path, artifact)) return previous;
    if (sameImage(root, relative, artifact)) return { ...artifact, path: relative, sourcePath: artifact.path, state: 'saved' };
    const prepared = readWorkArtifact(cwd, artifact.path, artifact);
    const content = Buffer.from(prepared.segment.data.base64, 'base64');
    inspectAssetImage(content, { maxBytes: content.length });
    const target = workPath(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    workPath(root, relative);
    // Write and flush a private complete copy before publishing it. Exclusive
    // copying never replaces an existing archive, even across competing tasks.
    temporary = workPath(root, path.posix.join(path.posix.dirname(relative), `.image-${randomUUID()}.tmp`));
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      relative = prefix + versionPath(archiveSource, artifact.sha256, attempt);
      if (sameImage(root, relative, artifact))
        return { ...artifact, path: relative, sourcePath: artifact.path, state: 'saved' };
      try { fs.copyFileSync(temporary, workPath(root, relative), fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      descriptor = fs.openSync(workPath(root, relative), 'r+');
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      if (!sameImage(root, relative, artifact))
        throw new ChannelError('WORK_IMAGE_ARCHIVE_CHANGED', '图片存档写入后内容不一致，原任务文件保留，请检查磁盘');
      return { ...artifact, path: relative, sourcePath: artifact.path, state: 'saved' };
    }
    throw new ChannelError('WORK_IMAGE_ARCHIVE_FAILED', '图片同名存档已满，原任务文件保留，请检查生成图片目录');
  } catch (error) {
    return { ...artifact, path: relative, sourcePath: artifact.path, state: 'failed',
      error: publicError(error, '图片未能保存到主目录，请检查磁盘和目录权限；原任务文件保留') };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Preserve the archive result and original task image. */ } }
  }
}
export function archiveWorkImages(job, cwd, artifacts) {
  return artifacts.filter(imageFile).map(artifact => archiveImage(job, cwd, artifact));
}
/** Also retain native-tool images if execution or text polishing is cancelled. */
export function archiveChangedWorkImages(job, cwd, before) {
  const artifacts = imageFiles(cwd).flatMap(file => {
    try {
      const artifact = readWorkArtifact(cwd, file.path, undefined, 'file').metadata;
      if (before.get(file.path) === artifact.sha256 || job.imageArchives?.some(value =>
        value.sourcePath === file.path && value.sha256 === artifact.sha256 && value.state === 'saved')) return [];
      return [artifact];
    } catch { return []; }
  });
  return archiveWorkImages(job, cwd, artifacts);
}
export function mergeImageArchives(previous = [], next) {
  const entries = new Map(previous.map(value => [value.sourcePath + ':' + value.sha256, value]));
  for (const value of next) entries.set(value.sourcePath + ':' + value.sha256, value);
  return [...entries.values()];
}
