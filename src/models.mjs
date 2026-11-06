import { ChannelError, validateModelChoice } from './contracts.mjs';

/** Use the same live registry as DSH's model picker, never provider URLs/keys. */
export async function availableModel(ctx, input, signal) {
  signal?.throwIfAborted();
  const selection = validateModelChoice(input);
  if (selection === null) return null;
  const registered = () => ctx.llm.listProviders().some(provider => provider.id === selection.provider);
  if (!registered()) throw new ChannelError('MODEL_UNAVAILABLE', '该模型已不在 DSH 可用列表中，请重新选择');
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
  let abort;
  try {
    const models = await Promise.race([
      Promise.resolve().then(() => ctx.llm.listModels(selection.provider)),
      new Promise((resolve, reject) => {
        abort = () => reject(lifetime.reason);
        lifetime.addEventListener('abort', abort, { once: true });
        if (lifetime.aborted) abort();
      })
    ]);
    signal?.throwIfAborted();
    if (!registered() || !models.some(model => model.id === selection.model))
      throw new ChannelError('MODEL_UNAVAILABLE', '该模型已不在 DSH 可用列表中，请重新选择');
    return selection;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ChannelError) throw error;
    throw new ChannelError('MODEL_CATALOG_FAILED', '暂时无法读取 DSH 的模型列表，请刷新列表后重试');
  } finally { lifetime.removeEventListener('abort', abort); }
}

export async function selectModel(ctx, store, input, signal) {
  const selection = await availableModel(ctx, input, signal);
  signal?.throwIfAborted();
  store.setModelChoice(selection);
  return selection;
}

/** Image understanding may use a separate, explicitly image-capable route. */
export async function visionSelection(ctx, selected, configured, signal) {
  signal?.throwIfAborted();
  const choice = configured ? await availableModel(ctx, configured, signal) : selected;
  if (typeof ctx.llm.resolveModelInfo !== 'function') return choice;
  const info = await ctx.llm.resolveModelInfo(choice.provider, choice.model, signal);
  if (!info.inputModalities || info.inputModalities.includes('image')) return choice;
  if (configured) throw new ChannelError('MODEL_NO_VISION', '所选图像理解模型不接受图片，请在高级设置中选择支持图像的模型');
  const models = await ctx.llm.listModels(choice.provider, signal);
  const candidates = models.filter(model => model.inputModalities?.includes('image'));
  // A dated custom route can be missing capability metadata while the same
  // family's stable route is explicitly advertised as accepting images.
  const family = choice.model.replace(/-\d{4,8}$/, '');
  const candidate = candidates.find(model => model.id === family) || candidates[0];
  if (!candidate) throw new ChannelError('MODEL_NO_VISION', '当前 DSH 服务没有可用的视觉模型，请在高级设置中指定图像理解模型');
  return { provider: choice.provider, model: candidate.id };
}
