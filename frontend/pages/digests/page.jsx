import { CleanupControl } from '../../components/cleanup-control.jsx';
import { useState } from 'react';
import { formatTime } from "../../shared/conversations.mjs";
import { localDate } from "../../shared/local-date.mjs";
import { Button, Tag, Empty, Feedback, Offline } from "../../components/workbench-ui.jsx";
import { PageHead } from '../../components/page-ui.jsx';
import { useWorkbench } from "../../hooks/use-workbench.mjs";

export function DigestsPage({ rpc, status }) {
  const state = useWorkbench(rpc, status.account?.id, 'digest.list'),
    groups = (status.conversations || []).filter((peer) => peer.authorized && peer.chatType === 'group');
  const [peerId, setPeerId] = useState(groups[0]?.peerId || ''),
    [from, setFrom] = useState(localDate(new Date().setHours(0, 0, 0, 0))),
    [to, setTo] = useState(localDate(Date.now())),
    [selected, setSelected] = useState(null),
    [todoText, setTodoText] = useState({}),
    [reminder, setReminder] = useState(null),
    [remindAt, setRemindAt] = useState(localDate(Date.now() + 3600000)),
    [deleting, setDeleting] = useState(false);
  const summaries = state.data?.summaries || [],
    summary = summaries.find((row) => row.id === selected) || summaries[0];
  const generate = async () => {
    const value = await state.execute('digest.generate', {
      peerId,
      chatType: 'group',
      from: new Date(from).getTime(),
      to: new Date(to).getTime(),
    });
    if (value) {
      setSelected(value.id);
      setTodoText({});
    }
  };
  const changeTodo = async (todo, next) =>
    state.execute('digest.todo', {
      summaryId: summary.id,
      todoId: todo.id,
      state: next,
      text: todoText[todo.id] ?? todo.text,
    });
  const items = (values, title) => (
    <section className="wa-wb-digest-section">
      <h3>{title}</h3>
      {values.length ? (
        values.map((item) => (
          <div className="wa-wb-summary-item wa-digest-conclusion" key={item.id}>
            <p>{item.text}</p>
            <small>依据 {item.sources.join('、')}</small>
          </div>
        ))
      ) : (
        <p className="wa-wb-note">这次整理没有提取到有明确依据的条目。</p>
      )}
    </section>
  );
  return (
    <section className="wa-wb-page" data-testid="digests-page">
      <PageHead icon="digest" title="群聊简报" description="整理讨论、核对结论，确认需要跟进的待办。">
        <Button quiet disabled={state.busy} onClick={state.refresh}>
          重新读取
        </Button>
      </PageHead>
      <Feedback state={state} />
      <Offline status={status}>
        <div className="wa-digest-generator wa-wb-generator">
          <label>
            授权群聊
            <select
              aria-label="摘要群聊"
              value={peerId}
              disabled={state.busy}
              onChange={(event) => setPeerId(event.target.value)}
            >
              <option value="">选择群聊</option>
              {groups.map((peer) => (
                <option key={peer.peerId} value={peer.peerId}>
                  {peer.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            开始时间
            <input
              type="datetime-local"
              aria-label="摘要开始时间"
              value={from}
              disabled={state.busy}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            结束时间
            <input
              type="datetime-local"
              aria-label="摘要结束时间"
              value={to}
              disabled={state.busy}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <Button disabled={state.busy || !peerId || !from || !to} onClick={generate}>
            {state.busy ? '正在处理…' : '生成简报草稿'}
          </Button>
        </div>
        <div className={'wa-wb-split wa-digest-workspace' + (!summaries.length ? ' is-empty' : '')}>
          <div className="wa-wb-list wa-digest-index">
            {!!summaries.length && <div className="wa-index-heading"><h2>历史简报</h2><span>{summaries.length}</span></div>}
            <CleanupControl key={status.account?.id} state={state} kind="digests" label="清空历史简报" />
            {summaries.map((row) => (
              <button
                type="button"
                key={row.id}
                className={'wa-wb-list-item' + (summary?.id === row.id ? ' is-selected' : '')}
                aria-current={summary?.id === row.id ? 'true' : undefined}
                disabled={state.busy}
                onClick={() => {
                  setSelected(row.id);
                  setReminder(null);
                  setDeleting(false);
                }}
              >
                <small>{groups.find((group) => group.peerId === row.peerId)?.name || '历史群聊'}</small>
                <h3>{row.title}</h3>
                <span>{formatTime(row.createdAt)}</span>
              </button>
            ))}
          </div>
          <div>
            {summary ? (
              <article className="wa-wb-digest">
                <header className="wa-digest-document-heading"><span>{groups.find((group) => group.peerId === summary.peerId)?.name || '历史群聊'} · 群聊简报</span><h2>{summary.title}</h2></header>
                <p className="wa-wb-note wa-digest-coverage">
                  {formatTime(summary.from)} — {formatTime(summary.to)} · 本机保存 {summary.coverage.storedMessages}{' '}
                  条，本次纳入 {summary.coverage.included} 条
                  {summary.coverage.truncated ? '（范围过大，仅含部分消息；请缩小时间段）' : ''}
                  。仅覆盖本机已保存的消息，不代表微信完整历史。
                </p>
                {items(summary.conclusions, '形成的结论')}
                {items(summary.questions, '尚未解决')}
                <div className="wa-wb-digest-section">
                  <h3>待办 · 确认后生效</h3>
                  {!summary.todos.length && <p className="wa-wb-note">没有明确待办。</p>}
                  {summary.todos.map((todo) => (
                    <div className={'wa-wb-todo is-' + todo.state} key={todo.id}>
                      <div className="wa-wb-between">
                        <span>
                          {todo.owner || '负责人待核对'} · 依据 {todo.sources.join('、')}
                        </span>
                        <Tag state={todo.state} />
                      </div>
                      {['draft', 'confirmed'].includes(todo.state) && !todo.taskId ? <textarea
                        aria-label="待办内容"
                        value={todoText[todo.id] ?? todo.text}
                        disabled={state.busy}
                        onChange={(event) => setTodoText({ ...todoText, [todo.id]: event.target.value })}
                      /> : <p className="wa-wb-todo-text">{todo.text}</p>}
                      <div className="wa-wb-actions wa-todo-actions">
                        {todo.state === 'draft' && (
                          <>
                            <Button disabled={state.busy} onClick={() => changeTodo(todo, 'confirmed')}>
                              确认待办
                            </Button>
                            <Button quiet disabled={state.busy} onClick={() => changeTodo(todo, 'dismissed')}>
                              忽略
                            </Button>
                          </>
                        )}
                        {todo.state === 'confirmed' && (
                          <>
                            <Button quiet disabled={state.busy} onClick={() => changeTodo(todo, 'done')}>
                              标记完成
                            </Button>
                            {!todo.taskId && <Button
                              disabled={state.busy}
                              onClick={() => {
                                setReminder(todo.id);
                                setRemindAt(localDate(Date.now() + 3600000));
                              }}
                            >
                              设为定时提醒
                            </Button>}
                          </>
                        )}
                      </div>
                      {todo.taskId && (
                        <p className="wa-wb-note">
                          {todo.reminder?.state === 'missing'
                            ? '提醒记录不可用，请到定时页核对'
                            : <>{todo.reminder?.state === 'cancelled' ? '提醒已取消' : todo.reminder?.state === 'completed' ? '提醒已完成' : '已创建提醒'}：{todo.reminder?.at ? formatTime(todo.reminder.at) : '请到定时页核对'}
                              {['cancelled', 'completed'].includes(todo.reminder?.state) ? '' : ' · 以定时页执行状态为准'}</>}
                        </p>
                      )}
                      {reminder === todo.id && (
                        <div className="wa-wb-review" role="region" aria-label="确认待办提醒">
                          <strong>
                            提醒会发到原群聊：
                            {groups.find((group) => group.peerId === summary.peerId)?.name || summary.peerId}
                          </strong>
                          <p>{todo.text}</p>
                          <label>
                            提醒时间
                            <input
                              type="datetime-local"
                              aria-label="待办提醒时间"
                              value={remindAt}
                              disabled={state.busy}
                              onChange={(event) => setRemindAt(event.target.value)}
                            />
                          </label>
                          <div className="wa-wb-actions">
                            <Button
                              disabled={state.busy || !remindAt}
                              onClick={async () => {
                                const saved = await state.execute('digest.remind', {
                                  summaryId: summary.id,
                                  todoId: todo.id,
                                  at: new Date(remindAt).getTime(),
                                  content: todo.text,
                                });
                                if (saved) {
                                  const actual = saved.todos.find((item) => item.id === todo.id)?.reminder;
                                  setReminder(null);
                                  state.setNotice(
                                    '提醒已保存' +
                                      (actual?.at ? '：' + formatTime(actual.at) : '') +
                                      '，可到定时页核对和取消。'
                                  );
                                }
                              }}
                            >
                              确认创建提醒
                            </Button>
                            <Button quiet disabled={state.busy} onClick={() => setReminder(null)}>
                              取消
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <details className="wa-wb-source-list">
                  <summary>核对原始消息 · {summary.source.length} 条</summary>
                  {summary.source.map((source) => (
                    <blockquote key={source.id}>
                      <small>
                        {source.id} · {source.sender} · {formatTime(source.time)}
                      </small>
                      <p>{source.text}</p>
                    </blockquote>
                  ))}
                </details>
                {deleting ? (
                  <div className="wa-wb-review" role="region" aria-label="确认删除简报">
                    <strong>删除这份简报？</strong>
                    <p>简报和其中的待办会移除。已经创建的定时提醒独立保留，可到定时页管理。</p>
                    <div className="wa-wb-actions">
                      <Button
                        danger
                        disabled={state.busy}
                        onClick={async () => {
                          if (
                            await state.execute('digest.delete', {
                              summaryId: summary.id,
                              revision: state.data.revision,
                            })
                          ) {
                            setSelected(null);
                            setReminder(null);
                            setDeleting(false);
                          }
                        }}
                      >
                        确认删除简报
                      </Button>
                      <Button quiet disabled={state.busy} onClick={() => setDeleting(false)}>
                        保留简报
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="wa-wb-actions wa-wb-history">
                    <Button quiet danger disabled={state.busy} onClick={() => setDeleting(true)}>
                      删除简报
                    </Button>
                  </div>
                )}
              </article>
            ) : (
              <Empty title="从一段讨论开始">
                选择群聊和时间范围，生成带原文依据的简报。生成简报不会发送群消息，也不会自动创建提醒。
              </Empty>
            )}
          </div>
        </div>
      </Offline>
    </section>
  );
}
