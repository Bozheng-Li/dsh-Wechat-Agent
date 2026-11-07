import { ChannelError, validatePersona, validateModelConfig } from '../../shared/contracts.mjs';
import { selectModel, visionSelection } from '../../features/agent/models.mjs';

export const endpoints = ['search.credentials', 'identity.save', 'model.select', 'model.configure', 'persona.save'];

export async function agentMutation(
  { ctx, store, runner, identity, lifetime, assertLive, paused, status },
  endpoint,
  payload,
  signal
) {
  switch (endpoint) {
    case 'search.credentials': {
      if (!runner?.search)
        throw new ChannelError('WEB_SEARCH_CREDENTIAL_STORE_MISSING', '搜索组件尚未就绪，密钥未保存。');
      await runner.search.configureCredential(
        payload.provider,
        payload.apiKey,
        AbortSignal.any([lifetime, ...(signal ? [signal] : [])])
      );
      break;
    }
    case 'identity.save': {
      const current = identity.validateEdit(payload.markdown, payload.revision);
      if (current.markdown !== payload.markdown)
        await paused('正在应用全局身份，旧任务已取消', () => {
          signal?.throwIfAborted();
          identity.edit(payload.markdown, payload.revision);
        });
      break;
    }
    case 'model.select':
      await selectModel(ctx, store, payload.selection, AbortSignal.any([lifetime, ...(signal ? [signal] : [])]));
      break;
    case 'model.configure': {
      const config = validateModelConfig(payload.modelConfig);
      if (config.vision && config.visionModel)
        await visionSelection(
          ctx,
          config.visionModel,
          config.visionModel,
          AbortSignal.any([lifetime, ...(signal ? [signal] : [])])
        );
      assertLive(signal);
      store.setModelConfig(config);
      break;
    }
    case 'persona.save': {
      const persona = validatePersona(payload.persona);
      if (JSON.stringify(persona) !== JSON.stringify(store.persona()))
        await paused('正在应用人设，旧任务已取消', () => {
          signal?.throwIfAborted();
          store.resetSessions();
          store.setPersona(persona);
        });
      break;
    }
  }
  assertLive(signal);
  return status();
}
