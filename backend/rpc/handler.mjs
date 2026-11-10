import { ChannelError, publicError } from "../../shared/contracts.mjs";
import { WORKBENCH_ENDPOINTS } from "../../modules/workbench/service.mjs";

export function rpcHandler(service, isDisposed = () => false) {
  return async (endpoint, payload, signal, peer) => {
    try {
      if (peer?.principal?.kind !== 'owner')
        throw new ChannelError('OWNER_REQUIRED', '只有 DSH 本机所有者可以管理微信插件');
      if (isDisposed()) throw new ChannelError('PLUGIN_STOPPING', '微信插件正在停止，请稍后重试');
      signal?.throwIfAborted();
      if (
        ![
          'status',
          'administrators.configure',
          'administrators.candidates',
          'changelog',
          'identity.get',
          'identity.save',
          'settings',
          'model.info',
          'model.select',
          'model.configure',
          'search.credentials',
          'imageGeneration.configure',
          'imageGeneration.credential',
          'persona.save',
          'storage.save',
          'conversation.configure',
          'natural.resume',
          'records.list',
          'contacts',
          'members',
          'moments.read',
          'moments.audience',
          'moments.list',
          'moments.discover',
          'moments.configure',
          'moments.write',
          'moments.publishing.configure',
          'moments.plans.save',
          'moments.plans.enable',
          'moments.plans.delete',
          'moments.plans.preview',
          'moments.drafts.edit',
          'moments.drafts.publish',
          'moments.drafts.discard',
          'moments.drafts.reconcile',
          'moments.drafts.image',
          'connect',
          'disconnect',
          'login.start',
          'login.cancel',
          'cancel',
          'memory.list',
          'memory.get',
          'memory.configure',
          'memory.edit',
          'memory.clear',
          'memory.compress',
          'memory.retryImages',
          'memory.global.get',
          'memory.global.edit',
          'memory.global.clear',
          'memory.global.extract',
          'memory.images.list',
          'memory.images.content',
          'memory.images.configure',
          'memory.images.import',
          'memory.images.delete',
          'memory.images.clear',
          'assets.list',
          'assets.content',
          'assets.import',
          'assets.edit',
          'assets.delete',
          'assets.configure',
          'assets.describe',
          'assets.upload.start',
          'assets.upload.chunk',
          'assets.upload.finish',
          'assets.upload.abort',
          'assets.packs.configure',
          'assets.packs.content',
          'tasks.list',
          'work.list',
          'work.get',
          'work.cancel',
          'work.configure',
          'work.retryDelivery',
          'tasks.create',
          'tasks.cancel',
          'tasks.pause',
          'tasks.resume',
          ...WORKBENCH_ENDPOINTS,
        ].includes(endpoint)
      )
        throw new ChannelError('UNKNOWN_OPERATION', '不支持的微信插件操作');
      return { ok: true, value: await service.call(endpoint, payload ?? {}, signal) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  };
}
