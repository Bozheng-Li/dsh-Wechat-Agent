import { ChannelError } from '../../shared/contracts.mjs';

/** Never run initialization on the launcher's synchronous readiness callback. */
export function afterAppReady(ctx, start, fail, signal) {
  let cancelled = false, scheduled, requested = false;
  let unsubscribe = () => {};
  const report = error => {
    if (!signal.aborted) return fail(error);
  };
  const cancel = () => {
    cancelled = true;
    clearImmediate(scheduled);
    unsubscribe();
    signal.removeEventListener('abort', cancel);
  };
  const schedule = () => {
    if (cancelled || requested || signal.aborted) return;
    requested = true;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      if (cancelled || signal.aborted) return;
      // Cordis does not await onReady listeners. Own every rejection here so
      // a failed optional integration cannot reach the host's fail-loud hook.
      void Promise.resolve().then(start).catch(report).catch(() => {});
    });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const ready = ctx.get?.('appReady') ?? ctx.appReady;
    if (typeof ready?.onReady !== 'function') {
      throw new ChannelError('HARNESS_READY_UNAVAILABLE', '无法确认 Harness 已就绪，微信插件暂未启动；请更新 Harness 后重新启用插件。');
    }
    unsubscribe = ready.onReady(schedule);
    if (signal.aborted) cancel();
  } catch (error) {
    report(error);
    cancel();
  }
  return cancel;
}

/** Stop waiting even when a host service ignores cancellation; observe late results. */
export function startupWait(task, signal) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      signal.removeEventListener('abort', aborted);
      settle(value);
    };
    const aborted = () => finish(reject, signal.reason);
    Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}
