export { Button } from './button.jsx';

export function Alert({ text }) {
  return text ? (
    <div className="wa-alert is-error" role="alert">
      {text}
    </div>
  ) : null;
}

export function Field({ label, children, help }) {
  return (
    <label className="wa-field wa-automation-field">
      <span className="wa-label">{label}</span>
      {children}
      {help && <span className="wa-help">{help}</span>}
    </label>
  );
}
