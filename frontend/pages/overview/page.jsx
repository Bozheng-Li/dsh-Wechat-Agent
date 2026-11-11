import { Glyph } from '../../components/glyph.jsx';
import { Button } from '../../components/button.jsx';
import { PageHead } from '../../components/page-ui.jsx';
import { AccountCard } from './account-card.jsx';

export function Overview({ status, busy, blocked, onAction, onNavigate }) {
  const settings = status.settings || {}, processing = status.processing || {};
  const groups = settings.groups?.length || 0, privates = settings.privatePeers?.length || 0;
  return <>
    <PageHead icon="grid" title="工作台" description="查看当前账号、消息处理状态与工作配置。">
      <Button primary icon="people" onClick={() => onNavigate('authorization')}>管理会话</Button>
    </PageHead>
    <div className="wa-stack wa-overview-stack">
      <AccountCard status={status} busy={busy} blocked={blocked} onAction={onAction} />
      <div className="wa-overview-body">
        <section className="wa-overview-status" aria-label="自动回复状态">
          <div className="wa-card-heading">
            <h2>自动回复</h2>
            <span className={'wa-badge ' + (settings.enabled ? 'is-success' : '')}>
              <span className={'wa-status-dot ' + (settings.enabled ? 'is-online' : '')} />
              {settings.enabled ? '自动回复已开启' : '自动回复已暂停'}
            </span>
          </div>
          <div className="wa-stat-grid">
            <div className="wa-stat">
              <div className="wa-stat-label">已授权会话</div>
              <div className="wa-stat-number">{groups + privates}</div>
              <p className="wa-stat-detail">{groups} 群聊 · {privates} 私聊</p>
            </div>
            <div className="wa-stat">
              <div className="wa-stat-label">等待处理</div>
              <div className="wa-stat-number">{processing.queued || 0}</div>
              <p className="wa-stat-detail">等待回复的消息</p>
            </div>
            <div className="wa-stat is-active" data-active={!!processing.active}>
              <div className="wa-stat-label">当前处理</div>
              <div className="wa-stat-number">{processing.active ? 1 : 0}</div>
              <p className="wa-stat-detail">{processing.active ? '正在处理消息' : '暂无进行中任务'}</p>
            </div>
          </div>
          <div className="wa-overview-status-footer">
            <p className="wa-help">{!settings.enabled ? '开启自动回复后，处理已授权会话的新消息。' : !status.online ? '微信未连接，恢复连接后才能回复。' : '正在接收已授权会话的新消息。'}</p>
            <Button quiet icon="arrow" onClick={() => onNavigate('records')}>查看回复记录</Button>
          </div>
        </section>
      <section className="wa-overview-summary" aria-labelledby="wa-overview-config-title">
        <div className="wa-card-heading"><h2 id="wa-overview-config-title">当前配置</h2></div>
        <div className="wa-overview-config-grid">
        {[
          { icon: 'model', title: '回复模型', value: status.model?.model || '尚未选择模型', help: status.modelChoice ? '使用指定的 DSH 模型' : '跟随 DSH 默认模型', page: 'model', label: '打开模型设置' },
          { icon: 'person', title: '默认助手', value: status.persona?.name || '微信助手', help: '所有会话共用的表达偏好', page: 'persona', label: '编辑默认助手设定' },
          { icon: 'folder', title: '工作目录', value: status.storage?.basePath || '使用默认工作目录', help: '记录、记忆与任务的保存位置', page: 'storage', label: '打开工作目录设置', path: true },
        ].map(item => <button type="button" className="wa-summary-item" key={item.page}
          aria-label={item.label} onClick={() => onNavigate(item.page, 'overview')}>
          <Glyph name={item.icon} />
          <div>
            <p className="wa-help">{item.title}</p>
            <div className={'wa-summary-value' + (item.path ? ' wa-path wa-mono' : '')}>{item.value}</div>
          </div>
          <Glyph name="arrow" className="wa-summary-arrow" />
        </button>)}
        </div>
      </section>
      </div>
      <section className="wa-overview-destinations" aria-label="常用工作区">
        {[
          { page: 'memory', icon: 'memory', title: '记忆库', description: '查看会话记忆与共同约定' },
          { page: 'tasks', icon: 'clock', title: '定时任务', description: '管理提醒与执行回执' },
          { page: 'work', icon: 'work', title: '工作任务', description: '跟进进度，查看交付成果' },
        ].map(item => <button type="button" className="wa-destination" key={item.page} onClick={() => onNavigate(item.page)}>
          <span className="wa-card-icon"><Glyph name={item.icon} /></span>
          <span><strong>{item.title}</strong><small>{item.description}</small></span>
          <Glyph name="arrow" className="wa-icon-small" />
        </button>)}
      </section>
    </div>
  </>;
}
