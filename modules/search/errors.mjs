import { ChannelError } from '../../shared/contracts.mjs';

export function searchFailure(error) {
  if (error instanceof ChannelError) return error;
  const code = error?.code;
  const message = String(error?.message || '');
  const status = Number(/HTTP\s+(\d{3})\b/i.exec(message)?.[1]);
  const unavailable = {
    WEB_PROVIDER_CREDENTIAL_MISSING:
      'DSH 搜索服务缺少可用凭据；请在 DSH 中配置搜索服务的 API Key。聊天模型与搜索认证分别配置，微信扫码不能修复此问题。',
    WEB_PROVIDER_CONFIGURED_MISSING: 'DSH 选择的搜索服务尚未加载；请在 DSH 搜索设置中选择已安装的服务。',
    WEB_PROVIDER_CONFIGURED_UNAVAILABLE: 'DSH 选择的搜索服务当前不可用；请检查该搜索服务的配置。',
    WEB_PROVIDER_UNAVAILABLE: 'DSH 没有可用的搜索服务；请先在 DSH 中配置搜索服务。',
    WEB_PROVIDER_AMBIGUOUS: 'DSH 存在多个可用搜索服务；请在 DSH 搜索设置中明确选择一个。',
    WEB_ABORTED: 'DSH 搜索已取消，未取得本次查询结果。',
  };
  if (unavailable[code]) return new ChannelError(code, unavailable[code]);
  if (status === 401 && /rejected the account sign-in/i.test(message))
    return new ChannelError(
      'WEB_SEARCH_AUTH_FAILED',
      'DSH 搜索接口返回 HTTP 401，DeepSeek 账号登录被拒绝；请在 DSH 中重新登录 DeepSeek 账号，微信扫码不能修复此问题。'
    );
  if (status === 401 || status === 403)
    return new ChannelError(
      'WEB_SEARCH_AUTH_FAILED',
      `DSH 搜索接口返回 HTTP ${status}，搜索凭据或访问权限被拒绝；请在 DSH 中检查搜索服务的 API Key 与权限。聊天模型与搜索认证分别配置，微信扫码不能修复此问题。`
    );
  if (status === 402)
    return new ChannelError('WEB_SEARCH_QUOTA', 'DSH 搜索接口返回 HTTP 402，请在对应搜索服务中检查额度。');
  if (status === 429)
    return new ChannelError('WEB_SEARCH_RATE_LIMITED', 'DSH 搜索接口返回 HTTP 429，本次查询受到限流，请稍后重试。');
  if (status >= 500 && status <= 599)
    return new ChannelError(
      'WEB_SEARCH_SERVICE_FAILED',
      `DSH 搜索接口返回 HTTP ${status}，搜索服务暂时异常，请稍后重试。`
    );
  if (/no web_search_tool_result/i.test(message))
    return new ChannelError(
      'WEB_SEARCH_UNSUPPORTED',
      'DSH 搜索接口没有返回可引用的联网搜索结果；请核对搜索接口和模型是否支持原生搜索。'
    );
  return new ChannelError(
    'WEB_SEARCH_FAILED',
    '联网搜索未完成，请检查 DSH 的搜索服务配置与连接；当前不能声称查到了最新资料。'
  );
}
