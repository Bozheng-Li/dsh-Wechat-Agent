import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CHANNEL } from './contracts.mjs';

export const inject = ['slots', 'connection', 'modelDirectories'];
const PANEL_ID = 'wechat-agent';
const stateLabels = { queued: '等待处理', generating: '正在回复', sending: '等待微信回执', sent: '微信已确认', cancelled: '已取消', failed: '失败', unknown: '发送结果不明', partial: '部分已确认', skipped: '未回复' };
const loginLabels = { idle: '尚未登录', requesting: '正在获取二维码', waiting: '请用手机微信扫码', scanned: '已扫码，请在手机确认', confirmed: '正在认证', authenticating: '正在认证', 'session-ready': '正在连接微信', connecting: '正在连接微信', expired: '二维码已过期', cancelled: '登录已取消', failed: '登录失败', offline: '微信离线', online: '微信已连接' };
const css = `
.wa-panel{height:100%;overflow:auto;color:var(--text-primary,#e5e7eb);background:var(--background-primary,transparent);font:14px/1.6 system-ui,sans-serif;box-sizing:border-box}.wa-panel *{box-sizing:border-box}.wa-wrap{max-width:1080px;padding:32px 28px 60px;margin:auto}.wa-top{display:flex;gap:18px;align-items:flex-start;justify-content:space-between;margin-bottom:24px}.wa-panel h1{font-size:25px;line-height:1.3;font-weight:650;letter-spacing:-.5px;margin:0 0 6px}.wa-panel h2{font-size:16px;font-weight:600;margin:0 0 16px}.wa-panel p{margin:5px 0}.wa-muted{color:var(--text-secondary,#9199a8);font-size:13px}.wa-grid{display:grid;grid-template-columns:1fr 1.3fr;gap:18px;align-items:start}.wa-card{border:1px solid #81889830;border-radius:12px;padding:22px;background:#81889806;margin-bottom:18px;min-width:0}.wa-badge{font-size:12px;padding:4px 10px;border-radius:20px;white-space:nowrap;background:#81889820}.wa-online{background:#29b87822;color:#47ba89}.wa-row{display:flex;flex-wrap:wrap;gap:9px;align-items:center}.wa-panel button{font:inherit;border:1px solid #81889850;border-radius:7px;background:transparent;color:inherit;padding:7px 12px;cursor:pointer}.wa-panel button:hover{background:#81889818}.wa-panel button:disabled{opacity:.45;cursor:default}.wa-panel button.wa-primary{background:#167552;border-color:#167552;color:white}.wa-panel button.wa-primary:hover{background:#1b8760}.wa-panel textarea,.wa-panel select{display:block;width:100%;font:inherit;color:inherit;background:#8188980a;border:1px solid #81889845;border-radius:7px;padding:9px 11px;resize:vertical}.wa-panel select option{background:#25282d;color:#eee}.wa-panel label{display:block;margin:16px 0 6px}.wa-panel .wa-switch{display:flex;gap:10px;align-items:center;margin:0 0 14px;cursor:pointer}.wa-panel input[type=checkbox]{accent-color:#269a70;width:17px;height:17px}.wa-panel textarea:focus,.wa-panel button:focus-visible,.wa-panel select:focus{outline:2px solid #31a778;outline-offset:2px}.wa-alert{padding:11px 14px;border-radius:8px;background:#dc925219;color:#db985f;margin:12px 0;overflow-wrap:anywhere}.wa-success{background:#29b87815;color:#54b68e}.wa-qr{display:block;width:220px;max-width:100%;height:auto;background:white;border-radius:8px;margin:20px auto}.wa-detail{margin:14px 0;overflow-wrap:anywhere}.wa-detail strong{display:block;font-size:16px}.wa-section{margin-top:16px}.wa-history{border-top:1px solid #81889825;padding:15px 0}.wa-history:first-of-type{border-top:0}.wa-history summary{cursor:pointer;display:flex;gap:10px;align-items:center;justify-content:space-between;list-style:none}.wa-history p{white-space:pre-wrap;overflow-wrap:anywhere}.wa-preview{max-width:68%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wa-id{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}.wa-empty{padding:24px 0;text-align:center;color:var(--text-secondary,#9199a8)}@media(max-width:800px){.wa-grid{grid-template-columns:1fr}.wa-wrap{padding:20px 16px}.wa-top{flex-wrap:wrap}.wa-card{padding:18px}}
.wa-panel{color:inherit}
`;

async function call(connection, endpoint, payload = {}, signal) {
  const result = await connection.rpc.call(CHANNEL, endpoint, payload, signal);
  if (!result.ok) throw new Error(result.error?.message || '微信插件操作失败');
  return result.value;
}

const modelKey = selection => selection ? JSON.stringify([selection.provider, selection.model]) : '';

function ModelPicker({ catalog, status, blocked, busy, notice, onSelect }) {
  const snapshot = useSyncExternalStore(catalog.store.subscribe, catalog.store.getSnapshot);
  useEffect(() => { void catalog.load().catch(() => {}); }, [catalog]);
  const groups = snapshot.value?.groups ?? [], choice = status.modelChoice;
  const find = selection => groups.find(group => group.id === selection?.provider)?.models.find(model => model.id === selection?.model);
  const defaultModel = snapshot.value?.default ?? status.defaultModel;
  const defaultName = find(defaultModel)?.name || defaultModel?.model;
  const missing = choice && !find(choice), loading = ['idle', 'loading'].includes(snapshot.status);
  return <section className="wa-card wa-model-card"><h2>回复模型</h2>
    <label htmlFor="wa-model">选择模型</label>
    <select id="wa-model" value={modelKey(choice)} disabled={blocked} aria-describedby="wa-model-help" onChange={event => {
      const pair = event.target.value ? JSON.parse(event.target.value) : null;
      void onSelect(pair ? { provider: pair[0], model: pair[1] } : null);
    }}>
      <option value="">跟随 DSH 默认{defaultName ? `（${defaultName}）` : ''}</option>
      {missing && <option value={modelKey(choice)} disabled>{choice.model} · {snapshot.status === 'ready' ? '暂不可用' : '等待列表确认'}</option>}
      {groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>{model.name}</option>)}</optgroup>)}
    </select>
    <p id="wa-model-help" className="wa-muted">同步 DSH 的模型列表和登录配置，无需另填地址或密钥。选择后自动保存，从下一个任务开始生效。</p>
    <div className="wa-row wa-section"><button disabled={loading} onClick={() => catalog.refresh()}>{loading ? '正在同步…' : '刷新列表'}</button>{busy === 'model.select' && <span role="status">正在保存模型…</span>}</div>
    {snapshot.status === 'error' && <p className="wa-alert" role="alert">暂时无法同步 DSH 模型列表，请刷新后重试。已保存的选择保留。</p>}
    {snapshot.value?.failures?.length > 0 && <p className="wa-alert">部分服务的模型列表暂时无法读取：{snapshot.value.failures.map(provider => provider.name).join('、')}。可刷新列表重试。</p>}
    {missing && snapshot.status === 'ready' && <p className="wa-alert">DSH 暂未提供所选模型，请刷新或重新选择。不会自动改用其他模型。</p>}
    {!choice && !defaultModel?.model && !loading && <p className="wa-alert">DSH 尚未设置默认模型，请在上方选择一个可用模型。</p>}
    {notice && <p className="wa-alert wa-success" role="status">{notice}</p>}
    <p className="wa-muted wa-section">此预览版支持文本对话；图片、语音、文件、知识库和定时任务暂未接入。</p>
  </section>;
}

export function WechatPanel({ connection, catalog }) {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [busy, setBusy] = useState('');
  const [draft, setDraft] = useState(null), [notice, setNotice] = useState(''), [contacts, setContacts] = useState(null);
  const [modelNotice, setModelNotice] = useState('');
  const mounted = useRef(false), account = useRef(null);
  const accept = value => {
    if (!mounted.current) return;
    setStatus(value);
    if (value.account?.id !== account.current) {
      account.current = value.account?.id;
      setDraft(value.account ? { ...value.settings, privatePeers: value.settings.privatePeers.join('\n'), groups: value.settings.groups.join('\n') } : null);
      setContacts(null); setNotice('');
    }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); let timer;
    const poll = async () => {
      try { accept(await call(connection, 'status', {}, AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]))); if (!controller.signal.aborted) setConnectionError(''); }
      catch (e) { if (!controller.signal.aborted) setConnectionError(e.message || '无法连接微信插件'); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [connection]);
  const action = async (endpoint, payload = {}) => {
    setBusy(endpoint); setError(''); setNotice('');
    if (endpoint === 'model.select') setModelNotice('');
    try {
      const value = await call(connection, endpoint, payload, AbortSignal.timeout(endpoint === 'disconnect' || endpoint === 'cancel' ? 60000 : 30000));
      if (!mounted.current) return;
      if (endpoint === 'contacts') setContacts(value);
      else accept(value);
      if (endpoint === 'settings') {
        setDraft({ ...value.settings, privatePeers: value.settings.privatePeers.join('\n'), groups: value.settings.groups.join('\n') });
        setNotice(value.settings.enabled ? '授权已保存，开始处理之后收到的消息' : '已保存，自动回复处于暂停状态');
      }
      if (endpoint === 'model.select') setModelNotice(value.modelChoice ? '模型已保存，从下一个任务生效' : '已跟随 DSH 默认模型，从下一个任务生效');
    } catch (e) { if (mounted.current) setError(e.message || '操作失败，请核对当前状态后重试'); }
    finally { if (mounted.current) setBusy(''); }
  };
  const update = (field, value) => { setDraft(previous => ({ ...previous, [field]: value })); setNotice(''); };
  const appendPeer = (field, id) => { if (id) update(field, [...new Set([...(draft[field] || '').split(/\s+/).filter(Boolean), id])].join('\n')); };
  const blocked = !!busy || !!status?.startupError;
  const loadingLogin = status?.login?.running;
  const save = () => action('settings', { accountId: status.account.id, settings: {
    ...draft, privatePeers: draft.privatePeers.split(/\s+/).filter(Boolean), groups: draft.groups.split(/\s+/).filter(Boolean)
  } });
  return <div className="wa-panel"><style>{css}</style><main className="wa-wrap">
    <header className="wa-top"><div><h1>微信 Agent</h1><p className="wa-muted">在微信接收问题，由 DeepSeek Harness 回复。</p></div><span className={`wa-badge ${status?.online ? 'wa-online' : ''}`}>{status?.online ? '微信已连接' : status ? '微信未连接' : '正在读取状态'}</span></header>
    {(error || connectionError || status?.startupError || status?.processing?.fault) && <div className="wa-alert" role="alert">{error || connectionError || status?.startupError?.message || status?.processing?.fault?.message}</div>}
    {!status ? <p className="wa-empty">正在连接 DSH 微信插件…</p> : <div className="wa-grid"><div>
      <section className="wa-card"><h2>微信账号</h2>
        {status.account ? <div className="wa-detail"><strong>{status.account.nickname || '当前微信账号'}</strong><span className="wa-muted wa-id">{status.account.id}</span></div> : <p className="wa-muted">扫码登录后，选择允许 Agent 回复的私聊和群聊。</p>}
        <p>{status.online ? '连接正常' : loginLabels[status.login?.state] || '微信未连接'}</p>
        {(status.login?.error || status.error) && <div className="wa-alert">{status.login?.error || status.error}</div>}
        {status.login?.image && loadingLogin && <img className="wa-qr" src={status.login.image} alt="微信登录二维码" />}
        {status.login?.state === 'scanned' && <p className="wa-muted">请在手机上确认本次登录。</p>}
        <div className="wa-row wa-section">
          {loadingLogin ? <button disabled={blocked} onClick={() => action('login.cancel')}>取消登录</button> : <button className="wa-primary" disabled={blocked || !status.runtimeReady} onClick={() => action('login.start', { replace: !!status.account })}>{busy === 'login.start' ? '正在启动…' : status.account ? '重新扫码登录' : '扫码登录微信'}</button>}
          {status.account && !loadingLogin && <button disabled={blocked} onClick={() => action(status.online ? 'disconnect' : 'connect')}>{status.online ? '断开连接' : '连接已有账号'}</button>}
        </div>
        {!status.runtimeReady && <p className="wa-alert">登录组件不完整，请安装 Windows x64 完整插件包。</p>}
        <p className="wa-muted wa-section">插件使用独立的微信登录资料。首次安装不会接管独立应用中的账号。</p>
      </section>
      <ModelPicker catalog={catalog} status={status} blocked={blocked} busy={busy} notice={modelNotice} onSelect={selection => action('model.select', { selection })} />
    </div><div>
      <section className="wa-card"><h2>会话授权</h2>{!draft ? <p className="wa-muted">登录微信后设置，仅作用于当前账号。</p> : <>
        <label className="wa-switch"><input type="checkbox" checked={draft.enabled} disabled={blocked} onChange={e => update('enabled', e.target.checked)} />启用自动回复</label>
        <p className="wa-muted">只回复下方授权的会话。群内需 @ 当前微信账号，或以 /agent 开头；每位成员保留独立上下文。</p>
        <label htmlFor="wa-private">允许回复的私聊 ID</label><textarea id="wa-private" rows={2} placeholder="每行一个微信 ID" value={draft.privatePeers} disabled={blocked} onChange={e => update('privatePeers', e.target.value)} />
        {contacts && <select aria-label="添加已发现的私聊" value="" disabled={blocked} onChange={e => appendPeer('privatePeers', e.target.value)}><option value="">从已发现的联系人添加…</option>{contacts.privatePeers.map(c => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}</select>}
        <label htmlFor="wa-groups">允许回复的群 ID</label><textarea id="wa-groups" rows={2} placeholder="每行一个群 ID，以 @chatroom 结尾" value={draft.groups} disabled={blocked} onChange={e => update('groups', e.target.value)} />
        {contacts && <select aria-label="添加已发现的群聊" value="" disabled={blocked} onChange={e => appendPeer('groups', e.target.value)}><option value="">从已发现的群聊添加…</option>{contacts.groups.map(c => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}</select>}
        <div className="wa-section"><button disabled={blocked || !status.online} onClick={() => action('contacts')}>{busy === 'contacts' ? '正在读取…' : '读取已发现的会话'}</button><p className="wa-muted">只列出微信同步中已发现的会话，也可以直接填入 ID。</p></div>
        <label htmlFor="wa-prompt">回复要求 <span className="wa-muted">可选</span></label><textarea id="wa-prompt" rows={3} maxLength={4000} placeholder="例如：使用中文，回答简洁，遇到不确定的信息直接说明。" value={draft.prompt} disabled={blocked} onChange={e => update('prompt', e.target.value)} />
        <div className="wa-row wa-section"><button className="wa-primary" disabled={blocked} onClick={save}>{busy === 'settings' ? '正在保存…' : '保存授权与设置'}</button><span className="wa-muted">当前：{status.settings.enabled ? '自动回复已启用' : '自动回复已暂停'}</span></div>
        {notice && <p className="wa-alert wa-success" role="status">{notice}</p>}
      </>}</section>
    </div></div>}
    {status && <section className="wa-card"><div className="wa-top"><div><h2>最近处理记录</h2><p className="wa-muted">{status.processing.active ? '有消息正在处理' : '当前没有运行中的任务'} · {status.processing.queued} 条排队</p></div><button disabled={blocked || !status.processing.active && !status.processing.queued} onClick={() => action('cancel')}>取消当前与排队任务</button></div>
      {!status.records.length ? <p className="wa-empty">授权会话有新问题时，处理结果会显示在这里。</p> : status.records.map(record => <details className="wa-history" key={record.key}><summary><span className="wa-preview">{record.question || record.sender || record.peerId}</span><span className={`wa-badge ${record.state === 'sent' ? 'wa-online' : ''}`}>{stateLabels[record.state] || record.state}</span></summary><p className="wa-muted">{new Date(record.createdAt).toLocaleString()} · {record.sender} · {record.peerId}</p>{record.question && <p>{record.question}</p>}{record.reply && <p>{record.reply}</p>}{record.reason && <p className="wa-alert">{record.reason}</p>}{record.acknowledgedMessageIds?.length > 0 && <p className="wa-muted">服务端已确认 {record.acknowledgedMessageIds.length} 条消息</p>}</details>)}
    </section>}
    <p className="wa-muted">微信 Agent {status?.version || ''} · 本地预览版</p>
  </main></div>;
}

function Icon() { return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20.5 11.2c0 4.6-4.4 8-9.1 8-1.4 0-2.7-.3-3.9-.8L3 20l1.1-4.3a7 7 0 0 1-1.6-4.5c0-4.4 4-8 9-8s9 3.6 9 8Z"/><path d="M7.5 11h.01M12 11h.01M16.5 11h.01" strokeWidth="3" strokeLinecap="round"/></svg>; }
export function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => <WechatPanel connection={ctx.connection} catalog={ctx.modelDirectories.catalog} />));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => '微信 Agent' }, Icon));
}
