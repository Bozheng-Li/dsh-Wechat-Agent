import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/button.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';
import { roleCardSettings } from '../../../shared/role-card-settings.mjs';

const draftOf = settings => ({ enabled: settings.enabled, trigger: settings.trigger, messageThreshold: String(settings.messageThreshold) });
const valueOf = (draft, saved) => roleCardSettings({ ...saved, ...draft, messageThreshold: Number(draft.messageThreshold) });

export function RoleCardSettings({ rpc, blocked, onSaved, children }) {
  const [saved, setSaved] = useState(null), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lifetime = useRef(null), operation = useRef(false);
  const load = async signal => {
    try {
      const value = await rpc('memory.role.settings', {}, signal);
      if (signal.aborted) return;
      setSaved(value); setDraft(draftOf(value.settings)); setError(''); setNotice('');
    } catch (failure) { if (!signal.aborted) setError(failure.message); }
  };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(draftOf(saved.settings));
  let value, invalid = '';
  if (draft) try { value = valueOf(draft, saved.settings); } catch (failure) { invalid = failure.message; }
  const change = (field, next) => { setDraft(current => ({ ...current, [field]: next })); setNotice(''); };
  const save = async event => {
    event.preventDefault();
    if (!dirty || invalid || operation.current || blocked) return;
    const signal = lifetime.current.signal;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await rpc('memory.role.configure', { settings: value, revision: saved.revision }, signal);
      if (signal.aborted) return;
      setSaved(result); setDraft(draftOf(result.settings));
      setNotice(result.settings.enabled ? '自动整理设置已保存。' : '已关闭自动整理；已有卡片仍可读取，也可手动根据已有来源更新。');
      onSaved?.();
    } catch (failure) { if (!signal.aborted) setError(failure.message); }
    finally { operation.current = false; if (!signal.aborted) setBusy(false); }
  };
  return <form className="wa-settings-block wa-section-space" data-testid="role-card-settings" onSubmit={save}>
    <h2>自动整理 · 全局设置</h2>
    <p className="wa-help">每个人单独累计，私聊、群聊与已读取的朋友圈原文合并计数。整理间隔与超时统一在“设置 → 时间设置”中修改。</p>
    {error && <p className="wa-alert is-error" role="alert">{error} <Button quiet disabled={busy} onClick={() => load(lifetime.current.signal)}>重新载入总设置</Button></p>}
    {!draft ? <p className="wa-help">正在读取总设置…</p> : <>
      <label className="wa-row">
        <input type="checkbox" role="switch" aria-label="自动整理角色卡" checked={draft.enabled} disabled={busy || blocked}
          onChange={event => change('enabled', event.target.checked)} />
        <span>自动整理角色卡</span>
      </label>
      <p className="wa-help">开启时，明确改称呼、纠正或 Agent 发现资料冲突可提前整理；关闭后暂停全部自动整理，保留读取和页面手动更新。</p>
      <div className="wa-form-grid">
        <Field label="普通消息的整理方式" id="wa-role-trigger" help="条数和时间仅按所选方式生效。">
          <select id="wa-role-trigger" className="wa-select" value={draft.trigger} disabled={busy || blocked}
            onChange={event => change('trigger', event.target.value)}>
            <option value="messages">按新增条数</option><option value="time">按时间间隔</option>
          </select>
        </Field>
        {draft.trigger === 'messages' ? <Field label="累计新增消息（条）" id="wa-role-message-threshold" help="默认 20 条。未达到条数时继续累计，首次认识的人也遵守这个频率。">
          <input id="wa-role-message-threshold" className="wa-input" type="number" min="1" max="512" step="1"
            value={draft.messageThreshold} disabled={busy || blocked} onChange={event => change('messageThreshold', event.target.value)} />
        </Field> : <p className="wa-help">按“时间设置”中的整理间隔执行。</p>}
      </div>
      {dirty && invalid && <p className="wa-alert is-error" role="alert">{invalid}</p>}
      {notice && <p className="wa-alert is-success" role="status">{notice}</p>}
      <FormActions dirty={dirty} busy={busy} disabled={blocked} invalid={!!invalid} label="保存角色卡总设置" hint="后台由模型总结，聊天可继续进行。"
        onReset={() => { setDraft(draftOf(saved.settings)); setError(''); setNotice(''); }} />
    </>}
    {children}
  </form>;
}
