import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Feedback, Offline, Tag } from '../../components/workbench-ui.jsx';
import { PageHead } from '../../components/page-ui.jsx';
import { WorkspaceTabs, WorkspacePanels } from '../../components/workspace-tabs.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { formatTime } from '../../shared/conversations.mjs';
import { AudiencePicker, audiencePreview } from './audience-picker.jsx';
import { MomentsPublishingPage } from './publishing-page.jsx';
import { MomentsMaterialsPage } from './materials-page.jsx';
import { MomentsFriendsPage } from './friends-page.jsx';
import { MomentsInteractionsPage } from './interactions-page.jsx';
import { MomentsReplySchedule } from './reply-schedule.jsx';
import { Glyph } from '../../components/glyph.jsx';
const stamp = seconds => formatTime(seconds * 1000);

export function MomentsPage({ rpc, status, onNavigate }) {
  return <MomentsWorkspace key={status.account?.id ?? 'offline'} rpc={rpc} status={status} onNavigate={onNavigate} />;
}
function MomentsWorkspace({ rpc, status, onNavigate }) {
  const [interactionPost, setInteractionPost] = useState(null);
  const [tab, setTab] = useState('posts'), [postId, setPostId] = useState(''), [lookup, setLookup] = useState(''),
    [comments, setComments] = useState(null), [reply, setReply] = useState(null), [replyText, setReplyText] = useState(''),
    [text, setText] = useState(''), [photos, setPhotos] = useState([]),
    [deleting, setDeleting] = useState(false), [fileError, setFileError] = useState('');
  const state = useWorkbench(rpc, status.account?.id, 'moments.list', '', ['publishing', 'schedule'].includes(tab) ? 3000 : 0, status.timeSettings);
  const [audience, setAudience] = useState(null), [audienceError, setAudienceError] = useState(false),
    [selection, setSelection] = useState({ blockedLabelIds: [], blockedUserIds: [] });
  const [publishScope, setPublishScope] = useState('blocked-list'), [scopeSaving, setScopeSaving] = useState(false),
    [scopeSaved, setScopeSaved] = useState(false), [scopeError, setScopeError] = useState('');
  const [defaultBlocks, setDefaultBlocks] = useState({ blockedLabelIds: [], blockedUserIds: [] }),
    [defaultSaving, setDefaultSaving] = useState(false), [defaultNotice, setDefaultNotice] = useState(''), [defaultError, setDefaultError] = useState('');
  const api = useRef(rpc); api.current = rpc;
  useEffect(() => {
    const accountId = status.account?.id;
    if (!accountId) return;
    let live = true;
    api.current('moments.publishScope', { accountId }, AbortSignal.timeout(15000)).then(value => {
      if (live && value?.scope) setPublishScope(value.scope);
    }).catch(() => { if (live) setScopeError('可见范围读取失败，请刷新后重试；发布时会按原来的范围执行。'); });
    return () => { live = false; };
  }, [status.account?.id]);
  useEffect(() => {
    if (!scopeSaved) return;
    const timer = setTimeout(() => setScopeSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [scopeSaved]);
  const choosePublishScope = async scope => {
    if (scope === publishScope || scopeSaving) return;
    const previous = publishScope;
    setPublishScope(scope); setScopeSaving(true); setScopeError(''); setScopeSaved(false);
    try {
      const value = await api.current('moments.publishScope', { accountId: status.account.id, scope }, AbortSignal.timeout(15000));
      if (!value?.scope) throw Error('可见范围未确认保存');
      setPublishScope(value.scope); setScopeSaved(true);
    } catch (error) {
      setPublishScope(previous); setScopeError((error.message || '可见范围保存失败') + '，仍使用原来的范围。');
    } finally { setScopeSaving(false); }
  };
  const preview = audiencePreview(audience, selection.blockedLabelIds, selection.blockedUserIds);
  const hasSelection = selection.blockedLabelIds.length + selection.blockedUserIds.length > 0;
  const loadAudience = async () => {
    const value = await state.execute('moments.audience', {}, false);
    if (value) { setAudience(value); setAudienceError(false); } else setAudienceError(true);
  };
  const hasDefault = defaultBlocks.blockedLabelIds.length + defaultBlocks.blockedUserIds.length > 0;
  // 账号级默认屏蔽名单只预填这一次的勾选，发布时仍以页面选择为准。
  useEffect(() => {
    const accountId = status.account?.id;
    if (!accountId) return;
    let live = true;
    api.current('moments.audienceDefault', { accountId }, AbortSignal.timeout(15000)).then(value => {
      if (!live || !value) return;
      const defaults = { blockedLabelIds: [...(value.blockedLabelIds ?? [])], blockedUserIds: [...(value.blockedUserIds ?? [])] };
      setDefaultBlocks(defaults);
      setSelection(current => current.blockedLabelIds.length || current.blockedUserIds.length ? current : defaults);
      if (defaults.blockedLabelIds.length || defaults.blockedUserIds.length) void loadAudience();
    }).catch(() => { if (live) setDefaultError('默认屏蔽名单读取失败，请刷新后重试；本次仍按页面上勾选的范围发布。'); });
    return () => { live = false; };
  }, [status.account?.id]);
  useEffect(() => {
    if (!defaultNotice) return;
    const timer = setTimeout(() => setDefaultNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [defaultNotice]);
  const writeDefault = async (selectionIds, done) => {
    if (defaultSaving) return;
    setDefaultSaving(true); setDefaultNotice(''); setDefaultError('');
    try {
      const value = await api.current('moments.audienceDefault', { accountId: status.account.id, ...selectionIds }, AbortSignal.timeout(15000));
      if (!value) throw Error('默认名单未确认保存');
      setDefaultBlocks({ blockedLabelIds: [...(value.blockedLabelIds ?? [])], blockedUserIds: [...(value.blockedUserIds ?? [])] });
      setDefaultNotice(done);
    } catch (error) {
      setDefaultError((error.message || '默认名单保存失败') + '，本次勾选仍会用于这一次发布。');
    } finally { setDefaultSaving(false); }
  };
  const saveDefault = () => writeDefault({ blockedUserIds: selection.blockedUserIds, blockedLabelIds: selection.blockedLabelIds }, '已保存为默认名单');
  const clearDefault = () => writeDefault({ blockedUserIds: [], blockedLabelIds: [] }, '已清除默认名单');
  const operation = useRef(null), liveState = useRef(state); liveState.current = state;
  const data = state.data, posts = data?.posts ?? [], post = posts.find(post => post.id === postId);
  useEffect(() => { const timer = setInterval(() => { if (!liveState.current.busy) void liveState.current.refresh(); }, 15000); return () => clearInterval(timer); }, []);
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
    <PageHead icon="moments" title="朋友圈" description="读好友动态，点赞、评论，也分享自己的生活。"><Button quiet disabled={state.busy} onClick={state.refresh}>刷新状态</Button></PageHead>
    <Feedback state={state} />
    <Offline status={status}>
      {!status.online && <p className="wa-alert is-error">微信未连接，发布和定时回复暂不执行。</p>}
      {data?.error && <p className="wa-alert is-error">{data.error}</p>}
      <WorkspaceTabs name="moments" label="朋友圈功能" active={tab} onChange={setTab}
        tabs={[["posts", "我的动态"], ["friends", "好友动态"], ["interactions", "点赞评论"], ["comments", "评论区"], ["publish", "发朋友圈"], ["publishing", "自动发布"], ["materials", "素材库"], ["schedule", "定时回复"]]} />
      <WorkspacePanels name="moments" tabs={['posts', 'friends', 'interactions', 'comments', 'publish', 'publishing', 'materials', 'schedule']} active={tab}>
      {tab === 'friends' && <MomentsFriendsPage key={status.account?.id} rpc={rpc} status={status} onNavigate={onNavigate} onComments={loadComments}
        onInteract={post => { setInteractionPost({ postId: post.id, key: crypto.randomUUID() }); setTab('interactions'); }} />}
      {tab === 'interactions' && <MomentsInteractionsPage key={status.account?.id} rpc={rpc} status={status} onNavigate={onNavigate} initialPost={interactionPost} onSeedUsed={() => setInteractionPost(null)} onComments={loadComments} />}
      {tab === 'materials' && <MomentsMaterialsPage rpc={rpc} status={status} embedded onNavigate={onNavigate} />}
      {tab === 'publishing' && <MomentsPublishingPage rpc={rpc} state={state} status={status} audience={audience} audienceError={audienceError} loadAudience={loadAudience} onNavigate={onNavigate}
        defaultAudience={defaultBlocks} onEditAudience={() => setTab('publish')} />}
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
        {posts.length ? <div className="wa-wb-split wa-moments-post-workspace"><div className="wa-wb-list wa-moments-feed"><div className="wa-index-heading"><h2>我的动态</h2><span>{posts.length}</span></div>{posts.map(item => <button type="button" key={item.id}
          className={'wa-wb-list-item' + (postId === item.id ? ' is-selected' : '')} aria-current={postId === item.id ? 'true' : undefined} onClick={() => { setPostId(item.id); setDeleting(false); }}>
          <small>{stamp(item.createdAt)}{item.deleted ? ' · 已删除' : item.readFailure ? ' · 暂不可读取' : ''}</small><p style={{ whiteSpace: 'pre-wrap' }}>{item.text || '图片动态'}</p>
          {item.imageCount > 0 && <small>{item.imageCount} 张图片</small>}
        </button>)}</div><div className="wa-moments-detail">
          {post ? <><header className="wa-moments-post-heading"><span className="wa-moments-avatar"><Glyph name="person" /></span><div><strong>{status.account.nickname || '当前账号'}</strong><time>{stamp(post.createdAt)}</time></div>{post.deleted && <Tag state="disabled">已删除</Tag>}</header><p className="wa-moments-post-text">{post.text || '图片动态'}</p>
            {!post.deleted && post.readFailure && <p className="wa-wb-note">这条动态暂时无法读取，自动检查已跳过。可以点击“拉取评论区”重新读取。</p>}
            <div className="wa-wb-actions wa-moments-post-actions"><Button disabled={state.busy || post.deleted} onClick={() => loadComments(post.id)}>拉取评论区</Button>
              <Button quiet danger disabled={state.busy || post.deleted} onClick={() => setDeleting(true)}>删除这条朋友圈</Button></div>
            {deleting && <div className="wa-wb-review" role="alert"><p>确认删除这条自己的朋友圈？</p><div className="wa-wb-actions"><Button danger disabled={state.busy} onClick={async () => {
              if (await write({ action: 'delete', postId: post.id })) setDeleting(false);
            }}>确认删除</Button><Button quiet disabled={state.busy} onClick={() => setDeleting(false)}>保留</Button></div></div>}
          </> : <Empty title="选择一条动态">查看原文、拉取评论或删除。</Empty>}
        </div></div> : <Empty title="先拉取我的动态">发布成功的动态也会自动加入这里。</Empty>}
      </>}
      {tab === 'comments' && <div className="wa-moments-comments">
        <div className="wa-wb-generator"><label>动态编号<input aria-label="评论区动态编号" value={postId} onChange={e => { setPostId(e.target.value); setComments(null); setReply(null); }} /></label>
          <Button disabled={state.busy || !/^[1-9]\d{0,19}$/.test(postId)} onClick={() => loadComments()}>拉取评论</Button></div>
        {comments && <p className="wa-wb-note">已读取 {comments.items.length} / {comments.visibleCommentEntries} 条可见评论{comments.nextCursor ? ' · 还有下一页' : ''}</p>}
        {!comments && <Empty title="选择一条动态的评论区">从好友动态或我的动态进入，也可以填写动态编号。</Empty>}
        {comments && !comments.items.length && <Empty title="暂无可见评论">微信当前没有返回这条动态的可见评论。</Empty>}
        {(comments?.items ?? []).map(item => <div className="wa-wb-summary-item wa-moments-comment" key={item.id ?? item.userId + item.createdAt}>
          <div className="wa-moments-comment-heading"><strong>{item.nickname || item.userId}</strong><small>{item.createdAt ? stamp(item.createdAt) : '时间未知'}{item.replyToCommentId ? ` · 回复 #${item.replyToCommentId}` : ''}{item.deleted ? ' · 已删除' : ''}</small></div>
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
      {tab === 'publish' && <div className="wa-moments-composer wa-automation-editor">
        <section className="wa-form-section"><h3>发布内容</h3>
        <label>朋友圈正文<textarea aria-label="朋友圈正文" disabled={state.busy} maxLength={10000} rows={7} value={text} onChange={e => setText(e.target.value)} placeholder="分享一段文字或图片…" /><span className="wa-composer-count">{text.length.toLocaleString()} / 10,000</span></label>
        <label>图片（可选）<input aria-label="朋友圈图片" type="file" accept="image/png,image/jpeg" multiple disabled={state.busy} onChange={choosePhotos} /></label>
        {fileError && <p role="alert" className="wa-alert is-error">{fileError}</p>}
        {!!photos.length && <div className="wa-moments-photos">{photos.map((photo, index) => <figure key={photo.name + index}><img src={photo.url} alt={photo.name} /><figcaption><span>{photo.name}</span><Button quiet disabled={state.busy} aria-label={'移除图片 ' + photo.name} onClick={() => setPhotos(photos.filter((_, position) => position !== index))}>移除</Button></figcaption></figure>)}</div>}
        <p className="wa-wb-note">支持文字、最多 9 张 PNG/JPEG，每张最多 10 MiB。视频上传尚未接通。</p>
        </section>
        <section className="wa-form-section" data-testid="moments-publish-scope">
          <h3>可见范围</h3>
          <div className="wa-moments-publish-scope" role="radiogroup" aria-label="可见范围">
            <label className="wa-wb-check"><input type="radio" name="moments-publish-scope" value="blocked-list"
              checked={publishScope === 'blocked-list'} disabled={scopeSaving || state.busy || !status.online}
              onChange={() => choosePublishScope('blocked-list')} /><span>自定义屏蔽名单（默认）</span></label>
            <label className="wa-wb-check"><input type="radio" name="moments-publish-scope" value="authorized"
              checked={publishScope === 'authorized'} disabled={scopeSaving || state.busy || !status.online}
              onChange={() => choosePublishScope('authorized')} /><span>仅授权好友可见</span></label>
          </div>
          <p className="wa-wb-note">自定义屏蔽名单（默认）：只屏蔽名单里的标签与联系人；名单为空时好友都可见。</p>
          <p className="wa-wb-note">仅授权好友可见：自动屏蔽所有未授权好友，只有已授权会话的好友能看到。</p>
          <p className={scopeError ? 'wa-alert is-error' : 'wa-help'} role={scopeError ? 'alert' : undefined} aria-live="polite">
            {scopeSaving ? '正在保存可见范围…' : scopeError || (scopeSaved ? '已保存，下次发布生效。' : '切换后立即保存，只影响这个微信账号。')}
          </p>
        </section>
        <AudiencePicker heading="屏蔽名单" data={audience} error={audienceError} labelIds={selection.blockedLabelIds} userIds={selection.blockedUserIds}
          onChange={values => setSelection({ ...selection, ...values })} onRead={loadAudience} busy={state.busy} online={status.online} />
        <div className="wa-moments-default-audience" data-testid="moments-default-audience">
          <p className="wa-wb-note">勾选即生效，只对这一次发布有效。</p>
          <div className="wa-wb-actions">
            <Button quiet disabled={state.busy || !status.online || defaultSaving} onClick={saveDefault}>保存为默认名单</Button>
            <Button quiet disabled={state.busy || !status.online || defaultSaving || !hasDefault} onClick={clearDefault}>清除默认名单</Button>
            <span className="wa-help" aria-live="polite">{defaultSaving ? '正在保存默认名单…' : defaultNotice ||
              `当前默认名单：${defaultBlocks.blockedLabelIds.length} 个标签、${defaultBlocks.blockedUserIds.length} 位联系人。`}</span>
          </div>
          {defaultError && <p role="alert" className="wa-alert is-error">{defaultError}</p>}
        </div>
        <div className="wa-form-actions"><span className="wa-help">微信确认后显示发布结果。</span><Button disabled={state.busy || !status.online || (!text.trim() && !photos.length) || !!fileError || preview.missing || hasSelection && audienceError} onClick={async () => {
          const result = await write({ action: 'publish', text, ...(hasSelection ? selection : {}), ...(photos.length ? { images: photos.map(photo => photo.data) } : {}) });
          if (result) { setText(''); setPhotos([]); setSelection({ blockedLabelIds: [], blockedUserIds: [] }); setPostId(result.postId); setTab('posts'); }
        }}>发布到我的朋友圈</Button></div>
      </div>}
      {tab === 'schedule' && <MomentsReplySchedule state={state} status={status} onNavigate={onNavigate} />}
      </WorkspacePanels>
    </Offline>
  </section>;
}
