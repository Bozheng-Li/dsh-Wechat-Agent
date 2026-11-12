import { useEffect, useState } from 'react';
import { Button, Feedback } from '../../components/workbench-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { MATERIAL_DEFAULTS, materialSourceKey } from '../../../shared/moments-materials.mjs';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';

export function MomentsMaterialSettings({ rpc, status, blocked }) {
  const state = useWorkbench(rpc, status.account?.id, 'moments.materials.list', '', 3000, status.timeSettings);
  const data = state.data, [settings, setSettings] = useState(() => structuredClone(MATERIAL_DEFAULTS)), [dirty, setDirty] = useState(false);
  const busy = !!state.busy || blocked || !data;
  useEffect(() => { if (data?.settings && !dirty) setSettings(data.settings); }, [data?.settings, dirty]);
  const configure = patch => { setSettings(current => ({ ...current, ...patch })); setDirty(true); state.setNotice(''); };
  return <section className="wa-moments-materials" data-testid="moments-material-settings">
    <Feedback state={state} cancellable={false} />
    {state.error && <Button quiet disabled={!!state.busy || blocked} onClick={state.refresh}>重新读取取材设置</Button>}
    <p className="wa-wb-note">只整理所选聊天的新内容，先脱敏再保存；不会搬运聊天原图。原聊天记忆与素材分开保留，整理和生成都不等于发布。</p>
    <fieldset disabled={busy} className="wa-automation-fields"><legend className="wa-sr-only">朋友圈素材自动设置</legend>
      <label className="wa-wb-check"><input aria-label="允许素材按需联网取图" type="checkbox" role="switch" checked={settings.webImagesEnabled}
        onChange={event => configure({ webImagesEnabled: event.target.checked })} />允许 Agent 按需搜索并下载公开图片到素材库</label>
      <p className="wa-wb-note">只提供可选工具，不强制联网或配图。网络图片保留来源，可编辑、停用或删除。</p>
      <label className="wa-wb-check"><input aria-label="允许素材按需生图" type="checkbox" role="switch" checked={settings.generatedImagesEnabled}
        onChange={event => configure({ generatedImagesEnabled: event.target.checked })} />允许 Agent 按需调用生图接口生成图片素材</label>
      <p className="wa-wb-note">使用设置中的生图 API，每轮最多一张，也可以不生成。</p>
      <label className="wa-wb-check"><input aria-label="自动整理朋友圈素材" type="checkbox" role="switch" checked={settings.enabled}
        onChange={event => configure({ enabled: event.target.checked })} />定期自动整理新素材</label>
      <p className="wa-wb-note">整理间隔统一在“时间设置”中修改。最多选择 20 个已授权会话作为取材来源。</p>
      <div className="wa-material-sources">{data?.peers?.length ? data.peers.map(peer => <label className="wa-wb-check" key={materialSourceKey(peer)}>
        <input type="checkbox" aria-label={'素材取材 ' + peer.name} checked={settings.sources.some(source => materialSourceKey(source) === materialSourceKey(peer))}
          onChange={event => configure({ sources: event.target.checked ? [...settings.sources, { chatType: peer.chatType, peerId: peer.peerId }]
            : settings.sources.filter(source => materialSourceKey(source) !== materialSourceKey(peer)) })} />
        {peer.name} <small>{peer.chatType === 'group' ? '群聊' : '私聊'}</small></label>) : <p className="wa-wb-note">暂无可选会话，请先在会话页授权。</p>}</div>
      {settings.sources.some(source => !data?.peers?.some(peer => materialSourceKey(peer) === materialSourceKey(source))) && <p className="wa-alert is-error">有取材会话已撤权。
        <Button quiet onClick={() => configure({ sources: settings.sources.filter(source => data.peers.some(peer => materialSourceKey(peer) === materialSourceKey(source))) })}>移除失效取材会话</Button></p>}
    </fieldset>
    <div className="wa-form-actions"><span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : '更改在保存后生效。'}</span><div className="wa-wb-actions">
      <Button quiet disabled={busy || !dirty} onClick={() => { setSettings(data.settings); setDirty(false); state.setNotice(''); }}>取消取材设置更改</Button>
      <Button disabled={busy || !dirty} onClick={async () => {
        if (await state.execute('moments.materials.configure', { settings: preserveTimeValues('materials', settings, data.settings), preserveTimeSettings: true })) {
          setDirty(false); state.setNotice('朋友圈取材范围已保存。');
        }
      }}>保存取材设置</Button>
    </div></div>
  </section>;
}
