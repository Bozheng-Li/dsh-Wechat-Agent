import { useRef } from 'react';

export function WorkspaceTabs({ name, label, tabs, active, onChange, className = '' }) {
  const buttons = useRef({});
  const onKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? tabs[0][0]
        : event.key === 'End'
          ? tabs[tabs.length - 1][0]
          : tabs[
              (tabs.findIndex((value) => value[0] === active) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) %
                tabs.length
            ][0];
    onChange(next);
    buttons.current[next]?.focus();
  };
  return (
    <div className={'wa-memory-tabs ' + className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map(([id, title, description]) => (
        <button
          type="button"
          role="tab"
          key={id}
          id={'wa-' + name + '-tab-' + id}
          data-testid={name + '-tab-' + id}
          aria-controls={'wa-' + name + '-panel-' + id}
          aria-selected={active === id}
          tabIndex={active === id ? 0 : -1}
          ref={(node) => {
            buttons.current[id] = node;
          }}
          onClick={() => onChange(id)}
        >
          <strong>{title}</strong>
          <small>{description}</small>
        </button>
      ))}
    </div>
  );
}
