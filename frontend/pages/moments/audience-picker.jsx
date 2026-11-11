import { useState } from 'react';
import { Button } from '../../components/workbench-ui.jsx';
import { formatTime } from '../../shared/conversations.mjs';

export function audiencePreview(data, labelIds, userIds) {
  const labels = new Map((data?.labels ?? []).map(row => [row.id, row])), contacts = new Set((data?.contacts ?? []).map(row => row.id));
  const missing = labelIds.some(id => !labels.has(id)) || userIds.some(id => !contacts.has(id));
  const merged = new Set(userIds);
  labelIds.forEach(id => labels.get(id)?.userIds.forEach(id => merged.add(id)));
  return { missing, count: merged.size };
}

export function AudiencePicker({ data, labelIds, userIds, onChange, onRead, busy, online, error }) {
  const [labelSearch, setLabelSearch] = useState(''), [userSearch, setUserSearch] = useState(''), [limit, setLimit] = useState(100);
  const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
  const labels = (data?.labels ?? []).filter(row => normalize(row.name).includes(normalize(labelSearch).trim()));
  const contacts = (data?.contacts ?? []).filter(row => [row.name, row.nickname, row.remark, row.id].some(value => normalize(value).includes(normalize(userSearch).trim())));
  const preview = audiencePreview(data, labelIds, userIds), selected = labelIds.length + userIds.length;
  const toggle = (key, values, id, checked) => onChange({ [key]: checked ? [...values, id] : values.filter(value => value !== id) });
  return <section className="wa-audience-picker wa-form-section" data-testid="moments-audience">
    <div className="wa-audience-heading"><h3>可见范围</h3><span className="wa-audience-count">{selected ? `已选 ${selected} 项` : '默认可见'}</span></div>
    <p className="wa-wb-note">选择不能看这条朋友圈的标签或联系人；发布时按最新标签成员合并去重。</p>
    <div className="wa-wb-actions"><Button quiet disabled={busy || !online} onClick={onRead}>{data ? '刷新微信标签与联系人' : '读取微信标签与联系人'}</Button>
      {selected > 0 && <Button quiet disabled={busy} onClick={() => onChange({ blockedLabelIds: [], blockedUserIds: [] })}>清空屏蔽选择</Button>}</div>
    {error && <p role="alert" className="wa-alert is-error">标签与联系人读取失败。已有选择保留，请刷新成功后再发布。</p>}
    {preview.missing && <p role="alert" className="wa-alert is-error">有已选标签或联系人不再可用。请重新读取并清空后选择，当前不会发布。</p>}
    {data && <>
      <p className="wa-wb-note">微信实际读取：{data.labels.length} 个标签、{data.contacts.length} 位联系人 · {formatTime(Date.parse(data.fetchedAt))}
        {data.unavailableCount > 0 ? `。另有 ${data.unavailableCount} 个不可用条目，未列入可选联系人。` : ''}</p>
      <div className="wa-audience-grid">
        <div className="wa-audience-column">
          <label>屏蔽标签<input type="search" aria-label="搜索屏蔽标签" value={labelSearch} placeholder="搜索微信标签名称" onChange={e => setLabelSearch(e.target.value)} /></label>
          <div className="wa-audience-list" role="group" aria-label="可屏蔽的微信标签">
            {labels.map(row => <label className={'wa-wb-check wa-audience-row' + (labelIds.includes(row.id) ? ' is-selected' : '')} key={row.id}>
              <input type="checkbox" aria-label={`屏蔽标签 ${row.name}`} disabled={busy} checked={labelIds.includes(row.id)}
                onChange={e => toggle('blockedLabelIds', labelIds, row.id, e.target.checked)} /><span>{row.name}</span><small>{row.memberCount} 人</small>
            </label>)}
            {!labels.length && <p className="wa-wb-note">{data.labels.length ? '没有匹配的微信标签。' : '微信当前未返回标签。'}</p>}
          </div>
        </div>
        <div className="wa-audience-column">
          <label>屏蔽联系人<input type="search" aria-label="搜索屏蔽联系人" value={userSearch} placeholder="搜索昵称、备注或微信 ID" onChange={e => { setUserSearch(e.target.value); setLimit(100); }} /></label>
          <div className="wa-audience-list" role="group" aria-label="可屏蔽的微信联系人">
            {contacts.slice(0, limit).map(row => <label className={'wa-wb-check wa-audience-row' + (userIds.includes(row.id) ? ' is-selected' : '')} key={row.id}>
              <input type="checkbox" aria-label={`屏蔽联系人 ${row.name} ${row.id}`} disabled={busy} checked={userIds.includes(row.id)}
                onChange={e => toggle('blockedUserIds', userIds, row.id, e.target.checked)} /><span>{row.name}<small className="wa-audience-identity">{row.nickname !== row.name ? `${row.nickname} · ` : ''}{row.id}</small></span>
            </label>)}
            {!contacts.length && <p className="wa-wb-note">没有匹配的联系人。</p>}
            {contacts.length > limit && <Button quiet onClick={() => setLimit(limit + 100)}>显示更多联系人（还有 {contacts.length - limit} 位）</Button>}
          </div>
        </div>
      </div>
      <p className="wa-wb-note" aria-live="polite" data-testid="moments-audience-summary">已选 {labelIds.length} 个标签、{userIds.length} 位联系人，合并后屏蔽 {preview.count} 人。</p>
    </>}
    {!selected && <p className="wa-wb-note">未选择屏蔽对象，按默认可见范围发布。</p>}
  </section>;
}
