import { loginLabels } from '../../shared/labels.mjs';
import { Glyph } from '../../components/glyph.jsx';
import { Button } from '../../components/button.jsx';

export function AccountCard({ status, busy, blocked, onAction }) {
  const loading = status.login?.running;
  const disconnectedState = status.login?.state === 'online' ? 'offline' : status.login?.state;
  return (
    <section className="wa-card wa-account-card">
      <p className="wa-account-kicker">
        微信连接<span>WECHAT</span>
      </p>
      <div className="wa-account-layout">
        <div className="wa-account-copy">
          <div className="wa-account-top">
            <div className="wa-account-avatar">
              <Glyph name="chat" size={26} />
            </div>
            <div>
              <h2 className="wa-account-name">
                {status.account?.nickname || (status.account ? '当前微信账号' : '连接你的微信')}
              </h2>
              <p className="wa-muted wa-mono">{status.account?.id || '扫码后，在这里管理 Agent 的会话'}</p>
            </div>
          </div>
          <div className="wa-account-content">
            <div className="wa-status-line wa-login-state">
              <span className={'wa-status-dot ' + (status.online ? 'is-online' : '')} />
              {status.online ? '已连接，正在同步新消息' : loginLabels[disconnectedState] || '微信未连接'}
            </div>
            <p className="wa-help">
              {status.online ? '回复范围和方式由每个授权会话的设置决定。' : '登录后选择会话，并为群聊设置参与方式。'}
            </p>
          </div>
          <div className="wa-row wa-account-actions">
            {loading ? (
              <Button disabled={blocked} onClick={() => onAction('login.cancel')}>
                取消登录
              </Button>
            ) : (
              <Button
                primary={!status.account}
                disabled={blocked || !status.runtimeReady}
                onClick={() => onAction('login.start', { replace: !!status.account })}
              >
                {busy === 'login.start' ? '正在启动…' : status.account ? '重新扫码' : '扫码登录微信'}
              </Button>
            )}
            {status.account && !loading && (
              <Button disabled={blocked} onClick={() => onAction(status.online ? 'disconnect' : 'connect')}>
                {status.online ? '断开连接' : '重新连接'}
              </Button>
            )}
          </div>
        </div>
      </div>
      {(status.login?.error || status.error) && (
        <div className="wa-alert is-error wa-section-space" role="alert">
          {status.login?.error || status.error}
        </div>
      )}
      {loading && status.login?.image && (
        <>
          <img className="wa-qr" src={status.login.image} alt="微信登录二维码" />
          <p className="wa-help wa-qr-caption">
            {status.login.state === 'scanned' ? '已扫码，请在手机确认本次登录。' : '请使用手机微信扫码。'}
          </p>
        </>
      )}
      {!status.runtimeReady && (
        <p className="wa-alert wa-section-space">缺少登录组件，请安装完整的 Windows x64 插件包。</p>
      )}
      <p className="wa-account-note">使用插件独立的登录资料；已保存的会话授权随当前微信账号切换。</p>
    </section>
  );
}
