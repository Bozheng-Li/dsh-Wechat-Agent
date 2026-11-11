import { useEffect, useRef, useState } from 'react';
import { PageHead } from '../../components/page-ui.jsx';
import { Button } from '../../components/button.jsx';
import { conversationKey, peerId, peerName, peerType } from '../../shared/conversations.mjs';
import { emptyRoleCard, ROLE_CARD_FIELDS } from '../../../shared/role-card.mjs';

export function RoleCardsPage({ rpc, status, rows = [] }) {
  const accountId = status.account?.id;
  const [selected, setSelected] = useState(''), [doc, setDoc] = useState(null), [draft, setDraft] = useState(emptyRoleCard),
    [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const target = rows.find(peer => conversationKey(peer) === selected),
    scope = target ? { accountId, chatType: peerType(target), peerId: peerId(target) } : null,
    key = JSON.stringify([accountId, selected]), current = useRef(key), operation = useRef(null), reads = useRef(0);
  current.current = key;
  const dirty = !!doc && JSON.stringify(draft) !== JSON.stringify(doc.card);
  const load = async signal => {
    if (!scope) return;
    const sequence = ++reads.current, value = await rpc('memory.role.get', scope, signal);
    if (!signal?.aborted && current.current === key && reads.current === sequence) { setDoc(value); setDraft(value.card); }
  };
  useEffect(() => { setSelected(''); }, [accountId]);
  useEffect(() => {
    setDoc(null); setDraft(emptyRoleCard()); setError(''); setNotice(''); setBusy(false);
    const controller = new AbortController();
    if (scope) void load(controller.signal).catch(failure => { if (!controller.signal.aborted && current.current === key) setError(failure.message); });
    return () => { controller.abort(); operation.current?.abort(); operation.current = null; };
  }, [key]);
  const save = async () => {
    if (!doc || !scope || operation.current) return;
    const controller = new AbortController(); operation.current = controller; reads.current++;
    setBusy(true); setError(''); setNotice('');
    try {
      await rpc('memory.role.save', { ...scope, card: draft, revision: doc.revision }, controller.signal);
      if (controller.signal.aborted || current.current !== key) return;
      await load(controller.signal);
      if (!controller.signal.aborted && current.current === key) setNotice('角色卡已保存，从下一轮回复生效。原有记忆已保留。');
    } catch (failure) { if (!controller.signal.aborted && current.current === key) setError(failure.message); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  };
  return <>
    <PageHead icon="memory" title="会话角色卡" description="全局助手作为默认，每个会话可以有自己的称呼、关系和说话方式。" />
    {!accountId ? <div className="wa-empty"><h3>先连接微信账号</h3><p>角色卡与记忆按账号和会话分别保存。</p></div> :
      <section className="wa-document-section" data-testid="role-cards-page">
        <label className="wa-field"><span className="wa-label">选择会话</span>
          <select className="wa-select" aria-label="角色卡所属会话" value={selected} disabled={busy || dirty}
            onChange={event => setSelected(event.target.value)}>
            <option value="">请选择一个会话</option>
            {rows.map(peer => <option key={conversationKey(peer)} value={conversationKey(peer)}>{peerType(peer) === 'group' ? '群聊' : '私聊'} · {peerName(peer)}</option>)}
          </select>
        </label>
        {error && <p className="wa-alert is-error" role="alert">{error}</p>}
        {notice && <p className="wa-alert is-success" role="status">{notice}</p>}
        {selected && !doc && <p className="wa-help">{error ? '未能读取这张角色卡。' : '正在读取角色卡…'}</p>}
        {selected && <Button disabled={busy || dirty} onClick={() => { setError(''); void load().catch(failure => { if (current.current === key) setError(failure.message); }); }}>重新读取角色卡</Button>}
        {doc && <div className="wa-section-space">
          <p className="wa-help">{doc.inherited ? '当前沿用全局助手。' : '当前使用此会话的角色卡。'} 留空的内容沿用默认。改名、换说话方式或恢复默认都保留本会话的 {doc.factCount} 条记忆。</p>
          {[
            ['label', '角色卡名称', '例如：项目伙伴、老朋友'],
            ['addressAs', '平时称呼对方', '例如：阿宁；群聊可留空，避免把所有成员叫成同一个人'],
            ['relationship', '相处关系', '例如：熟悉的同事，讨论工作直接一些'],
            ['style', '表达方式', '例如：简短、自然，先说有用的结论；聊天时可以轻松一些'],
          ].map(([field, label, placeholder]) => <label className="wa-field wa-section-space" key={field}>
            <span className="wa-label">{label}</span>
            {field === 'style' ? <textarea className="wa-textarea" aria-label={label} rows={6} maxLength={ROLE_CARD_FIELDS[field]}
              placeholder={placeholder} value={draft[field]} disabled={busy} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /> :
              <input className="wa-input" aria-label={label} maxLength={ROLE_CARD_FIELDS[field]}
                placeholder={placeholder} value={draft[field]} disabled={busy} onChange={event => setDraft({ ...draft, [field]: event.target.value })} />}
          </label>)}
          <div className="wa-long-tools">
            <Button primary disabled={busy || !dirty} onClick={save}>保存角色卡</Button>
            <Button disabled={busy || !dirty} onClick={() => { setDraft(doc.card); setError(''); }}>撤销修改</Button>
            <Button disabled={busy || Object.values(draft).every(value => !value)} onClick={() => setDraft(emptyRoleCard())}>恢复默认角色</Button>
          </div>
          <p className="wa-help wa-section-space">新事实会保留人物和原始依据，群成员不会共用个人偏好。旧记忆仍留在来源会话，无法确定人物的内容不会自动归到当前发言者。事实可在“长期记忆”和“维护”中查看。</p>
        </div>}
      </section>}
  </>;
}
