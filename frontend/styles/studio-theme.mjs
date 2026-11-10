// Unified appearance for every page; structural rules remain in base/workbench.
export const studioCss = `
.wa-panel{
 --wa-canvas:light-dark(#f7f7f4,#181c1b);--wa-surface:light-dark(#fff,#222726);--wa-surface-raised:light-dark(#fff,#2d3331);
 --wa-ink:light-dark(#28332f,#e9eeea);--wa-muted:light-dark(#606a64,#b0bbb4);--wa-faint:light-dark(#6c766e,#9ba99f);
 --wa-border:light-dark(#e0e4dd,#3c4641);--wa-border-soft:light-dark(#ecefe9,#323b36);--wa-subtle:light-dark(#f3f5f0,#29322d);--wa-hover:light-dark(#edf2eb,#333f37);
 --wa-accent:light-dark(#326b52,#abd3b9);--wa-accent-hover:light-dark(#275740,#c2e2cc);--wa-input-surface:light-dark(#fcfdfa,#1e2521);--wa-glint:transparent;
 --wa-shadow:0 2px 4px light-dark(#26332b03,#00000010),0 8px 22px light-dark(#26332b02,#00000008);--wa-shadow-raised:0 16px 48px light-dark(#25352b18,#00000040);
 --wa-title-font:"Segoe UI Variable Display","Segoe UI","Microsoft YaHei",sans-serif;
 color:var(--wa-ink);background:var(--wa-canvas);font:13px/1.75 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei",sans-serif;
 scrollbar-color:light-dark(#bfc5ba,#526155) transparent;text-rendering:optimizeLegibility;
}
.wa-panel ::selection{background:light-dark(#dceade,#3b5845);color:var(--wa-ink)}
.wa-panel :is(h1,h2,h3){font-family:var(--wa-title-font);letter-spacing:0;overflow-wrap:anywhere}
.wa-panel :is(h1,.wa-wb-heading h1){font-size:30px;line-height:1.4;font-weight:600;letter-spacing:-.025em;margin:0}
.wa-panel h2{font-size:16px;font-weight:600;line-height:1.55}.wa-panel h3{font-size:14px;font-weight:600;line-height:1.6}
.wa-panel :is(.wa-muted,.wa-help,.wa-wb-note,.wa-wb-loading){color:var(--wa-muted);opacity:1;font-size:12px;line-height:1.8}
.wa-panel :is(.wa-row,.wa-between,.wa-wb-between,.wa-wb-actions){min-width:0}.wa-panel :is(.wa-row,.wa-between,.wa-wb-between)>:is(div,span,p){min-width:0}
.wa-panel :is(.wa-eyebrow,.wa-wb-eyebrow){color:var(--wa-faint);opacity:1;font-size:11px;letter-spacing:.04em}.wa-panel .wa-eyebrow{display:none}
.wa-panel :is(button,input,textarea,select,summary,a):focus-visible{outline:2px solid var(--wa-accent);outline-offset:3px}
.wa-panel :is(.wa-mono,.wa-stat-number,.wa-memory-metrics dd){font-variant-numeric:tabular-nums}
/* Navigation and common page rhythm. */
.wa-panel .wa-shell{display:grid;grid-template-columns:198px minmax(0,1fr);min-height:100%}
.wa-panel .wa-nav{background:light-dark(#f0f2ec,#1c231f);border-color:var(--wa-border);padding:29px 13px 22px;gap:34px}
.wa-panel .wa-brand{gap:11px;padding:0 9px}.wa-panel .wa-brand-mark{width:33px;height:33px;border-radius:10px;background:var(--wa-accent);color:light-dark(#fff,#18271d);border:0;box-shadow:none}
.wa-panel .wa-brand strong{font-size:14px;font-weight:600;letter-spacing:-.02em}
.wa-panel .wa-nav-list{display:flex;flex-direction:column;gap:23px}.wa-panel .wa-nav-group{margin:0}
.wa-panel .wa-nav-label{margin:0;padding:0 11px 8px;color:var(--wa-faint);font-size:10px;letter-spacing:.1em;opacity:1}
.wa-panel .wa-nav-button{position:relative;min-height:40px;padding:9px 12px;border:1px solid transparent;border-radius:8px;gap:11px;font-size:12px!important;color:var(--wa-muted);background:transparent;box-shadow:none;font-weight:450}
.wa-panel .wa-nav-button>span{display:block}.wa-panel .wa-nav-button>svg{width:17px;height:17px}.wa-panel .wa-nav-button:hover{color:var(--wa-ink);background:var(--wa-hover)}
.wa-panel .wa-nav-button[aria-current=page]{color:var(--wa-accent);background:var(--wa-surface);border-color:var(--wa-border-soft);font-weight:600;box-shadow:var(--wa-shadow)}
.wa-panel .wa-nav-button[aria-current=page]::before{content:'';position:absolute;left:-1px;top:12px;bottom:12px;width:3px;border-radius:2px;background:var(--wa-accent)}
.wa-panel .wa-nav-button[aria-current=page] svg{color:var(--wa-accent)}.wa-panel .wa-nav-button[data-testid=nav-settings]{margin-top:0}
.wa-panel .wa-nav-footer{padding:16px 10px 0;color:var(--wa-muted);border-color:var(--wa-border);opacity:1;font-size:11px}.wa-panel .wa-nav-footer>span{font-size:10px;color:var(--wa-faint)}
.wa-panel .wa-status-dot.is-online{background:light-dark(#39845f,#90c6a6);box-shadow:none}
.wa-panel .wa-workspace{width:100%;max-width:1380px;padding:24px 38px 48px}.wa-panel .wa-workspace-chrome{min-height:29px;border-bottom:1px solid var(--wa-border);padding-bottom:13px;margin-bottom:27px}
.wa-panel .wa-breadcrumb{font-size:11px;gap:9px}.wa-panel .wa-breadcrumb>span:first-child{font-weight:450}
.wa-panel :is(.wa-page-head,.wa-wb-heading){display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0;margin:0 0 28px;border:0}
.wa-panel :is(.wa-page-head,.wa-wb-heading)>div:first-child{min-width:0}
.wa-panel :is(.wa-page-head,.wa-wb-heading) p:not(.wa-eyebrow){margin:9px 0 0;font-size:12px;color:var(--wa-muted);opacity:1;line-height:1.85;max-width:620px}
.wa-panel .wa-stack{gap:20px}.wa-panel .wa-content-narrow{max-width:900px}.wa-panel .wa-local-preview{border-radius:5px;font-size:10px;color:var(--wa-muted)}
/* Shared controls, surfaces, and feedback. */
.wa-panel :is(.wa-button,.wa-wb-button){display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:35px;padding:7px 12px;border:1px solid var(--wa-border);border-radius:7px;background:var(--wa-surface);color:var(--wa-ink);font-size:12px!important;font-weight:550;line-height:1.6;box-shadow:none;transform:none;filter:none;white-space:normal;transition:background .15s,border-color .15s,color .15s}
.wa-panel :is(.wa-button,.wa-wb-button):hover:not(:disabled){background:var(--wa-hover);border-color:light-dark(#bbc6b9,#5b6d60);box-shadow:none;transform:none;filter:none}
.wa-panel .wa-button.wa-primary,.wa-panel .wa-wb-button:not(.is-quiet):not(.is-danger){background:var(--wa-accent);border-color:var(--wa-accent);color:light-dark(#fff,#18271d)}
.wa-panel .wa-button.wa-primary:hover:not(:disabled),.wa-panel .wa-wb-button:not(.is-quiet):not(.is-danger):hover:not(:disabled){background:var(--wa-accent-hover);border-color:var(--wa-accent-hover)}
.wa-panel .wa-button.wa-quiet{background:transparent;border-color:transparent}.wa-panel .wa-wb-button.is-quiet{background:transparent;border-color:var(--wa-border)}
.wa-panel :is(.wa-button,.wa-wb-button):disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
.wa-panel :is(.wa-button.wa-danger,.wa-wb-button.is-danger){background:transparent;color:light-dark(#7e302b,#edaaa4);border-color:light-dark(#e7cec8,#64453f)}
.wa-panel :is(.wa-button.wa-danger,.wa-wb-button.is-danger):hover:not(:disabled){background:light-dark(#fff1ee,#3e2c29)}
.wa-panel .wa-back{font-size:12px!important;color:var(--wa-muted);margin-bottom:18px}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select,.wa-wb-page input:not([type=checkbox]):not([type=file]),.wa-wb-page textarea,.wa-wb-page select){background:var(--wa-input-surface);color:var(--wa-ink);border:1px solid var(--wa-border);border-radius:7px;font-size:13px;line-height:1.7;padding:9px 11px;min-width:0;max-width:100%;box-shadow:none}
.wa-panel :is(.wa-input,.wa-select){min-height:38px}.wa-panel :is(.wa-input,.wa-textarea,.wa-select):focus{border-color:var(--wa-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--wa-accent) 8%,transparent)}
.wa-panel input[type=checkbox]{accent-color:var(--wa-accent)}.wa-panel .wa-toggle input:checked{background:var(--wa-accent)}
.wa-panel input[type=file]{max-width:100%;font:12px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;color:var(--wa-muted)}
.wa-panel input[type=file]::file-selector-button{margin-right:12px;padding:7px 12px;border:1px solid var(--wa-border);border-radius:7px;background:var(--wa-surface);color:var(--wa-ink);font:inherit;font-weight:550;cursor:pointer;transition:background .15s,border-color .15s}
.wa-panel input[type=file]::file-selector-button:hover{background:var(--wa-hover);border-color:var(--wa-accent)}
.wa-panel :is(.wa-card,.wa-wb-card){padding:24px;background:var(--wa-surface);border:1px solid var(--wa-border);border-radius:12px;box-shadow:var(--wa-shadow);min-width:0}
.wa-panel .wa-card-heading{margin-bottom:20px}.wa-panel .wa-card-heading p{font-size:12px;margin-top:5px}
.wa-panel :is(.wa-card-icon,.wa-empty-icon,.wa-session-avatar){border-radius:9px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);color:var(--wa-accent);box-shadow:none}.wa-panel .wa-card-icon{width:35px;height:35px}
.wa-panel :is(.wa-badge,.wa-wb-tag){padding:3px 8px;font-size:10px;line-height:1.7;border-radius:5px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);color:var(--wa-muted);letter-spacing:0}
.wa-panel .wa-task-badge{padding:3px 8px;font-size:10px;line-height:1.7;border-radius:5px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);color:var(--wa-muted)}
.wa-panel .wa-task-badge:is(.is-completed,.is-sent){background:light-dark(#edf5ed,#283d2e);color:light-dark(#326f4d,#b1d8bb);border-color:light-dark(#dce9da,#405b44)}
.wa-panel .wa-task-badge:is(.is-running,.is-queued){background:var(--wa-subtle);color:var(--wa-accent);border-color:var(--wa-border)}
.wa-panel .wa-task-badge:is(.is-unknown,.is-partial,.is-settling){background:light-dark(#fbf4e7,#382f22);color:light-dark(#8a632a,#e3c18c);border-color:light-dark(#eedfc2,#5a4b31)}
.wa-panel .wa-task-badge.is-failed{background:light-dark(#fcf0ed,#3b2b29);color:light-dark(#a44842,#eeb0a8);border-color:light-dark(#edd7d0,#60443e)}
.wa-panel :is(.wa-badge.is-success,.wa-badge.is-accent,.wa-wb-tag.is-passed,.wa-wb-tag.is-confirmed,.wa-wb-tag.is-sent,.wa-wb-tag.is-done){background:light-dark(#edf5ed,#283d2e);color:light-dark(#326f4d,#b1d8bb);border-color:light-dark(#dce9da,#405b44)}
.wa-panel :is(.wa-badge.is-warn,.wa-wb-tag.is-unknown,.wa-wb-tag.is-partial,.wa-wb-tag.is-draft){background:light-dark(#fbf4e7,#382f22);color:light-dark(#8a632a,#e3c18c);border-color:light-dark(#eedfc2,#5a4b31)}
.wa-panel :is(.wa-badge.is-error,.wa-wb-tag.is-failed){background:light-dark(#fcf0ed,#3b2b29);color:light-dark(#a44842,#eeb0a8);border-color:light-dark(#edd7d0,#60443e)}
.wa-panel .wa-alert{border-radius:8px;font-size:12px;line-height:1.8;overflow-wrap:anywhere}
.wa-panel .wa-alert.is-success{background:light-dark(#f0f7ee,#26352a);color:light-dark(#346743,#b2d4b7);border-color:light-dark(#dce7d6,#405441)}
.wa-panel .wa-alert.is-error{background:light-dark(#fdf3f0,#342623);color:light-dark(#9e4c42,#e7b1a6);border-color:light-dark(#ebd5cd,#594037)}
.wa-panel :is(.wa-empty,.wa-wb-empty){min-height:180px;padding:38px 24px;border-radius:10px;background:transparent;box-shadow:none}.wa-panel .wa-wb-empty{border:1px solid var(--wa-border)}
.wa-panel .wa-wb-empty h3{font-size:15px;margin:0 0 8px}.wa-panel .wa-wb-empty p{color:var(--wa-muted);opacity:1}
.wa-panel :is(.wa-tabs,.wa-wb-tabs,.wa-memory-tabs){border:0;border-bottom:1px solid var(--wa-border);background:transparent;border-radius:0;gap:20px;padding:0;box-shadow:none;flex-wrap:wrap;max-width:none}
.wa-panel :is(.wa-wb-tabs,.wa-memory-tabs)>button{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:11px 2px;color:var(--wa-muted);font-size:12px;flex:0 0 auto;margin-bottom:-1px;box-shadow:none}
.wa-panel :is(.wa-wb-tabs,.wa-memory-tabs)>button[aria-pressed=true],.wa-panel .wa-memory-tabs>button[aria-selected=true]{border-color:var(--wa-accent);color:var(--wa-accent);background:transparent;font-weight:600;box-shadow:none}
.wa-panel .wa-memory-tabs strong{font-size:12px;font-weight:inherit}.wa-panel .wa-form-actions{border-color:var(--wa-border-soft);padding-top:18px}
.wa-panel :is(.wa-tab,.wa-task-tabs>button)[aria-selected=true]{color:var(--wa-accent)}.wa-panel .wa-tab[aria-selected=true]::after{background:var(--wa-accent)}
.wa-panel .wa-field-label,.wa-panel .wa-label{font-size:12px;font-weight:550;color:var(--wa-ink)}
.wa-panel :is(.wa-form-section,.wa-settings-form-section){padding-top:22px;margin-top:22px;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel :is(.wa-form-section,.wa-settings-form-section):first-child{padding-top:0;margin-top:0;border-top:0}
.wa-panel :is(.wa-form-section,.wa-settings-form-section)>h3{font-size:13px;margin:0 0 17px;color:var(--wa-ink)}
.wa-panel .wa-settings-form-sections{display:flex;flex-direction:column;min-width:0}
.wa-panel .wa-settings-form-sections>.wa-card-heading+.wa-settings-form-section{padding-top:0;margin-top:0;border-top:0}
.wa-panel .wa-form-section>label:not(.wa-wb-check){margin-bottom:17px}.wa-panel .wa-form-section>label:last-child{margin-bottom:0}
.wa-panel .wa-wb-card>.wa-wb-empty{border:0;min-height:150px;padding:24px 16px}
.wa-panel .wa-form-section>.wa-wb-generator{margin-top:14px}.wa-panel .wa-data-details{border-top:1px solid var(--wa-border-soft);padding-top:15px}
.wa-panel .wa-wb-generator:has(>label:last-child:nth-child(2)){grid-template-columns:repeat(2,minmax(0,1fr))}
.wa-panel .wa-wb-generator:has(>label:last-child:nth-child(3)){grid-template-columns:repeat(3,minmax(0,1fr))}
.wa-panel .wa-data-details>summary{padding:0;font-weight:500}
/* Overview and settings emphasize real information. */
.wa-panel .wa-overview-stack{gap:22px}.wa-panel .wa-overview-lead{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);align-items:stretch;gap:20px}
.wa-panel .wa-account-card{min-height:0;padding:24px;border-radius:11px}.wa-panel .wa-account-kicker{border-bottom:1px solid var(--wa-border-soft);padding-bottom:15px;margin-bottom:20px!important;font-size:12px}
.wa-panel .wa-account-avatar{border-radius:50%;background:var(--wa-subtle);border-color:var(--wa-border);color:var(--wa-accent);box-shadow:none}.wa-panel .wa-account-name{font-size:18px!important;font-weight:600}
.wa-panel .wa-overview-status{display:flex;flex-direction:column;justify-content:space-between;gap:18px}.wa-panel .wa-overview-status .wa-card-heading{align-items:center;margin:0}.wa-panel .wa-overview-status-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-overview-status-footer .wa-help{flex:1;min-width:150px}
.wa-panel .wa-overview-summary{margin-top:4px}.wa-panel .wa-overview-summary>.wa-card-heading{margin-bottom:14px}.wa-panel .wa-overview-summary h2{font-size:13px;color:var(--wa-muted)}
.wa-panel .wa-overview-config-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.wa-panel .wa-overview-summary .wa-summary-item{display:grid;grid-template-columns:17px minmax(0,1fr) 14px;align-items:start;gap:12px;padding:19px 18px;border:1px solid var(--wa-border);border-radius:10px;background:var(--wa-surface);color:var(--wa-ink);font:inherit;text-align:left;cursor:pointer;box-shadow:var(--wa-shadow);transition:background .15s,border-color .15s}
.wa-panel .wa-overview-summary .wa-summary-item:hover{background:var(--wa-subtle);border-color:color-mix(in srgb,var(--wa-accent) 35%,var(--wa-border))}
.wa-panel .wa-overview-summary .wa-summary-item>svg{margin-top:4px;box-sizing:border-box;width:17px;height:17px;padding:0;color:var(--wa-faint)}
.wa-panel .wa-overview-summary .wa-summary-item>.wa-summary-arrow{width:14px;height:14px;margin-top:5px}
.wa-panel .wa-overview-summary .wa-summary-value{font-size:14px;margin:6px 0;font-weight:550}.wa-panel .wa-overview-summary .wa-path{font-size:11px;line-height:1.8}
.wa-panel .wa-overview-summary .wa-help{font-size:11px;margin:0!important}.wa-panel .wa-account-options{margin-top:16px;font-size:12px;color:var(--wa-muted)}.wa-panel .wa-account-options summary{cursor:pointer}
.wa-panel .wa-stat-grid{background:transparent;border-radius:0;border:0;padding:0}.wa-panel .wa-stat{display:flex;flex-direction:column;align-items:flex-start;gap:8px;background:transparent;border:0;border-right:1px solid var(--wa-border-soft);border-radius:0;padding:6px 18px;box-shadow:none}
.wa-panel .wa-stat:first-child{padding-left:0}.wa-panel .wa-stat:last-child{padding-right:0;border-right:0}.wa-panel .wa-stat-number{font:34px/1.2 Georgia,serif;color:var(--wa-ink);letter-spacing:-.03em}
.wa-panel .wa-stat-label{font-size:11px}.wa-panel .wa-stat-detail{font-size:10px}.wa-panel .wa-overview-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}
.wa-panel .wa-summary-item{padding:13px 0;gap:12px;border-color:var(--wa-border-soft)}.wa-panel .wa-summary-item>svg{background:transparent;padding:0;width:17px;height:17px;color:var(--wa-faint);border-radius:0}.wa-panel .wa-summary-value{font-size:13px}
.wa-panel .wa-settings-sections{display:flex;flex-direction:column;gap:28px;max-width:940px}.wa-panel .wa-settings-section-head{margin:0 0 12px;padding:0 2px}.wa-panel .wa-settings-section-head h2{font-size:13px;color:var(--wa-muted)}
.wa-panel .wa-settings-list{border:1px solid var(--wa-border);background:var(--wa-surface);border-radius:11px;overflow:hidden}
.wa-panel .wa-settings-list .wa-setting-link{display:grid;grid-template-columns:35px minmax(0,1fr) auto 16px;align-items:center;width:100%;border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;background:transparent;padding:19px 22px;gap:15px;box-shadow:none;text-align:left;transform:none}
.wa-panel .wa-settings-list .wa-setting-link:last-child{border-bottom:0}.wa-panel .wa-settings-list .wa-setting-link:hover{background:var(--wa-subtle);transform:none;box-shadow:none}.wa-panel .wa-settings-list .wa-setting-link::before{content:none}
.wa-panel .wa-settings-list .wa-setting-link>.wa-card-icon{grid-column:1;grid-row:1}
.wa-panel .wa-settings-list .wa-setting-link>.wa-setting-copy{grid-column:2;grid-row:1}
.wa-panel .wa-settings-list .wa-setting-link>.wa-setting-value{grid-column:3;grid-row:1}
.wa-panel .wa-settings-list .wa-setting-link>svg{grid-column:4;grid-row:1;align-self:center;margin:0;color:var(--wa-faint)}
.wa-panel .wa-settings-list .wa-setting-link h3{margin:0}
.wa-panel .wa-settings-list .wa-setting-link h3{font-size:14px}.wa-panel .wa-settings-list .wa-setting-link p{font-size:12px;color:var(--wa-muted);margin-top:4px}.wa-panel .wa-setting-value{font-size:11px;color:var(--wa-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wa-panel .wa-setting-caption{display:none}.wa-panel .wa-persona-studio{display:block;max-width:900px}.wa-panel .wa-persona-manuscript>.wa-between{padding-bottom:20px;margin-bottom:22px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-storage-path-list{margin:16px 0 0}.wa-panel .wa-storage-path-list>div{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px;padding:12px 0;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-storage-path-list>div:last-child{border-bottom:0}.wa-panel .wa-storage-path-list dt{font-size:12px;color:var(--wa-muted);padding-top:9px}.wa-panel .wa-storage-path-list dd{margin:0;border-style:solid;font-size:11px}
.wa-panel .wa-persona-editor{min-height:380px;font-size:13px!important;line-height:1.9}.wa-panel .wa-note-box{border-left-color:var(--wa-accent);background:var(--wa-subtle)}
.wa-panel :is(.wa-identity-file,.wa-work-metadata,.wa-work-log){margin-top:20px;padding-top:13px;border-top:1px solid var(--wa-border-soft)}
.wa-panel :is(.wa-data-details,.wa-mode-guide)>summary{cursor:pointer;font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-data-details{margin-top:20px}.wa-panel .wa-data-details[open]>summary{margin-bottom:16px}
/* Message, memory, media, and automation surfaces. */
.wa-panel .wa-session-row{border-color:var(--wa-border-soft)}.wa-panel .wa-records-peer[aria-current=true]{background:var(--wa-subtle);border-color:var(--wa-border)}.wa-panel .wa-record-reply{background:var(--wa-subtle);border-left-color:var(--wa-accent)}
.wa-panel .wa-record-memory{margin-top:14px;padding:13px 15px;border:1px solid var(--wa-border-soft);border-radius:7px;background:var(--wa-input-surface);font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-record-memory-label{display:block;margin-bottom:7px;font-size:10px;color:var(--wa-faint)}.wa-panel .wa-record-memory p{margin-top:8px}.wa-panel .wa-record-memory .wa-row{gap:7px 15px}
.wa-panel .wa-memory-overview{background:var(--wa-surface);border:1px solid var(--wa-border);border-radius:10px;padding:22px;gap:18px}.wa-panel .wa-memory-overview-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.wa-panel .wa-memory-overview-heading h2{font-size:15px}
.wa-panel .wa-memory-metrics dd{font:23px/1.4 "Segoe UI",sans-serif;color:var(--wa-ink)}.wa-panel .wa-memory-meter>span{background:var(--wa-accent)}.wa-panel .wa-long-source-head>h3{border-left-color:var(--wa-accent)}.wa-panel .wa-mode-option:has(input:checked){background:var(--wa-subtle);border-color:var(--wa-accent)}
.wa-panel .wa-wb-page{padding:0;animation:none}.wa-panel .wa-wb-page fieldset{border:0;padding:0;margin:16px 0;min-width:0}.wa-panel .wa-wb-card h2{font-size:16px;font-weight:600;margin:0 0 12px;letter-spacing:0}.wa-panel .wa-wb-card h3{font-size:14px;font-weight:600;letter-spacing:0}.wa-panel .wa-wb-card>p{font-size:12px}
.wa-panel .wa-wb-split.is-empty{grid-template-columns:1fr}
.wa-panel .wa-wb-strip{background:transparent;border-radius:9px;padding:17px 20px;gap:26px}.wa-panel .wa-wb-strip strong{font:18px/1.4 "Segoe UI",sans-serif;color:var(--wa-ink)}
.wa-panel .wa-wb-list-item{border-radius:8px;background:var(--wa-surface)}.wa-panel .wa-wb-list-item.is-selected{border-color:var(--wa-accent);background:var(--wa-subtle)}.wa-panel .wa-wb-paper{background:var(--wa-subtle);border-left-color:var(--wa-accent);border-radius:0 7px 7px 0}
.wa-panel .wa-wb-card .wa-wb-fact-text{font-family:var(--wa-title-font);font-size:17px!important;letter-spacing:0}.wa-panel .wa-wb-number{color:var(--wa-faint);font-size:22px;opacity:1}.wa-panel .wa-wb-capability{min-height:195px}.wa-panel .wa-wb-capability::before{content:none}
.wa-panel .wa-assets-backdrop{background:#14221c70;backdrop-filter:blur(3px)}.wa-panel .wa-assets-dialog{border-radius:12px;box-shadow:var(--wa-shadow-raised)}
.wa-panel :is(.wa-work-toolbar,.wa-work-selection,.wa-work-state,.wa-work-operation,.wa-moments-toolbar){display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.wa-panel .wa-work-toolbar{margin:0 0 20px;padding:12px 0;border-bottom:1px solid var(--wa-border)}.wa-panel .wa-work-toolbar select{width:auto;min-width:110px}
.wa-panel .wa-work-selection{padding-bottom:18px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:20px}.wa-panel .wa-work-selection label{flex:1;min-width:180px}
.wa-panel .wa-work-operation{align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--wa-border-soft)}.wa-panel .wa-work-operation:last-child{border-bottom:0}
.wa-panel .wa-moments-toolbar{margin:0 0 20px}.wa-panel .wa-moments-lookup{flex:1 1 250px}.wa-panel .wa-moments-lookup .wa-row{margin-top:9px}.wa-panel .wa-moments-lookup input{flex:1}
.wa-panel .wa-moments-post-text{white-space:pre-wrap;overflow-wrap:anywhere}.wa-panel .wa-moments-photos{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.wa-panel .wa-moments-photos img{width:100px;height:100px;object-fit:cover;border:1px solid var(--wa-border);border-radius:7px}
/* New modules use the same section rhythm as established pages. */
.wa-panel .wa-section-stack{display:flex;flex-direction:column;gap:18px;min-width:0}
.wa-panel .wa-moments-post-actions{margin-top:15px}.wa-panel .wa-moments-plan{padding:20px 0;border-bottom:1px solid var(--wa-border-soft)}.wa-panel .wa-moments-plan:last-child{border-bottom:0;padding-bottom:0}
.wa-panel .wa-moments-draft-detail{min-width:0}.wa-panel .wa-moments-draft-detail>h2{margin-top:0}
.wa-panel .wa-audience-picker{margin-top:22px;padding-top:20px;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-audience-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:16px}
.wa-panel .wa-audience-grid>div{min-width:0}.wa-panel .wa-audience-list{max-height:280px;overflow:auto;margin-top:12px;scrollbar-width:thin;padding-right:5px}
.wa-panel .wa-audience-list label.wa-wb-check{margin:0;padding:10px 0;border-bottom:1px solid var(--wa-border-soft)}.wa-panel .wa-audience-list label.wa-wb-check:last-child{border-bottom:0}
.wa-panel .wa-audience-identity{display:block;color:var(--wa-muted);font-size:10px;overflow-wrap:anywhere}.wa-panel .wa-recipient-list{max-height:240px;overflow:auto;scrollbar-width:thin}
.wa-panel .wa-wb-todo-text{white-space:pre-wrap;overflow-wrap:anywhere}
.wa-panel :is(.wa-work-summary,.wa-work-section){min-width:0;margin:22px 0 0;padding:20px 0 0;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-work-summary{border-top:0;margin-top:0;padding-top:0}.wa-panel .wa-work-selection{display:grid;grid-template-columns:auto minmax(0,1fr);gap:15px;align-items:center}.wa-panel .wa-work-selection label{min-width:0;flex:none;font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-work-toolbar{justify-content:space-between}.wa-panel .wa-work-capacity-controls>label{flex:none;min-width:0;font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-work-section>h3{margin:0 0 12px;font-size:13px}.wa-panel .wa-work-content{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.9}
.wa-panel pre.wa-work-content{font:13px/1.9 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:0;background:none;border:0}
.wa-panel .wa-work-operation{display:block}.wa-panel .wa-work-operation>strong{font-size:12px;font-weight:550}.wa-panel .wa-work-operation>.wa-work-content{margin-top:8px;font:11px/1.8 Consolas,monospace;color:var(--wa-muted)}
.wa-panel .wa-work-retry{margin-top:16px}.wa-panel .wa-work-retry>.wa-help{margin-top:8px}.wa-panel .wa-work-progress{padding:12px 0;font-size:12px;overflow-wrap:anywhere}
.wa-panel .wa-work-files :is(ul,p){overflow-wrap:anywhere;font-size:12px;color:var(--wa-muted)}.wa-panel .wa-work-files ul{padding-left:18px}.wa-panel .wa-work-files li{margin:7px 0}
.wa-panel .wa-mode-fieldset{border:0;padding:0;margin:0;min-width:0}.wa-panel .wa-mode-fieldset>legend{padding:0;margin:0 0 12px;font-size:12px;font-weight:550}
.wa-panel .wa-conversation-persona-link{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.wa-panel details.wa-record-memory>summary{cursor:pointer;color:var(--wa-muted);font-size:11px;list-style:disclosure-closed}.wa-panel details.wa-record-memory[open]>summary{list-style:disclosure-open;margin-bottom:10px}
.wa-panel .wa-recovery-options{font-size:12px;color:var(--wa-muted)}.wa-panel .wa-recovery-options>summary{cursor:pointer;padding:7px 0}.wa-panel .wa-recovery-options[open]>.wa-wb-actions{margin:10px 0 0;gap:8px}
.wa-panel .wa-work-artifacts{width:100%;border-collapse:collapse;text-align:left;font-size:12px}.wa-panel .wa-work-artifacts th{font-size:11px;color:var(--wa-muted);font-weight:500;padding:9px 12px;background:var(--wa-subtle)}
.wa-panel .wa-work-artifacts td{padding:12px;border-bottom:1px solid var(--wa-border-soft);overflow-wrap:anywhere}.wa-panel .wa-work-artifacts td:first-child{word-break:break-all}.wa-panel .wa-work-receipt{display:block;font:10px/1.8 Consolas,monospace;color:var(--wa-muted);overflow-wrap:anywhere}
.wa-panel .wa-work-files{display:flex;flex-direction:column;gap:0}.wa-panel .wa-work-files>a{padding:12px 0;border-bottom:1px solid var(--wa-border-soft);color:var(--wa-accent);overflow-wrap:anywhere}.wa-panel .wa-work-files>a:last-child{border-bottom:0}
.wa-panel .wa-work-delivery{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:15px;padding:12px 15px;border:1px solid var(--wa-border-soft);border-radius:8px;background:var(--wa-subtle)}
.wa-panel .wa-work-capacity-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.wa-panel .wa-work-capacity-controls>label{flex:1;min-width:130px}
.wa-panel .wa-wb-capability footer{margin-top:14px;border-top:0;padding-top:0;opacity:1;color:var(--wa-muted)}
.wa-panel .wa-memory-fact-list{display:flex;flex-direction:column;gap:14px}.wa-panel .wa-memory-fact-list .wa-wb-fact-text{font-size:15px!important;line-height:1.9!important;margin:15px 0}
.wa-panel .wa-diagnostics-list{border:1px solid var(--wa-border);border-radius:12px;overflow:hidden;background:var(--wa-surface);margin-bottom:20px}
.wa-panel .wa-diagnostics-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:center;min-height:0;border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;box-shadow:none;padding:21px 24px}
.wa-panel .wa-diagnostics-row:last-child{border-bottom:0}.wa-panel .wa-diagnostics-content{min-width:0}.wa-panel .wa-diagnostics-content .wa-wb-between{justify-content:flex-start;gap:12px}.wa-panel .wa-diagnostics-content h2{margin:0;font-size:14px}
.wa-panel .wa-diagnostics-content>p{font-size:12px;color:var(--wa-muted);overflow-wrap:anywhere;margin:7px 0 0}.wa-panel .wa-diagnostics-row footer{flex-direction:column;align-items:flex-end;gap:8px;margin:0;font-size:11px}
.wa-panel .wa-wb-capability>p{font-size:12px;color:var(--wa-muted);opacity:1;max-width:none}.wa-panel .wa-wb-capability .wa-wb-number{font:inherit;font-size:12px}
.wa-panel .wa-wb-list-item small,.wa-panel .wa-wb-list-item p,.wa-panel .wa-wb-strip>div>span{color:var(--wa-muted);opacity:1}
.wa-panel .wa-task-toolbar{gap:16px}.wa-panel .wa-task-tabs>button{background:transparent;border:0;border-radius:0}.wa-panel .wa-task-tabs>button[aria-selected=true]{background:transparent;border-bottom:2px solid var(--wa-accent);box-shadow:none}
.wa-panel .wa-form-actions>.wa-row>.wa-button:not(.wa-primary):not(.wa-danger){border-color:transparent;background:transparent;color:var(--wa-muted)}
/* Compact windows retain labeled, reachable navigation. */
@media(min-width:1500px){.wa-panel .wa-workspace{padding:30px 48px 52px}}
@media(max-width:1100px){.wa-panel .wa-shell{grid-template-columns:180px minmax(0,1fr)}.wa-panel .wa-workspace{padding:23px 26px 36px}.wa-panel .wa-overview-lead{grid-template-columns:1fr}.wa-panel .wa-overview-config-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wa-panel .wa-overview-config-grid>.wa-summary-item:last-child{grid-column:1/-1}}
@media(max-width:800px){
 .wa-panel .wa-shell{display:flex;flex-direction:column}.wa-panel .wa-nav{display:flex;flex-direction:row;align-items:center;gap:16px;padding:12px 16px;border-right:0;border-bottom:1px solid var(--wa-border);min-width:0}
 .wa-panel .wa-brand{display:flex;padding:0;flex-shrink:0}.wa-panel .wa-brand>div:last-child,.wa-panel .wa-nav-label,.wa-panel .wa-nav-footer{display:none}
 .wa-panel .wa-nav .wa-nav-list{display:flex!important;flex:1;flex-direction:row;flex-wrap:nowrap;gap:12px;justify-content:flex-start;overflow-x:auto;overflow-y:hidden;min-width:0;scrollbar-width:thin}
 .wa-panel .wa-nav-group{display:flex;gap:4px;flex-shrink:0}.wa-panel .wa-nav-group+.wa-nav-group{padding-left:12px;border-left:1px solid var(--wa-border)}
 .wa-panel .wa-nav-button{width:auto;padding:8px 11px;gap:7px;flex-shrink:0}.wa-panel .wa-nav-button>span{display:block}.wa-panel .wa-nav-button svg{display:block;width:15px;height:15px}
 .wa-panel .wa-nav-button[aria-current=page]::before{display:none}
 .wa-panel .wa-workspace{padding:22px 24px 36px}.wa-panel .wa-workspace-chrome{margin-bottom:24px}.wa-panel :is(h1,.wa-wb-heading h1){font-size:26px}
 .wa-panel .wa-overview-grid,.wa-panel .wa-wb-split{grid-template-columns:1fr}.wa-panel .wa-memory-workspace-tabs{display:flex;flex-wrap:wrap;gap:16px}.wa-panel .wa-memory-workspace-tabs>button{flex:0 0 auto}
 .wa-panel .wa-settings-list .wa-setting-link{padding:17px 20px}
}
@media(max-width:560px){
 .wa-panel .wa-nav{padding:10px 12px;gap:12px}.wa-panel .wa-brand-mark{width:30px;height:30px}.wa-panel .wa-workspace{padding:20px 16px 30px}.wa-panel :is(h1,.wa-wb-heading h1){font-size:24px}
 .wa-panel :is(.wa-page-head,.wa-wb-heading){flex-wrap:wrap;gap:15px;margin-bottom:22px}.wa-panel .wa-page-head>.wa-row{width:auto}
 .wa-panel :is(.wa-card,.wa-wb-card,.wa-account-card){padding:19px;border-radius:9px}.wa-panel .wa-stat{padding:9px 12px}.wa-panel .wa-stat-number{font-size:25px}
 .wa-panel .wa-memory-metrics{gap:15px}.wa-panel .wa-memory-overview{padding:18px}.wa-panel .wa-memory-overview-heading{flex-wrap:wrap;gap:10px}
 .wa-panel .wa-settings-list .wa-setting-link{grid-template-columns:30px minmax(0,1fr) 16px;padding:17px 15px;gap:12px}.wa-panel .wa-setting-value{display:none}.wa-panel .wa-setting-link .wa-card-icon{width:30px;height:32px}
 .wa-panel .wa-settings-list .wa-setting-link>svg{grid-column:3}
 .wa-panel .wa-persona-editor{min-height:300px}.wa-panel .wa-wb-generator{grid-template-columns:1fr}.wa-panel .wa-work-toolbar{gap:10px}.wa-panel .wa-work-selection label{min-width:100%}
 .wa-panel :is(.wa-wb-between,.wa-between){flex-wrap:wrap}.wa-panel .wa-form-actions>.wa-row{justify-content:flex-start}
 .wa-panel .wa-overview-config-grid{grid-template-columns:1fr;gap:10px}.wa-panel .wa-overview-summary .wa-summary-item{padding:16px}.wa-panel .wa-overview-status-footer{gap:8px}
 .wa-panel .wa-audience-grid{grid-template-columns:1fr}
 .wa-panel .wa-storage-path-list>div{grid-template-columns:1fr;gap:5px}.wa-panel .wa-storage-path-list dt{padding:0}.wa-panel .wa-work-selection{grid-template-columns:1fr;gap:8px}.wa-panel .wa-work-selection label{min-width:0}
 .wa-panel .wa-diagnostics-row{grid-template-columns:1fr;gap:12px;padding:19px}.wa-panel .wa-diagnostics-row footer{flex-direction:row;align-items:center;justify-content:space-between}
 .wa-panel .wa-work-artifacts{table-layout:fixed}.wa-panel .wa-work-artifacts th,.wa-panel .wa-work-artifacts td{padding:10px 7px}.wa-panel .wa-work-artifacts th:first-child{width:39%}
 .wa-panel .wa-wb-generator:has(>label:last-child:nth-child(2)),.wa-panel .wa-wb-generator:has(>label:last-child:nth-child(3)){grid-template-columns:1fr}
}
@media(min-width:561px) and (max-width:650px){.wa-panel .wa-audience-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.wa-panel *,.wa-panel *::before,.wa-panel *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
