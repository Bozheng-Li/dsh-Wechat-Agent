import { useState } from 'react';
import { formatTime } from "../../shared/conversations.mjs";
import { names, Button, Tag, Heading, Empty, Feedback, Offline } from "../../components/workbench-ui.jsx";
import { useWorkbench } from "../../hooks/use-workbench.mjs";

export function RecoveryPage({ rpc, status }) {
  const state = useWorkbench(rpc, status.account?.id, 'recovery.list'),
    [selected, setSelected] = useState(null),
    [draft, setDraft] = useState(null),
    [verified, setVerified] = useState(false),
    [sendConfirmed, setSendConfirmed] = useState(false),
    [filter, setFilter] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const identity = (row) => [row.chatType, row.peerId, row.key].join(':'),
    filters = [
      ['all', '全部待处理'],
      ['failed', '处理失败'],
      ['unknown', '结果不明'],
      ['partial', '部分确认'],
      ['cancelled', '已取消'],
    ];
  const records = (state.data?.records || []).filter((record) => filter === 'all' || record.state === filter),
    record = records.find((row) => identity(row) === selected),
    count = state.data?.counts?.[filter] || 0;
  const locked = state.busy || !!deleteTarget;
  const select = (row) => {
    setSelected(identity(row));
    setDraft(null);
    setVerified(false);
    setSendConfirmed(false);
  };
  const prepare = async (mode) => {
    const value = await state.execute('recovery.prepare', {
      ...record,
      recordKey: record.key,
      mode,
      confirmUnreceived: verified,
    });
    if (value) {
      setDraft(value);
      setSendConfirmed(false);
    }
  };
  const send = async () => {
    const result = await state.execute('recovery.send', { draftId: draft.id, confirmSend: sendConfirmed });
    if (result) {
      setDraft(null);
      setSendConfirmed(false);
      state.setNotice(
        result.state === 'sent'
          ? '微信服务端已确认本次发送。原始记录和恢复记录分别保留。'
          : `本次恢复状态：${names[result.state] || result.state}。请核对记录后再操作。`
      );
    }
  };
  return (
    <section className="wa-wb-page wa-recovery-page" data-testid="recovery-page">
      <Heading icon="refresh" title="发送恢复" text="核对原回复与微信回执，预览后再恢复发送。">
        <Button quiet disabled={state.busy} onClick={state.refresh}>
          重新读取
        </Button>
      </Heading>
      <Feedback state={state} />
      <Offline status={status}>
        <div className="wa-wb-tabs" role="group" aria-label="筛选发送结果">
          {filters.map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setSelected(null);
                setDraft(null);
                setVerified(false);
                setSendConfirmed(false);
              }}
              disabled={locked}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="wa-wb-between wa-wb-list-toolbar">
          <p className="wa-wb-note">
            当前分类共 {count} 条{count > records.length ? '，展示最近 ' + records.length + ' 条' : ''}。
          </p>
          <Button
            quiet
            danger
            data-testid="recovery-clear-records"
            disabled={locked || !count}
            onClick={() =>
              setDeleteTarget({
                title: '清理「' + filters.find(([value]) => value === filter)[1] + '」的全部 ' + count + ' 条恢复记录',
                payload: {
                  recordFilter: filter,
                  revision: state.data.revision,
                  recordsRevision: state.data.recordsRevision,
                },
              })
            }
          >
            清理当前分类
          </Button>
        </div>
        <div className={'wa-wb-split wa-recovery-layout' + (!records.length ? ' is-empty' : '')}>
          <div className="wa-wb-list" aria-label="可恢复记录">
            {!records.length && !state.loading && (
              <Empty title="这里暂时没有待处理消息">之后失败或结果待核对的回复会出现在这里。</Empty>
            )}
            {records.map((row) => (
              <div
                key={identity(row)}
                className={'wa-wb-recovery-row' + (selected === identity(row) ? ' is-selected' : '')}
              >
                <button type="button" className="wa-wb-list-item" aria-current={selected === identity(row) ? 'true' : undefined} onClick={() => select(row)} disabled={locked}>
                  <div className="wa-wb-between">
                    <strong>{row.conversationName}</strong>
                    <Tag state={row.state} />
                  </div>
                  <p>{row.question || '回复记录'}</p>
                  <small>{formatTime(row.createdAt)}</small>
                </button>
                <div className="wa-wb-actions">
                  {row.busy && <small className="wa-wb-note">正在处理或等待回执</small>}
                  <Button
                    quiet
                    danger
                    data-testid="recovery-delete-record"
                    aria-label={'删除恢复记录：' + row.conversationName + '，' + (row.question || '回复记录')}
                    disabled={locked || row.busy}
                    onClick={() =>
                      setDeleteTarget({
                        title: '删除「' + row.conversationName + '」的这条恢复记录',
                        payload: {
                          revision: state.data.revision,
                          records: [
                            { recordKey: row.key, chatType: row.chatType, peerId: row.peerId, revision: row.revision },
                          ],
                        },
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="wa-recovery-detail" hidden={!records.length}>
            {record ? (
              <article className="wa-recovery-sheet">
                <div className="wa-wb-between"><h2>{record.conversationName}</h2><Tag state={record.state} /></div>
                <p className="wa-wb-note">{record.reason}</p>
                <div className="wa-wb-paper">
                  <small>保留的原回复</small>
                  <p>{record.reply || record.replyDraft || '尚未生成可用文字'}</p>
                  {record.replyMedia && <div className="wa-wb-asset">▧ {record.replyMedia.name}</div>}
                </div>
                {record.deliveryParts?.length > 0 && (
                  <div className="wa-wb-parts">
                    {record.deliveryParts.map((part) => (
                      <span key={part.index}>
                        {part.type === 'text' ? '文字' : '图片'} {part.index + 1} ·{' '}
                        {part.state === 'acknowledged'
                          ? '已有回执'
                          : part.state === 'not-sent'
                            ? '尚未发送'
                            : '结果待核对'}
                      </span>
                    ))}
                  </div>
                )}
                {['unknown', 'partial'].includes(record.state) && (
                  <label className="wa-wb-check">
                    <input
                      type="checkbox"
                      checked={verified}
                      onChange={(event) => setVerified(event.target.checked)}
                      disabled={locked}
                    />
                    我已在微信核对，准备恢复的内容尚未收到
                  </label>
                )}
                {!record.authorized && <p className="wa-wb-note">当前会话已撤销授权，请到会话页核对授权后操作。</p>}
                <div className="wa-wb-actions wa-recovery-prepare">
                  <Button disabled={locked || record.busy || !record.authorized} onClick={() => prepare('retry')}>
                    准备原回复
                  </Button>
                  <details className="wa-recovery-options">
                  <summary>其他恢复方式</summary>
                  <div className="wa-wb-actions">
                  {[
                    ['text', '仅恢复文字'],
                    ['image', '仅恢复图片'],
                    ['regenerate', '重新生成文字'],
                  ].map(([mode, label]) => (
                    <Button
                      key={mode}
                      quiet
                      disabled={locked || record.busy || !record.authorized || (mode === 'image' && !record.replyMedia)}
                      onClick={() => prepare(mode)}
                    >
                      {label}
                    </Button>
                  ))}
                  </div>
                  </details>
                </div>
                {draft && (
                  <div className="wa-wb-review" role="region" aria-label="发送前预览">
                    <div className="wa-wb-between">
                      <h3>发送前预览</h3>
                      <Tag state="draft" />
                    </div>
                    <p>
                      接收会话：<strong>{record.conversationName}</strong>
                    </p>
                    <div className="wa-wb-paper">
                      {draft.text || '仅发送图片'}
                      {draft.asset && <p>▧ {draft.asset.name}</p>}
                    </div>
                    <label className="wa-wb-check">
                      <input
                        type="checkbox"
                        checked={sendConfirmed}
                        disabled={locked}
                        onChange={(event) => setSendConfirmed(event.target.checked)}
                      />
                      确认以上内容和接收会话，立即发送
                    </label>
                    <div className="wa-wb-actions">
                      <Button disabled={locked || !sendConfirmed} onClick={send}>
                        发送并核对回执
                      </Button>
                      <Button
                        quiet
                        disabled={locked}
                        onClick={async () => {
                          if (await state.execute('recovery.discard', { draftId: draft.id })) setDraft(null);
                        }}
                      >
                        丢弃草稿
                      </Button>
                    </div>
                  </div>
                )}
              </article>
            ) : (
              <Empty title="选择一条消息">恢复操作先生成草稿；不会在点击记录时自动发送。</Empty>
            )}
          </div>
        </div>
        <details className="wa-settings-block wa-wb-history wa-recovery-history">
          <summary>最近的恢复操作 · {state.data?.draftCount || 0} 条</summary>
          <div className="wa-wb-between wa-wb-list-toolbar">
            <p className="wa-wb-note">
              {state.data?.draftCount > 50
                ? '展示最近 50 条；清空会整理全部恢复历史。'
                : '草稿和恢复历史可在这里整理。'}
              正在处理或等待回执的操作结束后才能删除。
            </p>
            <Button
              quiet
              danger
              data-testid="recovery-clear-history"
              disabled={locked || !state.data?.draftCount}
              onClick={() =>
                setDeleteTarget({
                  title: '清空全部 ' + state.data.draftCount + ' 条恢复历史',
                  history: true,
                  payload: {
                    revision: state.data.revision,
                    clearDrafts: true,
                    draftsRevision: state.data.draftsRevision,
                  },
                })
              }
            >
              清空恢复历史
            </Button>
          </div>
          {(state.data?.drafts || []).map((item) => (
            <div className="wa-wb-history-row" key={item.id}>
              <span>{formatTime(item.createdAt)}</span>
              <span>{item.text?.slice(0, 70) || item.asset?.name || '恢复草稿'}</span>
              <Tag state={item.state} />
              <Button
                quiet
                danger
                data-testid="recovery-delete-history"
                aria-label={'删除恢复历史：' + (item.text?.slice(0, 40) || item.asset?.name || '恢复草稿')}
                disabled={locked || item.busy}
                onClick={() =>
                  setDeleteTarget({
                    title: '删除这条恢复历史',
                    history: true,
                    payload: {
                      revision: state.data.revision,
                      draftIds: [item.id],
                      draftRevisions: { [item.id]: item.revision },
                    },
                  })
                }
              >
                删除
              </Button>
            </div>
          ))}
        </details>
        {deleteTarget && (
          <div className="wa-wb-review wa-recovery-confirm" role="region" aria-label="确认删除恢复记录">
            <h3>{deleteTarget.title}？</h3>
            <p>
              {deleteTarget.history ? '这些草稿或历史将从恢复列表移除。' : '这些恢复项及关联草稿将从恢复列表移除。'}
              聊天记录、微信回执和已发送状态保留，已确认内容仍不能重复发送。
            </p>
            <div className="wa-wb-actions">
              <Button
                danger
                disabled={state.busy}
                onClick={async () => {
                  const result = await state.execute(
                    'recovery.delete',
                    { ...deleteTarget.payload, confirmDelete: true },
                    false
                  );
                  if (result) {
                    state.setData(result);
                    if (!result.records.some((row) => identity(row) === selected)) {
                      setSelected(null);
                      setVerified(false);
                    }
                    if (draft && !result.drafts.some((item) => item.id === draft.id)) {
                      setDraft(null);
                      setSendConfirmed(false);
                    }
                    setDeleteTarget(null);
                    state.setNotice(
                      '已整理 ' +
                        result.deletedRecords +
                        ' 条恢复记录、' +
                        result.deletedDrafts +
                        ' 条草稿或历史；聊天记录与微信回执保留。'
                    );
                  }
                }}
              >
                确认删除
              </Button>
              <Button quiet disabled={state.busy} onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
            </div>
          </div>
        )}
      </Offline>
    </section>
  );
}
