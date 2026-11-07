import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../../shared/conversations.mjs';
import { Button, Tag, Heading, Empty, Feedback, Offline } from '../../components/workbench-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';

export const blankLibrary = { title: '', description: '', enabled: false, scopes: [] };

export function KnowledgePage({ rpc, status }) {
  const state = useWorkbench(rpc, status.account?.id, 'knowledge.list'),
    [selected, setSelected] = useState(''),
    [form, setForm] = useState(null),
    [query, setQuery] = useState(''),
    [results, setResults] = useState(null),
    [document, setDocument] = useState(null),
    [docLimit, setDocLimit] = useState(15),
    [progress, setProgress] = useState(null),
    [deleteTarget, setDeleteTarget] = useState(null),
    [uploadError, setUploadError] = useState('');
  const uploadController = useRef(null),
    fileInput = useRef(null),
    live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      uploadController.current?.abort();
    };
  }, []);
  const libraries = state.data?.libraries || [],
    library = libraries.find((item) => item.id === selected),
    documents = (state.data?.documents || []).filter((doc) => doc.libraryId === selected),
    peers = (status.conversations || []).filter((peer) => peer.authorized),
    busy = state.busy || progress !== null;
  const enabled = state.data?.settings?.enabled === true,
    index = state.data?.index;
  const toggleLock = useRef(false),
    [switching, setSwitching] = useState(false);
  const toggleQueries = async () => {
    if (toggleLock.current) return;
    toggleLock.current = true;
    setSwitching(true);
    try {
      const value = await state.execute(
        'knowledge.settings',
        { enabled: !enabled, revision: state.data.revision },
        true,
        { interrupt: enabled }
      );
      if (value) {
        setResults(null);
        state.setNotice(
          value.settings.enabled
            ? '已开启按需查询。普通聊天仍不会查知识库。'
            : '知识库查询已关闭，进行中的查询已停止；原文与会话范围已保留。'
        );
      }
    } finally {
      toggleLock.current = false;
      if (live.current) setSwitching(false);
    }
  };
  useEffect(() => {
    setResults(null);
  }, [state.data?.revision]);
  const select = (id) => {
    setSelected(id);
    setResults(null);
    setDocument(null);
    setDeleteTarget(null);
  };
  const upload = async (file) => {
    if (!file || !library || busy) return;
    if (file.size > 12 * 1024 * 1024) {
      setUploadError('每个文件最多 12 MiB，请拆分后导入。');
      return;
    }
    const controller = new AbortController();
    uploadController.current = controller;
    let uploadId;
    setProgress(0);
    setUploadError('');
    try {
      const invoke = (endpoint, payload, signal = controller.signal) =>
        rpc(endpoint, { accountId: status.account.id, ...payload }, signal);
      const result = await invoke('knowledge.upload.start', {
        libraryId: library.id,
        name: file.name,
        size: file.size,
      });
      uploadId = result.uploadId;
      for (let offset = 0; offset < file.size; offset += 192 * 1024) {
        controller.signal.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(offset, offset + 192 * 1024).arrayBuffer());
        let binary = '';
        for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
        await invoke('knowledge.upload.chunk', { uploadId, offset, data: btoa(binary) });
        if (live.current) setProgress(Math.min(99, Math.round(((offset + bytes.length) / file.size) * 100)));
      }
      const done = await invoke('knowledge.upload.finish', { uploadId });
      uploadId = null;
      if (live.current) {
        await state.refresh();
        state.setNotice(
          done.duplicate ? '相同文件已存在，没有重复导入。' : '原文已保存。首次明确查询时建立本地索引，也可以手动重建。'
        );
      }
    } catch (error) {
      if (live.current) setUploadError(controller.signal.aborted ? '导入已取消；请刷新核对文档列表。' : error.message);
    } finally {
      if (uploadId) {
        try {
          await rpc('knowledge.upload.abort', { accountId: status.account.id, uploadId }, AbortSignal.timeout(5000));
        } catch {}
      }
      uploadController.current = null;
      if (live.current) setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const runQuery = async (ask) => {
    setResults(null);
    const value = await state.execute(ask ? 'knowledge.ask' : 'knowledge.search', {
      query,
      ...(selected ? { libraryId: selected } : {}),
    });
    if (value) setResults(value);
  };
  return (
    <section className="wa-wb-page" data-testid="knowledge-page">
      <Heading number="05" title="知识库" text="把自己的资料交给 Agent，回答有据可查。">
        <Button quiet disabled={busy} onClick={state.refresh}>
          重新读取
        </Button>
        <Button disabled={busy || !status.account || !!form} onClick={() => setForm({ ...blankLibrary })}>
          新建知识库
        </Button>
      </Heading>
      <Feedback state={state} />
      {uploadError && (
        <div className="wa-alert is-error" role="alert">
          {uploadError}
        </div>
      )}
      <Offline status={status}>
        <article
          className={'wa-wb-card wa-wb-knowledge-control' + (enabled ? ' is-enabled' : '')}
          aria-label="知识库查询设置"
        >
          <div className="wa-wb-between">
            <div>
              <div className="wa-wb-eyebrow">ON YOUR REQUEST</div>
              <h2>你指定，才查询</h2>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="知识库查询总开关"
              aria-checked={enabled}
              disabled={!state.data || state.loading || switching || (busy && !enabled)}
              className="wa-wb-switch"
              onClick={toggleQueries}
            >
              <span aria-hidden="true" />
              <strong>{switching ? '正在保存' : enabled ? '已开启' : '已关闭'}</strong>
            </button>
          </div>
          <p>
            {enabled
              ? '仅响应当前消息中的明确查询请求。日常聊天、主动参与和定时任务不会自动查资料。'
              : '默认关闭查询。你仍可导入、整理和阅读原文；开启后也只响应明确请求。'}
          </p>
          <div className="wa-wb-knowledge-flow">
            <div>
              <span>01 · 明确请求</span>
              <strong>查知识库：退款期限</strong>
              <small>或发送 /kb 退款期限</small>
            </div>
            <div>
              <span>02 · 本地检索</span>
              <strong>一次，最多 4 段</strong>
              <small>最多 3000 字，无检索模型用量</small>
            </div>
            <div>
              <span>03 · 按原文回答</span>
              <strong>命中后调用模型一次</strong>
              <small>未命中直接说明，不自动重查</small>
            </div>
          </div>
        </article>
        <div className="wa-wb-strip">
          <div>
            <span>知识库</span>
            <strong>{libraries.length}</strong>
          </div>
          <div>
            <span>已保存文档</span>
            <strong>{state.data?.documents.length || 0}</strong>
          </div>
          <div>
            <span>已保存文字</span>
            <strong>{(state.data?.totalChars || 0).toLocaleString()} 字</strong>
          </div>
          <span className="wa-wb-note">Markdown / TXT / PDF / DOCX</span>
        </div>
        <div className="wa-wb-index" aria-label="本地索引状态">
          <div>
            <strong>
              本地全文索引 · {index?.state === 'ready' ? '已就绪' : index?.state === 'building' ? '建立中' : '待建立'}
            </strong>
            <p>
              {index?.state === 'ready'
                ? `${index.documents} 份文档 · ${index.chunks} 个分段 · ${formatTime(index.builtAt)}`
                : '首次明确查询时建立。导入不会调用模型，原文已独立保存。'}
            </p>
            <small>无嵌入模型 · 按关键词匹配，返回原文与出处</small>
          </div>
          <Button
            quiet
            disabled={busy || !state.data?.documents.length}
            onClick={async () => {
              if (await state.execute('knowledge.index.rebuild')) state.setNotice('本地全文索引已重建，未调用模型。');
            }}
          >
            重建本地索引
          </Button>
        </div>
        {form && (
          <form
            className="wa-wb-card wa-wb-library-form"
            aria-label="知识库设置"
            onSubmit={async (event) => {
              event.preventDefault();
              const value = await state.execute('knowledge.configure', {
                ...form,
                libraryId: form.id,
                revision: state.data.revision,
              });
              if (value) {
                setSelected(form.id || value.libraries[value.libraries.length - 1].id);
                setForm(null);
              }
            }}
          >
            <h2>{form.id ? '编辑知识库' : '新建知识库'}</h2>
            <div className="wa-wb-form-grid">
              <label>
                名称
                <input
                  aria-label="知识库名称"
                  value={form.title}
                  maxLength={80}
                  required
                  disabled={busy}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </label>
              <label>
                用途说明
                <input
                  aria-label="知识库说明"
                  value={form.description}
                  maxLength={1000}
                  disabled={busy}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </label>
            </div>
            <label className="wa-wb-check">
              <input
                type="checkbox"
                aria-label="启用会话知识检索"
                checked={form.enabled}
                disabled={busy}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              允许 Agent 在以下会话中检索这份知识库
            </label>
            <div className="wa-wb-scope-grid">
              {peers.map((peer) => (
                <label className="wa-wb-check" key={peer.key}>
                  <input
                    type="checkbox"
                    checked={form.scopes.includes(peer.key)}
                    disabled={busy}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        scopes: event.target.checked
                          ? [...form.scopes, peer.key]
                          : form.scopes.filter((key) => key !== peer.key),
                      })
                    }
                  />
                  {peer.name}
                </label>
              ))}
            </div>
            {!peers.length && <p className="wa-wb-note">尚无授权会话，可以先保存和整理资料。</p>}
            <div className="wa-wb-actions">
              <button className="wa-wb-button" type="submit" disabled={busy || !form.title.trim()}>
                保存知识库
              </button>
              <Button quiet disabled={busy} onClick={() => setForm(null)}>
                取消
              </Button>
            </div>
          </form>
        )}
        <div className="wa-wb-library-grid">
          {libraries.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={'wa-wb-library-card' + (item.id === selected ? ' is-selected' : '')}
              disabled={busy}
              onClick={() => select(item.id)}
            >
              <div className="wa-wb-between">
                <span className="wa-wb-number">{String(index + 1).padStart(2, '0')}</span>
                <Tag state={enabled && item.enabled ? 'passed' : 'disabled'}>
                  {!enabled ? '查询已关闭' : item.enabled ? '会话按需可查' : '仅管理员整理'}
                </Tag>
              </div>
              <h2>{item.title}</h2>
              <p>{item.description || '为对话提供有来源的参考资料。'}</p>
              <footer>
                <span>
                  {state.data.documents.filter((doc) => doc.libraryId === item.id).length} 份文档 · {item.scopes.length}{' '}
                  个会话
                </span>
                <span aria-hidden="true">↗</span>
              </footer>
            </button>
          ))}
        </div>
        {!libraries.length && !state.loading && (
          <Empty title="建立你的第一份知识库">产品资料、FAQ、学习笔记或项目文档，都可以按用途分开管理。</Empty>
        )}
        {library && (
          <div className="wa-wb-split wa-wb-knowledge-detail">
            <article className="wa-wb-card">
              <div className="wa-wb-between">
                <div>
                  <div className="wa-wb-eyebrow">DOCUMENTS</div>
                  <h2>{library.title}</h2>
                </div>
                <Button
                  quiet
                  disabled={busy || !!form}
                  onClick={() =>
                    setForm({
                      ...library,
                      scopes: library.scopes.filter((key) => peers.some((peer) => peer.key === key)),
                    })
                  }
                >
                  编辑设置
                </Button>
              </div>
              <div
                className="wa-wb-upload"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!busy) void upload(event.dataTransfer.files[0]);
                }}
              >
                <span aria-hidden="true">↥</span>
                <strong>
                  {progress === null
                    ? '选择文件，或拖到这里'
                    : progress >= 99
                      ? '正在解析文档…'
                      : `已上传 ${progress}%`}
                </strong>
                <p>每份最多 12 MiB、50 万字。PDF 最多 250 页；扫描件请先做 OCR。</p>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".md,.markdown,.txt,.pdf,.docx"
                  aria-label="导入知识文档"
                  disabled={busy}
                  onChange={(event) => void upload(event.target.files[0])}
                />
                {progress !== null && (
                  <>
                    <progress max="100" value={progress} aria-label="导入进度" />
                    <Button quiet onClick={() => uploadController.current?.abort()}>
                      取消导入
                    </Button>
                  </>
                )}
              </div>
              <div className="wa-wb-document-list">
                {documents.map((doc) => (
                  <div className="wa-wb-document" key={doc.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        const value = await state.execute('knowledge.document', { documentId: doc.id }, false);
                        if (value) {
                          setDocument(value);
                          setDocLimit(15);
                        }
                      }}
                    >
                      <strong>{doc.title}</strong>
                      <small>
                        {doc.chars.toLocaleString()} 字 · {doc.chunks} 个分段
                      </small>
                    </button>
                    <Button
                      quiet
                      disabled={busy}
                      onClick={() => setDeleteTarget({ documentId: doc.id, title: doc.title })}
                    >
                      删除
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                quiet
                danger
                disabled={busy}
                onClick={() => setDeleteTarget({ libraryId: library.id, title: library.title })}
              >
                删除整个知识库
              </Button>
            </article>
            <article className="wa-wb-card">
              <div className="wa-wb-eyebrow">RETRIEVAL STUDIO</div>
              <h2>先检索，再回答</h2>
              <p className="wa-wb-note">
                {enabled
                  ? '手动查询选中的知识库，包括尚未开放给会话的资料。'
                  : '先开启上方的查询总开关，即可在这里核对原文。'}
              </p>
              <label>
                问题或关键词
                <textarea
                  aria-label="知识库问题"
                  value={query}
                  maxLength={200}
                  disabled={busy}
                  placeholder="例如：产品退款期限是多少？"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="wa-wb-actions">
                <Button quiet disabled={busy || !enabled || !query.trim()} onClick={() => runQuery(false)}>
                  检索原文
                </Button>
                <Button disabled={busy || !enabled || !query.trim()} onClick={() => runQuery(true)}>
                  依据资料回答
                </Button>
              </div>
              <p className="wa-wb-note">检索原文：不调用模型。依据资料回答：命中后调用一次模型，按所选模型计费。</p>
              {results && (
                <div className="wa-wb-search-results" aria-live="polite">
                  {results.usage && (
                    <p className="wa-wb-note">
                      本次检索 {results.usage.queries} 次 · {results.usage.chunks} 段 / {results.usage.chars} 字 ·
                      回答模型 {results.usage.modelCalls} 次
                    </p>
                  )}
                  {results.answer && <div className="wa-wb-paper">{results.answer}</div>}
                  {!(results.sources || results.results)?.length && <p>没有找到匹配原文，可换用具体关键词。</p>}
                  {(results.sources || results.results || []).map((source) => (
                    <blockquote key={source.documentId + ':' + source.chunkId}>
                      <strong>{source.citation}</strong>
                      <p>{source.text}</p>
                      {source.truncated && <small>仅展示命中附近片段，可在左侧打开原文。</small>}
                    </blockquote>
                  ))}
                </div>
              )}
            </article>
          </div>
        )}
        {deleteTarget && (
          <div className="wa-wb-review" role="region" aria-label="确认删除资料">
            <h3>删除「{deleteTarget.title}」？</h3>
            <p>
              {deleteTarget.libraryId
                ? '此知识库及其索引文档将从插件移除。电脑上原始文件不受影响。'
                : '此文档将停止参与检索。电脑上原始文件不受影响。'}
            </p>
            <div className="wa-wb-actions">
              <Button
                danger
                disabled={busy}
                onClick={async () => {
                  if (await state.execute('knowledge.delete', { ...deleteTarget, revision: state.data.revision })) {
                    if (deleteTarget.libraryId) setSelected('');
                    setDocument(null);
                    setResults(null);
                    setDeleteTarget(null);
                  }
                }}
              >
                确认删除
              </Button>
              <Button quiet disabled={busy} onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
            </div>
          </div>
        )}
        {document && (
          <article className="wa-wb-card wa-wb-document-preview" aria-label="知识文档预览">
            <div className="wa-wb-between">
              <h2>{document.title}</h2>
              <Button quiet onClick={() => setDocument(null)}>
                收起预览
              </Button>
            </div>
            {document.chunks.slice(0, docLimit).map((chunk) => (
              <section key={chunk.id}>
                <small>
                  {chunk.label} · 段落 {chunk.id}
                </small>
                <p>{chunk.text}</p>
              </section>
            ))}
            {document.chunks.length > docLimit && (
              <Button quiet onClick={() => setDocLimit(docLimit + 20)}>
                继续阅读
              </Button>
            )}
          </article>
        )}
      </Offline>
    </section>
  );
}
