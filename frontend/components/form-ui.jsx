import { Children, cloneElement, isValidElement } from "react";
import { Button } from "./button.jsx";

export function Field({ label, id, children, help, count }) {
  return (
    <div className="wa-field">
      <label className="wa-field-label" htmlFor={id}>
        <span>{label}</span>
        {count != null && <span className="wa-field-count">{count}</span>}
      </label>
      {help && id ? Children.map(children, child => isValidElement(child) && child.props.id === id
        ? cloneElement(child, { 'aria-describedby': [child.props['aria-describedby'], id + '-help'].filter(Boolean).join(' ') })
        : child) : children}
      {help && (
        <p className="wa-help" id={id + '-help'}>
          {help}
        </p>
      )}
    </div>
  );
}

export function FormActions({
  dirty,
  busy,
  disabled,
  invalid,
  onReset,
  label = '保存设置',
  hint = '更改在保存后生效。',
}) {
  return (
    <div className="wa-form-actions" data-dirty={dirty ? 'true' : undefined}>
      <span className={dirty ? 'wa-dirty' : 'wa-help'}>{dirty ? '有尚未保存的更改' : hint}</span>
      <div className="wa-row">
        <Button quiet disabled={!dirty || busy || disabled} onClick={onReset}>
          取消更改
        </Button>
        <Button type="submit" primary loading={!!busy} disabled={busy || disabled || !dirty || invalid}>
          {busy ? '正在保存…' : label}
        </Button>
      </div>
    </div>
  );
}
