import { splitLines } from '../../shared/conversations.mjs';
import { Button } from '../../components/button.jsx';
import { PageHead, Notice, Back } from '../../components/page-ui.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';

export function PersonaSettings({ draft, blocked, busy, dirty, notice, onChange, onSave, onReset,
  onBack, backLabel, onRestoreDefault }) {
  const aliases = splitLines(draft.aliases);
  const invalid = !draft.name.trim() || aliases.length > 12 || aliases.some(alias => alias.length > 80) || draft.prompt.length > 16000;
  return <>
    <Back label={backLabel} onClick={onBack} />
    <PageHead icon="person" title="默认助手" description="所有授权会话共用的名字、唤醒词与表达偏好。" />
    <Notice notice={notice} area="persona" />
    <div className="wa-persona-studio wa-editor-layout" data-testid="global-persona-editor">
      <form className="wa-settings-document wa-persona-manuscript" onSubmit={event => { event.preventDefault(); onSave(); }}>
        <details className="wa-editor-identity" data-testid="persona-identity-settings">
          <summary><span className="wa-editor-avatar" aria-hidden="true">{(draft.name.trim() || '助').slice(0, 1)}</span><span><strong>{draft.name || '未设置名字'}</strong><small>全局共用 · {aliases.length ? aliases.length + ' 个唤醒别名' : '尚未设置唤醒别名'}</small></span><span className="wa-editor-identity-action">名字与唤醒词</span></summary>
          <div className="wa-form-grid">
            <Field label="助手名字" id="wa-persona-name">
              <input className="wa-input" id="wa-persona-name" maxLength={80} value={draft.name} disabled={blocked}
                onChange={event => onChange({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="唤醒别名" id="wa-persona-aliases" help="每行一个或用逗号分隔，最多 12 个。">
              <textarea className="wa-textarea" id="wa-persona-aliases" rows={2} maxLength={1000} value={draft.aliases}
                disabled={blocked} onChange={event => onChange({ ...draft, aliases: event.target.value })} />
            </Field>
          </div>
        </details>
        <div className="wa-editor-toolbar"><h2>表达偏好</h2><Button quiet data-testid="restore-default-persona" disabled={blocked} onClick={onRestoreDefault}>恢复默认正文</Button></div>
        <Field label="全局自定义提示词" id="wa-persona-prompt" count={draft.prompt.length + ' / 16000'}
          help="补充表达偏好、关注重点和称呼，保存后用于后续回复。恢复默认正文会保留名字与唤醒词。">
          <textarea className="wa-textarea wa-persona-editor" id="wa-persona-prompt" rows={18} maxLength={16000}
            value={draft.prompt} disabled={blocked} onChange={event => onChange({ ...draft, prompt: event.target.value })}
            placeholder="例如：日常说话简短一点；遇到技术问题保留必要细节。不必每次叫我的名字。" />
        </Field>
        {invalid && <div className="wa-alert is-error" role="alert">请填写助手名字；唤醒别名最多 12 个，每个不超过 80 字，正文不超过 16000 字。</div>}
        <FormActions dirty={dirty} busy={busy === 'persona.save'} disabled={blocked} invalid={invalid} onReset={onReset}
          label="保存全局助手设定" hint="所有会话的后续回复共用；已有记忆继续保留。" />
      </form>
    </div>
  </>;
}
