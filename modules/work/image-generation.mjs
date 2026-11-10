import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { imageGenerationSettings, imageGenerationEndpoint } from '../../shared/image-generation.mjs';
import { WORK_ARTIFACT_LIMITS } from '../../shared/work-artifacts.mjs';
import { inspectAssetImage } from '../media/image-format.mjs';
import { decodeGeneratedImage } from './image-response.mjs';

export const IMAGE_GENERATION_CREDENTIAL = 'WECHAT_AGENT_IMAGE_GENERATION_API_KEY';
export function imageGenerationCredential(provider) {
  if (provider.id === 'default') return IMAGE_GENERATION_CREDENTIAL;
  const endpoint = createHash('sha256').update(imageGenerationEndpoint(provider.endpoint)).digest('hex').slice(0, 16).toUpperCase();
  return `${IMAGE_GENERATION_CREDENTIAL}_${provider.id.toUpperCase().replaceAll('-', '_')}_${endpoint}`;
}
const privateAddress = value => /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|::$|f[cd][\da-f]{2}:|fe[89ab][\da-f]:|::ffff:)/i.test(value);
async function readResponse(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new ChannelError('IMAGE_GENERATION_RESPONSE', '生图服务返回了空响应');
  const chunks = [];
  try {
    for (;;) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Each selected interface uses its own credential; one API call, without automatic fallback. */
export class ImageGenerationService {
  constructor(ctx, store, { fetchImpl = globalThis.fetch, lookupImpl = lookup } = {}) {
    this.ctx = ctx; this.store = store; this.fetchImpl = fetchImpl; this.lookupImpl = lookupImpl;
    this.credentialStates = new Map(); this.credentialRevisions = new Map();
  }
  settings() { return imageGenerationSettings(this.store.config.section('imageGeneration') ?? {}); }
  status() {
    const settings = this.settings(), provider = settings.providers.find(item => item.id === settings.defaultProviderId);
    return { ...settings, providers: settings.providers.map(item => ({ ...item, credentialConfigured: !!this.credentialStates.get(imageGenerationCredential(item)) })),
      credentialStore: !!this.ctx?.credentials?.set, credentialConfigured: !!provider && !!this.credentialStates.get(imageGenerationCredential(provider)),
      // Preserve the selected-interface summary for older status readers, never in config.yaml.
      endpoint: provider?.endpoint ?? '', model: provider?.defaultModel ?? '', size: provider?.size ?? '1024x1024',
      quality: provider?.quality ?? '', responseFormat: provider?.responseFormat ?? 'auto', timeoutSeconds: provider?.timeoutSeconds ?? 180 };
  }
  catalog() {
    const { enabled, defaultProviderId, providers } = this.settings();
    return { enabled, defaultProviderId, providers: providers.map(({ id, name, models, defaultModel, size }) => ({ providerId: id, name, models, defaultModel, size })) };
  }
  provider(settings, providerId) {
    const selected = settings.providers.find(provider => provider.id === (providerId ?? settings.defaultProviderId));
    if (!selected) throw new ChannelError('IMAGE_GENERATION_PROVIDER', '所选生图接口未配置，请从设置 → 生图 API 的接口列表中选择');
    return selected;
  }
  async refreshCredential() {
    await Promise.all(this.settings().providers.map(async provider => {
      const reference = imageGenerationCredential(provider);
      try { this.credentialStates.set(reference, !!(await this.ctx?.credentials?.describe?.(reference))?.configured); }
      catch { this.credentialStates.set(reference, false); }
    }));
  }
  async configureCredential(apiKey, signal, { providerId, endpoint } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 2000 || /[\u0000-\u0020\u007f]/.test(apiKey.trim()))
      throw new ChannelError('IMAGE_GENERATION_CREDENTIAL', '请填写有效的生图 API Key，最多 2000 字');
    if (!this.ctx?.credentials?.set) throw new ChannelError('IMAGE_GENERATION_CREDENTIAL', 'DSH 凭据服务尚未就绪，生图密钥未保存');
    signal?.throwIfAborted(); this.store.config.assertCurrent();
    const provider = this.provider(this.settings(), providerId), reference = imageGenerationCredential(provider);
    if (!provider.endpoint) throw new ChannelError('IMAGE_GENERATION_CREDENTIAL', '请先保存该生图接口的地址，再单独保存密钥');
    if (endpoint !== undefined && imageGenerationEndpoint(endpoint) !== provider.endpoint)
      throw new ChannelError('IMAGE_GENERATION_CHANGED', '生图接口地址已变化，请重新核对接口后保存密钥');
    try { await this.ctx.credentials.set(reference, apiKey.trim()); }
    catch { throw new ChannelError('IMAGE_GENERATION_CREDENTIAL', 'DSH 未能保存生图密钥，请检查凭据服务'); }
    this.credentialRevisions.set(reference, (this.credentialRevisions.get(reference) ?? 0) + 1);
    signal?.throwIfAborted(); this.store.config.assertCurrent();
    const currentProvider = this.settings().providers.find(item => item.id === provider.id);
    if (!currentProvider || currentProvider.endpoint !== provider.endpoint)
      throw new ChannelError('IMAGE_GENERATION_CHANGED', '生图接口已变化，刚保存的密钥未应用到新接口；请重新核对设置');
    await this.refreshCredential();
  }
  async generate({ prompt, size, providerId, model }, signal, assertAllowed = () => {}) {
    const settings = this.settings();
    if (!settings.enabled) throw new ChannelError('IMAGE_GENERATION_DISABLED', '尚未启用生图 API，请在设置 → 生图 API 填写兼容地址、模型和密钥');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw new ChannelError('IMAGE_GENERATION_PROMPT', '生图要求应为 1–12000 字');
    const provider = this.provider(settings, providerId), selectedModel = model ?? provider.defaultModel;
    if (typeof selectedModel !== 'string' || !provider.models.includes(selectedModel))
      throw new ChannelError('IMAGE_GENERATION_MODEL', '所选接口未配置这个生图模型，请从该接口的模型列表中选择');
    if (size !== undefined) imageGenerationSettings({ enabled: settings.enabled, defaultProviderId: provider.id, providers: [{ ...provider, size }] });
    assertAllowed(); signal.throwIfAborted(); this.store.config.assertCurrent();
    const reference = imageGenerationCredential(provider), credentialRevision = this.credentialRevisions.get(reference) ?? 0;
    let apiKey;
    try { apiKey = (await this.ctx?.credentials?.resolve?.(reference))?.value; }
    catch { throw new ChannelError('IMAGE_GENERATION_CREDENTIAL', 'DSH 无法读取生图密钥，请检查凭据服务'); }
    this.credentialStates.set(reference, !!apiKey);
    if (!apiKey) throw new ChannelError('IMAGE_GENERATION_CREDENTIAL', '尚未保存生图 API Key，请在设置 → 生图 API 单独保存密钥');
    const timeout = AbortSignal.timeout(provider.timeoutSeconds * 1000), combined = AbortSignal.any([signal, timeout]);
    const selectedSize = size ?? provider.size;
    let responseSummary = {};
    const current = () => {
      assertAllowed(); combined.throwIfAborted(); this.store.config.assertCurrent();
      if (JSON.stringify(this.settings()) !== JSON.stringify(settings)) throw new ChannelError('IMAGE_GENERATION_CHANGED', '生图配置已变化，本次旧结果未保存或回传');
      if ((this.credentialRevisions.get(reference) ?? 0) !== credentialRevision) throw new ChannelError('IMAGE_GENERATION_CHANGED', '生图密钥已变化，本次旧结果未保存或回传');
    };
    try {
      current();
      const body = { model: selectedModel, prompt: prompt.trim(), n: 1,
        ...(selectedSize ? { size: selectedSize } : {}), ...(provider.quality ? { quality: provider.quality } : {}),
        ...(provider.responseFormat !== 'auto' ? { response_format: provider.responseFormat } : {}) };
      const response = await this.fetchImpl(provider.endpoint, { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body) });
      responseSummary = { httpStatus: response.status };
      if (!response.ok) {
        await response.body?.cancel();
        throw new ChannelError('IMAGE_GENERATION_HTTP', response.status === 401 || response.status === 403 ? '生图 API 拒绝认证，请检查密钥及该模型的权限' : response.status === 429 ? '生图 API 限流或额度不足，本次未自动重复请求' : `生图 API 返回 HTTP ${response.status}，请检查接口和模型配置`);
      }
      let json;
      try { json = JSON.parse((await readResponse(response, combined)).toString('utf8')); }
      catch (error) { if (error instanceof ChannelError || combined.aborted) throw error; throw new ChannelError('IMAGE_GENERATION_RESPONSE', '生图 API 没有返回兼容的 JSON 结果'); }
      current();
      const data = json?.data?.[0]; let bytes;
      const base64Present = typeof data?.b64_json === 'string' && !!data.b64_json.trim();
      const urlPresent = typeof data?.url === 'string' && !!data.url.trim();
      responseSummary = { ...responseSummary, dataItems: Array.isArray(json?.data) ? json.data.length : 0,
        base64Characters: typeof data?.b64_json === 'string' ? data.b64_json.length : 0, urlPresent };
      if (json?.error) {
        const code = json.error?.code;
        const publicCode = typeof code === 'string' && !code.includes(apiKey) && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(code) ? code : undefined;
        responseSummary.upstreamError = true;
        if (publicCode) responseSummary.upstreamErrorCode = publicCode;
        throw new ChannelError('IMAGE_GENERATION_UPSTREAM', '生图 API 返回接口错误' + (publicCode ? `（${publicCode}）` : '') + '，未获得图片；本次未自动重复请求');
      }
      if (base64Present) {
        bytes = decodeGeneratedImage(data.b64_json);
      } else if (urlPresent && /^data:/i.test(data.url.trim())) {
        bytes = decodeGeneratedImage(data.url);
      } else if (urlPresent) {
        let url;
        try { url = new URL(data.url); } catch { throw new ChannelError('IMAGE_GENERATION_RESPONSE', '生图 API 返回了无效的图片地址'); }
        const sameOrigin = url.origin === new URL(provider.endpoint).origin;
        if (url.username || url.password || url.href.length > 8192 || url.hash || !(url.protocol === 'https:' || sameOrigin && url.protocol === 'http:'))
          throw new ChannelError('IMAGE_GENERATION_RESPONSE', '生图 API 返回的图片地址不受支持');
        if (!sameOrigin) {
          const addresses = await this.lookupImpl(url.hostname, { all: true }); current();
          if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new ChannelError('IMAGE_GENERATION_RESPONSE', '生图 API 返回了本机或内网资源地址，未读取该资源');
        }
        // A provider-supplied download URL never receives the API credential.
        const download = await this.fetchImpl(url.href, { redirect: 'error', signal: combined });
        if (!download.ok) { await download.body?.cancel(); throw new ChannelError('IMAGE_GENERATION_DOWNLOAD', '图片已生成，但下载失败或链接已过期，尚未回传微信'); }
        bytes = await readResponse(download, combined);
      } else throw new ChannelError('IMAGE_GENERATION_EMPTY', '生图 API 没有返回图片数据（base64 和图片链接均为空），未保存图片；本次未自动重复请求');
      current();
      let info;
      try { info = inspectAssetImage(bytes, { maxBytes: bytes.length }); } catch { throw new ChannelError('IMAGE_GENERATION_RESPONSE', '生图 API 返回的内容不是有效图片'); }
      if (!['image/png', 'image/jpeg'].includes(info.mediaType)) throw new ChannelError('IMAGE_GENERATION_FORMAT', '请将生图 API 的输出格式设为 PNG 或 JPEG，以便原生回传微信');
      return { bytes, mediaType: info.mediaType, extension: info.mediaType === 'image/png' ? '.png' : '.jpg', providerId: provider.id, providerName: provider.name, model: selectedModel,
        sendAs: bytes.length > WORK_ARTIFACT_LIMITS.imageBytes ? 'file' : 'image' };
    } catch (error) {
      signal.throwIfAborted(); assertAllowed();
      const failure = timeout.aborted ? new ChannelError('IMAGE_GENERATION_TIMEOUT', '生图 API 请求或图片下载超时，未自动重复请求；请查询任务状态')
        : error instanceof ChannelError ? error
        : new ChannelError('IMAGE_GENERATION_NETWORK', '生图 API 请求或图片下载失败，请检查服务和网络；本次未自动重复请求');
      const reported = new ChannelError(failure.code, `${provider.name} / ${selectedModel}：${failure.message}`);
      reported.imageGeneration = { providerId: provider.id, providerName: provider.name, endpoint: provider.endpoint, model: selectedModel,
        size: selectedSize, responseFormat: provider.responseFormat, response: responseSummary };
      throw reported;
    }
  }
}
