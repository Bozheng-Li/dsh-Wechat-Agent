import { useEffect, useRef, useState } from 'react';
import { Back, PageHead } from '../../components/page-ui.jsx';
import { Button } from '../../components/button.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';
import { TIME_FIELDS, validateTimeValues } from '../../../shared/time-settings.mjs';
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

const draftOf = group => Object.fromEntries(TIME_FIELDS[group.kind].map(field => [field.key,
  field.type === 'number' ? group.values[field.key] == null ? '' : String(group.values[field.key]) : group.values[field.key]]));
const valuesOf = (group, draft) => Object.fromEntries(TIME_FIELDS[group.kind].map(field => [field.key,
  field.type === 'number' ? field.nullable && draft[field.key] === '' ? null : draft[field.key] === '' ? NaN : Number(draft[field.key]) : draft[field.key]]));

function TimeGroup({ group, rpc, scope, signal, onSaved, blocked }) {
  const [draft, setDraft] = useState(() => draftOf(group)), [base, setBase] = useState(group);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const operation = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(base));
  const stale = group.revision !== base.revision;
  useEffect(() => { if (!dirty && stale) { setBase(group); setDraft(draftOf(group)); } }, [group.revision, dirty]);
  let invalid = '';
  const values = valuesOf(base, draft);
  try {
    validateTimeValues(base.kind, values);
    if (base.kind === 'natural' && (values.minMinutes > values.maxMinutes || values.activeHours && values.startTime === values.endTime)) invalid = '请检查最短与最长间隔，以及活跃时段的起止时间。';
    if (base.kind === 'publishing' && values['automatic.startTime'] >= values['automatic.endTime']) invalid = '自动安排结束时间须晚于开始时间。';
  } catch (failure) { invalid = failure.message; }
  const reset = () => { setBase(group); setDraft(draftOf(group)); setError(''); setNotice(''); };
  const save = async event => {
    event.preventDefault();
    if (!dirty || invalid || operation.current || blocked || stale) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await rpc('time.configure', { ...scope, id: base.id, revision: base.revision, values }, signal);
      if (signal.aborted) return;
      const updated = result.groups.find(row => row.id === base.id);
      if (updated) { setBase(updated); setDraft(draftOf(updated)); }
      onSaved(result); setNotice('已保存，后续执行使用新的时间设置。');
    } catch (failure) { if (!signal.aborted) setError(failure.message); }
    finally { operation.current = false; if (!signal.aborted) setBusy(false); }
  };
  return <form className="wa-settings-block" aria-label={group.title} data-testid={'time-group-' + group.id} onSubmit={save}>
    <fieldset disabled={busy || blocked} className="wa-time-fields" aria-label={group.title}>
      <div className="wa-form-grid">{TIME_FIELDS[group.kind].map(field => {
        if (group.kind === 'natural' && (draft.intervalMode === 'fixed' ? ['minMinutes', 'maxMinutes'].includes(field.key) : field.key === 'fixedMinutes')) return null;
        if (group.kind === 'natural' && !draft.activeHours && ['startTime', 'endTime'].includes(field.key)) return null;
        const id = 'wa-time-' + group.id.replace(/[^\w-]/g, '-') + '-' + field.key.replaceAll('.', '-');
        const change = value => { setDraft(current => ({ ...current, [field.key]: value })); setNotice(''); };
        return <Field key={field.key} id={id} label={field.label} help={field.help}>
          {field.type === 'select' ? <select id={id} className="wa-select" value={draft[field.key]} onChange={event => change(event.target.value)}>{field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            : field.type === 'checkbox' ? <input id={id} type="checkbox" checked={draft[field.key]} onChange={event => change(event.target.checked)} />
            : <input id={id} className="wa-input" type={field.type} min={field.min} max={field.max} step={field.type === 'number' ? 1 : undefined} maxLength={field.type === 'text' ? 80 : undefined}
              value={draft[field.key]} placeholder={field.nullable ? '长期保存' : undefined} onChange={event => change(event.target.value)} />}
        </Field>;
      })}</div>
    </fieldset>
    {stale && <p className="wa-alert" role="alert">此项设置已更新，请载入最新值再保存。<Button quiet disabled={busy} onClick={reset}>载入最新值</Button></p>}
    {(error || dirty && invalid) && <p className="wa-alert is-error" role="alert">{error || invalid}</p>}
    {notice && <p className="wa-alert is-success" role="status">{notice}</p>}
    <FormActions dirty={dirty} busy={busy} disabled={blocked || stale} invalid={!!invalid} onReset={reset} label={'保存' + group.title} />
  </form>;
}

export function TimeSettings({ rpc, status, blocked, onBack, backLabel }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [query, setQuery] = useState(''), [peerKey, setPeerKey] = useState('');
  const lifetime = useRef(null), api = useRef(rpc), reads = useRef(0); api.current = rpc;
  const peers = status.conversations ?? [], peer = peers.find(row => row.key === peerKey);
  const scope = { ...(status.account?.id ? { accountId: status.account.id } : {}), ...(peer ? { peerId: peer.peerId, chatType: peer.chatType } : {}) };
  const scopeKey = JSON.stringify(scope);
  const load = async signal => {
    const read = ++reads.current;
    try { const result = await api.current('time.list', scope, signal); if (!signal.aborted && read === reads.current) { setData(result); setError(''); } }
    catch (failure) { if (!signal.aborted && read === reads.current) setError(failure.message); }
  };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller; setData(null); setError('');
    let timer;
    const poll = async () => { await load(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, 5000); };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [scopeKey]);
  const matches = group => !query.trim() || [group.title, group.category, ...TIME_FIELDS[group.kind].map(field => field.label)].join(' ').includes(query.trim());
  const groups = data?.groups.filter(matches) ?? [];
  return <>
    <Back onClick={onBack} label={backLabel} />
    <PageHead icon="clock" title="时间设置" description="统一管理等待时限、执行间隔、活跃时段与保存期限。每组独立保存。" />
    <div className="wa-form-grid wa-section-space">
      <Field id="wa-time-search" label="查找时间设置"><input id="wa-time-search" className="wa-input" type="search" value={query} placeholder="搜索超时、朋友圈、记忆…" onChange={event => setQuery(event.target.value)} /></Field>
      <Field id="wa-time-conversation" label="会话时间设置" help="选择会话后，可设置该群的陪聊节奏和该会话的图片保存期限。">
        <select id="wa-time-conversation" className="wa-select" value={peer?.key ?? ''} onChange={event => setPeerKey(event.target.value)} disabled={!status.account}>
          <option value="">全局与当前账号</option>{peers.map(row => <option key={row.key} value={row.key}>{row.chatType === 'group' ? '群聊' : '私聊'} · {row.name || row.peerId}</option>)}
        </select>
      </Field>
    </div>
    <Button quiet disabled={blocked} onClick={() => load(lifetime.current.signal)}>重新载入时间设置</Button>
    {error && <p className="wa-alert is-error" role="alert">{error}</p>}
    {!data && !error && <p className="wa-help" role="status">正在读取时间设置…</p>}
    {['全局', '当前微信账号', '所选会话'].map(category => {
      const items = groups.filter(group => group.category === category);
      return items.length ? <section key={category} className="wa-section-space" aria-label={category + '时间设置'}><h2>{category}{category === '所选会话' ? ' · ' + (peer?.name || peer?.peerId) : ''}</h2>
        {items.map(group => <details className="wa-time-group" key={scopeKey + group.id} open={!!query.trim() || group.id === 'runtime'}>
          <summary><span>{group.title}</span><span className="wa-time-group-meta">{group.schedule && <ScheduleCountdown {...group.schedule} status={status} />}<small>{TIME_FIELDS[group.kind].length} 项</small></span></summary>
          <TimeGroup group={group} rpc={(...args) => api.current(...args)} scope={scope} signal={lifetime.current.signal} onSaved={result => { reads.current++; setData(result); }} blocked={blocked} />
        </details>)}
      </section> : null;
    })}
    {data && !groups.length && <p className="wa-help">没有匹配的时间设置。</p>}
  </>;
}
