export function Glyph({ name = 'chat', size, className = '' }) {
  const paths = {
    chat: (
      <>
        <path d="M20.5 11.2c0 4.6-4.4 8-9.1 8-1.4 0-2.7-.3-3.9-.8L3 20l1.1-4.3a7 7 0 0 1-1.6-4.5c0-4.4 4-8 9-8s9 3.6 9 8Z" />
        <path d="M7.5 11h.01M12 11h.01M16.5 11h.01" strokeWidth="2.8" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    people: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        <circle cx="9" cy="7" r="4" />
      </>
    ),
    person: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2" />
      </>
    ),
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2" />
      </>
    ),
    settings: (
      <>
        <path d="m9 3-.7 2.4-2.1 1.2-2.4-.6L2 9l1.7 1.8v2.4L2 15l1.8 3 2.4-.6 2.1 1.2L9 21h6l.7-2.4 2.1-1.2 2.4.6 1.8-3-1.7-1.8v-2.4L22 9l-1.8-3-2.4.6-2.1-1.2L15 3Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    model: <path d="m12 2 8.7 5v10L12 22l-8.7-5V7L12 2Zm0 0v20M3.3 7 12 12l8.7-5M3.3 17 12 12l8.7 5" />,
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1.5" />
        <path d="m3 17 5-5 4 4 4-6 5 7" />
      </>
    ),
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    back: <path d="m14 5-7 7 7 7" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: <path d="M20 7V3l-3 3a8 8 0 0 0-13 5M4 17v4l3-3a8 8 0 0 0 13-5M20 7h-5M4 17h5" />,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    pause: <path d="M8 5v14M16 5v14" strokeWidth="3" />,
    shield: (
      <>
        <path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6L12 2Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    spark: <path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8L12 3ZM20 2v4M18 4h4" />,
  };
  return (
    <svg
      className={'wa-icon ' + className}
      viewBox="0 0 24 24"
      width={size || 19}
      height={size || 19}
      style={size ? { width: size, height: size } : undefined}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.chat}
    </svg>
  );
}
