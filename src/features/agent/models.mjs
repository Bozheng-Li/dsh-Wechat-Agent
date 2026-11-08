import { ChannelError, validateModelChoice } from '../../shared/contracts.mjs';

/** Use the same live registry as DSH's model picker, never provider URLs/keys. */
async function lookupModel(ctx, selection, signal, includeInfo) {
  signal?.throwIfAborted();
  const registered = () => ctx.llm.listProviders().some((provider) => provider.id === selection.provider);
  if (!registered()) throw new ChannelError('MODEL_UNAVAILABLE', '该模型已不在 DSH 可用列表中，请重新选择');
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
  let abort;
  let readingReasoning = false;
  let info;
  const cancelled = new Promise((resolve, reject) => {
    abort = () => reject(lifetime.reason);
    lifetime.addEventListener('abort', abort, { once: true });
    if (lifetime.aborted) abort();
  });
  const lookup = (read) => Promise.race([Promise.resolve().then(read), cancelled]);
  try {
    const models = await lookup(() => ctx.llm.listModels(selection.provider));
    lifetime.throwIfAborted();
    if (!registered() || !models.some((model) => model.id === selection.model))
      throw new ChannelError('MODEL_UNAVAILABLE', '该模型已不在 DSH 可用列表中，请重新选择');
    if (includeInfo) {
      readingReasoning = true;
      if (typeof ctx.llm.resolveModelInfo !== 'function')
        throw new ChannelError('MODEL_REASONING_UNAVAILABLE', '当前 DSH 无法读取模型的推理强度，请刷新模型列表或使用模型默认');
      info = await lookup(() => ctx.llm.resolveModelInfo(selection.provider, selection.model, lifetime));
      lifetime.throwIfAborted();
      if (!registered()) throw new ChannelError('MODEL_UNAVAILABLE', '该模型已不在 DSH 可用列表中，请重新选择');
      if (info?.id !== undefined && info.id !== selection.model)
        throw new ChannelError('MODEL_REASONING_UNAVAILABLE', 'DSH 返回的模型信息不匹配，请刷新模型列表后重试');
    }
    return info;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ChannelError) throw error;
    if (readingReasoning)
      throw new ChannelError('MODEL_REASONING_UNAVAILABLE', '暂时无法读取所选模型的推理强度，请刷新模型列表后重试');
    throw new ChannelError('MODEL_CATALOG_FAILED', '暂时无法读取 DSH 的模型列表，请刷新列表后重试');
  } finally {
    lifetime.removeEventListener('abort', abort);
  }
}

export async function availableModel(ctx, input, signal) {
  signal?.throwIfAborted();
  const selection = validateModelChoice(input);
  if (selection === null) return null;
  // Omission keeps the model/Host default. An explicit choice must come from
  // this exact model's live metadata, never a provider-specific guess.
  const info = await lookupModel(ctx, selection, signal, selection.reasoningEffort !== undefined);
  if (selection.reasoningEffort !== undefined && (
    !Array.isArray(info?.reasoning?.efforts) ||
    !info.reasoning.efforts.some((effort) => effort?.id === selection.reasoningEffort)
  ))
    throw new ChannelError('MODEL_REASONING_UNSUPPORTED', '所选模型不支持这个推理强度，请刷新模型列表后重新选择，或使用模型默认');
  return selection;
}

/** The shared catalog may omit reasoning metadata; resolve the selected model explicitly. */
export async function readModelInfo(ctx, input, signal) {
  signal?.throwIfAborted();
  const selection = validateModelChoice(input);
  if (!selection) throw new ChannelError('INVALID_MODEL', '请先选择具体模型，再读取推理强度');
  const info = await lookupModel(ctx, selection, signal, true);
  const unavailable = () => new ChannelError('MODEL_REASONING_UNAVAILABLE', 'DSH 未能提供有效的模型推理信息，请重试读取');
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw unavailable();
  const reasoning = info.reasoning;
  if (reasoning != null && !Array.isArray(reasoning.efforts)) throw unavailable();
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 300 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  const efforts = [];
  for (const effort of reasoning?.efforts || []) {
    if (!effort || !validId(effort.id)) throw unavailable();
    if (efforts.some(value => value.id === effort.id)) continue;
    efforts.push({
      id: effort.id,
      name: typeof effort.name === 'string' && effort.name.trim() ? effort.name.trim().slice(0, 200) : effort.id,
      ...(typeof effort.description === 'string' && effort.description.trim()
        ? { description: effort.description.trim().slice(0, 2000) } : {}),
    });
  }
  // Project only UI capability fields. Never return the provider's raw model configuration.
  return {
    provider: selection.provider,
    model: selection.model,
    reasoning: {
      efforts,
      ...(efforts.some(effort => effort.id === reasoning?.defaultEffort) ? { defaultEffort: reasoning.defaultEffort } : {}),
    },
  };
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
  if (configured)
    throw new ChannelError('MODEL_NO_VISION', '所选图像理解模型不接受图片，请在高级设置中选择支持图像的模型');
  const models = await ctx.llm.listModels(choice.provider, signal);
  const candidates = models.filter((model) => model.inputModalities?.includes('image'));
  // A dated custom route can be missing capability metadata while the same
  // family's stable route is explicitly advertised as accepting images.
  const family = choice.model.replace(/-\d{4,8}$/, '');
  const candidate = candidates.find((model) => model.id === family) || candidates[0];
  if (!candidate)
    throw new ChannelError('MODEL_NO_VISION', '当前 DSH 服务没有可用的视觉模型，请在高级设置中指定图像理解模型');
  return { provider: choice.provider, model: candidate.id };
}
