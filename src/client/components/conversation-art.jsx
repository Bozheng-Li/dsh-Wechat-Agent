import { useId } from 'react';

// Two conversation notes and their shared thread. Decorative, never a live preview.
export function ConversationArt() {
  const instance = useId().replace(/:/g, '');
  const id = (name) => `wa-dialogue-${instance}-${name}`;
  return (
    <svg className="wa-optical-art" viewBox="0 0 400 360" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id('paper')} x1="90" y1="60" x2="280" y2="280" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fffdf5" /><stop offset="1" stopColor="#ddd9c4" />
        </linearGradient>
        <linearGradient id={id('sage')} x1="160" y1="160" x2="330" y2="290" gradientUnits="userSpaceOnUse">
          <stop stopColor="#bdd0ba" /><stop offset="1" stopColor="#799b83" />
        </linearGradient>
        <filter id={id('shadow')} x="-30%" y="-30%" width="180%" height="200%" colorInterpolationFilters="sRGB">
          <feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#091f1b" floodOpacity=".22" />
        </filter>
      </defs>
      <circle cx="222" cy="168" r="133" stroke="#cfdec7" strokeOpacity=".12" />
      <circle cx="222" cy="168" r="108" stroke="#cfdec7" strokeOpacity=".12" strokeDasharray="2 9" />
      <path d="M40 256C15 204 57 145 132 153C213 162 272 65 328 98C393 138 355 267 297 286" stroke="#c8b984" strokeWidth="1.5" strokeOpacity=".7" />
      <circle cx="43" cy="260" r="4" fill="#d1bc7e" /><circle cx="329" cy="98" r="3.5" fill="#d1bc7e" />
      <g transform="rotate(-10 210 144)" filter={`url(#${id('shadow')})`}>
        <path d="M102 69H285C298 69 308 79 308 92V191C308 204 298 214 285 214H150L115 236V214H102C89 214 79 204 79 191V92C79 79 89 69 102 69Z" fill={`url(#${id('paper')})`} stroke="#fffcef" strokeOpacity=".5" />
        <circle cx="115" cy="108" r="14" fill="#e4c589" />
        <path d="M109 111C112 116 118 116 121 111" stroke="#776448" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="110" cy="105" r="1.2" fill="#776448" /><circle cx="120" cy="105" r="1.2" fill="#776448" />
        <path d="M142 104H220M142 115H184" stroke="#a7ae9c" strokeWidth="4" strokeLinecap="round" />
        <path d="M105 147H281M105 160H252M105 173H222" stroke="#607a68" strokeOpacity=".45" strokeWidth="4" strokeLinecap="round" />
        <path d="M261 107l4 4 9-10" stroke="#6e8d74" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g transform="rotate(7 264 240)" filter={`url(#${id('shadow')})`}>
        <path d="M189 188H332C344 188 352 196 352 208V273C352 285 344 293 332 293H324V312L296 293H189C177 293 169 285 169 273V208C169 196 177 188 189 188Z" fill={`url(#${id('sage')})`} stroke="#d4e3c9" strokeOpacity=".6" />
        <circle cx="201" cy="219" r="12" fill="#426451" />
        <path d="M196 219H206M201 214V224" stroke="#e0e9d3" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M224 215H284M224 225H260" stroke="#355944" strokeOpacity=".45" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M191 254H326M191 266H288" stroke="#355944" strokeOpacity=".6" strokeWidth="4" strokeLinecap="round" />
      </g>
      <path d="M335 48V68M325 58H345M328 51L342 65M328 65L342 51" stroke="#d4c795" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M96 300C105 284 119 281 123 289C127 297 115 304 96 300Z" fill="#abbf9a" />
      <path d="M95 301C77 297 72 286 79 282C86 278 96 286 95 301Z" fill="#718c73" />
      <path d="M94 300L88 318" stroke="#abc299" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
