import React, { useEffect, useRef, useState } from 'react';
import { conversationKey, formatTime, matchesSearch, peerId, peerName, peerType, searchText } from './client-utils.mjs';
import { taskViews } from './task-history.mjs';

const samePeer = (left, right) => left && right && conversationKey(left) === conversationKey(right);
const selector = (status, peer) => ({ accountId: status.account.id, chatType: peerType(peer), peerId: peerId(peer) });
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function Button({ primary, danger, ...props }) { return <button type="button" className={'wa-button' + (primary ? ' wa-primary' : '') + (danger ? ' wa-danger' : '')} {...props}/>; }
function Alert({ text }) { return text ? <div className="wa-alert is-error" role="alert">{text}</div> : null; }
function Field({ label, children, help }) { return <label className="wa-field wa-automation-field"><span className="wa-label">{label}</span>{children}{help && <span className="wa-help">{help}</span>}</label>; }
function RoomPicker({ rows, value, onChange, authorizedOnly = false }) {
  const [query, setQuery] = useState('');
  const filtered = rows.filter(peer => (!authorizedOnly || peer.authorized) && matchesSearch(peer, query));
  return <div className="wa-room-picker"><input className="wa-input" aria-label="按名字筛选会话" placeholder="输入群名或微信名查找" value={query} onChange={event => setQuery(event.target.value)}/>
    <select className="wa-select" aria-label="选择会话" value={value ? conversationKey(value) : ''} onChange={event => onChange(rows.find(peer => conversationKey(peer) === event.target.value) || null)}>
      <option value="">请选择一个会话</option>{value && !filtered.some(peer => samePeer(value, peer)) && <option value={conversationKey(value)}>{peerName(value)}</option>}
      {filtered.map(peer => <option key={conversationKey(peer)} value={conversationKey(peer)}>{peerType(peer) === 'group' ? '群聊' : '私聊'} · {peerName(peer)}{peer.authorized ? '' : ' · 已撤销授权'}</option>)}
    </select></div>;
}

function TaskRecipients({ rpc, accountId, peer, value, onChange, disabled }) {
  const [members, setMembers] = useState([]), [query, setQuery] = useState(''), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [revision, setRevision] = useState(0);
  const groupId = peer && peerType(peer) === 'group' ? peerId(peer) : '';
  useEffect(() => {
    if (!accountId || !groupId) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void (async () => {
      try {
        const result = await rpc('members', { accountId, chatType: 'group', peerId: groupId }, controller.signal);
        if (controller.signal.aborted) return;
        if (result?.accountId !== accountId || result?.peerId !== groupId || !Array.isArray(result.members)) throw new Error('群成员名单与当前账号或会话不匹配，请刷新后重试');
        const unique = new Map(result.members.filter(member => member?.id && (!member.groupId || member.groupId === groupId)).map(member => [member.id, member]));
        setMembers([...unique.values()].sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id, 'zh-CN'))); setLoaded(true);
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [accountId, groupId, revision]);
  if (!groupId) return peer ? <p className="wa-help">私聊任务会直接发送给对方，无需选择 @ 对象。</p> : null;
  const words = searchText(query).split(' ').filter(Boolean);
  const matching = members.filter(member => words.every(word => searchText([member.name, member.card, member.nickname, member.remark, member.alias].join(' ')).includes(word)));
  const duplicate = name => members.filter(member => (member.name || member.id) === name).length > 1;
  const toggle = member => onChange(value.some(target => target.id === member.id) ? value.filter(target => target.id !== member.id) : [...value, { id: member.id, name: member.name || member.id }]);
  const missing = loaded && value.some(target => !members.some(member => member.id === target.id));
  return <div className="wa-field wa-automation-field" data-testid="task-recipients"><div className="wa-between"><span className="wa-label">提醒对象（可选，可多选）</span><Button disabled={disabled || loading} onClick={() => setRevision(revision + 1)}>{loading ? '正在读取…' : '刷新成员'}</Button></div>
    <p className="wa-help">按群昵称、微信昵称或备注搜索，选中后到期会真正 @ 对方。不选择则发送普通消息，不 @ 所有人。</p>
    <input className="wa-input" aria-label="按名称查找提醒对象" placeholder="输入成员姓名，可模糊查找" value={query} disabled={disabled} onChange={event => setQuery(event.target.value)}/>
    <Alert text={error}/>
    <div role="group" aria-label="群成员提醒对象" style={{ maxHeight: 240, overflowY: 'auto' }}>
      {matching.slice(0, 60).map(member => { const name = member.name || member.id, checked = value.some(target => target.id === member.id); return <label className="wa-row" key={member.id} data-member-id={member.id}><input type="checkbox" checked={checked} disabled={disabled || !checked && value.length >= 20} onChange={() => toggle(member)}/><span>{name}{member.remark && member.remark !== name ? ` · 备注：${member.remark}` : ''}{duplicate(name) ? <small className="wa-help"> · 成员标识：{member.id}</small> : null}</span></label>; })}
      {!loading && !matching.length && <p className="wa-help">{query ? '已同步名单中没有匹配成员，请换个名字或刷新。' : '暂未同步到群成员。'}</p>}
    </div>
    {matching.length > 60 && <p className="wa-help">还有 {matching.length - 60} 位匹配成员，请输入更完整的名字缩小范围。</p>}
    <div aria-live="polite"><p className="wa-help">已选提醒对象：{value.length ? `${value.length} / 20 位` : '未选择'}</p>{value.length > 0 && <div className="wa-row">{value.map(target => <Button key={target.id} disabled={disabled} aria-label={'移除提醒对象 ' + target.name} onClick={() => onChange(value.filter(item => item.id !== target.id))}>@{members.find(member => member.id === target.id)?.name || target.name} ×</Button>)}</div>}</div>
    {missing && <p className="wa-task-warning">有已选成员暂不在这份名单中，请刷新并核对；保存时不会忽略失效对象。</p>}
    <p className="wa-help">这里只显示当前账号在此群已同步的成员，名单可能不完整。未出现的成员可先在群内发言，等待同步后刷新。发送前会再次核对。</p>
  </div>;
}

export function MemoryPage({ rpc, status, rows, initialPeer }) {
  const [selected, setSelected] = useState(() => initialPeer || rows[0] || null), [list, setList] = useState(null), [doc, setDoc] = useState(null);
  const [windowChars, setWindowChars] = useState(String(status.memory?.windowChars || 32000)), [summary, setSummary] = useState(''), [base, setBase] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirmClear, setConfirmClear] = useState(false);
  const draft = useRef({ summary, base }); draft.current = { summary, base };
  const current = useRef(selected); current.current = selected;
  const accountId = status.account?.id;
  const reload = async (force = false, signal) => {
    if (!accountId) return;
    const data = await rpc('memory.list', { accountId }, signal); if (signal?.aborted) return; setList(data);
    const selectedAtStart = current.current;
    if (selectedAtStart) {
      const next = await rpc('memory.get', selector(status, selectedAtStart), signal);
      if (signal?.aborted || !samePeer(current.current, selectedAtStart)) return;
      setDoc(next);
      if (force || !draft.current.base || draft.current.summary === draft.current.base.summary) { setSummary(next.summary); setBase(next); }
    }
  };
  useEffect(() => {
    const controller = new AbortController(); let timer;
    const poll = async () => { try { await reload(false, controller.signal); } catch (failure) { if (!controller.signal.aborted) setError(failure.message); } if (!controller.signal.aborted) timer = setTimeout(poll, 3000); };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [accountId, selected && conversationKey(selected)]);
  const act = async (endpoint, payload, success) => {
    if (busy) return; setBusy(endpoint); setError(''); setNotice('');
    try { await rpc(endpoint, payload); await reload(true); setNotice(success); setConfirmClear(false); }
    catch (failure) { setError(failure.message); } finally { setBusy(''); }
  };
  const choose = peer => { setSelected(peer); current.current = peer; setDoc(null); setSummary(''); setBase(null); draft.current = { summary: '', base: null }; setConfirmClear(false); setError(''); setNotice(''); };
  return <><header className="wa-page-head"><div><p className="wa-eyebrow">CONVERSATION MEMORY</p><h1>会话记忆库</h1><p className="wa-muted">每个会话保存自己的记忆，回复时一起交给 Agent；达到窗口后自动压缩。</p></div></header>
    <Alert text={error}/>{notice && <p className="wa-alert" role="status">{notice}</p>}
    <section className="wa-card wa-content-narrow"><h2>默认记忆窗口</h2><p className="wa-help">按交给模型的记忆文字计数。原文和压缩前快照独立保存；压缩不会修改聊天处理记录。</p>
      <div className="wa-row wa-section-space wa-window-setting"><input className="wa-input" type="number" min="1000" max="200000" step="1000" aria-label="默认记忆窗口字符数" value={windowChars} onChange={event => setWindowChars(event.target.value)}/><span>字</span><Button disabled={!!busy || !Number.isInteger(Number(windowChars)) || Number(windowChars) < 1000 || Number(windowChars) > 200000} onClick={() => act('memory.configure', { windowChars: Number(windowChars) }, '默认记忆窗口已保存。')}>保存窗口</Button></div>
      <p className="wa-help">每个会话也可在“会话设置”中单独设置。默认 {list?.windowChars || status.memory?.windowChars || 32000} 字。</p>
    </section>
    {!accountId ? <div className="wa-empty"><h3>先连接微信账号</h3><p>连接后可查看这个账号的会话记忆。</p></div> : <section className="wa-card wa-section-space">
      <RoomPicker rows={rows} value={selected} onChange={choose}/>
      {doc ? <div className="wa-memory-content" data-testid="memory-document">
        <div className="wa-between wa-section-space"><div><h2>{peerName(selected)}</h2><p className="wa-help">{doc.chars} / {doc.windowChars} 字 · {doc.entries.length} 条近期消息 · 已压缩 {doc.compressions} 次{doc.compacting ? ' · 正在压缩' : ''}</p></div><Button disabled={!!busy} onClick={() => { void reload(true).catch(failure => setError(failure.message)); }}>重新读取记忆</Button></div>
        <Alert text={doc.error}/>
        {(doc.failedImages > 0 || doc.lowQualityImages > 0) && <div className="wa-note-box">
          {doc.failedImages > 0 && <p>{doc.failedImages} 张图片暂未理解，记忆中保留了失败原因。</p>}
          {doc.lowQualityImages > 0 && <p>{doc.lowQualityImages} 张图片仅有缩略图笔记或尚未核实清晰度，可以重新获取清晰图片后理解。</p>}
          <Button disabled={!!busy || status.modelConfig.vision === false || !selected.authorized} onClick={() => act('memory.retryImages', selector(status, selected), '已重新获取图片并重试理解，未取得清晰图片的笔记会保留清晰度提示。')}>{busy === 'memory.retryImages' ? '正在重新理解…' : '重试图片理解'}</Button>
          {status.modelConfig.vision === false && <p className="wa-help">请先在模型的高级设置中启用图像理解。</p>}
        </div>}
        <Field label="已保存的记忆摘要" help="可以纠正记忆或补充长期信息。近期原文会继续附在后面。"><textarea className="wa-textarea" aria-label="记忆摘要" rows={10} maxLength={100000} value={summary} disabled={!!busy} onChange={event => setSummary(event.target.value)}/></Field>
        <div className="wa-row"><Button primary disabled={!!busy || summary === base?.summary} onClick={() => act('memory.edit', { ...selector(status, selected), summary, revision: base.revision }, '记忆摘要已保存。')}>保存记忆</Button><Button disabled={!!busy || doc.compacting || doc.chars <= doc.windowChars || !selected.authorized} onClick={() => act('memory.compress', selector(status, selected), '记忆已压缩，原文快照已保留。')}>{busy === 'memory.compress' || doc.compacting ? '正在压缩…' : '立即压缩'}</Button></div>
        <details className="wa-subsection"><summary>查看本次会带给 Agent 的完整记忆</summary><pre className="wa-memory-preview">{doc.text || '暂时没有记忆，新的授权会话消息会自动写入。'}</pre></details>
        <details className="wa-subsection"><summary>记忆文件保存位置</summary><div className="wa-path-value">{doc.path}</div><p className="wa-help">这是独立的记忆文件；聊天处理记录保存在另一个目录。压缩前的记忆保留在旁边的 archive 目录。</p></details>
        <div className="wa-subsection"><Button danger disabled={!!busy} onClick={() => setConfirmClear(true)}>清空当前记忆</Button>{confirmClear && <div className="wa-note-box"><p>清空“{peerName(selected)}”的当前记忆后，Agent 从新消息开始记忆。聊天记录和旧快照仍保留，但不会自动回填。</p><div className="wa-row"><Button danger disabled={!!busy} onClick={() => act('memory.clear', selector(status, selected), '当前记忆已清空，将从新消息开始积累。')}>确认清空这份记忆</Button><Button disabled={!!busy} onClick={() => setConfirmClear(false)}>返回</Button></div></div>}</div>
      </div> : <p className="wa-help wa-section-space">{selected ? '正在读取记忆…' : '选择一个会话，查看它记住了什么。'}</p>}
    </section>}
  </>;
}

const taskStates = { pending: '等待执行', running: '正在执行', paused: '已暂停', completed: '已完成', cancelled: '已取消', expired: '已过期', sent: '微信已确认', failed: '失败', unknown: '结果不明', partial: '部分已确认', queued: '等待处理', settling: '等待最终结果' };
function localDateInput(ms) { const time = new Date(ms); return new Date(ms - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function scheduleLabel(schedule) { return schedule.kind === 'once' ? '一次性' : schedule.kind === 'daily' ? '每天 ' + schedule.time + '（北京时间）' : '每 ' + schedule.minutes + ' 分钟'; }
function TaskBadge({ state }) { return <span className={'wa-task-badge is-' + state}>{taskStates[state] || state}</span>; }
function TaskDetails({ task, runs = [] }) {
  return <div className="wa-task-detail-content"><p className="wa-task-content">{task.content}</p><div className="wa-task-facts">
    <span>{task.kind === 'agent' ? 'Agent 任务' : '发送消息'} · {scheduleLabel(task.schedule)}</span><span>{task.source === 'chat' ? task.senderName + ' 在聊天中创建' : '管理员创建'}</span>
    {task.targets?.length > 0 && <span>提醒对象：{task.targets.map(target => '@' + target.name).join('、')}</span>}
    <span>创建时间：{date(task.createdAt)}</span><span>{task.state === 'pending' ? '下次计划' : '计划时间'}：{date(task.nextRunAt)}</span>
    {task.state === 'cancelled' && <span>状态更新：{date(task.updatedAt)}</span>}
  </div>{task.lastError && <p className="wa-task-warning">{task.lastError}</p>}
    {runs.length > 0 && <div className="wa-task-executions"><h3>最近执行记录</h3>{runs.map(run => <div className="wa-task-execution" key={run.id}>
      <div className="wa-row"><TaskBadge state={run.state}/><span>{run.finishedAt ? '结束时间：' + date(run.finishedAt) : '开始时间：' + date(run.startedAt)}</span></div>
      <p className="wa-help">本次计划：{date(run.scheduledAt)}{run.acknowledgedMessageIds?.length ? ` · 微信确认 ${run.acknowledgedMessageIds.length} 条` : ''}</p>
      {run.reason && <p className="wa-task-warning">{run.reason}</p>}{run.acknowledgedMessageIds?.length > 0 && <p className="wa-help wa-task-receipts">回执：{run.acknowledgedMessageIds.join('、')}</p>}
    </div>)}</div>}
  </div>;
}
export function TasksPage({ rpc, status, rows, initialPeer }) {
  const peers = rows.filter(peer => peer.authorized), accountId = status.account?.id;
  const [selected, setSelected] = useState(() => initialPeer?.authorized ? initialPeer : peers[0] || null), [data, setData] = useState({ tasks: [], runs: [] });
  const [content, setContent] = useState(''), [kind, setKind] = useState('message'), [scheduleKind, setScheduleKind] = useState('once');
  const [at, setAt] = useState(() => localDateInput(Date.now() + 5 * 60000)), [dailyTime, setDailyTime] = useState('09:00'), [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [filter, setFilter] = useState('all');
  const [view, setView] = useState('current'), [query, setQuery] = useState(''), [page, setPage] = useState(0), [showCreate, setShowCreate] = useState(false), [loaded, setLoaded] = useState(false);
  const [targets, setTargets] = useState([]);
  const request = useRef({ signature: '', id: '' });
  const mounted = useRef(true), actionController = useRef(null);
  const reload = async signal => { if (accountId) { const result = await rpc('tasks.list', { accountId }, signal); if (!signal?.aborted && mounted.current) { setData(result); setLoaded(true); } } };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionController.current?.abort(); }; }, []);
  useEffect(() => { setPage(0); }, [view, query, filter]);
  useEffect(() => {
    const controller = new AbortController(); let timer;
    const poll = async () => { try { await reload(controller.signal); } catch (failure) { if (!controller.signal.aborted) setError(failure.message); } if (!controller.signal.aborted) timer = setTimeout(poll, 2000); };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [accountId]);
  const act = async (endpoint, payload, success) => {
    if (busy) return false; setBusy(endpoint); setError(''); setNotice('');
    const controller = new AbortController(); actionController.current = controller;
    try { await rpc(endpoint, payload, controller.signal); await reload(controller.signal); if (!mounted.current || controller.signal.aborted) return false; setNotice(success); return true; }
    catch (failure) { if (mounted.current) setError(failure.message); return false; } finally { if (mounted.current) setBusy(''); if (actionController.current === controller) actionController.current = null; }
  };
  const create = async event => {
    event.preventDefault();
    if (!selected || busy) return;
    const schedule = scheduleKind === 'once' ? { kind: 'once', at: new Date(at).getTime() } : scheduleKind === 'daily' ? { kind: 'daily', time: dailyTime, timeZone: 'Asia/Shanghai' } : { kind: 'interval', minutes: Number(minutes) };
    const task = { kind, content, schedule, targets }, target = selector(status, selected), signature = JSON.stringify({ target, task });
    if (signature !== request.current.signature) request.current = { signature, id: crypto.randomUUID() };
    if (await act('tasks.create', { ...target, task, requestId: request.current.id }, '任务已保存，到期后向选定会话执行。')) { setContent(''); setTargets([]); setShowCreate(false); setView('current'); setFilter('all'); setQuery(''); request.current = { signature: '', id: '' }; }
  };
  const words = searchText(query).split(' ').filter(Boolean);
  const visible = data.tasks.filter(task => (filter === 'all' || conversationKey(task) === filter) && words.every(word => searchText([task.name, task.content, task.senderName, ...(task.targets || []).map(target => target.name)].join(' ')).includes(word)));
  const views = taskViews(visible, data.runs), entries = views[view], pageCount = Math.max(1, Math.ceil(entries.length / 20)), currentPage = Math.min(page, pageCount - 1);
  const pageEntries = entries.slice(currentPage * 20, currentPage * 20 + 20);
  const rooms = [...new Map(data.tasks.map(task => [conversationKey(task), task])).values()];
  return <><header className="wa-page-head"><div><p className="wa-eyebrow">SCHEDULED TASKS</p><h1>定时任务</h1><p className="wa-muted">查看接下来要做的事，已结束的任务归入历史记录。</p></div>{accountId && <Button primary data-testid="task-create-toggle" aria-expanded={showCreate} aria-controls="wa-task-create" disabled={!!busy} onClick={() => setShowCreate(value => !value)}>{showCreate ? '收起新增' : '新增任务'}</Button>}</header>
    <Alert text={error || data.error}/>{notice && <p className="wa-alert" role="status">{notice}</p>}
    {!accountId ? <div className="wa-empty"><h3>先连接微信账号</h3><p>连接并授权会话后即可安排任务。</p></div> : <>
      {showCreate && <form id="wa-task-create" className="wa-card wa-task-create" onSubmit={create} data-testid="task-create-form"><h2>安排一个任务</h2><p className="wa-help">插件运行、微信在线且会话获授权时执行；超过时间十分钟会跳过。</p><fieldset disabled={!!busy} className="wa-task-fields">
        <RoomPicker rows={peers} value={selected} onChange={peer => { setSelected(peer); setTargets([]); }} authorizedOnly/>
        <TaskRecipients key={accountId + ':' + (selected ? conversationKey(selected) : '')} rpc={rpc} accountId={accountId} peer={selected} value={targets} onChange={setTargets} disabled={!!busy}/>
        <Field label="做什么"><select className="wa-select" aria-label="任务类型" value={kind} onChange={event => setKind(event.target.value)}><option value="message">发送这段消息</option><option value="agent">让 Agent 执行任务并回复</option></select></Field>
        <Field label={kind === 'message' ? '发送内容' : '任务要求'} help={kind === 'agent' ? '到期后结合该会话记忆、人设与已开启的能力执行。' : '到期后原样发送这段文字。'}><textarea className="wa-textarea" aria-label="定时任务内容" rows={4} maxLength={4000} value={content} onChange={event => setContent(event.target.value)} placeholder={kind === 'agent' ? '例如：总结群里今天讨论的行动项。' : '例如：该吃饭啦。'}/></Field>
        <div className="wa-form-grid"><Field label="什么时候"><select className="wa-select" aria-label="任务执行方式" value={scheduleKind} onChange={event => setScheduleKind(event.target.value)}><option value="once">指定时间，仅一次</option><option value="daily">每天固定时间</option><option value="interval">按间隔重复</option></select></Field>
          {scheduleKind === 'once' ? <Field label="执行时间（当前设备时区）"><input className="wa-input" aria-label="任务执行时间" type="datetime-local" value={at} onChange={event => setAt(event.target.value)}/></Field> : scheduleKind === 'daily' ? <Field label="每天几点（北京时间）"><input className="wa-input" aria-label="每日执行时间" type="time" value={dailyTime} onChange={event => setDailyTime(event.target.value)}/></Field> : <Field label="每隔多少分钟"><input className="wa-input" aria-label="重复间隔分钟" type="number" min="1" max="525600" value={minutes} onChange={event => setMinutes(event.target.value)}/></Field>}
        </div><div className="wa-row"><Button type="submit" primary disabled={!!busy || !selected || !content.trim() || !status.settings.enabled}>{busy === 'tasks.create' ? '正在保存…' : '保存定时任务'}</Button><Button onClick={() => setShowCreate(false)}>收起，保留草稿</Button></div>{!status.settings.enabled && <p className="wa-help">请先在会话页开启自动回复。</p>}</fieldset>
      </form>}
      <section className="wa-card wa-task-workspace">
        <div className="wa-task-toolbar"><div className="wa-task-tabs" role="tablist" aria-label="任务视图">{[['current', '当前任务'], ['history', '历史记录']].map(([key, label]) => <button type="button" role="tab" id={'wa-task-tab-' + key} aria-controls="wa-task-panel" aria-selected={view === key} tabIndex={view === key ? 0 : -1} data-testid={'task-tab-' + key} key={key} onClick={() => setView(key)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'current' : event.key === 'End' ? 'history' : key === 'current' ? 'history' : 'current'; setView(next); document.getElementById('wa-task-tab-' + next)?.focus(); }}>{label}<span>{views[key].length}</span></button>)}</div>
          <div className="wa-task-tools"><input className="wa-input" aria-label="搜索定时任务" placeholder="搜索内容或会话" value={query} onChange={event => setQuery(event.target.value)}/><select className="wa-select" aria-label="定时任务筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部会话</option>{rooms.map(task => <option key={conversationKey(task)} value={conversationKey(task)}>{task.name}</option>)}</select></div></div>
        {!status.settings.enabled && <p className="wa-task-warning">自动回复已关闭，定时任务暂不执行。</p>}
        {view === 'history' && <p className="wa-help wa-task-history-hint">每个任务保留一条记录；展开可查看完整内容、最近执行和微信回执。</p>}
        <div id="wa-task-panel" role="tabpanel" aria-labelledby={'wa-task-tab-' + view}>
          {view === 'current' ? <div className="wa-task-list" data-testid="task-list">{pageEntries.map(task => <article className="wa-task" key={task.id} data-task-id={task.id}>
            <div className="wa-task-main"><div className="wa-task-heading"><h3>{task.content}</h3><p className="wa-help">{task.name} · {task.kind === 'agent' ? 'Agent 任务' : '发送消息'} · {scheduleLabel(task.schedule)}</p>{task.targets?.length > 0 && <p className="wa-help">提醒对象：{task.targets.map(target => '@' + target.name).join('、')}</p>}</div>
              <div className="wa-task-next"><span>{task.state === 'running' ? '本次计划' : task.state === 'paused' ? '原计划' : '下次执行'}</span><time>{formatTime(task.nextRunAt)}</time></div><TaskBadge state={task.state}/>
              <div className="wa-task-actions">{task.state === 'pending' && <Button disabled={!!busy} onClick={() => act('tasks.pause', { accountId, taskId: task.id }, '任务已暂停。')}>暂停</Button>}{task.state === 'paused' && !['unknown', 'partial'].includes(task.lastState) && <Button disabled={!!busy} onClick={() => act('tasks.resume', { accountId, taskId: task.id }, '任务已恢复。')}>恢复</Button>}<Button danger disabled={!!busy} onClick={() => act('tasks.cancel', { accountId, taskId: task.id }, '任务已取消，已移入历史记录；发送结果以回执为准。')}>取消任务</Button></div>
            </div>{task.lastState && ['failed', 'unknown', 'partial', 'cancelled', 'expired'].includes(task.lastState) && <p className="wa-task-warning">{taskStates[task.lastState]}{task.lastError ? ' · ' + task.lastError : ''}</p>}
            <details className="wa-task-details"><summary>查看详情</summary><TaskDetails task={task}/></details>
          </article>)}</div> : <div className="wa-task-history" data-testid="task-history">
            {pageEntries.length > 0 && <div className="wa-task-history-head"><span>记录时间</span><span>任务与会话</span><span>结果</span><span/></div>}
            {pageEntries.map(entry => <details className="wa-task-history-row" key={entry.task.id} data-task-id={entry.task.id}>
              <summary><time>{formatTime(entry.timestamp)}</time><div className="wa-task-history-title"><strong>{entry.task.content}</strong><span>{entry.task.name} · {scheduleLabel(entry.task.schedule)}{entry.task.state === 'cancelled' && entry.result === 'sent' ? ' · 已有微信确认，请以回执为准' : ''}</span></div><div className="wa-task-history-result"><TaskBadge state={entry.state}/>{entry.result && entry.result !== entry.state && entry.state !== 'completed' && <small>{taskStates[entry.result] || entry.result}</small>}</div><span className="wa-task-expand" aria-hidden="true">⌄</span></summary>
              <TaskDetails task={entry.task} runs={entry.runs}/>
            </details>)}
          </div>}
          {!entries.length && <div className="wa-empty wa-task-empty"><h3>{!loaded ? '正在读取任务…' : query || filter !== 'all' ? '没有匹配的任务' : view === 'current' ? '暂无待执行任务' : '暂无历史记录'}</h3><p>{query || filter !== 'all' ? '试试其他关键词或切换到全部会话。' : view === 'current' ? '可以点击右上方新增，也可以在聊天中安排提醒。' : '任务结束后会保留在这里，执行过的循环任务也可查看最近结果。'}</p></div>}
        </div>
        {entries.length > 20 && <div className="wa-task-pagination"><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage * 20 + 1}–{Math.min(currentPage * 20 + 20, entries.length)} / {entries.length}</span><Button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
      </section>
    </>}
  </>;
}
