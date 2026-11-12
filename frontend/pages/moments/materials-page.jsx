import { AutomationLink } from '../../components/automation-link.jsx';
import { CleanupControl } from '../../components/cleanup-control.jsx';
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Feedback, Tag } from '../../components/workbench-ui.jsx';
import { PageHead } from '../../components/page-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { formatTime } from '../../shared/conversations.mjs';
import { localDate as localDateInput } from '../../shared/local-date.mjs';
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

const blank = () => ({ title: '', text: '', url: '', enabled: true, expiresAt: null, imageUse: 'publish', imageOrigin: 'unknown' });
const fieldsOf = item => Object.fromEntries(Object.keys(blank()).map(key => [key, item[key]]));
const jobLabels = { reading: '正在读取新增记忆', organizing: '正在整理素材', reviewing: '正在检查公开性' };
function MaterialImage({ item, accountId, rpc }) {
  const api = useRef(rpc), [url, setUrl] = useState(''), [error, setError] = useState(''); api.current = rpc;
  useEffect(() => {
    if (!item.image) return;
    const controller = new AbortController(); setUrl(''); setError('');
    api.current('moments.materials.image', { accountId, id: item.id }, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
      .then(image => { if (!controller.signal.aborted) setUrl('data:' + image.mediaType + ';base64,' + image.data); })
      .catch(() => { if (!controller.signal.aborted) setError('图片暂不可用'); });
    return () => controller.abort();
  }, [item.id, item.revision, accountId]);
  return url ? <img className="wa-material-thumbnail" src={url} alt={item.title} /> : <span className="wa-wb-note">{error || '正在读取图片…'}</span>;
}
export function MomentsMaterialsPage({ rpc, status, embedded = false, onNavigate }) {
  const accountId = status.account?.id, state = useWorkbench(rpc, accountId, 'moments.materials.list', '', 3000, status.timeSettings);
  const data = state.data;
  const [editor, setEditor] = useState(null), [imageData, setImageData] = useState(null), [recognize, setRecognize] = useState(true);
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [page, setPage] = useState(0), [removeId, setRemoveId] = useState(null), [error, setError] = useState('');
  const [selectedItems, setSelectedItems] = useState([]);
  const operations = useRef({}), uploader = useRef(null), busy = state.busy;
  useEffect(() => setPage(0), [filter, search]);
  const items = (data?.items || []).filter(item => (filter === 'all' || filter === 'available' && item.selectable || filter === 'used' && item.uses.length || filter === 'inactive' && !item.available) &&
    (!search.trim() || (item.title + ' ' + item.text).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const pages = Math.max(1, Math.ceil(items.length / 12)), currentPage = Math.min(page, pages - 1);
  const open = item => { setEditor(item ? { id: item.id, revision: item.revision, fields: fieldsOf(item), kind: item.kind } : { fields: blank(), kind: 'text' }); setImageData(null); setError(''); };
  const edit = patch => setEditor(value => ({ ...value, fields: { ...value.fields, ...patch } }));
  const execute = async (method, payload) => {
    const signature = JSON.stringify(payload), prior = operations.current[method];
    if (prior?.signature !== signature) operations.current[method] = { signature, requestId: 'material-' + crypto.randomUUID() };
    const value = await state.execute(method, { ...payload, requestId: operations.current[method].requestId });
    if (value) delete operations.current[method]; else {
      const latest = await state.refresh(true);
      if (method === 'moments.materials.organize' && ['failed', 'interrupted'].includes(latest?.lastRun?.state)) delete operations.current[method];
    }
    return value;
  };
  const upload = async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024) { setError('请选择 PNG/JPEG 图片，每张最多 10 MiB。'); return; }
    try {
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
      setEditor({ kind: 'image', fields: { ...blank(), title: file.name.replace(/\.[^.]+$/, '').slice(0, 80) } }); setImageData(base64); setError('');
    } catch { setError('图片读取失败，请重新选择。'); }
  };
  const save = async () => {
    const value = await execute('moments.materials.save', { ...editor, kind: undefined, ...(imageData ? { imageData } : {}) });
    if (!value) return;
    setEditor(null); setImageData(null); state.setNotice('素材已保存，可以在朋友圈生成时选用。');
    if (value.kind === 'image' && !value.text && recognize) {
      const described = await state.execute('moments.materials.describe', { id: value.id, revision: value.revision });
      if (described) state.setNotice('图片与内容描述已保存。');
    }
  };
  const stop = async () => {
    try { await rpc('moments.materials.cancel', { accountId }, AbortSignal.timeout(10000)); }
    catch { setError('取消请求暂未确认，请刷新素材状态。'); }
  };
  return <section className="wa-wb-page wa-moments-materials" data-testid="moments-materials">
    {!embedded && <PageHead icon="moments" title="朋友圈素材库" description="留下随手记、图片和聊天带来的想法，让内容慢慢积累。" />}
    <Feedback state={state} />
    {(error || data?.error || state.refreshError) && <p className="wa-alert is-error" role="alert">{error || data?.error || state.refreshError}</p>}
    <div className="wa-wb-card">
      <div className="wa-wb-between"><div><h2>留下点什么</h2><p className="wa-wb-note">素材独立保留，生成朋友圈时再挑选。停用、过期和已用版本不会自动重复选用。</p></div>
        <div className="wa-wb-actions"><Button disabled={busy || !accountId} onClick={() => open()}>记一条素材</Button><Button quiet disabled={busy || !accountId} onClick={() => uploader.current?.click()}>上传图片素材</Button>
          <input ref={uploader} hidden aria-label="上传朋友圈素材图片" type="file" accept="image/png,image/jpeg" onChange={upload} /></div></div>
      <div className="wa-wb-actions">
        <AutomationLink onNavigate={onNavigate} from={embedded ? 'moments' : 'assets'} section="moments-materials">取材与自动整理设置</AutomationLink>
        <Button quiet disabled={busy || data?.running || !data?.settings.sources.length || !status.online} onClick={() => execute('moments.materials.organize', {})}>整理一次素材</Button>
      </div>
      <p className="wa-wb-note">取材会话、自动整理和图片获取开关统一在“设置 → 自动功能”中管理。</p>
      {data?.running && <div className="wa-wb-between"><p role="status">{data.runningKind === 'describe' ? '正在识别图片，达到设定超时后停止。' : data.runningKind === 'generate' ? '正在生成并识别图片素材，达到设定超时后停止。' : data.runningKind === 'download' ? '正在下载图片素材，达到设定超时后停止。' : (jobLabels[data.lastRun?.stage] || '正在整理素材') + '，达到设定超时后停止；离开页面后仍会继续。'}</p><Button quiet onClick={stop}>停止素材处理</Button></div>}
      {data?.lastRun && data.lastRun.state !== 'running' && <p className="wa-wb-note" role="status">{data.lastRun.state === 'done' ? `最近整理：新增 ${data.lastRun.added} 条，更新 ${data.lastRun.updated} 条${data.lastRun.rejected ? `，${data.lastRun.rejected} 条未通过公开性检查` : ''}。` : data.lastRun.state === 'empty' ? '没有新的聊天内容可整理。' : data.lastRun.error}</p>}
      {data?.settings.enabled && <small className="wa-schedule-time"><span>下次整理：{data.nextRunAt ? formatTime(data.nextRunAt) : '等待安排'}</span>
        <ScheduleCountdown at={data.nextRunAt} running={data.running} paused={data.error || !data.settings.sources.length} status={status} action="整理" /></small>}
    </div>
    {editor && <div className="wa-wb-card" data-testid="material-editor"><h2>{editor.id ? '编辑素材' : editor.kind === 'image' ? '添加图片素材' : '记一条素材'}</h2>
      <fieldset disabled={busy}>
        <label>标题<input aria-label="朋友圈素材标题" maxLength={80} value={editor.fields.title} onChange={event => edit({ title: event.target.value })} /></label>
        <label>{editor.kind === 'image' ? '图片描述或想说的话' : '留下的内容'}<textarea aria-label="朋友圈素材内容" rows={5} maxLength={2000} value={editor.fields.text} onChange={event => edit({ text: event.target.value })} placeholder="可以是一句随手记、一个问题、一个有趣的角度，不必写成完整文案。" /></label>
        <label>公开来源链接（可选）<input aria-label="朋友圈素材来源链接" maxLength={2048} value={editor.fields.url} onChange={event => edit({ url: event.target.value })} /></label>
        <label>有效期（可留空，长期保留）<input aria-label="朋友圈素材有效期" type="datetime-local" value={editor.fields.expiresAt ? localDateInput(editor.fields.expiresAt) : ''} onChange={event => edit({ expiresAt: event.target.value ? new Date(event.target.value).getTime() : null })} /></label>
        {editor.kind === 'image' && <>
          <label>图片来源<select aria-label="朋友圈图片来源" value={editor.fields.imageOrigin} onChange={event => edit({ imageOrigin: event.target.value })}><option value="unknown">来源未注明</option><option value="photo">真实照片</option><option value="artwork">收藏或创作的作品</option><option value="ai">AI 生成图片</option></select></label>
          <label>图片用途<select aria-label="朋友圈图片用途" value={editor.fields.imageUse} onChange={event => edit({ imageUse: event.target.value })}><option value="publish">可作为朋友圈配图</option><option value="reference">仅作灵感参考，不发布原图</option></select></label>
          <p className="wa-wb-note">标为可发布的图片会进入自动选图范围，请确认画面适合公开。</p>
          {!editor.fields.text && <label className="wa-wb-check"><input type="checkbox" checked={recognize} onChange={event => setRecognize(event.target.checked)} />保存后识别图片内容；也可以手动补充描述</label>}
        </>}
        <label className="wa-wb-check"><input aria-label="启用朋友圈素材" type="checkbox" checked={editor.fields.enabled} onChange={event => edit({ enabled: event.target.checked })} />允许生成朋友圈时选用</label>
      </fieldset>
      <div className="wa-wb-actions"><Button disabled={busy || !editor.fields.title.trim()} onClick={save}>保存朋友圈素材</Button><Button quiet disabled={busy} onClick={() => { setEditor(null); setImageData(null); }}>取消素材编辑</Button></div>
    </div>}
    <div className="wa-wb-card"><div className="wa-wb-between"><h2>素材 · {data?.items?.length || 0}</h2><CleanupControl key={accountId} state={state} kind="moments.materials" label="清空素材库" onDone={() => { setSelectedItems([]); setEditor(null); }} /><div className="wa-wb-actions">
      <input aria-label="搜索朋友圈素材" placeholder="搜索素材" value={search} onChange={event => setSearch(event.target.value)} />
      <select aria-label="筛选朋友圈素材" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部素材</option><option value="available">可选用</option><option value="used">已使用</option><option value="inactive">停用或过期</option></select></div></div>
      {!!selectedItems.length && <CleanupControl state={state} kind="moments.materials" ids={selectedItems} label={`删除选中 ${selectedItems.length} 条素材`} onDone={() => { setSelectedItems([]); setEditor(null); }} />}
      {items.length ? <div className="wa-material-grid">{items.slice(currentPage * 12, currentPage * 12 + 12).map(item => <article className="wa-material-card" key={item.id} data-material-id={item.id}>
        <label className="wa-wb-check"><input type="checkbox" aria-label={"选择素材 " + item.title} checked={selectedItems.includes(item.id)} onChange={event => setSelectedItems(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} />选择素材</label>
        {item.image && <MaterialImage item={item} accountId={accountId} rpc={rpc} />}
        <div className="wa-wb-between"><strong>{item.title}</strong><Tag state={item.selectable ? 'ready' : 'disabled'}>{!item.available ? '暂不使用' : item.usedCurrentVersion ? '此内容已使用' : !item.text ? '待补充描述' : '可选用'}</Tag></div>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text || '补充描述后即可参与选图。'}</p>
        <small>{item.origin === 'chat' ? '聊天整理' : item.origin === 'web' ? '网络图片' : item.origin === 'generated' ? 'AI 生成图片' : '手动添加'} · {formatTime(item.updatedAt)}{item.image ? item.imageUse === 'reference' ? ' · 仅供参考' : ' · 可发布图片' : ''}</small>
        {item.generatedSource && <p className="wa-wb-note">{item.generatedSource.providerName} · {item.generatedSource.model}</p>}
        {!!item.sources.length && <details><summary>取材来源（仅自己可见）</summary>{item.sources.map(source => <p key={materialSourceKey(source)}>{source.name} · {formatTime(source.at)}</p>)}</details>}
        {!!item.uses.length && <details><summary>使用过 {item.uses.length} 次</summary>{item.uses.map(use => <p key={use.runId}>{formatTime(use.at)} · 已确认发布</p>)}</details>}
        {item.expiresAt && <p className="wa-wb-note">有效期至 {formatTime(item.expiresAt)}</p>}
        {item.url && <a href={item.url} target="_blank" rel="noreferrer">查看公开来源</a>}
        <div className="wa-wb-actions"><Button quiet disabled={busy} onClick={() => open(item)}>编辑素材</Button>
          <Button quiet disabled={busy} onClick={() => execute('moments.materials.save', { id: item.id, revision: item.revision, fields: { ...fieldsOf(item), enabled: !item.enabled } })}>{item.enabled ? '暂不使用' : '启用素材'}</Button>
          {item.image && <Button quiet disabled={busy || data?.running || !status.online} onClick={() => state.execute('moments.materials.describe', { id: item.id, revision: item.revision })}>识别图片内容</Button>}
          <Button quiet danger disabled={busy} onClick={() => setRemoveId(item.id)}>删除素材</Button></div>
        {removeId === item.id && <div role="alert"><p>删除后不会从同一段聊天重新整理出来，已有发布记录保留。</p><div className="wa-wb-actions"><Button danger disabled={busy} onClick={async () => { if (await state.execute('moments.materials.delete', { id: item.id, revision: item.revision })) setRemoveId(null); }}>确认删除素材</Button><Button quiet onClick={() => setRemoveId(null)}>保留素材</Button></div></div>}
      </article>)}</div> : <Empty title="还没有这样的素材">先记下一句话、上传一张图片，或选择聊天整理一次。</Empty>}
      {pages > 1 && <div className="wa-wb-actions"><Button quiet disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage + 1} / {pages}</span><Button quiet disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
    </div>
  </section>;
}
