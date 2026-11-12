import { useEffect, useRef, useState } from 'react';
import { Button, Feedback } from '../../components/workbench-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { MOMENTS_LIKE_DEFAULTS as defaults, momentsLikeSettings } from '../../../shared/moments-likes.mjs';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';

const bounds = [['maxLikesPerRun', '每轮最多点赞', 1, 20], ['maxLikesPerDay', '每天最多点赞', 1, 100]];

export function MomentsLikeSettings({ rpc, status, blocked }) {
  const accountId = status.account.id, online = status.online;
  const state = useWorkbench(rpc, accountId, 'moments.likes.list', '', 5000, status.timeSettings), data = state.data;
  const [settings, setSettings] = useState(() => structuredClone(defaults)), [dirty, setDirty] = useState(false);
  const [contacts, setContacts] = useState(null), [contactsError, setContactsError] = useState(''), [contactSearch, setContactSearch] = useState(''), [contactLimit, setContactLimit] = useState(50);
  const api = useRef(rpc), live = useRef(false), contactReader = useRef(null); api.current = rpc;
  useEffect(() => { if (data?.settings && !dirty) setSettings(data.settings); }, [data?.settings, dirty]);
  const update = patch => { setSettings(current => ({ ...current, ...patch })); setDirty(true); state.setNotice(''); };
  const readContacts = async () => {
    contactReader.current?.abort(); const controller = new AbortController(); contactReader.current = controller; setContactsError('');
    try {
      const result = await api.current('contacts', { accountId }, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
      if (live.current && !controller.signal.aborted) setContacts((result.privatePeers ?? []).filter(row => row.id !== accountId));
    } catch (failure) { if (live.current && !controller.signal.aborted) setContactsError(failure.message); }
  };
  useEffect(() => {
    live.current = true; if (online) void readContacts();
    return () => { live.current = false; contactReader.current?.abort(); };
  }, [accountId, online]);
  const visibleContacts = (contacts ?? []).filter(row => [row.name, row.nickname, row.remark, row.id].some(value => String(value ?? '').toLocaleLowerCase().includes(contactSearch.trim().toLocaleLowerCase())));
  const contactNames = new Map((contacts ?? []).map(row => [row.id, row.name || row.nickname || row.id]));
  let invalid = ''; try { momentsLikeSettings(settings); } catch (failure) { invalid = failure.message; }
  const busy = !!state.busy || blocked || !data;
  return <section className="wa-friend-automation" data-testid="moments-likes-settings">
    <Feedback state={state} cancellable={false} />
    {state.error && <Button quiet disabled={!!state.busy || blocked} onClick={state.refresh}>重新读取点赞设置</Button>}
    <p className="wa-wb-note">定时仅处理选中好友的新动态，聊天中明确提出的点赞请求独立控制；结果不明时保留记录，不重复提交。</p>
      <fieldset className="wa-likes-fields" disabled={state.loading || state.busy || !data || blocked}>
        <section className="wa-form-section"><h3>触发方式</h3>
          <label className="wa-wb-check"><input aria-label="开启定时点赞" type="checkbox" role="switch" checked={settings.enabled} onChange={event => update({ enabled: event.target.checked })} />定时为选中好友的新动态点赞</label>
          <label className="wa-wb-check"><input aria-label="响应聊天点赞请求" type="checkbox" role="switch" checked={settings.respondToRequests} onChange={event => update({ respondToRequests: event.target.checked })} />响应聊天中明确提出的朋友圈点赞请求</label>
        </section>
        <section className="wa-form-section"><div className="wa-audience-heading"><h3>定时点赞的好友</h3><span className="wa-audience-count">已选 {settings.userIds.length} / 100</span></div>
          <div className="wa-friend-contact-search"><label>搜索好友<input aria-label="搜索自动点赞好友" type="search" value={contactSearch} placeholder="搜索昵称、备注或微信 ID" onChange={event => { setContactSearch(event.target.value); setContactLimit(50); }} /></label><Button quiet disabled={!online} onClick={readContacts}>刷新好友列表</Button></div>
          {contactsError && <p className="wa-alert is-error" role="alert">好友列表读取失败：{contactsError} 已选好友保留。</p>}
          <div className="wa-friend-contact-list" role="group" aria-label="自动点赞好友选择">{visibleContacts.slice(0, contactLimit).map(row => <label className={'wa-wb-check wa-audience-row' + (settings.userIds.includes(row.id) ? ' is-selected' : '')} key={row.id}>
            <input aria-label={`自动点赞好友 ${row.name || row.nickname || row.id} ${row.id}`} type="checkbox" disabled={!settings.userIds.includes(row.id) && settings.userIds.length >= 100} checked={settings.userIds.includes(row.id)} onChange={event => update({ userIds: event.target.checked ? [...settings.userIds, row.id] : settings.userIds.filter(id => id !== row.id) })} /><span>{row.name || row.nickname || row.id}<small className="wa-audience-identity">{row.id}</small></span>
          </label>)}{!visibleContacts.length && <p className="wa-wb-note">{contacts ? '没有匹配的好友。' : '正在读取好友列表…'}</p>}</div>
          {visibleContacts.length > contactLimit && <Button quiet onClick={() => setContactLimit(value => value + 50)}>显示更多好友</Button>}
          {settings.userIds.length > 0 && <div className="wa-recipient-selection">{settings.userIds.map(id => <Button quiet key={id} aria-label={`移除自动点赞好友 ${id}`} onClick={() => update({ userIds: settings.userIds.filter(value => value !== id) })}>{contactNames.get(id) || id} ×</Button>)}</div>}
          {!settings.userIds.length && <p className="wa-wb-note">尚未选择好友；开启定时或立即执行前，请先选择并保存。</p>}
        </section>
        <section className="wa-form-section"><h3>点赞额度</h3><div className="wa-wb-generator wa-likes-limits">{bounds.map(([key, label, min, max]) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} value={settings[key]} onChange={event => update({ [key]: event.target.value === '' ? '' : Number(event.target.value) })} /></label>)}</div>
          <label className="wa-wb-check"><input aria-label="包含开启前的动态" type="checkbox" checked={settings.includeExisting} onChange={event => update({ includeExisting: event.target.checked })} />也处理开启前、仍在最近天数范围内的动态</label>
          <p className="wa-wb-note">检查间隔与最近天数统一在“设置 → 时间设置”中修改。每轮 1–20 次，每天 1–100 次。未获确认的提交也占用尝试额度。</p>
        </section>
      </fieldset>
    {dirty && invalid && <p role="alert" className="wa-alert is-error">{invalid}</p>}
    <div className="wa-form-actions"><span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : '更改在保存后生效。'}</span><div className="wa-wb-actions">
      <Button quiet disabled={!dirty || busy} onClick={() => { setSettings(data.settings); setDirty(false); state.setNotice(''); }}>取消点赞设置更改</Button>
      <Button disabled={!dirty || !!invalid || busy} onClick={async () => {
        const result = await state.execute('moments.likes.configure', { settings: preserveTimeValues('likes', settings, data.settings), preserveTimeSettings: true }, false);
        if (result) { state.setData(result); setDirty(false); state.setNotice('自动点赞设置已保存。'); }
      }}>保存点赞设置</Button>
    </div></div>
  </section>;
}
