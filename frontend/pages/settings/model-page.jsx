import { SearchControls, SearchCredentials } from "./search-settings.jsx";
import { Button } from "../../components/button.jsx";
import { PageHead, Notice, Back } from "../../components/page-ui.jsx";
import { Field, FormActions } from "../../components/form-ui.jsx";
import { ModelPicker, VisionModelPicker } from "./model-picker.jsx";

export function ModelSettings({
  connection,
  catalog,
  status,
  draft,
  prompt,
  blocked,
  busy,
  notice,
  modelDirty,
  promptDirty,
  onModelChange,
  onModelSave,
  onModelReset,
  onPromptChange,
  onPromptSave,
  onPromptReset,
  onSelect,
  onSearchCredential,
  onBack,
  backLabel,
  onNavigate,
}) {
  const tokens = draft.maxTokens.trim() === '' ? null : Number(draft.maxTokens),
    temperature = draft.temperature.trim() === '' ? null : Number(draft.temperature);
  const invalid =
    (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1)) ||
    (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2));
  return (
    <>
      <Back label={backLabel} onClick={onBack} />
      <PageHead title="模型设置" description="选择回复使用的模型，并单独设置生成参数。" />
      <Notice notice={notice} area="model" />
      <div className="wa-stack wa-content-narrow">
        <section className="wa-card wa-model-card">
          <div className="wa-card-heading">
            <div>
              <h2>模型连接</h2>
              <p className="wa-muted">模型服务由 DSH 统一管理。</p>
            </div>
          </div>
          <ModelPicker connection={connection} catalog={catalog} status={status} blocked={blocked} busy={busy} onSelect={onSelect} />
        </section>
        <form
          className="wa-card"
          onSubmit={(event) => {
            event.preventDefault();
            onModelSave();
          }}
        >
          <div className="wa-card-heading">
            <div>
              <h2>生成参数</h2>
              <p className="wa-muted">影响之后开始的回复任务。</p>
            </div>
          </div>
          <div className="wa-form-grid">
            <Field
              label="最大输出 Token"
              id="wa-max-tokens"
              help="留空使用所选模型的最大输出额度；也可填写正整数自行调整，插件不再设置固定上限。"
            >
              <input
                className="wa-input"
                id="wa-max-tokens"
                type="number"
                min="1"
                step="1"
                placeholder="自动 · 使用模型最大输出额度"
                value={draft.maxTokens}
                disabled={blocked}
                aria-invalid={tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1) || undefined}
                aria-describedby="wa-max-tokens-help"
                onChange={(event) => onModelChange({ ...draft, maxTokens: event.target.value })}
              />
            </Field>
            <Field label="温度" id="wa-temperature" help="0–2；留空时使用模型默认值。">
              <input
                className="wa-input"
                id="wa-temperature"
                type="number"
                min="0"
                max="2"
                step="any"
                placeholder="跟随模型默认"
                value={draft.temperature}
                disabled={blocked}
                aria-invalid={temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) || undefined}
                aria-describedby="wa-temperature-help"
                onChange={(event) => onModelChange({ ...draft, temperature: event.target.value })}
              />
            </Field>
          </div>
          <details className="wa-subsection" data-testid="model-advanced">
            <summary>高级设置</summary>
            <Field label="上下文模式" id="wa-prompt-strategy" help="按需加载精简默认提示、图片目录与历史，相关能力在需要时展开。完整模式保留原有行为；管理员明确要求始终保留。">
              <select className="wa-input" id="wa-prompt-strategy" value={draft.promptStrategy ?? 'legacy'} disabled={blocked}
                onChange={event => onModelChange({ ...draft, promptStrategy: event.target.value })}>
                <option value="legacy">完整上下文（兼容）</option>
                <option value="progressive-v1">按需加载（试用）</option>
              </select>
            </Field>
            <label className="wa-check-row">
              <input
                type="checkbox"
                aria-label="启用图像理解"
                checked={draft.vision}
                disabled={blocked}
                onChange={(event) => onModelChange({ ...draft, vision: event.target.checked })}
              />
              <span>按需图片理解</span>
            </label>
            <p className="wa-help">
              收到图片先保存；只有回答需要看图时才调用视觉模型，已有描述足够就直接回答。表情包不理解。
            </p>
            <VisionModelPicker
              catalog={catalog}
              value={draft.visionModel}
              disabled={blocked || !draft.vision}
              onChange={(visionModel) => onModelChange({ ...draft, visionModel })}
            />
            <label className="wa-check-row">
              <input
                type="checkbox"
                aria-label="启用联网搜索"
                checked={draft.webSearch}
                disabled={blocked}
                onChange={(event) => onModelChange({ ...draft, webSearch: event.target.checked })}
              />
              <span>联网搜索</span>
            </label>
            <SearchControls draft={draft} status={status} blocked={blocked} onChange={onModelChange} Field={Field} />
          </details>
          {invalid && <div className="wa-alert is-error" role="alert">请检查参数范围：Token 为正整数或留空，温度为 0–2 或留空。</div>}
          <FormActions
            dirty={modelDirty}
            busy={busy === 'model.configure'}
            disabled={blocked}
            invalid={invalid}
            onReset={onModelReset}
            label="保存生成参数"
          />
        </form>
        <SearchCredentials
          status={status}
          blocked={blocked}
          busy={busy}
          onSave={onSearchCredential}
          Field={Field}
          Button={Button}
        />
        <form
          className="wa-card"
          onSubmit={(event) => {
            event.preventDefault();
            onPromptSave();
          }}
        >
          <div className="wa-card-heading">
            <div>
              <h2>当前账号的补充回复要求</h2>
              <p className="wa-muted">与默认助手设定共同用于当前账号的后续回复。</p>
            </div>
          </div>
          {status.account ? (
            <>
              <Field label="补充要求" id="wa-prompt" count={prompt.length + ' / 4000'}>
                <textarea
                  className="wa-textarea"
                  id="wa-prompt"
                  rows={4}
                  maxLength={4000}
                  placeholder="例如：在技术讨论中先给结论，再补充必要依据。"
                  value={prompt}
                  disabled={blocked}
                  onChange={(event) => onPromptChange(event.target.value)}
                />
              </Field>
              <FormActions
                dirty={promptDirty}
                busy={busy === 'settings'}
                disabled={blocked}
                onReset={onPromptReset}
                label="保存补充要求"
              />
            </>
          ) : (
            <p className="wa-help">连接微信后，可为当前账号设置补充要求。</p>
          )}
        </form>
      </div>
    </>
  );
}
