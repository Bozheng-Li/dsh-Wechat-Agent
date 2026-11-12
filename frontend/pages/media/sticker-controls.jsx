import { Button } from '../../components/button.jsx';

export function StickerControls({ data, status, busy, act }) {
  const state = data.stickers || {}, connected = status.online;
  return <section className="wa-sticker-controls" data-testid="wechat-stickers">
    <div className="wa-sticker-heading">
      <div><h2>用你自己的微信表情</h2><p className="wa-help">同步收藏，收集聊天表情，整理含义和使用情景。聊天时由模型自然选择，优先原生发送。</p></div>
      <span className={'wa-sticker-status' + (state.state === 'ready' ? ' is-ready' : '')}>
        {state.syncing ? '正在同步微信' : !connected ? '等待微信连接' : state.state === 'ready' ? '微信收藏已同步' : state.state === 'unavailable' ? '收藏暂未同步' : '等待首次同步'}
      </span>
    </div>
    <div className="wa-sticker-actions">
      <Button primary icon="refresh" disabled={!!busy || !connected || state.syncing} onClick={() => void act('assets.stickers.sync', {}, result =>
        `已同步 ${result.count} 张微信收藏，新增 ${result.imported} 张。${result.previews ? '原图正在后台保存。' : ''}${result.skipped ? '本机已移除的表情保持移除。' : ''}`)}>同步微信收藏</Button>
      <Button disabled={!!busy || !connected || data.settings.captureIncoming === false} onClick={() => void act('assets.stickers.collect', {}, result =>
        result.queued ? `已安排收集最近聊天中的 ${result.queued} 条表情，重复内容会自动跳过。` : '最近已授权的聊天中没有可收集的表情。')}>收集最近聊天表情</Button>
      <Button disabled={!!busy || !connected || !data.counts.enabled} onClick={() => void act('assets.stickers.send', {}, result =>
        `“${result.name}”已${result.native ? '作为微信原生表情' : '作为图片'}发送到文件传输助手，已收到微信确认。`)}>随机试发</Button>
    </div>
    <p className="wa-help wa-sticker-note">试发仅发送到当前账号的文件传输助手。聊天表情从已授权会话收集，按账号单独保存。</p>
    {state.pending > 0 && <p className="wa-help" role="status">正在保存表情原图 · 还有 {state.pending} 项</p>}
    {state.describing && <p className="wa-help" role="status">正在后台整理含义与适用情景，聊天可以继续</p>}
    {state.lastError && <p className="wa-alert" role="status">{state.lastError}</p>}
    {!!data.retiredBuiltinCount && <p className="wa-help">旧版内置表情已移除。现在使用微信收藏、聊天表情或你自行导入的图片。</p>}
  </section>;
}
