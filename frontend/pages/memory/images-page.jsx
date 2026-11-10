import { useEffect, useRef, useState } from 'react';
import { RoomPicker } from "../../components/room-picker.jsx";
import { conversationKey, peerId, peerType, peerName, formatTime } from "../../shared/conversations.mjs";
import { Button } from '../../components/button.jsx';
import { PageHead } from '../../components/page-ui.jsx';

const quality = (value) =>
  ({ original: '原图', full: '完整图片', thumbnail: '仅微信缩略图', unknown: '清晰度未核实' })[value] || '清晰度未核实';
const css = `.wa-image-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:16px;margin-top:20px}.wa-image-card{padding:16px;border:1px solid var(--wa-border);border-radius:12px;min-width:0}.wa-image-open{display:block;width:100%;height:176px;border:0;border-radius:8px;background:var(--wa-surface);color:inherit;cursor:pointer}.wa-image-open img{width:100%;height:100%;object-fit:contain}.wa-image-description{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.wa-image-card .wa-image-description{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}.wa-image-toolbar{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}.wa-image-settings{display:flex;gap:16px;align-items:end;flex-wrap:wrap;margin:20px 0}.wa-image-modal{position:fixed;inset:0;z-index:1000;background:#0009;padding:16px;display:flex;align-items:center;justify-content:center}.wa-image-modal>.wa-card{width:min(900px,100%);max-height:90vh;overflow:auto}.wa-image-preview{width:100%;max-height:55vh;object-fit:contain}.wa-image-delete{margin-top:16px}.wa-memory-tabs{flex-wrap:wrap}.wa-memory-tabs>button{flex:1;min-width:0}.wa-memory-tabs strong,.wa-memory-tabs small{display:block;overflow-wrap:anywhere;white-space:normal}`;

export function ImageMemoryPage({ rpc, status, rows = [], initialPeer, active = true }) {
  const accountId = status.account?.id;
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
    [clearing, setClearing] = useState(false);
  const scope = selected && { accountId, chatType: peerType(selected), peerId: peerId(selected) };
  const key = accountId + ':' + (selected ? conversationKey(selected) : '');
  const current = useRef(key);
  current.current = key;
  const docRef = useRef(doc);
  docRef.current = doc;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pending = useRef(false),
    previewId = useRef(null),
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
    if (preview) closeButton.current?.focus();
  }, [preview?.item.id]);
  const choose = (peer) => {
    if (pending.current) return;
    current.current = accountId + ':' + (peer ? conversationKey(peer) : '');
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
    previewId.current = item.id;
    setPreview({ item, data: '', error: '' });
    setRemoving(false);
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
      <style>{css}</style>
      <PageHead title="图片记忆" description="按描述查找保存的图片，需要核对细节时再理解原图。" />
      {error && (
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
        <section className="wa-card" data-testid="image-memory-document">
          <RoomPicker rows={rows} value={selected} onChange={choose} disabled={busy || !!preview} />
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
                    aria-label="保存此会话的图片"
                    checked={settings.enabled}
                    disabled={busy}
                    onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
                  />
                  <span>保存此会话的图片与表情</span>
                </label>
                <label className="wa-field">
                  <span className="wa-label">保留天数（默认 30 天）</span>
                  <input
                    className="wa-input"
                    type="number"
                    min="1"
                    max="36500"
                    step="1"
                    aria-label="图片记忆保留天数"
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
                  aria-label="搜索图片记忆"
                  placeholder="搜索描述、发言者或消息关键词"
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
                  {busy ? '正在处理…' : '保存已有图片'}
                </Button>
                <Button icon="refresh" disabled={busy} onClick={() => void reload(true).catch((failure) => setError(failure.message))}>
                  重新读取图片记忆
                </Button>
              </div>
              <p className="wa-help wa-section-space" data-testid="image-memory-count">
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
                    <p className="wa-help">
                      {item.senderName || '会话成员'} · {formatTime(item.time || item.capturedAt, true)}
                    </p>
                    <span className="wa-badge">{quality(item.quality)}</span>
                    <p className="wa-image-description">
                      {item.type === 'face'
                        ? '表情包已保存，不调用图像理解。'
                        : item.description || '图片已保存，只有需要看图时才按需理解。'}
                    </p>
                    <p className="wa-help">
                      {item.expiresAt ? '保留至 ' + formatTime(item.expiresAt, true) : '长期保存'}
                    </p>
                  </article>
                ))}
              </div>
              {!doc.items.length && (
                <p className="wa-help wa-section-space">
                  {query
                    ? '当前会话没有匹配的图片记忆。'
                    : '此会话尚未保存图片。之后收到的图片会独立保存，也可保存仍可读取的已有图片。'}
                </p>
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
                  独立于微信缓存及文字窗口，压缩或清空文字记忆不会删除这些图片。删除后不从旧消息自动补回；聊天记录里的文字描述仍保留。
                </p>
                <Button danger disabled={busy || !doc.storedCount} onClick={() => setClearing(true)}>
                  清空此会话的图片记忆
                </Button>
                {clearing && (
                  <div className="wa-note-box">
                    <p>将删除此会话保存的图片和缩略图，并停止从现有旧消息补回。其他会话不受影响。</p>
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
        <div className="wa-image-modal">
          <section
            className="wa-card"
            role="dialog"
            aria-modal="true"
            aria-label="图片记忆预览"
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
              if (event.key === 'Tab') {
                const controls = Array.from(event.currentTarget.querySelectorAll('button:not(:disabled)'));
                const first = controls[0],
                  last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <div className="wa-between">
              <h2>
                {quality(preview.item.quality)} · {preview.item.senderName || '会话成员'}
              </h2>
              <button className="wa-button" type="button" ref={closeButton} disabled={busy} onClick={close}>
                关闭图片预览
              </button>
            </div>
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
            <p className="wa-image-description">{preview.item.description}</p>
            <p className="wa-help">
              来源：{peerName(selected)} · {formatTime(preview.item.time || preview.item.capturedAt, true)}。
              {quality(preview.item.quality)}。
            </p>
            <Button danger disabled={busy} onClick={() => setRemoving(true)}>
              删除这张图片记忆
            </Button>
            {removing && (
              <div className="wa-note-box wa-image-delete">
                <p>删除保存图片及缩略图，不从原消息自动补回。聊天记录中的文字描述保留。</p>
                <Button
                  danger
                  disabled={busy}
                  onClick={async () => {
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
          </section>
        </div>
      )}
    </>
  );
}
