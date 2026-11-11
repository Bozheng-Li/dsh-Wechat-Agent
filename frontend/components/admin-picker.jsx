import { useEffect, useId, useState } from 'react';
import { Button } from './button.jsx';
import { Field } from './form-ui.jsx';
import { Glyph } from './glyph.jsx';
import { searchText, peerId, peerType, initials } from '../shared/conversations.mjs';

export function AdminPicker({ rpc, accountId, peer, value, onChange, disabled = false, label = '管理员' }) {
  const pickerId = useId();
  const [query, setQuery] = useState(''), [group, setGroup] = useState(''), [revision, setRevision] = useState(0);
  const [source, setSource] = useState({ users: [], groups: [] }), [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const selectedPeer = peer ? peerId(peer) : group;
  const selectedType = peer ? peerType(peer) : group ? 'group' : null;
  useEffect(() => {
    setSource({ users: [], groups: [] });
    if (!accountId) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void rpc('administrators.candidates', { accountId, ...(selectedPeer ? { peerId: selectedPeer, chatType: selectedType } : {}) }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (result?.accountId !== accountId || result.peerId !== (selectedPeer || null) || !Array.isArray(result.users))
          throw new Error('管理员候选名单与当前账号或会话不匹配，请重新读取');
        setSource(result);
        if (!selectedPeer) setGroups(result.groups ?? []);
      }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountId, selectedPeer, selectedType, revision]);
  const words = searchText(query).split(' ').filter(Boolean);
  const matching = source.users.filter(row => words.every(word => searchText([row.id, row.name, row.nickname, row.remark].join(' ')).includes(word)));
  const add = id => { if (!value.includes(id) && value.length < 200) onChange([...value, id].sort()); };
  const remove = id => onChange(value.filter(item => item !== id));
  const manual = query.trim();
  const usersById = new Map(source.users.map(row => [row.id, row]));
  return <div className="wa-admin-picker" data-testid="admin-picker" role="group" aria-label={label + '选择器'}>
    <div className={'wa-admin-search-fields' + (peer ? ' is-conversation' : '')}>
    {!peer && <Field label="候选来源" id={pickerId + '-source'}>
        <select id={pickerId + '-source'} className="wa-select" aria-label="管理员候选来源" value={group} disabled={disabled || loading} onChange={event => setGroup(event.target.value)}>
          <option value="">微信联系人</option>
          {groups.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}
        </select>
    </Field>}
    <Field label={'搜索' + label} id={pickerId + '-search'}>
    <div className="wa-admin-search-row">
      <div className="wa-admin-search-input">
      <Glyph name="search" className="wa-icon-small" />
      <input id={pickerId + '-search'} type="search" className="wa-input" aria-label={'搜索' + label} placeholder="微信名、备注或成员 ID"
        value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} />
      </div>
      <Button icon="refresh" disabled={disabled || loading} onClick={() => setRevision(current => current + 1)}>{loading ? '正在读取…' : '刷新名单'}</Button>
    </div>
    </Field>
    </div>
    {error && <p className="wa-alert is-error" role="alert">{error}</p>}
    <div className="wa-admin-selection-grid">
    <div className="wa-admin-candidate-pane">
    <section className="wa-admin-candidates" aria-labelledby={pickerId + '-candidates'} aria-busy={loading}>
    <div className="wa-admin-section-head">
      <h3 id={pickerId + '-candidates'}>候选成员</h3>
      <span className="wa-help" role="status">{loading ? '正在读取名单…' : matching.length + ' 位' + (query ? '匹配成员' : '可选成员')}</span>
    </div>
    <div className="wa-admin-candidate-list" role="group" aria-label={label + '候选名单'}>
      {matching.slice(0, 60).map(row => <label className={'wa-admin-candidate' + (value.includes(row.id) ? ' is-selected' : '')} key={row.id} data-admin-id={row.id}>
        <input type="checkbox" checked={value.includes(row.id)} disabled={disabled || (!value.includes(row.id) && value.length >= 200)}
          onChange={() => value.includes(row.id) ? remove(row.id) : add(row.id)} />
        <span className="wa-admin-avatar" aria-hidden="true">{initials(row.name || row.id)}</span>
        <span className="wa-admin-candidate-copy"><strong>{row.name || row.id}</strong>
          {row.remark && row.remark !== row.name && <span className="wa-admin-remark">{row.remark}</span>}
          <small>微信 ID：{row.id}</small></span>
      </label>)}
      {!loading && !matching.length && <div className="wa-admin-empty"><Glyph name="people" /><p>{query ? '已同步名单中没有匹配项。知道微信 ID 时也可直接添加。' : '暂未同步到候选成员，可以刷新名单或输入微信 ID。'}</p></div>}
      {loading && <p className="wa-admin-list-note">正在读取微信成员，已有选择继续保留。</p>}
    </div>
    {matching.length > 60 && <p className="wa-admin-list-note">还有 {matching.length - 60} 位匹配成员，请缩小搜索范围。</p>}
    </section>
    {/^(?:wxid_)[a-z0-9_-]{1,145}$/i.test(manual) && !value.includes(manual) && !source.users.some(row => row.id === manual) &&
      <Button icon="plus" className="wa-admin-manual" disabled={disabled || value.length >= 200} onClick={() => { add(manual); setQuery(''); }}>按微信 ID 添加：{manual}</Button>}
    </div>
    <section className="wa-admin-selected" aria-labelledby={pickerId + '-selected'}>
      <div className="wa-admin-section-head"><h3 id={pickerId + '-selected'}>已选{label}</h3><span className="wa-badge" aria-live="polite">{value.length} / 200 位</span></div>
      <p className="wa-help">保存后生效 · 点击成员移除</p>
      {!!value.length && <div className="wa-admin-selected-list">{value.map(id => <Button key={id} className="wa-admin-chip" disabled={disabled} aria-label={'移除管理员 ' + id} onClick={() => remove(id)}>
        <span><strong>{usersById.get(id)?.name || id}</strong>{usersById.get(id)?.name && <small>{id}</small>}</span><Glyph name="close" className="wa-icon-small" />
      </Button>)}</div>}
      {!value.length && <p className="wa-admin-selection-empty">尚未选择{label}</p>}
    </section>
    </div>
  </div>;
}
