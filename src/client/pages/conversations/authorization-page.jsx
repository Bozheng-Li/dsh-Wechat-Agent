import { useState } from 'react';
import { conversationKey, initials, matchesSearch, peerId, peerName, peerType } from '../../shared/conversations.mjs';
import { modeLabels } from '../../shared/labels.mjs';
import { Button } from '../../components/button.jsx';
import { PageHead, Empty, Notice, Search, TypeFilters } from '../../components/page-ui.jsx';

export function Authorization({
  status,
  rows,
  contacts,
  query,
  setQuery,
  type,
  setType,
  tab,
  setTab,
  blocked,
  busy,
  notice,
  onAction,
  onGrant,
  onDetail,
  onToggle,
}) {
  const [nameQuery, setNameQuery] = useState(''),
    [nameType, setNameType] = useState('all');
  const authorized = rows.filter((item) => item.authorized);
  const discoveredKeys = new Set([
    ...(contacts?.privatePeers || []).map((item) => conversationKey({ ...item, chatType: 'private' })),
    ...(contacts?.groups || []).map((item) => conversationKey({ ...item, chatType: 'group' })),
  ]);
  const source = tab === 'authorized' ? authorized : rows.filter((item) => discoveredKeys.has(conversationKey(item)));
  const filtered = source.filter((item) => (type === 'all' || peerType(item) === type) && matchesSearch(item, query));
  const suggestions = nameQuery.trim()
    ? rows.filter((item) => (nameType === 'all' || peerType(item) === nameType) && matchesSearch(item, nameQuery))
    : [];
  const row = (item) => (
    <div
      className="wa-session-row"
      data-peer-id={peerId(item)}
      data-chat-type={peerType(item)}
      key={conversationKey(item)}
    >
      <div className={'wa-session-avatar ' + (peerType(item) === 'group' ? 'is-group' : '')}>
        {initials(peerName(item))}
      </div>
      <div className="wa-session-info">
        <div className="wa-session-title" title={peerName(item)}>
          {peerName(item)}
        </div>
        <div className="wa-session-meta">
          <span>{peerType(item) === 'group' ? '群聊' : '私聊'}</span>
          <span>{item.remark || item.nickname || ''}</span>
          <span className="wa-mono" title={peerId(item)}>
            …{peerId(item).slice(-8)}
          </span>
        </div>
      </div>
      <div className="wa-session-actions">
        {item.authorized && (
          <span className="wa-badge">
            {peerType(item) === 'group' ? modeLabels[item.config?.mode || 'default'] : '私聊回复'}
          </span>
        )}
        {item.authorized ? (
          <>
            <Button disabled={blocked} onClick={() => onDetail(item)}>
              设置
            </Button>
            <Button
              quiet
              className="wa-icon-button"
              icon="close"
              disabled={blocked}
              title={'撤销 ' + peerName(item) + ' 的授权'}
              aria-label={'撤销 ' + peerName(item) + ' 的授权'}
              onClick={() => onGrant(item, false)}
            />
          </>
        ) : (
          <Button icon="plus" disabled={blocked} onClick={() => onGrant(item, true)}>
            授权
          </Button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <PageHead title="会话授权" description="输入微信名、备注或群名，选择 Agent 可以回复的会话。">
        <Button icon="refresh" disabled={blocked || !status.online} onClick={() => onAction('contacts')}>
          {busy === 'contacts' ? '正在同步…' : '同步已发现会话'}
        </Button>
      </PageHead>
      <Notice notice={notice} area="authorization" />
      {!status.account ? (
        <section className="wa-card">
          <Empty icon="shield" title="先连接一个微信账号" description="连接后按名字搜索联系人和群聊。" />
        </section>
      ) : (
        <>
          <div className="wa-auth-toggle">
            <div className="wa-toggle-copy">
              <h3>自动回复</h3>
              <p>
                {status.settings.enabled
                  ? '按各个会话的模式处理新消息，并执行已保存的定时任务。'
                  : '授权、记忆与任务继续保留，当前暂停回复和定时发送。'}
              </p>
            </div>
            <label className="wa-toggle">
              <input
                type="checkbox"
                checked={status.settings.enabled}
                disabled={blocked}
                onChange={(event) => onToggle(event.target.checked)}
                aria-label="启用自动回复"
              />
              <span>{status.settings.enabled ? '已开启' : '已暂停'}</span>
            </label>
          </div>
          <section className="wa-manual-box wa-name-add" data-testid="name-add">
            <h3>通过名字添加</h3>
            <p className="wa-help">
              输入部分微信名、备注或群名，例如“李”，在下面的匹配列表中选择。同名会话需分别选择。
            </p>
            <div className="wa-row wa-section-space">
              <select
                className="wa-select"
                aria-label="按名字添加的会话类型"
                value={nameType}
                onChange={(event) => setNameType(event.target.value)}
              >
                <option value="all">全部类型</option>
                <option value="group">群聊</option>
                <option value="private">私聊</option>
              </select>
              <input
                className="wa-input"
                aria-label="添加会话的微信名"
                data-testid="add-conversation-name"
                value={nameQuery}
                onChange={(event) => setNameQuery(event.target.value)}
                placeholder="例如：李、产品讨论、周末搭子"
                maxLength={150}
              />
            </div>
            {nameQuery.trim() && (
              <>
                <p className="wa-help" role="status">
                  找到 {suggestions.length} 个匹配会话
                </p>
                <div className="wa-name-suggestions">{suggestions.map(row)}</div>
                {!suggestions.length && (
                  <p className="wa-help">暂未找到。可以换个字、试试备注或同步已发现会话；新会话需要先被微信同步到。</p>
                )}
              </>
            )}
          </section>
          <div className="wa-tabs" role="tablist" aria-label="会话来源">
            <button
              type="button"
              role="tab"
              className="wa-tab"
              aria-selected={tab === 'authorized'}
              onClick={() => setTab('authorized')}
            >
              已授权<span className="wa-tab-count">{authorized.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              className="wa-tab"
              aria-selected={tab === 'discovered'}
              onClick={() => setTab('discovered')}
            >
              发现会话<span className="wa-tab-count">{discoveredKeys.size}</span>
            </button>
          </div>
          <div className="wa-toolbar">
            <Search value={query} onChange={setQuery} />
            <TypeFilters value={type} onChange={setType} />
          </div>
          <div className="wa-session-list">
            {filtered.length ? (
              filtered.map(row)
            ) : (
              <Empty icon="search" title="没有匹配的会话" description="可以在上方按名字添加，或调整筛选条件。" />
            )}
          </div>
          <p className="wa-help wa-section-space">
            显示 {filtered.length} / {source.length} 个会话
          </p>
        </>
      )}
    </>
  );
}
