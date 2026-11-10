import { useEffect, useState } from 'react';
import { Button } from './button.jsx';
import { Field } from './form-ui.jsx';
import { searchText, peerId, peerType } from '../shared/conversations.mjs';

export function AdminPicker({ rpc, accountId, peer, value, onChange, disabled = false, label = '管理员' }) {
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
  return <div data-testid="admin-picker" aria-label={label + '选择器'}>
    {!peer && <Field label="候选来源" id="wa-admin-source">
        <select id="wa-admin-source" className="wa-select" aria-label="管理员候选来源" value={group} disabled={disabled || loading} onChange={event => setGroup(event.target.value)}>
          <option value="">微信联系人</option>
          {groups.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}
        </select>
    </Field>}
    <div className="wa-row">
      <input className="wa-input" style={{ flex: '1 1 240px', minWidth: 0 }} aria-label={'搜索' + label} placeholder="搜索微信名、备注或成员 ID"
        value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} />
      <Button disabled={disabled || loading} onClick={() => setRevision(current => current + 1)}>{loading ? '正在读取…' : '刷新名单'}</Button>
    </div>
    {error && <p className="wa-alert" role="alert">{error}</p>}
    <div role="group" aria-label={label + '候选名单'} style={{ maxHeight: 240, overflowY: 'auto' }}>
      {matching.slice(0, 60).map(row => <label className="wa-row" key={row.id} data-admin-id={row.id} style={{ padding: '9px 0', alignItems: 'flex-start' }}>
        <input type="checkbox" checked={value.includes(row.id)} disabled={disabled || (!value.includes(row.id) && value.length >= 200)}
          onChange={() => value.includes(row.id) ? remove(row.id) : add(row.id)} />
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{row.name}{row.remark && row.remark !== row.name ? ' · ' + row.remark : ''}
          <small className="wa-help" style={{ display: 'block' }}>微信 ID：{row.id}</small></span>
      </label>)}
      {!loading && !matching.length && <p className="wa-help">{query ? '已同步名单中没有匹配项。知道微信 ID 时也可直接添加。' : '暂未同步到候选成员，可以刷新名单或输入微信 ID。'}</p>}
      {matching.length > 60 && <p className="wa-help">还有 {matching.length - 60} 位匹配成员，请缩小搜索范围。</p>}
    </div>
    {/^(?:wxid_)[a-z0-9_-]{1,145}$/i.test(manual) && !value.includes(manual) && !source.users.some(row => row.id === manual) &&
      <Button disabled={disabled || value.length >= 200} onClick={() => { add(manual); setQuery(''); }}>按微信 ID 添加：{manual}</Button>}
    <p className="wa-help" aria-live="polite">已选 {value.length} / 200 位{label}；保存后生效。</p>
    <div className="wa-row" style={{ overflowWrap: 'anywhere' }}>{value.map(id => <Button key={id} disabled={disabled} aria-label={'移除管理员 ' + id} onClick={() => remove(id)}>
      {source.users.find(row => row.id === id)?.name ? source.users.find(row => row.id === id).name + ' · ' + id : id} · 移除
    </Button>)}</div>
  </div>;
}
