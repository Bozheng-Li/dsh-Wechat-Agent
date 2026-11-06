import React, { useEffect, useRef, useState } from 'react';
import { conversationKey, matchesSearch, peerId, peerName, peerType } from './client-utils.mjs';

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
        {doc.failedImages > 0 && <div className="wa-note-box"><p>{doc.failedImages} 张图片暂未理解，记忆中保留了失败原因。</p><Button disabled={!!busy || status.modelConfig.vision === false || !selected.authorized} onClick={() => act('memory.retryImages', selector(status, selected), '已重试图片理解，仍未能识别的图片会继续标注原因。')}>{busy === 'memory.retryImages' ? '正在重新理解…' : '重试图片理解'}</Button>{status.modelConfig.vision === false && <p className="wa-help">请先在模型的高级设置中启用图像理解。</p>}</div>}
        <Field label="已保存的记忆摘要" help="可以纠正记忆或补充长期信息。近期原文会继续附在后面。"><textarea className="wa-textarea" aria-label="记忆摘要" rows={10} maxLength={100000} value={summary} disabled={!!busy} onChange={event => setSummary(event.target.value)}/></Field>
        <div className="wa-row"><Button primary disabled={!!busy || summary === base?.summary} onClick={() => act('memory.edit', { ...selector(status, selected), summary, revision: base.revision }, '记忆摘要已保存。')}>保存记忆</Button><Button disabled={!!busy || doc.compacting || doc.chars <= doc.windowChars || !selected.authorized} onClick={() => act('memory.compress', selector(status, selected), '记忆已压缩，原文快照已保留。')}>{busy === 'memory.compress' || doc.compacting ? '正在压缩…' : '立即压缩'}</Button></div>
        <details className="wa-subsection"><summary>查看本次会带给 Agent 的完整记忆</summary><pre className="wa-memory-preview">{doc.text || '暂时没有记忆，新的授权会话消息会自动写入。'}</pre></details>
        <details className="wa-subsection"><summary>记忆文件保存位置</summary><div className="wa-path-value">{doc.path}</div><p className="wa-help">这是独立的记忆文件；聊天处理记录保存在另一个目录。压缩前的记忆保留在旁边的 archive 目录。</p></details>
        <div className="wa-subsection"><Button danger disabled={!!busy} onClick={() => setConfirmClear(true)}>清空当前记忆</Button>{confirmClear && <div className="wa-note-box"><p>清空“{peerName(selected)}”的当前记忆后，Agent 从新消息开始记忆。聊天记录和旧快照仍保留，但不会自动回填。</p><div className="wa-row"><Button danger disabled={!!busy} onClick={() => act('memory.clear', selector(status, selected), '当前记忆已清空，将从新消息开始积累。')}>确认清空这份记忆</Button><Button disabled={!!busy} onClick={() => setConfirmClear(false)}>返回</Button></div></div>}</div>
      </div> : <p className="wa-help wa-section-space">{selected ? '正在读取记忆…' : '选择一个会话，查看它记住了什么。'}</p>}
    </section>}
  </>;
}

const taskStates = { pending: '等待执行', running: '正在执行', paused: '已暂停', completed: '已完成', cancelled: '已取消', expired: '已过期', sent: '微信已确认', failed: '失败', unknown: '结果不明', partial: '部分已确认', queued: '等待处理' };
function localDateInput(ms) { const time = new Date(ms); return new Date(ms - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function scheduleLabel(schedule) { return schedule.kind === 'once' ? '一次性' : schedule.kind === 'daily' ? '每天 ' + schedule.time + '（北京时间）' : '每 ' + schedule.minutes + ' 分钟'; }
export function TasksPage({ rpc, status, rows, initialPeer }) {
  const peers = rows.filter(peer => peer.authorized), accountId = status.account?.id;
  const [selected, setSelected] = useState(() => initialPeer?.authorized ? initialPeer : peers[0] || null), [data, setData] = useState({ tasks: [], runs: [] });
  const [content, setContent] = useState(''), [kind, setKind] = useState('message'), [scheduleKind, setScheduleKind] = useState('once');
  const [at, setAt] = useState(() => localDateInput(Date.now() + 5 * 60000)), [dailyTime, setDailyTime] = useState('09:00'), [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [filter, setFilter] = useState('all');
  const request = useRef({ signature: '', id: '' });
  const reload = async signal => { if (accountId) { const result = await rpc('tasks.list', { accountId }, signal); if (!signal?.aborted) setData(result); } };
  useEffect(() => {
    const controller = new AbortController(); let timer;
    const poll = async () => { try { await reload(controller.signal); } catch (failure) { if (!controller.signal.aborted) setError(failure.message); } if (!controller.signal.aborted) timer = setTimeout(poll, 2000); };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [accountId]);
  const act = async (endpoint, payload, success) => {
    if (busy) return false; setBusy(endpoint); setError(''); setNotice('');
    try { await rpc(endpoint, payload); await reload(); setNotice(success); return true; } catch (failure) { setError(failure.message); return false; } finally { setBusy(''); }
  };
  const create = async event => {
    event.preventDefault();
    const schedule = scheduleKind === 'once' ? { kind: 'once', at: new Date(at).getTime() } : scheduleKind === 'daily' ? { kind: 'daily', time: dailyTime, timeZone: 'Asia/Shanghai' } : { kind: 'interval', minutes: Number(minutes) };
    const task = { kind, content, schedule }, target = selector(status, selected), signature = JSON.stringify({ target, task });
    if (signature !== request.current.signature) request.current = { signature, id: crypto.randomUUID() };
    if (await act('tasks.create', { ...target, task, requestId: request.current.id }, '任务已保存，到期后向选定会话执行。')) { setContent(''); request.current = { signature: '', id: '' }; }
  };
  const visible = data.tasks.filter(task => filter !== 'current' || selected && task.chatType === peerType(selected) && task.peerId === peerId(selected));
  return <><header className="wa-page-head"><div><p className="wa-eyebrow">SCHEDULED TASKS</p><h1>定时任务</h1><p className="wa-muted">安排消息或 Agent 任务，也可以在聊天中说“小胖，一分钟后提醒我吃饭”。</p></div></header>
    <Alert text={error || data.error}/>{notice && <p className="wa-alert" role="status">{notice}</p>}
    {!accountId ? <div className="wa-empty"><h3>先连接微信账号</h3><p>连接并授权会话后即可安排任务。</p></div> : <>
      <form className="wa-card wa-content-narrow" onSubmit={create} data-testid="task-create-form"><h2>新增任务</h2><p className="wa-help">任务保存在本地。插件运行、微信在线且会话获授权时执行；超过时间十分钟会跳过，避免补发过期提醒。</p>
        <RoomPicker rows={peers} value={selected} onChange={setSelected} authorizedOnly/>
        <Field label="做什么"><select className="wa-select" aria-label="任务类型" value={kind} onChange={event => setKind(event.target.value)}><option value="message">发送这段消息</option><option value="agent">让 Agent 执行任务并回复</option></select></Field>
        <Field label={kind === 'message' ? '发送内容' : '任务要求'} help={kind === 'agent' ? '到期后结合该会话记忆、人设与已开启的能力执行。' : '到期后原样发送这段文字。'}><textarea className="wa-textarea" aria-label="定时任务内容" rows={4} maxLength={4000} value={content} onChange={event => setContent(event.target.value)} placeholder={kind === 'agent' ? '例如：总结群里今天讨论的行动项。' : '例如：该吃饭啦。'}/></Field>
        <div className="wa-form-grid"><Field label="什么时候"><select className="wa-select" aria-label="任务执行方式" value={scheduleKind} onChange={event => setScheduleKind(event.target.value)}><option value="once">指定时间，仅一次</option><option value="daily">每天固定时间</option><option value="interval">按间隔重复</option></select></Field>
          {scheduleKind === 'once' ? <Field label="执行时间（当前设备时区）"><input className="wa-input" aria-label="任务执行时间" type="datetime-local" value={at} onChange={event => setAt(event.target.value)}/></Field> : scheduleKind === 'daily' ? <Field label="每天几点（北京时间）"><input className="wa-input" aria-label="每日执行时间" type="time" value={dailyTime} onChange={event => setDailyTime(event.target.value)}/></Field> : <Field label="每隔多少分钟"><input className="wa-input" aria-label="重复间隔分钟" type="number" min="1" max="525600" value={minutes} onChange={event => setMinutes(event.target.value)}/></Field>}
        </div><Button type="submit" primary disabled={!!busy || !selected || !content.trim() || !status.settings.enabled}>{busy === 'tasks.create' ? '正在保存…' : '保存定时任务'}</Button>{!status.settings.enabled && <p className="wa-help">请先在会话页开启自动回复。</p>}
      </form>
      <section className="wa-card wa-section-space"><div className="wa-between"><h2>已保存的任务</h2><select className="wa-select" aria-label="定时任务筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">当前账号全部会话</option><option value="current">仅上方选定会话</option></select></div>
        <div className="wa-task-list" data-testid="task-list">{visible.map(task => <article className="wa-task" key={task.id} data-task-id={task.id}>
          <div className="wa-between"><strong>{task.name}</strong><span className="wa-badge">{taskStates[task.state] || task.state}</span></div><p className="wa-task-content">{task.content}</p>
          <p className="wa-help">{task.kind === 'agent' ? 'Agent 任务' : '发送消息'} · {scheduleLabel(task.schedule)} · {task.source === 'chat' ? task.senderName + ' 在聊天中创建' : '管理员创建'}</p><p className="wa-help">{task.state === 'completed' ? '执行时间' : '计划时间'}：{date(task.nextRunAt)}</p>
          {task.lastState && <p className="wa-help">上次结果：{taskStates[task.lastState] || task.lastState}{task.lastError ? ' · ' + task.lastError : ''}</p>}
          <div className="wa-row">{task.state === 'pending' && <Button disabled={!!busy} onClick={() => act('tasks.pause', { accountId, taskId: task.id }, '任务已暂停。')}>暂停</Button>}{task.state === 'paused' && !['unknown', 'partial'].includes(task.lastState) && <Button disabled={!!busy} onClick={() => act('tasks.resume', { accountId, taskId: task.id }, '任务已恢复。')}>恢复</Button>}{['pending', 'paused', 'running'].includes(task.state) && <Button danger disabled={!!busy} onClick={() => act('tasks.cancel', { accountId, taskId: task.id }, '任务已取消；若已发送，请以回执记录为准。')}>取消任务</Button>}</div>
        </article>)}</div>{!visible.length && <p className="wa-help wa-section-space">还没有匹配的定时任务。</p>}
        <details className="wa-subsection"><summary>最近执行记录</summary>{data.runs.map(run => <p className="wa-help" key={run.id}>{date(run.startedAt)} · {taskStates[run.state] || run.state}{run.acknowledgedMessageIds?.length ? ' · 微信确认 ' + run.acknowledgedMessageIds.length + ' 条' : ''}{run.reason ? ' · ' + run.reason : ''}</p>)}{!data.runs.length && <p className="wa-help">暂无执行记录。</p>}</details>
      </section>
    </>}
  </>;
}
