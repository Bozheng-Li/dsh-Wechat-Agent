import { stateLabels } from "../shared/labels.mjs";
import { Glyph } from "./glyph.jsx";

export function PageHead({ title, description, children, icon, className = '' }) {
  return (
    <header className={'wa-page-head ' + className}>
      <div className="wa-page-heading-copy">
        <h1>{icon && <Glyph name={icon} />}{title}</h1>
        {description && <p className="wa-muted">{description}</p>}
      </div>
      {children && <div className="wa-page-actions">{children}</div>}
    </header>
  );
}

export function Empty({ icon = 'chat', title, description, children, className = '' }) {
  return (
    <div className={'wa-empty ' + className}>
      <div className="wa-empty-icon">
        <Glyph name={icon} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}

export function Notice({ notice, area }) {
  return notice?.area === area ? (
    <div className="wa-alert is-success" role="status">
      <div className="wa-row">
        <Glyph name="check" className="wa-icon-small" />
        {notice.text}
      </div>
    </div>
  ) : null;
}

export function Search({ value, onChange, placeholder = '搜索名称、备注或微信 ID', label = '搜索会话' }) {
  return (
    <div className="wa-search">
      <Glyph name="search" className="wa-icon-small" />
      <input
        type="search"
        data-testid={label === '搜索记录会话' ? 'records-conversation-search' : 'conversation-search'}
        className="wa-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
      {value && (
        <button type="button" className="wa-search-clear" onClick={() => onChange('')} aria-label={'清空' + label}>
          <Glyph name="close" className="wa-icon-small" />
        </button>
      )}
    </div>
  );
}

export function TypeFilters({ value, onChange }) {
  return (
    <div className="wa-filters" role="group" aria-label="会话类型">
      {[
        ['all', '全部'],
        ['group', '群聊'],
        ['private', '私聊'],
      ].map(([id, label]) => (
        <button type="button" className="wa-filter" key={id} aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function StateBadge({ state, label }) {
  const kind =
    state === 'sent'
      ? 'success'
      : state === 'failed'
        ? 'error'
        : ['unknown', 'partial'].includes(state)
          ? 'warn'
          : ['queued', 'generating', 'sending'].includes(state)
            ? 'accent'
            : '';
  return (
    <span className={'wa-badge ' + (kind ? 'is-' + kind : '')}>
      <span className="wa-badge-dot" aria-hidden="true" />
      {label || stateLabels[state] || state || '等待消息'}
    </span>
  );
}

export function Back({ label = '返回设置', onClick }) {
  return (
    <button type="button" className="wa-back" onClick={onClick}>
      <Glyph name="back" className="wa-icon-small" />
      {label}
    </button>
  );
}
