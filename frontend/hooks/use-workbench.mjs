import { useEffect, useRef, useState } from 'react';
import { MATERIAL_ORGANIZE_TIMEOUT_MS } from '../../shared/moments-materials.mjs';

export function useWorkbench(rpc, accountId, endpoint, refreshKey = '', pollMs = 0) {
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [refreshError, setRefreshError] = useState('');
  const api = useRef(rpc),
    current = useRef(null),
    live = useRef(false),
    generation = useRef(0),
    reads = useRef(0);
  api.current = rpc;
  const load = async (signal, epoch = generation.current) => {
    const read = ++reads.current,
      value = await api.current(endpoint, { accountId }, signal);
    if (!signal?.aborted && live.current && epoch === generation.current && read === reads.current) setData(value);
    return value;
  };
  useEffect(() => {
    live.current = true;
    generation.current++;
    current.current = null;
    const controller = new AbortController();
    setData(null);
    setError('');
    setNotice('');
    setRefreshError('');
    setBusy(false);
    setLoading(true);
    if (accountId)
      load(controller.signal)
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    else setLoading(false);
    return () => {
      live.current = false;
      controller.abort();
      current.current?.abort();
    };
  }, [accountId, endpoint, refreshKey]);
  useEffect(() => {
    if (!accountId || !pollMs) return;
    const controller = new AbortController(), epoch = generation.current;
    let timer;
    const poll = async () => {
      try {
        await load(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), epoch);
        if (!controller.signal.aborted && epoch === generation.current) setRefreshError('');
      } catch {
        if (!controller.signal.aborted && epoch === generation.current) setRefreshError('状态自动刷新暂不可用，当前显示可能不是最新结果。');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, pollMs);
      }
    };
    timer = setTimeout(poll, pollMs);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [accountId, endpoint, refreshKey, pollMs]);
  const execute = async (method, payload = {}, reload = true) => {
    if (!accountId || current.current) return null;
    const controller = new AbortController(),
      epoch = generation.current;
    const owns = () => live.current && generation.current === epoch && current.current === controller;
    current.current = controller;
    reads.current++;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await api.current(
        method,
        { ...payload, accountId },
        AbortSignal.any([controller.signal, AbortSignal.timeout(method === 'moments.materials.organize' ? MATERIAL_ORGANIZE_TIMEOUT_MS + 15000 : 300000)])
      );
      if (controller.signal.aborted || !owns()) return null;
      if (reload) await load(controller.signal, epoch);
      return owns() && !controller.signal.aborted ? value : null;
    } catch (error) {
      if (owns())
        setError(
          controller.signal.aborted
            ? '操作已取消；请重新读取以核对已经完成的步骤。'
            : error.message || '操作未完成，请重试'
        );
      return null;
    } finally {
      if (owns()) {
        current.current = null;
        setBusy(false);
      }
    }
  };
  return {
    data,
    error,
    notice,
    setNotice,
    busy,
    loading,
    refreshError,
    execute,
    refresh: (preserveFeedback = false) => preserveFeedback === true
      ? load(AbortSignal.timeout(10000)).catch(() => null)
      : execute(endpoint, {}, false).then((value) => {
        if (value) setData(value);
      }),
    cancel: () => current.current?.abort(),
    setData,
  };
}
