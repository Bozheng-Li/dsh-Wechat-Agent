import { useEffect, useState, useSyncExternalStore } from 'react';
import { modelKey } from '../../shared/drafts.mjs';
import { Button } from '../../components/button.jsx';
import { Field } from '../../components/form-ui.jsx';
import { useModelInfo } from '../../hooks/use-model-info.mjs';

export function ModelPicker({ connection, catalog, status, blocked, busy, onSelect }) {
  const snapshot = useSyncExternalStore(catalog.store.subscribe, catalog.store.getSnapshot);
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    void catalog.load().catch(() => {});
  }, [catalog]);
  const groups = snapshot.value?.groups || [],
    choice = status.modelChoice;
  const find = (selection) =>
    groups.find((group) => group.id === selection?.provider)?.models.find((model) => model.id === selection?.model);
  const defaultModel = snapshot.value?.default ?? status.defaultModel,
    selectedModel = find(choice),
    missing = choice && !selectedModel;
  const details = useModelInfo(connection, choice, snapshot.value);
  const reasoning = details.value?.reasoning,
    efforts = reasoning?.efforts || [],
    savedEffort = choice?.reasoningEffort,
    selectedEffort = efforts.find((effort) => effort.id === savedEffort),
    defaultEffort = efforts.find((effort) => effort.id === reasoning?.defaultEffort),
    missingEffort = !!savedEffort && details.status === 'ready' && !selectedEffort;
  const loading = refreshing || ['idle', 'loading'].includes(snapshot.status);
  const refresh = () => {
    setRefreshError('');
    setRefreshing(true);
    void Promise.resolve()
      .then(() => catalog.refresh())
      .catch(() => setRefreshError('暂时无法刷新模型列表，请稍后重试。'))
      .finally(() => { details.reload(); setRefreshing(false); });
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
      {choice && (details.status !== 'ready' || efforts.length > 0 || savedEffort) && (
        <Field
          label="推理强度"
          id="wa-reasoning-effort"
          help={
            (savedEffort ? selectedEffort?.description : defaultEffort?.description) ||
            (!savedEffort && details.status === 'ready' && !defaultEffort
              ? 'DSH 未提供默认档位信息。选择具体强度后自动保存，从下一个任务开始生效。'
              : '档位由 DSH 提供。选择后自动保存，从下一个任务开始生效。')
          }
        >
          <select
            id="wa-reasoning-effort"
            className="wa-select"
            value={savedEffort || ''}
            disabled={blocked || (details.status !== 'ready' && !savedEffort)}
            aria-describedby={'wa-reasoning-effort-help' + (missingEffort ? ' wa-reasoning-effort-warning' : '')}
            aria-invalid={missingEffort ? true : undefined}
            onChange={(event) => {
              const selection = { provider: choice.provider, model: choice.model };
              if (event.target.value) selection.reasoningEffort = event.target.value;
              onSelect(selection);
            }}
          >
            <option value="">
              使用模型默认{reasoning?.defaultEffort ? '（' + (defaultEffort?.name || reasoning.defaultEffort) + '）' : ''}
            </option>
            {savedEffort && !selectedEffort && (
              <option value={savedEffort} disabled>
                {savedEffort} · {details.status === 'ready' ? '暂不可用' : '已保存，等待确认'}
              </option>
            )}
            {efforts.map((effort) => (
              <option key={effort.id} value={effort.id}>
                {effort.name || effort.id}
              </option>
            ))}
          </select>
          {missingEffort && (
            <p className="wa-alert wa-section-space" id="wa-reasoning-effort-warning" role="alert">
              已保存的推理强度不在该模型当前支持的档位中，请重新选择或使用模型默认。
            </p>
          )}
        </Field>
      )}
      {choice && details.status === 'loading' && (
        <p className="wa-help" role="status">正在向 DSH 查询该模型的推理强度…</p>
      )}
      {choice && details.status === 'error' && (
        <div className="wa-stack wa-section-space">
          <p className="wa-alert" role="alert">{details.error} 已保存的选择继续保留。</p>
          <div><Button icon="refresh" onClick={details.reload}>重试读取强度</Button></div>
        </div>
      )}
      {choice && details.status === 'ready' && !efforts.length && !savedEffort && (
        <p className="wa-help" role="status">DSH 未为此模型提供可选推理强度，将使用模型默认。</p>
      )}
      {!choice && (
        <p className="wa-help">推理强度同时跟随 DSH 默认。需要单独设置时，请先选择具体模型。</p>
      )}
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
