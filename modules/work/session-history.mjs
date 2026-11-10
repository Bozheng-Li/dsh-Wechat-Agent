/** Releasing an Agent removes its live row in DSH rc.5. Publish the stored
 * summary again so the history remains visible without keeping a loop alive. */
export async function publishWorkSessionHistory(ctx, sessionId) {
  let controller;
  try { controller = ctx.get?.('sessionController') ?? ctx.sessionController; } catch {}
  if (typeof controller?.list !== 'function' || typeof ctx.emit !== 'function')
    return { state: 'stored', message: '会话记录由 DSH 保存，可刷新 DSH 会话列表查看' };
  try {
    const { items } = await controller.list({}, AbortSignal.timeout(10000));
    const summary = items.find(item => item.sessionId === sessionId);
    if (!summary) return { state: 'unavailable', message: '未能核对 DSH 历史会话，请保留任务记录并检查 DSH 会话存储' };
    ctx.emit('api-session/added', summary);
    return { state: 'visible' };
  } catch {
    return { state: 'stored', message: 'DSH 历史列表暂未刷新，任务记录保留，可在 DSH 刷新后查看' };
  }
}
