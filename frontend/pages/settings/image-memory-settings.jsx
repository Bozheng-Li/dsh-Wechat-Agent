import { useEffect, useState } from 'react';
import { Button, Feedback } from '../../components/workbench-ui.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { conversationKey, peerId, peerType } from '../../shared/conversations.mjs';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';

function ImageCollectionSettings({ rpc, status, peer, collection, blocked }) {
  const scope = { accountId: status.account.id, chatType: peerType(peer), peerId: peerId(peer), collection };
  const state = useWorkbench((endpoint, payload, signal) => rpc(endpoint, { ...payload, ...scope,
    ...(endpoint === 'memory.images.list' ? { limit: 1 } : {}) }, signal), scope.accountId, 'memory.images.list', collection, 5000, status.timeSettings);
  const settings = state.data?.settings, [enabled, setEnabled] = useState(null), [changed, setChanged] = useState(false);
  const generated = collection === 'generated', busy = !!state.busy || blocked || !settings;
  useEffect(() => { if (settings && !changed) setEnabled(settings.enabled); }, [settings, changed]);
  const dirty = !!settings && enabled !== null && enabled !== settings.enabled;
  return <form className="wa-settings-block" data-testid={'image-memory-settings-' + collection} onSubmit={async event => {
    event.preventDefault(); if (busy || !dirty) return;
    if (await state.execute('memory.images.configure', { settings: preserveTimeValues('images', { ...settings, enabled }, settings), preserveTimeSettings: true })) {
      setChanged(false); state.setNotice('此会话的图片记忆设置已保存。');
    }
  }}>
    <Feedback state={state} cancellable={false} />
    {state.error && <Button quiet disabled={!!state.busy || blocked} onClick={state.refresh}>重新读取图片设置</Button>}
    {enabled !== null && <>
      <label className="wa-check-row"><input type="checkbox" role="switch" aria-label={generated ? '保存此会话的生成图片' : '保存此会话的图片'}
        checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); setChanged(true); state.setNotice(''); }} />
        <span>{generated ? '保存此会话的生成图片' : '保存此会话的图片与表情'}</span></label>
      <FormActions dirty={dirty} busy={state.busy} disabled={busy} label="保存图片记忆设置"
        onReset={() => { setEnabled(settings.enabled); setChanged(false); state.setNotice(''); }} />
    </>}
  </form>;
}

export function ImageMemoryAutomationSettings({ rpc, status, rows = [], initialPeerKey, blocked }) {
  const [selectedKey, setSelectedKey] = useState(initialPeerKey || (rows[0] ? conversationKey(rows[0]) : ''));
  const peer = rows.find(row => conversationKey(row) === selectedKey) || rows[0];
  return <section data-testid="image-memory-automation-settings">
    <Field label="选择会话" id="wa-automation-image-conversation" help="会话收到的图片和 Agent 生成图片分别保存，各自独立开关。">
      <select id="wa-automation-image-conversation" className="wa-select" value={peer ? conversationKey(peer) : ''} disabled={blocked || !rows.length}
        onChange={event => setSelectedKey(event.target.value)}>
        {!rows.length && <option value="">暂无可选会话</option>}
        {rows.map(row => <option key={conversationKey(row)} value={conversationKey(row)}>{peerType(row) === 'group' ? '群聊' : '私聊'} · {row.name || peerId(row)}</option>)}
      </select>
    </Field>
    {peer ? <div key={conversationKey(peer)}>
      <ImageCollectionSettings rpc={rpc} status={status} peer={peer} collection="conversation" blocked={blocked} />
      <ImageCollectionSettings rpc={rpc} status={status} peer={peer} collection="generated" blocked={blocked} />
    </div> : <p className="wa-help">先在会话页授权一个会话。</p>}
    <p className="wa-help">保存期限在“时间设置”中选择同一会话后修改。关闭后停止保存和模型读取，已有图片仍可在记忆库中管理。</p>
  </section>;
}
