import { ConversationSculpture } from '../../components/visuals.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { Button } from '../../components/button.jsx';
import { PageHead } from '../../components/page-ui.jsx';
import { AccountCard } from './account-card.jsx';

export function Overview({ status, busy, blocked, onAction, onNavigate }) {
  const settings = status.settings || {},
    processing = status.processing || {};
  const groups = settings.groups?.length || 0,
    privates = settings.privatePeers?.length || 0;
  return (
    <>
      <PageHead title="工作台" eyebrow="A SPACE FOR CONVERSATION" description="让每次对话，都多一点熟悉。">
        <span className={'wa-badge ' + (settings.enabled ? 'is-success' : '')}>
          <span className={'wa-status-dot ' + (settings.enabled ? 'is-online' : '')} />
          {settings.enabled ? '自动回复已开启' : '自动回复已暂停'}
        </span>
      </PageHead>
      <div className="wa-stack wa-overview-stack">
        <div className="wa-overview-lead">
          <section className="wa-intro-card">
            <div className="wa-intro-copy">
              <span className="wa-intro-kicker">
                <i />
                性格 · 记忆 · 日常
              </span>
              <h2>
                好的对话，
                <br />
                <span>从相互了解开始。</span>
              </h2>
              <p>
                留住重要的事，
                <br />
                用熟悉的方式回应。
              </p>
              <div className="wa-row wa-intro-actions">
                <Button primary onClick={() => onNavigate('authorization')}>
                  管理会话
                  <Glyph name="arrow" className="wa-icon-small" />
                </Button>
                <Button quiet onClick={() => onNavigate('records')}>
                  查看记录
                </Button>
              </div>
            </div>
            <ConversationSculpture />
            <span className="wa-intro-edition" aria-hidden="true">
              EVERY CONVERSATION LEAVES A TRACE.
            </span>
          </section>
          <AccountCard status={status} busy={busy} blocked={blocked} onAction={onAction} />
        </div>
        <div className="wa-persona-ribbon">
          <div className="wa-persona-ribbon-identity">
            <span className="wa-persona-ribbon-avatar" aria-hidden="true">
              {Array.from(status.persona?.name || '微信助手')[0]}
            </span>
            <div>
              <span>当前默认人设</span>
              <strong>{status.persona?.name || '微信助手'}</strong>
            </div>
          </div>
          <p>为不同会话保留不同性格，让记忆服务于当下的交流。</p>
          <div className="wa-row">
            <Button quiet onClick={() => onNavigate('persona', 'overview')}>
              调整人设 <Glyph name="arrow" className="wa-icon-small" />
            </Button>
            <Button quiet onClick={() => onNavigate('memory')}>
              查看记忆 <Glyph name="arrow" className="wa-icon-small" />
            </Button>
          </div>
        </div>
        <div className="wa-stat-grid">
          <div className="wa-stat">
            <span className="wa-stat-index" aria-hidden="true">
              01
            </span>
            <div className="wa-stat-label">
              <Glyph name="people" className="wa-icon-small" />
              已授权会话
            </div>
            <div className="wa-stat-number">{groups + privates}</div>
            <p className="wa-stat-detail">
              {groups} 个群聊 · {privates} 个私聊
            </p>
          </div>
          <div className="wa-stat">
            <span className="wa-stat-index" aria-hidden="true">
              02
            </span>
            <div className="wa-stat-label">
              <Glyph name="clock" className="wa-icon-small" />
              等待处理
            </div>
            <div className="wa-stat-number">{processing.queued || 0}</div>
            <p className="wa-stat-detail">已接收的回复任务</p>
          </div>
          <div className="wa-stat is-active" data-active={!!processing.active}>
            <span className="wa-stat-index" aria-hidden="true">
              03
            </span>
            <div className="wa-stat-label">
              <Glyph name="spark" className="wa-icon-small" />
              当前任务
            </div>
            <div className="wa-stat-number">{processing.active ? 1 : 0}</div>
            <p className="wa-stat-detail">{processing.active ? '正在生成或发送回复' : '等待新会话消息'}</p>
          </div>
        </div>
        <div className="wa-overview-grid">
          <section className="wa-card">
            <div className="wa-card-heading">
              <div>
                <h2>你的 Agent</h2>
                <p className="wa-muted">模型、人设与数据都有清晰的位置。</p>
              </div>
              <Glyph name="spark" />
            </div>
            <div className="wa-summary-item">
              <Glyph name="model" />
              <div>
                <div className="wa-summary-value">{status.model?.model || '尚未选择模型'}</div>
                <p className="wa-help">{status.modelChoice ? '使用指定的 DSH 模型' : '跟随 DSH 默认模型'}</p>
              </div>
              <Button quiet icon="arrow" onClick={() => onNavigate('model', 'overview')} aria-label="打开模型设置" />
            </div>
            <div className="wa-summary-item">
              <Glyph name="person" />
              <div>
                <div className="wa-summary-value">{status.persona?.name || '微信助手'}</div>
                <p className="wa-help">默认人设 · 可在会话中独立设置</p>
              </div>
              <Button quiet icon="arrow" onClick={() => onNavigate('persona', 'overview')} aria-label="打开默认人设" />
            </div>
            <div className="wa-summary-item">
              <Glyph name="folder" />
              <div>
                <div className="wa-summary-value">全局工作目录</div>
                <p className="wa-help wa-mono wa-path">{status.storage?.basePath || '正在读取保存位置'}</p>
              </div>
              <Button
                quiet
                icon="arrow"
                onClick={() => onNavigate('storage', 'overview')}
                aria-label="打开全局工作目录"
              />
            </div>
          </section>
          <section className="wa-card">
            <div className="wa-card-heading">
              <div>
                <h2>会话参与方式</h2>
                <p className="wa-muted">为不同群聊安排不同的角色。</p>
              </div>
              <Glyph name="chat" />
            </div>
            <div className="wa-participation-list">
              {[
                ['默认回复', '群内 @ 当前账号，或使用 /agent 提问。'],
                ['昵称唤醒', '呼叫 Agent 的名字或别名，也可以获得回复。'],
                ['主动参与', '按各群设置的消息条数，理解上下文后加入聊天。'],
                ['自然陪聊', '择机接话与开话题，能接后续，也会在无人回应时退让。'],
              ].map(([title, description], index) => (
                <div className="wa-participation-item" key={title}>
                  <span className="wa-participation-index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p className="wa-help">{description}</p>
                  </div>
                </div>
              ))}
            </div>
            <Button className="wa-participation-manage" icon="people" onClick={() => onNavigate('authorization')}>
              管理会话授权
            </Button>
          </section>
        </div>
      </div>
    </>
  );
}
