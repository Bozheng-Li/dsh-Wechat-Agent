// Warm paper, forest ink, and a quiet editorial hierarchy across the whole workspace.
export const studioCss = `
.wa-panel{
 --wa-canvas:light-dark(#f4f3ed,#151d1b);--wa-surface:light-dark(#fffefa,#1e2925);--wa-surface-raised:light-dark(#fffefa,#293830);
 --wa-ink:light-dark(#263b32,#eeeede);--wa-muted:light-dark(#637066,#abb9ae);--wa-faint:light-dark(#6b7768,#93a396);
 --wa-border:light-dark(#dcded2,#3a4b40);--wa-border-soft:light-dark(#e9e9df,#304036);--wa-subtle:light-dark(#eeefe5,#25332b);--wa-hover:light-dark(#e7ecdf,#304137);
 --wa-accent:light-dark(#32634d,#b3d1ad);--wa-accent-hover:light-dark(#234b39,#cce2bf);--wa-input-surface:light-dark(#fbfbf6,#19251e);
 --wa-shadow:0 2px 3px light-dark(#1b301d03,#0001),0 8px 24px light-dark(#1b301d04,#0001);
 --wa-shadow-raised:0 7px 16px light-dark(#1b301d08,#0002),0 20px 36px light-dark(#1b301d06,#0002);
 --wa-title-font:"Georgia","Songti SC","STSong","SimSun",serif;
 background:var(--wa-canvas);font-size:13px;line-height:1.8;scrollbar-color:light-dark(#bdc7b4,#536954) transparent;
}
.wa-panel ::selection{background:light-dark(#d5e2c8,#465f44);color:var(--wa-ink)}
.wa-panel h1,.wa-panel .wa-wb-heading h1{font-family:var(--wa-title-font);font-size:32px;font-weight:500;letter-spacing:.045em;line-height:1.45}
.wa-panel .wa-eyebrow,.wa-panel .wa-wb-eyebrow{font:9px/1.7 "Segoe UI",sans-serif;letter-spacing:.19em;color:var(--wa-faint);opacity:1}
.wa-panel .wa-shell{grid-template-columns:208px minmax(0,1fr)}
.wa-panel .wa-workspace{max-width:1460px;padding:27px 40px 36px}
.wa-panel .wa-workspace-chrome{border-bottom:1px solid var(--wa-border);padding-bottom:17px;margin-bottom:29px}
.wa-panel .wa-breadcrumb{font-size:11px}.wa-panel .wa-motion-control{font-size:11px!important}
.wa-panel .wa-page-head{margin-bottom:27px}.wa-panel .wa-page-head p:not(.wa-eyebrow){font-size:13px;line-height:1.85}
.wa-panel .wa-nav{background:#243d32;color:#ecf0e3;border-color:#314d3c;padding:33px 17px 23px;gap:31px}
.wa-panel .wa-brand{gap:12px;padding:0 8px}.wa-panel .wa-brand-mark{width:36px;height:39px;border-radius:12px 12px 12px 3px;background:#e4e8cd;color:#2e4c36;border-color:#edf0d844;box-shadow:0 4px 12px #06181022}
.wa-panel .wa-brand strong{font-size:15px;font-weight:600}.wa-panel .wa-brand small{font-size:7px;letter-spacing:.19em;color:#abbfae}
.wa-panel .wa-nav-group{margin-bottom:24px}.wa-panel .wa-nav-label{color:#a2b5a5;font-size:10px;letter-spacing:.1em;padding-left:10px;margin-left:0}
.wa-panel .wa-nav-button{color:#c5d1c4;border-radius:8px;padding:10px 12px;margin-bottom:3px;font-size:12px!important;border:1px solid transparent}
.wa-panel .wa-nav-button:hover{background:#365340;color:#fff}.wa-panel .wa-nav-button[aria-current=page]{background:#e6ecd8;border-color:#eef3e133;color:#284231;box-shadow:0 3px 9px #0c201b17}
.wa-panel .wa-nav-button[aria-current=page] svg{color:#326044}.wa-panel .wa-nav-button[data-testid=nav-settings]{margin-top:0}
.wa-panel .wa-nav-footer{color:#c9d4c4;border-color:#49604a;font-size:11px}.wa-panel .wa-nav-footer>span{color:#a7b9a5;font-size:10px}
.wa-panel .wa-nav .wa-status-dot{background:#a5b5a3}.wa-panel .wa-nav .wa-status-dot.is-online{background:#c5dbaa;box-shadow:0 0 0 3px #c5dbaa12}
.wa-panel .wa-button{border-radius:8px;min-height:36px;padding:8px 14px}
.wa-panel .wa-button.wa-primary{background:linear-gradient(135deg,light-dark(#3c6951,#d5e5be),light-dark(#2c513d,#b5ce9f));color:light-dark(#fffdf4,#243927);border-color:light-dark(#365c45,#c1d8ad);box-shadow:inset 0 1px 0 #ffffff15,0 3px 8px #1b35221a}
.wa-panel .wa-button.wa-primary:hover:not(:disabled){background:linear-gradient(135deg,light-dark(#4d7b5e,#e2edcf),light-dark(#39634b,#caddb8));border-color:var(--wa-accent)}
.wa-panel .wa-button:hover:not(:disabled){border-color:light-dark(#aebfa6,#6c8568)}
.wa-panel .wa-card,.wa-panel .wa-wb-card{border-radius:15px;box-shadow:var(--wa-shadow)}
.wa-panel .wa-card-heading{padding-bottom:17px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:19px}
.wa-panel .wa-card-icon{border-radius:12px 12px 12px 4px;background:var(--wa-subtle);color:var(--wa-accent);box-shadow:none}
.wa-panel .wa-intro-card{container-type:inline-size;container-name:wa-intro;min-height:337px;border-radius:18px;border-color:#345847;background:radial-gradient(ellipse at 88% 40%,#71987335,transparent 62%),linear-gradient(130deg,#2a4b3e,#203e32);color:#f8f3df;box-shadow:inset 0 1px 0 #d3e4bf1a,0 9px 25px #233b2712}
.wa-panel .wa-intro-card:after{left:0;right:0;top:auto;bottom:14px;width:auto;height:1px;transform:none;background:linear-gradient(90deg,transparent,#d4dfb621,transparent)}
.wa-panel .wa-intro-copy{padding:30px 32px 35px;max-width:76%}
.wa-panel .wa-intro-kicker{color:#c6d4b9;font-size:10px;letter-spacing:.16em;margin-bottom:20px}.wa-panel .wa-intro-kicker i{background:#d5c48d;box-shadow:none}
.wa-panel .wa-intro-copy h2{font-family:var(--wa-title-font);font-size:34px;font-weight:400;line-height:1.55;letter-spacing:.03em;white-space:nowrap}
.wa-panel .wa-intro-copy h2>span{color:#d4dfbd}.wa-panel .wa-intro-copy>p{color:#c4d0bc;font-size:12px;margin-top:14px;line-height:1.9}
.wa-panel .wa-intro-actions{margin-top:23px}.wa-panel .wa-intro-actions .wa-primary{background:linear-gradient(135deg,#f3f1da,#dce7c5);color:#30432b;border-color:#e6edcf}
.wa-panel .wa-intro-actions .wa-primary:hover:not(:disabled){background:#f4f5e2}.wa-panel .wa-intro-actions .wa-quiet{color:#d6dfc8}
.wa-panel .wa-intro-edition{color:#cedabc75;letter-spacing:.14em;font-size:7px;bottom:17px}
.wa-panel .wa-conversation-sculpture{right:-21px;top:20px;width:312px;height:285px;opacity:1}.wa-panel .wa-sculpture-float{animation-duration:12s}
/* The host sidebar can leave a narrow card even in a wide viewport. */
@container wa-intro (max-width:680px){.wa-panel .wa-conversation-sculpture{display:none}}
.wa-panel .wa-account-card{min-height:337px;border-radius:18px;padding:25px 25px 20px;background:var(--wa-surface)}
.wa-panel .wa-account-kicker{padding-bottom:15px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:21px!important}
.wa-panel .wa-account-avatar{border-radius:50%;background:var(--wa-subtle);border-color:var(--wa-border);color:var(--wa-accent)}
.wa-panel .wa-account-name{font-size:17px!important}.wa-panel .wa-account-note{font-size:10px}
.wa-panel .wa-persona-ribbon{display:flex;align-items:center;gap:22px;padding:19px 22px;background:var(--wa-surface);border:1px solid var(--wa-border);border-radius:13px}
.wa-panel .wa-persona-ribbon-identity{display:flex;gap:12px;align-items:center;flex-shrink:0;min-width:0}
.wa-panel .wa-persona-ribbon-avatar{display:grid;place-items:center;width:43px;height:47px;background:light-dark(#e7dfc9,#4c5138);color:light-dark(#726b45,#d6d5ac);border:1px solid light-dark(#d8ceb3,#626548);border-radius:11px 11px 11px 3px;font:23px/1 var(--wa-title-font);flex-shrink:0}
.wa-panel .wa-persona-ribbon-identity>div>span{display:block;color:var(--wa-faint);font-size:10px}.wa-panel .wa-persona-ribbon-identity strong{display:block;font-size:15px;font-weight:550;overflow-wrap:anywhere;max-width:180px}
.wa-panel .wa-persona-ribbon>p{font-size:12px;color:var(--wa-muted);flex:1;max-width:370px}.wa-panel .wa-persona-ribbon>.wa-row{margin-left:auto;gap:3px;flex-wrap:nowrap}
.wa-panel .wa-persona-ribbon .wa-button{font-size:11px!important;padding:7px 9px}
.wa-panel .wa-stat-grid{background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:13px;padding:0}
.wa-panel .wa-stat{padding:19px 23px}.wa-panel .wa-stat:first-child{padding-left:23px}.wa-panel .wa-stat:last-child{padding-right:23px}.wa-panel .wa-stat-number{font:34px/1.1 Georgia,serif;color:var(--wa-accent);letter-spacing:-1px}
.wa-panel .wa-summary-item>svg{background:var(--wa-subtle);color:var(--wa-accent);border-radius:10px}.wa-panel .wa-participation-index{color:var(--wa-accent);background:var(--wa-subtle);min-width:25px;text-align:center;border-radius:50%;line-height:25px}
.wa-panel .wa-settings-sections{display:flex;flex-direction:column;gap:32px}.wa-panel .wa-settings-section-head{display:flex;align-items:center;gap:15px;margin-bottom:17px}
.wa-panel .wa-settings-section-head>span{font:26px/1 Georgia,serif;color:var(--wa-faint);opacity:.65}.wa-panel .wa-settings-section-head h2{font-size:15px}.wa-panel .wa-settings-section-head p{font-size:11px;color:var(--wa-muted);margin-top:3px}
.wa-panel .wa-setting-grid{gap:16px;grid-template-columns:repeat(3,minmax(0,1fr))}.wa-panel .wa-setting-link{padding:23px;gap:18px 10px;border-radius:15px;position:relative}
.wa-panel .wa-setting-link:before{content:'';position:absolute;left:23px;right:23px;top:0;height:2px;background:var(--wa-accent);opacity:0;transition:opacity .2s}.wa-panel .wa-setting-link:hover:before{opacity:.6}
.wa-panel .wa-setting-link:hover{border-color:light-dark(#afc0a5,#688362)}.wa-panel .wa-setting-link h3{font-size:16px}.wa-panel .wa-setting-link .wa-card-icon{width:39px;height:41px}
.wa-panel .wa-setting-caption{border-color:var(--wa-border-soft);color:var(--wa-muted);font-size:10px;line-height:1.8}
.wa-panel .wa-persona-studio{display:grid;grid-template-columns:minmax(0,1fr) 250px;align-items:start;gap:26px;max-width:1180px}
.wa-panel .wa-persona-manuscript{padding:28px;min-width:0}.wa-panel .wa-persona-manuscript>.wa-between{padding-bottom:22px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:22px}
.wa-panel .wa-persona-manuscript>.wa-between h2{font-size:16px}.wa-panel .wa-persona-editor{font-size:14px!important;line-height:2;min-height:460px}
.wa-panel .wa-persona-guide{position:sticky;top:25px;min-width:0}.wa-panel .wa-persona-guide-profile{padding:27px 22px;background:var(--wa-subtle);border:1px solid var(--wa-border);border-radius:15px}
.wa-panel .wa-persona-guide-profile>.wa-persona-ribbon-avatar{margin-bottom:18px;width:50px;height:55px;font-size:27px}.wa-panel .wa-persona-guide-profile>span:not(.wa-persona-ribbon-avatar){font-size:10px;color:var(--wa-faint)}
.wa-panel .wa-persona-guide-profile h2{font-family:var(--wa-title-font);font-size:25px;font-weight:500;margin:5px 0 12px;overflow-wrap:anywhere}.wa-panel .wa-persona-guide p{font-size:12px;line-height:1.9;color:var(--wa-muted)}
.wa-panel .wa-persona-guide-note{padding:25px 5px}.wa-panel .wa-persona-guide h3{font-size:13px;margin-bottom:10px}.wa-panel .wa-persona-guide .wa-section-number{font-size:10px;letter-spacing:0}
.wa-panel .wa-persona-guide blockquote{font-family:var(--wa-title-font);font-size:15px;line-height:1.95;margin:17px 0;padding:0 0 0 14px;border-left:2px solid light-dark(#a5b195,#6d8465);color:var(--wa-ink)}
.wa-panel .wa-persona-guide-scope{padding:20px 5px;border-top:1px solid var(--wa-border)}
.wa-panel .wa-note-box{border-left-color:var(--wa-accent);background:var(--wa-subtle)}
.wa-panel .wa-input,.wa-panel .wa-select,.wa-panel .wa-textarea{border-radius:8px}.wa-panel :is(.wa-input,.wa-select,.wa-textarea):focus{box-shadow:0 0 0 3px color-mix(in srgb,var(--wa-accent) 9%,transparent)}
.wa-panel .wa-toggle input:checked{background:var(--wa-accent)}.wa-panel input[type=checkbox]{accent-color:var(--wa-accent)}
.wa-panel .wa-mode-option:has(input:checked){border-color:light-dark(#8fa582,#65815d);background:light-dark(#f0f4e9,#2a3a2c)}
.wa-panel .wa-badge.is-accent{background:light-dark(#edf3e8,#2c402b);color:light-dark(#4d7246,#c1d7ab);border-color:light-dark(#d8e2cf,#4d6242)}
.wa-panel .wa-session-avatar.is-group{color:var(--wa-accent);background:var(--wa-subtle);border-color:var(--wa-border)}
.wa-panel .wa-records-peer[aria-current=true]{background:var(--wa-subtle);border-color:light-dark(#bbcbae,#5c7452)}.wa-panel .wa-records-peer[aria-current=true] .wa-session-avatar{background:var(--wa-surface);color:var(--wa-accent)}
.wa-panel .wa-record-reply{background:var(--wa-subtle);border-left-color:light-dark(#8ea680,#6c8961)}
.wa-panel .wa-record-memory{border:1px solid var(--wa-border-soft);background:var(--wa-input-surface);border-radius:9px;padding:13px 15px;margin-top:14px;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-record-memory-label{display:block;font-size:10px;letter-spacing:.04em;color:var(--wa-faint);margin-bottom:7px}.wa-panel .wa-record-memory .wa-row{gap:7px 15px;color:var(--wa-ink);font-size:11px}.wa-panel .wa-record-memory p{margin-top:8px;font-size:11px;line-height:1.8;overflow-wrap:anywhere}
.wa-panel .wa-memory-overview,.wa-panel .wa-memory-content>.wa-memory-overview{background:var(--wa-surface);border-radius:15px}
.wa-panel .wa-memory-book{color:var(--wa-accent);border-color:var(--wa-border);background:linear-gradient(125deg,light-dark(#f4f6e9,#4b6140),light-dark(#dbe3c8,#2a3c28));box-shadow:inset 3px 0 0 light-dark(#b7c29f,#728662),inset 0 1px 0 var(--wa-glint),3px 4px 0 light-dark(#e0e3d4,#162319),0 7px 12px #2030100a}
.wa-panel .wa-memory-tabs{background:transparent;border:0;border-bottom:1px solid var(--wa-border);border-radius:0;padding:0;gap:5px;max-width:none}
.wa-panel .wa-memory-tabs>button{padding:13px 18px;border-radius:9px 9px 0 0;border:1px solid transparent;border-bottom:2px solid transparent;margin-bottom:-1px;flex:0 1 210px}
.wa-panel .wa-memory-tabs>button[aria-selected=true]{background:var(--wa-surface);border-color:var(--wa-border);border-bottom-color:var(--wa-accent);box-shadow:none;color:var(--wa-accent)}
.wa-panel .wa-memory-metrics dd{font-family:Georgia,serif;color:var(--wa-accent)}.wa-panel .wa-memory-meter>span{background:light-dark(#7f996b,#bdd2aa)}
.wa-panel .wa-long-source-head>h3{border-left-color:var(--wa-accent)}.wa-panel .wa-long-fact{padding:20px 0}
.wa-panel .wa-persona-card{background:var(--wa-surface);border-radius:0}.wa-panel .wa-persona-emblem{color:light-dark(#678151,#bed6a0)}
.wa-panel .wa-wb-heading{border-bottom:1px solid var(--wa-border);padding-bottom:23px}.wa-panel .wa-wb-heading p{color:var(--wa-muted);opacity:1}
.wa-panel .wa-wb-paper{border-left-color:light-dark(#839a6e,#8ba079);border-radius:0 8px 8px 0}.wa-panel .wa-wb-card .wa-wb-fact-text{font-family:var(--wa-title-font);font-size:19px!important;letter-spacing:.01em}
.wa-panel .wa-wb-note,.wa-panel .wa-wb-empty p{color:var(--wa-muted);opacity:1}
.wa-panel .wa-wb-strip{background:var(--wa-subtle);border-radius:12px}.wa-panel .wa-wb-strip strong{font-family:Georgia,"Microsoft YaHei",serif;font-size:18px;color:var(--wa-accent)}
.wa-panel .wa-wb-button{border-radius:8px}.wa-panel .wa-wb-button:not(.is-quiet):not(.is-danger){color:light-dark(#fffef3,#243927);background:var(--wa-accent)}
.wa-panel .wa-wb-empty{background:var(--wa-subtle);border-color:var(--wa-border)}.wa-panel .wa-wb-number{color:var(--wa-accent);opacity:.6}
.wa-panel .wa-footer{font-size:10px;margin-top:33px;padding-top:19px}.wa-panel .wa-assets-backdrop{background:#10251888}.wa-panel .wa-assets-dialog{border-radius:18px}
@media(min-width:1450px){.wa-panel .wa-workspace{padding:29px 48px 40px}.wa-panel .wa-conversation-sculpture{right:-8px;width:350px;height:315px;top:3px}.wa-panel .wa-intro-copy h2{font-size:37px}}
@media(max-width:1180px){.wa-panel .wa-shell{grid-template-columns:182px minmax(0,1fr)}.wa-panel .wa-workspace{padding:25px 28px 32px}.wa-panel .wa-nav{padding:29px 12px 22px}.wa-panel .wa-brand strong{font-size:13px}.wa-panel .wa-brand-mark{width:31px;height:35px}.wa-panel .wa-overview-lead{grid-template-columns:1fr}.wa-panel .wa-intro-copy{max-width:70%}.wa-panel .wa-conversation-sculpture{right:10px;top:8px;width:340px;height:306px}.wa-panel .wa-account-card{min-height:0}.wa-panel .wa-persona-ribbon>p{display:none}.wa-panel .wa-persona-studio{grid-template-columns:minmax(0,1fr) 220px;gap:20px}.wa-panel .wa-persona-manuscript{padding:23px}.wa-panel .wa-setting-link{padding:21px}.wa-panel .wa-setting-grid{gap:13px}}
@media(max-width:1000px){.wa-panel .wa-persona-studio{grid-template-columns:1fr}.wa-panel .wa-persona-guide{position:static;display:grid;grid-template-columns:1fr 1fr;gap:22px}.wa-panel .wa-persona-guide-note{padding:12px 0}.wa-panel .wa-persona-guide-scope{grid-column:1/-1}.wa-panel .wa-setting-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wa-panel .wa-settings-section .wa-setting-link:last-child{grid-column:1/-1;grid-template-columns:42px minmax(0,1fr) auto;gap:16px;align-items:center}.wa-panel .wa-settings-section .wa-setting-link:last-child>div:nth-child(2){grid-column:2;grid-row:1}.wa-panel .wa-settings-section .wa-setting-link:last-child>svg{grid-column:3;grid-row:1}.wa-panel .wa-settings-section .wa-setting-link:last-child .wa-setting-caption{padding-top:8px;margin-top:9px}}
@media(max-width:820px){.wa-panel .wa-shell{grid-template-columns:66px minmax(0,1fr)}.wa-panel .wa-nav{padding:23px 8px}.wa-panel .wa-brand{padding:0}.wa-panel .wa-brand-mark{width:34px}.wa-panel .wa-nav-button{padding:12px 10px}.wa-panel .wa-workspace{padding:22px}.wa-panel .wa-intro-copy h2{font-size:33px}.wa-panel .wa-intro-copy{padding:29px;max-width:80%}.wa-panel .wa-conversation-sculpture{width:290px;height:261px;right:-20px;top:45px}.wa-panel .wa-persona-ribbon{padding:16px;gap:12px}.wa-panel .wa-persona-ribbon-identity strong{max-width:130px}}
@media(max-width:560px){.wa-panel .wa-shell{display:flex}.wa-panel .wa-nav{padding:9px 12px;gap:10px}.wa-panel .wa-nav-group{margin:0}.wa-panel .wa-nav-button{padding:8px 6px;margin:0}.wa-panel .wa-nav-group+.wa-nav-group{border-color:#48614a}.wa-panel .wa-workspace{padding:18px 17px 27px}.wa-panel .wa-workspace-chrome{padding-bottom:13px;margin-bottom:24px}.wa-panel h1,.wa-panel .wa-wb-heading h1{font-size:28px}.wa-panel .wa-eyebrow{font-size:8px;letter-spacing:.15em}.wa-panel .wa-page-head{gap:10px}.wa-panel .wa-page-head p:not(.wa-eyebrow){font-size:12px}.wa-panel .wa-breadcrumb,.wa-panel .wa-motion-control{font-size:9px!important}.wa-panel .wa-card{padding:20px}.wa-panel .wa-intro-card{min-height:360px;border-radius:15px}.wa-panel .wa-intro-copy{padding:26px;max-width:100%}.wa-panel .wa-intro-copy h2{font-size:29px}.wa-panel .wa-intro-copy>p{font-size:12px}.wa-panel .wa-intro-actions{margin-top:27px}.wa-panel .wa-conversation-sculpture{width:210px;height:189px;right:-25px;top:145px;opacity:.7}.wa-panel .wa-intro-edition{font-size:6px;left:26px;right:auto}.wa-panel .wa-account-card{min-height:0}.wa-panel .wa-persona-ribbon{flex-wrap:wrap;padding:18px}.wa-panel .wa-persona-ribbon-identity strong{max-width:210px}.wa-panel .wa-persona-ribbon>.wa-row{width:100%;justify-content:space-between;margin:0;border-top:1px solid var(--wa-border-soft);padding-top:9px}.wa-panel .wa-persona-ribbon .wa-button{padding-left:0}.wa-panel .wa-stat,.wa-panel .wa-stat:first-child,.wa-panel .wa-stat:last-child{padding:15px 12px}.wa-panel .wa-stat-number{font-size:30px}.wa-panel .wa-stat-label{font-size:10px}.wa-panel .wa-stat-detail{font-size:9px}.wa-panel .wa-setting-grid{grid-template-columns:1fr}.wa-panel .wa-settings-section .wa-setting-link:last-child{grid-template-columns:minmax(0,1fr) auto;gap:18px 10px}.wa-panel .wa-settings-section .wa-setting-link:last-child>div:nth-child(2){grid-column:1/-1;grid-row:2}.wa-panel .wa-settings-section .wa-setting-link:last-child>svg{grid-column:2}.wa-panel .wa-settings-section .wa-setting-link:last-child .wa-setting-caption{margin-top:19px;padding-top:13px}.wa-panel .wa-persona-manuscript{padding:20px}.wa-panel .wa-persona-guide{grid-template-columns:1fr;gap:4px}.wa-panel .wa-persona-guide-note{padding:23px 3px}.wa-panel .wa-persona-manuscript>.wa-between{align-items:flex-start;flex-wrap:wrap;gap:12px}.wa-panel .wa-persona-editor{font-size:13px!important;min-height:410px}.wa-panel .wa-memory-tabs>button{padding:11px 12px;flex:1 1 115px}.wa-panel .wa-memory-tabs small{font-size:10px}.wa-panel .wa-memory-tabs strong{font-size:12px}.wa-panel .wa-wb-heading{padding-bottom:18px}}
@media(max-width:380px){.wa-panel .wa-workspace{padding-left:12px;padding-right:12px}.wa-panel .wa-nav{padding:8px}.wa-panel .wa-intro-copy{padding:23px}.wa-panel .wa-intro-copy h2{font-size:26px}.wa-panel .wa-intro-card{min-height:350px}.wa-panel .wa-conversation-sculpture{width:180px;height:162px;top:167px;right:-21px}.wa-panel .wa-intro-edition{left:23px;font-size:5px}.wa-panel .wa-stat,.wa-panel .wa-stat:first-child,.wa-panel .wa-stat:last-child{padding:14px 9px}.wa-panel .wa-stat-label{font-size:10px}.wa-panel .wa-stat-detail{font-size:8px}.wa-panel .wa-memory-tabs>button{padding:10px}.wa-panel .wa-card{padding:18px}}
@media(max-width:560px){.wa-panel .wa-memory-workspace-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding-bottom:10px}.wa-panel .wa-memory-workspace-tabs>button{margin:0;border-radius:8px;border-bottom-width:1px}.wa-panel .wa-memory-workspace-tabs>button[aria-selected=true]{border-color:var(--wa-border);box-shadow:inset 3px 0 0 var(--wa-accent)}.wa-panel .wa-memory-workspace-tabs strong{font-size:12px}.wa-panel .wa-memory-workspace-tabs small{font-size:10px}}
@media(hover:none){.wa-panel .wa-setting-link:hover{transform:none;box-shadow:var(--wa-shadow)}}
`;
