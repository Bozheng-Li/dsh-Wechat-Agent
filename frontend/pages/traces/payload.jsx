import { useEffect, useRef, useState } from 'react';

export function TracePayload({ rpc, accountId, traceId, reference, inline, title }) {
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const [state, setState] = useState({ value: inline, error: '' }), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (inline) { setState({ value: inline, error: '' }); return; }
    if (!reference?.id) { setState({ value: null, error: '' }); return; }
    const controller = new AbortController();
    setState({ value: null, error: '', loading: true });
    rpcRef.current('traces.content', { accountId, traceId, contentId: reference.id }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setState({ value, error: '' }); })
      .catch(error => { if (!controller.signal.aborted) setState({ value: null, error: error.message }); });
    return () => controller.abort();
  }, [accountId, traceId, reference?.id, inline, retry]);
  if (!reference && !inline) return null;
  return <section className="wa-trace-payload">
    <h4>{title}</h4>
    {state.loading && <p role="status">正在读取详情…</p>}
    {state.error && <p role="alert">{state.error} <button type="button" className="wa-trace-text-button" onClick={() => setRetry(value => value + 1)}>重试读取</button></p>}
    {state.value && <>
      {state.value.limited && <p className="wa-trace-warning">此项内容超过记录上限，已明确标记省略位置。</p>}
      <pre tabIndex={0}>{typeof state.value.value === 'string' ? state.value.value : JSON.stringify(state.value.value, null, 2)}</pre>
      {(state.value.binaryOmitted > 0 || state.value.credentialsHidden > 0) && <small>媒体保留引用与摘要；凭据已隐藏。</small>}
    </>}
  </section>;
}
