import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Feedback, Offline, Tag } from '../../components/workbench-ui.jsx';
import { PageHead } from '../../components/page-ui.jsx';
import { WorkspaceTabs, WorkspacePanels } from '../../components/workspace-tabs.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_DEFAULTS } from '../../../shared/moments.mjs';
import { AudiencePicker, audiencePreview } from './audience-picker.jsx';
import { MomentsPublishingPage } from './publishing-page.jsx';
const stamp = seconds => formatTime(seconds * 1000);
const replyLabels = { sent: '微信已确认', existing: '已有回复', sending: '提交中', unknown: '结果不明，未重发', rejected: '已拒绝，未重发', failed: '生成失败，尚未提交', generating: '生成中', draft: '草稿' };

export function MomentsPage({ rpc, status }) {
  const state = useWorkbench(rpc, status.account?.id, 'moments.list');
  const [tab, setTab] = useState('posts'), [postId, setPostId] = useState(''), [lookup, setLookup] = useState(''),
    [comments, setComments] = useState(null), [reply, setReply] = useState(null), [replyText, setReplyText] = useState(''),
    [text, setText] = useState(''), [photos, setPhotos] = useState([]), [settings, setSettings] = useState({ ...MOMENTS_DEFAULTS }),
    [dirty, setDirty] = useState(false), [deleting, setDeleting] = useState(false), [fileError, setFileError] = useState('');
  const [audience, setAudience] = useState(null), [audienceError, setAudienceError] = useState(false),
    [selection, setSelection] = useState({ blockedLabelIds: [], blockedUserIds: [] });
  const preview = audiencePreview(audience, selection.blockedLabelIds, selection.blockedUserIds);
  const hasSelection = selection.blockedLabelIds.length + selection.blockedUserIds.length > 0;
  const loadAudience = async () => {
    const value = await state.execute('moments.audience', {}, false);
    if (value) { setAudience(value); setAudienceError(false); } else setAudienceError(true);
  };
  const operation = useRef(null), liveState = useRef(state); liveState.current = state;
  const data = state.data, posts = data?.posts ?? [], post = posts.find(post => post.id === postId);
  useEffect(() => { if (data?.settings && !dirty) setSettings(data.settings); }, [data, dirty]);
  useEffect(() => { const timer = setInterval(() => { if (!liveState.current.busy) void liveState.current.refresh(); }, 15000); return () => clearInterval(timer); }, []);
  const update = values => { setSettings({ ...settings, ...values }); setDirty(true); };
  const write = async args => {
    const signature = JSON.stringify(args);
    if (operation.current?.signature !== signature) operation.current = { signature, requestId: 'ui-moments-' + crypto.randomUUID() };
    const result = await state.execute('moments.write', { ...args, requestId: operation.current.requestId });
    if (result) { operation.current = null; state.setNotice('微信已确认' + (args.action === 'delete' ? '删除' : args.action === 'publish' ? '发布' : '回复') + '。'); }
    return result;
  };
  const loadComments = async (id = postId, cursor) => {
    const value = await state.execute('moments.read', { action: 'comments', postId: id, limit: 50, ...(cursor ? { cursor } : {}) });
    if (value) { setPostId(id); setComments(cursor ? { ...value, items: [...(comments?.items ?? []), ...value.items] } : value); setTab('comments'); setReply(null); }
  };
  const choosePhotos = async event => {
    const files = [...event.target.files]; setFileError('');
    if (files.length > 9 || files.some(file => file.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type))) {
      setFileError('请选择最多 9 张 PNG/JPEG，每张不超过 10 MiB。'); event.target.value = ''; return;
    }
    try { setPhotos(await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve({ name: file.name, url: reader.result, data: String(reader.result).split(',')[1] }); reader.readAsDataURL(file);
    })))); } catch { setFileError('图片读取失败，请重新选择。'); }
  };
  return <section className="wa-wb-page" data-testid="moments-page">
    <PageHead title="朋友圈" description="查看自己的动态，发布与回复评论。"><Button quiet disabled={state.busy} onClick={state.refresh}>刷新状态</Button></PageHead>
    <Feedback state={state} />
    <Offline status={status}>
      {!status.online && <p className="wa-alert is-error">微信未连接，发布和定时回复暂不执行。</p>}
      {data?.error && <p className="wa-alert is-error">{data.error}</p>}
      <WorkspaceTabs name="moments" label="朋友圈功能" active={tab} onChange={setTab}
        tabs={[["posts", "我的动态"], ["comments", "评论区"], ["publish", "发朋友圈"], ["publishing", "自动发布"], ["schedule", "定时回复"]]} />
      <WorkspacePanels name="moments" tabs={['posts', 'comments', 'publish', 'publishing', 'schedule']} active={tab}>
      {tab === 'publishing' && <MomentsPublishingPage state={state} status={status} audience={audience} audienceError={audienceError} loadAudience={loadAudience} />}
      {tab === 'posts' && <>
        <div className="wa-moments-toolbar">
          <Button disabled={state.busy || !status.online} onClick={() => state.execute('moments.discover')}>拉取我的动态</Button>
          <details className="wa-moments-lookup"><summary>按编号查找</summary><div className="wa-wb-generator">
          <label>动态编号<input aria-label="朋友圈动态编号" placeholder="原始动态编号" value={lookup} onChange={e => setLookup(e.target.value)} /></label>
          <Button quiet disabled={state.busy || !/^[1-9]\d{0,19}$/.test(lookup)} onClick={async () => {
            if (await state.execute('moments.read', { action: 'detail', postId: lookup })) { setPostId(lookup); setLookup(''); }
          }}>读取动态</Button>
          </div></details>
        </div>
        {posts.length ? <div className="wa-wb-split"><div className="wa-wb-list">{posts.map(item => <button type="button" key={item.id}
          className={'wa-wb-list-item' + (postId === item.id ? ' is-selected' : '')} aria-current={postId === item.id ? 'true' : undefined} onClick={() => { setPostId(item.id); setDeleting(false); }}>
          <small>{stamp(item.createdAt)}{item.deleted ? ' · 已删除' : ''}</small><p style={{ whiteSpace: 'pre-wrap' }}>{item.text || '图片动态'}</p>
          {item.imageCount > 0 && <small>{item.imageCount} 张图片</small>}
        </button>)}</div><div className="wa-wb-card">
          {post ? <><p className="wa-moments-post-text">{post.text || '图片动态'}</p><small>{stamp(post.createdAt)}</small>
            <div className="wa-wb-actions wa-moments-post-actions"><Button disabled={state.busy || post.deleted} onClick={() => loadComments(post.id)}>拉取评论区</Button>
              <Button quiet danger disabled={state.busy || post.deleted} onClick={() => setDeleting(true)}>删除这条朋友圈</Button></div>
            {deleting && <div className="wa-wb-review" role="alert"><p>确认删除这条自己的朋友圈？</p><div className="wa-wb-actions"><Button danger disabled={state.busy} onClick={async () => {
              if (await write({ action: 'delete', postId: post.id })) setDeleting(false);
            }}>确认删除</Button><Button quiet disabled={state.busy} onClick={() => setDeleting(false)}>保留</Button></div></div>}
          </> : <Empty title="选择一条动态">查看原文、拉取评论或删除。</Empty>}
        </div></div> : <Empty title="先拉取我的动态">发布成功的动态也会自动加入这里。</Empty>}
      </>}
      {tab === 'comments' && <div className="wa-wb-card">
        <div className="wa-wb-generator"><label>动态编号<input aria-label="评论区动态编号" value={postId} onChange={e => { setPostId(e.target.value); setComments(null); setReply(null); }} /></label>
          <Button disabled={state.busy || !/^[1-9]\d{0,19}$/.test(postId)} onClick={() => loadComments()}>拉取评论</Button></div>
        {comments && <p className="wa-wb-note">已读取 {comments.items.length} / {comments.visibleCommentEntries} 条可见评论{comments.nextCursor ? ' · 还有下一页' : ''}</p>}
        {!comments && <Empty title="选择一条动态的评论区">从我的动态进入，或填写动态编号拉取评论。</Empty>}
        {comments && !comments.items.length && <Empty title="暂无可见评论">微信当前没有返回这条动态的可见评论。</Empty>}
        {(comments?.items ?? []).map(item => <div className="wa-wb-summary-item" key={item.id ?? item.userId + item.createdAt}>
          <strong>{item.nickname || item.userId}</strong><small> · {item.createdAt ? stamp(item.createdAt) : '时间未知'}{item.replyToCommentId ? ` · 回复 #${item.replyToCommentId}` : ''}{item.deleted ? ' · 已删除' : ''}</small>
          <p style={{ whiteSpace: 'pre-wrap' }}>{item.text}</p><Button quiet disabled={state.busy || item.deleted || !item.id || item.userId === status.account.id}
            onClick={() => { setReply(item); setReplyText(''); }}>回复这条评论</Button>
        </div>)}
        {comments?.nextCursor && <Button quiet disabled={state.busy} onClick={() => loadComments(postId, comments.nextCursor)}>继续拉取评论</Button>}
        {reply && <div className="wa-wb-review"><label>回复 {reply.nickname || reply.userId}<textarea aria-label="评论回复正文" maxLength={2000} value={replyText} onChange={e => setReplyText(e.target.value)} /></label>
          <div className="wa-wb-actions">
          <Button disabled={state.busy || !replyText.trim()} onClick={async () => {
            if (await write({ action: 'comment', postId, replyToCommentId: reply.id, text: replyText })) { setReply(null); setReplyText(''); await loadComments(); }
          }}>发送回复</Button><Button quiet disabled={state.busy} onClick={() => setReply(null)}>取消</Button></div></div>}
      </div>}
      {tab === 'publish' && <div className="wa-wb-card">
        <section className="wa-form-section"><h3>发布内容</h3>
        <label>朋友圈正文<textarea aria-label="朋友圈正文" disabled={state.busy} maxLength={10000} rows={7} value={text} onChange={e => setText(e.target.value)} placeholder="分享一段文字或图片…" /></label>
        <label>图片（可选）<input aria-label="朋友圈图片" type="file" accept="image/png,image/jpeg" multiple disabled={state.busy} onChange={choosePhotos} /></label>
        {fileError && <p role="alert" className="wa-alert is-error">{fileError}</p>}
        {!!photos.length && <div className="wa-moments-photos">{photos.map((photo, index) => <img key={index} src={photo.url} alt={photo.name} />)}</div>}
        <p className="wa-wb-note">支持文字、最多 9 张 PNG/JPEG，每张最多 10 MiB。视频上传尚未接通。</p>
        </section>
        <AudiencePicker data={audience} error={audienceError} labelIds={selection.blockedLabelIds} userIds={selection.blockedUserIds}
          onChange={values => setSelection({ ...selection, ...values })} onRead={loadAudience} busy={state.busy} online={status.online} />
        <div className="wa-form-actions"><span className="wa-help">微信确认后显示发布结果。</span><Button disabled={state.busy || !status.online || (!text.trim() && !photos.length) || !!fileError || preview.missing || hasSelection && audienceError} onClick={async () => {
          const result = await write({ action: 'publish', text, ...(hasSelection ? selection : {}), ...(photos.length ? { images: photos.map(photo => photo.data) } : {}) });
          if (result) { setText(''); setPhotos([]); setSelection({ blockedLabelIds: [], blockedUserIds: [] }); setPostId(result.postId); setTab('posts'); }
        }}>发布到我的朋友圈</Button></div>
      </div>}
      {tab === 'schedule' && <>
        <div className="wa-wb-card"><div className="wa-wb-between"><h2>定时抓取与回复</h2><Tag state={data?.running ? 'running' : data?.settings.enabled ? 'ready' : 'disabled'}>
          {data?.running ? '正在处理' : data?.settings.enabled ? '已开启' : '已关闭'}</Tag></div>
          <p className="wa-wb-note">仅回复本人动态的新评论；跳过已回复内容，结果不明时停止重发。</p>
          <section className="wa-form-section"><h3>处理节奏</h3>
          <label className="wa-wb-check"><input type="checkbox" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />开启自动抓取并由模型回复评论</label>
          <div className="wa-wb-generator">
            {[["intervalMinutes", "抓取间隔（分钟）", 1440], ["lookbackDays", "处理近几天动态", 365], ["maxRepliesPerRun", "每轮最多尝试回复", 50]].map(([field, label, max]) => <label key={field}>{label}
              <input aria-label={label} type="number" min={1} max={max} value={settings[field]} onChange={e => update({ [field]: Number(e.target.value) })} /></label>)}
            <label>处理范围<select aria-label="定时回复范围" value={settings.scope} onChange={e => update({ scope: e.target.value })}>
              <option value="own">当前账号自己的朋友圈</option><option value="selected">仅手动选中的本人动态</option></select></label>
          </div>
          </section>
          <section className="wa-form-section"><h3>回复范围与风格</h3>
          {settings.scope === 'selected' && <div>{posts.filter(post => !post.deleted).map(post => <label className="wa-wb-check" key={post.id}>
            <input type="checkbox" checked={settings.selectedPostIds.includes(post.id)} onChange={e => update({ selectedPostIds: e.target.checked ? [...settings.selectedPostIds, post.id] : settings.selectedPostIds.filter(id => id !== post.id) })} />
            {stamp(post.createdAt)} · {post.text.slice(0, 50) || '图片动态'}</label>)}</div>}
          <label className="wa-wb-check"><input type="checkbox" checked={settings.includeExisting} onChange={e => update({ includeExisting: e.target.checked })} />也回复开启前已存在、尚未回复的评论</label>
          <label>回复风格与要求<textarea aria-label="定时评论回复要求" maxLength={2000} rows={3} value={settings.replyInstructions} onChange={e => update({ replyInstructions: e.target.value })} /></label>
          </section>
          <p className="wa-wb-note">下一次：{data?.nextRunAt ? formatTime(data.nextRunAt) : '未安排'}</p>
          {data?.lastRun && <p>上轮扫描 {data.lastRun.scanned} 条，尝试 {data.lastRun.attempted ?? 0} 条，微信确认 {data.lastRun.replied} 条。</p>}
          {data?.lastError && <p className="wa-alert is-error">{data.lastError}</p>}
          <div className="wa-form-actions"><span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : '更改在保存后生效。'}</span><div className="wa-wb-actions">
          <Button quiet disabled={state.busy || !dirty} onClick={() => { setDirty(false); setSettings(data?.settings ?? { ...MOMENTS_DEFAULTS }); }}>取消更改</Button>
          <Button disabled={state.busy || !dirty} onClick={async () => { if (await state.execute('moments.configure', { settings })) { setDirty(false); state.setNotice('朋友圈定时设置已保存。'); } }}>保存定时设置</Button>
          </div></div>
        </div>
        <div className="wa-wb-card" style={{ marginTop: 16 }}><h2>评论回复记录</h2>{(data?.replies ?? []).length ? data.replies.map(row => <div className="wa-wb-summary-item" key={row.postId + ':' + row.commentId}>
          <div className="wa-wb-between"><strong>{row.author || `评论 #${row.commentId}`}</strong><Tag state={row.state}>{replyLabels[row.state]}</Tag></div><p>{row.commentText}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{row.text}</p>{row.error && <p className="wa-wb-note">{row.error}</p>}<small>{formatTime(row.updatedAt)} · 动态 {row.postId}</small>
        </div>) : <p className="wa-wb-note">尚无记录。自动回复默认关闭，保存开启后按周期处理。</p>}</div>
      </>}
      </WorkspacePanels>
    </Offline>
  </section>;
}
