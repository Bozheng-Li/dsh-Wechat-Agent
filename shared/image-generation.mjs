import { ChannelError } from './contracts.mjs';

export const IMAGE_GENERATION_MAX_TIMEOUT_SECONDS = 3600;

const legacyFields = ['enabled', 'endpoint', 'model', 'size', 'quality', 'responseFormat', 'timeoutSeconds'];
const providerFields = ['id', 'name', 'endpoint', 'models', 'defaultModel', 'size', 'quality', 'responseFormat', 'timeoutSeconds'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const invalid = message => { throw new ChannelError('IMAGE_GENERATION_CONFIG', message); };

export function imageGenerationEndpoint(value) {
  if (typeof value !== 'string') invalid('请填写有效的生图 API 地址');
  if (!value.trim()) return '';
  let url;
  try { url = new URL(value.trim()); } catch { throw new ChannelError('IMAGE_GENERATION_CONFIG', '请填写有效的生图 API 地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2000)
    throw new ChannelError('IMAGE_GENERATION_CONFIG', '生图 API 地址应为 HTTP／HTTPS 地址，不包含账号、密钥或查询参数');
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/images/generations') ? pathname : (pathname || '/v1') + '/images/generations';
  return url.href;
}

export function imageGenerationProvider(input) {
  if (!object(input) || Object.keys(input).some(key => !providerFields.includes(key)))
    invalid('生图接口配置格式不正确，密钥请单独保存到 DSH 凭据服务');
  const value = { name: '', endpoint: '', models: [], defaultModel: '', size: '1024x1024', quality: '', responseFormat: 'auto', timeoutSeconds: 180, ...input };
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(value.id) || !text(value.name, 80) || !value.name.trim())
    invalid('请填写接口名称；接口编号只能包含小写字母、数字和连字符，最多 48 字');
  if (!Array.isArray(value.models) || value.models.length > 40 || value.models.some(model => !text(model, 200) || !model.trim()))
    invalid('每个接口最多配置 40 个生图模型，模型名为 1–200 字');
  value.models = value.models.map(model => model.trim());
  if (new Set(value.models).size !== value.models.length) invalid('同一接口的生图模型名不能重复');
  if (!text(value.defaultModel, 200) || !text(value.quality, 80) || typeof value.size !== 'string' ||
      !/^(?:auto|\d{2,4}x\d{2,4})?$/.test(value.size) || !['auto', 'b64_json', 'url'].includes(value.responseFormat) ||
      !Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 10 || value.timeoutSeconds > IMAGE_GENERATION_MAX_TIMEOUT_SECONDS)
    invalid('请检查生图模型、尺寸、返回格式和超时（10–3600 秒）');
  value.endpoint = imageGenerationEndpoint(value.endpoint);
  value.name = value.name.trim(); value.defaultModel = value.defaultModel.trim(); value.quality = value.quality.trim();
  if (value.models.length && !value.defaultModel) value.defaultModel = value.models[0];
  if (value.defaultModel && !value.models.includes(value.defaultModel)) invalid('默认生图模型必须在该接口的模型列表中');
  return value;
}

/** Older single-interface YAML remains readable, including its dedicated credential reference. */
export function imageGenerationSettings(input = {}) {
  if (!object(input)) invalid('生图配置格式不正确，密钥请单独保存到 DSH 凭据服务');
  const multiple = 'providers' in input || 'defaultProviderId' in input;
  const fields = multiple ? ['enabled', 'defaultProviderId', 'providers'] : legacyFields;
  if (Object.keys(input).some(key => !fields.includes(key))) invalid('生图配置格式不正确，密钥请单独保存到 DSH 凭据服务');
  const enabled = 'enabled' in input ? input.enabled : false;
  if (typeof enabled !== 'boolean') invalid('生图启用状态应为 true 或 false');
  let providers, defaultProviderId;
  if (multiple) {
    if (!Array.isArray(input.providers) || input.providers.length > 20) invalid('最多配置 20 家生图接口');
    providers = input.providers.map(imageGenerationProvider);
    defaultProviderId = input.defaultProviderId === undefined ? providers[0]?.id ?? '' : input.defaultProviderId;
  } else {
    const { enabled: ignored, model = '', ...legacy } = input;
    if (!text(model, 200)) invalid('生图模型名为 1–200 字');
    providers = Object.keys(legacy).length || model || enabled ? [imageGenerationProvider({
      id: 'default', name: '默认接口', ...legacy, models: model.trim() ? [model.trim()] : [], defaultModel: model.trim(),
    })] : [];
    defaultProviderId = providers[0]?.id ?? '';
  }
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) invalid('生图接口编号不能重复');
  if (typeof defaultProviderId !== 'string' || (providers.length ? !providers.some(provider => provider.id === defaultProviderId) : defaultProviderId !== ''))
    invalid('请选择已配置的默认生图接口');
  if (enabled && (!providers.length || providers.some(provider => !provider.endpoint || !provider.defaultModel)))
    invalid('启用生图前请为每家接口填写 API 地址、模型列表和默认模型');
  return { enabled, defaultProviderId, providers };
}
