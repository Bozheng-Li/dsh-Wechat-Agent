import { useState } from 'react';

const names = { dsh: 'DeepSeek 原生', tavily: 'Tavily' };

export function SearchControls({ draft, status, blocked, onChange, Field }) {
  const selected = draft.searchProvider || 'tavily', alternate = selected === 'tavily' ? 'dsh' : 'tavily',
    last = status.lastSearch;
  return (
    <div className="wa-search-controls" data-testid="search-settings">
      <Field label="搜索服务" id="wa-search-provider">
        <select
          className="wa-select"
          id="wa-search-provider"
          value={selected}
          disabled={blocked || !draft.webSearch}
          onChange={(event) => onChange({ ...draft, searchProvider: event.target.value })}
        >
          <option value="dsh">DeepSeek 原生搜索</option>
          <option value="tavily">Tavily 搜索</option>
        </select>
      </Field>
      <Field label="Tavily 服务地址" id="wa-tavily-url" help="Tavily 作为优先或备用搜索时均使用此 HTTPS 地址。">
          <input
            className="wa-input"
            id="wa-tavily-url"
            type="url"
            value={draft.tavilyBaseURL}
            disabled={blocked || !draft.webSearch}
            onChange={(event) => onChange({ ...draft, tavilyBaseURL: event.target.value })}
          />
      </Field>
      <p className="wa-help">
        优先使用{names[selected]}；接口不可用或没有可用结果时，回退{names[alternate]}一次。备用接口需有专用搜索密钥。只查询必要的公开主题，回复保留来源。
      </p>
      {last && (
        <p className="wa-help" data-testid="search-status" role={last.ok ? 'status' : 'alert'}>
          {last.fallbackUsed ? `已从${names[last.primaryProvider] || '默认接口'}回退至${names[last.provider] || '备用接口'}：` : `${names[last.provider] || '搜索服务'}最近一次查询：`}
          {last.ok ? `已完成，取得 ${last.sourceCount} 条可引用结果。` : last.message}
        </p>
      )}
    </div>
  );
}

export function SearchCredentials({ status, blocked, busy, onSave, Field, Button }) {
  const [values, setValues] = useState({ dsh: '', tavily: '' });
  const save = async (provider) => {
    const submitted = values[provider],
      result = await onSave(provider, submitted);
    if (result) setValues((current) => (current[provider] === submitted ? { ...current, [provider]: '' } : current));
  };
  return (
    <section className="wa-settings-block wa-search-credentials">
      <details className="wa-data-details" data-testid="search-credentials">
        <summary>搜索密钥</summary>
        <p className="wa-help">密钥保存到 DSH 凭据服务；再次打开只显示配置状态。</p>
        {Object.keys(names).map((provider) => (
          <form
            key={provider}
            className="wa-subsection wa-credential-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(provider);
            }}
          >
            <Field
              label={`${names[provider]} API Key`}
              id={`wa-search-key-${provider}`}
              help={
                status.search?.credentials?.[provider]
                  ? '已保存；填写新密钥可替换。'
                  : provider === 'dsh'
                    ? '作为优先接口时兼容 DSH 原有搜索；作为备用时必须保存专用密钥。'
                    : '尚未保存 Tavily 搜索密钥。'
              }
            >
              <input
                className="wa-input"
                id={`wa-search-key-${provider}`}
                type="password"
                autoComplete="new-password"
                maxLength={512}
                value={values[provider]}
                disabled={blocked || !status.search?.credentialStore}
                onChange={(event) => setValues((current) => ({ ...current, [provider]: event.target.value }))}
              />
            </Field>
            <div className="wa-form-actions">
              <Button
                type="submit"
                primary
                disabled={blocked || !status.search?.credentialStore || !values[provider].trim()}
              >
                {busy === 'search.credentials' ? '正在保存…' : `保存${names[provider]}密钥`}
              </Button>
            </div>
          </form>
        ))}
      </details>
    </section>
  );
}
