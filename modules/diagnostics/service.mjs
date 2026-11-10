import { promptText } from '../../prompts/loader.mjs';
import { publicError } from "../../shared/contracts.mjs";
import { digest, fail } from "../workbench/store.mjs";
import { internal } from "../workbench/helpers.mjs";

export function runtimeFingerprint(workbench, accountId) {
  const state = workbench.channel.transport.status();
  let selected = null;
  try {
    const model = workbench.runner.selection?.();
    selected = model ? { provider: model.provider, model: model.model } : null;
  } catch {}
  return digest([
    accountId,
    state.account?.id,
    state.online,
    state.good,
    state.runtimeReady,
    state.imageUploadReady,
    state.state,
    selected,
    workbench.store.modelChoice(),
    workbench.store.modelConfig(),
    workbench.runner.search?.status?.(),
  ]);
}

export function readDiagnostics(workbench, accountId) {
  const saved = workbench.disk.load(accountId).diagnostics;
  const checks = saved?.checks?.filter((check) => ['wechat', 'model', 'search', 'image'].includes(check.id)) || [];
  return saved
    ? {
        ...saved,
        checks,
        stale:
          checks.length !== saved.checks?.length ||
          saved.fingerprint !== workbench.fingerprint(accountId) ||
          workbench.now() - saved.finishedAt > 300000,
      }
    : { checks: [], stale: true };
}

export async function runDiagnostics(workbench, accountId, signal) {
  const startedAt = workbench.now(),
    checks = [],
    fingerprint = workbench.fingerprint(accountId),
    config = workbench.store.modelConfig();
  const check = async (id, title, run) => {
    signal.throwIfAborted();
    workbench.current(accountId);
    const start = workbench.now();
    const action = { wechat: 'overview', model: 'model', search: 'model', image: 'recovery' }[id];
    try {
      const value = await run();
      checks.push({
        id,
        title,
        action,
        state: 'passed',
        ...value,
        durationMs: workbench.now() - start,
        checkedAt: workbench.now(),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      checks.push({
        id,
        title,
        action,
        state: 'failed',
        error: publicError(error, '检查未完成，请重新测试'),
        durationMs: workbench.now() - start,
        checkedAt: workbench.now(),
      });
    }
  };
  await check('wechat', '微信连接', async () => {
    const value = workbench.channel.transport.status();
    if (!value.online || !value.good) fail('WECHAT_OFFLINE', '微信当前离线；请先检查连接');
    return { detail: '当前账号在线，连接状态正常', action: 'overview' };
  });
  await check('model', '聊天模型', async () => {
    const result = await internal(
      workbench.runner,
      promptText('diagnostics/templates.json', 'instructions-1'),
      signal,
      promptText('diagnostics/templates.json', 'instructions-2')
    );
    if (result.text?.trim() !== 'OK')
      fail('MODEL_PROBE_RESPONSE', '模型返回了内容，但未遵循最小检查要求；请检查所选模型');
    return { detail: '所选模型实际返回 OK', action: 'model' };
  });
  if (!config.webSearch)
    checks.push({
      id: 'search',
      title: '联网搜索',
      state: 'disabled',
      checkedAt: workbench.now(),
      detail: '当前关闭，可在模型设置启用',
      action: 'model',
    });
  else
    await check('search', '联网搜索', async () => {
      const result = await workbench.runner.search
        .forConfig(config)
        .search({ query: 'arXiv official site', maxResults: 2 }, signal);
      if (!result.sources?.length) fail('SEARCH_NO_SOURCES', '搜索接口返回成功，但没有可引用来源');
      return {
        detail: `${config.searchProvider === 'tavily' ? 'Tavily' : 'DeepSeek'} 返回 ${result.sources.length} 条可引用来源`,
        action: 'model',
      };
    });
  await check('image', '图片发送条件', async () => {
    const status = workbench.channel.transport.status();
    if (!status.online) fail('WECHAT_OFFLINE', '微信离线，无法准备图片发送');
    if (status.imageUploadReady !== true)
      fail('IMAGE_PARAMETERS_UNVERIFIED', '图片发送条件尚未确认；请更新完整插件或检查登录参数交接');
    return {
      state: 'ready',
      detail: '本机组件与图片参数就绪；这不是实际投递成功证明',
      action: 'recovery',
      deliveryVerified: false,
    };
  });
  signal.throwIfAborted();
  workbench.current(accountId);
  if (fingerprint !== workbench.fingerprint(accountId))
    fail('DIAGNOSTICS_CHANGED', '检查期间连接、模型或搜索设置发生变化，请重新检查');
  const data = workbench.disk.load(accountId);
  data.diagnostics = { startedAt, finishedAt: workbench.now(), fingerprint, checks };
  workbench.disk.save(data);
  return workbench.diagnostics(accountId);
}
