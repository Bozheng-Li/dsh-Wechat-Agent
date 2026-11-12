import { CleanupControl } from '../../components/cleanup-control.jsx';
import { useEffect, useRef, useState } from 'react';
import { conversationKey, formatTime, searchText } from "../../shared/conversations.mjs";
import { taskViews } from "../../../shared/task-history.mjs";
import { selector } from "../../shared/peers.mjs";
import { Button, Alert, Field } from "../../components/automation-ui.jsx";
import { RoomPicker } from "../../components/room-picker.jsx";
import { TaskRecipients } from "./recipients.jsx";
import { taskStates, localDateInput, scheduleLabel, TaskBadge, TaskDetails } from "./details.jsx";
import { PageHead } from '../../components/page-ui.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

export function TasksPage({ rpc, status, rows, initialPeer }) {
  const peers = rows.filter((peer) => peer.authorized),
    accountId = status.account?.id;
  const [selected, setSelected] = useState(() => (initialPeer?.authorized ? initialPeer : peers[0] || null)),
    [data, setData] = useState({ tasks: [], runs: [] });
  const [content, setContent] = useState(''),
    [kind, setKind] = useState('message'),
    [scheduleKind, setScheduleKind] = useState('once');
  const [at, setAt] = useState(() => localDateInput(Date.now() + 5 * 60000)),
    [dailyTime, setDailyTime] = useState('09:00'),
    [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [filter, setFilter] = useState('all');
  const [view, setView] = useState('current'),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(0),
    [showCreate, setShowCreate] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [targets, setTargets] = useState([]);
  const request = useRef({ signature: '', id: '' });
  const mounted = useRef(true),
    actionController = useRef(null);
  const reload = async (signal) => {
    if (accountId) {
      const result = await rpc('tasks.list', { accountId }, signal);
      if (!signal?.aborted && mounted.current) {
        setData(result);
        setLoaded(true);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      actionController.current?.abort();
    };
  }, []);
  useEffect(() => {
    setPage(0);
  }, [view, query, filter]);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        await reload(controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [accountId]);
  const act = async (endpoint, payload, success, refresh = true) => {
    if (busy) return false;
    setBusy(endpoint);
    setError('');
    setNotice('');
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const result = await rpc(endpoint, payload, controller.signal);
      if (refresh) await reload(controller.signal);
      if (!mounted.current || controller.signal.aborted) return false;
      setNotice(success || '');
      return result || true;
    } catch (failure) {
      if (mounted.current) setError(failure.message);
      return false;
    } finally {
      if (mounted.current) setBusy('');
      if (actionController.current === controller) actionController.current = null;
    }
  };
  const create = async (event) => {
    event.preventDefault();
    if (!selected || busy) return;
    const schedule =
      scheduleKind === 'once'
        ? { kind: 'once', at: new Date(at).getTime() }
        : scheduleKind === 'daily'
          ? { kind: 'daily', time: dailyTime, timeZone: 'Asia/Shanghai' }
          : { kind: 'interval', minutes: Number(minutes) };
    const task = { kind, content, schedule, targets },
      target = selector(status, selected),
      signature = JSON.stringify({ target, task });
    if (signature !== request.current.signature) request.current = { signature, id: crypto.randomUUID() };
    if (
      await act(
        'tasks.create',
        { ...target, task, requestId: request.current.id },
        '任务已保存，到期后向选定会话执行。'
      )
    ) {
      setContent('');
      setTargets([]);
      setShowCreate(false);
      setView('current');
      setFilter('all');
      setQuery('');
      request.current = { signature: '', id: '' };
    }
  };
  const cleanupState = { busy: !!busy, setNotice, execute: (method, payload, refresh = true) => act(method, { ...payload, accountId }, '', refresh) };
  const words = searchText(query).split(' ').filter(Boolean);
  const visible = data.tasks.filter(
    (task) =>
      (filter === 'all' || conversationKey(task) === filter) &&
      words.every((word) =>
        searchText(
          [task.name, task.content, task.senderName, ...(task.targets || []).map((target) => target.name)].join(' ')
        ).includes(word)
      )
  );
  const views = taskViews(visible, data.runs),
    entries = views[view],
    pageCount = Math.max(1, Math.ceil(entries.length / 20)),
    currentPage = Math.min(page, pageCount - 1);
  const pageEntries = entries.slice(currentPage * 20, currentPage * 20 + 20);
  const rooms = [...new Map(data.tasks.map((task) => [conversationKey(task), task])).values()];
  const taskPaused = task => task.state === 'paused' || data.error || rows.some(peer => conversationKey(peer) === conversationKey(task) && !peer.authorized);
  return (
    <>
      <PageHead icon="clock" title="定时任务" description="安排提醒与 Agent 任务，查看执行结果。">
        {accountId && (
          <Button
            primary
            data-testid="task-create-toggle"
            aria-expanded={showCreate}
            aria-controls="wa-task-create"
            disabled={!!busy}
            onClick={() => setShowCreate((value) => !value)}
          >
            {showCreate ? '收起新增' : '新增任务'}
          </Button>
        )}
      </PageHead>
      <Alert text={error || data.error} />
      {notice && (
        <p className="wa-alert is-success" role="status">
          {notice}
        </p>
      )}
      {!accountId ? (
        <div className="wa-empty">
          <div className="wa-empty-icon"><Glyph name="clock" /></div>
          <h3>先连接微信账号</h3>
          <p>连接并授权会话后即可安排任务。</p>
        </div>
      ) : (
        <>
          {showCreate && (
            <form
              id="wa-task-create"
              className="wa-task-create wa-automation-editor"
              onSubmit={create}
              data-testid="task-create-form"
            >
              <header className="wa-editor-heading"><h2>新增任务</h2><p>选择会话、填写内容，再安排执行时间。</p></header>
              <fieldset disabled={!!busy} className="wa-task-fields">
                <section className="wa-form-section">
                <h3>发送到哪里</h3>
                <RoomPicker
                  rows={peers}
                  value={selected}
                  onChange={(peer) => {
                    setSelected(peer);
                    setTargets([]);
                  }}
                  authorizedOnly
                />
                <TaskRecipients
                  key={accountId + ':' + (selected ? conversationKey(selected) : '')}
                  rpc={rpc}
                  accountId={accountId}
                  peer={selected}
                  value={targets}
                  onChange={setTargets}
                  disabled={!!busy}
                />
                </section>
                <section className="wa-form-section">
                <h3>任务内容</h3>
                <Field label="做什么">
                  <select
                    className="wa-select"
                    aria-label="任务类型"
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    <option value="message">发送这段消息</option>
                    <option value="agent">让 Agent 执行任务并回复</option>
                  </select>
                </Field>
                <Field
                  label={kind === 'message' ? '发送内容' : '任务要求'}
                  help={
                    kind === 'agent' ? '到期后结合该会话记忆、人设与已开启的能力执行。' : '到期后原样发送这段文字。'
                  }
                >
                  <textarea
                    className="wa-textarea"
                    aria-label="定时任务内容"
                    rows={4}
                    maxLength={4000}
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder={kind === 'agent' ? '例如：总结群里今天讨论的行动项。' : '例如：该吃饭啦。'}
                  />
                </Field>
                </section>
                <section className="wa-form-section">
                <h3>执行时间</h3>
                <div className="wa-form-grid">
                  <Field label="什么时候">
                    <select
                      className="wa-select"
                      aria-label="任务执行方式"
                      value={scheduleKind}
                      onChange={(event) => setScheduleKind(event.target.value)}
                    >
                      <option value="once">指定时间，仅一次</option>
                      <option value="daily">每天固定时间</option>
                      <option value="interval">按间隔重复</option>
                    </select>
                  </Field>
                  {scheduleKind === 'once' ? (
                    <Field label="执行时间（当前设备时区）">
                      <input
                        className="wa-input"
                        aria-label="任务执行时间"
                        type="datetime-local"
                        value={at}
                        onChange={(event) => setAt(event.target.value)}
                      />
                    </Field>
                  ) : scheduleKind === 'daily' ? (
                    <Field label="每天几点（北京时间）">
                      <input
                        className="wa-input"
                        aria-label="每日执行时间"
                        type="time"
                        value={dailyTime}
                        onChange={(event) => setDailyTime(event.target.value)}
                      />
                    </Field>
                  ) : (
                    <Field label="每隔多少分钟">
                      <input
                        className="wa-input"
                        aria-label="重复间隔分钟"
                        type="number"
                        min="1"
                        max="525600"
                        value={minutes}
                        onChange={(event) => setMinutes(event.target.value)}
                      />
                    </Field>
                  )}
                </div>
                </section>
                <div className="wa-form-actions">
                  <span className="wa-help">保存后按计划执行。</span>
                  <div className="wa-row">
                  <Button quiet disabled={!!busy} onClick={() => setShowCreate(false)}>取消新增</Button>
                  <Button
                    type="submit"
                    primary
                    disabled={!!busy || !selected || !content.trim() || !status.settings.enabled}
                  >
                    {busy === 'tasks.create' ? '正在保存…' : '保存定时任务'}
                  </Button>
                  </div>
                </div>
                {!status.settings.enabled && <p className="wa-help">请先在“设置 → 自动功能”中开启自动回复。</p>}
              </fieldset>
            </form>
          )}
          <section className="wa-task-workspace">
            <div className="wa-task-toolbar">
              <div className="wa-task-tabs" role="tablist" aria-label="任务视图">
                {[
                  ['current', '当前任务'],
                  ['history', '历史记录'],
                ].map(([key, label]) => (
                  <button
                    type="button"
                    role="tab"
                    id={'wa-task-tab-' + key}
                    aria-controls="wa-task-panel"
                    aria-selected={view === key}
                    tabIndex={view === key ? 0 : -1}
                    data-testid={'task-tab-' + key}
                    key={key}
                    onClick={() => setView(key)}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const next =
                        event.key === 'Home'
                          ? 'current'
                          : event.key === 'End'
                            ? 'history'
                            : key === 'current'
                              ? 'history'
                              : 'current';
                      setView(next);
                      document.getElementById('wa-task-tab-' + next)?.focus();
                    }}
                  >
                    {label}
                    <span>{views[key].length}</span>
                  </button>
                ))}
              </div>
              <div className="wa-task-tools">
                <input
                  className="wa-input"
                  aria-label="搜索定时任务"
                  placeholder="搜索内容或会话"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <select
                  className="wa-select"
                  aria-label="定时任务筛选"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                >
                  <option value="all">全部会话</option>
                  {rooms.map((task) => (
                    <option key={conversationKey(task)} value={conversationKey(task)}>
                      {task.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {!status.settings.enabled && <p className="wa-task-warning">自动回复已关闭，定时任务暂不执行。</p>}
            <div className="wa-wb-actions">{view === 'history' && <><CleanupControl key={accountId} state={cleanupState} kind="tasks.history" label="清空任务历史" />{(query || filter !== 'all') && <CleanupControl state={cleanupState} kind="tasks.history" ids={views.history.map(entry => entry.task.id)} label="删除筛选结果" />}</>}</div>
            <div id="wa-task-panel" role="tabpanel" aria-labelledby={'wa-task-tab-' + view}>
              {view === 'current' ? (
                <div className="wa-task-list" data-testid="task-list">
                  {!!pageEntries.length && <div className="wa-task-list-heading" aria-hidden="true"><span>任务</span><span>执行时间</span><span>状态</span><span>操作</span></div>}
                  {pageEntries.map((task) => (
                    <article className="wa-task" key={task.id} data-task-id={task.id} data-state={task.state}>
                      <div className="wa-task-main">
                        <div className="wa-task-heading">
                          <div className="wa-task-title-line"><Glyph name={task.kind === 'agent' ? 'spark' : 'chat'} /><h3>{task.content}</h3></div>
                          <p className="wa-help">
                            {task.name} · {task.kind === 'agent' ? 'Agent 任务' : '发送消息'} ·{' '}
                            {scheduleLabel(task.schedule)}
                          </p>
                          {task.targets?.length > 0 && (
                            <p className="wa-help">
                              提醒对象：{task.targets.map((target) => '@' + target.name).join('、')}
                            </p>
                          )}
                        </div>
                        <div className="wa-task-next">
                          <span>
                            {task.overdue
                              ? '已到期，等待提醒'
                              : task.state === 'running'
                                ? '本次计划'
                                : task.state === 'paused'
                                  ? '原计划'
                                  : '下次执行'}
                          </span>
                          <time>{formatTime(task.nextRunAt)}</time>
                          <ScheduleCountdown at={Math.max(task.nextRunAt, task.retryAt || 0)} running={task.state === 'running'}
                            paused={taskPaused(task)} status={status} action={task.retryAt > task.nextRunAt ? '重试' : '执行'} />
                        </div>
                        <TaskBadge state={task.state} />
                        <div className="wa-task-actions">
                          {task.state === 'pending' && (
                            <Button
                              quiet
                              disabled={!!busy}
                              onClick={() => act('tasks.pause', { accountId, taskId: task.id }, '任务已暂停。')}
                            >
                              暂停
                            </Button>
                          )}
                          {task.state === 'paused' && !['unknown', 'partial'].includes(task.lastState) && (
                            <Button
                              quiet
                              disabled={!!busy}
                              onClick={() => act('tasks.resume', { accountId, taskId: task.id }, '任务已恢复。')}
                            >
                              恢复
                            </Button>
                          )}
                          <Button
                            danger
                            quiet
                            disabled={!!busy}
                            onClick={() =>
                              act(
                                'tasks.cancel',
                                { accountId, taskId: task.id },
                                '任务已取消，已移入历史记录；发送结果以回执为准。'
                              )
                            }
                          >
                            取消任务
                          </Button>
                        </div>
                      </div>
                      {task.lastState &&
                        ['failed', 'unknown', 'partial', 'cancelled', 'expired'].includes(task.lastState) && (
                          <p className="wa-task-warning">
                            {taskStates[task.lastState]}
                            {task.lastError ? ' · ' + task.lastError : ''}
                          </p>
                        )}
                      <details className="wa-task-details">
                        <summary>查看详情</summary>
                        <TaskDetails task={task} paused={taskPaused(task)} status={status} />
                      </details>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="wa-task-history" data-testid="task-history">
                  {pageEntries.length > 0 && (
                    <div className="wa-task-history-head">
                      <span>记录时间</span>
                      <span>任务与会话</span>
                      <span>结果</span>
                      <span />
                    </div>
                  )}
                  {pageEntries.map((entry) => (
                    <details className="wa-task-history-row" key={entry.task.id} data-task-id={entry.task.id}>
                      <summary>
                        <time>{formatTime(entry.timestamp)}</time>
                        <div className="wa-task-history-title">
                          <strong>{entry.task.content}</strong>
                          <span>
                            {entry.task.name} · {scheduleLabel(entry.task.schedule)}
                            {entry.task.state === 'cancelled' && entry.result === 'sent'
                              ? ' · 已有微信确认，请以回执为准'
                              : ''}
                          </span>
                        </div>
                        <div className="wa-task-history-result">
                          <TaskBadge state={entry.state} />
                          {entry.result && entry.result !== entry.state && entry.state !== 'completed' && (
                            <small>{taskStates[entry.result] || entry.result}</small>
                          )}
                        </div>
                        <span className="wa-task-expand" aria-hidden="true">
                          ⌄
                        </span>
                      </summary>
                      <TaskDetails task={entry.task} runs={entry.runs} paused={taskPaused(entry.task)} status={status} /><CleanupControl state={cleanupState} kind="tasks.history" ids={[entry.task.id]} label="删除任务历史" />
                    </details>
                  ))}
                </div>
              )}
              {!entries.length && (
                <div className="wa-empty wa-task-empty">
                  <div className="wa-empty-icon"><Glyph name={view === 'current' ? 'clock' : 'history'} /></div>
                  <h3>
                    {!loaded
                      ? '正在读取任务…'
                      : query || filter !== 'all'
                        ? '没有匹配的任务'
                        : view === 'current'
                          ? '暂无待执行任务'
                          : '暂无历史记录'}
                  </h3>
                  <p>
                    {query || filter !== 'all'
                      ? '试试其他关键词或切换到全部会话。'
                      : view === 'current'
                        ? '可以点击右上方新增，也可以在聊天中安排提醒。'
                        : '任务结束后会保留在这里，执行过的循环任务也可查看最近结果。'}
                  </p>
                </div>
              )}
            </div>
            {entries.length > 20 && (
              <div className="wa-task-pagination">
                <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                  上一页
                </Button>
                <span>
                  {currentPage * 20 + 1}–{Math.min(currentPage * 20 + 20, entries.length)} / {entries.length}
                </span>
                <Button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>
                  下一页
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
