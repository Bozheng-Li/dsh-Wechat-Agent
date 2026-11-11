import { useEffect, useRef, useState } from 'react';
import { formatTime } from "../../shared/conversations.mjs";
import { localDate } from "../../shared/local-date.mjs";
import { Button, Tag, Heading, Empty, Feedback, Offline } from "../../components/workbench-ui.jsx";
import { useWorkbench } from "../../hooks/use-workbench.mjs";

export function MemoryReviewPage({ rpc, status }) {
  const state = useWorkbench(rpc, status.account?.id, 'memory.global.get'),
    [filter, setFilter] = useState('pending'),
    [editing, setEditing] = useState(null),
    [expiry, setExpiry] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null),
    [deleteAttempted, setDeleteAttempted] = useState(false),
    locked = state.busy || !!deleteTarget;
  const confirmation = useRef(null), confirmationTrigger = useRef(null);
  const requestDelete = (target) => {
    confirmationTrigger.current = document.activeElement;
    setDeleteAttempted(false);
    setDeleteTarget(target);
  };
  const [, tick] = useState(0),
    now = Date.now();
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!deleteTarget) return;
    const previous = confirmationTrigger.current;
    confirmation.current?.querySelector('.is-quiet')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      else document.querySelector('#wa-memory-tab-review')?.focus();
    };
  }, [deleteTarget]);
  useEffect(() => {
    const dialog = confirmation.current;
    if (!deleteTarget || !dialog) return;
    if (state.busy) dialog.focus();
    else if (!dialog.contains(document.activeElement) || document.activeElement === dialog)
      dialog.querySelector('.is-quiet')?.focus();
  }, [deleteTarget, state.busy]);
  const all = (state.data?.sections || []).flatMap((section) => {
    const disputed = new Set(
      section.facts.filter((fact) => fact.state === 'pending').flatMap((fact) => fact.replaces || [])
    );
    return section.facts.map((fact) => ({
      ...fact,
      conversationName: section.name,
      peers: section.facts,
      disputed: disputed.has(fact.id),
      expired: fact.expiresAt != null && fact.expiresAt <= now,
    }));
  });
  const usable = (fact) => fact.state === 'active' && !fact.disputed && !fact.expired;
  const facts = all.filter(
    (fact) =>
      filter === 'all' ||
      (filter === 'expired'
        ? fact.state === 'active' && fact.expired
        : filter === 'active'
          ? usable(fact)
          : fact.state === filter)
  );
  const filters = [
    ['pending', '冲突待确认'],
    ['active', '有效记忆'],
    ['expired', '已到期'],
    ['all', '全部与历史'],
  ];
  return (
    <section className="wa-wb-page" data-testid="memory-review-page">
      <Heading icon="memory" title="记忆维护" text="确认冲突、调整有效期，整理过时事实。">
        <Button quiet disabled={state.busy} onClick={state.refresh}>
          重新读取
        </Button>
      </Heading>
      {!deleteTarget && <Feedback state={state} />}
      <Offline status={status}>
        <div className="wa-memory-review-metrics">
          <div>
            <span>有效事实</span>
            <strong>{all.filter(usable).length}</strong>
          </div>
          <div>
            <span>待确认冲突</span>
            <strong>{all.filter((fact) => fact.state === 'pending').length}</strong>
          </div>
          <div>
            <span>已到期</span>
            <strong>{all.filter((fact) => fact.state === 'active' && fact.expired).length}</strong>
          </div>
        </div>
        <div className="wa-wb-tabs" role="group" aria-label="记忆状态">
          {filters.map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-pressed={filter === id}
              disabled={locked}
              onClick={() => {
                setFilter(id);
                setEditing(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="wa-wb-between wa-wb-list-toolbar">
          <p className="wa-wb-note">当前分类共 {facts.length} 条事实。</p>
          <Button
            quiet
            danger
            data-testid="memory-clear-facts"
            disabled={locked || state.data?.invalid || !facts.length}
            onClick={() =>
              requestDelete({
                title:
                  '删除「' + filters.find(([value]) => value === filter)[1] + '」的全部 ' + facts.length + ' 条事实',
                factIds: facts.map((fact) => fact.id),
                revision: state.data.revision,
              })
            }
          >
            删除当前分类
          </Button>
        </div>
        {!facts.length && !state.loading && (
          <Empty title="当前分类没有记忆">
            新事实从会话中提取。临时安排可设置有效期，冲突事实确认后才重新进入对话。
          </Empty>
        )}
        <div className="wa-memory-fact-list">
          {facts.map((fact) => (
            <article className="wa-memory-review-fact" key={fact.id} data-fact-state={fact.state}>
              <header className="wa-memory-review-meta">
                <span className="wa-wb-eyebrow">{fact.conversationName}</span>
                <Tag state={fact.state === 'pending' || fact.disputed ? 'draft' : usable(fact) ? 'passed' : 'disabled'}>
                  {fact.state === 'pending'
                    ? '待确认'
                    : fact.state === 'superseded'
                      ? '历史事实'
                      : fact.expired
                        ? '已到期'
                        : fact.disputed
                          ? '冲突待定 · 暂停使用'
                          : '有效'}
                </Tag>
              </header>
              <p className="wa-wb-fact-text">{fact.text}</p>
              {fact.state === 'pending' && (
                <>
                  <div className="wa-memory-conflict">
                    {fact.replaces?.length ? (
                      <>
                        <small>与以下旧事实冲突</small>
                        {fact.peers
                          .filter((value) => fact.replaces.includes(value.id))
                          .map((value) => (
                            <p key={value.id}>{value.text}</p>
                          ))}
                      </>
                    ) : (
                      <p>{fact.reviewReason === 'reported' ? '这条内容来自他人转述，需要确认适用后才会使用。' :
                        fact.reviewReason === 'image' ? '这条内容来自图片识别，需要确认后才会使用。' : '关联的旧事实已移除；这条候选仍需确认后才会使用。'}</p>
                    )}
                  </div>
                  <div className="wa-wb-actions">
                    <Button
                      disabled={locked || state.data?.invalid}
                      onClick={() =>
                        state.execute('memory.fact.resolve', {
                          factId: fact.id,
                          revision: state.data.revision,
                          decision: 'accept',
                        })
                      }
                    >
                      采用新事实
                    </Button>
                    <Button
                      quiet
                      disabled={locked || state.data?.invalid}
                      onClick={() =>
                        state.execute('memory.fact.resolve', {
                          factId: fact.id,
                          revision: state.data.revision,
                          decision: 'keep',
                        })
                      }
                    >
                      {fact.replaces?.length ? '保留旧事实' : '忽略这条候选'}
                    </Button>
                  </div>
                </>
              )}
              <footer className="wa-memory-expiry">
                <small>{fact.expiresAt ? '有效至 ' + formatTime(fact.expiresAt) : '长期有效'}</small>
                <div className="wa-wb-actions">
                  <Button
                    quiet
                    disabled={locked || state.data?.invalid}
                    onClick={() => {
                      setEditing(fact.id);
                      setExpiry(fact.expiresAt ? localDate(fact.expiresAt) : '');
                    }}
                  >
                    调整有效期
                  </Button>
                  <Button
                    quiet
                    danger
                    data-testid="memory-delete-fact"
                    aria-label={'删除记忆：' + fact.text}
                    disabled={locked || state.data?.invalid}
                    onClick={() =>
                      requestDelete({
                        title: '删除「' + fact.text.slice(0, 60) + (fact.text.length > 60 ? '…' : '') + '」',
                        factIds: [fact.id],
                        revision: state.data.revision,
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              </footer>
              {editing === fact.id && (
                <div className="wa-wb-inline-form">
                  <label>
                    到期时间
                    <input
                      aria-label="记忆到期时间"
                      type="datetime-local"
                      value={expiry}
                      disabled={locked}
                      onChange={(event) => setExpiry(event.target.value)}
                    />
                  </label>
                  <small>留空表示长期有效；到期后保留历史，停止作为当前事实使用。</small>
                  <div className="wa-wb-actions">
                    <Button
                      disabled={locked}
                      onClick={async () => {
                        if (
                          await state.execute('memory.fact.update', {
                            factId: fact.id,
                            revision: state.data.revision,
                            expiresAt: expiry ? new Date(expiry).getTime() : null,
                          })
                        )
                          setEditing(null);
                      }}
                    >
                      保存有效期
                    </Button>
                    <Button quiet disabled={locked} onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              )}
              <details className="wa-memory-sources">
                <summary>查看原始依据 · {fact.sources.length} 条</summary>
                {fact.sources.map((source, index) => (
                  <blockquote key={source.key + ':' + index}>
                    <small>
                      {source.sender} ·{' '}
                      {source.time ? formatTime(source.time < 1e12 ? source.time * 1000 : source.time) : '时间未记录'}
                    </small>
                    <p>{source.quote || '旧版事实仅保存来源标识，可到会话记录核对原文。'}</p>
                  </blockquote>
                ))}
              </details>
            </article>
          ))}
        </div>
        {deleteTarget && (
          <div className="wa-memory-confirmation-backdrop" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !state.busy) setDeleteTarget(null);
          }}>
          <div className="wa-memory-delete-dialog" ref={confirmation} tabIndex={-1} role="dialog" aria-modal="true" aria-label="确认删除记忆"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !state.busy) { event.preventDefault(); setDeleteTarget(null); }
              if (event.key !== 'Tab') return;
              const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
              if (!controls.length) { event.preventDefault(); event.currentTarget.focus(); }
              else if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
              else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
            }}>
            <h3>{deleteTarget.title}？</h3>
            <p>
              选中的事实将从长期记忆移除并停止用于回复，旧来源不会自动补回。聊天记录、全局备注与修改前备份保留；其他事实继续使用。
            </p>
            {deleteAttempted && state.error && !state.busy && (
              <div className="wa-alert is-error" role="alert">{state.error}</div>
            )}
            <div className="wa-wb-actions">
              <Button
                danger
                disabled={state.busy}
                onClick={async () => {
                  setDeleteAttempted(true);
                  const value = await state.execute(
                    'memory.fact.delete',
                    { factIds: deleteTarget.factIds, revision: deleteTarget.revision, confirmDelete: true },
                    false
                  );
                  if (value) {
                    state.setData(value);
                    if (deleteTarget.factIds.includes(editing)) setEditing(null);
                    setDeleteTarget(null);
                    state.setNotice('已删除 ' + value.deletedFacts + ' 条事实，全局长期记忆已同步。');
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
          </div>
        )}
      </Offline>
    </section>
  );
}
