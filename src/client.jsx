import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CHANNEL, personaText } from './contracts.mjs';
import { css } from './client-styles.mjs';
import { ConversationSculpture, MotionControl, useVisualMotion } from './client-visuals.jsx';
import { SearchControls, SearchCredentials } from './search-settings.jsx';
import { PersonaLibrary } from './persona-library.jsx';
import { MemoryPage, TasksPage } from './automation-pages.jsx';
import { LongTermMemoryPage } from './long-term-memory-page.jsx';
import { MediaLibraryPage } from './media-library-page.jsx';
import { PERSONA_CATEGORIES, PERSONA_PRESETS, getPersonaPreset, personaFromPreset } from './persona-presets.mjs';
import { conversationKey, formatTime, initials, matchesSearch, mergeConversations, peerId, peerName, peerType, splitLines } from './client-utils.mjs';

export const inject = ['slots', 'connection', 'modelDirectories'];
const PANEL_ID = 'wechat-agent';
const stateLabels = { queued: '等待处理', generating: '正在生成', sending: '等待微信回执', sent: '微信已确认', cancelled: '已取消', failed: '处理失败', unknown: '发送结果不明', partial: '部分已确认', skipped: '未触发回复', observed: '已读取', waiting: '等待参与' };
const loginLabels = { idle: '尚未登录', requesting: '正在获取二维码', waiting: '请用手机微信扫码', scanned: '已扫码，请在手机确认', confirmed: '正在认证', authenticating: '正在认证', 'session-ready': '正在连接微信', connecting: '正在连接微信', expired: '二维码已过期', cancelled: '登录已取消', failed: '登录失败', offline: '微信离线', online: '微信已连接' };
const modeLabels = { default: '默认回复', nickname: '昵称唤醒', participate: '主动参与' };
const pageLabels = { overview: '工作台', authorization: '会话授权', records: '处理记录', settings: '设置', model: '模型设置', identity: '全局身份', persona: '默认人设', 'persona-library': '内置人设库', storage: '全局工作目录', conversation: '会话设置', changelog: '更新日志', memory: '记忆库', tasks: '定时任务', assets: '表情与图片素材' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const personaDraft = (value = {}) => ({ name: value.name || '微信助手', aliases: (value.aliases || []).join('\n'), prompt: personaText(value) });
const modelDraft = (value = {}) => ({ maxTokens: String(value.maxTokens ?? 4096), temperature: value.temperature == null ? '' : String(value.temperature), vision: value.vision ?? true, visionModel: value.visionModel ?? null, webSearch: value.webSearch ?? false, searchProvider: value.searchProvider ?? 'tavily', tavilyBaseURL: value.tavilyBaseURL ?? 'https://api.tavily.com' });
const storageDraft = (value = {}) => ({ basePath: value.basePath || '' });
const configDraft = (value = {}, defaultPersona = {}) => ({ mode: value.mode || 'default', intervalMode: value.intervalMode || 'random', fixedMessages: String(value.fixedMessages ?? value.minMessages ?? 5), minMessages: String(value.minMessages ?? 5), maxMessages: String(value.maxMessages ?? 20), recordsPath: value.recordsPath || '', memoryMode: value.memoryMode || 'always', memoryWindowChars: value.memoryWindowChars == null ? '' : String(value.memoryWindowChars), allowChatTasks: value.allowChatTasks ?? true, personaMode: value.persona ? 'custom' : 'default', persona: personaDraft(value.persona || defaultPersona) });
const configPayload = ({ personaMode, persona, ...value }) => ({ ...value, fixedMessages: Number(value.fixedMessages), memoryWindowChars: value.memoryWindowChars.trim() === '' ? null : Number(value.memoryWindowChars), minMessages: Number(value.minMessages), maxMessages: Number(value.maxMessages), recordsPath: value.recordsPath.trim(), persona: personaMode === 'custom' ? { name: persona.name.trim(), aliases: splitLines(persona.aliases), prompt: persona.prompt } : null });
const modelKey = selection => selection ? JSON.stringify([selection.provider, selection.model]) : '';

async function call(connection, endpoint, payload = {}, signal) {
  let result;
  try { result = await connection.rpc.call(CHANNEL, endpoint, payload, signal); }
  catch { throw new Error(['status', 'contacts', 'records.list', 'changelog', 'identity.get', 'memory.list', 'memory.get', 'tasks.list'].includes(endpoint) ? '暂时无法读取微信插件，请检查 DSH 连接后重试。' : '未能确认操作结果，请重新读取状态，核对是否已保存后再试。'); }
  if (!result?.ok) throw new Error(result?.error?.message || '操作未完成，请核对当前状态后重试。');
  return result.value;
}

function Glyph({ name = 'chat', size, className = '' }) {
  const paths = {
    chat: <><path d="M20.5 11.2c0 4.6-4.4 8-9.1 8-1.4 0-2.7-.3-3.9-.8L3 20l1.1-4.3a7 7 0 0 1-1.6-4.5c0-4.4 4-8 9-8s9 3.6 9 8Z"/><path d="M7.5 11h.01M12 11h.01M16.5 11h.01" strokeWidth="2.8"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    people: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/></>,
    person: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></>,
    history: <><path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/></>,
    settings: <><path d="m9 3-.7 2.4-2.1 1.2-2.4-.6L2 9l1.7 1.8v2.4L2 15l1.8 3 2.4-.6 2.1 1.2L9 21h6l.7-2.4 2.1-1.2 2.4.6 1.8-3-1.7-1.8v-2.4L22 9l-1.8-3-2.4.6-2.1-1.2L15 3Z"/><circle cx="12" cy="12" r="3"/></>,
    model: <path d="m12 2 8.7 5v10L12 22l-8.7-5V7L12 2Zm0 0v20M3.3 7 12 12l8.7-5M3.3 17 12 12l8.7 5"/>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>,
    arrow: <path d="m9 5 7 7-7 7"/>, back: <path d="m14 5-7 7 7 7"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    refresh: <path d="M20 7V3l-3 3a8 8 0 0 0-13 5M4 17v4l3-3a8 8 0 0 0 13-5M20 7h-5M4 17h5"/>,
    check: <path d="m5 12 4 4L19 6"/>, plus: <path d="M12 5v14M5 12h14"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
    pause: <path d="M8 5v14M16 5v14" strokeWidth="3"/>,
    shield: <><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6L12 2Z"/><path d="m8 12 3 3 5-6"/></>,
    spark: <path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8L12 3ZM20 2v4M18 4h4"/>,
  };
  return <svg className={'wa-icon ' + className} viewBox="0 0 24 24" width={size || 19} height={size || 19} style={size ? { width: size, height: size } : undefined} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.chat}</svg>;
}
function Button({ children, icon, primary, quiet, danger, className = '', type = 'button', ...props }) {
  return <button type={type} className={'wa-button ' + (primary ? 'wa-primary ' : '') + (quiet ? 'wa-quiet ' : '') + (danger ? 'wa-danger ' : '') + className} {...props}>{icon && <Glyph name={icon} className="wa-icon-small"/>}{children}</button>;
}
function PageHead({ title, description, eyebrow, children }) {
  return <header className="wa-page-head"><div>{eyebrow && <p className="wa-eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="wa-muted">{description}</p>}</div>{children && <div className="wa-row">{children}</div>}</header>;
}
function Empty({ icon = 'chat', title, description, children }) {
  return <div className="wa-empty"><div className="wa-empty-icon"><Glyph name={icon}/></div><h3>{title}</h3>{description && <p>{description}</p>}{children}</div>;
}
function Notice({ notice, area }) {
  return notice?.area === area ? <div className="wa-alert is-success" role="status"><div className="wa-row"><Glyph name="check" className="wa-icon-small"/>{notice.text}</div></div> : null;
}
function Search({ value, onChange, placeholder = '搜索名称、备注或微信 ID', label = '搜索会话' }) {
  return <div className="wa-search"><Glyph name="search" className="wa-icon-small"/><input type="search" data-testid={label === '搜索记录会话' ? 'records-conversation-search' : 'conversation-search'} className="wa-input" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={label}/>{value && <button type="button" className="wa-search-clear" onClick={() => onChange('')} aria-label={'清空' + label}><Glyph name="close" className="wa-icon-small"/></button>}</div>;
}
function TypeFilters({ value, onChange }) {
  return <div className="wa-filters" role="group" aria-label="会话类型">{[['all', '全部'], ['group', '群聊'], ['private', '私聊']].map(([id, label]) => <button type="button" className="wa-filter" key={id} aria-pressed={value === id} onClick={() => onChange(id)}>{label}</button>)}</div>;
}
function StateBadge({ state }) {
  const kind = state === 'sent' ? 'success' : state === 'failed' ? 'error' : ['unknown', 'partial'].includes(state) ? 'warn' : ['queued', 'generating', 'sending'].includes(state) ? 'accent' : '';
  return <span className={'wa-badge ' + (kind ? 'is-' + kind : '')}>{stateLabels[state] || state || '等待消息'}</span>;
}
function Field({ label, id, children, help, count }) {
  return <div className="wa-field"><label className="wa-field-label" htmlFor={id}><span>{label}</span>{count && <span className="wa-field-count">{count}</span>}</label>{children}{help && <p className="wa-help" id={id + '-help'}>{help}</p>}</div>;
}
function FormActions({ dirty, busy, disabled, invalid, onReset, label = '保存设置', hint = '更改在保存后生效。' }) {
  return <div className="wa-form-actions"><span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : hint}</span><div className="wa-row"><Button disabled={!dirty || busy || disabled} onClick={onReset}>取消更改</Button><Button type="submit" primary disabled={busy || disabled || !dirty || invalid}>{busy ? '正在保存…' : label}</Button></div></div>;
}
function Back({ label = '返回设置', onClick }) { return <button type="button" className="wa-back" onClick={onClick}><Glyph name="back" className="wa-icon-small"/>{label}</button>; }

function AccountCard({ status, busy, blocked, onAction }) {
  const loading = status.login?.running;
  const disconnectedState = status.login?.state === 'online' ? 'offline' : status.login?.state;
  return <section className="wa-card wa-account-card"><p className="wa-account-kicker">微信连接<span>WECHAT</span></p><div className="wa-account-layout"><div className="wa-account-copy"><div className="wa-account-top"><div className="wa-account-avatar"><Glyph name="chat" size={26}/></div><div><h2 className="wa-account-name">{status.account?.nickname || (status.account ? '当前微信账号' : '连接你的微信')}</h2><p className="wa-muted wa-mono">{status.account?.id || '扫码后，在这里管理 Agent 的会话'}</p></div></div>
    <div className="wa-account-content"><div className="wa-status-line wa-login-state"><span className={'wa-status-dot ' + (status.online ? 'is-online' : '')}/>{status.online ? '已连接，正在同步新消息' : loginLabels[disconnectedState] || '微信未连接'}</div><p className="wa-help">{status.online ? '回复范围和方式由每个授权会话的设置决定。' : '登录后选择会话，并为群聊设置参与方式。'}</p></div><div className="wa-row wa-account-actions">
      {loading ? <Button disabled={blocked} onClick={() => onAction('login.cancel')}>取消登录</Button> : <Button primary={!status.account} disabled={blocked || !status.runtimeReady} onClick={() => onAction('login.start', { replace: !!status.account })}>{busy === 'login.start' ? '正在启动…' : status.account ? '重新扫码' : '扫码登录微信'}</Button>}
      {status.account && !loading && <Button disabled={blocked} onClick={() => onAction(status.online ? 'disconnect' : 'connect')}>{status.online ? '断开连接' : '重新连接'}</Button>}
    </div></div></div>
    {(status.login?.error || status.error) && <div className="wa-alert is-error wa-section-space" role="alert">{status.login?.error || status.error}</div>}
    {loading && status.login?.image && <><img className="wa-qr" src={status.login.image} alt="微信登录二维码"/><p className="wa-help wa-qr-caption">{status.login.state === 'scanned' ? '已扫码，请在手机确认本次登录。' : '请使用手机微信扫码。'}</p></>}
    {!status.runtimeReady && <p className="wa-alert wa-section-space">缺少登录组件，请安装完整的 Windows x64 插件包。</p>}
    <p className="wa-account-note">使用插件独立的登录资料；已保存的会话授权随当前微信账号切换。</p>
  </section>;
}


function Overview({ status, busy, blocked, onAction, onNavigate }) {
  const settings = status.settings || {}, processing = status.processing || {};
  const groups = settings.groups?.length || 0, privates = settings.privatePeers?.length || 0;
  return <><PageHead title="工作台" description="你的 Agent、会话与日常，都在这里。"><span className={'wa-badge ' + (settings.enabled ? 'is-success' : '')}><span className={'wa-status-dot ' + (settings.enabled ? 'is-online' : '')}/>{settings.enabled ? '自动回复已开启' : '自动回复已暂停'}</span></PageHead>
    <div className="wa-stack wa-overview-stack"><div className="wa-overview-lead"><section className="wa-intro-card"><div className="wa-intro-copy"><span className="wa-intro-kicker"><i/>你的对话空间</span><h2>有性格，<br/><span>也有记忆。</span></h2><p>把 Agent 带进日常，<br/>让交流自然发生。</p><div className="wa-row wa-intro-actions"><Button primary onClick={() => onNavigate('authorization')}>管理会话<Glyph name="arrow" className="wa-icon-small"/></Button><Button quiet onClick={() => onNavigate('records')}>查看记录</Button></div></div><ConversationSculpture/><span className="wa-intro-edition" aria-hidden="true">CONVERSATION, WITH CHARACTER.</span></section><AccountCard status={status} busy={busy} blocked={blocked} onAction={onAction}/></div>
      <div className="wa-stat-grid"><div className="wa-stat"><span className="wa-stat-index" aria-hidden="true">01</span><div className="wa-stat-label"><Glyph name="people" className="wa-icon-small"/>已授权会话</div><div className="wa-stat-number">{groups + privates}</div><p className="wa-stat-detail">{groups} 个群聊 · {privates} 个私聊</p></div><div className="wa-stat"><span className="wa-stat-index" aria-hidden="true">02</span><div className="wa-stat-label"><Glyph name="clock" className="wa-icon-small"/>等待处理</div><div className="wa-stat-number">{processing.queued || 0}</div><p className="wa-stat-detail">已接收的回复任务</p></div><div className="wa-stat is-active" data-active={!!processing.active}><span className="wa-stat-index" aria-hidden="true">03</span><div className="wa-stat-label"><Glyph name="spark" className="wa-icon-small"/>当前任务</div><div className="wa-stat-number">{processing.active ? 1 : 0}</div><p className="wa-stat-detail">{processing.active ? '正在生成或发送回复' : '等待新会话消息'}</p></div></div>
      <div className="wa-overview-grid"><section className="wa-card"><div className="wa-card-heading"><div><h2>你的 Agent</h2><p className="wa-muted">模型、人设与数据都有清晰的位置。</p></div><Glyph name="spark"/></div><div className="wa-summary-item"><Glyph name="model"/><div><div className="wa-summary-value">{status.model?.model || '尚未选择模型'}</div><p className="wa-help">{status.modelChoice ? '使用指定的 DSH 模型' : '跟随 DSH 默认模型'}</p></div><Button quiet icon="arrow" onClick={() => onNavigate('model', 'overview')} aria-label="打开模型设置"/></div><div className="wa-summary-item"><Glyph name="person"/><div><div className="wa-summary-value">{status.persona?.name || '微信助手'}</div><p className="wa-help">默认人设 · 可在会话中独立设置</p></div><Button quiet icon="arrow" onClick={() => onNavigate('persona', 'overview')} aria-label="打开默认人设"/></div><div className="wa-summary-item"><Glyph name="folder"/><div><div className="wa-summary-value">全局工作目录</div><p className="wa-help wa-mono wa-path">{status.storage?.basePath || '正在读取保存位置'}</p></div><Button quiet icon="arrow" onClick={() => onNavigate('storage', 'overview')} aria-label="打开全局工作目录"/></div></section>
      <section className="wa-card"><div className="wa-card-heading"><div><h2>会话参与方式</h2><p className="wa-muted">为不同群聊安排不同的角色。</p></div><Glyph name="chat"/></div><div className="wa-participation-list"><div className="wa-participation-item"><span className="wa-participation-index" aria-hidden="true">01</span><div><h3>默认回复</h3><p className="wa-help">群内 @ 当前账号，或使用 /agent 提问。</p></div></div><div className="wa-participation-item"><span className="wa-participation-index" aria-hidden="true">02</span><div><h3>昵称唤醒</h3><p className="wa-help">呼叫 Agent 的名字或别名，也可以获得回复。</p></div></div><div className="wa-participation-item"><span className="wa-participation-index" aria-hidden="true">03</span><div><h3>主动参与</h3><p className="wa-help">按各群设置的消息条数，理解上下文后加入聊天。</p></div></div></div><Button className="wa-participation-manage" icon="people" onClick={() => onNavigate('authorization')}>管理会话授权</Button></section></div>
    </div></>;
}

function Authorization({ status, rows, contacts, query, setQuery, type, setType, tab, setTab, blocked, busy, notice, onAction, onGrant, onDetail, onToggle }) {
  const [nameQuery, setNameQuery] = useState(''), [nameType, setNameType] = useState('all');
  const authorized = rows.filter(item => item.authorized);
  const discoveredKeys = new Set([...(contacts?.privatePeers || []).map(item => conversationKey({ ...item, chatType: 'private' })), ...(contacts?.groups || []).map(item => conversationKey({ ...item, chatType: 'group' }))]);
  const source = tab === 'authorized' ? authorized : rows.filter(item => discoveredKeys.has(conversationKey(item)));
  const filtered = source.filter(item => (type === 'all' || peerType(item) === type) && matchesSearch(item, query));
  const suggestions = nameQuery.trim() ? rows.filter(item => (nameType === 'all' || peerType(item) === nameType) && matchesSearch(item, nameQuery)) : [];
  const row = item => <div className="wa-session-row" data-peer-id={peerId(item)} data-chat-type={peerType(item)} key={conversationKey(item)}>
    <div className={'wa-session-avatar ' + (peerType(item) === 'group' ? 'is-group' : '')}>{initials(peerName(item))}</div>
    <div className="wa-session-info"><div className="wa-session-title" title={peerName(item)}>{peerName(item)}</div><div className="wa-session-meta"><span>{peerType(item) === 'group' ? '群聊' : '私聊'}</span><span>{item.remark || item.nickname || ''}</span><span className="wa-mono" title={peerId(item)}>…{peerId(item).slice(-8)}</span></div></div>
    <div className="wa-session-actions">{item.authorized && <span className="wa-badge">{peerType(item) === 'group' ? modeLabels[item.config?.mode || 'default'] : '私聊回复'}</span>}{item.authorized ? <><Button disabled={blocked} onClick={() => onDetail(item)}>设置</Button><Button quiet className="wa-icon-button" icon="close" disabled={blocked} title={'撤销 ' + peerName(item) + ' 的授权'} aria-label={'撤销 ' + peerName(item) + ' 的授权'} onClick={() => onGrant(item, false)}/></> : <Button icon="plus" disabled={blocked} onClick={() => onGrant(item, true)}>授权</Button>}</div>
  </div>;
  return <><PageHead title="会话授权" description="输入微信名、备注或群名，选择 Agent 可以回复的会话。"><Button icon="refresh" disabled={blocked || !status.online} onClick={() => onAction('contacts')}>{busy === 'contacts' ? '正在同步…' : '同步已发现会话'}</Button></PageHead><Notice notice={notice} area="authorization"/>
    {!status.account ? <section className="wa-card"><Empty icon="shield" title="先连接一个微信账号" description="连接后按名字搜索联系人和群聊。"/></section> : <>
      <div className="wa-auth-toggle"><div className="wa-toggle-copy"><h3>自动回复</h3><p>{status.settings.enabled ? '按各个会话的模式处理新消息，并执行已保存的定时任务。' : '授权、记忆与任务继续保留，当前暂停回复和定时发送。'}</p></div><label className="wa-toggle"><input type="checkbox" checked={status.settings.enabled} disabled={blocked} onChange={event => onToggle(event.target.checked)} aria-label="启用自动回复"/><span>{status.settings.enabled ? '已开启' : '已暂停'}</span></label></div>
      <section className="wa-manual-box wa-name-add" data-testid="name-add"><h3>通过名字添加</h3><p className="wa-help">输入部分微信名、备注或群名，例如“李”，在下面的匹配列表中选择。同名会话需分别选择。</p>
        <div className="wa-row wa-section-space"><select className="wa-select" aria-label="按名字添加的会话类型" value={nameType} onChange={event => setNameType(event.target.value)}><option value="all">全部类型</option><option value="group">群聊</option><option value="private">私聊</option></select><input className="wa-input" aria-label="添加会话的微信名" data-testid="add-conversation-name" value={nameQuery} onChange={event => setNameQuery(event.target.value)} placeholder="例如：李、产品讨论、周末搭子" maxLength={150}/></div>
        {nameQuery.trim() && <><p className="wa-help" role="status">找到 {suggestions.length} 个匹配会话</p><div className="wa-name-suggestions">{suggestions.map(row)}</div>{!suggestions.length && <p className="wa-help">暂未找到。可以换个字、试试备注或同步已发现会话；新会话需要先被微信同步到。</p>}</>}
      </section>
      <div className="wa-tabs" role="tablist" aria-label="会话来源"><button type="button" role="tab" className="wa-tab" aria-selected={tab === 'authorized'} onClick={() => setTab('authorized')}>已授权<span className="wa-tab-count">{authorized.length}</span></button><button type="button" role="tab" className="wa-tab" aria-selected={tab === 'discovered'} onClick={() => setTab('discovered')}>发现会话<span className="wa-tab-count">{discoveredKeys.size}</span></button></div>
      <div className="wa-toolbar"><Search value={query} onChange={setQuery}/><TypeFilters value={type} onChange={setType}/></div><div className="wa-session-list">{filtered.length ? filtered.map(row) : <Empty icon="search" title="没有匹配的会话" description="可以在上方按名字添加，或调整筛选条件。"/>}</div><p className="wa-help wa-section-space">显示 {filtered.length} / {source.length} 个会话</p>
    </>}</>;
}

function ConversationSettings({ peer, draft, status, blocked, busy, notice, dirty, onChange, onSave, onReset, onBack, onNavigate, onRecords, onRevoke }) {
  if (!peer || !draft) return <Empty title="选择一个会话" description="从会话授权中打开会话设置。"/>;
  const group = peerType(peer) === 'group', minimum = Number(draft.minMessages), maximum = Number(draft.maxMessages), fixed = Number(draft.fixedMessages);
  const rangeInvalid = group && (draft.intervalMode === 'fixed' ? !Number.isInteger(fixed) || fixed < 1 || fixed > 100 : !Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum > 100 || minimum > maximum);
  const memorySize = draft.memoryWindowChars.trim() === '' ? null : Number(draft.memoryWindowChars);
  const customPersona = draft.personaMode === 'custom', aliases = splitLines(draft.persona.aliases);
  const personaInvalid = customPersona && (!draft.persona.name.trim() || aliases.length > 12 || aliases.some(alias => alias.length > 80) || draft.persona.prompt.length > 16000);
  const invalid = rangeInvalid || personaInvalid || memorySize !== null && (!Number.isInteger(memorySize) || memorySize < 1000 || memorySize > 200000);
  const names = customPersona ? [draft.persona.name, ...aliases].filter(Boolean).join('、') : [status.persona?.name || '微信助手', ...(status.persona?.aliases || [])].join('、');
  return <><Back label="返回会话授权" onClick={onBack}/><PageHead title="会话设置" description="为这个会话配置人设、参与方式、记忆和定时任务。"><Button icon="history" onClick={() => onRecords(peer)}>查看处理记录</Button></PageHead><Notice notice={notice} area="conversation"/>
    <div className="wa-content-narrow"><form className="wa-card" onSubmit={event => { event.preventDefault(); onSave(); }}><div className="wa-card-heading"><div className="wa-detail-title"><div className={'wa-session-avatar ' + (group ? 'is-group' : '')}>{initials(peerName(peer))}</div><div><h2>{peerName(peer)}</h2><p className="wa-muted">{group ? '群聊' : '私聊'}</p></div></div><span className="wa-badge">{peer.authorized ? '已授权' : '仅保留历史'}</span></div>
      <div className="wa-subsection"><h2>此会话的人设</h2><div className="wa-radio-list" role="radiogroup" aria-label="此会话人设来源">{[
        ['default', '使用默认人设', '当前默认：' + (status.persona?.name || '微信助手') + '。默认人设更新时，这个会话会跟随。'],
        ['custom', '自定义此会话人设', '单独设置名字、唤醒别名和正文，只在这个会话生效。'],
      ].map(([value, label, description]) => <label key={value} className="wa-mode-option"><input type="radio" name="wa-conversation-persona-mode" value={value} checked={draft.personaMode === value} disabled={blocked || !peer.authorized} onChange={() => onChange({ ...draft, personaMode: value })}/><span><strong>{label}</strong><small>{description}</small></span></label>)}</div>
      {customPersona ? <>
        <Field label="导入内置人设" id="wa-conversation-persona-preset" help="选中后填入名字、别名和正文，作为草稿继续修改；保存后只用于这个会话。"><select className="wa-select" id="wa-conversation-persona-preset" value="" disabled={blocked} onChange={event => { if (event.target.value) onChange({ ...draft, persona: personaDraft(personaFromPreset(event.target.value)) }); }}><option value="">选择内置人设，或直接编辑下方内容</option>{PERSONA_CATEGORIES.map(category => <optgroup key={category.id} label={category.name}>{PERSONA_PRESETS.filter(preset => preset.category === category.id).map(preset => <option key={preset.id} value={preset.id}>{preset.name} · {preset.role}</option>)}</optgroup>)}</select></Field>
        <div className="wa-form-grid"><Field label="Agent 名字" id="wa-conversation-persona-name"><input className="wa-input" id="wa-conversation-persona-name" maxLength={80} value={draft.persona.name} disabled={blocked} onChange={event => onChange({ ...draft, persona: { ...draft.persona, name: event.target.value } })}/></Field><Field label="唤醒别名" id="wa-conversation-persona-aliases" help="每行一个或用逗号分隔，最多 12 个。"><textarea className="wa-textarea" id="wa-conversation-persona-aliases" rows={2} maxLength={1000} value={draft.persona.aliases} disabled={blocked} onChange={event => onChange({ ...draft, persona: { ...draft.persona, aliases: event.target.value } })}/></Field></div>
        <Field label="人设正文" id="wa-conversation-persona-prompt" count={draft.persona.prompt.length + ' / 16000'} help="身份、性格、说话习惯和示例写在一起即可。此会话的回复和定时任务使用这套人设。"><textarea className="wa-textarea wa-persona-editor" id="wa-conversation-persona-prompt" rows={12} maxLength={16000} value={draft.persona.prompt} disabled={blocked} onChange={event => onChange({ ...draft, persona: { ...draft.persona, prompt: event.target.value } })}/></Field>
        {personaInvalid && <p className="wa-help">请填写名字；别名最多 12 个、每个 80 字，人设正文最多 16000 字。</p>}
      </> : <Button quiet onClick={() => onNavigate('persona', 'conversation')}>查看或修改默认人设<Glyph name="arrow" className="wa-icon-small"/></Button>}</div>
      {group ? <><Field label="回复模式" id="wa-mode"><div className="wa-radio-list" role="radiogroup" aria-label="群聊回复模式">{[
        ['default', '默认回复', '群内 @ 当前微信账号，或以 /agent 开头提问时回复。'],
        ['nickname', '昵称唤醒', '在默认回复基础上，增加 Agent 名字与昵称唤醒。'],
        ['participate', '主动参与', '保留 @、/agent 和昵称的立即回应，再按消息条数主动加入聊天。'],
      ].map(([value, label, description]) => <label key={value} className="wa-mode-option"><input type="radio" name="wa-group-mode" value={value} checked={draft.mode === value} disabled={blocked || !peer.authorized} onChange={() => onChange({ ...draft, mode: value })}/><span><strong>{label}</strong><small>{description}</small></span></label>)}</div></Field>
      {draft.mode !== 'default' && <div className="wa-note-box"><p>{dirty ? '保存后识别：' : '当前识别：'}<strong>{names || '请填写上方的 Agent 名字'}</strong></p><p className="wa-help">名字和别名由上方的此会话人设决定。</p></div>}
      {draft.mode === 'participate' && <div className="wa-note-box"><p><strong>每个群独立计数</strong></p><p>普通新消息按条数累计。有人直接点名时立即回应，并重新开始主动参与计数。</p>
        <Field label="参与间隔"><select className="wa-select" aria-label="主动参与间隔模式" value={draft.intervalMode} disabled={blocked} onChange={event => onChange({ ...draft, intervalMode: event.target.value })}><option value="random">在区间内随机</option><option value="fixed">固定消息条数</option></select></Field>
        <div className="wa-number-range"><span>每</span>{draft.intervalMode === 'fixed' ? <input className="wa-input" aria-label="主动参与固定消息数" type="number" min="1" max="100" step="1" value={draft.fixedMessages} disabled={blocked} onChange={event => onChange({ ...draft, fixedMessages: event.target.value })}/> : <><input className="wa-input" aria-label="主动参与最少消息数" type="number" min="1" max="100" step="1" value={draft.minMessages} disabled={blocked} onChange={event => onChange({ ...draft, minMessages: event.target.value })}/><span>—</span><input className="wa-input" aria-label="主动参与最多消息数" type="number" min="1" max="100" step="1" value={draft.maxMessages} disabled={blocked} onChange={event => onChange({ ...draft, maxMessages: event.target.value })}/></>}<span>条消息参与一次</span></div>
        <p className="wa-help">均可设置为 1–100 的整数。{peer.config?.mode === 'participate' && peer.progress ? '当前累计 ' + (peer.progress.count || 0) + ' / ' + (peer.progress.target || '待开始') + ' 条。' : ''}</p>{rangeInvalid && <p className="wa-alert">请检查消息条数和区间。</p>}
      </div>}</> : <p className="wa-help">直接处理这个授权联系人的消息，使用此会话自己的记忆。</p>}
      <div className="wa-subsection"><h2>会话记忆</h2><Field label="记忆读取" id="wa-memory-mode" help="每轮读取会把记忆带入回复上下文；按需读取由 Agent 在需要时查阅记忆。"><select className="wa-select" id="wa-memory-mode" value={draft.memoryMode} disabled={blocked} onChange={event => onChange({ ...draft, memoryMode: event.target.value })}><option value="always">每轮读取</option><option value="on-demand">按需读取</option></select></Field><Field label="记忆窗口字符数" help={'留空使用默认 ' + (status.memory?.windowChars || 32000) + ' 字；可设置 1000–200000 字。满窗口自动压缩，旧记忆快照保留。'}><input className="wa-input" id="wa-memory-window" aria-label="此会话记忆窗口字符数" type="number" min="1000" max="200000" value={draft.memoryWindowChars} disabled={blocked} placeholder="跟随记忆库默认窗口" onChange={event => onChange({ ...draft, memoryWindowChars: event.target.value })}/></Field><Button quiet onClick={() => onNavigate('memory', 'conversation')}>查看这个会话的记忆</Button></div>
      <div className="wa-subsection"><h2>会话定时任务</h2><label className="wa-check-row"><input type="checkbox" aria-label="允许会话创建定时任务" checked={draft.allowChatTasks} disabled={blocked} onChange={event => onChange({ ...draft, allowChatTasks: event.target.checked })}/><span>允许在聊天中安排提醒和定时任务</span></label><p className="wa-help">例如“小胖，一分钟后提醒我吃饭”。任务绑定当前会话和创建者，并在定时任务页显示。</p><Button quiet onClick={() => onNavigate('tasks', 'conversation')}>查看或添加定时任务</Button></div>
      <details className="wa-subsection"><summary>记录保存位置</summary><p className="wa-help">会话记录由全局工作目录统一管理，按账号和会话分别保存。</p><div className="wa-path-value">{peer.recordsPath || '正在读取保存位置'}</div><Button quiet onClick={() => onNavigate('storage', 'conversation')}>查看全局工作目录</Button></details>
      <FormActions dirty={dirty} busy={busy === 'conversation.configure'} disabled={blocked} invalid={invalid || !peer.authorized} onReset={onReset} label="保存会话设置" hint="修改参与方式后重新计数，已有记录和记忆继续保留。"/>
    </form>{peer.authorized && <div className="wa-between wa-section-space"><p className="wa-help">撤销授权后停止这个会话的回复和定时发送。</p><Button danger disabled={blocked} onClick={() => onRevoke(peer)}>撤销授权</Button></div>}</div></>;
}

function SettingsIndex({ status, onNavigate }) {
  const items = [
    { page: 'model', icon: 'model', title: '模型设置', text: '选择 DSH 模型，配置生成参数与当前账号的补充回复要求。', value: status.model?.model || '跟随 DSH 默认模型' },
    { page: 'identity', icon: 'shield', title: '全局身份', text: '编辑所有会话共同遵循的身份与行为规则，每轮从 AGENT.md 读取。', value: '全局身份 → 会话人设 → 相关记忆' },
    { page: 'persona', icon: 'person', title: '默认人设', text: '未自定义人设的会话使用此设定，每个会话可独立覆盖。', value: status.persona?.name || '微信助手' },
    { page: 'storage', icon: 'folder', title: '全局工作目录', text: '只需设置一个目录，插件数据在其下自动分类保存。', value: status.storage?.basePath || '所有插件数据 · 统一迁移' },
    { page: 'authorization', icon: 'shield', title: '会话人设与回复模式', text: '搜索授权会话，为每个会话设置独立人设和回复方式。', value: (status.settings?.privatePeers?.length || 0) + (status.settings?.groups?.length || 0) + ' 个已授权会话' },
    { page: 'changelog', icon: 'history', title: '更新日志', text: '查看当前版本的变化、历史更新和未发布内容。', value: status.version || '插件版本记录' },
  ];
  return <><PageHead title="设置" description="按职责配置你的 Agent，每个入口都有独立的设置页面。"/><div className="wa-setting-grid">{items.map(item => <button type="button" className="wa-setting-link" data-testid={'open-' + item.page} key={item.page} onClick={() => onNavigate(item.page, 'settings')}><div className="wa-card-icon"><Glyph name={item.icon}/></div><div><h3>{item.title}</h3><p>{item.text}</p><span className="wa-setting-caption">{item.value}</span></div><Glyph name="arrow" className="wa-icon-small"/></button>)}</div></>;
}

function IdentitySettings({ connection, blocked, onSave, onBack, backLabel }) {
  const [document, setDocument] = useState(null), [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), savingRef = useRef(false), draftRef = useRef({ document, markdown });
  draftRef.current = { document, markdown };
  const dirty = !!document && markdown !== document.markdown, busy = loading || saving;
  const invalid = !markdown.trim() || markdown.length > 32000 || markdown.includes('\0');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const draft = draftRef.current;
    if (draft.document && draft.markdown !== draft.document.markdown) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    void call(connection, 'identity.get', {}, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])).then(value => {
      if (controller.signal.aborted) return;
      const current = draftRef.current;
      if (current.document && current.markdown !== current.document.markdown) return;
      if (typeof value?.markdown !== 'string' || !value.revision || !value.path) throw new Error('未能读取完整的全局身份文件，请重新读取。');
      setDocument(value); setMarkdown(value.markdown);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message || '全局身份文件暂时无法读取，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection, refresh]);
  const save = async () => {
    if (savingRef.current || busy || blocked || !dirty || invalid || !document?.revision) return;
    savingRef.current = true; setSaving(true); setError(''); setNotice('');
    try {
      const result = await onSave({ markdown, revision: document.revision });
      if (!result || !mounted.current) return;
      setDocument({ ...document, markdown, revision: null });
      setNotice('全局身份已保存，将从下一轮回复开始生效。');
      setRefresh(value => value + 1);
    } catch (failure) { if (mounted.current) setError(failure.message || '全局身份未能保存，草稿已保留。'); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  };
  return <><Back label={backLabel} onClick={onBack}/><PageHead title="全局身份" description="在 AGENT.md 中定义所有会话共同遵循的身份与行为，再由各会话的人设决定名字、性格和表达方式。"/>
    {error && <div className="wa-alert is-error" role="alert">{error}</div>}{notice && <div className="wa-alert is-success" role="status">{notice}</div>}
    <form className="wa-card wa-content-narrow" data-testid="agent-identity-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="wa-card-heading"><div><h2>身份与行为正文</h2><p className="wa-muted">直接编辑 Markdown，保存后下一轮读取。</p></div><div className="wa-card-icon"><Glyph name="shield"/></div></div>
      <div className="wa-note-box"><p>每轮先读取全局身份，再应用当前会话的人设。</p><p>近期上下文帮助衔接当前对话；历史与长期记忆按会话的记忆读取设置提供，或在需要时查阅。</p></div>
      <Field label="全局身份 Markdown" id="wa-identity-markdown" count={markdown.length + ' / 32000'} help="填写共同的身份、行为准则与回复习惯。每个会话的名字、别名和角色设定在会话设置中配置。"><textarea className="wa-textarea wa-persona-editor" id="wa-identity-markdown" rows={20} maxLength={32000} value={markdown} disabled={busy || blocked || !document?.revision} onChange={event => { setMarkdown(event.target.value); setNotice(''); }}/></Field>
      {invalid && document && <p className="wa-help">请填写 1–32000 字的 Markdown 正文。</p>}
      <div className="wa-subsection"><h3>文件位置</h3><div className="wa-path-value" data-testid="agent-identity-path">{document?.path || (loading ? '正在读取文件位置…' : '暂未读取到文件位置')}</div><p className="wa-help">可用外部编辑器修改 AGENT.md，下一轮会读取文件中的最新内容。本页不会自动刷新正文。</p><Button icon="refresh" disabled={busy || blocked || dirty} onClick={() => { setNotice(''); setRefresh(value => value + 1); }}>{loading ? '正在读取…' : '重新读取文件'}</Button>{dirty && <p className="wa-help">有未保存的草稿，保存或取消更改后可重新读取文件。</p>}</div>
      <FormActions dirty={dirty} busy={saving} disabled={blocked || loading || !document?.revision} invalid={invalid} onReset={() => { setMarkdown(document?.markdown || ''); setNotice(''); }} label="保存全局身份" hint="修改会用于下一轮回复，已有会话记录与记忆继续保留。"/>
    </form></>;
}

function Changelog({ connection, onBack }) {
  const [markdown, setMarkdown] = useState(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setMarkdown(null); setError('');
    void call(connection, 'changelog', {}, controller.signal).then(value => {
      if (!controller.signal.aborted) setMarkdown(typeof value?.markdown === 'string' ? value.markdown : '');
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [connection, revision]);
  const blocks = useMemo(() => {
    if (!markdown) return [];
    return markdown.trim().split(/\r?\n\s*\r?\n/).map((block, index) => {
      const lines = block.split(/\r?\n/), heading = /^(#{1,6})\s+(.+)$/.exec(block);
      if (heading) return React.createElement(heading[1].length <= 2 ? 'h2' : 'h3', { key: index }, heading[2]);
      if (lines.every(line => /^\s*[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, row) => <li key={row}>{line.replace(/^\s*[-*]\s+/, '')}</li>)}</ul>;
      return <p key={index}>{block}</p>;
    });
  }, [markdown]);
  return <><Back onClick={onBack}/><PageHead title="更新日志" description="查看插件的版本变化与更新记录。"/><section className="wa-card wa-content-narrow wa-changelog" data-testid="changelog-content">{error ? <div className="wa-alert is-error" role="alert"><p>{error}</p><Button icon="refresh" onClick={() => setRevision(value => value + 1)}>重新读取更新日志</Button></div> : markdown === null ? <p className="wa-help" role="status">正在读取更新日志…</p> : blocks.length ? blocks : <Empty icon="history" title="暂无更新记录" description="当前插件包暂未提供更新日志。"/>}</section></>;
}


function MemoryWorkspace(props) {
  const [tab, setTab] = useState('conversation');
  const buttons = useRef({});
  const onKeyDown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'conversation' : event.key === 'End' ? 'global' : tab === 'conversation' ? 'global' : 'conversation';
    setTab(next); buttons.current[next]?.focus();
  };
  return <><div className="wa-memory-tabs" role="tablist" aria-label="记忆类型" onKeyDown={onKeyDown}>{[['conversation', '会话记忆窗口', '衔接当前对话'], ['global', '全局长期记忆', '留存事实与共同约定']].map(([id, label, description]) => <button type="button" role="tab" key={id} id={'wa-memory-tab-' + id} aria-controls={'wa-memory-panel-' + id} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} ref={node => { buttons.current[id] = node; }} onClick={() => setTab(id)}><strong>{label}</strong><small>{description}</small></button>)}</div><div id="wa-memory-panel-conversation" role="tabpanel" aria-labelledby="wa-memory-tab-conversation" hidden={tab !== 'conversation'}><MemoryPage {...props}/></div><div id="wa-memory-panel-global" role="tabpanel" aria-labelledby="wa-memory-tab-global" hidden={tab !== 'global'}><LongTermMemoryPage {...props}/></div></>;
}

function ModelPicker({ catalog, status, blocked, busy, onSelect }) {
  const snapshot = useSyncExternalStore(catalog.store.subscribe, catalog.store.getSnapshot);
  const [refreshError, setRefreshError] = useState('');
  useEffect(() => { void catalog.load().catch(() => {}); }, [catalog]);
  const groups = snapshot.value?.groups || [], choice = status.modelChoice;
  const find = selection => groups.find(group => group.id === selection?.provider)?.models.find(model => model.id === selection?.model);
  const defaultModel = snapshot.value?.default ?? status.defaultModel, missing = choice && !find(choice);
  const loading = ['idle', 'loading'].includes(snapshot.status);
  const refresh = () => { setRefreshError(''); void Promise.resolve().then(() => catalog.refresh()).catch(() => setRefreshError('暂时无法刷新模型列表，请稍后重试。')); };
  return <><Field label="回复模型" id="wa-model" help="直接使用 DSH 的模型列表与登录配置。选择后自动保存，从下一个任务开始生效。"><select id="wa-model" className="wa-select" value={modelKey(choice)} disabled={blocked} aria-describedby="wa-model-help" onChange={event => { const pair = event.target.value ? JSON.parse(event.target.value) : null; onSelect(pair ? { provider: pair[0], model: pair[1] } : null); }}><option value="">跟随 DSH 默认{defaultModel?.model ? '（' + (find(defaultModel)?.name || defaultModel.model) + '）' : ''}</option>{missing && <option value={modelKey(choice)} disabled>{choice.model} · {snapshot.status === 'ready' ? '暂不可用' : '等待列表确认'}</option>}{groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>{model.name}</option>)}</optgroup>)}</select></Field><div className="wa-row"><Button icon="refresh" disabled={loading} onClick={refresh}>{loading ? '正在同步…' : '刷新模型列表'}</Button>{busy === 'model.select' && <span className="wa-help" role="status">正在保存模型…</span>}</div>
    {(snapshot.status === 'error' || refreshError) && <p className="wa-alert wa-section-space" role="alert">{refreshError || '暂时无法同步 DSH 模型列表，请刷新后重试。已保存的选择继续保留。'}</p>}{snapshot.value?.failures?.length > 0 && <p className="wa-alert wa-section-space">部分服务的模型列表暂时无法读取：{snapshot.value.failures.map(provider => provider.name).join('、')}。</p>}{missing && snapshot.status === 'ready' && <p className="wa-alert wa-section-space">所选模型暂不可用。请刷新列表或重新选择；此时不会自动换用其他模型。</p>}{!choice && !defaultModel?.model && !loading && <p className="wa-alert wa-section-space">DSH 尚未设置默认模型，请选择一个可用模型。</p>}
  </>;
}

function VisionModelPicker({ catalog, value, disabled, onChange }) {
  const snapshot = useSyncExternalStore(catalog.store.subscribe, catalog.store.getSnapshot);
  const groups = (snapshot.value?.groups || []).map(group => ({ ...group, models: group.models.filter(model => !model.inputModalities || model.inputModalities.includes('image')) })).filter(group => group.models.length);
  const missing = value && !groups.some(group => group.id === value.provider && group.models.some(model => model.id === value.model));
  return <Field label="图像理解模型" id="wa-vision-model" help="自动时优先当前模型；若它只接收文字，使用同一 DSH 服务的视觉模型，优先同系列。也可在这里单独指定。"><select id="wa-vision-model" className="wa-select" value={modelKey(value)} disabled={disabled} onChange={event => { const pair = event.target.value ? JSON.parse(event.target.value) : null; onChange(pair ? { provider: pair[0], model: pair[1] } : null); }}><option value="">自动选择视觉模型</option>{missing && <option value={modelKey(value)} disabled>{value.model} · 等待可用视觉模型</option>}{groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>{model.name}</option>)}</optgroup>)}</select></Field>;
}

function ModelSettings({ catalog, status, draft, prompt, blocked, busy, notice, modelDirty, promptDirty, onModelChange, onModelSave, onModelReset, onPromptChange, onPromptSave, onPromptReset, onSelect, onSearchCredential, onBack, backLabel, onNavigate }) {
  const tokens = Number(draft.maxTokens), temperature = draft.temperature.trim() === '' ? null : Number(draft.temperature);
  const invalid = !Number.isInteger(tokens) || tokens < 256 || tokens > 8192 || temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2);
  return <><Back label={backLabel} onClick={onBack}/><PageHead title="模型设置" description="选择回复使用的模型，并单独设置生成参数。"/><Notice notice={notice} area="model"/><div className="wa-stack wa-content-narrow"><section className="wa-card wa-model-card"><div className="wa-card-heading"><div><h2>模型连接</h2><p className="wa-muted">模型服务由 DSH 统一管理。</p></div><div className="wa-card-icon"><Glyph name="model"/></div></div><ModelPicker catalog={catalog} status={status} blocked={blocked} busy={busy} onSelect={onSelect}/><div className="wa-model-summary"><div><h3>默认人设 · {status.persona?.name || '微信助手'}</h3><p>未自定义人设的会话使用此设定，每个会话可独立配置。</p></div><Button icon="person" onClick={() => onNavigate('persona', 'model')}>配置默认人设</Button></div></section>
      <form className="wa-card" onSubmit={event => { event.preventDefault(); onModelSave(); }}><div className="wa-card-heading"><div><h2>生成参数</h2><p className="wa-muted">影响之后开始的回复任务。</p></div></div><div className="wa-form-grid"><Field label="最大输出 Token" id="wa-max-tokens" help="256–8192，控制单次回复的生成上限。"><input className="wa-input" id="wa-max-tokens" type="number" min="256" max="8192" step="1" value={draft.maxTokens} disabled={blocked} onChange={event => onModelChange({ ...draft, maxTokens: event.target.value })}/></Field><Field label="温度" id="wa-temperature" help="0–2；留空时使用模型默认值。"><input className="wa-input" id="wa-temperature" type="number" min="0" max="2" step="any" placeholder="跟随模型默认" value={draft.temperature} disabled={blocked} onChange={event => onModelChange({ ...draft, temperature: event.target.value })}/></Field></div><details className="wa-subsection" data-testid="model-advanced"><summary>高级设置</summary><label className="wa-check-row"><input type="checkbox" aria-label="启用图像理解" checked={draft.vision} disabled={blocked} onChange={event => onModelChange({ ...draft, vision: event.target.checked })}/><span>图像与表情包理解</span></label><p className="wa-help">图片先由视觉模型理解，再将结果交给回复模型并保存进会话记忆。</p><VisionModelPicker catalog={catalog} value={draft.visionModel} disabled={blocked || !draft.vision} onChange={visionModel => onModelChange({ ...draft, visionModel })}/><label className="wa-check-row"><input type="checkbox" aria-label="启用联网搜索" checked={draft.webSearch} disabled={blocked} onChange={event => onModelChange({ ...draft, webSearch: event.target.checked })}/><span>联网搜索</span></label><SearchControls draft={draft} status={status} blocked={blocked} onChange={onModelChange} Field={Field}/></details>{invalid && <p className="wa-help">请检查参数范围：Token 为 256–8192 的整数，温度为 0–2 或留空。</p>}<FormActions dirty={modelDirty} busy={busy === 'model.configure'} disabled={blocked} invalid={invalid} onReset={onModelReset} label="保存生成参数"/></form>
      <SearchCredentials status={status} blocked={blocked} busy={busy} onSave={onSearchCredential} Field={Field} Button={Button}/>
      <form className="wa-card" onSubmit={event => { event.preventDefault(); onPromptSave(); }}><div className="wa-card-heading"><div><h2>当前账号的补充回复要求</h2><p className="wa-muted">在各会话使用的人设基础上，补充这个微信账号的要求。</p></div></div>{status.account ? <><Field label="补充要求" id="wa-prompt" count={prompt.length + ' / 4000'}><textarea className="wa-textarea" id="wa-prompt" rows={4} maxLength={4000} placeholder="例如：在技术讨论中先给结论，再补充必要依据。" value={prompt} disabled={blocked} onChange={event => onPromptChange(event.target.value)}/></Field><FormActions dirty={promptDirty} busy={busy === 'settings'} disabled={blocked} onReset={onPromptReset} label="保存补充要求"/></> : <p className="wa-help">连接微信后，可为当前账号设置补充要求。模型和人设可先行配置。</p>}</form>
    </div></>;
}

function PersonaSettings({ draft, blocked, busy, dirty, notice, onChange, onSave, onReset, onBack, backLabel, onBrowsePresets, onSelectPreset, presetLoad, onUndoPreset }) {
  const aliases = splitLines(draft.aliases);
  const invalid = !draft.name.trim() || aliases.length > 12 || aliases.some(alias => alias.length > 80) || draft.prompt.length > 16000;
  return <><Back label={backLabel} onClick={onBack}/><PageHead title="默认人设" description="未自定义人设的会话使用此设定，也可在每个会话中独立配置。"/><Notice notice={notice} area="persona"/>
    <form className="wa-card wa-content-narrow" onSubmit={event => { event.preventDefault(); onSave(); }}>
      <div className="wa-between"><h2>你希望它怎样与你相处</h2><Button data-testid="browse-persona-presets" disabled={blocked} onClick={onBrowsePresets}>浏览完整人设</Button></div>
      <Field label="内置人设或自定义"><select className="wa-select" aria-label="选择人设模板" value={presetLoad?.id || ''} disabled={blocked} onChange={event => { if (event.target.value) onSelectPreset(event.target.value); }}><option value="">自定义人设 · 直接编辑下方正文</option>{PERSONA_CATEGORIES.map(category => <optgroup key={category.id} label={category.name}>{PERSONA_PRESETS.filter(preset => preset.category === category.id).map(preset => <option key={preset.id} value={preset.id}>{preset.name} · {preset.role}</option>)}</optgroup>)}</select></Field>
      {presetLoad && <div className="wa-alert wa-persona-load-note" role="status" data-testid="preset-loaded-notice"><div>已载入「{presetLoad.label}」<p className="wa-help">尚未保存，可以继续改写。当前名字和昵称按你的选择保留。</p></div><Button disabled={blocked} onClick={onUndoPreset}>撤销载入</Button></div>}
      <Field label="人设正文" id="wa-persona-prompt" count={draft.prompt.length + ' / 16000'} help="身份、性格、说话习惯和示例写在一起即可。保存后用于选择默认人设的会话。"><textarea className="wa-textarea wa-persona-editor" id="wa-persona-prompt" rows={20} maxLength={16000} value={draft.prompt} disabled={blocked} onChange={event => onChange({ ...draft, prompt: event.target.value })} placeholder="例如：你叫小胖，是一个松弛、机灵又靠得住的聊天搭子。日常接梗，认真问题就说清楚……"/></Field>
      <div className="wa-note-box"><strong>自然回复与角色口吻</strong><p className="wa-help">人设决定词汇、节奏、态度和互动方式，全局规则减少多余套话，完成请求后自然结束。普通闲聊默认简短；诗歌、故事、代码、步骤等按实际请求保留。不会把不同角色统一改成一种助手口吻，也不编造现实经历和关系。</p></div>
      <details className="wa-subsection"><summary>名字与唤醒词 · {draft.name || '未设置'}</summary><p className="wa-help">这是群聊识别呼叫的名字，与上面的人设正文分开保存。</p><div className="wa-form-grid"><Field label="Agent 名字" id="wa-persona-name"><input className="wa-input" id="wa-persona-name" maxLength={80} value={draft.name} disabled={blocked} onChange={event => onChange({ ...draft, name: event.target.value })}/></Field><Field label="其他昵称与别名" id="wa-persona-aliases" help="每行一个或用逗号分隔，最多 12 个。"><textarea className="wa-textarea" id="wa-persona-aliases" rows={2} value={draft.aliases} maxLength={1000} disabled={blocked} onChange={event => onChange({ ...draft, aliases: event.target.value })}/></Field></div></details>
      <FormActions dirty={dirty} busy={busy === 'persona.save'} disabled={blocked} invalid={invalid} onReset={onReset} label="保存默认人设" hint="保存后用于跟随默认人设的会话；已有会话记忆继续保留。"/>
    </form></>;
}

function StorageSettings({ status, draft, blocked, busy, dirty, notice, onChange, onSave, onReset, onBack, backLabel }) {
  const storage = status.storage || {};
  const directories = [['workspacePath', 'Agent 工作空间'], ['recordsPath', '会话记录'], ['memoryPath', '记忆资料'], ['assetsPath', '表情与图片素材'], ['tasksPath', '定时任务'], ['loginPath', '微信登录资料'], ['cachePath', '缓存']];
  return <><Back label={backLabel} onClick={onBack}/><PageHead title="全局工作目录" description="只需设置一个目录，插件会自动管理各类数据的保存位置。"/><Notice notice={notice} area="storage"/><div className="wa-stack wa-content-narrow"><form className="wa-card" onSubmit={event => { event.preventDefault(); onSave(); }}><div className="wa-card-heading"><div><h2>插件数据的统一位置</h2><p className="wa-muted">填写本机可写入的绝对目录路径。</p></div><div className="wa-card-icon"><Glyph name="folder"/></div></div><Field label="全局工作目录" id="wa-base-path" help="工作空间、记录、记忆、素材、定时任务、登录资料和缓存都在此目录下自动管理。"><input className="wa-input wa-mono" id="wa-base-path" value={draft.basePath} disabled={blocked} placeholder="例如：D:\WechatAgent" onChange={event => onChange({ ...draft, basePath: event.target.value })}/></Field><div className="wa-note-box"><p>切换时先停止接收新的回复任务，等待当前任务收尾，再迁移所有插件数据；旧目录继续保留。</p><p>迁移完成后使用新目录。保存失败时保留输入草稿，方便核对后重试。</p></div><details className="wa-subsection" data-testid="storage-derived-paths"><summary>查看自动管理的目录</summary><p className="wa-help">以下为当前已应用的位置，由全局工作目录自动派生。</p>{directories.map(([key, label]) => <div className="wa-subsection" key={key}><h3>{label}</h3><div className="wa-path-value" data-storage-path={key}>{storage[key] || '正在读取保存位置'}</div></div>)}</details><FormActions dirty={dirty} busy={busy === 'storage.save'} disabled={blocked} invalid={!draft.basePath.trim()} onReset={onReset} label="保存目录并应用"/></form>
      <section className="wa-card"><div className="wa-card-heading"><div><h2>数据如何保存</h2><p className="wa-muted">微信历史、插件记录与模型会话各有不同来源。</p></div></div><div className="wa-note-box"><p><strong>插件记录不等同于微信完整聊天历史。</strong></p><p>这里保存插件同步后观察到的消息与处理结果，最近 {storage.observedMessageLimit || 1000} 条观察消息可用于上下文。微信客户端已有的全部历史不会自动导入。</p></div><div className="wa-subsection"><h3>DSH 原生 Agent 会话</h3><p className="wa-help">模型会话与原生日志仍由 DSH 管理，插件保存对应会话的引用与独立记录。</p><div className="wa-path-value">{storage.dshSessionPath || '由 DSH 统一管理'}</div></div></section></div></>;
}

function Records({ rows, selected, onSelect, query, setQuery, type, setType, data, loading, error, offset, onOffset, onRefresh, onInspect, blocked, processing, onCancel, onCancelAll, notice }) {
  const filtered = rows.filter(item => (type === 'all' || peerType(item) === type) && matchesSearch(item, query));
  const records = data?.records || [], current = selected?.processing;
  const pending = (current?.active ? 1 : 0) + (current?.queued || 0);
  return <>
    <PageHead title="处理记录" description="按会话查看问题、回复与微信回执，分别保留上下文。">
      <Button icon="pause" disabled={blocked || !processing?.active && !processing?.queued} onClick={onCancelAll}>取消全部回复任务</Button>
    </PageHead>
    <Notice notice={notice} area="records"/>
    <div className="wa-records-layout">
      <aside className="wa-records-sidebar" aria-label="记录会话列表">
        <Search value={query} onChange={setQuery} label="搜索记录会话" placeholder="搜索名称或会话 ID"/>
        <div style={{ margin: '0 4px 16px' }}><TypeFilters value={type} onChange={setType}/></div>
        <p className="wa-records-sidebar-label">{filtered.length} 个会话 · 记录分别保存</p>
        <div className="wa-records-peers">{filtered.map(item =>
          <button type="button" key={conversationKey(item)} className="wa-records-peer" data-peer-id={peerId(item)} data-chat-type={peerType(item)} aria-current={selected && conversationKey(selected) === conversationKey(item) ? 'true' : undefined} onClick={() => onSelect(item)}>
            <span className={'wa-session-avatar ' + (peerType(item) === 'group' ? 'is-group' : '')}>{initials(peerName(item))}</span>
            <span className="wa-session-info"><span className="wa-session-title" style={{ display: 'block' }}>{peerName(item)}</span><span className="wa-session-meta">{peerType(item) === 'group' ? '群聊' : '私聊'}{!item.authorized ? ' · 已撤销授权' : ''}</span></span>
            <span className="wa-record-count">{item.recordCount || 0}</span>
          </button>
        )}</div>
        {!filtered.length && <Empty icon="search" title="没有匹配的会话" description={query ? '尝试其他名称或 ID。' : '授权后，每个会话将在这里独立显示。'}/>}
      </aside>
      <section className="wa-records-main" aria-label="当前会话处理记录">
        {!selected ? <Empty icon="history" title="选择一个会话" description="每个群聊与私聊的处理记录独立展示，不会混在一起。"/> : <>
          <header className="wa-records-head">
            <div>
              <h2>{peerName(selected)}</h2><p className="wa-muted wa-mono">{peerId(selected)}</p>
              <details className="wa-records-location" key={conversationKey(selected)}>
                <summary><Glyph name="folder" className="wa-icon-small"/>记录保存位置</summary>
                <div className="wa-path-value">{data?.recordsPath || selected.recordsPath || '此会话使用独立记录目录'}</div>
              </details>
              <p className="wa-help" data-testid="conversation-processing" aria-live="polite">{current?.active ? '正在回复' : '当前没有运行中的回复'}{current?.queued ? ' · ' + current.queued + ' 条等待处理' : ''}</p>
            </div>
            <div className="wa-row wa-records-actions">
              <Button icon="pause" data-testid="cancel-conversation" disabled={blocked || !pending} onClick={onCancel}>取消此会话任务</Button>
              <Button quiet icon="refresh" className="wa-icon-button" disabled={loading} onClick={onRefresh} aria-label="刷新此会话记录" title="刷新此会话记录"/>
            </div>
          </header>
          <div className="wa-records-body">
            {data?.newerCount > 0 && <div className="wa-alert wa-between" data-testid="new-records-notice" role="status">
              <span>有 {data.newerCount} 条新记录，当前浏览位置保持不变。</span>
              <Button quiet disabled={loading} onClick={onRefresh}>查看最新记录</Button>
            </div>}
            {error && <div className="wa-alert is-error wa-section-space" role="alert">{error}</div>}
            {loading && !data ? <div className="wa-loading-block" aria-label="正在读取此会话记录"><div className="wa-skeleton" style={{ width: '60%' }}/><div className="wa-skeleton"/><div className="wa-skeleton" style={{ width: '80%' }}/></div>
              : records.length ? records.map(record =>
                <details className="wa-record" key={record.key} data-record-key={record.key} onToggle={event => { if (event.currentTarget.open) onInspect(); }}>
                  <summary>
                    <div className="wa-record-meta"><span>{record.sender || (peerType(selected) === 'group' ? '群成员' : peerName(selected))}</span><time>{formatTime(record.createdAt)}</time></div>
                    <div className="wa-record-headline"><span className="wa-record-question">{record.question || record.reason || '这条消息没有可显示的正文'}</span><StateBadge state={record.state}/></div>
                  </summary>
                  <div className="wa-record-content">
                    {record.replyMedia && <p className="wa-help">已选择{record.replyMedia.kind === 'sticker' ? '表情包' : '图片'}：{record.replyMedia.name} · 发送结果以本条回执状态为准</p>}{record.reply && <p className="wa-record-reply">{record.reply}</p>}
                    {record.reason && <p className="wa-alert">{record.reason}</p>}
                    {record.acknowledgedMessageIds?.length > 0 && <p className="wa-muted">微信服务端已确认 {record.acknowledgedMessageIds.length} 条消息；回执不代表对方已读。</p>}
                    <p className="wa-muted">{formatTime(record.createdAt, true)}{record.updatedAt ? ' · 更新于 ' + formatTime(record.updatedAt, true) : ''}</p>
                  </div>
                </details>
              ) : !error && <Empty icon="history" title="此会话还没有处理记录" description="授权后收到的新消息与回复结果会保存在这个会话中。"/>}
          </div>
          <footer className="wa-pagination">
            <span>{data ? '共 ' + data.total + ' 条 · 第 ' + (Math.floor(offset / (data.limit || 50)) + 1) + ' 页' : '正在读取记录'}</span>
            <div className="wa-row"><Button disabled={loading || offset <= 0} onClick={() => onOffset(Math.max(0, offset - (data?.limit || 50)))}>上一页</Button><Button disabled={loading || !data?.hasMore} onClick={() => onOffset(offset + (data?.limit || 50))}>下一页</Button></div>
          </footer>
        </>}
      </section>
    </div>
    <p className="wa-help wa-section-space">这里显示插件观察和处理的消息，微信客户端中的完整历史不会自动导入。展开或翻页时保留浏览位置，可刷新查看最新记录。</p>
  </>;
}


export function WechatPanel({ connection, catalog }) {
  const motion = useVisualMotion();
  const [status, setStatus] = useState(null), [page, setPage] = useState('overview'), [returnPages, setReturnPages] = useState({});
  const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [busy, setBusy] = useState(''), [busyArea, setBusyArea] = useState(''), [notice, setNotice] = useState(null);
  const [contacts, setContacts] = useState(null), [authQuery, setAuthQuery] = useState(''), [authType, setAuthType] = useState('all'), [authTab, setAuthTab] = useState('authorized');
  const [detailKey, setDetailKey] = useState(null), [drafts, setDrafts] = useState({ persona: null, model: null, storage: null, prompt: '', conversation: null });
  const [personaLoad, setPersonaLoad] = useState(null);
  const [recordPeer, setRecordPeer] = useState(null), [recordQuery, setRecordQuery] = useState(''), [recordType, setRecordType] = useState('all');
  const [recordOffset, setRecordOffset] = useState(0), [recordAnchor, setRecordAnchor] = useState(null), [recordData, setRecordData] = useState(null), [recordLoading, setRecordLoading] = useState(false), [recordError, setRecordError] = useState(''), [recordEpoch, setRecordEpoch] = useState(0);
  const mounted = useRef(false), statusRef = useRef(null), draftsRef = useRef(drafts), busyRef = useRef(false), statusEpoch = useRef(0), detailRef = useRef(null), recordRequestEpoch = useRef(0), workspaceRef = useRef(null);
  useEffect(() => { workspaceRef.current?.scrollTo({ top: 0, left: 0 }); }, [page, detailKey]);
  const rows = useMemo(() => mergeConversations(status, contacts), [status, contacts]);
  const detail = rows.find(item => conversationKey(item) === detailKey) || null;
  const recordRows = useMemo(() => rows.filter(item => item.authorized || item.hasArchive).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)), [rows]);
  const recordSelected = recordPeer ? recordRows.find(item => conversationKey(item) === conversationKey(recordPeer)) : null;
  const setDraft = (name, value) => {
    const next = { ...draftsRef.current, [name]: value }; draftsRef.current = next; setDrafts(next);
    setNotice(previous => previous?.area === name || name === 'prompt' && previous?.area === 'model' ? null : previous);
  };
  const accept = (value, force = []) => {
    if (!mounted.current || !value) return;
    const previous = statusRef.current, accountChanged = (previous?.account?.id || null) !== (value.account?.id || null), next = { ...draftsRef.current };
    const sync = (field, before, after, forced = false) => { if (next[field] === null || same(next[field], before) || force.includes(field) || forced) next[field] = after; };
    sync('persona', personaDraft(previous?.persona), personaDraft(value.persona));
    if (force.includes('persona')) setPersonaLoad(null);
    sync('model', modelDraft(previous?.modelConfig), modelDraft(value.modelConfig));
    sync('storage', storageDraft(previous?.storage), storageDraft(value.storage));
    sync('prompt', previous?.settings?.prompt || '', value.settings?.prompt || '', accountChanged);
    if (accountChanged) {
      recordRequestEpoch.current++;
      setContacts(null); setRecordPeer(null); setRecordOffset(0); setRecordAnchor(null); setRecordData(null); setRecordError('');
      setDetailKey(null); detailRef.current = null; next.conversation = null; setNotice(null);
      setPage(current => current === 'conversation' ? 'authorization' : current);
    } else if (detailRef.current) {
      const before = previous?.conversations?.find(item => conversationKey(item) === detailRef.current);
      const after = value.conversations?.find(item => conversationKey(item) === detailRef.current);
      if (after) sync('conversation', configDraft(before?.config, previous?.persona), configDraft(after.config, value.persona));
    }
    draftsRef.current = next; setDrafts(next); statusRef.current = value; setStatus(value);
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); let timer;
    const poll = async () => {
      const epoch = statusEpoch.current;
      if (!busyRef.current) {
        try {
          const value = await call(connection, 'status', {}, AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]));
          if (!controller.signal.aborted && epoch === statusEpoch.current) { accept(value); setConnectionError(''); }
        } catch (failure) { if (!controller.signal.aborted && epoch === statusEpoch.current) setConnectionError(failure.message); }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); statusEpoch.current++; };
  }, [connection]);
  const action = async (endpoint, payload = {}, options = {}) => {
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(endpoint); setBusyArea(options.area || page); setError(''); setNotice(null);
    const epoch = ++statusEpoch.current, accountId = statusRef.current?.account?.id;
    try {
      const timeout = ['storage.save', 'conversation.configure', 'disconnect', 'cancel'].includes(endpoint) ? 120000 : 30000;
      const value = await call(connection, endpoint, payload, AbortSignal.timeout(timeout));
      if (!mounted.current || epoch !== statusEpoch.current) return null;
      if (endpoint === 'contacts') { if (accountId === statusRef.current?.account?.id) setContacts(value); }
      else { accept(value, options.force || []); setConnectionError(''); }
      if (options.text && (!payload.accountId || value.account?.id === payload.accountId)) setNotice({ area: options.area || page, text: options.text });
      if (['storage.save', 'conversation.configure', 'settings', 'cancel'].includes(endpoint)) setRecordEpoch(value => value + 1);
      return value;
    } catch (failure) { if (mounted.current && epoch === statusEpoch.current) setError(failure.message || '操作未完成，请核对当前状态。'); return null; }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  };
  useEffect(() => {
    if (page === 'authorization' && status?.online && !contacts && !busyRef.current) void action('contacts');
  }, [page, authTab, status?.online, status?.account?.id]);
  const navigate = (next, from) => { if (from) setReturnPages(current => ({ ...current, [next]: from })); setPage(next); };
  const loadPersonaPreset = (id, keepIdentity) => {
    if (busyRef.current) return;
    const preset = getPersonaPreset(id), previous = structuredClone(draftsRef.current.persona);
    if (!preset || !previous) return;
    const identity = keepIdentity ? { name: previous.name, aliases: splitLines(previous.aliases) } : undefined;
    setDraft('persona', personaDraft(personaFromPreset(id, identity)));
    setPersonaLoad({ id, label: preset.name + ' · ' + preset.role, previous }); setPage('persona');
  };
  const undoPersonaPreset = () => {
    if (busyRef.current || !personaLoad) return;
    setDraft('persona', structuredClone(personaLoad.previous)); setPersonaLoad(null);
  };
  const backPage = returnPages[page] || 'settings', back = () => setPage(backPage), backLabel = '返回' + (pageLabels[backPage] || '设置');
  const openDetail = peer => { const key = conversationKey(peer); detailRef.current = key; setDetailKey(key); setDraft('conversation', configDraft(peer.config, statusRef.current?.persona)); setPage('conversation'); setNotice(null); };
  const selectRecord = peer => { recordRequestEpoch.current++; setRecordLoading(true); setRecordPeer({ peerId: peerId(peer), chatType: peerType(peer) }); setRecordOffset(0); setRecordAnchor(null); setRecordData(null); setRecordError(''); };
  const holdRecordPosition = () => { if (!recordAnchor && recordData?.anchor) { recordRequestEpoch.current++; setRecordAnchor(recordData.anchor); } };
  const changeRecordPage = offset => {
    recordRequestEpoch.current++; setRecordLoading(true); setRecordAnchor(recordAnchor || recordData?.anchor || null);
    setRecordOffset(offset); setRecordData(null); setRecordError('');
  };
  const refreshRecords = () => {
    recordRequestEpoch.current++; setRecordLoading(true); setRecordAnchor(null); setRecordOffset(0);
    setRecordData(null); setRecordError(''); setRecordEpoch(value => value + 1);
  };
  const openRecords = peer => { selectRecord(peer); setPage('records'); };
  useEffect(() => {
    if (page === 'records' && (!recordPeer || !recordRows.some(item => conversationKey(item) === conversationKey(recordPeer)))) {
      if (recordRows[0]) selectRecord(recordRows[0]); else { setRecordPeer(null); setRecordData(null); }
    }
  }, [page, recordPeer?.peerId, recordPeer?.chatType, recordRows.map(conversationKey).join('|'), status?.account?.id]);
  useEffect(() => {
    if (page !== 'records' || !recordPeer || !status?.account?.id) return;
    const controller = new AbortController(), accountId = status.account.id, queryEpoch = ++recordRequestEpoch.current;
    let timer, first = true;
    const poll = async () => {
      if (first) setRecordLoading(true);
      try {
        const value = await call(connection, 'records.list', { accountId, chatType: recordPeer.chatType, peerId: recordPeer.peerId, offset: recordOffset, limit: 50, anchor: recordAnchor }, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
        if (controller.signal.aborted || queryEpoch !== recordRequestEpoch.current || statusRef.current?.account?.id !== accountId) return;
        setRecordData(value); setRecordError('');
        if (recordOffset > 0 && value.total <= recordOffset) setRecordOffset(Math.max(0, Math.floor(Math.max(0, value.total - 1) / (value.limit || 50)) * (value.limit || 50)));
      } catch (failure) { if (!controller.signal.aborted && queryEpoch === recordRequestEpoch.current && statusRef.current?.account?.id === accountId) setRecordError(failure.message); }
      finally { if (!controller.signal.aborted && queryEpoch === recordRequestEpoch.current) setRecordLoading(false); }
      first = false; if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [connection, page, recordPeer?.peerId, recordPeer?.chatType, status?.account?.id, recordOffset, recordAnchor, recordEpoch]);
  const saveSettings = (settings, options = {}) => action('settings', { accountId: statusRef.current.account.id, settings }, options);
  const grant = async (peer, enabled) => {
    if (!statusRef.current?.account) return null;
    const settings = statusRef.current.settings, field = peerType(peer) === 'group' ? 'groups' : 'privatePeers';
    return saveSettings({ ...settings, [field]: enabled ? [...new Set([...settings[field], peerId(peer)])] : settings[field].filter(id => id !== peerId(peer)) }, { area: page === 'conversation' ? 'conversation' : 'authorization', text: enabled ? '会话已授权，可进入设置选择回复模式。' : '已撤销此会话授权，已有记录继续保留。' });
  };
  const blocked = !!busy || !!status?.startupError;
  const navPage = ['model', 'identity', 'persona', 'persona-library', 'storage', 'changelog'].includes(page) ? 'settings' : page === 'conversation' ? 'authorization' : page;
  const warning = error || connectionError || status?.startupError?.message || status?.processing?.fault?.message;
  let content;


  if (!status || !drafts.persona || !drafts.model || !drafts.storage) content = <><PageHead title="微信 Agent" description="正在读取你的工作台…"/><div className="wa-card wa-loading-block"><div className="wa-skeleton" style={{ width: '42%' }}/><div className="wa-skeleton" style={{ width: '78%' }}/><div className="wa-skeleton"/></div></>;
  else if (page === 'overview') content = <Overview status={status} busy={busy} blocked={blocked} onAction={action} onNavigate={navigate}/>;
  else if (page === 'authorization') content = <Authorization key={status.account?.id || 'offline'} status={status} rows={rows} contacts={contacts} query={authQuery} setQuery={setAuthQuery} type={authType} setType={setAuthType} tab={authTab} setTab={setAuthTab} blocked={blocked} busy={busy} notice={notice} onAction={action} onGrant={grant} onDetail={openDetail} onToggle={enabled => saveSettings({ ...statusRef.current.settings, enabled }, { area: 'authorization', text: enabled ? '自动回复已开启，开始处理之后收到的新消息。' : '自动回复已暂停，授权与记录继续保留。' })}/>;
  else if (page === 'settings') content = <SettingsIndex status={status} onNavigate={navigate}/>;
  else if (page === 'identity') content = <IdentitySettings connection={connection} blocked={blocked} onSave={payload => action('identity.save', payload, { area: 'identity' })} onBack={back} backLabel={backLabel}/>;
  else if (page === 'changelog') content = <Changelog connection={connection} onBack={() => setPage('settings')}/>;
  else if (page === 'model') content = <ModelSettings catalog={catalog} status={status} draft={drafts.model} prompt={drafts.prompt} blocked={blocked} busy={busyArea === 'model' ? busy : ''} notice={notice} modelDirty={!same(drafts.model, modelDraft(status.modelConfig))} promptDirty={drafts.prompt !== (status.settings?.prompt || '')} onModelChange={value => setDraft('model', value)} onModelSave={() => action('model.configure', { modelConfig: { vision: draftsRef.current.model.vision, visionModel: draftsRef.current.model.visionModel, webSearch: draftsRef.current.model.webSearch, searchProvider: draftsRef.current.model.searchProvider, tavilyBaseURL: draftsRef.current.model.tavilyBaseURL, maxTokens: Number(draftsRef.current.model.maxTokens), temperature: draftsRef.current.model.temperature.trim() === '' ? null : Number(draftsRef.current.model.temperature) } }, { area: 'model', force: ['model'], text: '生成参数已保存，从下一个任务开始生效。' })} onModelReset={() => setDraft('model', modelDraft(status.modelConfig))} onPromptChange={value => setDraft('prompt', value)} onPromptSave={() => saveSettings({ ...statusRef.current.settings, prompt: draftsRef.current.prompt }, { area: 'model', force: ['prompt'], text: '当前账号的补充回复要求已保存。' })} onPromptReset={() => setDraft('prompt', status.settings?.prompt || '')} onSearchCredential={(provider, apiKey) => action('search.credentials', { provider, apiKey }, { area: 'model', text: '搜索密钥已保存，之后的查询使用新凭据。' })} onSelect={selection => action('model.select', { selection }, { area: 'model', text: selection ? '回复模型已保存，从下一个任务开始生效。' : '已跟随 DSH 默认模型，从下一个任务开始生效。' })} onBack={back} backLabel={backLabel} onNavigate={navigate}/>;
  else if (page === 'persona') content = <PersonaSettings draft={drafts.persona} blocked={blocked} busy={busyArea === 'persona' ? busy : ''} dirty={!same(drafts.persona, personaDraft(status.persona))} notice={notice} onChange={value => setDraft('persona', value)} onSave={() => action('persona.save', { persona: { ...draftsRef.current.persona, name: draftsRef.current.persona.name.trim(), aliases: splitLines(draftsRef.current.persona.aliases) } }, { area: 'persona', force: ['persona'], text: '人设已保存，将用于之后开始的回复任务。' })} onReset={() => { setDraft('persona', personaDraft(status.persona)); setPersonaLoad(null); }} onBack={back} backLabel={backLabel} onBrowsePresets={() => navigate('persona-library', 'persona')} onSelectPreset={id => loadPersonaPreset(id, true)} presetLoad={personaLoad} onUndoPreset={undoPersonaPreset}/>;
  else if (page === 'persona-library') content = <PersonaLibrary draft={drafts.persona} blocked={blocked} onBack={() => setPage('persona')} onLoad={loadPersonaPreset}/>;
  else if (page === 'storage') content = <StorageSettings status={status} draft={drafts.storage} blocked={blocked} busy={busyArea === 'storage' ? busy : ''} dirty={!same(drafts.storage, storageDraft(status.storage))} notice={notice} onChange={value => setDraft('storage', value)} onSave={() => action('storage.save', { storage: { basePath: draftsRef.current.storage.basePath.trim() } }, { area: 'storage', force: ['storage'], text: '全局工作目录已应用，插件数据已整理到新位置；旧目录继续保留。' })} onReset={() => setDraft('storage', storageDraft(status.storage))} onBack={back} backLabel={backLabel}/>;
  else if (page === 'conversation') content = <ConversationSettings peer={detail} draft={drafts.conversation} status={status} blocked={blocked} busy={busyArea === 'conversation' ? busy : ''} notice={notice} dirty={!same(drafts.conversation, configDraft(detail?.config, status.persona))} onChange={value => setDraft('conversation', value)} onSave={() => action('conversation.configure', { accountId: status.account.id, chatType: peerType(detail), peerId: peerId(detail), config: configPayload(draftsRef.current.conversation) }, { area: 'conversation', force: ['conversation'], text: '此会话的设置已保存，之后的回复使用新设置。' })} onReset={() => setDraft('conversation', configDraft(detail?.config, status.persona))} onBack={() => setPage('authorization')} onNavigate={navigate} onRecords={openRecords} onRevoke={peer => grant(peer, false)}/>;
  else if (page === 'memory') content = <MemoryWorkspace key={status.account?.id || 'offline'} rpc={(endpoint, payload, signal) => call(connection, endpoint, payload, signal || AbortSignal.timeout(['memory.compress', 'memory.retryImages', 'memory.global.extract'].includes(endpoint) ? 240000 : 30000))} status={status} rows={recordRows} initialPeer={detail}/>;
  else if (page === 'assets') content = <MediaLibraryPage key={status.account?.id || 'offline'} rpc={(endpoint, payload, signal) => call(connection, endpoint, payload, signal || AbortSignal.timeout(endpoint === 'assets.describe' ? 300000 : 30000))} status={status}/>;
  else if (page === 'tasks') content = <TasksPage key={status.account?.id || 'offline'} rpc={(endpoint, payload, signal) => call(connection, endpoint, payload, signal || AbortSignal.timeout(30000))} status={status} rows={rows} initialPeer={detail}/>;
  else if (page === 'records') content = <Records rows={recordRows} selected={recordSelected} onSelect={selectRecord} query={recordQuery} setQuery={setRecordQuery} type={recordType} setType={setRecordType} data={recordData} loading={recordLoading} error={recordError} offset={recordOffset} onOffset={changeRecordPage} onRefresh={refreshRecords} onInspect={holdRecordPosition} blocked={blocked} processing={status.processing} notice={notice} onCancelAll={() => action('cancel', {}, { area: 'records', text: '已取消全部会话的当前任务和等待任务。' })} onCancel={() => recordSelected && action('cancel', { accountId: status.account.id, chatType: peerType(recordSelected), peerId: peerId(recordSelected) }, { area: 'records', text: '已取消此会话的当前任务和等待任务，其他会话继续处理。' })}/>;
  return <div className="wa-panel" data-motion={motion.enabled ? 'on' : 'off'} data-page={page}><style>{css}</style><div className="wa-shell"><aside className="wa-nav" aria-label="微信 Agent 导航"><div className="wa-brand"><div className="wa-brand-mark"><Glyph name="chat"/></div><div><strong>微信 Agent</strong><small>CONVERSATIONS</small></div></div><nav className="wa-nav-list"><div className="wa-nav-label">工作空间</div>{[['overview', 'grid', '概览'], ['authorization', 'people', '会话'], ['records', 'history', '记录'], ['memory', 'folder', '记忆'], ['tasks', 'history', '定时'], ['assets', 'image', '素材'], ['settings', 'settings', '设置']].map(([id, icon, label]) => <button type="button" className="wa-nav-button" data-testid={'nav-' + id} key={id} aria-current={navPage === id ? 'page' : undefined} aria-label={pageLabels[id]} title={pageLabels[id]} onClick={() => navigate(id)}><Glyph name={icon}/><span>{label}</span>{id === 'authorization' && status && <span className="wa-nav-count">{(status.settings?.privatePeers?.length || 0) + (status.settings?.groups?.length || 0)}</span>}</button>)}</nav><div className="wa-nav-footer"><div className="wa-status-line"><span className={'wa-status-dot ' + (status?.online ? 'is-online' : '')}/>{status?.online ? '微信已连接' : status ? '微信未连接' : '正在连接'}</div><span>DeepSeek Harness 插件</span></div></aside><main className="wa-workspace" ref={workspaceRef}><div className="wa-workspace-chrome"><div className="wa-breadcrumb" aria-label="当前位置"><span>微信 Agent</span><span className="wa-breadcrumb-divider" aria-hidden="true">/</span><span>{pageLabels[page] || '工作台'}</span></div><MotionControl motion={motion}/></div>{warning && <div className="wa-alert is-error" role="alert"><div className="wa-between"><span>{warning}</span><Button quiet disabled={!!busy} icon="refresh" onClick={() => action('status')}>重新读取</Button></div></div>}{content}<footer className="wa-footer"><span>微信 Agent {status?.version || ''}</span><span>每个会话，各自的上下文</span></footer></main></div></div>;
}

function Icon() { return <Glyph name="chat" size={20}/>; }
export function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => <WechatPanel connection={ctx.connection} catalog={ctx.modelDirectories.catalog}/>));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => '微信 Agent' }, Icon));
}
