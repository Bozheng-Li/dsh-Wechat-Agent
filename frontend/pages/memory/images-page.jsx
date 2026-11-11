import { useEffect, useRef, useState } from 'react';
import { RoomPicker } from "../../components/room-picker.jsx";
import { conversationKey, peerId, peerType, peerName, formatTime } from "../../shared/conversations.mjs";
import { Button } from '../../components/button.jsx';
import { PageHead } from '../../components/page-ui.jsx';

const quality = (value) =>
  ({ original: '原图', full: '完整图片', thumbnail: '仅微信缩略图', unknown: '清晰度未核实' })[value] || '清晰度未核实';

function GenerationSource({ item }) {
  const source = item.generation;
  if (!source) return null;
  return <div className="wa-image-generation-source">
    <p className="wa-help">{source.fileName} · {source.model ? [source.providerName, source.model].filter(Boolean).join(' / ') : 'Agent 任务产图'}</p>
    <p className="wa-help">生成要求：{source.prompt || item.sourceText}</p>
    <p className="wa-help">任务 {source.jobId} · {source.deliveryState === 'sent' ? '微信已确认发送' : '尚未确认发送'}</p>
  </div>;
}

export function ImageMemoryPage({ rpc, status, rows = [], initialPeer, active = true, collection = 'conversation' }) {
  const accountId = status.account?.id, generated = collection === 'generated',
    title = generated ? '生成图片记忆' : '会话图片记忆';
  const [selected, setSelected] = useState(() => initialPeer || rows[0] || null),
    [doc, setDoc] = useState(null);
  const [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [failures, setFailures] = useState([]);
  const [preview, setPreview] = useState(null),
    [thumbnails, setThumbnails] = useState({}),
    [removing, setRemoving] = useState(false),
    [deleteAttempted, setDeleteAttempted] = useState(false),
    [clearing, setClearing] = useState(false);
  const scope = selected && { accountId, chatType: peerType(selected), peerId: peerId(selected), ...(generated ? { collection } : {}) };
  const key = accountId + ':' + collection + ':' + (selected ? conversationKey(selected) : '');
  const current = useRef(key);
  current.current = key;
  const docRef = useRef(doc);
  docRef.current = doc;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pending = useRef(false),
    previewId = useRef(null),
    previewTrigger = useRef(null),
    previewDialog = useRef(null),
    closeButton = useRef(null);
  const reload = async (force = false, signal) => {
    if (!scope?.accountId) return;
    const next = await rpc('memory.images.list', { ...scope, query, offset, limit: 20 }, signal);
    if (signal?.aborted || current.current !== key) return;
    if (
      force ||
      !settingsRef.current ||
      JSON.stringify(settingsRef.current) === JSON.stringify(docRef.current?.settings)
    )
      setSettings(next.settings);
    setDoc(next);
    return next;
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        if (!pending.current) await reload(false, controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, query, offset, active]);
  useEffect(() => {
    if (!active || !doc) return;
    const controller = new AbortController();
    void Promise.allSettled(
      doc.items
        .filter((item) => item.hasThumbnail)
        .map(async (item) => {
          const result = await rpc(
            'memory.images.content',
            { ...scope, imageId: item.id, preview: true },
            controller.signal
          );
          return [item.id, 'data:' + result.mediaType + ';base64,' + result.data];
        })
    ).then((results) => {
      if (controller.signal.aborted || current.current !== key) return;
      setThumbnails(
        Object.fromEntries(results.filter((result) => result.status === 'fulfilled').map((result) => result.value))
      );
    });
    return () => controller.abort();
  }, [key, doc, active]);
  useEffect(() => {
    if (!preview) return;
    closeButton.current?.focus();
    return () => {
      if (previewTrigger.current?.isConnected) previewTrigger.current.focus();
    };
  }, [preview?.item.id]);
  useEffect(() => {
    const dialog = previewDialog.current;
    if (!preview || !dialog) return;
    if (busy) dialog.focus();
    else if (!dialog.contains(document.activeElement) || document.activeElement === dialog)
      closeButton.current?.focus();
  }, [busy, preview?.item.id]);
  const choose = (peer) => {
    if (pending.current) return;
    current.current = accountId + ':' + collection + ':' + (peer ? conversationKey(peer) : '');
    setSelected(peer);
    setDoc(null);
    setSettings(null);
    setQuery('');
    setOffset(0);
    setThumbnails({});
    setError('');
    setNotice('');
    setFailures([]);
    setClearing(false);
  };
  const act = async (endpoint, payload) => {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setFailures([]);
    try {
      const result = await rpc(endpoint, { ...scope, ...payload });
      if (current.current !== key) return null;
      await reload(true);
      return result;
    } catch (failure) {
      if (current.current === key) setError(failure.message);
      return null;
    } finally {
      pending.current = false;
      if (current.current === key) setBusy(false);
    }
  };
  const open = async (item) => {
    previewTrigger.current = document.activeElement;
    previewId.current = item.id;
    setPreview({ item, data: '', error: '' });
    setRemoving(false);
    setDeleteAttempted(false);
    try {
      const image = await rpc('memory.images.content', { ...scope, imageId: item.id });
      if (current.current === key && previewId.current === item.id)
        setPreview({ item, data: 'data:' + image.mediaType + ';base64,' + image.data, error: '' });
    } catch (failure) {
      if (current.current === key && previewId.current === item.id)
        setPreview({ item, data: '', error: failure.message });
    }
  };
  const close = () => {
    if (!busy) {
      previewId.current = null;
      setPreview(null);
      setRemoving(false);
    }
  };
  const invalid =
    settings?.retentionDays !== null &&
    (!Number.isSafeInteger(settings?.retentionDays) || settings.retentionDays < 1 || settings.retentionDays > 36500);
  return (
    <>
      <PageHead icon="image" title={title} description={generated
        ? '保存 Agent 产出的原图，按生成要求查找，后续讨论时直接查看。'
        : '按描述查找会话中收到的图片，需要核对细节时再理解原图。'} />
      {error && !preview && (
        <div role="alert" className="wa-alert is-error">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="wa-alert is-success">
          {notice}
        </p>
      )}
      {failures.length > 0 && (
        <ul className="wa-help">
          {failures.map((item) => (
            <li key={item.reason}>
              {item.count} 张：{item.reason}
            </li>
          ))}
        </ul>
      )}
      {!accountId ? (
        <div className="wa-empty">
          <h3>先连接微信账号</h3>
          <p>图片记忆按账号和会话分别保存。</p>
        </div>
      ) : (
        <section className="wa-image-memory" data-testid={generated ? 'generated-image-memory-document' : 'image-memory-document'}>
          <div className="wa-memory-scope"><RoomPicker rows={rows} value={selected} onChange={choose} disabled={busy || !!preview} /></div>
          {doc && settings ? (
            <>
              {doc.error && (
                <p role="alert" className="wa-alert is-error">
                  {doc.error}
                </p>
              )}
              <form
                className="wa-image-settings"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await act('memory.images.configure', { settings })) setNotice('此会话的图片记忆设置已保存。');
                }}
              >
                <label className="wa-check-row">
                  <input
                    type="checkbox"
                    aria-label={generated ? '保存此会话的生成图片' : '保存此会话的图片'}
                    checked={settings.enabled}
                    disabled={busy}
                    onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
                  />
                  <span>{generated ? '保存此会话的生成图片' : '保存此会话的图片与表情'}</span>
                </label>
                <label className="wa-field">
                  <span className="wa-label">保留天数（默认 30 天）</span>
                  <input
                    className="wa-input"
                    type="number"
                    min="1"
                    max="36500"
                    step="1"
                    aria-label={generated ? '生成图片记忆保留天数' : '图片记忆保留天数'}
                    placeholder="手动留空可长期保存"
                    value={settings.retentionDays ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        retentionDays: event.target.value.trim() === '' ? null : Number(event.target.value),
                      })
                    }
                  />
                </label>
                <Button
                  primary
                  type="submit"
                  disabled={busy || invalid || JSON.stringify(settings) === JSON.stringify(doc.settings)}
                >
                  保存图片记忆设置
                </Button>
              <Button disabled={busy || JSON.stringify(settings) === JSON.stringify(doc.settings)} onClick={() => setSettings(doc.settings)}>取消更改</Button>
              </form>
              {invalid && <div className="wa-alert is-error" role="alert">保留天数填写 1–36500 的整数，留空可长期保存。</div>}
              <p className="wa-help">
                期限从首次保存起计算，对已有和新图片都生效；到期会删除图片文件。关闭后停止保存和模型读取，已有图片仍可由你管理。
              </p>
              <div className="wa-image-toolbar">
                <input
                  type="search"
                  className="wa-input"
                  aria-label={generated ? '搜索生成图片记忆' : '搜索图片记忆'}
                  placeholder={generated ? '搜索生成要求、文件名或画面描述' : '搜索描述、发言者或消息关键词'}
                  disabled={busy || !!preview}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setOffset(0);
                  }}
                />
                <Button
                  disabled={busy || !selected.authorized || !doc.settings.enabled}
                  onClick={async () => {
                    const result = await act('memory.images.import', {});
                    if (result) {
                      setNotice(
                        `保存已结束：新增 ${result.saved} 张，已有或已删除 ${result.skipped} 张，未取得 ${result.failed} 张。`
                      );
                      setFailures(result.failures);
                    }
                  }}
                >
                  {busy ? '正在处理…' : generated ? '补充已有生成图片' : '保存已有图片'}
                </Button>
                <Button icon="refresh" disabled={busy} onClick={() => void reload(true).catch((failure) => setError(failure.message))}>
                  重新读取图片记忆
                </Button>
              </div>
              <p className="wa-image-count" data-testid={generated ? 'generated-image-memory-count' : 'image-memory-count'}>
                已保存 {doc.storedCount} 张 · {(doc.storedBytes / 1024 / 1024).toFixed(2)}{' '}MiB
                {query ? ' · 当前匹配 ' + doc.total + ' 张' : ''}
              </p>
              <div className="wa-image-grid">
                {doc.items.map((item) => (
                  <article className="wa-image-card" key={item.id} data-image-memory-id={item.id}>
                    <button
                      type="button"
                      className="wa-image-open"
                      aria-label={'预览图片记忆 ' + item.id}
                      onClick={() => void open(item)}
                    >
                      {thumbnails[item.id] ? (
                        <img src={thumbnails[item.id]} alt={item.description || '保存的图片缩略图'} />
                      ) : (
                        <span>
                          点击查看已保存图片{item.thumbnailError && <small className="wa-help"> · 暂无缩略图</small>}
                        </span>
                      )}
                    </button>
                    <div className="wa-image-card-copy">
                    <div className="wa-image-card-meta">
                    <span>
                      {item.senderName || '会话成员'} · {formatTime(item.time || item.capturedAt, true)}
                    </span>
                    <span className="wa-badge">{quality(item.quality)}</span>
                    </div>
                    <p className="wa-image-description">
                      {item.type === 'face'
                        ? '表情包已保存，不调用图像理解。'
                        : item.description || '图片已保存，只有需要看图时才按需理解。'}
                    </p>
                    {generated && <GenerationSource item={item} />}
                    <p className="wa-help">
                      {item.expiresAt ? '保留至 ' + formatTime(item.expiresAt, true) : '长期保存'}
                    </p>
                    </div>
                  </article>
                ))}
              </div>
              {!doc.items.length && (
                <div className="wa-empty">
                  <h3>{query ? '没有匹配的图片' : generated ? '这个会话还没有生成图片记忆' : '这个会话还没有图片记忆'}</h3>
                  <p>{query ? generated ? '换个生成要求、文件名或描述再找找。' : '换个描述、发言者或消息关键词再找找。'
                    : generated ? 'Agent 产出的图片会独立保存，也会补入仍可读取的已有任务图片。' : '之后收到的图片会独立保存，也可保存仍可读取的已有图片。'}</p>
                </div>
              )}
              <div className="wa-between wa-section-space">
                <span className="wa-help">{doc.total ? offset + 1 + '–' + Math.min(offset + 20, doc.total) + ' / ' + doc.total : '暂无图片'}</span>
                <div className="wa-row">
                  <Button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>
                    上一页图片
                  </Button>
                  <Button disabled={busy || !doc.hasMore} onClick={() => setOffset(offset + 20)}>
                    下一页图片
                  </Button>
                </div>
              </div>
              <details className="wa-subsection">
                <summary>图片记忆文件与清理</summary>
                <div className="wa-path-value">{doc.path}</div>
                <p className="wa-help">
                  {generated ? '生成图与会话收到的图片分开保存。清理只删除本类记忆副本，不删除工作任务原文件，也不再自动补入已删除的旧图。'
                    : '独立于微信缓存及文字窗口，压缩或清空文字记忆不会删除这些图片。删除后不从旧消息自动补回；聊天记录里的文字描述仍保留。'}
                </p>
                <Button danger disabled={busy || !doc.storedCount} onClick={() => setClearing(true)}>
                  {generated ? '清空此会话的生成图片记忆' : '清空此会话的图片记忆'}
                </Button>
                {clearing && (
                  <div className="wa-note-box">
                    <p>{generated ? '将删除此会话的生成图片记忆及缩略图，并停止补入已有任务图片。会话图片记忆和任务原文件保留。'
                      : '将删除此会话保存的图片和缩略图，并停止从现有旧消息补回。生成图片记忆和其他会话保留。'}</p>
                    <Button
                      danger
                      disabled={busy}
                      onClick={async () => {
                        if (await act('memory.images.clear', {})) {
                          setClearing(false);
                          setNotice('此会话的图片记忆已清空。');
                        }
                      }}
                    >
                      确认清空图片记忆
                    </Button>
                    <Button disabled={busy} onClick={() => setClearing(false)}>
                      返回
                    </Button>
                  </div>
                )}
              </details>
            </>
          ) : (
            <p className="wa-help wa-section-space">{selected ? '正在读取图片记忆…' : '选择一个会话查看图片记忆。'}</p>
          )}
        </section>
      )}
      {preview && (
        <div className="wa-image-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section
            className="wa-image-dialog"
            ref={previewDialog}
            role="dialog"
            aria-modal="true"
            aria-label={generated ? '生成图片记忆预览' : '图片记忆预览'}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
              if (event.key === 'Tab') {
                const controls = Array.from(event.currentTarget.querySelectorAll('button:not(:disabled)'));
                const first = controls[0],
                  last = controls.at(-1);
                if (!controls.length) {
                  event.preventDefault();
                  event.currentTarget.focus();
                } else if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <header className="wa-image-dialog-head">
              <h2>
                {quality(preview.item.quality)} · {preview.item.senderName || '会话成员'}
              </h2>
              <button className="wa-button" type="button" ref={closeButton} disabled={busy} onClick={close}>
                关闭图片预览
              </button>
            </header>
            <div className="wa-image-dialog-stage">
            {preview.error ? (
              <p role="alert" className="wa-alert is-error">
                {preview.error}
              </p>
            ) : preview.data ? (
              <img
                className="wa-image-preview"
                src={preview.data}
                alt={preview.item.description || '当前会话保存的图片'}
              />
            ) : (
              <p className="wa-help">正在读取保存图片…</p>
            )}
            </div>
            <div className="wa-image-dialog-information">
            <p className="wa-image-description">{preview.item.description}</p>
            {generated && <GenerationSource item={preview.item} />}
            <p className="wa-help">
              来源：{peerName(selected)} · {formatTime(preview.item.time || preview.item.capturedAt, true)}。
              {quality(preview.item.quality)}。
            </p>
            <Button danger disabled={busy} onClick={() => { setDeleteAttempted(false); setRemoving(true); }}>
              删除这张图片记忆
            </Button>
            {removing && (
              <div className="wa-note-box wa-image-delete">
                <p>{generated ? '删除这张生成图片的记忆副本及缩略图，不从任务自动补回。工作任务原文件保留。'
                  : '删除保存图片及缩略图，不从原消息自动补回。聊天记录中的文字描述保留。'}</p>
                {deleteAttempted && error && !busy && (
                  <div className="wa-alert is-error" role="alert">{error}</div>
                )}
                <Button
                  danger
                  disabled={busy}
                  onClick={async () => {
                    setDeleteAttempted(true);
                    if (await act('memory.images.delete', { imageId: preview.item.id })) {
                      previewId.current = null;
                      setPreview(null);
                      setRemoving(false);
                      setNotice('这张图片记忆已删除。');
                    }
                  }}
                >
                  确认删除图片记忆
                </Button>
                <Button disabled={busy} onClick={() => setRemoving(false)}>
                  保留图片
                </Button>
              </div>
            )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
