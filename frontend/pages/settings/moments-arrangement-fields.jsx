import { AudiencePicker } from '../moments/audience-picker.jsx';

export function ArrangementFields({ value, onChange, settings, data, audience, audienceError, loadAudience, busy, online }) {
  const update = patch => onChange({ ...value, ...patch });
  const content = patch => update({ content: { ...value.content, ...patch } });
  return <section className="wa-moments-arrangement" data-testid="moments-arrangement">
    <h3>自动安排计划</h3>
    <label className="wa-wb-check"><input type="checkbox" role="switch" aria-label="按每天次数自动生成发布计划" checked={value.enabled} disabled={busy} onChange={e => update({ enabled: e.target.checked })} />按每天次数自动生成发布计划</label>
    <p className="wa-wb-note">保存后排出今天和后两天的计划，每天继续补上新一天。手动计划优先计入当天次数；你修改、暂停或删除的自动计划会保留决定，不会被覆盖或补回。</p>
    {data?.automaticWaitingReason && <p role="alert" className="wa-alert is-error">{data.automaticWaitingReason}</p>}
    {value.enabled && <>
      <div className="wa-wb-generator">
        <label>每天计划条数<input aria-label="每天自动安排条数" type="number" min={1} max={8} value={value.dailyCount} onChange={e => update({ dailyCount: Number(e.target.value) })} /></label>
      </div>
      <p className="wa-wb-note">安排时段、时区和最短发布间隔统一在“设置 → 时间设置”中修改。在时段内分散安排，至少提前 10 分钟。每天条数是目标，仍受 24 小时上限与最短间隔限制；时段不够时少排，不集中补发。到时间再生成正文，主题可以留空。</p>
      {value.dailyCount > settings.maxPostsPer24Hours && <p className="wa-wb-note">每天目标超过了 24 小时上限，实际会少排；可调整上方发布上限。</p>}
      <details className="wa-moments-arrangement-content"><summary>自动计划的默认内容与可见范围</summary>
        <p className="wa-wb-note">用于新安排和未改过的未来计划。已经单独改过的计划保留原设置。</p>
        <label>内容方向（可留空，每行一个）<textarea aria-label="自动安排内容方向" rows={3} maxLength={6030} value={value.content.themes.join('\n')} onChange={e => content({ themes: e.target.value.split('\n') })} placeholder="留空时结合人设、近期内容和可用素材自主选题。" /></label>
        <label className="wa-wb-check"><input type="checkbox" aria-label="自动安排使用素材库" checked={value.content.useMaterials} onChange={e => content({ useMaterials: e.target.checked })} />结合朋友圈素材库</label>
        <p className="wa-wb-note">只使用素材库中已保存的内容；聊天整理范围在本页的“朋友圈素材整理”中设置，发布前仍会检查脱敏。</p>
        <label>写作风格<input aria-label="自动安排写作风格" maxLength={1000} value={value.content.style} onChange={e => content({ style: e.target.value })} /></label>
        <label>内容要求<textarea aria-label="自动安排内容要求" rows={3} maxLength={4000} value={value.content.instructions} onChange={e => content({ instructions: e.target.value })} /></label>
        <div className="wa-wb-generator">
          <label>正文最多字数<input aria-label="自动安排正文最多字数" type="number" min={30} max={2000} value={value.content.maxChars} onChange={e => content({ maxChars: Number(e.target.value) })} /><small>只设上限，长短随内容变化。</small></label>
          <label>发布方式<select aria-label="自动安排发布方式" value={value.content.reviewRequired ? 'review' : 'direct'} onChange={e => content({ reviewRequired: e.target.value === 'review' })}><option value="direct">按时直接发布</option><option value="review">先生成草稿，由我审核发布</option></select></label>
          <label>配图<select aria-label="自动安排配图方式" value={value.content.image.mode} onChange={e => content({ image: { ...value.content.image, mode: e.target.value } })}><option value="library">从素材库选图，合适时配图</option><option value="none">纯文字</option><option value="ai">使用已配置的 AI 生图接口</option></select></label>
        </div>
        {value.content.image.mode === 'ai' && <label>配图要求<textarea aria-label="自动安排配图要求" rows={2} maxLength={2000} value={value.content.image.instructions} onChange={e => content({ image: { ...value.content.image, instructions: e.target.value } })} /></label>}
        <label className="wa-wb-check"><input type="checkbox" aria-label="自动安排联网取材" checked={value.content.research} onChange={e => content({ research: e.target.checked })} />生成前联网取材</label>
        {value.content.research && <label>公开搜索主题（可留空）<input aria-label="自动安排搜索主题" maxLength={240} value={value.content.researchQuery} onChange={e => content({ researchQuery: e.target.value })} /></label>}
        <AudiencePicker data={audience} error={audienceError} labelIds={value.content.blockedLabelIds} userIds={value.content.blockedUserIds} onChange={content} onRead={loadAudience} busy={busy} online={online} />
      </details>
    </>}
    {data?.settings.automatic?.enabled && <div className="wa-moments-arrangement-status" role="status">
      {(data.arrangement ?? []).map(row => <p key={row.date}>{row.date} · 已占用 {row.reserved} / 目标 {row.target} 个时段{row.shortfall > 0 ? ` · 还少 ${row.shortfall} 个：剩余时间或发布间隔不足` : ''}</p>)}
      <small>已占用包含手动计划，以及你暂停、删除或已执行的自动时段。</small>
    </div>}
  </section>;
}
