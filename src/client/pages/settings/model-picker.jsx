import { useEffect, useState, useSyncExternalStore } from 'react';
import { modelKey } from '../../shared/drafts.mjs';
import { Button } from '../../components/button.jsx';
import { Field } from '../../components/form-ui.jsx';

export function ModelPicker({ catalog, status, blocked, busy, onSelect }) {
  const snapshot = useSyncExternalStore(catalog.store.subscribe, catalog.store.getSnapshot);
  const [refreshError, setRefreshError] = useState('');
  useEffect(() => {
    void catalog.load().catch(() => {});
  }, [catalog]);
  const groups = snapshot.value?.groups || [],
    choice = status.modelChoice;
  const find = (selection) =>
    groups.find((group) => group.id === selection?.provider)?.models.find((model) => model.id === selection?.model);
  const defaultModel = snapshot.value?.default ?? status.defaultModel,
    missing = choice && !find(choice);
  const loading = ['idle', 'loading'].includes(snapshot.status);
  const refresh = () => {
    setRefreshError('');
    void Promise.resolve()
      .then(() => catalog.refresh())
      .catch(() => setRefreshError('暂时无法刷新模型列表，请稍后重试。'));
  };
  return (
    <>
      <Field
        label="回复模型"
        id="wa-model"
        help="直接使用 DSH 的模型列表与登录配置。选择后自动保存，从下一个任务开始生效。"
      >
        <select
          id="wa-model"
          className="wa-select"
          value={modelKey(choice)}
          disabled={blocked}
          aria-describedby="wa-model-help"
          onChange={(event) => {
            const pair = event.target.value ? JSON.parse(event.target.value) : null;
            onSelect(pair ? { provider: pair[0], model: pair[1] } : null);
          }}
        >
          <option value="">
            跟随 DSH 默认{defaultModel?.model ? '（' + (find(defaultModel)?.name || defaultModel.model) + '）' : ''}
          </option>
          {missing && (
            <option value={modelKey(choice)} disabled>
              {choice.model} · {snapshot.status === 'ready' ? '暂不可用' : '等待列表确认'}
            </option>
          )}
          {groups.map((group) => (
            <optgroup key={group.id} label={group.name}>
              {group.models.map((model) => (
                <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <div className="wa-row">
        <Button icon="refresh" disabled={loading} onClick={refresh}>
          {loading ? '正在同步…' : '刷新模型列表'}
        </Button>
        {busy === 'model.select' && (
          <span className="wa-help" role="status">
            正在保存模型…
          </span>
        )}
      </div>
      {(snapshot.status === 'error' || refreshError) && (
        <p className="wa-alert wa-section-space" role="alert">
          {refreshError || '暂时无法同步 DSH 模型列表，请刷新后重试。已保存的选择继续保留。'}
        </p>
      )}
      {snapshot.value?.failures?.length > 0 && (
        <p className="wa-alert wa-section-space">
          部分服务的模型列表暂时无法读取：{snapshot.value.failures.map((provider) => provider.name).join('、')}。
        </p>
      )}
      {missing && snapshot.status === 'ready' && (
        <p className="wa-alert wa-section-space">所选模型暂不可用。请刷新列表或重新选择；此时不会自动换用其他模型。</p>
      )}
      {!choice && !defaultModel?.model && !loading && (
        <p className="wa-alert wa-section-space">DSH 尚未设置默认模型，请选择一个可用模型。</p>
      )}
    </>
  );
}

export function VisionModelPicker({ catalog, value, disabled, onChange }) {
  const snapshot = useSyncExternalStore(catalog.store.subscribe, catalog.store.getSnapshot);
  const groups = (snapshot.value?.groups || [])
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => !model.inputModalities || model.inputModalities.includes('image')),
    }))
    .filter((group) => group.models.length);
  const missing =
    value &&
    !groups.some((group) => group.id === value.provider && group.models.some((model) => model.id === value.model));
  return (
    <Field
      label="图像理解模型"
      id="wa-vision-model"
      help="自动时优先当前模型；若它只接收文字，使用同一 DSH 服务的视觉模型，优先同系列。也可在这里单独指定。"
    >
      <select
        id="wa-vision-model"
        className="wa-select"
        value={modelKey(value)}
        disabled={disabled}
        onChange={(event) => {
          const pair = event.target.value ? JSON.parse(event.target.value) : null;
          onChange(pair ? { provider: pair[0], model: pair[1] } : null);
        }}
      >
        <option value="">自动选择视觉模型</option>
        {missing && (
          <option value={modelKey(value)} disabled>
            {value.model} · 等待可用视觉模型
          </option>
        )}
        {groups.map((group) => (
          <optgroup key={group.id} label={group.name}>
            {group.models.map((model) => (
              <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>
                {model.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}
