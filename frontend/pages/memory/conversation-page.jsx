import { useEffect, useRef, useState } from 'react';
import { conversationKey, formatTime, peerName } from "../../shared/conversations.mjs";
import { MemoryOverview } from "./visuals.jsx";
import { samePeer, selector } from "../../shared/peers.mjs";
import { Button, Alert, Field } from "../../components/automation-ui.jsx";
import { RoomPicker } from "../../components/room-picker.jsx";
import { PageHead } from '../../components/page-ui.jsx';
import { Glyph } from '../../components/glyph.jsx';

export function MemoryPage({ rpc, status, rows, initialPeer }) {
  const [selected, setSelected] = useState(() => initialPeer || rows[0] || null),
    [list, setList] = useState(null),
    [doc, setDoc] = useState(null);
  const [windowChars, setWindowChars] = useState(String(status.memory?.windowChars || 100000)),
    [summary, setSummary] = useState(''),
    [base, setBase] = useState(null);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmClear, setConfirmClear] = useState(false);
  const draft = useRef({ summary, base });
  draft.current = { summary, base };
  const current = useRef(selected);
  current.current = selected;
  const accountId = status.account?.id;
  const pendingAction = useRef(false);
  const compressionRequest = useRef(null);
  const reload = async (force = false, signal) => {
    if (!accountId) return;
    const data = await rpc('memory.list', { accountId }, signal);
    if (signal?.aborted) return;
    setList(data);
    const selectedAtStart = current.current;
    if (selectedAtStart) {
      const next = await rpc('memory.get', selector(status, selectedAtStart), signal);
      if (signal?.aborted || !samePeer(current.current, selectedAtStart)) return;
      setDoc(next);
      if (compressionRequest.current && samePeer(selectedAtStart, compressionRequest.current.peer) &&
          next.compressions > compressionRequest.current.compressions && !next.compacting && !next.compressionQueued) {
        setNotice('记忆已压缩，原文快照已保留。');
        compressionRequest.current = null;
      }
      if (force || !draft.current.base || draft.current.summary === draft.current.base.summary) {
        setSummary(next.summary);
        setBase(next);
      }
      return next;
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        await reload(false, controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [accountId, selected && conversationKey(selected)]);
  const act = async (endpoint, payload, success) => {
    if (pendingAction.current) return;
    pendingAction.current = true;
    const selectedAtStart = current.current;
    setBusy(endpoint);
    setError('');
    setNotice('');
    try {
      if (endpoint === 'memory.compress') compressionRequest.current = { peer: selectedAtStart, compressions: doc.compressions };
      await rpc(endpoint, payload);
      if ((current.current || selectedAtStart) && !samePeer(current.current, selectedAtStart)) return;
      const updated = await reload(endpoint !== 'memory.compress');
      setNotice(
        endpoint === 'memory.retryImages'
          ? updated?.failedImages > 0
            ? `重试已结束，仍有 ${updated.failedImages} 张普通图片未理解，请查看下方失败原因。`
            : updated?.lowQualityImages > 0
              ? `重试已结束，仍有 ${updated.lowQualityImages} 张图片的清晰度未核实，已有笔记继续保留。`
              : '图片重试已结束，理解结果已更新。'
          : endpoint === 'memory.compress' && (updated?.compacting || updated?.compressionQueued ||
              updated?.compressions === compressionRequest.current?.compressions)
            ? '压缩已安排，完成后摘要会自动更新；聊天回复继续优先处理。'
            : success
      );
      setConfirmClear(false);
    } catch (failure) {
      if (endpoint === 'memory.compress') compressionRequest.current = null;
      setError(failure.message);
    } finally {
      pendingAction.current = false;
      setBusy('');
    }
  };
  const choose = (peer) => {
    if (pendingAction.current) return;
    setSelected(peer);
    current.current = peer;
    setDoc(null);
    setSummary('');
    setBase(null);
    draft.current = { summary: '', base: null };
    setConfirmClear(false);
    setError('');
    setNotice('');
    compressionRequest.current = null;
  };
  return (
    <>
      <PageHead icon="chat" title="会话记忆" description="各会话独立保留近期上下文，达到窗口后整理为摘要。" />
      <Alert text={error} />
      {notice && (
        <p className="wa-alert is-success" role="status">
          {notice}
        </p>
      )}
      {!accountId ? (
        <div className="wa-empty">
          <div className="wa-empty-icon"><Glyph name="memory" /></div>
          <h3>先连接微信账号</h3>
          <p>连接后可查看这个账号的会话记忆。</p>
        </div>
      ) : (
        <section className="wa-memory-document">
          <div className="wa-memory-scope">
            <RoomPicker rows={rows} value={selected} onChange={choose} disabled={!!busy} />
          </div>
          {doc ? (
            <div className="wa-memory-content" data-testid="memory-document">
              <MemoryOverview document={doc} name={peerName(selected)} />
              <div className="wa-document-heading">
                <div>
                  <h2>摘要与补充</h2>
                  <p className="wa-help">修正这段会话的背景，近期原文会继续附在后面。</p>
                </div>
                <Button
                  disabled={!!busy || summary !== base?.summary}
                  onClick={() => {
                    void reload(true).catch((failure) => setError(failure.message));
                  }}
                >
                  重新读取记忆
                </Button>
              </div>
              <Alert text={doc.error} />
              {doc.retryAt && !doc.compacting && (
                <p className="wa-help" role="status">
                  {doc.retryKind === 'yield' ? '已优先让位聊天回复，记忆整理会继续' :
                    doc.retryKind === 'extraction' ? '长期记忆提取会自动重试' : '压缩失败后会自动重试'}，
                  下一次：{formatTime(doc.retryAt, true)}。原文继续保留。
                </p>
              )}
              <Alert text={doc.imageMemoryError} />
              {(doc.failedImages > 0 || doc.lowQualityImages > 0) && (
                <div className="wa-note-box">
                  {doc.failedImages > 0 && <p>{doc.failedImages} 张图片暂未理解，记忆中保留了失败原因。</p>}
                  {doc.imageFailures?.length > 0 && (
                    <ul className="wa-help" data-testid="image-failure-reasons">
                      {doc.imageFailures.map(({ reason, count }) => (
                        <li key={reason}>
                          {count} 张：{reason}
                        </li>
                      ))}
                    </ul>
                  )}
                  {doc.lowQualityImages > 0 && (
                    <p>{doc.lowQualityImages} 张图片仅有缩略图笔记或尚未核实清晰度，可以重新获取清晰图片后理解。</p>
                  )}
                  <Button
                    disabled={!!busy || status.modelConfig.vision === false || !selected.authorized}
                    onClick={() =>
                      act(
                        'memory.retryImages',
                        selector(status, selected),
                        '已重新获取图片并重试理解，未取得清晰图片的笔记会保留清晰度提示。'
                      )
                    }
                  >
                    {busy === 'memory.retryImages' ? '正在重新理解…' : '重试图片理解'}
                  </Button>
                  {status.modelConfig.vision === false && (
                    <p className="wa-help">请先在模型的高级设置中启用图像理解。</p>
                  )}
                </div>
              )}
              <div className="wa-memory-editor">
              <Field label="已保存的记忆摘要" help="需要长期保留的共同约定，可写入长期记忆。">
                <textarea
                  className="wa-textarea"
                  aria-label="记忆摘要"
                  rows={6}
                  maxLength={100000}
                  value={summary}
                  disabled={!!busy}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </Field>
              <div className="wa-document-actions">
                <div className="wa-row">
                <Button
                  primary
                  disabled={!!busy || summary === base?.summary}
                  onClick={() =>
                    act(
                      'memory.edit',
                      { ...selector(status, selected), summary, revision: base.revision },
                      '记忆摘要已保存。'
                    )
                  }
                >
                  保存记忆
                </Button>
                <Button
                  disabled={!!busy || summary === base?.summary}
                  onClick={() => {
                    setSummary(doc.summary);
                    setBase(doc);
                  }}
                >
                  撤销修改
                </Button>
                </div>
                <Button
                  disabled={!!busy || doc.compacting || doc.compressionQueued || !doc.text?.trim() || !selected.authorized}
                  onClick={() => act('memory.compress', selector(status, selected), '记忆已压缩，原文快照已保留。')}
                >
                  {doc.compacting ? '正在压缩…' : busy === 'memory.compress' || doc.compressionQueued ? '等待压缩…' : '立即压缩'}
                </Button>
              </div>
              <p className="wa-help">可提前压缩现有内容，原文快照保留。</p>
              </div>
              <section className="wa-memory-reference" aria-label="记忆参考与维护">
              <details className="wa-subsection">
                <summary>查看本次会带给 Agent 的完整记忆</summary>
                <pre className="wa-memory-preview">{doc.text || '暂时没有记忆，新的授权会话消息会自动写入。'}</pre>
              </details>
              <details className="wa-subsection">
                <summary>记忆文件保存位置</summary>
                <div className="wa-path-value">{doc.path}</div>
                <p className="wa-help">
                  这是独立的记忆文件；聊天处理记录保存在另一个目录。压缩前的记忆保留在旁边的 archive 目录。
                </p>
              </details>
              <div className="wa-subsection">
                <Button danger disabled={!!busy} onClick={() => setConfirmClear(true)}>
                  清空当前记忆
                </Button>
                {confirmClear && (
                  <div className="wa-note-box">
                    <p>
                      清空“{peerName(selected)}
                      ”的文字窗口后，从新消息开始积累。聊天记录和旧快照仍保留，但不会自动回填；已保存图片在“图片记忆”中单独管理。
                    </p>
                    <div className="wa-row">
                      <Button
                        danger
                        disabled={!!busy}
                        onClick={() =>
                          act('memory.clear', selector(status, selected), '当前记忆已清空，将从新消息开始积累。')
                        }
                      >
                        确认清空这份记忆
                      </Button>
                      <Button disabled={!!busy} onClick={() => setConfirmClear(false)}>
                        返回
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              </section>
            </div>
          ) : (
            <p className="wa-help wa-section-space">
              {selected ? '正在读取记忆…' : '选择一个会话，查看它记住了什么。'}
            </p>
          )}
        </section>
      )}
      <details className="wa-memory-preferences" data-testid="memory-preferences">
        <summary>
          <span>记忆窗口设置</span>
          <span>默认 {list?.windowChars || status.memory?.windowChars || 100000} 字</span>
        </summary>
        <section className="wa-memory-preferences-body">
          <h2>默认记忆窗口</h2>
          <p className="wa-help">
            记忆窗口按字符计算，与每轮模型的上下文额度分别管理。原文和压缩前快照独立保留。
          </p>
          <div className="wa-row wa-section-space wa-window-setting">
            <input
              className="wa-input"
              type="number"
              min="1000"
              step="1"
              aria-label="默认记忆窗口字符数"
              value={windowChars}
              onChange={(event) => setWindowChars(event.target.value)}
            />
            <span>字符</span>
            <Button
              disabled={!!busy || !Number.isSafeInteger(Number(windowChars)) || Number(windowChars) < 1000}
              onClick={() => act('memory.configure', { windowChars: Number(windowChars) }, '默认记忆窗口已保存。')}
            >
              保存窗口
            </Button>
          </div>
          <p className="wa-help">
            至少 1000 字符；可在“会话设置”中单独覆盖。
          </p>
        </section>
      </details>
    </>
  );
}
