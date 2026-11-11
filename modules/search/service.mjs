import { ChannelError, DEFAULT_TAVILY_URL, searchBaseURL } from "../../shared/contracts.mjs";

import { searchWithFallback } from './fallback.mjs';

export const SEARCH_CREDENTIALS = Object.freeze({
  dsh: 'WECHAT_AGENT_DEEPSEEK_SEARCH_API_KEY',
  tavily: 'WECHAT_AGENT_TAVILY_API_KEY',
});
export { DEFAULT_TAVILY_URL, searchBaseURL };
const MAX_RESPONSE_BYTES = 1024 * 1024;
function boundedImages(values) {
  return (Array.isArray(values) ? values : []).flatMap(value => {
    try { const url = new URL(typeof value === 'string' ? value : value?.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) return [];
      return [{ url: url.href, description: String(value?.description || '').slice(0, 1000) }];
    } catch { return []; }
  }).slice(0, 8);
}

function boundedSources(values, limit) {
  if (!Array.isArray(values))
    throw new ChannelError('WEB_SEARCH_INVALID_RESULT', '搜索服务没有返回有效的结果列表，请核对服务接口。');
  const seen = new Set(),
    sources = [];
  for (const value of values) {
    let url;
    try {
      url = new URL(value?.url);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 4096 ||
      seen.has(url.href)
    )
      continue;
    seen.add(url.href);
    sources.push({
      title: String(value.title || '').slice(0, 300),
      url: url.href,
      snippet: String(value.content || value.snippet || '').slice(0, 1500),
    });
    if (sources.length === limit) break;
  }
  return sources;
}

async function responseJSON(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new ChannelError('WEB_SEARCH_RESPONSE_TOO_LARGE', '搜索服务的返回内容过大，请调整查询后重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ChannelError('WEB_SEARCH_INVALID_RESULT', '搜索服务返回了空响应，请稍后重试。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new ChannelError('WEB_SEARCH_RESPONSE_TOO_LARGE', '搜索服务的返回内容过大，请调整查询后重试。');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ChannelError('WEB_SEARCH_INVALID_RESULT', '搜索服务返回的内容无法解析，请核对服务接口。');
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}

/** Independent search credentials; a chat credential is never copied to a new endpoint. */
export class SearchService {
  constructor(ctx, { fetchImpl = globalThis.fetch, loadDeepSeek, attemptTimeoutMs = 45000 } = {}) {
    this.ctx = ctx;
    this.fetchImpl = fetchImpl;
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.loadDeepSeek =
      loadDeepSeek ||
      (() => {
        // rc.5 exposes its registered native provider on the web service. Reuse
        // that implementation with our dedicated credential, without changing
        // the host's provider selection, endpoint or conversation credentials.
        const provider = ctx?.web?.searchProviders?.get('deepseek-official');
        if (!provider || typeof provider.resolveOptions !== 'function')
          throw new Error('Native search provider is missing');
        return {
          DeepSeekSearchProvider: provider.constructor,
          DEEPSEEK_DEFAULT_BASE_URL: 'https://api.deepseek.com/anthropic/v1',
          DEEPSEEK_DEFAULT_MODEL: 'deepseek-v4-flash',
          DEEPSEEK_DEFAULT_API_VERSION: '2023-06-01',
          DEEPSEEK_DEFAULT_MAX_TOKENS: 4096,
        };
      });
    this.credentials = { dsh: false, tavily: false };
  }
  async refreshCredentials() {
    for (const [provider, ref] of Object.entries(SEARCH_CREDENTIALS)) {
      try {
        this.credentials[provider] = !!(await this.ctx?.credentials?.describe?.(ref))?.configured;
      } catch {
        this.credentials[provider] = false;
      }
    }
    return { ...this.credentials };
  }
  async configureCredential(provider, apiKey, signal) {
    if (
      !Object.hasOwn(SEARCH_CREDENTIALS, provider) ||
      typeof apiKey !== 'string' ||
      !apiKey.trim() ||
      apiKey.length > 512 ||
      /[\u0000-\u0020\u007f]/.test(apiKey.trim())
    )
      throw new ChannelError('INVALID_SEARCH_CREDENTIAL', '请选择搜索服务并填写有效的 API Key，最多 512 字。');
    if (!this.ctx?.credentials?.set)
      throw new ChannelError('WEB_SEARCH_CREDENTIAL_STORE_MISSING', 'DSH 凭据服务尚未就绪，搜索密钥未保存。');
    signal?.throwIfAborted();
    try {
      await this.ctx.credentials.set(SEARCH_CREDENTIALS[provider], apiKey.trim());
    } catch {
      throw new ChannelError('WEB_SEARCH_CREDENTIAL_SAVE_FAILED', 'DSH 未能保存搜索密钥，请核对当前凭据状态后重试。');
    }
    await this.refreshCredentials();
  }
  status() {
    return { credentialStore: !!this.ctx?.credentials?.set, credentials: { ...this.credentials } };
  }
  forConfig(config = {}, { assertAllowed = () => {} } = {}) {
    const selected = config.searchProvider ?? 'tavily',
      baseURL = config.tavilyBaseURL ?? DEFAULT_TAVILY_URL;
    return { search: (request, signal) => searchWithFallback({ primary: selected, request, signal, timeoutMs: this.attemptTimeoutMs, assertAllowed,
      search: (provider, query, abort, options) => this.search(provider, baseURL, query, abort, options) }) };
  }
  async search(provider, baseURL, request, signal, { requireCredential = false } = {}) {
    signal?.throwIfAborted();
    const ref = SEARCH_CREDENTIALS[provider];
    if (!ref) throw new ChannelError('INVALID_SEARCH_CONFIG', '请选择 DeepSeek 原生搜索或 Tavily。');
    let apiKey;
    try {
      apiKey = (await this.ctx?.credentials?.resolve?.(ref))?.value;
    } catch {
      throw new ChannelError('WEB_SEARCH_CREDENTIAL_READ_FAILED', 'DSH 未能读取搜索凭据，请检查凭据服务。');
    }
    signal?.throwIfAborted();
    this.credentials[provider] = !!apiKey;
    if (provider === 'dsh') {
      // Older installations keep the existing DSH search provider until a
      // dedicated DeepSeek search credential has been explicitly saved.
      if (!apiKey) {
        if (requireCredential || !this.ctx?.web?.search)
          throw new ChannelError(
            'WEB_PROVIDER_CREDENTIAL_MISSING',
            'DeepSeek 搜索尚未配置密钥；请在模型设置中保存搜索 API Key。'
          );
        const result = await this.ctx.web.search(request, signal);
        signal?.throwIfAborted();
        return { ...result, sources: boundedSources(result.sources, request.maxResults || 5),
          ...(request.includeImages ? { images: boundedImages(result.images) } : {}) };
      }
      let native;
      try {
        native = await this.loadDeepSeek();
      } catch {
        throw new ChannelError(
          'WEB_SEARCH_NATIVE_MISSING',
          '当前 DSH 未提供 DeepSeek 原生搜索组件，请使用兼容版本或选择 Tavily。'
        );
      }
      signal?.throwIfAborted();
      const nativeProvider = new native.DeepSeekSearchProvider(() => ({
        apiKey,
        baseURL: native.DEEPSEEK_DEFAULT_BASE_URL,
        model: native.DEEPSEEK_DEFAULT_MODEL,
        apiVersion: native.DEEPSEEK_DEFAULT_API_VERSION,
        maxTokens: native.DEEPSEEK_DEFAULT_MAX_TOKENS,
        maxUses: 5,
        recordRequest: (record) =>
          this.ctx.get?.('agents')?.currentInitiator?.()?.session.append('web/deepseek-search-llm-request', record),
      }));
      const result = await nativeProvider.search(request, signal);
      return { ...result, sources: boundedSources(result.sources, request.maxResults || 5) };
    }
    if (!apiKey)
      throw new ChannelError(
        'WEB_PROVIDER_CREDENTIAL_MISSING',
        'Tavily 搜索尚未配置密钥；请在模型设置中保存 Tavily API Key。'
      );
    const endpoint = searchBaseURL(baseURL) + '/search';
    const combined = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: request.query,
          search_depth: 'basic',
          max_results: Math.min(request.maxResults || 5, 5),
          include_answer: false,
          include_raw_content: false,
          ...(request.includeImages ? { include_images: true, include_image_descriptions: true } : {}),
        }),
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new ChannelError(
        combined.aborted ? 'WEB_SEARCH_TIMEOUT' : 'WEB_SEARCH_FAILED',
        combined.aborted ? 'Tavily 搜索超时，请稍后重试。' : 'Tavily 搜索请求未完成，请检查服务地址与连接。'
      );
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {}
      if ([401, 403].includes(response.status))
        throw new ChannelError(
          'WEB_SEARCH_AUTH_FAILED',
          `Tavily 搜索接口返回 HTTP ${response.status}，请检查 Tavily API Key 与访问权限。`
        );
      if (response.status === 429)
        throw new ChannelError(
          'WEB_SEARCH_RATE_LIMITED',
          'Tavily 搜索接口返回 HTTP 429，本次查询受到限流，请稍后重试。'
        );
      throw new ChannelError(
        'WEB_SEARCH_SERVICE_FAILED',
        `Tavily 搜索接口返回 HTTP ${response.status}，本次未取得搜索结果。`
      );
    }
    const result = await responseJSON(response, combined);
    if (!Array.isArray(result.results))
      throw new ChannelError('WEB_SEARCH_INVALID_RESULT', 'Tavily 接口没有返回有效的搜索结果，请核对服务地址。');
    return {
      sources: boundedSources(result.results, request.maxResults || 5),
      ...(request.includeImages ? { images: boundedImages(result.images) } : {}),
      truncated: result.results.length > (request.maxResults || 5),
    };
  }
}
