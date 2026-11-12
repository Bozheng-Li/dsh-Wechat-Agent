import { useEffect, useState } from 'react';
import { Field, FormActions } from '../../components/form-ui.jsx';
import { Button, Feedback } from '../../components/workbench-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';

const draftOf = settings => ({ ...settings, minGapMessages: String(settings.minGapMessages) });

export function MediaAutomationSettings({ rpc, status, blocked }) {
  const state = useWorkbench(rpc, status.account?.id, 'assets.list', '', 5000, status.timeSettings);
  const [draft, setDraft] = useState(null), [changed, setChanged] = useState(false);
  const settings = state.data?.settings, busy = !!state.busy || blocked || !settings;
  useEffect(() => { if (settings && !changed) setDraft(draftOf(settings)); }, [settings, changed]);
  const value = draft && { ...draft, minGapMessages: Number(draft.minGapMessages) };
  const dirty = !!settings && !!value && JSON.stringify(value) !== JSON.stringify(settings);
  const invalid = !draft || draft.minGapMessages.trim() === '' || !Number.isInteger(value.minGapMessages) || value.minGapMessages < 0 || value.minGapMessages > 100;
  const change = patch => { setDraft(current => ({ ...current, ...patch })); setChanged(true); state.setNotice(''); };
  return <form className="wa-settings-block" data-testid="asset-settings" onSubmit={async event => {
    event.preventDefault(); if (busy || !dirty || invalid) return;
    if (await state.execute('assets.configure', { settings: value })) { setChanged(false); state.setNotice('素材使用设置已保存。'); }
  }}>
    <Feedback state={state} cancellable={false} />
    {state.error && <Button quiet disabled={!!state.busy || blocked} onClick={state.refresh}>重新读取素材设置</Button>}
    {draft && <>
      <fieldset disabled={busy} className="wa-automation-fields"><legend className="wa-sr-only">表情与图片自动设置</legend>
        {[
          ['enabled', '允许图片和表情回复', '允许 Agent 用图片和表情回复'],
          ['preferNative', '优先发送微信原生表情', '优先发送微信原生表情，保留动画'],
          ['captureIncoming', '自动收集聊天表情', '自动保存已授权聊天中的表情'],
          ['autoDescribe', '自动整理表情含义与情景', '后台整理表情含义与适用情景'],
        ].map(([key, label, text]) => <label key={key} className="wa-check-row"><input type="checkbox" role="switch"
          aria-label={label} checked={!!draft[key]} onChange={event => change({ [key]: event.target.checked })} /><span>{text}</span></label>)}
        <p className="wa-help">模型读取含义和适用情景后，按当前语境选择表情。</p>
        <Field label="至少间隔几条消息" id="wa-media-message-gap" help="避免连续用图片刷屏。明确要求表情时不受间隔限制。">
          <input id="wa-media-message-gap" aria-label="素材最少消息间隔" className="wa-input" type="number" min="0" max="100"
            value={draft.minGapMessages} onChange={event => change({ minGapMessages: event.target.value })} />
        </Field>
        <p className="wa-help">含义整理需要在模型设置中开启图像理解，后台进行，不阻塞聊天。发送结果不明时不补发。</p>
      </fieldset>
      {dirty && invalid && <p className="wa-alert is-error" role="alert">消息间隔须为 0–100 的整数。</p>}
      <FormActions dirty={dirty} busy={state.busy} disabled={busy} invalid={invalid} label="保存使用设置"
        onReset={() => { setDraft(draftOf(settings)); setChanged(false); state.setNotice(''); }} />
    </>}
  </form>;
}
