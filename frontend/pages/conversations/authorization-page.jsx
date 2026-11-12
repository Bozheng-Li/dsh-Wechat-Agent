import { useEffect, useState } from 'react';
import { conversationKey, initials, matchesSearch, peerId, peerName, peerType } from "../../shared/conversations.mjs";
import { modeLabels } from "../../shared/labels.mjs";
import { Button } from "../../components/button.jsx";
import { PageHead, Empty, Notice, Search, TypeFilters } from "../../components/page-ui.jsx";

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
  onGrantMany,
  onDetail,
  onNavigate,
}) {
  const [nameQuery, setNameQuery] = useState(''),
    [nameType, setNameType] = useState('all'),
    [selectedKeys, setSelectedKeys] = useState(() => new Set()),
    [pending, setPending] = useState('');
  const authorized = rows.filter((item) => item.authorized);
  const discoveredKeys = new Set([
    ...(contacts?.privatePeers || []).map((item) => conversationKey({ ...item, chatType: 'private' })),
    ...(contacts?.groups || []).map((item) => conversationKey({ ...item, chatType: 'group' })),
  ]);
  const discovered = rows.filter((item) => discoveredKeys.has(conversationKey(item))),
    source = tab === 'authorized' ? authorized : discovered;
  const filtered = source.filter((item) => (type === 'all' || peerType(item) === type) && matchesSearch(item, query));
  const selected = rows.filter((item) => selectedKeys.has(conversationKey(item))),
    grantable = selected.filter((item) => !item.authorized),
    revocable = selected.filter((item) => item.authorized),
    disabled = blocked || !!pending;
  useEffect(() => {
    const allowed = new Set(rows.map(conversationKey));
    setSelectedKeys((previous) => {
      const next = new Set([...previous].filter((key) => allowed.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [rows]);
  const select = (items, checked) => setSelectedKeys((previous) => {
    const next = new Set(previous);
    for (const item of items) {
      const key = conversationKey(item);
      if (checked) next.add(key);
      else next.delete(key);
    }
    return next;
  });
  const applyBulk = async (enabled) => {
    if (disabled || !(enabled ? grantable : revocable).length) return;
    const items = selected;
    setPending(enabled ? 'grant-selected' : 'revoke-selected');
    try {
      const result = await onGrantMany(items, enabled);
      if (result?.account?.id === status.account?.id) select(items, false);
    } finally {
      setPending('');
    }
  };
  const applyOne = async (item, enabled) => {
    if (disabled) return;
    const result = await onGrant(item, enabled);
    if (result?.account?.id === status.account?.id) select([item], false);
  };
  const suggestions = nameQuery.trim()
    ? rows.filter((item) => (nameType === 'all' || peerType(item) === nameType) && matchesSearch(item, nameQuery))
    : [];
  const changeTabWithKeyboard = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'authorized' : event.key === 'End' ? 'discovered'
      : tab === 'authorized' ? 'discovered' : 'authorized';
    setTab(next);
    document.getElementById('wa-authorization-tab-' + next)?.focus();
  };
  const selectionBar = (items, scope, label) => {
    const visibleSelected = items.filter((item) => selectedKeys.has(conversationKey(item))).length,
      allSelected = items.length > 0 && visibleSelected === items.length;
    return (
      <div className="wa-authorization-selection" data-selection-scope={scope}>
        <label className="wa-authorization-select-all">
          <input type="checkbox" aria-label={label}
            checked={allSelected} disabled={disabled || !items.length}
            ref={(element) => { if (element) element.indeterminate = visibleSelected > 0 && !allSelected; }}
            onChange={(event) => select(items, event.target.checked)} />
          {label}
        </label>
        <span className="wa-help" role="status" data-testid="authorization-selection-count">
          已选 {selected.length} 个{selected.length > visibleSelected ? `（其中 ${selected.length - visibleSelected} 个不在当前列表）` : ''}
        </span>
        <div className="wa-row">
          <Button quiet disabled={disabled || !selected.length} onClick={() => setSelectedKeys(new Set())}>
            清空选择
          </Button>
          <Button primary icon="check" data-testid="authorization-grant-selected"
            disabled={disabled || !grantable.length} loading={pending === 'grant-selected'}
            aria-describedby="wa-authorization-selection-scope"
            onClick={() => applyBulk(true)}>
            授权所选
          </Button>
          <Button danger icon="close" data-testid="authorization-revoke-selected"
            disabled={disabled || !revocable.length} loading={pending === 'revoke-selected'}
            aria-describedby="wa-authorization-selection-scope"
            onClick={() => applyBulk(false)}>
            取消所选授权
          </Button>
        </div>
      </div>
    );
  };
  const row = (item) => {
    const secondaryName = [item.remark, item.nickname].find(name => name && name !== peerName(item));
    return (
    <div
      className="wa-session-row has-selection"
      data-peer-id={peerId(item)}
      data-chat-type={peerType(item)}
      data-selected={selectedKeys.has(conversationKey(item)) ? 'true' : undefined}
      key={conversationKey(item)}
    >
        <label className="wa-session-select" title="选择此会话以批量授权或取消授权">
          <input
            type="checkbox"
            aria-label={'选择' + (peerType(item) === 'group' ? '群聊 ' : '私聊 ') + peerName(item) + '（' + peerId(item) + '）'}
            checked={selectedKeys.has(conversationKey(item))}
            disabled={disabled}
            onChange={(event) => select([item], event.target.checked)}
          />
        </label>
      <div className={'wa-session-avatar ' + (peerType(item) === 'group' ? 'is-group' : '')}>
        {initials(peerName(item))}
      </div>
      <div className="wa-session-info">
        <div className="wa-session-title" title={peerName(item)}>
          {peerName(item)}
        </div>
        <div className="wa-session-meta">
          <span>{peerType(item) === 'group' ? '群聊' : '私聊'}</span>
          {secondaryName && <span>{secondaryName}</span>}
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
            <Button disabled={disabled} onClick={() => onDetail(item)}>
              设置
            </Button>
            <Button
              quiet
              className="wa-icon-button"
              icon="close"
              disabled={disabled}
              title={'撤销 ' + peerName(item) + ' 的授权'}
              aria-label={'撤销 ' + peerName(item) + ' 的授权'}
              onClick={() => applyOne(item, false)}
            />
          </>
        ) : (
          <Button icon="plus" disabled={disabled} onClick={() => applyOne(item, true)}>
            授权
          </Button>
        )}
      </div>
    </div>
    );
  };
  return (
    <>
      <PageHead icon="people" title="会话授权" description="授权限定回复、自动操作和资料整理的对象。群聊授权不会扩展为成员的私聊或朋友圈授权。">
        <Button icon="refresh" disabled={disabled || !status.online} onClick={() => onAction('contacts')}>
          {busy === 'contacts' ? '正在同步…' : '同步已发现会话'}
        </Button>
      </PageHead>
      <Notice notice={notice} area="authorization" />
      {status.authorization?.error && <p className="wa-alert is-error" role="alert">{status.authorization.error}，相关操作保持停止，后台会自动重试。</p>}
      {!status.authorization?.error && status.authorization?.pendingCount > 0 &&
        <p className="wa-help" role="status">正在清空 {status.authorization.pendingCount} 个撤销对象的数据，相关操作已停止。</p>}
      {!status.account ? (
        <section className="wa-card">
          <Empty icon="shield" title="先连接一个微信账号" description="连接后按名字搜索联系人和群聊。" />
        </section>
      ) : (
        <>
          <div className="wa-auth-toggle" data-enabled={status.settings.enabled}>
            <div className="wa-toggle-copy">
              <h3>自动回复</h3>
              <p>
                {status.settings.enabled
                  ? '按各个会话的模式处理新消息，并执行已保存的定时任务。'
                  : '授权、记忆与任务继续保留，当前暂停回复和定时发送。'}
              </p>
            </div>
            <div className="wa-row">
              <span className="wa-badge">{status.settings.enabled ? '已开启' : '已暂停'}</span>
              <Button quiet icon="settings" onClick={() => onNavigate('automation', 'authorization')}>自动功能设置</Button>
            </div>
          </div>
          <div className="wa-tabs" role="tablist" aria-label="会话来源" onKeyDown={changeTabWithKeyboard}>
            <button
              type="button"
              role="tab"
              className="wa-tab"
              id="wa-authorization-tab-authorized"
              aria-controls="wa-authorization-panel"
              tabIndex={tab === 'authorized' ? 0 : -1}
              aria-selected={tab === 'authorized'}
              onClick={() => setTab('authorized')}
            >
              已授权<span className="wa-tab-count">{authorized.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              className="wa-tab"
              id="wa-authorization-tab-discovered"
              aria-controls="wa-authorization-panel"
              tabIndex={tab === 'discovered' ? 0 : -1}
              aria-selected={tab === 'discovered'}
              onClick={() => setTab('discovered')}
            >
              发现会话<span className="wa-tab-count">{discoveredKeys.size}</span>
            </button>
          </div>
          <section className="wa-authorization-results" id="wa-authorization-panel" role="tabpanel" aria-labelledby={'wa-authorization-tab-' + tab}>
          <div className="wa-toolbar">
            <Search value={query} onChange={setQuery} />
            <TypeFilters value={type} onChange={setType} />
          </div>
          {selectionBar(filtered, 'main', '全选当前列表')}
          <p className="wa-help wa-authorization-scope" id="wa-authorization-selection-scope">
            取消授权会停止相关操作，并永久清空该对象的本机资料、记忆、任务与记录。重新授权后从新资料开始。
          </p>
          <div className="wa-session-list">
            {!!filtered.length && <div className="wa-session-columns" aria-hidden="true"><span>会话</span><span>回复方式与权限</span></div>}
            {filtered.length ? (
              filtered.map(row)
            ) : (
              <Empty icon="search" title="没有匹配的会话" description="调整筛选，或在下方按名字补充授权。" />
            )}
          </div>
          <p className="wa-help wa-section-space">
            显示 {filtered.length} / {source.length} 个会话
          </p>
          </section>
          <section className="wa-manual-box wa-name-add" data-testid="name-add">
            <div className="wa-name-add-heading"><h3>补充授权</h3>
            <p className="wa-help">
              按名字查找其他会话。同名结果需分别选择。
            </p></div>
            <div className="wa-name-add-controls">
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
                {selectionBar(suggestions, 'suggestions', '全选搜索结果')}
                <div className="wa-name-suggestions">{suggestions.map(row)}</div>
                {!suggestions.length && (
                  <p className="wa-help">暂未找到。可以换个字、试试备注或同步已发现会话；新会话需要先被微信同步到。</p>
                )}
              </>
            )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
