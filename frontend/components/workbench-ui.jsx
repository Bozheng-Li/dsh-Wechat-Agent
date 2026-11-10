import { Button as SharedButton } from './button.jsx';
import { PageHead } from './page-ui.jsx';

export const names = {
  queued: '排队中',
  running: '生成中',
  sending: '等待回执',
  interrupted: '提交已中断',
  passed: '已验证',
  failed: '需处理',
  ready: '条件就绪',
  disabled: '已关闭',
  unknown: '结果不明',
  partial: '部分确认',
  cancelled: '已取消',
  draft: '待确认',
  confirmed: '已确认',
  done: '已完成',
  dismissed: '已忽略',
  sent: '微信已确认',
  submitting: '提交中',
  discarded: '已丢弃',
};

export const Button = ({ children, quiet, danger, className = '', ...props }) => (
  <SharedButton
    primary={!quiet && !danger}
    quiet={quiet}
    danger={danger}
    className={'wa-wb-button' + (quiet ? ' is-quiet' : '') + (danger ? ' is-danger' : '') + ' ' + className}
    {...props}
  >
    {children}
  </SharedButton>
);

export const Tag = ({ state, children }) => (
  <span className={'wa-wb-tag is-' + state}>{children || names[state] || state}</span>
);

export function Heading({ title, text, children }) {
  return <PageHead className="wa-wb-heading" title={title} description={text}>{children}</PageHead>;
}

export function Empty({ title, children }) {
  return (
    <div className="wa-wb-empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Feedback({ state, cancellable = true }) {
  return (
    <>
      {state.error && (
        <div className="wa-alert is-error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && (
        <div className="wa-alert is-success" role="status">
          {state.notice}
        </div>
      )}
      {state.loading && (
        <p className="wa-wb-loading" role="status">
          正在读取…
        </p>
      )}
      {cancellable && state.busy && (
        <div className="wa-wb-between wa-wb-operation">
          <span className="wa-wb-note" role="status">
            正在处理…
          </span>
          <Button quiet onClick={state.cancel}>
            取消操作
          </Button>
        </div>
      )}
    </>
  );
}

export function Offline({ status, children }) {
  return status.account?.id ? (
    children
  ) : (
    <Empty title="先连接微信账号">资料按账号独立保存。连接后即可管理当前账号的工作空间。</Empty>
  );
}
