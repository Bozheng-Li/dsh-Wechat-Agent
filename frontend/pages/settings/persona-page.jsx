import { useEffect, useState } from 'react';
import { splitLines } from '../../shared/conversations.mjs';
import { Button } from '../../components/button.jsx';
import { PageHead, Notice, Back } from '../../components/page-ui.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';
import { WorkspaceTabs, WorkspacePanels } from '../../components/workspace-tabs.jsx';
import { PersonaChat } from './persona-chat.jsx';

const WARMTH_LABELS = [
  ['balanced', '中性（推荐）'],
  ['terse', '更短更冷'],
  ['warm', '稍暖一点'],
];

/** 从聊天记录提炼说话方式，并另存为一个人设。 */
function DistillPanel({ rpc, accountId, blocked, onSaved, onCancel }) {
  const [people, setPeople] = useState(null);
  const [senderId, setSenderId] = useState('');
  const [warmth, setWarmth] = useState('balanced');
  const [draft, setDraft] = useState(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!rpc || !accountId) return;
    let live = true;
    rpc('persona.candidates', { accountId })
      .then(value => { if (live) setPeople(value); })
      .catch(failure => { if (live) { setError(failure.message || '读取会话失败'); setPeople([]); } });
    return () => { live = false; };
  }, [rpc, accountId]);

  const build = async () => {
    if (!senderId || blocked || busy) return;
    setBusy('build'); setError('');
    try {
      const value = await rpc('persona.distill', { accountId, senderId, warmth });
      setDraft(value);
      setTitle(value.suggestedName);
    } catch (failure) { setError(failure.message || '提炼失败'); }
    finally { setBusy(''); }
  };

  const save = async () => {
    if (blocked || busy || !draft?.persona) return;
    setBusy('save'); setError('');
    try {
      const result = await onSaved({ persona: draft.persona, name: title.trim(), source: 'distilled' });
      if (!result) setError('保存未完成，草稿和编辑内容已保留；请查看错误提示后重试。');
    } catch (failure) { setError(failure.message || '保存失败，草稿和编辑内容已保留。'); }
    finally { setBusy(''); }
  };

  return <section className="wa-persona-distill" data-testid="persona-distill">
    <div className="wa-card-heading">
      <div><h2>从聊天记录提炼</h2>
        <p className="wa-muted">让当前模型阅读最近的授权发言和相邻对话，直接总结说话方式。联系方式与已知称呼会匿名；生成后可自由编辑，保存后所有会话共用。</p></div>
      <Button quiet onClick={onCancel} disabled={blocked || !!busy}>取消</Button>
    </div>
    {!people ? <p className="wa-help">正在读取会话…</p>
      : !people.length ? <p className="wa-help">还没有可用的会话记录。先和某人聊一段时间，再回来提炼。</p>
        : <>
          <div className="wa-form-grid">
            <Field label="学谁" id="wa-distill-person">
              <select className="wa-input" id="wa-distill-person" value={senderId} disabled={blocked || !!busy}
                onChange={event => { setSenderId(event.target.value); }}>
                <option value="">选择一个人</option>
                {people.map(person => <option key={person.senderId} value={person.senderId}>
                  {person.name}（{person.count} 条，{person.chats.length} 个会话）
                </option>)}
              </select>
            </Field>
            <Field label="松紧" id="wa-distill-warmth" help="告诉模型保留多简练或温和的表达，不是字数上限。">
              <select className="wa-input" id="wa-distill-warmth" value={warmth} disabled={blocked || !!busy}
                onChange={event => { setWarmth(event.target.value); }}>
                {WARMTH_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          <p className="wa-help">生成草稿会把做过基础脱敏的聊天片段、相邻发言和时间发给当前模型服务。片段仍可能包含私人信息，请只在内容适合交给该服务时使用。保存前可以编辑结果。</p>
          <div className="wa-row">
            <Button quiet onClick={build} loading={busy === 'build'} disabled={blocked || !senderId || !!busy}>生成草稿</Button>
          </div>
          {draft && <>
            {draft.summaryWarning && <p className="wa-help" role="status">{draft.summaryWarning}</p>}
            {(draft.senderId !== senderId || draft.warmth !== warmth) && <p className="wa-help">当前保留的是上次生成的草稿。选择或松紧已改变，再次生成成功后才会替换正文。</p>}
            <details className="wa-section-space"><summary>查看采样统计</summary>
              <p className="wa-help">{draft.summary}</p>
              {draft.sampling && <p className="wa-help">本次使用 {draft.sampling.used} 条发言及相邻语境，来自 {draft.sampling.chats || 1} 个会话；另有 {draft.sampling.omitted} 条未纳入本次。统计用于参考，不是生成或保存门槛。</p>}
            </details>
            <Field label="人设名称" id="wa-distill-title">
              <input className="wa-input" id="wa-distill-title" maxLength={80} value={title} disabled={blocked || !!busy}
                onChange={event => setTitle(event.target.value)} />
            </Field>
            <Field label="生成的人设（保存前可以改）" id="wa-distill-body">
              <textarea className="wa-textarea wa-persona-editor" id="wa-distill-body" rows={14} disabled={blocked || !!busy}
                value={draft.persona.prompt}
                onChange={event => setDraft({ ...draft, persona: { ...draft.persona, prompt: event.target.value } })} />
            </Field>
            <div className="wa-row">
              <Button primary onClick={save} loading={busy === 'save'}
                disabled={blocked || !title.trim() || !!busy}>保存为新人设并使用</Button>
            </div>
          </>}
        </>}
    {error && <p className="wa-alert is-error" role="alert">{error}</p>}
  </section>;
}

function PersonaLibrary({ personas, blocked, onSelect, onDelete, onAdd }) {
  const items = personas?.items ?? [];
  return <section className="wa-persona-library" data-testid="persona-library">
    <div className="wa-card-heading">
      <div><h2>人设库</h2>
        <p className="wa-muted">所有会话共用正在使用的那一条。{items.length} / 12</p></div>
      <Button quiet icon="plus" onClick={onAdd} disabled={blocked}>从聊天记录提炼</Button>
    </div>
    <ul className="wa-persona-list" role="radiogroup" aria-label="选择人设">
      {items.map(item => {
        const active = item.id === personas.activeId;
        return <li key={item.id} data-active={active || undefined}>
          <button type="button" className="wa-persona-pick" role="radio" aria-checked={active}
            disabled={blocked} onClick={() => onSelect(item.id)}>
            <span className="wa-persona-mark" aria-hidden="true" />
            <span className="wa-persona-copy">
              <span className="wa-persona-name">{item.name}</span>
              <span className="wa-persona-meta">{item.source === 'distilled' ? '提炼' : '手写'} · {item.chars} 字</span>
            </span>
            {active && <span className="wa-persona-badge">使用中</span>}
          </button>
          <button type="button" className="wa-persona-remove" aria-label={'删除人设 ' + item.name}
            disabled={blocked || items.length <= 1} title={items.length <= 1 ? '至少要保留一个人设' : '删除'}
            onClick={() => onDelete(item.id)}>删除</button>
        </li>;
      })}
    </ul>
  </section>;
}

const TABS = [['edit', '当前人设'], ['library', '人设库'], ['chat', '试聊']];

export function PersonaSettings({ draft, personas, blocked, busy, dirty, notice, onChange, onSave, onReset,
  onBack, backLabel, onRestoreDefault, rpc, accountId, onSelectPersona, onCreatePersona, onDeletePersona }) {
  const [tab, setTab] = useState('edit');
  const [adding, setAdding] = useState(false);
  const aliases = splitLines(draft.aliases);
  const activeName = (personas?.items ?? []).find(item => item.id === personas.activeId)?.name;
  const invalid = !draft.name.trim() || aliases.length > 12 || aliases.some(alias => alias.length > 80) || draft.prompt.length > 16000 ||
    !['standard', 'high-precision'].includes(draft.personaMode || 'standard');

  return <>
    <Back label={backLabel} onClick={onBack} />
    <PageHead icon="person" title="默认助手" description="管理多个人设，选用其中一个，或从聊天记录提炼新的说话方式。" />
    <Notice notice={notice} area="persona" />
    <WorkspaceTabs name="persona" label="人设分区" active={tab} onChange={setTab} tabs={TABS} />
    <WorkspacePanels name="persona" tabs={TABS.map(([id]) => id)} active={tab}>
      {tab === 'edit' && <form className="wa-settings-document wa-persona-manuscript wa-persona-pane"
        onSubmit={event => { event.preventDefault(); onSave(); }}>
        <details className="wa-editor-identity" data-testid="persona-identity-settings">
          <summary><span className="wa-editor-avatar" aria-hidden="true">{(draft.name.trim() || '助').slice(0, 1)}</span><span><strong>{draft.name || '未设置名字'}</strong><small>{activeName ? '正在编辑：' + activeName : '正在编辑当前人设'} · {aliases.length ? aliases.length + ' 个唤醒别名' : '尚未设置唤醒别名'}</small></span><span className="wa-editor-identity-action">名字与唤醒词</span></summary>
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
        <label className="wa-check-row wa-persona-precision">
          <input type="checkbox" aria-label="高精度人设模式" checked={draft.personaMode === 'high-precision'} disabled={blocked}
            onChange={event => onChange({ ...draft, personaMode: event.target.checked ? 'high-precision' : 'standard' })} />
          <span>高精度人设模式</span>
        </label>
        <p className="wa-help">回复先整理事实，再单独按人设表达；每条需回复的消息多一次生成。不会因短消息自动降级。</p>
        <div className="wa-editor-toolbar"><h2>人设正文</h2><Button quiet data-testid="restore-default-persona" disabled={blocked} onClick={onRestoreDefault}>恢复默认正文</Button></div>
        <Field label="性格与表达" id="wa-persona-prompt" count={draft.prompt.length + ' / 16000'}
          help="写清相处方式、关注点、称呼和说话习惯。「试聊」页可以直接用当前草稿测试，不必先保存。">
          <textarea className="wa-textarea wa-persona-editor" id="wa-persona-prompt" rows={18} maxLength={16000}
            value={draft.prompt} disabled={blocked} onChange={event => onChange({ ...draft, prompt: event.target.value })}
            placeholder="例如：说话短一点，对具体细节有兴趣，偶尔轻轻吐槽。" />
        </Field>
        {invalid && <div className="wa-alert is-error" role="alert">请填写名字；唤醒别名最多 12 个，每个不超过 80 字；人设正文不超过 16000 字。</div>}
        <FormActions dirty={dirty} busy={busy === 'persona.save'} disabled={blocked} invalid={invalid} onReset={onReset}
          label="保存当前人设" hint="只影响当前选用的人设；其他人的设定不变。" />
      </form>}
      {tab === 'library' && <div className="wa-persona-pane">
        {adding
          ? <DistillPanel rpc={rpc} accountId={accountId} blocked={blocked}
              onCancel={() => setAdding(false)}
              onSaved={async payload => {
                const result = await onCreatePersona(payload);
                if (result) setAdding(false);
                return result;
              }} />
          : <PersonaLibrary personas={personas} blocked={blocked}
              onSelect={id => onSelectPersona(id)} onDelete={id => onDeletePersona(id)}
              onAdd={() => setAdding(true)} />}
      </div>}
      {tab === 'chat' && <div className="wa-persona-pane wa-persona-chat-pane">
        <PersonaChat draft={draft} rpc={rpc} disabled={blocked || invalid} />
      </div>}
    </WorkspacePanels>
  </>;
}
