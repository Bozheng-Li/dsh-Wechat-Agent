import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { inspectAssetImage } from '../media/image-format.mjs';
import { workPath } from '../work/policy.mjs';
const MAX_BYTES = 10 * 1024 * 1024;
export function momentsImage(data) {
  const info = inspectAssetImage(data, { maxBytes: MAX_BYTES });
  if (!['image/png', 'image/jpeg'].includes(info.mediaType)) throw new ChannelError('MOMENTS_IMAGE_FORMAT', '朋友圈图片发布目前使用 PNG 或 JPEG，请先转换图片');
  return { data: data.toString('base64'), width: info.width, height: info.height };
}
export function workMomentsMedia(cwd) {
  return { description: 'images 填本任务目录内 PNG/JPEG 图片的相对路径，最多 9 张，每张不超过 10 MiB。',
    load: async (paths, signal, check) => paths.map(relative => {
      check(); signal?.throwIfAborted();
      if (typeof relative !== 'string' || relative.replaceAll('\\', '/').split('/').some(part => part.toLowerCase() === '.wechat-work'))
        throw new ChannelError('MOMENTS_IMAGE_PATH', '请选择当前任务目录中的普通图片文件');
      const target = workPath(cwd, relative); let descriptor;
      try {
        descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new ChannelError('MOMENTS_IMAGE_SIZE', '朋友圈图片须为有效普通文件，且每张不超过 10 MiB');
        const data = fs.readFileSync(descriptor); workPath(cwd, relative); check(); signal?.throwIfAborted();
        if (data.length !== stat.size) throw new ChannelError('MOMENTS_IMAGE_CHANGED', '图片正在变化，未发布，请先保存完成');
        return momentsImage(data);
      } catch (error) {
        if (error instanceof ChannelError) throw error;
        throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '当前任务图片无法读取，未上传或发布');
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }) };
}
export function chatMomentsMedia(channel, scope, snapshot, currentKey) {
  const candidates = snapshot.entries.flatMap(entry => (entry.attachments ?? []).filter(attachment => attachment.type === 'image' && attachment.resourceId && entry.messageId)
    .map(attachment => ({ entry, attachment, id: createHash('sha256').update(JSON.stringify([entry.key, attachment.resourceId])).digest('hex') }))).slice(-12);
  return { description: 'images 只能选择下列当前微信会话图片 ID：' + JSON.stringify(candidates.map(({ entry, attachment, id }) => ({ id, current: entry.key === currentKey, text: entry.text?.slice(0, 150), description: attachment.description }))),
    load: async (ids, signal, check) => {
      const images = [];
      for (const id of ids) {
        check(); signal?.throwIfAborted(); const candidate = candidates.find(item => item.id === id), doc = channel.memory.load(scope);
        const assertImageCurrent = () => {
          const current = channel.memory.load(scope);
          if (!candidate || current.generation !== snapshot.generation || !current.entries.some(entry => entry.key === candidate.entry.key && entry.attachments?.some(attachment => attachment.resourceId === candidate.attachment.resourceId)) ||
              channel.memory.expiry(candidate.entry.rememberedAt ?? snapshot.createdAt) <= channel.memory.now())
            throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '这张图片不属于本轮会话列表、已到期或上下文已变化，未发布');
          const archive = channel.memory.images.load(scope), savedId = channel.memory.images.imageId(archive, candidate.entry, candidate.attachment);
          if (archive.deleted[savedId]) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '这张图片已删除或到期，未发布');
        };
        assertImageCurrent();
        const result = await channel.transport.media({ accountId: scope.accountId, peerId: scope.peerId, messageId: candidate.entry.messageId, resourceId: candidate.attachment.resourceId, preferOriginal: true }, signal);
        check(); signal?.throwIfAborted(); assertImageCurrent();
        if (!['original', 'full'].includes(result?.quality)) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '目前尚未取得完整图片，未代替原图发布');
        const data = Buffer.from(result?.data ?? '', 'base64');
        if (!data.length || data.length > MAX_BYTES || data.toString('base64') !== result.data) throw new ChannelError('MOMENTS_IMAGE_UNAVAILABLE', '未取得有效图片内容，未发布');
        images.push(momentsImage(data));
      }
      return images;
    } };
}
