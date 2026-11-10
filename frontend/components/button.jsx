import { Glyph } from "./glyph.jsx";

export function Button({ children, icon, primary, quiet, danger, className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={
        'wa-button ' +
        (primary ? 'wa-primary ' : '') +
        (quiet ? 'wa-quiet ' : '') +
        (danger ? 'wa-danger ' : '') +
        className
      }
      {...props}
    >
      {icon && <Glyph name={icon} className="wa-icon-small" />}
      {children}
    </button>
  );
}
