import { ChannelError } from "../../shared/contracts.mjs";

export const endpoints = [
  'assets.import',
  'assets.configure',
  'assets.packs.configure',
  'assets.edit',
  'assets.delete',
  'assets.describe',
  'assets.upload.start',
  'assets.upload.chunk',
  'assets.upload.finish',
  'assets.upload.abort',
];

export async function mediaMutation(
  { store, runner, channel, lifetime, assertLive, currentAccount, paused, status },
  endpoint,
  payload,
  signal
) {
  switch (endpoint) {
    case 'assets.import': {
      const account = currentAccount(payload);
      return channel.library.import(account.id, payload);
    }
    case 'assets.configure': {
      const account = currentAccount(payload);
      if (payload.settings?.enabled === false)
        return paused(
          '正在停用图片回复',
          () => {
            currentAccount(payload);
            return channel.library.configure(account.id, payload.settings);
          },
          { accountId: account.id, mediaOnly: true },
          { resetProgress: false }
        );
      return channel.library.configure(account.id, payload.settings);
    }
    case 'assets.packs.configure': {
      const account = currentAccount(payload),
        pack = channel.library.validatePackSetting(account.id, payload.packId, payload.enabled);
      const apply = () => {
        currentAccount(payload);
        assertLive(signal);
        return channel.library.configurePack(account.id, pack.id, payload.enabled);
      };
      if (!payload.enabled)
        return paused(
          '正在停用素材分组',
          apply,
          { accountId: account.id, assetIds: pack.assetIds },
          { resetProgress: false }
        );
      return apply();
    }
    case 'assets.edit': {
      const account = currentAccount(payload);
      if (payload.patch?.enabled === false) {
        channel.library.resolveAsset(account.id, payload.assetId, { enabledOnly: false });
        return paused(
          '正在停用这张素材',
          () => {
            currentAccount(payload);
            return channel.library.edit(account.id, payload.assetId, payload.patch);
          },
          { accountId: account.id, assetIds: [payload.assetId] },
          { resetProgress: false }
        );
      }
      return channel.library.edit(account.id, payload.assetId, payload.patch);
    }
    case 'assets.delete': {
      const account = currentAccount(payload);
      if (!Array.isArray(payload.assetIds) || !payload.assetIds.length)
        throw new ChannelError('INVALID_ASSETS', '请选择要删除的素材');
      for (const id of payload.assetIds) channel.library.resolveAsset(account.id, id, { enabledOnly: false });
      return paused(
        '正在删除这张素材',
        () => {
          currentAccount(payload);
          return channel.library.remove(account.id, payload.assetIds);
        },
        { accountId: account.id, assetIds: payload.assetIds },
        { resetProgress: false }
      );
    }
    case 'assets.describe': {
      const account = currentAccount(payload);
      if (!store.modelConfig().vision) throw new ChannelError('VISION_DISABLED', '请先在模型高级设置中开启图像理解');
      return channel.library.describe(
        account.id,
        payload.assetIds,
        runner,
        AbortSignal.any([lifetime, ...(signal ? [signal] : [])])
      );
    }
    case 'assets.upload.start': {
      const account = currentAccount(payload);
      return channel.library.beginUpload(account.id, payload);
    }
    case 'assets.upload.chunk': {
      const account = currentAccount(payload);
      return channel.library.appendUpload(account.id, payload.uploadId, payload);
    }
    case 'assets.upload.finish': {
      const account = currentAccount(payload);
      return channel.library.finishUpload(account.id, payload.uploadId);
    }
    case 'assets.upload.abort': {
      const account = currentAccount(payload);
      return channel.library.abortUpload(account.id, payload.uploadId);
    }
  }
  assertLive(signal);
  return status();
}
