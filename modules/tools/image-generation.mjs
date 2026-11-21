import { randomUUID } from 'node:crypto';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { MEDIA_LIBRARY_LIMITS } from '../media/limits.mjs';

/** Ordinary chat generation uses the plugin's existing DSH-owned image service.
 * It never depends on the sticker/image library being non-empty. */
export function imageGenerationTool({ imageGeneration, library, scope, select, assertAllowed = () => {} }) {
  let attempted = false;
  return {
    name: 'wechat_generate_image',
    description: '按用户明确要求生成一张新图片，随本轮回复一起发出。只需要提供画面描述；不要编造图片地址。生成成功后会安排到当前回复，等待真实微信回执；失败应如实说明，不重复请求。',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 4000, description: '画面描述：主体、场景、风格、构图、光线和需要出现的文字。' },
      size: { type: 'string', maxLength: 32, description: '可选图片尺寸；省略时使用已选接口的默认值。' },
    }, required: ['prompt'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async (args, exec = {}) => {
      const check = () => { exec.signal?.throwIfAborted(); assertAllowed(); };
      check();
      try {
        if (!args || typeof args !== 'object' || Array.isArray(args) ||
            Object.keys(args).some(key => !['prompt', 'size'].includes(key)) ||
            typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000 ||
            args.size !== undefined && (typeof args.size !== 'string' || args.size.length > 32))
          throw new ChannelError('IMAGE_GENERATION_PROMPT', '请提供要画的内容，最多 4000 字');
        if (!imageGeneration?.generate || !imageGeneration?.status?.().enabled || !imageGeneration.status().credentialConfigured)
          throw new ChannelError('IMAGE_GENERATION_DISABLED', '生图 API 尚未启用或没有已保存的密钥，请先检查设置');
        if (attempted) throw new ChannelError('IMAGE_GENERATION_ALREADY_ATTEMPTED', '本轮生图请求已经尝试执行，不会再次调用；请依据首次结果回复');
        // Set immediately before crossing the provider boundary; even a timeout or
        // provider failure must not cause a second billable generation in this turn.
        attempted = true;
        const generated = await imageGeneration.generate({ prompt: args.prompt.trim(), ...(args.size ? { size: args.size } : {}) }, exec.signal, assertAllowed);
        check();
        // Chat sends this through the image segment limit (10 MiB). Large outputs
        // belong in DSH work artifacts, which have a separate file delivery path.
        if (generated.bytes.length > MEDIA_LIBRARY_LIMITS.imageBytes)
          throw new ChannelError('IMAGE_GENERATION_TOO_LARGE', '生成图片超过聊天图片发送上限，未导入素材库或发送；可在工作任务中交付为原图文件');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const extension = generated.mediaType === 'image/jpeg' ? 'jpg' : 'png';
        const imported = library.import(scope.accountId, { name: `AI-${stamp}.${extension}`, kind: 'image', data: generated.bytes.toString('base64') });
        const assetId = imported.assetIds?.[0] ?? imported.duplicateIds?.[0];
        if (!assetId) throw new ChannelError('IMAGE_GENERATION_SAVE', '图片已生成，但没有存入素材库，未发出');
        const asset = library.resolveAsset(scope.accountId, assetId, { enabledOnly: false });
        await select({ asset, caption: '', generated: { jobId: randomUUID().replaceAll('-', '').slice(0, 12),
          bytes: generated.bytes, mediaType: generated.mediaType,
          prompt: args.prompt.trim(), fileName: asset.name, providerName: generated.providerName, model: generated.model, generatedAt: Date.now() } });
        check();
        return JSON.stringify({ ok: true, provider: generated.providerName, model: generated.model,
          note: '图片已生成并安排到本轮回复；仅在收到微信服务端回执后才算送达，不要重复生成' });
      } catch (error) {
        check();
        return JSON.stringify({ ok: false, ...publicError(error, '这次没有生成图片，未发出') });
      }
    },
  };
}
