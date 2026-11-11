import { CleanupControl } from '../../components/cleanup-control.jsx';
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Feedback, Tag } from '../../components/workbench-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { formatTime } from '../../shared/conversations.mjs';
import { Glyph } from '../../components/glyph.jsx';
import { MOMENTS_LIKE_DEFAULTS as defaults } from '../../../shared/moments-likes.mjs';

const bounds = [['intervalMinutes', '检查间隔（分钟）', 5, 1440], ['lookbackDays', '查看最近几天', 1, 30], ['maxLikesPerRun', '每轮最多点赞', 1, 20], ['maxLikesPerDay', '每天最多点赞', 1, 100]];
const recordLabels = { sending: '等待微信确认', liked: '微信已确认', unknown: '结果不明', rejected: '未提交成功', skipped: '已跳过' };
const runLabels = { running: '执行中', completed: '已完成', cancelled: '已取消', failed: '执行失败', interrupted: '已中断' };
// Keep the same operation identity when this tab is closed and reopened.
const likeOperations = new Map();
const emptyFeed = () => ({ items: [], nextCursor: null, loaded: false, loading: false, error: '' });
const errorText = error => typeof error === 'string' ? error : error?.message || '';
const postLiked = (post, accountId) => post.likedByCurrentAccount === true || (post.likes ?? []).some(row => row.userId === accountId);
const stamp = seconds => seconds ? formatTime(seconds * 1000) : '时间未知';

export function MomentsFriendsPage({ rpc, status, onInteract, onComments }) {
  const accountId = status.account?.id, online = status.online && !!accountId;
  const state = useWorkbench(rpc, accountId, 'moments.likes.list', '', 5000);
  const [feed, setFeed] = useState(emptyFeed), [scope, setScope] = useState('timeline'), [user, setUser] = useState('');
  const [contacts, setContacts] = useState(null), [contactsError, setContactsError] = useState(''), [contactSearch, setContactSearch] = useState(''), [contactLimit, setContactLimit] = useState(50);
  const [settings, setSettings] = useState({ ...defaults }), [dirty, setDirty] = useState(false), [, renderLikes] = useState(0), [cancelling, setCancelling] = useState(false), [controlError, setControlError] = useState('');
  const api = useRef(rpc), reader = useRef(null), contactReader = useRef(null), epoch = useRef(0), live = useRef(false), writes = useRef(new Set()), runRequest = useRef(null);
  api.current = rpc;
  const data = state.data?.accountId === accountId ? state.data : null;
  useEffect(() => { if (data?.settings && !dirty) setSettings(data.settings); }, [data, dirty]);
  const update = patch => { setSettings(value => ({ ...value, ...patch })); setDirty(true); };
  const invalidate = () => { epoch.current++; reader.current?.abort(); reader.current = null; setFeed(emptyFeed()); };
  const read = async (cursor, target = { scope, user }) => {
    if (!online || target.scope === 'user' && !target.user.trim()) return;
    reader.current?.abort();
    const controller = new AbortController(), version = ++epoch.current;
    reader.current = controller;
    setFeed(previous => ({ ...(cursor ? previous : emptyFeed()), loading: true, error: '' }));
    try {
      const result = await api.current('moments.read', { accountId, action: target.scope, ...(target.scope === 'user' ? { user: target.user.trim() } : {}), ...(cursor ? { cursor } : {}), limit: 20 }, controller.signal);
      if (!live.current || controller.signal.aborted || version !== epoch.current) return;
      if (result.accountId !== accountId) throw new Error('账号已变化，请重新读取好友动态。');
      setFeed(previous => {
        const items = new Map((cursor ? previous.items : []).map(post => [post.id, post]));
        for (const post of result.items ?? []) if (post.author?.userId && post.author.userId !== accountId) items.set(post.id, post);
        return { items: [...items.values()], nextCursor: result.nextCursor, selection: result.selection, loaded: true, loading: false, error: '' };
      });
    } catch (error) {
      if (live.current && !controller.signal.aborted && version === epoch.current) setFeed(previous => ({ ...previous, loading: false, error: errorText(error) || '好友动态读取失败，请重试。' }));
    } finally { if (reader.current === controller) reader.current = null; }
  };
  const readContacts = async () => {
    contactReader.current?.abort();
    const controller = new AbortController(); contactReader.current = controller; setContactsError('');
    try {
      const result = await api.current('contacts', { accountId }, controller.signal);
      if (live.current && !controller.signal.aborted) setContacts((result.privatePeers ?? []).filter(row => row.id !== accountId));
    } catch (error) { if (live.current && !controller.signal.aborted) setContactsError(errorText(error)); }
  };
  useEffect(() => {
    live.current = true;
    if (accountId) { void read(undefined, { scope: 'timeline', user: '' }); void readContacts(); }
    return () => { live.current = false; epoch.current++; reader.current?.abort(); contactReader.current?.abort(); for (const controller of writes.current) controller.abort(); };
  }, [accountId]);
  const like = async (post, retry = false) => {
    const key = accountId + ':' + post.id, previous = likeOperations.get(key);
    if (!online || postLiked(post, accountId) || previous && !(retry && previous.state === 'rejected')) return;
    const operation = { requestId: 'ui-moments-' + crypto.randomUUID(), state: 'sending' }, controller = new AbortController();
    likeOperations.set(key, operation); writes.current.add(controller); renderLikes(value => value + 1);
    try {
      const result = await api.current('moments.write', { accountId, action: 'like', postId: post.id, requestId: operation.requestId }, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]));
      if (result.accountId !== accountId || result.postId !== post.id || !(result.liked === true || result.alreadyLiked === true) || !['server-ack', 'verified-existing'].includes(result.delivery)) throw new Error('没有收到可核对的微信点赞回执。');
      Object.assign(operation, { state: 'liked', alreadyLiked: result.alreadyLiked === true, error: '' });
    } catch (error) { Object.assign(operation, { state: ['not-sent', 'rejected'].includes(error?.delivery) ? 'rejected' : 'unknown', error: errorText(error) || '没有收到微信确认。' }); }
    finally { writes.current.delete(controller); if (live.current) renderLikes(value => value + 1); }
  };
  const valid = bounds.every(([key, , min, max]) => Number.isInteger(settings[key]) && settings[key] >= min && settings[key] <= max) && (!settings.enabled || settings.userIds.length > 0) && settings.userIds.length <= 100;
  const visibleContacts = (contacts ?? []).filter(row => [row.name, row.nickname, row.remark, row.id].some(value => String(value ?? '').toLocaleLowerCase().includes(contactSearch.trim().toLocaleLowerCase())));
  const contactNames = new Map((contacts ?? []).map(row => [row.id, row.name || row.nickname || row.id]));
  const run = async () => {
    runRequest.current ??= 'ui-moments-' + crypto.randomUUID();
    const result = await state.execute('moments.likes.run', { requestId: runRequest.current }, false);
    if (result) { state.setData(result); runRequest.current = null; state.setNotice('本轮点赞处理已结束，结果见执行记录。'); }
  };
  const cancelRun = async () => {
    if (cancelling) return;
    setCancelling(true); setControlError('');
    try { const result = await api.current('moments.likes.cancel', { accountId }); if (live.current) { state.setData(result); state.setNotice('已请求停止本轮，请以执行记录中的微信回执为准。'); } }
    catch (error) { if (live.current) setControlError('取消未获确认：' + errorText(error)); }
    finally { if (live.current) setCancelling(false); }
  };
  return <div className="wa-moments-friends" data-testid="moments-friends" data-account-id={accountId}>
    <section className="wa-friend-feed" aria-labelledby="wa-friend-feed-title">
      <div className="wa-index-heading"><h2 id="wa-friend-feed-title">好友动态</h2><span>{feed.items.length ? `已读取 ${feed.items.length} 条` : '微信当前可见范围'}</span></div>
      <form className="wa-friend-query" onSubmit={event => { event.preventDefault(); void read(); }}>
        <label>查看范围<select aria-label="好友动态范围" value={scope} onChange={event => { invalidate(); setScope(event.target.value); }}><option value="timeline">最近好友动态</option><option value="user">指定好友</option></select></label>
        {scope === 'user' && <label>好友昵称或微信 ID<input aria-label="好友动态查询对象" list="wa-moments-friend-options" value={user} maxLength={150} placeholder="输入精确昵称、备注或微信 ID" onChange={event => { invalidate(); setUser(event.target.value); }} /><datalist id="wa-moments-friend-options">{(contacts ?? []).map(row => <option value={row.id} key={row.id}>{row.name || row.nickname || row.id}</option>)}</datalist></label>}
        <Button type="submit" disabled={!online || feed.loading || scope === 'user' && !user.trim()}>{feed.loaded ? '刷新好友动态' : '读取好友动态'}</Button>
      </form>
      <p className="wa-wb-note">仅显示好友当前可见的动态，每次最多读取 20 条；指定好友时按发布时间核对顺序。点赞数以最近一次微信读取为准。</p>
      {feed.selection?.complete === false && feed.nextCursor && <p className="wa-wb-note">还有未核实的动态范围，可以继续读取；当前结果不代表该好友的全部动态。</p>}
      {feed.error && <p role="alert" className="wa-alert is-error">{feed.error}</p>}
      {feed.loading && <p className="wa-wb-loading" role="status">正在读取好友动态…</p>}
      {!feed.items.length && !feed.loading && <Empty title={feed.loaded ? '本页没有可见的好友动态' : '选择范围，读取好友动态'}>{feed.loaded ? feed.nextCursor ? '可以继续读取下一页。' : '微信当前未返回好友动态，稍后可刷新。' : '指定好友时请使用精确昵称、备注或微信 ID。'}</Empty>}
      <div className="wa-friend-posts">{feed.items.map(post => {
        const operation = likeOperations.get(accountId + ':' + post.id), liked = postLiked(post, accountId) || operation?.state === 'liked';
        return <article className="wa-friend-post" key={post.id} data-post-id={post.id}>
          <header className="wa-moments-post-heading"><span className="wa-moments-avatar"><Glyph name="person" /></span><div><strong>{post.author.nickname || contactNames.get(post.author.userId) || post.author.userId}</strong><time>{stamp(post.createdAt)}</time></div>{post.deleted && <Tag state="disabled">已删除</Tag>}</header>
          <p className="wa-friend-post-text">{post.text || (post.contentAvailable === false ? '此动态正文暂不可见' : post.imageCount ? '图片动态' : '暂无文字内容')}</p>
          <div className="wa-friend-post-footer"><span>{post.imageCount > 0 && `${post.imageCount} 张图片 · `}{Number.isFinite(post.likeCount) ? `${post.likeCount} 个赞` : '点赞数未知'}{Number.isFinite(post.commentCount) && ` · ${post.commentCount} 条评论`}</span>
            {liked ? <Tag state="liked">{operation?.alreadyLiked ? '已点赞（微信核实）' : '已点赞'}</Tag> : operation ? <div className="wa-wb-actions"><Tag state={operation.state}>{recordLabels[operation.state]}</Tag>{operation.state === 'rejected' && <Button quiet aria-label={`重试点赞动态 ${post.id}`} disabled={!online || status.momentsWriteReady === false || post.deleted || post.contentAvailable === false} onClick={() => like(post, true)}>重试点赞</Button>}</div> : <Button quiet aria-label={`点赞动态 ${post.id}`} disabled={!online || status.momentsWriteReady === false || post.deleted || post.contentAvailable === false} onClick={() => like(post)}>点赞</Button>}
          </div>
          {(onInteract || onComments) && <div className="wa-wb-actions">
            {onInteract && <Button quiet aria-label={`评论动态 ${post.id}`} disabled={!online || post.deleted || post.contentAvailable === false} onClick={() => onInteract(post)}>写评论</Button>}
            {onComments && <Button quiet aria-label={`查看动态评论 ${post.id}`} disabled={!online || post.deleted || post.contentAvailable === false} onClick={() => onComments(post.id)}>查看评论</Button>}
          </div>}
          {!liked && operation?.error && <p className="wa-wb-note wa-friend-like-error" role="alert">{operation.error} {operation.state === 'rejected' ? '本次已明确未提交成功，可点击“重试点赞”重新提交。' : '结果尚未确认，请刷新好友动态核对；此条不会再次提交。'}</p>}
        </article>;
      })}</div>
      {feed.nextCursor && <Button quiet disabled={!online || feed.loading} onClick={() => read(feed.nextCursor)}>继续读取好友动态</Button>}
    </section>

    <section className="wa-friend-automation" data-testid="moments-likes-settings" aria-labelledby="wa-friend-likes-title">
      <header className="wa-index-heading"><h2 id="wa-friend-likes-title">自动点赞</h2><Tag state={data?.running ? 'running' : data?.settings.enabled ? 'ready' : 'disabled'}>{data?.running ? '本轮执行中' : data?.settings.enabled ? '定时已开启' : '定时已关闭'}</Tag></header>
      <Feedback state={state} cancellable={false} />
      {state.busy && <p className="wa-wb-loading" role="status"><span className="wa-activity-indicator" aria-hidden="true" />{runRequest.current ? '正在处理本轮点赞，等待执行结果…' : '正在更新点赞状态…'}</p>}
      {controlError && <p role="alert" className="wa-alert is-error">{controlError}</p>}
      {state.refreshError && <p role="alert" className="wa-wb-note">{state.refreshError}</p>}
      {data?.error && <p role="alert" className="wa-alert is-error">{errorText(data.error)}</p>}
      <p className="wa-wb-note">定时仅处理选中好友的新动态，默认关闭。聊天中的明确点赞请求由下方开关控制；结果不明时保留记录，不重复提交。</p>
      <fieldset className="wa-likes-fields" disabled={state.loading || state.busy || !data}>
        <section className="wa-form-section"><h3>触发方式</h3>
          <label className="wa-wb-check"><input aria-label="开启定时点赞" type="checkbox" checked={settings.enabled} onChange={event => update({ enabled: event.target.checked })} />定时为选中好友的新动态点赞</label>
          <label className="wa-wb-check"><input aria-label="响应聊天点赞请求" type="checkbox" checked={settings.respondToRequests} onChange={event => update({ respondToRequests: event.target.checked })} />响应聊天中明确提出的朋友圈点赞请求</label>
        </section>
        <section className="wa-form-section"><div className="wa-audience-heading"><h3>定时点赞的好友</h3><span className="wa-audience-count">已选 {settings.userIds.length} / 100</span></div>
          <div className="wa-friend-contact-search"><label>搜索好友<input aria-label="搜索自动点赞好友" type="search" value={contactSearch} placeholder="搜索昵称、备注或微信 ID" onChange={event => { setContactSearch(event.target.value); setContactLimit(50); }} /></label><Button quiet disabled={!online} onClick={readContacts}>刷新好友列表</Button></div>
          {contactsError && <p className="wa-alert is-error" role="alert">好友列表读取失败：{contactsError} 已选好友保留。</p>}
          <div className="wa-friend-contact-list" role="group" aria-label="自动点赞好友选择">{visibleContacts.slice(0, contactLimit).map(row => <label className={'wa-wb-check wa-audience-row' + (settings.userIds.includes(row.id) ? ' is-selected' : '')} key={row.id}>
            <input aria-label={`自动点赞好友 ${row.name || row.nickname || row.id} ${row.id}`} type="checkbox" disabled={!settings.userIds.includes(row.id) && settings.userIds.length >= 100} checked={settings.userIds.includes(row.id)} onChange={event => update({ userIds: event.target.checked ? [...settings.userIds, row.id] : settings.userIds.filter(id => id !== row.id) })} /><span>{row.name || row.nickname || row.id}<small className="wa-audience-identity">{row.id}</small></span>
          </label>)}{!visibleContacts.length && <p className="wa-wb-note">{contacts ? '没有匹配的好友。' : '正在读取好友列表…'}</p>}</div>
          {visibleContacts.length > contactLimit && <Button quiet onClick={() => setContactLimit(value => value + 50)}>显示更多好友</Button>}
          {settings.userIds.length > 0 && <div className="wa-recipient-selection">{settings.userIds.map(id => <Button quiet key={id} aria-label={`移除自动点赞好友 ${id}`} onClick={() => update({ userIds: settings.userIds.filter(value => value !== id) })}>{contactNames.get(id) || id} ×</Button>)}</div>}
          {!settings.userIds.length && <p className="wa-wb-note">尚未选择好友；开启定时或立即执行前，请先选择并保存。</p>}
        </section>
        <section className="wa-form-section"><h3>频率与额度</h3><div className="wa-wb-generator wa-likes-limits">{bounds.map(([key, label, min, max]) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} value={settings[key]} onChange={event => update({ [key]: event.target.value === '' ? '' : Number(event.target.value) })} /></label>)}</div>
          <label className="wa-wb-check"><input aria-label="包含开启前的动态" type="checkbox" checked={settings.includeExisting} onChange={event => update({ includeExisting: event.target.checked })} />也处理开启前、仍在最近天数范围内的动态</label>
          <p className="wa-wb-note">检查间隔 5–1440 分钟，最近 1–30 天；每轮 1–20 次，每天 1–100 次。未获确认的提交也占用尝试额度。</p>
        </section>
      </fieldset>
      <div className="wa-form-actions"><span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : '保存后生效，立即执行使用已保存设置。'}</span><div className="wa-wb-actions"><Button quiet disabled={!dirty || state.busy} onClick={() => { setSettings(data?.settings ?? { ...defaults }); setDirty(false); }}>取消点赞设置更改</Button><Button disabled={!dirty || !valid || state.busy || !data} onClick={async () => { const result = await state.execute('moments.likes.configure', { settings }, false); if (result) { state.setData(result); setDirty(false); state.setNotice('自动点赞设置已保存。'); } }}>保存点赞设置</Button></div></div>
      <div className="wa-likes-status"><div><p>下次检查：{data?.nextRunAt ? formatTime(data.nextRunAt) : '未安排'}</p><p>今日尝试 {data?.today?.attempted ?? 0} 次 · 确认新增 {data?.today?.liked ?? 0} 赞 · 剩余额度 {data?.today?.remaining ?? '—'}</p></div><div className="wa-wb-actions"><Button quiet disabled={state.busy} onClick={state.refresh}>刷新点赞状态</Button><Button quiet disabled={!online || state.busy || data?.running || dirty || !data?.settings.userIds.length} onClick={run}>{runRequest.current ? '核对此轮执行结果' : '立即执行一轮'}</Button>{data?.running && <Button quiet disabled={cancelling} onClick={cancelRun}>{cancelling ? '正在请求停止…' : '停止本轮'}</Button>}</div></div>
    </section>
    <section className="wa-likes-history" data-testid="moments-likes-history"><header className="wa-index-heading"><h2>执行记录</h2><span>自动点赞</span></header><div className="wa-wb-actions"><CleanupControl key={status.account?.id + ":runs"} state={state} kind="moments.likes.runs" label="清空执行轮次" /><CleanupControl key={status.account?.id + ":records"} state={state} kind="moments.likes.records" label="清空点赞记录" /></div>
      {!!data?.runs?.length && <p className="wa-wb-note">显示最近 10 轮执行与 30 条动态的处理结果。</p>}
      {(data?.runs ?? (data?.lastRun ? [data.lastRun] : [])).slice(0, 10).map(run => <div className="wa-likes-run" key={run.id}><div className="wa-wb-between"><strong>{run.source === 'scheduled' || run.source === 'schedule' ? '定时检查' : '手动执行'} · {formatTime(run.startedAt)}</strong><Tag state={run.state || 'done'}>{runLabels[run.state] || '已结束'}</Tag></div><p>扫描 {run.scanned ?? 0} 条 · 尝试 {run.attempted ?? 0} 次 · 确认新增 {run.liked ?? 0} 赞 · 跳过 {run.skipped ?? 0} 条</p>{run.error && <p className="wa-wb-note">{errorText(run.error)}</p>}<CleanupControl state={state} kind="moments.likes.runs" ids={[run.id]} label="删除本轮记录" /></div>)}
      {(data?.records ?? []).slice(0, 30).map(row => <div className="wa-likes-record" key={row.postId}><div className="wa-wb-between"><strong>{contactNames.get(row.userId) || row.userId}</strong><Tag state={row.state}>{row.alreadyLiked ? '微信核实已点赞' : recordLabels[row.state] || row.state}</Tag></div><p>{row.text || '无文字动态'}</p>{row.error && <p className="wa-wb-note">{errorText(row.error)}</p>}<small>{formatTime(row.updatedAt)} · 动态 {row.postId}</small><CleanupControl state={state} kind="moments.likes.records" ids={[row.postId]} label="删除点赞记录" /></div>)}
      {!data?.records?.length && !data?.runs?.length && !data?.lastRun && <p className="wa-wb-note">暂无执行记录。保存好友与规则后，可以立即执行一轮；定时默认关闭。</p>}
    </section>
  </div>;
}
