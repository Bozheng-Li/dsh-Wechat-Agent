import React, { useId } from 'react';

// A pair of optical loops: a polished silver body and a translucent glass body.
// All highlights belong to the geometry; this artwork has no connection state.
export function ConversationArt() {
  const instance = useId().replace(/:/g, '');
  const id = name => `wa-optical-${instance}-${name}`;
  const paint = name => `url(#${id(name)})`;
  const silver = 'M129 48C182 24 240 66 269 131C299 198 274 252 223 277C171 302 110 262 80 196C50 130 76 72 129 48Z M145 86C176 72 212 100 232 146C253 193 241 225 209 240C178 255 142 228 121 182C101 137 113 101 145 86Z';
  const silverInner = 'M145 86C176 72 212 100 232 146C253 193 241 225 209 240C178 255 142 228 121 182C101 137 113 101 145 86Z';
  const glass = 'M246 116C293 107 333 140 335 181C338 227 297 279 249 289C207 298 176 271 179 231C182 187 207 124 246 116Z M250 147C277 141 302 160 304 184C306 214 277 249 247 257C221 264 207 248 211 224C215 195 229 153 250 147Z';
  const glassInner = 'M250 147C277 141 302 160 304 184C306 214 277 249 247 257C221 264 207 248 211 224C215 195 229 153 250 147Z';

  return <svg className="wa-optical-art" viewBox="0 0 400 360" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={id('silver')} x1="93" y1="60" x2="260" y2="273" gradientUnits="userSpaceOnUse">
        <stop stopColor="#f8fbff"/><stop offset=".13" stopColor="#a5b5c5"/><stop offset=".29" stopColor="#465261"/>
        <stop offset=".41" stopColor="#d9e5ee"/><stop offset=".49" stopColor="#f9fcff"/><stop offset=".59" stopColor="#9daebe"/>
        <stop offset=".73" stopColor="#374758"/><stop offset=".85" stopColor="#121d2b"/><stop offset=".94" stopColor="#718598"/><stop offset="1" stopColor="#d3e0ea"/>
      </linearGradient>
      <linearGradient id={id('silverDepth')} x1="108" y1="92" x2="246" y2="287" gradientUnits="userSpaceOnUse">
        <stop stopColor="#64798c"/><stop offset=".35" stopColor="#192838"/><stop offset=".7" stopColor="#0c1421"/><stop offset="1" stopColor="#5b7486"/>
      </linearGradient>
      <linearGradient id={id('silverEdge')} x1="117" y1="44" x2="254" y2="278" gradientUnits="userSpaceOnUse">
        <stop stopColor="#fff"/><stop offset=".25" stopColor="#e5f1fc" stopOpacity=".9"/><stop offset=".53" stopColor="#fff" stopOpacity=".08"/>
        <stop offset=".76" stopColor="#08131f" stopOpacity=".7"/><stop offset="1" stopColor="#b5cfdf" stopOpacity=".85"/>
      </linearGradient>
      <linearGradient id={id('silverInner')} x1="209" y1="239" x2="138" y2="86" gradientUnits="userSpaceOnUse">
        <stop stopColor="#eff8ff" stopOpacity=".9"/><stop offset=".34" stopColor="#7691a5"/><stop offset=".61" stopColor="#121d2a"/><stop offset="1" stopColor="#06111c"/>
      </linearGradient>
      <linearGradient id={id('glass')} x1="204" y1="143" x2="322" y2="267" gradientUnits="userSpaceOnUse">
        <stop stopColor="#e2f5ff" stopOpacity=".85"/><stop offset=".18" stopColor="#b8d6f6" stopOpacity=".48"/>
        <stop offset=".39" stopColor="#7893c1" stopOpacity=".2"/><stop offset=".55" stopColor="#d7f0ff" stopOpacity=".45"/>
        <stop offset=".73" stopColor="#84c1ed" stopOpacity=".27"/><stop offset="1" stopColor="#d8efff" stopOpacity=".73"/>
      </linearGradient>
      <linearGradient id={id('glassDepth')} x1="326" y1="160" x2="211" y2="282" gradientUnits="userSpaceOnUse">
        <stop stopColor="#acd9ff" stopOpacity=".6"/><stop offset=".42" stopColor="#39799b" stopOpacity=".28"/><stop offset=".76" stopColor="#8aa6ea" stopOpacity=".47"/><stop offset="1" stopColor="#d7f6ff" stopOpacity=".38"/>
      </linearGradient>
      <linearGradient id={id('glassEdge')} x1="226" y1="131" x2="298" y2="279" gradientUnits="userSpaceOnUse">
        <stop stopColor="#fff" stopOpacity=".96"/><stop offset=".35" stopColor="#e1f5ff" stopOpacity=".15"/><stop offset=".58" stopColor="#8bccf1" stopOpacity=".58"/><stop offset="1" stopColor="#f1f6ff" stopOpacity=".9"/>
      </linearGradient>
      <linearGradient id={id('glassInner')} x1="226" y1="155" x2="286" y2="260" gradientUnits="userSpaceOnUse">
        <stop stopColor="#172c44" stopOpacity=".6"/><stop offset=".48" stopColor="#bedfff" stopOpacity=".13"/><stop offset=".75" stopColor="#d4f4ff" stopOpacity=".9"/><stop offset="1" stopColor="#6a91c0" stopOpacity=".7"/>
      </linearGradient>
      <linearGradient id={id('reflection')} x1="119" y1="39" x2="211" y2="223" gradientUnits="userSpaceOnUse">
        <stop stopColor="#fff" stopOpacity=".94"/><stop offset=".62" stopColor="#f6fbff" stopOpacity=".05"/><stop offset="1" stopColor="#fff" stopOpacity="0"/>
      </linearGradient>
      <radialGradient id={id('ground')}><stop stopColor="#02050b" stopOpacity=".55"/><stop offset="1" stopColor="#02050b" stopOpacity="0"/></radialGradient>
      <filter id={id('shadow')} x="-35%" y="-30%" width="180%" height="180%" colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation="8"/>
      </filter>
      <clipPath id={id('front')}><path d="M75 222L170 226L264 236L299 300L163 318Z"/></clipPath>
    </defs>

    <ellipse cx="219" cy="320" rx="126" ry="20" fill={paint('ground')}/>
    <path d={silver} fill="#030810" fillRule="evenodd" transform="translate(5 18)" opacity=".4" filter={paint('shadow')}/>
    <path d={silver} fill={paint('silverDepth')} fillRule="evenodd" transform="translate(3 10)"/>
    <path d={silver} fill={paint('silver')} fillRule="evenodd" stroke={paint('silverEdge')} strokeWidth="1.2"/>
    <path d={silverInner} stroke={paint('silverInner')} strokeWidth="4.5"/>
    <path d="M87 134C83 92 106 59 139 52C181 42 219 76 242 114" stroke={paint('reflection')} strokeWidth="4" strokeLinecap="round"/>
    <path d="M82 160C86 202 117 251 153 271" stroke="#dcecf8" strokeOpacity=".48" strokeWidth="1.2" strokeLinecap="round"/>
    <path d="M149 88C177 80 206 103 224 139" stroke="#eff8ff" strokeOpacity=".35" strokeWidth="1" strokeLinecap="round"/>

    <path d={glass} fill="#020c1b" fillRule="evenodd" transform="translate(1 11)" opacity=".37" filter={paint('shadow')}/>
    <path d={glass} fill={paint('glassDepth')} fillRule="evenodd" transform="translate(5 8)" stroke="#9fcef1" strokeOpacity=".3" strokeWidth=".8"/>
    <path d={glass} fill={paint('glass')} fillRule="evenodd" stroke={paint('glassEdge')} strokeWidth="1.6"/>
    <path d={glassInner} stroke={paint('glassInner')} strokeWidth="3.2"/>
    <path d="M220 139C242 112 279 115 302 132" stroke="#eefaff" strokeOpacity=".77" strokeWidth="2.3" strokeLinecap="round"/>
    <path d="M191 227C198 187 217 139 247 129" stroke="#f5fcff" strokeOpacity=".45" strokeWidth="1.2" strokeLinecap="round"/>
    <path d="M331 190C329 229 293 270 254 281" stroke="#e2f5ff" strokeOpacity=".85" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M306 195C301 224 276 251 250 260" stroke="#a3d6f9" strokeOpacity=".66" strokeWidth="1.4" strokeLinecap="round"/>

    <g clipPath={paint('front')}>
      <path d={silver} fill={paint('silver')} fillRule="evenodd" stroke={paint('silverEdge')} strokeWidth="1.2"/>
      <path d={silverInner} stroke={paint('silverInner')} strokeWidth="4.5"/>
      <path d="M153 269C181 286 209 284 230 272" stroke="#d6eafa" strokeOpacity=".4" strokeWidth="1.1" strokeLinecap="round"/>
    </g>
  </svg>;
}
