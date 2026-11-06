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
