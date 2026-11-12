import { useEffect, useRef, useState } from 'react';
import { timeOperationTimeoutMs } from '../../../shared/time-settings.mjs';

const recentRounds = new Map();
const empty = () => ({ runs: [], current: null, running: false, activeId: null });
export function useInteractions(rpc, accountId, timeSettings) {
  const [data, setData] = useState(empty), [busy, setBusy] = useState(''), [error, setError] = useState(''), [refreshError, setRefreshError] = useState(''), [cancelling, setCancelling] = useState(false);
  const api = useRef(rpc), live = useRef(false), chosen = useRef(recentRounds.get(accountId)), reads = useRef(0),
    requests = useRef(new Set()), operation = useRef(null), reading = useRef(false);
  api.current = rpc;
  const refresh = async (id = chosen.current, explicit = false) => {
    const serial = ++reads.current, controller = new AbortController(); requests.current.add(controller);
    if (explicit) { chosen.current = id; setError(''); }
    try {
      const result = await api.current('moments.interactions.list', { accountId, ...(id ? { id } : {}) }, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      if (!live.current || controller.signal.aborted || serial !== reads.current) return null;
      if (result.accountId !== accountId) throw new Error('账号已变化，请重新读取互动记录。');
      if (!id && (result.activeId || result.runs[0]?.id)) return refresh(result.activeId || result.runs[0].id, true);
      if (id) recentRounds.set(accountId, id);
      setData(result); setRefreshError(''); return result.current;
    } catch (err) {
      if (live.current && !controller.signal.aborted && serial === reads.current) {
        setRefreshError(err.message || '互动状态暂未刷新，当前显示可能不是最新结果。');
        if (err.code === 'MOMENTS_INTERACTION_NOT_FOUND') { chosen.current = null; recentRounds.delete(accountId); setData(empty()); }
      }
      return null;
    } finally { requests.current.delete(controller); }
  };
  useEffect(() => {
    live.current = true;
    if (accountId) void refresh();
    const timer = setInterval(async () => {
      if (!accountId || operation.current || reading.current) return;
      reading.current = true; try { await refresh(); } finally { reading.current = false; }
    }, 2500);
    return () => { live.current = false; reads.current++; clearInterval(timer); for (const controller of requests.current) controller.abort(); };
  }, [accountId]);
  const execute = async (action, payload) => {
    if (!accountId || operation.current) return null;
    const controller = new AbortController(); requests.current.add(controller); operation.current = controller; reads.current++;
    setBusy(action); setError('');
    try {
      const cleanup = action.startsWith('cleanup.');
      const result = await api.current(cleanup ? action : 'moments.interactions.' + action, { ...payload, accountId }, AbortSignal.any([controller.signal, AbortSignal.timeout(timeOperationTimeoutMs(timeSettings, 'moments.interactions.' + action))]));
      if (!live.current || controller.signal.aborted) return null;
      if (cleanup) { if (action === 'cleanup.delete') await refresh(); return result; }
      if (result.accountId !== accountId) throw new Error('账号已变化，请重新读取互动记录。');
      if (['configure', 'stop'].includes(action)) {
        reads.current++; setData(previous => ({ ...previous, automation: result })); setRefreshError(''); return result;
      }
      reads.current++; chosen.current = result.id; recentRounds.set(accountId, result.id);
      setData(previous => ({ ...previous, current: result, runs: [result, ...previous.runs.filter(row => row.id !== result.id)],
        ...(action === 'run' ? { running: result.state === 'running', activeId: result.state === 'running' ? result.id : null } : {}) }));
      setRefreshError(''); return result;
    } catch (err) {
      if (live.current && !controller.signal.aborted) { setError(err.message || '操作未获确认，请先刷新本轮状态。'); await refresh(); }
      return null;
    } finally {
      requests.current.delete(controller); if (operation.current === controller) operation.current = null;
      if (live.current) setBusy('');
    }
  };
  const cancelGeneration = async id => {
    if (cancelling) return;
    const controller = new AbortController(); requests.current.add(controller); setCancelling(true);
    try { await api.current('moments.interactions.cancel', { accountId, id }, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])); }
    catch (err) { if (live.current && !controller.signal.aborted) setError(err.message || '停止请求尚未确认。'); }
    finally { requests.current.delete(controller); if (live.current) setCancelling(false); }
  };
  return { data, busy, error, refreshError, execute, refresh, cancelling, cancelGeneration,
    select: id => !operation.current ? refresh(id, true) : Promise.resolve(null),
    clear: () => { reads.current++; chosen.current = null; recentRounds.delete(accountId); setData(previous => ({ ...previous, current: null })); },
  };
}
