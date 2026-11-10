import {
  conversationKey,
  formatTime,
  initials,
  matchesSearch,
  peerId,
  peerName,
  peerType,
} from "../../shared/conversations.mjs";
import { Glyph } from "../../components/glyph.jsx";
import { Button } from "../../components/button.jsx";
import { PageHead, Empty, Notice, Search, TypeFilters, StateBadge } from "../../components/page-ui.jsx";

export function Records({
  rows,
  selected,
  onSelect,
  query,
  setQuery,
  type,
  setType,
  data,
  loading,
  error,
  offset,
  onOffset,
  onRefresh,
  onInspect,
  blocked,
  processing,
  onCancel,
  onCancelAll,
  notice,
}) {
  const filtered = rows.filter((item) => (type === 'all' || peerType(item) === type) && matchesSearch(item, query));
  const records = data?.records || [],
    current = selected?.processing;
  const pending = (current?.active ? 1 : 0) + (current?.queued || 0);
  return (
    <>
      <PageHead title="处理记录" description="按会话查看问题、回复与微信回执，分别保留上下文。">
        <Button quiet icon="pause" disabled={blocked || (!processing?.active && !processing?.queued)} onClick={onCancelAll}>
          取消全部回复任务
        </Button>
      </PageHead>
      <Notice notice={notice} area="records" />
      <div className="wa-records-layout">
        <aside className="wa-records-sidebar" aria-label="记录会话列表">
          <Search value={query} onChange={setQuery} label="搜索记录会话" placeholder="搜索名称或会话 ID" />
          <div style={{ margin: '0 4px 16px' }}>
            <TypeFilters value={type} onChange={setType} />
          </div>
          <p className="wa-records-sidebar-label">{filtered.length} 个会话</p>
          <div className="wa-records-peers">
            {filtered.map((item) => (
              <button
                type="button"
                key={conversationKey(item)}
                className="wa-records-peer"
                data-peer-id={peerId(item)}
                data-chat-type={peerType(item)}
                aria-current={selected && conversationKey(selected) === conversationKey(item) ? 'true' : undefined}
                onClick={() => onSelect(item)}
              >
                <span className={'wa-session-avatar ' + (peerType(item) === 'group' ? 'is-group' : '')}>
                  {initials(peerName(item))}
                </span>
                <span className="wa-session-info">
                  <span className="wa-session-title" style={{ display: 'block' }}>
                    {peerName(item)}
                  </span>
                  <span className="wa-session-meta">
                    {peerType(item) === 'group' ? '群聊' : '私聊'}
                    {!item.authorized ? ' · 已撤销授权' : ''}
                  </span>
                </span>
                <span className="wa-record-count">{item.recordCount || 0}</span>
              </button>
            ))}
          </div>
          {!filtered.length && (
            <Empty
              icon="search"
              title="没有匹配的会话"
              description={query ? '尝试其他名称或 ID。' : '授权后，每个会话将在这里独立显示。'}
            />
          )}
        </aside>
        <section className="wa-records-main" aria-label="当前会话处理记录">
          {!selected ? (
            <Empty icon="history" title="选择一个会话" description="每个群聊与私聊的处理记录独立展示，不会混在一起。" />
          ) : (
            <>
              <header className="wa-records-head">
                <div>
                  <h2>{peerName(selected)}</h2>
                  <p className="wa-muted wa-mono">{peerId(selected)}</p>
                  <details className="wa-records-location" key={conversationKey(selected)}>
                    <summary>
                      <Glyph name="folder" className="wa-icon-small" />
                      记录保存位置
                    </summary>
                    <div className="wa-path-value">
                      {data?.recordsPath || selected.recordsPath || '此会话使用独立记录目录'}
                    </div>
                  </details>
                  <p className="wa-help" data-testid="conversation-processing" aria-live="polite">
                    {current?.active ? '正在回复' : '当前没有运行中的回复'}
                    {current?.queued ? ' · ' + current.queued + ' 条等待处理' : ''}
                  </p>
                </div>
                <div className="wa-row wa-records-actions">
                  <Button
                    icon="pause"
                    data-testid="cancel-conversation"
                    disabled={blocked || !pending}
                    onClick={onCancel}
                  >
                    取消此会话任务
                  </Button>
                  <Button
                    quiet
                    icon="refresh"
                    className="wa-icon-button"
                    disabled={loading}
                    onClick={onRefresh}
                    aria-label="刷新此会话记录"
                    title="刷新此会话记录"
                  />
                </div>
              </header>
              <div className="wa-records-body">
                {data?.newerCount > 0 && (
                  <div className="wa-alert wa-between" data-testid="new-records-notice" role="status">
                    <span>有 {data.newerCount} 条新记录，当前浏览位置保持不变。</span>
                    <Button quiet disabled={loading} onClick={onRefresh}>
                      查看最新记录
                    </Button>
                  </div>
                )}
                {error && (
                  <div className="wa-alert is-error wa-section-space" role="alert">
                    {error}
                  </div>
                )}
                {loading && !data ? (
                  <div className="wa-loading-block" aria-label="正在读取此会话记录">
                    <div className="wa-skeleton" style={{ width: '60%' }} />
                    <div className="wa-skeleton" />
                    <div className="wa-skeleton" style={{ width: '80%' }} />
                  </div>
                ) : records.length ? (
                  records.map((record) => (
                    <details
                      className="wa-record"
                      key={record.key}
                      data-record-key={record.key}
                      onToggle={(event) => {
                        if (event.currentTarget.open) onInspect();
                      }}
                    >
                      <summary>
                        <div className="wa-record-meta">
                          <span>
                            {record.sender || (peerType(selected) === 'group' ? '群成员' : peerName(selected))}
                          </span>
                          <time>{formatTime(record.createdAt)}</time>
                        </div>
                        <div className="wa-record-headline">
                          <span className="wa-record-question">
                            {record.question || record.reason || '这条消息没有可显示的正文'}
                          </span>
                          <StateBadge
                            state={record.state}
                            label={record.mode === 'natural' && record.state === 'skipped' ? '本轮保持安静' : undefined}
                          />
                        </div>
                      </summary>
                      <div className="wa-record-content">
                        {record.replyMedia && (
                          <p className="wa-help">
                            已选择{record.replyMedia.kind === 'sticker' ? '表情包' : '图片'}：{record.replyMedia.name} ·
                            发送结果以本条回执状态为准
                          </p>
                        )}
                        {record.reply && <p className="wa-record-reply">{record.reply}</p>}
                        {record.memoryContext && (
                          <details className="wa-record-memory" data-testid="record-memory-context">
                            <summary className="wa-record-memory-label">本轮记忆准备</summary>
                            <div className="wa-row">
                              <span>{record.memoryContext.mode === 'on-demand' ? '按需查阅' : '自动筛选'}</span>
                              <span>近期对话 {record.memoryContext.recentMessages || 0} 条</span>
                              <span>预载旧记忆 {record.memoryContext.referenceChars || 0} 字</span>
                            </div>
                            <p>{record.memoryContext.mode === 'on-demand'
                              ? '旧记忆由模型需要时查阅；此处显示回复开始前提供的内容，不代表已经调用查询。'
                              : record.memoryContext.referenceChars > 0
                                ? '只提供与本轮相关的历史，作为回答参考。'
                                : '未预载相关旧记忆，先依据本轮消息与近期对话回答。'}</p>
                            {!!record.memoryContext.matchedTerms?.length && <p>关联线索：{record.memoryContext.matchedTerms.join('、')}</p>}
                          </details>
                        )}
                        {record.reason && <p className="wa-alert">{record.reason}</p>}
                        {record.replyStyleWarning && (
                          <p className="wa-note-box" data-testid="reply-style-review">
                            {record.replyStyleWarning}
                          </p>
                        )}
                        {record.acknowledgedMessageIds?.length > 0 && (
                          <p className="wa-muted">
                            微信服务端已确认 {record.acknowledgedMessageIds.length} 条消息；回执不代表对方已读。
                          </p>
                        )}
                        <p className="wa-muted">
                          {formatTime(record.createdAt, true)}
                          {record.updatedAt ? ' · 更新于 ' + formatTime(record.updatedAt, true) : ''}
                        </p>
                      </div>
                    </details>
                  ))
                ) : (
                  !error && (
                    <Empty
                      icon="history"
                      title="此会话还没有处理记录"
                      description="授权后收到的新消息与回复结果会保存在这个会话中。"
                    />
                  )
                )}
              </div>
              <footer className="wa-pagination">
                <span>
                  {data
                    ? '共 ' + data.total + ' 条 · 第 ' + (Math.floor(offset / (data.limit || 50)) + 1) + ' 页'
                    : '正在读取记录'}
                </span>
                <div className="wa-row">
                  <Button
                    disabled={loading || offset <= 0}
                    onClick={() => onOffset(Math.max(0, offset - (data?.limit || 50)))}
                  >
                    上一页
                  </Button>
                  <Button disabled={loading || !data?.hasMore} onClick={() => onOffset(offset + (data?.limit || 50))}>
                    下一页
                  </Button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
      <p className="wa-help wa-section-space">
        这里显示插件观察和处理的消息，微信客户端中的完整历史不会自动导入。展开或翻页时保留浏览位置，可刷新查看最新记录。
      </p>
    </>
  );
}
