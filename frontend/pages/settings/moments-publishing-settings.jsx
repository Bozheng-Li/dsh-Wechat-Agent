import { useEffect, useState } from 'react';
import { Button, Feedback, Tag } from '../../components/workbench-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { MOMENTS_PUBLISH_DEFAULTS, momentsPublishingSettings } from '../../../shared/moments-publishing.mjs';
import { preserveTimeValues } from '../../../shared/time-settings.mjs';
import { ArrangementFields } from './moments-arrangement-fields.jsx';

export function MomentsPublishingSettings({ rpc, status, blocked }) {
  const state = useWorkbench(rpc, status.account?.id, 'moments.list', '', 3000, status.timeSettings);
  const data = state.data?.publishing, [settings, setSettings] = useState(() => structuredClone(MOMENTS_PUBLISH_DEFAULTS));
  const [dirty, setDirty] = useState(false), [error, setError] = useState('');
  const [audience, setAudience] = useState(null), [audienceError, setAudienceError] = useState(false);
  const [defaultAudience, setDefaultAudience] = useState({ blockedLabelIds: [], blockedUserIds: [] });
  const busy = !!state.busy || blocked || !data, online = status.online;
  useEffect(() => { if (data?.settings && !dirty) setSettings(data.settings); }, [data?.settings, dirty]);
  useEffect(() => {
    const accountId = status.account?.id;
    if (!accountId) return;
    let live = true;
    rpc('moments.audienceDefault', { accountId }, AbortSignal.timeout(15000)).then(value => {
      if (live && value) setDefaultAudience({ blockedLabelIds: [...(value.blockedLabelIds ?? [])], blockedUserIds: [...(value.blockedUserIds ?? [])] });
    }).catch(() => {});
    return () => { live = false; };
  }, [status.account?.id]);
  const update = patch => { setSettings(current => ({ ...current, ...patch })); setDirty(true); setError(''); state.setNotice(''); };
  const loadAudience = async () => {
    const value = await state.execute('moments.audience', {}, false);
    if (value) { setAudience(value); setAudienceError(false); } else setAudienceError(true);
  };
  return <section className="wa-moments-publishing" data-testid="moments-publishing-settings">
    <Feedback state={state} cancellable={false} />
    {state.error && <Button quiet disabled={!!state.busy || blocked} onClick={state.refresh}>重新读取发布设置</Button>}
    <div className="wa-wb-between"><h3>发布控制</h3><Tag state={data?.settings.enabled ? 'ready' : 'disabled'}>{!data ? '正在加载' : data.settings.enabled ? '已开启' : '已关闭'}</Tag></div>
    <p className="wa-wb-note">总开关和计划都开启后才执行。主题可留空，没有合适内容时可以跳过。发布计划与草稿在朋友圈页面管理。</p>
    <fieldset className="wa-automation-fields" disabled={busy}><legend className="wa-sr-only">朋友圈自动发布设置</legend>
      <label className="wa-wb-check"><input aria-label="开启朋友圈自动发布" type="checkbox" role="switch" checked={settings.enabled}
        onChange={event => update({ enabled: event.target.checked })} />开启朋友圈自动发布</label>
      <div className="wa-wb-generator"><label>24 小时最多自动发布<input aria-label="24 小时最多自动发布" type="number" min={1} max={24}
        value={settings.maxPostsPer24Hours} onChange={event => update({ maxPostsPer24Hours: Number(event.target.value) })} /></label></div>
      <ArrangementFields value={settings.automatic} settings={settings} data={data} onChange={automatic => update({ automatic })}
        audience={audience} audienceError={audienceError} loadAudience={loadAudience} busy={busy} online={online} defaultAudience={defaultAudience} />
    </fieldset>
    {error && <p role="alert" className="wa-alert is-error">{error}</p>}
    <div className="wa-form-actions"><span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : '更改在保存后生效。'}</span><div className="wa-wb-actions">
      <Button quiet disabled={busy || !dirty} onClick={() => { setDirty(false); setError(''); setSettings(data.settings); state.setNotice(''); }}>取消总设置更改</Button>
      <Button disabled={busy || !dirty || !online} onClick={async () => {
        let value;
        try { value = momentsPublishingSettings(preserveTimeValues('publishing', { ...settings, automatic: { ...settings.automatic,
          content: { ...settings.automatic.content, themes: settings.automatic.content.themes.map(text => text.trim()).filter(Boolean) } } }, data.settings)); setError(''); }
        catch (failure) { setError(failure.message); return; }
        if (await state.execute('moments.publishing.configure', { settings: value, preserveTimeSettings: true })) {
          setDirty(false); state.setNotice(value.automatic.enabled ? '自动安排已保存，发布计划可在朋友圈页面逐条管理。' : '自动发布设置已保存。');
        }
      }}>保存自动发布设置</Button>
    </div></div>
  </section>;
}
