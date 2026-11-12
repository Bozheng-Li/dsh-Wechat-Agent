import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/button.jsx';
import { PageHead } from '../../components/page-ui.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { StickerControls } from './sticker-controls.jsx';
import { AutomationLink } from '../../components/automation-link.jsx';

const kinds = { sticker: '表情包', image: '图片' };
const empty = {
  items: [],
  packs: [],
  total: 0,
  counts: { all: 0, enabled: 0, described: 0, bytes: 0, favorites: 0, collected: 0 },
  settings: { enabled: true, probability: 20, minGapMessages: 3 },
  progress: null,
};
const size = (bytes) =>
  !bytes ? '0 B' : bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MiB' : Math.max(1, Math.ceil(bytes / 1024)) + ' KiB';
const tagsFromText = (text) => [
  ...new Set(
    text
      .split(/[,，\n]/u)
      .map((value) => value.trim())
      .filter(Boolean)
  ),
];
const metadata = (asset) => ({
  name: asset.name,
  description: asset.description,
  usage: asset.usage || '',
  tags: asset.tags.join('，'),
  kind: asset.kind,
  enabled: asset.enabled,
});
function Field({ title, children, help }) {
  return (
    <label className="wa-assets-field">
      <span>{title}</span>
      {children}
      {help && <small className="wa-help">{help}</small>}
    </label>
  );
}
function encoded(bytes) {
  let value = '';
  for (let at = 0; at < bytes.length; at += 16384) value += String.fromCharCode(...bytes.subarray(at, at + 16384));
  return btoa(value);
}
function dataUrl(value) {
  if (
    !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value?.mediaType) ||
    typeof value.data !== 'string'
  )
    throw new Error('图片预览数据无效');
  return 'data:' + value.mediaType + ';base64,' + value.data;
}

export function MediaLibraryPage({ rpc, status, onNavigate }) {
  const accountId = status.account?.id;
  const [data, setData] = useState(empty),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState(''),
    [source, setSource] = useState(''),
    [packId, setPackId] = useState(''),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(new Set()),
    [thumbnails, setThumbnails] = useState({}),
    [editing, setEditing] = useState(null),
    [preview, setPreview] = useState(''),
    [previewError, setPreviewError] = useState('');
  const [draft, setDraft] = useState(null),
    [importKind, setImportKind] = useState('sticker');
  const [busy, setBusy] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [upload, setUpload] = useState(null),
    [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef(null),
    dialogRef = useRef(null),
    busyRef = useRef(busy),
    active = useRef(null),
    mounted = useRef(true),
    previewCache = useRef(new Map()),
    previewSignatures = useRef(new Map()),
    currentAccount = useRef(accountId);
  busyRef.current = busy;
  currentAccount.current = accountId;
  const request = (endpoint, payload = {}, signal) => rpc(endpoint, { accountId, ...payload }, signal);
  const reload = async (signal) => {
    if (!accountId) return;
    const result = await request(
      'assets.list',
      { query, kind: kind || undefined, packId: packId || undefined, source: source || undefined, offset, limit: 24 },
      signal
    );
    if (!mounted.current || signal?.aborted || currentAccount.current !== accountId) return;
    setData((previous) => (previous.revision > result.revision ? previous : result));
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    setData(empty);
    setSelected(new Set());
    setEditing(null);
    setDraft(null);
    setThumbnails({});
    previewCache.current.clear();
    previewSignatures.current.clear();
    setOffset(0);
    setPackId('');
    setSource('');
    setBusy('');
    setNotice('');
    setError('');
    setUpload(null);
    setConfirmDelete(false);
    active.current?.abort();
  }, [accountId]);
  useEffect(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, [query, kind, packId, source]);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        await reload(controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 100);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [accountId, query, kind, packId, source, offset]);
  useEffect(() => {
    const controller = new AbortController(),
      missing = data.items.filter(
        (asset) =>
          asset.bytes > 0 && previewSignatures.current.get(asset.id) !== (asset.contentSha256 || asset.id) + ':' + asset.bytes
      );
    void (async () => {
      for (let at = 0; at < missing.length && !controller.signal.aborted; at += 4) {
        await Promise.all(
          missing.slice(at, at + 4).map(async (asset) => {
            try {
              const url = dataUrl(await request('assets.thumbnail', { assetId: asset.id }, controller.signal));
              if (!controller.signal.aborted && currentAccount.current === accountId) {
                previewCache.current.set(asset.id, url);
                previewSignatures.current.set(asset.id, (asset.contentSha256 || asset.id) + ':' + asset.bytes);
                setThumbnails((value) => ({ ...value, [asset.id]: url }));
              }
            } catch {
              if (!controller.signal.aborted) previewSignatures.current.set(asset.id, (asset.contentSha256 || asset.id) + ':' + asset.bytes);
            }
          })
        );
      }
    })();
    return () => controller.abort();
  }, [accountId, data.items.map((asset) => asset.id + ':' + asset.bytes + ':' + asset.contentSha256).join(',')]);
  useEffect(() => {
    if (!editing) {
      setPreview('');
      return;
    }
    const controller = new AbortController();
    setPreview(previewCache.current.get(editing.id) || '');
    setPreviewError('');
    void request('assets.content', { assetId: editing.id }, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setPreview(dataUrl(value));
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setPreviewError(failure.message);
        });
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || [])]
      .filter(element => element.getClientRects().length);
    (focusable()[0] || dialog)?.focus();
    const key = (event) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        setEditing(null);
      }
      if (event.key === 'Tab') {
        const elements = focusable(), first = elements[0], last = elements.at(-1);
        if (!elements.length) { event.preventDefault(); dialog?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const keepFocus = (event) => {
      if (dialog && !dialog.contains(event.target)) (focusable()[0] || dialog).focus();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', keepFocus);
    return () => {
      controller.abort();
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', keepFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector('[data-testid="nav-assets"]')?.focus();
    };
  }, [editing?.id, accountId]);
  const act = async (endpoint, payload, message) => {
    if (busyRef.current) return false;
    busyRef.current = endpoint;
    const controller = new AbortController();
    active.current = controller;
    setBusy(endpoint);
    setError('');
    setNotice('');
    try {
      const result = await request(endpoint, payload, controller.signal);
      await reload();
      if (mounted.current && currentAccount.current === accountId)
        setNotice(typeof message === 'function' ? message(result) : message);
      return !controller.signal.aborted && currentAccount.current === accountId;
    } catch (failure) {
      if (mounted.current && currentAccount.current === accountId)
        setError(controller.signal.aborted ? '操作已停止，已保存的结果会保留。' : failure.message);
      return false;
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current && currentAccount.current === accountId) { busyRef.current = ''; setBusy(''); }
    }
  };
  const uploadFiles = async (files) => {
    if (!files?.length || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy('upload');
    setError('');
    setNotice('');
    let currentUpload;
    const totals = { imported: 0, duplicates: 0, skipped: 0 };
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        controller.signal.throwIfAborted();
        if (file.size > 32 * 1024 * 1024) throw new Error('“' + file.name + '”超过 32 MiB，请分成较小的压缩包。');
        const started = await request(
          'assets.upload.start',
          { name: file.name, size: file.size, kind: importKind },
          controller.signal
        );
        currentUpload = started.uploadId;
        if (mounted.current && currentAccount.current === accountId)
          setUpload({
            name: file.name,
            index: index + 1,
            count: files.length,
            received: 0,
            total: file.size,
            phase: '正在上传',
          });
        for (let at = 0; at < file.size; at += started.chunkBytes) {
          const bytes = new Uint8Array(await file.slice(at, at + started.chunkBytes).arrayBuffer());
          const result = await request(
            'assets.upload.chunk',
            { uploadId: currentUpload, offset: at, data: encoded(bytes) },
            controller.signal
          );
          if (mounted.current && currentAccount.current === accountId)
            setUpload((value) => ({ ...value, received: result.received }));
        }
        if (mounted.current && currentAccount.current === accountId)
          setUpload((value) => ({ ...value, phase: '正在检查并导入' }));
        const result = await request('assets.upload.finish', { uploadId: currentUpload }, controller.signal);
        currentUpload = undefined;
        for (const key of Object.keys(totals)) totals[key] += result[key];
      }
      await reload();
      if (mounted.current && currentAccount.current === accountId)
        setNotice(
          `已导入 ${totals.imported} 张，跳过 ${totals.duplicates} 张重复素材${totals.skipped ? `及 ${totals.skipped} 个非图片文件` : ''}。表情含义与适用情景将在后台整理，也可以手动填写。`
        );
    } catch (failure) {
      if (mounted.current && currentAccount.current === accountId)
        setError(controller.signal.aborted ? '上传已停止，已完成导入的素材保留。' : failure.message);
    } finally {
      if (currentUpload) {
        try {
          await request('assets.upload.abort', { uploadId: currentUpload });
        } catch {}
      }
      if (mounted.current && currentAccount.current === accountId) {
        setBusy('');
        setUpload(null);
      }
      if (active.current === controller) active.current = null;
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const edit = (asset) => {
    setEditing(asset);
    setDraft(metadata(asset));
    setError('');
  };
  const toggle = (id) =>
    setSelected((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const analyze = () =>
    act(
      'assets.describe',
      { assetIds: selected.size ? [...selected] : undefined },
      (result) =>
        `已理解 ${result.succeeded} 张${result.failed ? `，${result.failed} 张未完成，可查看原因后重试` : ''}${result.skipped ? `；${result.skippedNoPreview || 0} 张等待原图，${result.skipped - (result.skippedNoPreview || 0)} 张保留了你的最新修改` : ''}。`
    );
  const togglePack = (pack) =>
    act(
      'assets.packs.configure',
      { packId: pack.id, enabled: !pack.enabled },
      (result) =>
        `“${pack.name}”已${result.enabled ? '启用' : '停用'}${result.imported ? `，加入 ${result.imported} 张素材` : ''}。${result.duplicates ? '已有的重复图片保留原来的分组和设置。' : ''}${result.enabled && !data.settings.enabled ? '图片回复总开关仍关闭，可在“设置 → 自动功能 → 聊天表情与图片”中开启。' : ''}`
    );
  const importedPacks = data.packs;
  const progress = upload || data.progress?.running;
  return (
    <div className="wa-library-page">
      <PageHead icon="image" title="表情与图片" description="微信收藏、聊天表情和你自己的图片。">
        {accountId && <Button primary icon="plus" disabled={!!busy} onClick={() => document.querySelector('[data-testid="asset-import"]')?.scrollIntoView({ behavior: 'auto', block: 'start' })}>添加素材</Button>}
      </PageHead>
      {error && (
        <p className="wa-alert is-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="wa-alert is-success" role="status">
          {notice}
        </p>
      )}
      {!accountId ? (
        <section className="wa-card wa-empty">
          <div className="wa-empty-icon"><Glyph name="image" /></div>
          <h3>先连接微信账号</h3>
          <p>每个账号分别保存自己的素材和使用设置。</p>
        </section>
      ) : (
        <>
          <StickerControls data={data} status={status} busy={busy} act={act} />
          <section className="wa-library-gallery" data-testid="my-assets">
            <div className="wa-assets-gallery-heading">
              <h2>我的素材</h2>
              <Button icon="refresh"
                disabled={!!busy}
                onClick={() => {
                  void reload().catch((failure) => setError(failure.message));
                }}
              >
                刷新
              </Button>
            </div>
            <div className="wa-assets-statline">
              <span>共 {data.counts.all} 张</span>
              <span>微信收藏 {data.counts.favorites || 0} 张</span>
              <span>聊天收集 {data.counts.collected || 0} 张</span>
              <span>可用于回复 {data.counts.enabled} 张</span>
              <span>有含义 {data.counts.described} 张</span>
              <span>{size(data.counts.bytes)}</span>
            </div>
            {data.counts.all > 0 && <>
            <div className="wa-sticker-sources" aria-label="表情来源筛选">
              {[['', '全部素材'], ['favorite', '微信收藏'], ['chat', '聊天收集'], ['upload', '自行导入']].map(([value, label]) =>
                <button key={value} type="button" aria-pressed={source === value} disabled={!!busy} onClick={() => { setSource(value); setPackId(''); setOffset(0); }}>{label}</button>)}
            </div>
            <div className="wa-assets-toolbar">
              <input
                type="search"
                className="wa-input"
                aria-label="搜索表情或图片"
                placeholder="按名称、含义或标签找素材"
                value={query}
                disabled={!!busy}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
              />
              <select
                className="wa-select"
                aria-label="素材类型筛选"
                value={kind}
                disabled={!!busy}
                onChange={(event) => {
                  setKind(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全部类型</option>
                <option value="sticker">表情包</option>
                <option value="image">图片</option>
              </select>
              <select
                className="wa-select"
                aria-label="素材分组筛选"
                value={packId}
                disabled={!!busy}
                onChange={(event) => {
                  setPackId(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全部分组</option>
                {data.packs
                  .filter((pack) => pack.installed > 0)
                  .map((pack) => (
                    <option key={pack.id} value={pack.id}>
                      {pack.name}
                      {pack.enabled ? '' : '（已停用）'}
                    </option>
                  ))}
              </select>
              <Button
                disabled={!!busy || !data.items.length}
                onClick={() => setSelected(new Set(data.items.map((asset) => asset.id)))}
              >
                选中本页
              </Button>
              {selected.size > 0 && (
                <Button disabled={!!busy} onClick={() => setSelected(new Set())}>
                  取消选择
                </Button>
              )}
            </div>
            <div className={'wa-assets-batch-actions' + (selected.size ? ' has-selection' : '')}>
              <Button
                disabled={!!busy || !data.counts.all || status.modelConfig?.vision === false}
                onClick={() => {
                  void analyze();
                }}
              >
                {selected.size ? `理解选中的 ${selected.size} 张` : '整理未填写的含义与情景'}
              </Button>
              {selected.size > 0 && <Button quiet danger disabled={!!busy} onClick={() => setConfirmDelete(true)}>
                删除选中
              </Button>}
              {selected.size > 0 && <span className="wa-assets-selected">已选 {selected.size} 张</span>}
            </div>
            <p className="wa-help wa-section-space">
              表情会整理画面含义、适用情景和标签；你也可以点击图片手动编辑。动态图按首帧整理，原图保留。
              {status.modelConfig?.vision === false ? '请先在模型高级设置开启图像理解，才能自动分析。' : ''}
            </p>
            </>}
            {confirmDelete && (
              <div className="wa-assets-delete">
                <p>删除选中的 {selected.size} 张素材？之后 Agent 不会再使用它们，原始 ZIP 或图片文件不受影响。</p>
                <div className="wa-row wa-section-space">
                  <Button
                    danger
                    disabled={!!busy}
                    onClick={async () => {
                      if (
                        await act(
                          'assets.delete',
                          { assetIds: [...selected] },
                          (result) =>
                            `已删除 ${result.removed} 张素材。${result.retainedFiles ? '部分本地文件暂未清理，已从可用素材中移除。' : ''}`
                        )
                      ) {
                        setSelected(new Set());
                        setConfirmDelete(false);
                      }
                    }}
                  >
                    确认删除素材
                  </Button>
                  <Button disabled={!!busy} onClick={() => setConfirmDelete(false)}>
                    保留
                  </Button>
                </div>
              </div>
            )}
            <div className="wa-assets-grid wa-section-space" data-testid="asset-grid">
              {data.items.map((asset) => (
                <article
                  className={'wa-asset-card' + (asset.effectiveEnabled ? '' : ' is-disabled')}
                  key={asset.id}
                  data-asset-id={asset.id}
                >
                  <label className="wa-asset-check">
                    <input
                      type="checkbox"
                      aria-label={'选择 ' + asset.name}
                      checked={selected.has(asset.id)}
                      disabled={!!busy}
                      onChange={() => toggle(asset.id)}
                    />
                  </label>
                  <button
                    type="button"
                    className="wa-asset-open"
                    aria-label={'预览并编辑 ' + asset.name}
                    onClick={() => edit(asset)}
                  >
                    <div className="wa-asset-preview">
                      {thumbnails[asset.id] ? (
                        <img src={thumbnails[asset.id]} alt={asset.name} loading="lazy" />
                      ) : (
                        <span className="wa-asset-placeholder">
                          {kinds[asset.kind]}
                          <br />
                          点击预览
                        </span>
                      )}
                    </div>
                    <div className="wa-asset-details">
                      <strong>{asset.name}</strong>
                      <p>{asset.usage || asset.description || (asset.kind === 'sticker' ? '等待整理含义与适用情景' : '点击编辑或让模型理解')}</p>
                      {asset.descriptionError && <p className="wa-assets-card-error">{asset.descriptionError}</p>}
                      <div className="wa-asset-meta">
                        <span>
                          {asset.nativeSticker ? '微信表情' : kinds[asset.kind]} ·{' '}
                          {!asset.packEnabled ? '分组已停用' : asset.enabled ? '启用' : '单张已停用'}
                        </span>
                        <span>{asset.bytes ? size(asset.bytes) : '预览暂未取得'}</span>
                      </div>
                    </div>
                  </button>
                </article>
              ))}
            </div>
            {!data.items.length && (
              <div className="wa-empty">
                <div className="wa-empty-icon"><Glyph name={data.counts.all ? 'search' : 'image'} /></div>
                <h3>{data.counts.all ? '没有匹配的素材' : '把微信里的表情带过来'}</h3>
                <p>
                  {data.counts.all
                    ? '换个关键词或清除筛选试试。'
                    : '同步账号收藏，或从已授权的聊天中保存表情。也可以导入自己的图片。'}
                </p>
                <Button quiet disabled={!!busy} onClick={() => {
                  if (data.counts.all) { setQuery(''); setKind(''); setPackId(''); setSource(''); setOffset(0); }
                  else document.querySelector('[data-testid="wechat-stickers"]')?.scrollIntoView({ behavior: 'auto', block: 'start' });
                }}>{data.counts.all ? '清除筛选' : '查看同步与收集'}</Button>
              </div>
            )}
            {data.total > 24 && (
              <div className="wa-assets-pagination">
                <Button disabled={!!busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 24))}>
                  上一页
                </Button>
                <span className="wa-help">
                  {offset + 1}–{Math.min(offset + 24, data.total)} / {data.total}
                </span>
                <Button disabled={!!busy || offset + 24 >= data.total} onClick={() => setOffset(offset + 24)}>
                  下一页
                </Button>
              </div>
            )}
            <details className="wa-subsection">
              <summary>素材保存位置</summary>
              <div className="wa-path-value">{data.path}</div>
              <p className="wa-help">当前微信账号独立保存素材。切换账号不会混用别的账号图片。</p>
            </details>
          </section>
          <section className="wa-library-section wa-library-import" data-testid="asset-import">
            <div className="wa-assets-upload">
              <div>
                <h2>添加素材</h2>
                <p className="wa-help">上传 ZIP 表情包或图片，重复素材自动跳过。</p>
              </div>
              <div className="wa-assets-upload-actions">
                <select
                  className="wa-select"
                  aria-label="导入素材类型"
                  value={importKind}
                  disabled={!!busy}
                  onChange={(event) => setImportKind(event.target.value)}
                >
                  <option value="sticker">导入为表情包</option>
                  <option value="image">导入为图片</option>
                </select>
                <Button primary disabled={!!busy} onClick={() => fileInput.current?.click()}>
                  选择 ZIP 或图片
                </Button>
                <input
                  ref={fileInput}
                  data-testid="asset-upload-input"
                  className="wa-assets-import-input"
                  type="file"
                  multiple
                  accept=".zip,.png,.jpg,.jpeg,.gif,.webp"
                  aria-label="上传 ZIP 或图片"
                  onChange={(event) => {
                    void uploadFiles(Array.from(event.target.files || []));
                  }}
                />
              </div>
            </div>
            <details className="wa-subsection"><summary>支持的格式与大小</summary><p className="wa-help">PNG、JPEG、GIF、WebP 图片，单图最多 10 MiB。ZIP 按包名分组，最多 32 MiB、展开后 64 MiB，每次最多 300 张。</p></details>
            {importedPacks.length > 0 && (
              <div className="wa-imported-packs" aria-label="导入的素材分组">
                {importedPacks.map((pack) => (
                  <div className="wa-imported-pack" key={pack.id}>
                    <span className="wa-imported-pack-name" title={pack.name}>
                      {pack.name} · {pack.installed} 张
                    </span>
                    <label className="wa-pack-toggle">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={'启用分组 ' + pack.name}
                        checked={pack.enabled}
                        disabled={!!busy}
                        onChange={() => {
                          void togglePack(pack);
                        }}
                      />
                      {pack.enabled ? '已启用' : '已停用'}
                    </label>
                  </div>
                ))}
              </div>
            )}
            {progress && (
              <div className="wa-assets-progress" role="status">
                <div className="wa-between">
                  <span>
                    {upload
                      ? `${upload.phase} · ${upload.name}（${upload.index}/${upload.count}）`
                      : `正在理解素材 · ${data.progress.completed}/${data.progress.total}`}
                  </span>
                  <Button disabled={!active.current} onClick={() => active.current?.abort()}>
                    停止
                  </Button>
                </div>
                <progress
                  max={upload ? upload.total : data.progress.total || 1}
                  value={upload ? upload.received : data.progress.completed}
                />
                <p className="wa-help">
                  {upload
                    ? `${size(upload.received)} / ${size(upload.total)}`
                    : `已成功 ${data.progress.succeeded} 张，失败 ${data.progress.failed} 张。已完成的结果会逐批保存。`}
                </p>
              </div>
            )}
            {data.progress?.error && !data.progress.running && (
              <p className="wa-help wa-section-space">{data.progress.error}</p>
            )}
            <div className="wa-subsection">
              <div className="wa-between"><h3>自动表情与图片</h3><AutomationLink onNavigate={onNavigate} from="assets" section="media">素材自动设置</AutomationLink></div>
              <p className="wa-help">图片表情回复、聊天表情收集与含义整理统一在“设置 → 自动功能”中管理。</p>
              <p className="wa-help">图片表情回复{data.settings.enabled ? '已开启' : '已关闭'} · 聊天表情收集{data.settings.captureIncoming ? '已开启' : '已关闭'} · 含义整理{data.settings.autoDescribe ? '已开启' : '已关闭'}</p>
            </div>
          </section>
        </>
      )}
      {editing && draft && (
        <div
          className="wa-assets-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setEditing(null);
          }}
        >
          <section className="wa-assets-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="编辑素材">
            <header className="wa-assets-dialog-head">
              <h2>编辑素材</h2>
              <Button disabled={!!busy} onClick={() => setEditing(null)}>
                关闭
              </Button>
            </header>
            {error && (
              <p className="wa-alert is-error wa-section-space" role="alert">
                {error}
              </p>
            )}
            <div className="wa-assets-editor wa-section-space">
              <div>
                <div className="wa-assets-large-preview">
                  {preview ? (
                    <img src={preview} alt={draft.name} />
                  ) : (
                    <p className="wa-help">{previewError || '正在读取图片…'}</p>
                  )}
                </div>
                <p className="wa-help wa-section-space">
                  {editing.bytes ? `${editing.width} × ${editing.height} · ${size(editing.bytes)}` : '微信暂未提供预览，仍可尝试原生发送'}
                </p>
                {preview && previewError && <p className="wa-alert">{previewError}</p>}
                {editing.nativeSticker && <p className="wa-help">{editing.nativeSticker.favorite ? '已收藏在当前微信账号' : '已保存在本机表情库'} · 优先使用微信原生表情</p>}
                {editing.nativeSticker && !editing.nativeSticker.favorite && <Button disabled={!!busy || !status.online} onClick={async () => {
                  if (await act('assets.stickers.favorite', { assetId: editing.id }, '微信收藏列表已确认收录这张表情。')) setEditing(null);
                }}>收藏到微信</Button>}
                <Button disabled={!!busy || !editing.effectiveEnabled || !status.online} onClick={() => void act('assets.stickers.send', { assetId: editing.id }, result =>
                  `已${result.native ? '用微信原生表情' : '用图片'}发送到文件传输助手，微信已确认。`)}>试发到文件传输助手</Button>
                {editing.descriptionError && <p className="wa-alert wa-section-space">{editing.descriptionError}</p>}
                <Button
                  disabled={!!busy || !editing.bytes || status.modelConfig?.vision === false}
                  onClick={async () => {
                    if (
                      await act(
                        'assets.describe',
                        { assetIds: [editing.id] },
                        '已整理这张素材，可重新打开查看含义与适用情景。'
                      )
                    )
                      setEditing(null);
                  }}
                >
                  {editing.kind === 'sticker' ? '整理含义与适用情景' : '让模型理解这张图片'}
                </Button>
              </div>
              <div>
                <Field title="名称">
                  <input
                    className="wa-input"
                    aria-label="素材名称"
                    maxLength={120}
                    value={draft.name}
                    disabled={!!busy}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Field>
                <Field title="画面与含义" help="描述实际画面、文字与表达的情绪，模型检索时会读取。">
                  <textarea
                    className="wa-textarea"
                    aria-label="素材含义"
                    rows={4}
                    maxLength={1600}
                    value={draft.description}
                    disabled={!!busy}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                  <span className="wa-assets-description-count">{draft.description.length} / 1600</span>
                </Field>
                <Field title="适用情景" help="例如：适合熟人间轻松吐槽；不适合安慰正在难过的人。">
                  <textarea className="wa-textarea" aria-label="表情适用情景" rows={3} maxLength={600}
                    value={draft.usage} disabled={!!busy} onChange={event => setDraft({ ...draft, usage: event.target.value })} />
                </Field>
                <Field title="标签" help="用逗号分隔，最多 16 个。">
                  <input
                    className="wa-input"
                    aria-label="素材标签"
                    value={draft.tags}
                    disabled={!!busy}
                    onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                  />
                </Field>
                <Field title="类型">
                  <select
                    className="wa-select"
                    aria-label="素材类型"
                    value={draft.kind}
                    disabled={!!busy}
                    onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
                  >
                    <option value="sticker">表情包</option>
                    <option value="image">图片</option>
                  </select>
                </Field>
                <label className="wa-assets-checkline">
                  <input
                    type="checkbox"
                    aria-label="启用这张素材"
                    checked={draft.enabled}
                    disabled={!!busy}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                  允许 Agent 使用这张素材
                </label>
                <div className="wa-assets-editor-actions">
                  <Button
                    primary
                    disabled={!!busy || !draft.name.trim() || tagsFromText(draft.tags).length > 16}
                    onClick={async () => {
                      if (
                        await act(
                          'assets.edit',
                          {
                            assetId: editing.id,
                            patch: { ...draft, tags: tagsFromText(draft.tags), revision: editing.revision },
                          },
                          '素材设置已保存。'
                        )
                      )
                        setEditing(null);
                    }}
                  >
                    保存素材
                  </Button>
                  <Button quiet disabled={!!busy} onClick={() => setEditing(null)}>取消</Button>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
