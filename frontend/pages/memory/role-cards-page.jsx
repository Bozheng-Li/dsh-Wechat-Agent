import { useEffect, useRef, useState } from 'react';
import { Empty, PageHead, Search } from '../../components/page-ui.jsx';
import { Button } from '../../components/button.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { emptyRoleCard } from '../../../shared/role-card.mjs';
import { AutomationLink } from '../../components/automation-link.jsx';
import { RoleAvatar, RoleCardDetails, RolePersonCard, roleSource, roleTone } from './role-card-view.jsx';
import { roleCardGroups } from './role-card-groups.mjs';

export function RoleCardsPage({ rpc, status, onNavigate }) {
  const accountId = status.account?.id;
  const [people, setPeople] = useState([]), [selected, setSelected] = useState(''), [doc, setDoc] = useState(null);
  const [draft, setDraft] = useState(emptyRoleCard), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [listError, setListError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [listing, setListing] = useState(!!accountId);
  const [audience, setAudience] = useState(null), [tagBusy, setTagBusy] = useState(false), [tagError, setTagError] = useState('');
  const key = JSON.stringify([accountId, selected]), current = useRef(key), account = useRef(accountId);
  const operation = useRef(null), reads = useRef(0), listReads = useRef(0), editingRef = useRef(false);
  const dialogRef = useRef(null), triggerRef = useRef(null);
  const tagOperation = useRef(null);
  current.current = key; account.current = accountId; editingRef.current = editing;
  const scope = { accountId, personId: selected };
  const dirty = !!doc && JSON.stringify(draft) !== JSON.stringify(doc.card);
  const canReadTags = !!accountId && status.online && status.momentsAudienceReady === true;
  const authorizedPeople = JSON.stringify(status.settings?.privatePeers || []);
  useEffect(() => {
    const allowed = new Set(status.settings?.privatePeers || []);
    setPeople(current => current.filter(person => allowed.has(person.personId)));
    if (selected && !allowed.has(selected)) {
      operation.current?.abort(); setSelected(''); setDoc(null); setDraft(emptyRoleCard());
      setEditing(false); editingRef.current = false; setError(''); setNotice('');
    }
  }, [accountId, authorizedPeople]);
  const loadTags = async () => {
    if (!canReadTags) return;
    tagOperation.current?.abort();
    const controller = new AbortController(); tagOperation.current = controller;
    setTagBusy(true); setTagError('');
    try {
      const value = await rpc('moments.audience', { accountId }, controller.signal);
      if (controller.signal.aborted || account.current !== accountId) return;
      if (value.accountId !== accountId || value.source !== 'wechat-contacts-live' || value.membershipComplete !== true ||
          !Array.isArray(value.contacts) || !Array.isArray(value.labels)) throw new Error('微信标签未完整读取，请刷新重试。');
      setAudience(value);
    } catch (failure) {
      if (!controller.signal.aborted && account.current === accountId) setTagError(failure.message);
    } finally {
      if (tagOperation.current === controller) { tagOperation.current = null; setTagBusy(false); }
    }
  };
  useEffect(() => {
    setAudience(null); setTagError(''); setTagBusy(false);
    return () => { tagOperation.current?.abort(); tagOperation.current = null; };
  }, [accountId]);
  useEffect(() => { if (canReadTags) void loadTags(); }, [accountId, canReadTags]);
  const loadPeople = async signal => {
    if (!accountId) return;
    const sequence = ++listReads.current, value = await rpc('memory.role.list', { accountId }, signal);
    if (!signal?.aborted && account.current === accountId && listReads.current === sequence) {
      setPeople(value.people); setListError(value.errors?.[0] || ''); setListing(false);
    }
  };
  const load = async signal => {
    if (!selected) return;
    const sequence = ++reads.current, value = await rpc('memory.role.get', scope, signal);
    if (!signal?.aborted && current.current === key && reads.current === sequence && !editingRef.current) {
      setDoc(value); setDraft(value.card);
    }
  };
  useEffect(() => {
    setPeople([]); setSelected(''); setListError(''); setQuery(''); setListing(!!accountId);
    if (!accountId) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        await loadPeople(controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted && account.current === accountId) { setListError(failure.message); setListing(false); }
      }
    };
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [accountId]);
  useEffect(() => {
    setDoc(null); setDraft(emptyRoleCard()); setEditing(false); editingRef.current = false;
    setError(''); setNotice(''); setBusy(false);
    const controller = new AbortController();
    const refresh = () => {
      if (editingRef.current || operation.current) return;
      void load(controller.signal).catch(failure => { if (!controller.signal.aborted && current.current === key) setError(failure.message); });
    };
    refresh(); const timer = setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(timer); operation.current?.abort(); operation.current = null; };
  }, [key]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!selected || !dialog) return;
    dialog.showModal();
    return () => {
      dialog.close();
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [selected]);
  useEffect(() => {
    if (editing) dialogRef.current?.querySelector('textarea')?.focus();
  }, [editing]);
  const run = async (endpoint, payload, message) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; reads.current++;
    setBusy(true); setError(''); setNotice('');
    try {
      await rpc(endpoint, payload, controller.signal);
      if (controller.signal.aborted || current.current !== key) return;
      if (endpoint === 'memory.role.save') { setEditing(false); editingRef.current = false; }
      await Promise.all([load(controller.signal), loadPeople(controller.signal)]);
      if (!controller.signal.aborted && current.current === key) setNotice(message);
    } catch (failure) { if (!controller.signal.aborted && current.current === key) setError(failure.message); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  };
  const search = query.trim();
  const { filtered, groups } = roleCardGroups(people, audience, query);
  const person = people.find(row => row.personId === selected);
  const name = doc?.card.label || person?.name || selected;
  const names = new Map();
  for (const row of people) names.set(row.name, (names.get(row.name) || 0) + 1);
  return <>
    <PageHead icon="people" title="人物角色卡" description="根据已有聊天与已读取的朋友圈资料创建角色卡，有实际资料的人才会出现在这里。">
      <AutomationLink onNavigate={onNavigate} from="memory" section="roles">自动整理设置</AutomationLink>
    </PageHead>
    <section className="wa-role-gallery" data-testid="role-cards-page">
      {!accountId ? <Empty icon="person" title="先连接微信账号" description="连接后，Agent 会从已有的授权聊天中整理人物资料。" /> : <>
        <div className="wa-role-gallery-head">
          <div><h2>全部人物<span>{people.length} 张角色卡</span></h2><p>按微信标签分组，每组资料项多的排在前面。</p></div>
          <Search value={query} onChange={setQuery} label="搜索人物角色卡" placeholder="搜索姓名、标签、称呼或喜好" />
        </div>
        <div className="wa-role-tag-tools">
          <p role="status">{tagBusy ? '正在读取微信标签…' : audience ? '多标签人物会出现在各自分组，共用同一张卡。' : '微信标签尚未读取，已有资料仍可查看。'}</p>
          <Button icon="refresh" aria-label="刷新微信标签" loading={tagBusy} disabled={!canReadTags || tagBusy} onClick={loadTags}>
            {audience ? '刷新微信标签' : '读取微信标签'}
          </Button>
        </div>
        {tagError && <p className="wa-alert is-error" role="alert">微信标签读取失败：{tagError}</p>}
        {listError && <p className="wa-alert is-error" role="alert">{listError}</p>}
        {!selected && error && <p className="wa-alert is-error" role="alert">{error}</p>}
        {!selected && notice && <p className="wa-alert is-success" role="status">{notice}</p>}
        {listing ? <Empty icon="people" title="正在读取人物角色卡" description="正在载入这个账号认识的人物…" /> : !people.length ?
          <Empty icon="person" title="正在从聊天中认识人物" description="整理出称呼、喜好等实际资料后才创建角色卡；只有姓名或发言记录的人暂不创建。">
            <Button icon="refresh" disabled={busy} onClick={() => run('memory.role.refresh', { accountId }, '已安排后台整理已有聊天，人物列表会自动刷新。')}>整理已有聊天</Button>
          </Empty> : !filtered.length ? <Empty icon="search" title="没有找到这个人物" description="换一个姓名、标签、称呼或喜好试试。">
            <Button onClick={() => setQuery('')}>显示全部人物</Button>
          </Empty> : <>
            {search && <p className="wa-role-search-result" role="status">找到 {filtered.length} 张角色卡</p>}
            <div className="wa-role-groups">
              {groups.map(group => <section className="wa-role-tag-group" data-testid="role-card-group" data-label-id={group.id} key={group.id}>
                <header className="wa-role-tag-head"><h3>{group.name}</h3><span>{group.people.length} 张角色卡</span></header>
                <div className="wa-role-grid" role="list" aria-label={group.name + '人物角色卡'}>
                  {group.people.map(row => <RolePersonCard key={row.personId} person={row} status={status} duplicate={names.get(row.name) > 1} onOpen={event => {
                    triggerRef.current = event.currentTarget; setSelected(row.personId);
                  }} />)}
                </div>
              </section>)}
            </div>
          </>}
      </>}
    </section>
    {selected && <dialog className="wa-role-dialog" data-testid="role-card-dialog" data-tone={roleTone(selected)} ref={dialogRef}
      aria-labelledby="wa-role-dialog-title" aria-modal="true" closedby={busy || editing ? 'none' : 'closerequest'}
      onKeyDown={event => { if (event.key === 'Escape' && (busy || editing)) event.preventDefault(); }}
      onCancel={event => { event.preventDefault(); if (!busy && !editing) setSelected(''); }}>
      <header className="wa-role-dialog-hero">
        <Button icon="close" className="wa-role-dialog-close" aria-label="关闭人物角色卡" disabled={busy || editing} onClick={() => setSelected('')}>关闭卡片</Button>
        <span className="wa-role-eyebrow">人物角色卡</span>
        <div className="wa-role-dialog-identity"><RoleAvatar name={name} large /><div><h2 id="wa-role-dialog-title">{name}</h2>
          <p>{roleSource(doc?.encounters || person?.encounters)}{doc?.card.addressAs ? ' · 称呼 ' + doc.card.addressAs : ''}</p></div></div>
      </header>
      <div className="wa-role-dialog-body">
        {error && <p className="wa-alert is-error" role="alert">{error}</p>}
        {notice && <p className="wa-alert is-success" role="status">{notice}</p>}
        {!doc ? <p className="wa-help">{error ? <Button onClick={() => { setError(''); void load().catch(failure => setError(failure.message)); }}>重新读取资料</Button> : '正在读取人物资料…'}</p> :
          <RoleCardDetails doc={doc} draft={draft} editing={editing} busy={busy} dirty={dirty} status={status}
            onChange={(field, value) => setDraft(previous => ({ ...previous, [field]: value }))}
            onRefresh={() => run('memory.role.refresh', scope, '已安排后台更新，聊天继续进行；整理完成后这里会自动刷新。')}
            onEdit={() => { editingRef.current = true; setEditing(true); setDraft(doc.card); setNotice(''); }}
            onSave={() => run('memory.role.save', { ...scope, card: draft, revision: doc.revision }, '已保存纠正；后续聊天会继续自动更新这张人物卡。')}
            onCancel={() => { setEditing(false); editingRef.current = false; setDraft(doc.card); setError(''); void load().catch(failure => setError(failure.message)); }} />}
      </div>
    </dialog>}
  </>;
}
