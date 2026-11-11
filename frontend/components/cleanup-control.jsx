import { useEffect, useRef, useState } from 'react';
import { Button } from './workbench-ui.jsx';

/** The server freezes the full scope before confirmation, including rows off-page. */
export function CleanupControl({ state, kind, ids, label = '一键清空', disabled = false, onDone }) {
  const [preview, setPreview] = useState(null), [working, setWorking] = useState(false);
  const mounted = useRef(true), lock = useRef(false), scope = JSON.stringify([kind, ids]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setPreview(null); }, [scope]);
  const execute = async confirm => {
    if (lock.current) return;
    lock.current = true; setWorking(true);
    try {
      const result = await state.execute(confirm ? 'cleanup.delete' : 'cleanup.preview', confirm ? { token: preview.token } : { kind, ...(ids ? { ids } : {}) }, confirm);
      if (!mounted.current || !result) return;
      if (confirm) { setPreview(null); state.setNotice?.(result.warning || `已清理 ${result.deleted} 条记录。`); onDone?.(); }
      else setPreview(result);
    } finally { lock.current = false; if (mounted.current) setWorking(false); }
  };
  return <div className="wa-cleanup-control">
    <Button quiet danger disabled={disabled || state.busy || working || ids?.length === 0} onClick={() => execute(false)}>{working ? '正在处理…' : label}</Button>
    {preview && <div className="wa-alert" role="alert">
      <p><strong>{preview.label}：将删除 {preview.count} 条</strong>（{preview.scope}）</p>
      <p>{preview.note}</p>
      {!!preview.protectedCount && <p>另有 {preview.protectedCount} 条正在处理或需要核对结果，已保留。</p>}
      <p>确认后新增的记录不在本次范围内。</p>
      <div className="wa-wb-actions"><Button danger disabled={working || state.busy || !preview.count} onClick={() => execute(true)}>确认删除 {preview.count} 条</Button>
        <Button quiet disabled={working} onClick={() => setPreview(null)}>取消清理</Button></div>
    </div>}
  </div>;
}
