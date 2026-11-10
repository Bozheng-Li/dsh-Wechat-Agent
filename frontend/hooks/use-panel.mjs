import { useEffect, useMemo, useRef, useState } from 'react';
import { useVisualMotion } from "../components/visuals.jsx";
import { emptyPersona } from '../../shared/contracts.mjs';
import { conversationKey, mergeConversations, peerId, peerType, splitLines } from "../shared/conversations.mjs";
import { pageLabels } from "../shared/labels.mjs";
import { same, personaDraft, modelDraft, storageDraft, configDraft, remoteDraft } from "../shared/drafts.mjs";
import { call } from "../shared/rpc.mjs";

export function usePanel(connection) {
  const motion = useVisualMotion();
  const [status, setStatus] = useState(null),
    [page, setPage] = useState('overview'),
    [returnPages, setReturnPages] = useState({});
  const [memoryTab, setMemoryTab] = useState('conversation');
  const [error, setError] = useState(''),
    [connectionError, setConnectionError] = useState(''),
    [busy, setBusy] = useState(''),
    [busyArea, setBusyArea] = useState(''),
    [notice, setNotice] = useState(null);
  const [contacts, setContacts] = useState(null),
    [authQuery, setAuthQuery] = useState(''),
    [authType, setAuthType] = useState('all'),
    [authTab, setAuthTab] = useState('authorized');
  const [detailKey, setDetailKey] = useState(null),
    [drafts, setDrafts] = useState({ persona: null, model: null, storage: null, remote: null, prompt: '', conversation: null });
  const [recordPeer, setRecordPeer] = useState(null),
    [recordQuery, setRecordQuery] = useState(''),
    [recordType, setRecordType] = useState('all');
  const [recordOffset, setRecordOffset] = useState(0),
    [recordAnchor, setRecordAnchor] = useState(null),
    [recordData, setRecordData] = useState(null),
    [recordLoading, setRecordLoading] = useState(false),
    [recordError, setRecordError] = useState(''),
    [recordEpoch, setRecordEpoch] = useState(0);
  const mounted = useRef(false),
    statusRef = useRef(null),
    draftsRef = useRef(drafts),
    busyRef = useRef(false),
    statusEpoch = useRef(0),
    detailRef = useRef(null),
    recordRequestEpoch = useRef(0),
    workspaceRef = useRef(null);
  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0, left: 0 });
  }, [page, detailKey, memoryTab]);
  const rows = useMemo(() => mergeConversations(status, contacts), [status, contacts]);
  const detail = rows.find((item) => conversationKey(item) === detailKey) || null;
  const recordRows = useMemo(
    () =>
      rows
        .filter((item) => item.authorized || item.hasArchive)
        .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)),
    [rows]
  );
  const recordSelected = recordPeer
    ? recordRows.find((item) => conversationKey(item) === conversationKey(recordPeer))
    : null;
  const setDraft = (name, value) => {
    const next = { ...draftsRef.current, [name]: value };
    draftsRef.current = next;
    setDrafts(next);
    setNotice((previous) =>
      previous?.area === name || (name === 'prompt' && previous?.area === 'model') ? null : previous
    );
  };
  const accept = (value, force = []) => {
    if (!mounted.current || !value) return;
    const previous = statusRef.current,
      accountChanged = (previous?.account?.id || null) !== (value.account?.id || null),
      next = { ...draftsRef.current };
    const sync = (field, before, after, forced = false) => {
      if (next[field] === null || same(next[field], before) || force.includes(field) || forced) next[field] = after;
    };
    sync('persona', personaDraft(previous?.persona), personaDraft(value.persona));
    sync('model', modelDraft(previous?.modelConfig), modelDraft(value.modelConfig));
    sync('storage', storageDraft(previous?.storage), storageDraft(value.storage));
    sync('remote', remoteDraft(previous?.remote), remoteDraft(value.remote));
    sync('prompt', previous?.settings?.prompt || '', value.settings?.prompt || '', accountChanged);
    if (accountChanged) {
      recordRequestEpoch.current++;
      setContacts(null);
      setRecordPeer(null);
      setRecordOffset(0);
      setRecordAnchor(null);
      setRecordData(null);
      setRecordError('');
      setMemoryTab('conversation');
      setDetailKey(null);
      detailRef.current = null;
      next.conversation = null;
      setNotice(null);
      setPage((current) => (current === 'conversation' ? 'authorization' : current));
    } else if (detailRef.current) {
      const before = previous?.conversations?.find((item) => conversationKey(item) === detailRef.current);
      const after = value.conversations?.find((item) => conversationKey(item) === detailRef.current);
      if (after)
        sync('conversation', configDraft(before?.config, previous?.persona), configDraft(after.config, value.persona));
    }
    draftsRef.current = next;
    setDrafts(next);
    statusRef.current = value;
    setStatus(value);
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      const epoch = statusEpoch.current;
      if (!busyRef.current) {
        try {
          const value = await call(
            connection,
            'status',
            {},
            AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])
          );
          if (!controller.signal.aborted && epoch === statusEpoch.current) {
            accept(value);
            setConnectionError('');
          }
        } catch (failure) {
          if (!controller.signal.aborted && epoch === statusEpoch.current) setConnectionError(failure.message);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
      statusEpoch.current++;
    };
  }, [connection]);
  const action = async (endpoint, payload = {}, options = {}) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(endpoint);
    setBusyArea(options.area || page);
    setError('');
    setNotice(null);
    const epoch = ++statusEpoch.current,
      accountId = statusRef.current?.account?.id;
    try {
      const timeout = ['storage.save', 'conversation.configure', 'disconnect', 'cancel'].includes(endpoint)
        ? 120000
        : 30000;
      const value = await call(connection, endpoint, payload, AbortSignal.timeout(timeout));
      if (!mounted.current || epoch !== statusEpoch.current) return null;
      if (endpoint === 'contacts') {
        if (accountId === statusRef.current?.account?.id) setContacts(value);
      } else {
        accept(value, options.force || []);
        setConnectionError('');
      }
      if (options.text && (!payload.accountId || value.account?.id === payload.accountId))
        setNotice({ area: options.area || page, text: options.text });
      if (['storage.save', 'conversation.configure', 'settings', 'cancel'].includes(endpoint))
        setRecordEpoch((value) => value + 1);
      return value;
    } catch (failure) {
      if (mounted.current && epoch === statusEpoch.current) setError(failure.message || '操作未完成，请核对当前状态。');
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy('');
    }
  };
  useEffect(() => {
    if (page === 'authorization' && status?.online && !contacts && !busyRef.current) void action('contacts');
  }, [page, authTab, status?.online, status?.account?.id]);
  const navigate = (next, from) => {
    if (next === 'memory-review') {
      next = 'memory';
      setMemoryTab('review');
    }
    if (from) setReturnPages((current) => ({ ...current, [next]: from }));
    setPage(next);
  };
  const restoreDefaultPersona = () => {
    if (busyRef.current) return;
    const previous = draftsRef.current.persona;
    if (!previous) return;
    setDraft('persona', personaDraft(emptyPersona({ name: previous.name, aliases: splitLines(previous.aliases) })));
  };
  const backPage = returnPages[page] || 'settings',
    back = () => setPage(backPage),
    backLabel = '返回' + (pageLabels[backPage] || '设置');
  const openDetail = (peer) => {
    const key = conversationKey(peer);
    detailRef.current = key;
    setDetailKey(key);
    setDraft('conversation', configDraft(peer.config, statusRef.current?.persona));
    setPage('conversation');
    setNotice(null);
  };
  const selectRecord = (peer) => {
    recordRequestEpoch.current++;
    setRecordLoading(true);
    setRecordPeer({ peerId: peerId(peer), chatType: peerType(peer) });
    setRecordOffset(0);
    setRecordAnchor(null);
    setRecordData(null);
    setRecordError('');
  };
  const holdRecordPosition = () => {
    if (!recordAnchor && recordData?.anchor) {
      recordRequestEpoch.current++;
      setRecordAnchor(recordData.anchor);
    }
  };
  const changeRecordPage = (offset) => {
    recordRequestEpoch.current++;
    setRecordLoading(true);
    setRecordAnchor(recordAnchor || recordData?.anchor || null);
    setRecordOffset(offset);
    setRecordData(null);
    setRecordError('');
  };
  const refreshRecords = () => {
    recordRequestEpoch.current++;
    setRecordLoading(true);
    setRecordAnchor(null);
    setRecordOffset(0);
    setRecordData(null);
    setRecordError('');
    setRecordEpoch((value) => value + 1);
  };
  const openRecords = (peer) => {
    selectRecord(peer);
    setPage('records');
  };
  useEffect(() => {
    if (
      page === 'records' &&
      (!recordPeer || !recordRows.some((item) => conversationKey(item) === conversationKey(recordPeer)))
    ) {
      if (recordRows[0]) selectRecord(recordRows[0]);
      else {
        setRecordPeer(null);
        setRecordData(null);
      }
    }
  }, [page, recordPeer?.peerId, recordPeer?.chatType, recordRows.map(conversationKey).join('|'), status?.account?.id]);
  useEffect(() => {
    if (page !== 'records' || !recordPeer || !status?.account?.id) return;
    const controller = new AbortController(),
      accountId = status.account.id,
      queryEpoch = ++recordRequestEpoch.current;
    let timer,
      first = true;
    const poll = async () => {
      if (first) setRecordLoading(true);
      try {
        const value = await call(
          connection,
          'records.list',
          {
            accountId,
            chatType: recordPeer.chatType,
            peerId: recordPeer.peerId,
            offset: recordOffset,
            limit: 50,
            anchor: recordAnchor,
          },
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
        );
        if (
          controller.signal.aborted ||
          queryEpoch !== recordRequestEpoch.current ||
          statusRef.current?.account?.id !== accountId
        )
          return;
        setRecordData(value);
        setRecordError('');
        if (recordOffset > 0 && value.total <= recordOffset)
          setRecordOffset(
            Math.max(0, Math.floor(Math.max(0, value.total - 1) / (value.limit || 50)) * (value.limit || 50))
          );
      } catch (failure) {
        if (
          !controller.signal.aborted &&
          queryEpoch === recordRequestEpoch.current &&
          statusRef.current?.account?.id === accountId
        )
          setRecordError(failure.message);
      } finally {
        if (!controller.signal.aborted && queryEpoch === recordRequestEpoch.current) setRecordLoading(false);
      }
      first = false;
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    connection,
    page,
    recordPeer?.peerId,
    recordPeer?.chatType,
    status?.account?.id,
    recordOffset,
    recordAnchor,
    recordEpoch,
  ]);
  const saveSettings = (settings, options = {}) =>
    action('settings', { accountId: statusRef.current.account.id, settings }, options);
  const grant = async (peer, enabled) => {
    if (!statusRef.current?.account) return null;
    const settings = statusRef.current.settings,
      field = peerType(peer) === 'group' ? 'groups' : 'privatePeers';
    return saveSettings(
      {
        ...settings,
        [field]: enabled
          ? [...new Set([...settings[field], peerId(peer)])]
          : settings[field].filter((id) => id !== peerId(peer)),
      },
      {
        area: page === 'conversation' ? 'conversation' : 'authorization',
        text: enabled ? '会话已授权，可进入设置选择回复模式。' : '已撤销此会话授权，已有记录继续保留。',
      }
    );
  };
  const blocked = !!busy || !!status?.startupError;
  const navPage = ['model', 'identity', 'persona', 'storage', 'changelog', 'administrators', 'image-generation', 'diagnostics'].includes(page)
    ? 'settings'
    : page === 'conversation'
      ? 'authorization'
      : page === 'recovery'
        ? 'records'
        : page;
  const warning = error || connectionError || status?.startupError?.message || status?.processing?.fault?.message;

  return {
    motion,
    status,
    page,
    setPage,
    memoryTab,
    setMemoryTab,
    error,
    busy,
    busyArea,
    notice,
    contacts,
    authQuery,
    setAuthQuery,
    authType,
    setAuthType,
    authTab,
    setAuthTab,
    drafts,
    recordQuery,
    setRecordQuery,
    recordType,
    setRecordType,
    recordOffset,
    recordData,
    recordLoading,
    recordError,
    statusRef,
    draftsRef,
    workspaceRef,
    rows,
    detail,
    recordRows,
    recordSelected,
    setDraft,
    action,
    navigate,
    restoreDefaultPersona,
    back,
    backLabel,
    openDetail,
    selectRecord,
    holdRecordPosition,
    changeRecordPage,
    refreshRecords,
    openRecords,
    saveSettings,
    grant,
    blocked,
    navPage,
    warning,
  };
}
