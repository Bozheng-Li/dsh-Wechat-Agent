import { useEffect, useRef, useState } from 'react';
import { imageGenerationSettings, imageGenerationEndpoint, imageGenerationProvider } from '../../../shared/image-generation.mjs';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';
import { Button } from '../../components/button.jsx';
import { PageHead, Back } from '../../components/page-ui.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';
import { Glyph } from '../../components/glyph.jsx';

const providerFields = ['id', 'name', 'endpoint', 'models', 'defaultModel', 'size', 'quality', 'responseFormat', 'timeoutSeconds'];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const settingsOf = value => imageGenerationSettings(value?.providers ? {
  ...pick(value, ['enabled', 'defaultProviderId']), providers: value.providers.map(provider => pick(provider, providerFields)),
} : pick(value, ['enabled', 'endpoint', 'model', 'size', 'quality', 'responseFormat', 'timeoutSeconds']));
export function ImageGenerationSettings({ status, blocked, onAction, onBack, backLabel }) {
  const saved = settingsOf(status.imageGeneration), signature = JSON.stringify(saved), previous = useRef(signature);
  const [draft, setDraft] = useState(saved), [selectedId, setSelectedId] = useState(saved.defaultProviderId), [modelInputs, setModelInputs] = useState({});
  const [key, setKey] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { const old = previous.current; setDraft(value => JSON.stringify(value) === old ? saved : value); previous.current = signature; }, [signature]);
  const dirty = JSON.stringify(draft) !== signature;
  const provider = draft.providers.find(item => item.id === selectedId) ?? draft.providers[0];
  const savedProvider = saved.providers.find(item => item.id === provider?.id);
  const credentialConfigured = Array.isArray(status.imageGeneration?.providers)
    ? !!status.imageGeneration.providers.find(item => item.id === provider?.id)?.credentialConfigured
    : !!savedProvider && !!status.imageGeneration?.credentialConfigured;
  useEffect(() => { setKey(''); }, [provider?.id, savedProvider?.endpoint]);
  let invalid = '', endpoint = '';
  try { imageGenerationSettings(draft); endpoint = provider ? imageGenerationEndpoint(provider.endpoint) : ''; } catch (error) { invalid = error.message; }
  const updateProvider = patch => setDraft(value => ({ ...value, providers: value.providers.map(item => item.id === provider.id ? { ...item, ...patch } : item) }));
  const updateModels = value => {
    setModelInputs(inputs => ({ ...inputs, [provider.id]: value }));
    const models = value.split(/[\n,，]/).map(model => model.trim()).filter(Boolean);
    updateProvider({ models, defaultModel: models.includes(provider.defaultModel) ? provider.defaultModel : models[0] ?? '' });
  };
  const addProvider = () => {
    let number = 1; while (draft.providers.some(item => item.id === 'api-' + number)) number++;
    const added = imageGenerationProvider({ id: 'api-' + number, name: '新接口 ' + number });
    setDraft({ ...draft, providers: [...draft.providers, added], defaultProviderId: draft.defaultProviderId || added.id });
    setSelectedId(added.id); setNotice('');
  };
  const removeProvider = () => {
    const providers = draft.providers.filter(item => item.id !== provider.id);
    setDraft({ ...draft, providers, enabled: providers.length ? draft.enabled : false, defaultProviderId: providers.some(item => item.id === draft.defaultProviderId) ? draft.defaultProviderId : providers[0]?.id ?? '' });
    setSelectedId(providers[0]?.id ?? ''); setNotice('');
  };
  const reset = () => { setDraft(saved); setModelInputs({}); setSelectedId(saved.defaultProviderId); };
  const submit = async () => {
    setNotice(''); const settings = imageGenerationSettings({ ...draft, providers: draft.providers.map(provider => preserveTimeValues('provider', provider, saved.providers.find(row => row.id === provider.id))) });
    if (await onAction('imageGeneration.configure', { settings, preserveTimeSettings: true })) { setDraft(settings); setModelInputs({}); setNotice('接口与模型设置已保存；生成结果通过工作任务回传。'); }
  };
  const keyDisabled = blocked || dirty || !savedProvider?.endpoint || !status.imageGeneration?.credentialStore;
  const saveKey = async () => {
    if (keyDisabled) return;
    setNotice('');
    if (await onAction('imageGeneration.credential', { providerId: savedProvider.id, endpoint: savedProvider.endpoint, apiKey: key })) {
      setKey(''); setNotice(`${savedProvider.name} 的生图密钥已保存到 DSH 凭据服务。`);
    }
  };
  return <>
    <Back label={backLabel || '返回设置'} onClick={onBack} />
    <PageHead icon="image" title="图片生成" description="管理生图接口与模型，生成结果通过工作任务回传微信。" />
    {notice && <div className="wa-alert is-success" role="status">{notice}</div>}
    <div className="wa-settings-stack wa-image-generation-settings">
    <form className="wa-settings-document wa-settings-form-sections" data-testid="image-generation-settings" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="wa-card-heading">
        <div><h2>接口与模型</h2><p className="wa-muted">每家接口独立保存模型和生成参数。</p></div>
        <label className="wa-check-row"><input type="checkbox" role="switch" aria-label="启用生图 API" checked={draft.enabled} disabled={blocked} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span>启用</span></label>
      </div>
      <div className="wa-image-provider-layout">
      <aside className="wa-image-switchboard" aria-label="生图接口选择">
        <Field label="正在编辑的接口" id="wa-image-provider"><select className="wa-select" id="wa-image-provider" value={provider?.id ?? ''} disabled={blocked || !provider} onChange={event => setSelectedId(event.target.value)}>{!provider && <option value="">暂无接口</option>}{draft.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="默认生图接口" id="wa-image-default-provider" help="微信没有指定接口时使用这一家。"><select className="wa-select" id="wa-image-default-provider" value={draft.defaultProviderId} disabled={blocked || !provider} onChange={event => setDraft({ ...draft, defaultProviderId: event.target.value })}>{!provider && <option value="">暂无接口</option>}{draft.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <div className="wa-row"><Button primary={!provider} icon="plus" data-testid="image-provider-add" disabled={blocked || draft.providers.length >= 20} onClick={addProvider}>添加接口</Button>{provider && <Button quiet danger data-testid="image-provider-remove" disabled={blocked} onClick={removeProvider}>移除当前接口</Button>}</div>
      </aside>
      <div className="wa-image-provider-editor">
      {provider ? <>
      <section className="wa-settings-form-section">
      <h3>接口信息</h3>
      <Field label="接口名称" id="wa-image-provider-name"><input className="wa-input" id="wa-image-provider-name" value={provider.name} disabled={blocked} maxLength={80} onChange={event => updateProvider({ name: event.target.value })} /></Field>
      <Field label="接口地址" id="wa-image-endpoint" help="可填写服务的基础地址（如 https://example.com/v1），或完整的 /images/generations 地址。">
        <input className="wa-input" id="wa-image-endpoint" value={provider.endpoint} disabled={blocked} maxLength={2000} placeholder="https://example.com/v1" onChange={event => updateProvider({ endpoint: event.target.value })} />
      </Field>
      {endpoint && endpoint !== provider.endpoint && <p className="wa-help">请求地址：{endpoint}</p>}
      </section>
      <section className="wa-settings-form-section">
      <h3>模型与默认参数</h3>
      <Field label="模型列表" id="wa-image-models" help="每行一个生图模型名，也可用逗号分隔。"><textarea className="wa-textarea" id="wa-image-models" rows={3} value={modelInputs[provider.id] ?? provider.models.join('\n')} disabled={blocked} maxLength={8040} onChange={event => updateModels(event.target.value)} /></Field>
      <Field label="默认模型" id="wa-image-model" help="微信可点名使用列表里的其他模型。"><select className="wa-select" id="wa-image-model" value={provider.defaultModel} disabled={blocked || !provider.models.length} onChange={event => updateProvider({ defaultModel: event.target.value })}>{!provider.models.length && <option value="">请先添加生图模型</option>}{[...new Set(provider.models)].map(model => <option key={model} value={model}>{model}</option>)}</select></Field>
      <div className="wa-form-grid">
        <Field label="默认尺寸" id="wa-image-size" help="例如 1024x1024；留空由服务决定。"><input className="wa-input" id="wa-image-size" value={provider.size} disabled={blocked} onChange={event => updateProvider({ size: event.target.value })} /></Field>
        <Field label="返回格式" id="wa-image-format"><select className="wa-select" id="wa-image-format" value={provider.responseFormat} disabled={blocked} onChange={event => updateProvider({ responseFormat: event.target.value })}><option value="auto">服务默认（自动识别）</option><option value="b64_json">Base64 图片</option><option value="url">图片下载地址</option></select></Field>
      </div>
      <details className="wa-subsection"><summary>高级设置</summary><div className="wa-form-grid"><Field label="质量参数" id="wa-image-quality" help="按服务文档填写，留空不发送此参数。"><input className="wa-input" id="wa-image-quality" value={provider.quality} disabled={blocked} maxLength={80} onChange={event => updateProvider({ quality: event.target.value })} /></Field></div><p className="wa-help">调用超时统一在“设置 → 时间设置”中修改。支持兼容接口的 Base64 图片或下载地址，图片格式为 PNG/JPEG。调用失败不自动重试生图，朋友圈会回退为纯文字。</p></details>
      </section>
      </> : <div className="wa-image-provider-empty"><Glyph name="image" /><h3>还没有生图接口</h3><p>添加接口后，在这里管理地址、模型与生成参数。</p></div>}
      </div>
      </div>
      {invalid && <div className="wa-alert is-error" role="alert">{invalid}</div>}
      <FormActions dirty={dirty} disabled={blocked} invalid={!!invalid} onReset={reset} label="保存生图设置" />
    </form>
    <form className="wa-settings-block wa-image-credentials" onSubmit={event => { event.preventDefault(); void saveKey(); }}>
      <div className="wa-card-heading"><div><h2>接口凭据</h2><p className="wa-muted">当前接口的密钥单独保存到 DSH 凭据服务。</p></div><span className={'wa-badge' + (credentialConfigured ? ' is-success' : '')}>{!savedProvider?.endpoint ? '待保存接口' : credentialConfigured ? '已配置' : '未配置'}</span></div>
      <Field label={provider ? `${provider.name} · API Key` : '生图 API Key'} id="wa-image-key" help={!status.imageGeneration?.credentialStore ? '当前 DSH 未提供凭据服务，暂时无法保存密钥。' : dirty || !savedProvider?.endpoint ? '先保存接口设置，再为当前接口单独保存密钥。' : credentialConfigured ? '填写新密钥可替换当前密钥。' : '当前接口尚未保存密钥，不写入 config.yaml。'}><input className="wa-input" id="wa-image-key" type="password" autoComplete="new-password" value={key} disabled={keyDisabled} maxLength={2000} onChange={event => setKey(event.target.value)} /></Field>
      <div className="wa-form-actions"><span className="wa-help">切换接口时使用各自的密钥。</span><Button type="submit" primary disabled={keyDisabled || !key.trim()}>保存生图密钥</Button></div>
    </form>
    </div>
  </>;
}
