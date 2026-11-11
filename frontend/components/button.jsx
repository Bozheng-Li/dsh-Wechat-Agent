import { Glyph } from "./glyph.jsx";

export function Button({ children, icon, primary, quiet, danger, size, loading, className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      data-size={size}
      aria-busy={loading || undefined}
      className={
        'wa-button ' +
        (primary ? 'wa-primary ' : '') +
        (quiet ? 'wa-quiet ' : '') +
        (danger ? 'wa-danger ' : '') +
        className
      }
      {...props}
    >
      {loading ? <span className="wa-button-spinner" aria-hidden="true" /> : icon && <Glyph name={icon} className="wa-icon-small" />}
      {children}
    </button>
  );
}
