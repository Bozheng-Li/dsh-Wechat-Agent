import { imageGenerationSettings } from '../../shared/image-generation.mjs';
import { ChannelError } from '../../shared/contracts.mjs';

export const endpoints = ['imageGeneration.configure', 'imageGeneration.credential', 'work.retryDelivery'];
export async function workMutation({ store, channel, lifetime, assertLive, status, currentAccount, conversation }, endpoint, payload, signal) {
  const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
  assertLive(combined); store.config.assertCurrent();
  if (endpoint === 'work.retryDelivery') {
    if (!channel?.work) throw new ChannelError('WORK_UNAVAILABLE', '工作组件尚未就绪');
    const account = currentAccount(payload), scope = payload.peerId ? conversation(payload) : { accountId: account.id };
    return channel.work.retryDelivery(payload.id, scope, { signal: combined, expectedUpdatedAt: payload.expectedUpdatedAt,
      expectedRetryCount: payload.expectedRetryCount, confirmedNotReceived: payload.confirmedNotReceived });
  }
  if (!channel?.work?.imageGeneration) throw new ChannelError('IMAGE_GENERATION_UNAVAILABLE', '工作生图组件尚未就绪');
  if (endpoint === 'imageGeneration.configure') {
    const settings = imageGenerationSettings(payload.settings), next = store.config.snapshot(store.data);
    next.imageGeneration = settings; store.config.commit(next);
    await channel.work.imageGeneration.refreshCredential();
  } else if (endpoint === 'imageGeneration.credential') await channel.work.imageGeneration.configureCredential(payload.apiKey, combined, { providerId: payload.providerId, endpoint: payload.endpoint });
  assertLive(combined); return status();
}
