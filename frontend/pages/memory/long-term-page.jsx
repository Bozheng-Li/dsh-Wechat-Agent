import { useEffect, useRef, useState } from 'react';
import { conversationKey, peerId, peerName, peerType } from "../../shared/conversations.mjs";
import { MemoryOverview } from "./visuals.jsx";
import { Button } from '../../components/button.jsx';
import { PageHead } from '../../components/page-ui.jsx';

const stamp = (value) =>
  value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
const replace = (document, range, value) =>
  document.markdown.slice(0, range.start) + value + document.markdown.slice(range.end);

/** Owner-facing editor; hidden Markdown markers are preserved by scoped edits. */
export function LongTermMemoryPage({ rpc, status, rows = [] }) {
  const accountId = status.account?.id;
  const [doc, setDoc] = useState(null),
    [base, setBase] = useState(null),
    [notes, setNotes] = useState('');
  const [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null),
    [rawDraft, setRawDraft] = useState(null),
    [confirmClear, setConfirmClear] = useState(false),
    [remove, setRemove] = useState(null);
  const [notesEditing, setNotesEditing] = useState(false);
  const account = useRef(accountId);
  account.current = accountId;
  const draft = useRef();
  draft.current = { notes, base };
  const dirty = !!base && notes !== base.globalNotes;
  const reload = async (force = false, signal) => {
    if (!accountId) return;
    const next = await rpc('memory.global.get', { accountId }, signal);
    if (signal?.aborted || account.current !== accountId) return;
    setDoc(next);
    if (force || !draft.current.base || draft.current.notes === draft.current.base.globalNotes) {
      setNotes(next.globalNotes);
      setBase(next);
    }
  };
  useEffect(() => {
    setDoc(null);
    setBase(null);
    setNotes('');
    setNotesEditing(false);
    setSelected('');
    setEditing(null);
    setRawDraft(null);
    setRemove(null);
    setConfirmClear(false);
    setError('');
    setNotice('');
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        await reload(false, controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [accountId]);
  const act = async (endpoint, payload, success) => {
    if (busy || doc?.readOnly) return false;
    setBusy(endpoint);
    setError('');
    setNotice('');
    try {
      await rpc(endpoint, payload);
      if (account.current !== accountId) return false;
      await reload(true);
      setNotice(success);
      setConfirmClear(false);
      return true;
    } catch (failure) {
      if (account.current === accountId) setError(failure.message);
      return false;
    } finally {
      if (account.current === accountId) setBusy('');
    }
  };
  const save = (document, markdown, success) =>
    act('memory.global.edit', { accountId, markdown, revision: document.revision }, success);
  const target = rows.find((peer) => conversationKey(peer) === selected);
  const sections = (doc?.sections || []).filter((section) => !selected || conversationKey(section) === selected);
  const fact = (entry, section) => (
    <article
      key={entry.id}
      className={'wa-long-fact' + (entry.state === 'superseded' ? ' is-old' : '')}
      data-long-fact-id={entry.id}
    >
      <header className="wa-long-fact-meta">
        <span>{entry.state === 'superseded' ? '已被后续更正' : '长期事实'}</span>
        <time>{stamp(entry.createdAt)}</time>
      </header>
      {editing?.id === entry.id ? (
        <div className="wa-section-space">
          <textarea
            className="wa-textarea"
            aria-label="编辑长期事实"
            rows={4}
            maxLength={4000}
            value={editing.value}
            disabled={!!busy}
            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
          />
          <div className="wa-long-tools">
            <Button
              primary
              disabled={!!busy || !editing.value.trim()}
              onClick={async () => {
                if (
                  await save(
                    editing.base,
                    replace(editing.base, editing.range, '\n- ' + editing.value.trim() + '\n'),
                    '长期事实已修改。'
                  )
                )
                  setEditing(null);
              }}
            >
              保存这条事实
            </Button>
            <Button disabled={!!busy} onClick={() => setEditing(null)}>
              取消编辑
            </Button>
          </div>
        </div>
      ) : (
        <p className="wa-long-note">{entry.text}</p>
      )}
      <p className="wa-help">
        对象：{entry.subjectId === 'group' ? '本群共同事项' : entry.subjectName || '原会话资料 · 人物未确认'}；
        来源：{section.name} ·{' '}
        {[...new Set((entry.sources || []).map((source) => source.sender).filter(Boolean))].join('、') || '会话成员'}
        ；仅用于这个会话。
      </p>
      {!editing && (
        <div className="wa-long-fact-actions">
          <Button
            disabled={!!busy || dirty || !!rawDraft}
            onClick={() => setEditing({ id: entry.id, base: doc, range: entry.bodyRange, value: entry.text })}
          >
            编辑
          </Button>
          <Button
            danger
            disabled={!!busy || dirty || !!rawDraft}
            onClick={() =>
              setRemove({ id: entry.id, base: doc, range: { start: entry.start, end: entry.end }, text: entry.text })
            }
          >
            删除这条
          </Button>
        </div>
      )}
      {remove?.id === entry.id && (
        <div className="wa-note-box wa-section-space">
          <p>删除后，不会从这条事实原有的消息来源自动补回。</p>
          <div className="wa-long-tools">
            <Button
              danger
              disabled={!!busy}
              onClick={async () => {
                if (await save(remove.base, replace(remove.base, remove.range, ''), '这条长期事实已删除。'))
                  setRemove(null);
              }}
            >
              确认删除这条事实
            </Button>
            <Button disabled={!!busy} onClick={() => setRemove(null)}>
              返回
            </Button>
          </div>
        </div>
      )}
    </article>
  );
  return (
    <>
      <PageHead icon="memory" title="长期记忆" description="稳定偏好与重要约定，按来源会话分别保留。">
        {accountId && <Button icon="refresh" disabled={!doc || !!busy || dirty || !!editing || !!rawDraft}
          onClick={() => { void reload(true).catch((failure) => setError(failure.message)); }}>重新读取</Button>}
      </PageHead>
      {(error || doc?.error) && (
        <div className="wa-alert is-error" role="alert">
          {error || doc.error}
        </div>
      )}
      {notice && (
        <p className="wa-alert is-success" role="status">
          {notice}
        </p>
      )}
      {!accountId ? (
        <div className="wa-empty">
          <h3>先连接微信账号</h3>
          <p>每个微信账号都有自己独立的长期记忆。</p>
        </div>
      ) : !doc ? (
        <p className="wa-help">正在读取长期记忆…</p>
      ) : (
        <div className="wa-long-workspace" data-testid="global-memory-document">
          <MemoryOverview document={doc} longTerm />
          {doc.readOnly && (
            <p className="wa-note-box" data-testid="memory-read-only">
              请修复记忆文件的位置或体积后重新读取。当前无法编辑、清空或整理这份文件。
            </p>
          )}
          <section className="wa-document-section wa-long-shared">
            <header className="wa-document-heading">
              <div>
                <h2>所有会话通用的内容</h2>
                <p className="wa-help">
                  由你手动填写，当前账号的授权会话都会参考。自动提取的私人信息保留在下方的来源会话内。
                </p>
              </div>
            </header>
            {notesEditing || !doc.globalNotes ? (
              <>
                <label className="wa-field wa-automation-field">
                  <span className="wa-label">全局通用备注</span>
                  <textarea
                    className="wa-textarea wa-long-editor"
                    aria-label="全局通用备注"
                    rows={5}
                    maxLength={100000}
                    disabled={!!busy || doc.invalid || !!editing || !!rawDraft}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="例如：所有会话共享的背景、角色关系或回答约定。"
                  />
                </label>
                <div className="wa-long-tools">
                  <Button
                    primary
                    disabled={!!busy || !dirty || doc.invalid || !!editing || !!rawDraft}
                    onClick={async () => {
                      if (
                        await save(
                          base,
                          replace(base, base.globalRange, '\n' + notes.trim() + '\n'),
                          '全局通用备注已保存，将用于下一轮回复。'
                        )
                      )
                        setNotesEditing(false);
                    }}
                  >
                    保存全局备注
                  </Button>
                  <Button
                    disabled={!!busy || (!dirty && !notesEditing)}
                    onClick={() => {
                      setBase(doc);
                      setNotes(doc.globalNotes);
                      setNotesEditing(false);
                    }}
                  >
                    {doc.globalNotes ? '取消编辑备注' : '撤销修改'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="wa-long-saved-document" data-testid="saved-global-notes">
                <span className="wa-long-document-status">{doc.globalNotesExpired ? '已到期' : '已保存'}</span>
                <p className="wa-long-note wa-section-space">{doc.globalNotes}</p>
                <div className="wa-long-tools">
                  <Button
                    disabled={!!busy || doc.invalid || !!editing || !!rawDraft}
                    onClick={() => {
                      setBase(doc);
                      setNotes(doc.globalNotes);
                      setNotesEditing(true);
                    }}
                  >
                    编辑全局备注
                  </Button>
                </div>
              </div>
            )}
            <p className="wa-help wa-section-space">
              默认有效期 30 天。全局备注补充共同背景，默认助手设置表达偏好；自动事实仅在来源会话使用。
              {doc.globalNotesExpiresAt
                ? '全局备注' + (doc.globalNotesExpired ? '已于 ' : '有效至 ') + stamp(doc.globalNotesExpiresAt) + '。'
                : ''}
            </p>
          </section>
          <section className="wa-document-section wa-long-collected">
            <header className="wa-document-heading">
              <div><h2>来自各会话的重要事实</h2>
              <p className="wa-help">更正会保留旧事实，不再作为当前结论使用。</p></div>
            </header>
            <div className="wa-long-source">
              <select
                className="wa-select"
                aria-label="长期记忆来源会话"
                value={selected}
                disabled={!!busy || !!editing || !!rawDraft}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setRemove(null);
                }}
              >
                <option value="">查看当前账号全部来源</option>
                {rows.map((peer) => (
                  <option key={conversationKey(peer)} value={conversationKey(peer)}>
                    {peerType(peer) === 'group' ? '群聊' : '私聊'} · {peerName(peer)}
                  </option>
                ))}
              </select>
            </div>
            {target && (
              <div className="wa-long-tools">
                <Button
                  disabled={!!busy || doc.invalid || doc.readOnly || doc.extracting || !target.authorized}
                  onClick={() =>
                    act(
                      'memory.global.extract',
                      { accountId, chatType: peerType(target), peerId: peerId(target) },
                      '已整理这批长期信息；剩余来源会继续在后台处理。'
                    )
                  }
                >
                  {busy === 'memory.global.extract' || doc.extracting ? '正在整理…' : '整理这个会话的重要信息'}
                </Button>
              </div>
            )}
            {sections.map((section) => (
              <div key={section.key} className="wa-long-source-head">
                <div className="wa-long-source-title"><h3>{section.name}</h3><span>{section.facts.filter((entry) => entry.state === 'active').length} 条当前事实</span></div>
                <div className="wa-long-facts">
                  {section.facts.filter((entry) => entry.state === 'active').map((entry) => fact(entry, section))}
                </div>
                {section.facts.some((entry) => entry.state === 'superseded') && (
                  <details className="wa-subsection">
                    <summary>查看已被更正的旧事实</summary>
                    <div className="wa-long-facts">
                      {section.facts
                        .filter((entry) => entry.state === 'superseded')
                        .map((entry) => fact(entry, section))}
                    </div>
                  </details>
                )}
              </div>
            ))}
            {!sections.some((section) => section.facts.length) && (
              <p className="wa-help wa-section-space">
                还没有匹配的长期事实。身份、稳定偏好、重要约定和明确更正会从后续会话中逐步保存。
              </p>
            )}
          </section>
          <section className="wa-document-section wa-long-storage">
            <h2>记忆文件与维护</h2>
            <details className="wa-subsection">
              <summary>保存位置与编辑说明</summary>
              <div className="wa-path-value wa-section-space">{doc.path}</div>
              <p className="wa-help wa-section-space">
              global-memory.md
              是正文来源，可用文本编辑器查看和修改。请保留账号、会话和事实标记；未处理的原始来源单独保存，即使局部窗口压缩也能继续提取。
              </p>
            </details>
            <details className="wa-subsection">
              <summary>查看完整 Markdown</summary>
              <pre className="wa-long-preview">{doc.markdown}</pre>
            </details>
            {!rawDraft ? (
              <div className="wa-long-tools">
                <Button
                  disabled={!!busy || dirty || !!editing || doc.readOnly}
                  onClick={() => setRawDraft({ base: doc, value: doc.markdown })}
                >
                  {doc.invalid ? '修复完整 Markdown' : '编辑完整 Markdown'}
                </Button>
              </div>
            ) : (
              <div className="wa-section-space">
                <textarea
                  className="wa-textarea"
                  aria-label="完整长期记忆 Markdown"
                  rows={16}
                  maxLength={2000000}
                  value={rawDraft.value}
                  disabled={!!busy || doc.readOnly}
                  onChange={(event) => setRawDraft({ ...rawDraft, value: event.target.value })}
                />
                <p className="wa-help">手动删除事实会同时记录来源，避免旧消息自动回填。来源标记损坏时不会覆盖原文。</p>
                <div className="wa-long-tools">
                  <Button
                    primary
                    disabled={!!busy || doc.readOnly || rawDraft.value === rawDraft.base.markdown}
                    onClick={async () => {
                      if (await save(rawDraft.base, rawDraft.value, '长期记忆 Markdown 已保存。')) setRawDraft(null);
                    }}
                  >
                    保存 Markdown
                  </Button>
                  <Button disabled={!!busy} onClick={() => setRawDraft(null)}>
                    取消编辑
                  </Button>
                </div>
              </div>
            )}
            <div className="wa-subsection">
              <Button
                danger
                disabled={!!busy || dirty || !!editing || !!rawDraft || doc.readOnly}
                onClick={() => setConfirmClear(true)}
              >
                清空这个账号的长期记忆
              </Button>
              {confirmClear && (
                <div className="wa-note-box wa-section-space">
                  <p>
                    将清空全局备注和所有会话的长期事实，并从后续新消息重新积累。局部会话记忆、聊天记录和备份仍保留，但旧内容不会自动回填。
                  </p>
                  <div className="wa-long-tools">
                    <Button
                      danger
                      disabled={!!busy || doc.readOnly}
                      onClick={() =>
                        act('memory.global.clear', { accountId }, '长期记忆已清空，将从后续新消息重新积累。')
                      }
                    >
                      确认清空长期记忆
                    </Button>
                    <Button disabled={!!busy} onClick={() => setConfirmClear(false)}>
                      返回
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
