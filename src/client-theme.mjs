// The visual layer is scoped to this plugin; host navigation and theme settings stay independent.
export const visualCss = `
:where(.dark,[data-theme="dark"]) .wa-panel{color-scheme:dark}
:where(.light,[data-theme="light"]) .wa-panel{color-scheme:light}
.wa-panel{
  --wa-accent:light-dark(#207a5c,#8dd8b7);
  --wa-accent-hover:light-dark(#175f47,#a9e6ca);
  --wa-canvas:light-dark(#f5f7f3,#141c19);
  --wa-surface:light-dark(#ffffff,#1c2722);
  --wa-surface-raised:light-dark(#ffffff,#24322b);
  --wa-nav-surface:light-dark(#edf2ec,#111b16);
  --wa-ink:light-dark(#263d31,#e4ede7);
  --wa-muted:light-dark(#5f7262,#9caf9f);
  --wa-faint:light-dark(#809084,#819888);
  --wa-border:light-dark(#dce5db,#33443a);
  --wa-border-soft:light-dark(#e9eee6,#2b3b31);
  --wa-subtle:light-dark(#f3f6f0,#202d25);
  --wa-hover:light-dark(#eaf1e7,#2a3b30);
  --wa-input-surface:light-dark(#fafcf8,#17231c);
  --wa-glint:light-dark(#ffffffcc,#c0e5c318);
  --wa-shadow:0 4px 18px light-dark(#28453108,#00000014);
  --wa-shadow-raised:0 12px 30px light-dark(#26412f16,#0000002c);
  --wa-ease:cubic-bezier(.2,.7,.2,1);
  color:var(--wa-ink);background:var(--wa-canvas);
  font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
  scrollbar-color:light-dark(#c5d2c2,#455b49) transparent;scrollbar-width:thin;
}
.wa-panel ::selection{background:light-dark(#c6e5d3,#3d6b51);color:var(--wa-ink)}
.wa-panel :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--wa-accent);outline-offset:4px}
.wa-panel h1{font-weight:650;font-size:29px;letter-spacing:-.8px;line-height:1.35}
.wa-panel h2{font-weight:650;letter-spacing:-.25px}
.wa-panel .wa-muted,.wa-panel .wa-help{color:var(--wa-muted);opacity:1}
.wa-panel .wa-eyebrow{color:var(--wa-faint);opacity:1;font-size:10px;letter-spacing:1.8px;margin-bottom:9px!important}
.wa-panel .wa-workspace{padding:24px 36px 36px;max-width:1390px}
.wa-panel .wa-workspace-chrome{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:30px;margin-bottom:22px}
.wa-panel .wa-breadcrumb{display:flex;align-items:center;gap:9px;min-width:0;color:var(--wa-faint);font-size:10px;letter-spacing:.3px}
.wa-panel .wa-breadcrumb>span:first-child{font-weight:650;color:var(--wa-muted)}
.wa-panel .wa-breadcrumb>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wa-panel .wa-breadcrumb-divider{opacity:.5}
.wa-panel .wa-motion-control{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;border:1px solid var(--wa-border-soft);border-radius:20px;background:var(--wa-surface);padding:5px 9px;color:var(--wa-muted);font-size:10px!important;line-height:1.5;transition:border-color .2s,background .2s}
.wa-panel .wa-motion-control:hover:not(:disabled){border-color:var(--wa-border);background:var(--wa-subtle)}
.wa-panel .wa-motion-control:disabled{opacity:.75}
.wa-panel .wa-motion-value{font-size:9px;color:var(--wa-accent);padding-left:5px;border-left:1px solid var(--wa-border)}
.wa-panel .wa-page-head{margin-bottom:25px;align-items:center}
.wa-panel .wa-page-head p:not(.wa-eyebrow){line-height:1.8}
.wa-panel .wa-nav{padding:33px 15px 22px;gap:33px;border-color:var(--wa-border);background:linear-gradient(180deg,light-dark(#ffffff6b,#31523b0a),transparent 320px),var(--wa-nav-surface)}
.wa-panel .wa-brand{gap:11px;padding:0 10px}
.wa-panel .wa-brand-mark{position:relative;overflow:hidden;width:37px;height:37px;border-radius:12px;background:linear-gradient(145deg,#58b78b,#1f805c 53%,#135b40);color:#f5fff6;border:1px solid #78ba9166;box-shadow:inset 0 1px 0 #dcffe965,inset 0 -3px 5px #10422a35,0 5px 10px #163c261b}
.wa-panel .wa-brand-mark:after{content:"";position:absolute;inset:1px 1px auto;height:15px;border-radius:10px 10px 50% 50%;background:linear-gradient(#ffffff24,transparent);pointer-events:none}
.wa-panel .wa-brand strong{font-size:14px;font-weight:650;letter-spacing:-.2px}
.wa-panel .wa-brand small{color:var(--wa-faint);opacity:1;font-size:8px;letter-spacing:1.65px;margin-top:2px;display:block}
.wa-panel .wa-nav-label{font-size:10px;letter-spacing:1px;color:var(--wa-faint);opacity:1;padding:0 13px 9px}
.wa-panel .wa-nav-list{gap:6px}
.wa-panel .wa-nav-button{position:relative;color:var(--wa-muted);padding:11px 13px;border:1px solid transparent;border-radius:10px;gap:12px;font-size:12px!important;transition:background .22s var(--wa-ease),color .22s,border-color .22s}
.wa-panel .wa-nav-button:hover{color:var(--wa-ink);background:var(--wa-hover)}
.wa-panel .wa-nav-button[aria-current=page]{color:var(--wa-ink);background:light-dark(#dceadc,#273e2d);border-color:light-dark(#cdddca,#3c5842);box-shadow:inset 0 1px 0 var(--wa-glint),0 2px 4px #19321e05;font-weight:650}
.wa-panel .wa-nav-button[aria-current=page]:before{content:"";position:absolute;left:-1px;top:13px;bottom:13px;width:3px;border-radius:0 3px 3px 0;background:var(--wa-accent)}
.wa-panel .wa-nav-button[aria-current=page]>.wa-icon{color:var(--wa-accent)}
.wa-panel .wa-nav-button[data-testid=nav-settings]{margin-top:14px}
.wa-panel .wa-nav-count{font-size:9px;min-width:21px;padding:1px 5px;border-radius:5px;color:var(--wa-muted);background:light-dark(#ffffff80,#ffffff09);opacity:1}
.wa-panel .wa-nav-footer{border-color:var(--wa-border);color:var(--wa-muted);opacity:1;font-size:10px;padding:18px 10px 0;gap:8px}
.wa-panel .wa-nav-footer>span{font-size:9px;color:var(--wa-faint)}
.wa-panel .wa-status-dot{width:6px;height:6px;background:var(--wa-faint)}
.wa-panel .wa-status-dot.is-online{background:light-dark(#288960,#8ad4a4);box-shadow:0 0 0 3px light-dark(#26875b12,#7acc9b12)}
.wa-panel .wa-button{min-height:35px;border-radius:9px;border-color:var(--wa-border);background:var(--wa-surface);padding:8px 13px;font-size:11px!important;font-weight:600;box-shadow:inset 0 1px 0 var(--wa-glint),0 1px 2px #15302006;transition:transform .2s var(--wa-ease),background .2s,border-color .2s,box-shadow .2s}
.wa-panel .wa-button:hover:not(:disabled){border-color:light-dark(#b6cbb4,#526c55);background:var(--wa-hover)}
.wa-panel .wa-button.wa-primary{color:light-dark(#fafff9,#173e28);background:linear-gradient(160deg,light-dark(#358d69,#b9e9c6),light-dark(#207353,#8fd6a8));border-color:light-dark(#246f50,#a3dfb6);box-shadow:inset 0 1px 0 #ffffff3b,0 3px 6px light-dark(#1b56351a,#00000015)}
.wa-panel .wa-button.wa-primary:hover:not(:disabled){background:linear-gradient(160deg,light-dark(#3c9973,#cdf3d5),light-dark(#1d6c4d,#a3e2b9));border-color:light-dark(#286f4f,#b8eac6);box-shadow:inset 0 1px 0 #ffffff3b,0 5px 12px light-dark(#1b563524,#00000022);transform:translateY(-1px)}
.wa-panel .wa-button:active:not(:disabled){transform:translateY(1px);box-shadow:none}
.wa-panel .wa-button.wa-quiet{background:transparent;border-color:transparent;box-shadow:none}
.wa-panel .wa-button.wa-quiet:hover:not(:disabled){background:var(--wa-hover);border-color:transparent}
.wa-panel .wa-button.wa-danger{color:light-dark(#ab5447,#e6a093)}
.wa-panel .wa-back{color:var(--wa-muted);opacity:1;margin-bottom:16px;font-size:11px!important;transition:color .2s}
.wa-panel .wa-back:hover{color:var(--wa-accent)}
.wa-panel .wa-card{border-color:var(--wa-border);border-radius:16px;background:linear-gradient(155deg,var(--wa-glint),transparent 120px),var(--wa-surface);padding:24px;box-shadow:var(--wa-shadow)}
.wa-panel .wa-card-heading{margin-bottom:21px}
.wa-panel .wa-card-heading>svg{color:var(--wa-accent);width:18px;height:18px;padding:0;margin-top:2px}
.wa-panel .wa-card-heading p{font-size:11px;margin-top:6px}
.wa-panel .wa-card-icon{width:40px;height:40px;border-radius:12px;border-color:light-dark(#d9e5d5,#3b5140);color:var(--wa-accent);background:linear-gradient(145deg,var(--wa-glint),transparent),var(--wa-subtle);box-shadow:inset 0 1px 0 var(--wa-glint),0 3px 6px #1c392708;transition:transform .25s var(--wa-ease),box-shadow .25s}
.wa-panel .wa-badge{font-size:10px;padding:4px 9px;border:1px solid transparent;border-radius:20px;background:var(--wa-subtle);color:var(--wa-muted);line-height:1.5}
.wa-panel .wa-badge:is(.is-success,.is-accent){color:light-dark(#26794f,#a1dfb5);background:light-dark(#e9f3e7,#29412e);border-color:light-dark(#d7e8d2,#3a5640)}
.wa-panel .wa-badge.is-warn{color:light-dark(#986828,#e4c38d);background:light-dark(#fcf4e5,#403728);border-color:light-dark(#efe3c9,#5b4b32)}
.wa-panel .wa-badge.is-error{color:light-dark(#ab5447,#e9ac9f);background:light-dark(#fcf0eb,#402e29);border-color:light-dark(#eedbd3,#5e4138)}
.wa-panel .wa-alert{border-radius:12px;border-color:light-dark(#eadcbf,#554c31);background:light-dark(#fcf7ed,#302c21);color:light-dark(#795f36,#d9c6a1)}
.wa-panel .wa-alert.is-error{border-color:light-dark(#edcfc6,#5b3d34);background:light-dark(#fcf2ee,#31241f);color:light-dark(#9b5042,#e7b0a0)}
.wa-panel .wa-alert.is-success{border-color:light-dark(#d6e6cf,#3b523d);background:light-dark(#eff6eb,#233326);color:light-dark(#397344,#b2d9b6)}
.wa-panel .wa-account-card{padding:28px 30px 22px;background:radial-gradient(ellipse at 86% 35%,light-dark(#cfe4c665,#3d6b3f35),transparent 55%),linear-gradient(135deg,light-dark(#fcfdf8,#233326),light-dark(#f0f5e9,#1b2920));border-color:light-dark(#d5e2cc,#3c5140);box-shadow:inset 0 1px 0 var(--wa-glint),var(--wa-shadow);overflow:hidden}
.wa-panel .wa-account-layout{display:grid;grid-template-columns:minmax(0,1fr) 274px;gap:20px;align-items:center;min-height:174px}
.wa-panel .wa-account-copy{min-width:0;position:relative;z-index:1}
.wa-panel .wa-account-top{margin-bottom:19px;gap:13px}
.wa-panel .wa-account-avatar{width:48px;height:48px;border-radius:15px;background:linear-gradient(145deg,light-dark(#f6fdf0,#405840),light-dark(#e0edd6,#293c2c));color:var(--wa-accent);border-color:light-dark(#ccdfc0,#52684c);box-shadow:inset 0 1px 0 var(--wa-glint),0 4px 7px #143c2410}
.wa-panel .wa-account-avatar>.wa-icon{width:25px;height:25px}
.wa-panel .wa-account-name{font-size:20px!important;font-weight:650;margin-bottom:3px!important;letter-spacing:-.4px}
.wa-panel .wa-account-top .wa-mono{color:var(--wa-faint);font-size:10px;letter-spacing:.2px}
.wa-panel .wa-account-content{display:block}
.wa-panel .wa-login-state{font-size:12px;font-weight:600;gap:9px}
.wa-panel .wa-account-content .wa-help{font-size:11px;margin-top:7px!important;max-width:450px}
.wa-panel .wa-account-actions{margin-top:19px;gap:8px}
.wa-panel .wa-account-note{margin-top:20px!important;padding-top:15px;border-color:light-dark(#dce5d0,#384b38);color:var(--wa-faint);opacity:1;font-size:10px;position:relative;z-index:1}
.wa-panel .wa-qr{position:relative;z-index:1;box-shadow:0 7px 24px #17332718}
.wa-panel .wa-conversation-sculpture{width:274px;height:180px;position:relative;pointer-events:none;user-select:none;contain:layout style}
.wa-panel .wa-sculpture-stage{position:absolute;width:290px;height:236px;left:6px;top:-9px;transform:scale(.88);transform-origin:top left}
.wa-panel .wa-sculpture-halo{position:absolute;inset:8px 0 18px;background:radial-gradient(ellipse,light-dark(#a5c68e28,#96c27c18),transparent 68%)}
.wa-panel .wa-sculpture-platform{position:absolute;width:192px;height:46px;left:48px;bottom:22px;border-radius:50%;background:radial-gradient(ellipse,#41683c21,transparent 72%);transform:rotate(-8deg)}
.wa-panel .wa-sculpture-platform>span{position:absolute;inset:7px -14px;border:1px solid light-dark(#88a97830,#abc78a21);border-radius:50%}
.wa-panel .wa-sculpture-platform>span:last-child{inset:0 -28px;border-style:dashed;opacity:.5}
.wa-panel .wa-sculpture-orbit{position:absolute;left:13px;top:81px;width:262px;height:81px;border:1px solid light-dark(#90ac744c,#a7c28345);border-radius:50%;transform:rotate(-25deg)}
.wa-panel .wa-sculpture-orbit.is-back{border-bottom-color:transparent;border-left-color:transparent}
.wa-panel .wa-sculpture-orbit.is-front{border-top-color:transparent;border-right-color:transparent;left:16px;top:87px;z-index:4;opacity:.7}
.wa-panel .wa-sculpture-float{position:absolute;z-index:2;will-change:auto;animation:wa-sculpture-float 7s ease-in-out infinite}
.wa-panel .wa-sculpture-float.is-main{left:49px;top:52px}
.wa-panel .wa-sculpture-float.is-companion{left:175px;top:98px;z-index:3;animation-delay:-2.8s;animation-duration:8s}
.wa-panel .wa-sculpture-bubble{position:relative;display:grid;place-items:center;width:143px;height:106px;border-radius:31px;transform:perspective(650px) rotateX(14deg) rotateY(-24deg) rotateZ(-12deg);background:radial-gradient(ellipse at 30% 12%,#c1f4c98c,transparent 48%),linear-gradient(150deg,#8fc6a0,#3c9369 48%,#1d6549 88%);border:1px solid #8fc998;box-shadow:inset 2px 2px 6px #eaffcc65,inset -3px -4px 8px #18473155,1px 2px 0 #2d704e,2px 4px 0 #266c4b,3px 6px 0 #226347,4px 8px 0 #1d5d42,5px 10px 0 #18503b,13px 24px 24px #173b2828}
.wa-panel .wa-sculpture-bubble:after{content:"";position:absolute;left:26px;bottom:-11px;width:26px;height:27px;transform:skewY(-35deg) rotate(12deg);background:linear-gradient(130deg,#438f64,#216747);border-radius:0 0 7px 4px;box-shadow:2px 4px 0 #1b583e;z-index:-1}
.wa-panel .wa-sculpture-reflection{position:absolute;left:9px;right:12px;top:7px;height:42%;border-radius:25px 25px 45% 45%;border-top:1px solid #f2ffcd80;background:linear-gradient(170deg,#efffda25,transparent 70%);pointer-events:none}
.wa-panel .wa-sculpture-dots{display:flex;gap:12px;margin-top:-2px}
.wa-panel .wa-sculpture-dots>i{width:10px;height:10px;display:block;border-radius:50%;background:linear-gradient(#f4ffdf,#d2eec5);box-shadow:0 2px 3px #245f4566,inset 0 1px 1px #ffffff}
.wa-panel .wa-sculpture-bubble.is-pearl{width:85px;height:67px;border-radius:23px;transform:perspective(650px) rotateX(10deg) rotateY(-26deg) rotateZ(12deg);background:radial-gradient(ellipse at 32% 16%,#ffffff,transparent 70%),linear-gradient(145deg,#f2f4d9,#cbd8af 80%);border-color:#dceac4;box-shadow:inset 1px 2px 5px #ffffffce,inset -2px -3px 6px #768f5524,1px 2px 0 #bacb9e,2px 4px 0 #a2b88d,3px 6px 0 #8aab7d,5px 8px 0 #719467,7px 16px 16px #173b282b}
.wa-panel .wa-sculpture-bubble.is-pearl:after{width:18px;height:17px;left:auto;right:16px;bottom:-7px;transform:skewY(35deg) rotate(-8deg);background:#ccdab4;box-shadow:1px 3px 0 #91ab80}
.wa-panel .wa-sculpture-bubble.is-pearl .wa-sculpture-reflection{height:38%;top:5px;left:6px;right:6px;opacity:.7}
.wa-panel .wa-sculpture-spark{font-family:Georgia,serif;font-size:33px;line-height:1;color:#47785c;text-shadow:0 1px 0 #ffffffbd}
.wa-panel .wa-sculpture-orb{position:absolute;border-radius:50%;background:radial-gradient(circle at 30% 24%,#e3ecc0,#a2b77d 43%,#608451 78%);box-shadow:inset -2px -3px 5px #36583729,0 5px 7px #324f3024;z-index:5}
.wa-panel .wa-sculpture-orb.is-large{width:19px;height:19px;left:28px;top:155px;animation:wa-sculpture-orb 9s ease-in-out infinite}
.wa-panel .wa-sculpture-orb.is-small{width:9px;height:9px;right:54px;top:39px;background:radial-gradient(circle at 30% 24%,#dcffde,#79b08c 60%,#447a5d)}
.wa-panel .wa-sculpture-star{position:absolute;left:31px;top:41px;color:light-dark(#85a575,#a4c18d);font-size:20px;font-weight:300;transform:rotate(15deg)}
.wa-panel .wa-stat-grid{gap:16px}
.wa-panel .wa-stat{position:relative;overflow:hidden;border-radius:14px;border-color:var(--wa-border);padding:21px 23px;background:linear-gradient(150deg,var(--wa-glint),transparent 100px),var(--wa-surface);box-shadow:var(--wa-shadow)}
.wa-panel .wa-stat:after{content:"";position:absolute;width:68px;height:68px;border:1px solid light-dark(#dce7d74d,#55744826);border-radius:50%;right:-19px;bottom:-21px;box-shadow:0 0 0 11px light-dark(#e5ede334,#5475440b);pointer-events:none}
.wa-panel .wa-stat-label{font-size:11px;color:var(--wa-muted);opacity:1;margin-bottom:15px;gap:8px}
.wa-panel .wa-stat-label>svg{color:var(--wa-accent)}
.wa-panel .wa-stat-number{font-size:33px;font-weight:600;line-height:1.05;letter-spacing:-1.1px;font-variant-numeric:tabular-nums;color:var(--wa-ink)}
.wa-panel .wa-stat-index{position:absolute;right:18px;top:20px;color:var(--wa-faint);font-size:9px;letter-spacing:1px;opacity:.6}
.wa-panel .wa-stat-detail{font-size:10px;color:var(--wa-faint);opacity:1;margin-top:10px!important;position:relative;z-index:1}
.wa-panel .wa-stat.is-active[data-active=true]{border-color:light-dark(#bfd9b6,#618b61)}
.wa-panel .wa-stat.is-active[data-active=true] .wa-stat-label>svg{animation:wa-active-glow 2s ease-in-out infinite}
.wa-panel .wa-overview-grid{grid-template-columns:minmax(0,1.3fr) minmax(260px,1fr);gap:18px}
.wa-panel .wa-summary-item{gap:13px;padding:15px 0;border-color:var(--wa-border-soft)}
.wa-panel .wa-summary-item>svg{box-sizing:content-box;width:17px;height:17px;margin-top:0;padding:9px;border:1px solid var(--wa-border-soft);background:var(--wa-subtle);border-radius:10px;color:var(--wa-accent);opacity:1}
.wa-panel .wa-summary-value{font-size:12px;font-weight:600}
.wa-panel .wa-summary-item .wa-help{font-size:10px;margin-top:4px!important}
.wa-panel .wa-summary-item .wa-button{min-height:30px;width:30px;padding:6px;color:var(--wa-faint)}
.wa-panel .wa-participation-list{display:flex;flex-direction:column;gap:0}
.wa-panel .wa-participation-item{display:flex;gap:13px;align-items:flex-start;padding:13px 0;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-participation-item:first-child{padding-top:0}
.wa-panel .wa-participation-item:last-child{border-bottom:0}
.wa-panel .wa-participation-index{font-size:10px;line-height:23px;font-variant-numeric:tabular-nums;color:var(--wa-accent);flex-shrink:0}
.wa-panel .wa-participation-item h3{font-size:12px}
.wa-panel .wa-participation-item .wa-help{font-size:11px;margin-top:4px!important}
.wa-panel .wa-participation-manage{width:100%;margin-top:17px}
.wa-panel .wa-setting-link{border-radius:15px;border-color:var(--wa-border);background:linear-gradient(155deg,var(--wa-glint),transparent 130px),var(--wa-surface);box-shadow:var(--wa-shadow);padding:23px;gap:16px;transition:transform .25s var(--wa-ease),border-color .25s,box-shadow .25s,background .25s}
.wa-panel .wa-setting-link:hover{background:var(--wa-surface);border-color:light-dark(#b9ceb4,#526f51);box-shadow:var(--wa-shadow-raised);transform:translateY(-3px)}
.wa-panel .wa-setting-link:hover .wa-card-icon{transform:rotate(-4deg);box-shadow:0 5px 10px #21452912}
.wa-panel .wa-setting-link:hover>svg{color:var(--wa-accent);opacity:1}
.wa-panel .wa-setting-link h3{font-size:13px;margin-bottom:7px}
.wa-panel .wa-setting-link p{font-size:11px;color:var(--wa-muted);opacity:1;line-height:1.9}
.wa-panel .wa-setting-caption{font-size:10px;color:var(--wa-faint);opacity:1;margin-top:14px}
.wa-panel .wa-input,.wa-panel .wa-textarea,.wa-panel .wa-select{border-color:var(--wa-border);border-radius:9px;background:var(--wa-input-surface);color:var(--wa-ink);padding:10px 12px;box-shadow:inset 0 1px 2px #16382003;transition:border-color .2s,box-shadow .2s,background .2s}
.wa-panel .wa-input::placeholder,.wa-panel .wa-textarea::placeholder{color:var(--wa-faint);opacity:.8}
.wa-panel .wa-search .wa-input{padding:9px 34px 9px 38px;font-size:12px!important}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select):hover:not(:disabled){border-color:light-dark(#c0d0bb,#4c624c)}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select):focus{border-color:var(--wa-accent);outline:none;box-shadow:0 0 0 3px light-dark(#32825812,#a3d6a512);background:var(--wa-surface)}
.wa-panel .wa-select option,.wa-panel .wa-select optgroup{background:var(--wa-surface);color:var(--wa-ink)}
.wa-panel .wa-field-label{font-size:12px;font-weight:600;margin-bottom:9px}
.wa-panel .wa-field-count{font-size:10px;color:var(--wa-faint);opacity:1;font-variant-numeric:tabular-nums}
.wa-panel .wa-form-actions{border-color:var(--wa-border-soft);padding-top:20px}
.wa-panel .wa-subsection,.wa-panel .wa-manual-box{border-color:var(--wa-border-soft)}
.wa-panel .wa-path-value{border-color:var(--wa-border);background:var(--wa-input-surface);border-radius:9px;color:var(--wa-muted)}
.wa-panel .wa-mode-option{border-color:var(--wa-border);border-radius:12px;padding:17px;background:var(--wa-input-surface);transition:border-color .2s,background .2s}
.wa-panel .wa-mode-option:hover{border-color:light-dark(#b6cbb0,#536d4f)}
.wa-panel .wa-mode-option:has(input:checked){border-color:light-dark(#91b38b,#61875b);background:light-dark(#f0f6eb,#283b29);box-shadow:inset 0 1px 0 var(--wa-glint)}
.wa-panel .wa-mode-option strong{font-size:12px}
.wa-panel .wa-mode-option small{color:var(--wa-muted);opacity:1;line-height:1.9}
.wa-panel .wa-auth-toggle{border-radius:13px;border-color:var(--wa-border);background:var(--wa-surface);box-shadow:var(--wa-shadow);padding:18px 20px}
.wa-panel .wa-toggle-copy p{color:var(--wa-muted);opacity:1}
.wa-panel .wa-toggle input{width:36px;height:22px;background:light-dark(#c5cfc0,#485947);box-shadow:inset 0 1px 3px #162b1d12;transition:background .2s}
.wa-panel .wa-toggle input:before{width:16px;height:16px;box-shadow:0 1px 3px #1327192b;transition:transform .2s var(--wa-ease)}
.wa-panel .wa-toggle input:checked{background:light-dark(#388a62,#8dc598)}
.wa-panel .wa-tabs{gap:24px;border-color:var(--wa-border);margin-bottom:20px}
.wa-panel .wa-tab{color:var(--wa-muted);opacity:1;transition:color .2s}
.wa-panel .wa-tab[aria-selected=true]{color:var(--wa-accent)}
.wa-panel .wa-tab[aria-selected=true]:after{height:3px;bottom:-2px;border-radius:3px}
.wa-panel .wa-tab-count{color:var(--wa-faint);background:var(--wa-subtle);padding:2px 6px;min-width:21px;text-align:center}
.wa-panel .wa-filters{border-radius:10px;border-color:var(--wa-border);padding:4px;background:var(--wa-subtle)}
.wa-panel .wa-filter{border-radius:7px;color:var(--wa-muted);opacity:1;padding:5px 11px;transition:background .2s,color .2s}
.wa-panel .wa-filter[aria-pressed=true]{background:var(--wa-surface);color:var(--wa-ink);box-shadow:0 1px 4px #1e342e10}
.wa-panel .wa-session-list{border-radius:14px;border-color:var(--wa-border);background:var(--wa-surface);box-shadow:var(--wa-shadow)}
.wa-panel .wa-session-row{padding:17px 20px;border-color:var(--wa-border-soft);transition:background .2s}
.wa-panel .wa-session-row:hover{background:var(--wa-subtle)}
.wa-panel .wa-session-avatar{border:1px solid light-dark(#dae5d3,#41543d);background:linear-gradient(145deg,var(--wa-glint),transparent),var(--wa-subtle);color:var(--wa-muted);border-radius:11px;box-shadow:inset 0 1px 0 var(--wa-glint)}
.wa-panel .wa-session-avatar.is-group{color:light-dark(#548176,#acd3ba);border-color:light-dark(#d6e6dc,#3b5746);background:light-dark(#edf5ee,#2c4032)}
.wa-panel .wa-session-title{font-size:12px;font-weight:600}
.wa-panel .wa-session-meta{color:var(--wa-faint);opacity:1}
.wa-panel .wa-name-suggestions{border-radius:12px;border-color:var(--wa-border);background:var(--wa-surface)}
.wa-panel .wa-records-layout{border-radius:16px;background:var(--wa-surface);border-color:var(--wa-border);box-shadow:var(--wa-shadow)}
.wa-panel .wa-records-sidebar{border-color:var(--wa-border);background:var(--wa-input-surface);padding:18px 13px}
.wa-panel .wa-records-sidebar-label{color:var(--wa-faint);opacity:1}
.wa-panel .wa-records-peer{border:1px solid transparent;border-radius:10px;padding:11px 10px;transition:background .2s,border-color .2s}
.wa-panel .wa-records-peer[aria-current=true]{background:light-dark(#e8f0e1,#2b3e2c);border-color:light-dark(#d4e1cb,#415740)}
.wa-panel .wa-records-peer[aria-current=true] .wa-session-avatar{background:light-dark(#dbeaca,#3a5438);color:var(--wa-accent)}
.wa-panel .wa-record-count{color:var(--wa-faint);opacity:1;font-variant-numeric:tabular-nums}
.wa-panel .wa-records-head,.wa-panel .wa-pagination,.wa-panel .wa-record{border-color:var(--wa-border-soft)}
.wa-panel .wa-record-meta{color:var(--wa-faint);opacity:1;font-variant-numeric:tabular-nums}
.wa-panel .wa-record-question{font-size:12px;line-height:1.85}
.wa-panel .wa-record-reply,.wa-panel .wa-note-box,.wa-panel .wa-persona-example-reply{border-color:light-dark(#a2c095,#63855b);background:light-dark(#f0f6eb,#263829);border-radius:0 10px 10px 0}
.wa-panel .wa-pagination>span{color:var(--wa-muted);opacity:1}
.wa-panel .wa-persona-entry{background:radial-gradient(ellipse at 0 0,light-dark(#e4efda,#354d2f),transparent 80%),var(--wa-surface)}
.wa-panel .wa-persona-total{border-color:var(--wa-border);background:var(--wa-surface);border-radius:20px;color:var(--wa-muted);opacity:1;padding:6px 11px;font-size:10px}
.wa-panel .wa-persona-filter{border-radius:9px;transition:background .2s,border-color .2s;color:var(--wa-muted)}
.wa-panel .wa-persona-filter[aria-pressed=true]{background:light-dark(#e3efd8,#30482d);border-color:light-dark(#bed4b2,#4a6a40);color:var(--wa-accent)}
.wa-panel .wa-persona-results{color:var(--wa-faint);opacity:1}
.wa-panel .wa-persona-card{position:relative;border-radius:16px;border-color:var(--wa-border);background:linear-gradient(145deg,var(--wa-glint),transparent 160px),var(--wa-surface);padding:22px;box-shadow:var(--wa-shadow);transition:transform .25s var(--wa-ease),border-color .25s,box-shadow .25s,background .25s}
.wa-panel .wa-persona-card:hover{background:var(--wa-surface);border-color:light-dark(#b8cbb0,#57724c);box-shadow:var(--wa-shadow-raised);transform:translateY(-4px)}
.wa-panel .wa-persona-card:active{transform:translateY(-1px)}
.wa-panel .wa-persona-emblem{border-radius:14px;background:linear-gradient(140deg,var(--wa-glint),transparent),color-mix(in srgb,var(--persona-color) 10%,var(--wa-surface));border-color:color-mix(in srgb,var(--persona-color) 20%,var(--wa-border-soft));box-shadow:inset 0 1px 0 var(--wa-glint),inset 0 -2px 4px color-mix(in srgb,var(--persona-color) 8%,transparent),0 4px 7px #1b392809;transition:transform .3s var(--wa-ease);color:light-dark(var(--persona-color),color-mix(in srgb,var(--persona-color) 60%,#e4eac6))}
.wa-panel .wa-persona-card:hover .wa-persona-emblem{transform:rotate(-5deg)}
.wa-panel .wa-persona-card strong{font-size:17px;letter-spacing:.3px}
.wa-panel .wa-persona-card>p{color:var(--wa-muted);opacity:1;line-height:1.9;font-size:11px}
.wa-panel .wa-persona-role{color:var(--wa-faint);opacity:1;font-size:10px;margin-top:3px}
.wa-panel .wa-persona-tags>span{background:var(--wa-input-surface);border:1px solid var(--wa-border-soft);border-radius:6px;font-size:9px;color:var(--wa-muted);opacity:1;padding:3px 7px}
.wa-panel .wa-persona-card-footer{border-color:var(--wa-border-soft);color:var(--wa-faint);opacity:1;margin-top:18px;padding-top:14px;font-size:9px}
.wa-panel .wa-persona-card:hover .wa-persona-arrow{color:var(--wa-accent);opacity:1;transform:translateX(3px)}
.wa-panel .wa-persona-arrow{transition:transform .25s,color .25s,opacity .25s}
.wa-panel .wa-memory-tabs,.wa-panel .wa-task-toolbar{border-color:var(--wa-border)}
.wa-panel .wa-memory-tabs>button,.wa-panel .wa-task-tabs>button{color:var(--wa-muted);border:1px solid transparent;border-radius:9px;transition:background .2s,color .2s,border-color .2s}
.wa-panel :is(.wa-memory-tabs,.wa-task-tabs)>button[aria-selected=true]{background:light-dark(#e6f0dc,#2e432b);color:var(--wa-accent);border-color:light-dark(#cbdec0,#46623d);box-shadow:inset 0 1px 0 var(--wa-glint)}
.wa-panel .wa-task,.wa-panel .wa-task-history-row,.wa-panel .wa-task-history-head,.wa-panel .wa-task-pagination{border-color:var(--wa-border-soft)}
.wa-panel .wa-task-heading h3,.wa-panel .wa-task-history-title strong{font-size:12px}
.wa-panel .wa-task-history-row>summary{border-radius:8px;transition:background .2s}
.wa-panel .wa-task-history-row>summary:hover{background:var(--wa-subtle)}
.wa-panel .wa-task-history-row[open]>summary{background:var(--wa-subtle)}
.wa-panel .wa-task-detail-content{border-color:light-dark(#bed1b0,#4f6744);background:var(--wa-input-surface);border-radius:0 10px 10px 0}
.wa-panel .wa-task-badge{border-radius:7px;padding:5px 8px;font-size:10px}
.wa-panel .wa-task-badge:is(.is-completed,.is-sent){color:light-dark(#3f7940,#a5d999);background:light-dark(#ebf3e4,#30432b)}
.wa-panel .wa-task-next>span,.wa-panel .wa-task-history-head,.wa-panel .wa-task-history-title>span{color:var(--wa-faint);opacity:1}
.wa-panel .wa-long-fact{border-radius:12px;border-color:var(--wa-border-soft);background:var(--wa-input-surface)}
.wa-panel .wa-memory-preview,.wa-panel .wa-long-preview{background:var(--wa-input-surface);border:1px solid var(--wa-border-soft);border-radius:11px;line-height:1.9}
.wa-panel .wa-asset-card,.wa-panel .wa-pack-card{border-radius:15px;border-color:var(--wa-border);background:linear-gradient(145deg,var(--wa-glint),transparent 150px),var(--wa-surface);box-shadow:var(--wa-shadow);transition:transform .25s var(--wa-ease),border-color .25s,box-shadow .25s}
.wa-panel .wa-asset-card:hover{border-color:light-dark(#b9ceb1,#58734e);box-shadow:var(--wa-shadow-raised);transform:translateY(-3px)}
.wa-panel .wa-asset-preview{background:radial-gradient(circle at 50% 30%,light-dark(#ffffff,#31462d),transparent 72%),var(--wa-input-surface);border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-asset-preview img{padding:12px;filter:drop-shadow(0 7px 5px #1b332113);transition:transform .3s var(--wa-ease)}
.wa-panel .wa-asset-open:hover .wa-asset-preview img{transform:translateY(-3px) scale(1.035)}
.wa-panel .wa-asset-details{padding:15px}
.wa-panel .wa-asset-details strong{font-size:12px}
.wa-panel .wa-asset-details p,.wa-panel .wa-asset-meta,.wa-panel .wa-assets-statline,.wa-panel .wa-pack-description,.wa-panel .wa-pack-source{color:var(--wa-muted);opacity:1}
.wa-panel .wa-asset-check{background:var(--wa-surface);border-color:var(--wa-border);border-radius:7px;box-shadow:0 2px 4px #1c352112}
.wa-panel input[type=checkbox]{accent-color:light-dark(#358654,#96cc9f)}
.wa-panel .wa-pack-card{padding:19px}
.wa-panel .wa-pack-card.is-enabled{border-color:light-dark(#9dbc8b,#648a54);box-shadow:inset 0 0 0 1px light-dark(#c4d9b526,#79a85b16),var(--wa-shadow)}
.wa-panel .wa-pack-previews{background:radial-gradient(ellipse,light-dark(#eef4e8,#334c2b),transparent 72%);padding:7px 0 10px;margin-bottom:12px}
.wa-panel .wa-pack-previews img{filter:drop-shadow(0 6px 4px #213a2515);transition:transform .3s var(--wa-ease)}
.wa-panel .wa-pack-previews>div:hover img{transform:translateY(-5px) rotate(-5deg)}
.wa-panel .wa-pack-card h3{font-size:14px}
.wa-panel .wa-pack-description{font-size:11px;line-height:1.9}
.wa-panel .wa-pack-footer{border-top:1px solid var(--wa-border-soft);padding-top:13px}
.wa-panel .wa-imported-pack{background:var(--wa-input-surface);border-color:var(--wa-border);border-radius:10px}
.wa-panel .wa-assets-backdrop{background:light-dark(#21302288,#07130fbb);backdrop-filter:blur(6px)}
.wa-panel .wa-assets-dialog{border-radius:20px;background:var(--wa-surface);border-color:var(--wa-border);box-shadow:0 22px 75px #06160a40}
.wa-panel .wa-assets-large-preview{border-color:var(--wa-border-soft);border-radius:14px;background:radial-gradient(ellipse at 50% 35%,light-dark(#fff,#3e5630),transparent 75%),var(--wa-input-surface)}
.wa-panel .wa-assets-large-preview img{filter:drop-shadow(0 10px 10px #173b2420)}
.wa-panel .wa-assets-progress{border-color:var(--wa-border);background:var(--wa-input-surface);border-radius:12px}
.wa-panel .wa-empty{padding:45px 24px;gap:11px}
.wa-panel .wa-empty-icon{width:52px;height:52px;border-radius:17px;color:var(--wa-accent);border-color:var(--wa-border);background:linear-gradient(145deg,var(--wa-glint),transparent),var(--wa-subtle);opacity:1;box-shadow:inset 0 1px 0 var(--wa-glint),0 5px 12px #1b3d2209}
.wa-panel .wa-empty p{color:var(--wa-muted);opacity:1;font-size:11px}
.wa-panel .wa-footer{margin-top:30px;padding-top:17px;border-top:1px solid var(--wa-border-soft);color:var(--wa-faint);opacity:1;font-size:9px}
.wa-panel .wa-changelog>h2{padding-top:23px;border-top:1px solid var(--wa-border-soft);font-size:16px}
.wa-panel .wa-changelog>h2:first-child{border-top:0;padding-top:0}
.wa-panel .wa-changelog>p{color:var(--wa-muted);opacity:1}
.wa-panel .wa-changelog li{opacity:1;line-height:2}
.wa-panel .wa-page-head{animation:wa-page-arrive .35s var(--wa-ease) both}
@keyframes wa-page-arrive{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes wa-sculpture-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes wa-sculpture-orb{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}
@keyframes wa-active-glow{50%{opacity:.5}}
@media(min-width:1500px){.wa-panel .wa-workspace{padding:26px 46px 40px}.wa-panel .wa-nav{padding-top:35px}}
@media(max-width:1140px){
  .wa-panel .wa-workspace{padding:23px 26px 34px}
  .wa-panel .wa-nav{padding-left:10px;padding-right:10px}
  .wa-panel .wa-brand{padding:0 7px;gap:9px}
  .wa-panel .wa-brand-mark{width:34px;height:34px}
  .wa-panel .wa-overview-grid{grid-template-columns:1fr}
  .wa-panel .wa-account-layout{grid-template-columns:minmax(0,1fr) 224px;gap:8px}
  .wa-panel .wa-conversation-sculpture{width:224px;height:194px}
  .wa-panel .wa-sculpture-stage{transform:scale(.86);transform-origin:top left;left:-2px;top:0}
  .wa-panel .wa-stat{padding:20px}
  .wa-panel .wa-setting-link{padding:21px 18px}
}
@media(max-width:820px){
  .wa-panel .wa-nav{padding:24px 8px;gap:27px}
  .wa-panel .wa-brand{padding:0}
  .wa-panel .wa-brand-mark{width:35px;height:35px}
  .wa-panel .wa-nav-button{padding:11px 8px;gap:0}
  .wa-panel .wa-nav-button[aria-current=page]:before{top:12px;bottom:12px}
  .wa-panel .wa-workspace{padding:20px 22px 30px}
  .wa-panel .wa-workspace-chrome{margin-bottom:24px}
  .wa-panel .wa-card{padding:22px}
  .wa-panel .wa-account-card{padding:24px 25px 20px}
  .wa-panel .wa-stat-grid{gap:10px}
  .wa-panel .wa-stat{padding:18px 16px}
  .wa-panel .wa-stat-index{right:13px;top:18px}
  .wa-panel .wa-stat-number{font-size:29px}
  .wa-panel .wa-records-sidebar{border-bottom-color:var(--wa-border)}
  .wa-panel .wa-persona-preview-head{align-items:center}
}
@media(max-width:680px){
  .wa-panel .wa-account-layout{grid-template-columns:minmax(0,1fr) 153px;gap:0}
  .wa-panel .wa-conversation-sculpture{width:153px;height:158px}
  .wa-panel .wa-sculpture-stage{transform:scale(.62);left:-7px;top:5px}
  .wa-panel .wa-account-top{gap:10px}
  .wa-panel .wa-account-avatar{width:42px;height:42px;border-radius:13px;flex-shrink:0}
  .wa-panel .wa-account-name{font-size:18px!important}
  .wa-panel .wa-stat-label{font-size:10px;gap:6px}
  .wa-panel .wa-stat-label>svg{width:14px;height:14px}
  .wa-panel .wa-stat-index{display:none}
  .wa-panel .wa-stat-detail{font-size:9px}
}
@media(max-width:560px){
  .wa-panel .wa-nav{padding:9px 12px;gap:12px;align-items:center;border-bottom-color:var(--wa-border);background:var(--wa-nav-surface)}
  .wa-panel .wa-brand-mark{width:31px;height:33px;border-radius:10px}
  .wa-panel .wa-nav-list{gap:3px;width:100%;min-width:0}
  .wa-panel .wa-nav-button{min-width:0;padding:7px 2px;gap:4px;border-radius:8px;font-size:10px!important}
  .wa-panel .wa-nav-button svg{width:16px;height:16px;display:block}
  .wa-panel .wa-nav-button>span:not(.wa-nav-count){font-size:9px;line-height:1.5}
  .wa-panel .wa-nav-button[aria-current=page]:before{display:none}
  .wa-panel .wa-nav-button[data-testid=nav-settings]{margin-top:0}
  .wa-panel .wa-workspace{padding:17px 16px 26px}
  .wa-panel .wa-workspace-chrome{margin-bottom:22px;min-height:26px}
  .wa-panel .wa-breadcrumb{font-size:9px;gap:7px}
  .wa-panel .wa-motion-control{padding:4px 7px;font-size:9px!important;gap:4px}
  .wa-panel h1{font-size:25px;letter-spacing:-.5px}
  .wa-panel .wa-page-head{align-items:flex-start;gap:13px;margin-bottom:22px}
  .wa-panel .wa-page-head p:not(.wa-eyebrow){font-size:11px}
  .wa-panel .wa-page-head>.wa-badge{font-size:9px;padding:4px 8px}
  .wa-panel .wa-card{padding:19px;border-radius:14px}
  .wa-panel .wa-card-heading{margin-bottom:19px}
  .wa-panel .wa-account-card{padding:21px 20px 18px}
  .wa-panel .wa-account-layout{display:block;position:relative;min-height:0}
  .wa-panel .wa-account-top{max-width:calc(100% - 99px);min-height:81px;margin-bottom:12px;align-items:flex-start;gap:10px;padding-top:7px}
  .wa-panel .wa-account-avatar{width:39px;height:39px;border-radius:12px}
  .wa-panel .wa-account-avatar>.wa-icon{width:22px;height:22px}
  .wa-panel .wa-account-name{font-size:17px!important}
  .wa-panel .wa-account-top .wa-mono{font-size:9px;margin-top:4px;overflow-wrap:anywhere}
  .wa-panel .wa-conversation-sculpture{position:absolute;right:-21px;top:-9px;width:120px;height:119px}
  .wa-panel .wa-sculpture-stage{transform:scale(.5);left:-14px;top:0}
  .wa-panel .wa-account-content{display:block}
  .wa-panel .wa-account-content .wa-help{font-size:10px;line-height:1.85}
  .wa-panel .wa-account-actions{margin-top:16px}
  .wa-panel .wa-account-note{font-size:9px;line-height:1.8;margin-top:17px!important;padding-top:13px}
  .wa-panel .wa-stat-grid{gap:9px}
  .wa-panel .wa-stat{padding:16px 13px;border-radius:12px}
  .wa-panel .wa-stat-label{font-size:10px;margin-bottom:12px}
  .wa-panel .wa-stat-label>svg{display:none}
  .wa-panel .wa-stat-number{font-size:28px}
  .wa-panel .wa-stat-detail{font-size:9px;line-height:1.8;margin-top:8px!important}
  .wa-panel .wa-stat:after{width:52px;height:52px;right:-24px;bottom:-20px}
  .wa-panel .wa-setting-link{padding:20px 18px;border-radius:14px}
  .wa-panel .wa-setting-link .wa-card-icon{width:37px;height:37px}
  .wa-panel .wa-setting-link h3{font-size:13px}
  .wa-panel .wa-setting-link p{font-size:11px}
  .wa-panel .wa-session-row{padding:15px 13px;gap:10px}
  .wa-panel .wa-session-avatar{width:33px;height:33px;border-radius:10px}
  .wa-panel .wa-records-head{padding:19px}
  .wa-panel .wa-records-body{padding:4px 19px}
  .wa-panel .wa-pagination{padding:14px 19px}
  .wa-panel .wa-badge{font-size:9px;padding:3px 7px}
  .wa-panel .wa-mode-option{padding:15px}
  .wa-panel .wa-persona-card{padding:20px;border-radius:14px}
  .wa-panel .wa-persona-card>p{font-size:12px}
  .wa-panel .wa-assets-dialog{padding:19px;border-radius:16px}
  .wa-panel .wa-pack-card{padding:18px}
  .wa-panel .wa-footer{margin-top:26px;gap:9px;font-size:8px}
}
@media(max-width:380px){
  .wa-panel .wa-nav{padding:8px;gap:0}
  .wa-panel .wa-brand{display:none}
  .wa-panel .wa-workspace{padding-left:12px;padding-right:12px}
  .wa-panel .wa-conversation-sculpture{display:none}
  .wa-panel .wa-account-top{max-width:100%;min-height:0;margin-bottom:19px}
  .wa-panel .wa-stat{padding:15px 10px}
  .wa-panel .wa-stat-number{font-size:26px}
  .wa-panel .wa-stat-detail{font-size:8px}
  .wa-panel .wa-breadcrumb{gap:5px}
}
@media(hover:none){.wa-panel :is(.wa-setting-link,.wa-persona-card,.wa-asset-card):hover{transform:none;box-shadow:var(--wa-shadow)}}
@media(prefers-reduced-motion:reduce){.wa-panel *,.wa-panel *:before,.wa-panel *:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.wa-panel[data-motion=off] *,.wa-panel[data-motion=off] *:before,.wa-panel[data-motion=off] *:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
`;
