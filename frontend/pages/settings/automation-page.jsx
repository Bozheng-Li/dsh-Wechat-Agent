import { useState } from 'react';
import { Back, Notice, PageHead } from '../../components/page-ui.jsx';
import { Button } from '../../components/button.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { RoleCardSettings } from './role-card-settings.jsx';
import { MediaAutomationSettings } from './media-automation-settings.jsx';
import { MomentsReplySettings } from './moments-reply-settings.jsx';
import { MomentsLikeSettings } from './moments-like-settings.jsx';
import { MomentsInteractionSettings } from './moments-interaction-settings.jsx';
import { MomentsPublishingSettings } from './moments-publishing-settings.jsx';
import { MomentsMaterialSettings } from './moments-material-settings.jsx';
import { ImageMemoryAutomationSettings } from './image-memory-settings.jsx';

function AutomationGroup({ id, title, description, initialSection, children }) {
  const [open, setOpen] = useState(id === initialSection), [loaded, setLoaded] = useState(id === initialSection);
  return <details className="wa-automation-group" data-testid={'automation-group-' + id} open={open}
    onToggle={event => { const next = event.currentTarget.open; setOpen(next); if (next) setLoaded(true); }}>
    <summary><span><strong>{title}</strong><small>{description}</small></span><Glyph name="arrow" size={15} /></summary>
    {loaded && <div className="wa-automation-group-body">{children}</div>}
  </details>;
}

export function AutomationSettings({ rpc, status, rows, target = {}, blocked, notice, onToggle, onNavigate, onBack, backLabel }) {
  const accountId = status.account?.id;
  const group = (id, title, description, content) => <AutomationGroup key={id} id={id} title={title} description={description}
    initialSection={target.section}>{content}</AutomationGroup>;
  const accountProps = { rpc, status, blocked };
  return <section className="wa-wb-page wa-automation-settings" data-testid="automation-settings-page">
    <Back onClick={onBack} label={backLabel} />
    <PageHead icon="settings" title="自动功能" description="统一管理自动回复、朋友圈、记忆与素材。各组独立保存。">
      <Button quiet icon="clock" onClick={() => onNavigate('time', 'automation')}>时间设置</Button>
    </PageHead>
    <section className="wa-automation-master wa-section-space" aria-label="自动回复总开关">
      <div><h2>自动回复总开关</h2><p className="wa-help">{status.settings.enabled
        ? '按已授权会话的模式处理新消息，并允许定时任务和朋友圈自动功能运行。'
        : '已暂停回复、定时发送和朋友圈自动执行，授权与已有记录继续保留。'}</p></div>
      <label className="wa-toggle"><input type="checkbox" role="switch" aria-label="启用自动回复"
        checked={status.settings.enabled} disabled={blocked || !accountId} onChange={event => onToggle(event.target.checked)} />
        <span>{status.settings.enabled ? '已开启' : '已暂停'}</span></label>
    </section>
    <Notice notice={notice} area="automation" />
    <section className="wa-section-space" aria-label="当前微信账号自动功能">
      <h2>当前微信账号{status.account?.nickname ? ' · ' + status.account.nickname : ''}</h2>
      <p className="wa-help">执行间隔、活跃时段与超时在“时间设置”中管理。</p>
      {!accountId ? <p className="wa-help">连接微信账号后，可管理该账号的朋友圈和表情自动功能。</p> : <>
        {group('moments-replies', '朋友圈评论回复', '回复我的评论区，接续好友朋友圈对话', <MomentsReplySettings {...accountProps} />)}
        {group('moments-likes', '指定好友自动点赞', '好友名单、定时点赞与聊天点赞请求', <MomentsLikeSettings {...accountProps} />)}
        {group('moments-interactions', '朋友圈自动互动', '定期挑选好友动态，点赞与评论', <MomentsInteractionSettings {...accountProps} />)}
        {group('moments-publishing', '朋友圈自动发布', '发布总开关、自动安排与默认内容', <MomentsPublishingSettings {...accountProps} />)}
        {group('moments-materials', '朋友圈素材整理', '自动整理聊天素材，管理联网取图与生图', <MomentsMaterialSettings {...accountProps} />)}
        {group('media', '聊天表情与图片', '图片表情回复、聊天表情收集与含义整理', <MediaAutomationSettings {...accountProps} />)}
      </>}
    </section>
    <section className="wa-section-space" aria-label="全局自动功能"><h2>全局</h2>
      {group('roles', '人物角色卡整理', '所有账号共用的开关与整理方式', <RoleCardSettings rpc={rpc} blocked={blocked} />)}
    </section>
    {accountId && <section className="wa-section-space" aria-label="会话自动功能"><h2>按会话设置</h2>
      {group('images', '图片记忆自动保存', '分别控制会话收到的图片与 Agent 生成图片',
        <ImageMemoryAutomationSettings {...accountProps} rows={rows} initialPeerKey={target.peerKey} />)}
    </section>}
  </section>;
}
