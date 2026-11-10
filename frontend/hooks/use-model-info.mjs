import { useCallback, useEffect, useState } from 'react';
import { modelKey } from "../shared/drafts.mjs";
import { call } from "../shared/rpc.mjs";

export function useModelInfo(connection, choice, catalogValue) {
  const provider = choice?.provider, model = choice?.model, key = modelKey(choice);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!provider || !model) return;
    const controller = new AbortController();
    const request = { key, attempt, catalogValue };
    setResult({ ...request, status: 'loading' });
    void call(connection, 'model.info', { selection: { provider, model } }, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setResult({ ...request, status: 'ready', value });
      })
      .catch(error => {
        if (!controller.signal.aborted) setResult({ ...request, status: 'error', error: error.message });
      });
    // Some transports still deliver a response after cancellation. Guard both paths.
    return () => controller.abort();
  }, [connection, provider, model, key, catalogValue, attempt]);
  const current = result?.key === key && result?.attempt === attempt && result?.catalogValue === catalogValue
    ? result : { status: key ? 'loading' : 'idle' };
  return { ...current, reload };
}
