export const layoutCss = `
.wa-panel .wa-shell{height:100%;min-height:0;display:grid;grid-template-columns:184px minmax(0,1fr)}
.wa-panel .wa-nav{min-width:0;min-height:0;display:flex;flex-direction:column;padding:21px 12px 16px;border-right:1px solid var(--wa-border-soft);background:var(--wa-nav-surface);overflow-y:auto}
.wa-panel .wa-brand{display:flex;align-items:center;gap:9px;padding:0 7px;margin-bottom:28px}
.wa-panel .wa-brand-mark{display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--wa-border);border-radius:7px;background:var(--wa-surface);color:var(--wa-ink)}
.wa-panel .wa-brand-mark svg{width:17px;height:17px}.wa-panel .wa-brand strong{display:block;font-size:13px;font-weight:650;letter-spacing:-.1px}
.wa-panel .wa-brand small{display:block;font-size:10px;color:var(--wa-muted);margin-top:1px}
.wa-panel .wa-nav-list{display:flex;flex-direction:column;gap:22px}.wa-panel .wa-nav-group{display:flex;flex-direction:column;gap:3px}
.wa-panel .wa-nav-mobile{display:none}
.wa-panel .wa-nav-label{font-size:10px;font-weight:500;color:var(--wa-muted);padding:0 9px 6px}
.wa-panel .wa-nav-button{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:7px 9px;border:0;border-radius:5px;background:transparent;color:var(--wa-muted);text-align:left;font-size:12px;line-height:1.65;transition:background .13s,color .13s}
.wa-panel .wa-nav-button svg{width:16px;height:16px;stroke-width:1.65}.wa-panel .wa-nav-button:hover{background:var(--wa-hover);color:var(--wa-ink)}
.wa-panel .wa-nav-button[aria-current=page]{background:var(--wa-hover);color:var(--wa-ink);font-weight:600}
.wa-panel .wa-nav-footer{display:flex;flex-direction:column;gap:5px;margin-top:auto;padding:20px 9px 0;color:var(--wa-muted)}
.wa-panel .wa-nav-footer .wa-status-line{font-size:11px}.wa-panel .wa-nav-footer>span{padding-left:12px;font:10px var(--wa-font-mono);color:var(--wa-faint)}
.wa-panel .wa-workspace{min-width:0;min-height:0;width:100%;height:100%;overflow:auto;padding:0 34px 36px;scrollbar-gutter:stable;scroll-behavior:auto}
.wa-panel .wa-workspace-chrome{min-height:54px;display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:22px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-breadcrumb{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;color:var(--wa-muted);font-size:11px}
.wa-panel .wa-breadcrumb>span:last-child{color:var(--wa-ink)}.wa-panel .wa-breadcrumb-divider{color:var(--wa-faint);opacity:.6}
.wa-panel .wa-local-preview{font-size:10px;color:var(--wa-muted)}.wa-panel .wa-chrome-status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-overview-stack{gap:28px;max-width:1120px}
.wa-panel .wa-account-card{padding:20px 22px;border:1px solid var(--wa-border-soft);border-radius:8px;background:var(--wa-subtle)}
.wa-panel .wa-account-main{display:flex;align-items:center;justify-content:space-between;gap:20px;min-width:0}
.wa-panel .wa-account-top{display:flex;align-items:center;gap:13px;min-width:0}.wa-panel .wa-account-top>div:last-child{min-width:0}
.wa-panel .wa-account-avatar{display:grid;place-items:center;width:42px;height:42px;flex-shrink:0;border:1px solid var(--wa-border);border-radius:10px;background:var(--wa-surface);color:var(--wa-muted)}
.wa-panel .wa-account-name{font-size:16px;font-weight:600;overflow-wrap:anywhere}.wa-panel .wa-account-top .wa-mono{font-size:10px;margin-top:3px}
.wa-panel .wa-account-actions{justify-content:flex-end;flex-shrink:0}.wa-panel .wa-login-state{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-account-detail{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin:15px 0 0 55px}
.wa-panel .wa-account-options{font-size:11px;min-width:0;text-align:right}.wa-panel .wa-account-options>summary{font-size:11px}.wa-panel .wa-account-options>p{max-width:340px}.wa-panel .wa-account-options>.wa-button{margin-top:9px}
.wa-panel .wa-qr{display:block;width:192px;height:192px;object-fit:contain;background:white;padding:10px;border-radius:7px;border:1px solid var(--wa-border);margin:22px auto 0}
.wa-panel .wa-qr-caption{text-align:center;margin-top:10px}
.wa-panel .wa-overview-body{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(260px,.85fr);gap:36px}
.wa-panel .wa-overview-status{min-width:0}.wa-panel .wa-overview-status .wa-card-heading{align-items:center;margin-bottom:22px}
.wa-panel .wa-overview-status h2,.wa-panel .wa-overview-summary h2{font-size:13px}
.wa-panel .wa-stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;padding:8px 0 22px}
.wa-panel .wa-stat{min-width:0;padding:0 20px;border-left:1px solid var(--wa-border-soft)}.wa-panel .wa-stat:first-child{padding-left:0;border-left:0}.wa-panel .wa-stat:last-child{padding-right:0}
.wa-panel .wa-stat-label{font-size:11px;color:var(--wa-muted);margin-bottom:13px}.wa-panel .wa-stat-number{font:500 30px/1.2 var(--wa-title-font);font-variant-numeric:tabular-nums;letter-spacing:-1px}
.wa-panel .wa-stat-detail{font-size:10px;color:var(--wa-muted);margin-top:8px}.wa-panel .wa-stat[data-active=true] .wa-stat-number{color:var(--wa-info)}
.wa-panel .wa-overview-status-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;border-top:1px solid var(--wa-border-soft);padding-top:13px}.wa-panel .wa-overview-status-footer>.wa-help{margin:0;max-width:300px}
.wa-panel .wa-overview-summary{padding-left:30px;border-left:1px solid var(--wa-border-soft);min-width:0}.wa-panel .wa-overview-summary .wa-card-heading{margin-bottom:8px}
.wa-panel .wa-overview-config-grid{display:flex;flex-direction:column}
.wa-panel .wa-summary-item{display:grid;grid-template-columns:17px minmax(0,1fr) 13px;align-items:center;gap:10px;min-width:0;width:100%;padding:14px 0;border:0;border-bottom:1px solid var(--wa-border-soft);background:transparent;color:var(--wa-ink);text-align:left}
.wa-panel .wa-summary-item:last-child{border-bottom:0}.wa-panel .wa-summary-item>svg{color:var(--wa-faint);width:16px;height:16px}.wa-panel .wa-summary-item>div{min-width:0}
.wa-panel .wa-summary-item .wa-help{font-size:10px;margin:0}.wa-panel .wa-summary-value{margin-top:3px;font-size:12px;font-weight:550;overflow-wrap:anywhere}.wa-panel .wa-summary-value.wa-path{font-size:10px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal;font-weight:400}
.wa-panel .wa-summary-item:hover .wa-summary-value{color:var(--wa-accent)}.wa-panel .wa-summary-item>.wa-summary-arrow{width:12px;height:12px}
.wa-panel .wa-overview-destinations{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;padding-top:24px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-destination{display:flex;align-items:center;gap:11px;min-width:0;padding:10px 18px;background:transparent;border:0;border-right:1px solid var(--wa-border-soft);text-align:left;color:var(--wa-ink)}
.wa-panel .wa-destination:first-child{padding-left:0}.wa-panel .wa-destination:last-child{border-right:0;padding-right:0}.wa-panel .wa-destination>span:nth-child(2){min-width:0;flex:1}.wa-panel .wa-destination strong{display:block;font-size:12px;font-weight:550}.wa-panel .wa-destination small{display:block;color:var(--wa-muted);font-size:10px;margin-top:4px;line-height:1.7}.wa-panel .wa-destination>svg{color:var(--wa-faint);width:13px;height:13px}.wa-panel .wa-destination:hover strong{color:var(--wa-accent)}
@media(min-width:1500px){.wa-panel .wa-workspace{padding-right:48px;padding-left:48px}}
@media(max-width:1050px){.wa-panel .wa-overview-body{grid-template-columns:1fr;gap:26px}.wa-panel .wa-overview-summary{padding:22px 0 0;border:0;border-top:1px solid var(--wa-border-soft)}.wa-panel .wa-overview-config-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.wa-panel .wa-summary-item{border:0;align-items:start}.wa-panel .wa-summary-item>svg{margin-top:3px}.wa-panel .wa-summary-item>.wa-summary-arrow{display:none}}
@media(max-width:800px){
 .wa-panel .wa-shell{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}
 .wa-panel .wa-nav{position:relative;z-index:30;flex-direction:row;align-items:center;justify-content:space-between;gap:14px;padding:10px 16px;border-right:0;border-bottom:1px solid var(--wa-border-soft);overflow:visible}
 .wa-panel .wa-brand{margin:0;padding:0;flex-shrink:0}.wa-panel .wa-brand small,.wa-panel .wa-nav-footer{display:none}
 .wa-panel .wa-nav-mobile{display:inline-flex;align-items:center;gap:14px;border:1px solid var(--wa-border);border-radius:6px;background:var(--wa-surface);padding:5px 9px;font-size:12px;min-height:32px}
 .wa-panel .wa-nav-mobile>svg{width:15px;height:15px;color:var(--wa-muted)}
 .wa-panel .wa-nav-list{display:none;position:absolute;top:calc(100% + 4px);right:12px;width:min(310px,calc(100vw - 24px));max-height:calc(100vh - 85px);overflow:auto;padding:13px;background:var(--wa-surface);border:1px solid var(--wa-border);border-radius:9px;box-shadow:var(--wa-shadow-raised);gap:15px}
 .wa-panel .wa-nav[data-expanded=true] .wa-nav-list{display:flex}.wa-panel .wa-nav-label{padding-top:2px;padding-bottom:3px}
 .wa-panel .wa-nav-button{min-height:38px;padding:8px 10px}.wa-panel .wa-nav-button svg{width:16px;height:16px}
 .wa-panel .wa-workspace{padding:0 24px 30px}.wa-panel .wa-workspace-chrome{min-height:47px;margin-bottom:22px}
}
@media(max-width:560px){.wa-panel .wa-workspace{padding:0 16px 28px}.wa-panel .wa-nav{gap:10px;padding:9px 12px}.wa-panel .wa-brand-mark{width:25px;height:25px}.wa-panel .wa-nav-button{font-size:11px}.wa-panel .wa-workspace-chrome{min-height:43px;margin-bottom:19px}.wa-panel .wa-account-card{padding:16px}.wa-panel .wa-account-main{flex-wrap:wrap;gap:14px}.wa-panel .wa-account-actions{justify-content:flex-start}.wa-panel .wa-account-detail{margin-left:0;flex-direction:column;gap:8px}.wa-panel .wa-account-options{text-align:left}.wa-panel .wa-account-name{font-size:15px}.wa-panel .wa-overview-stack{gap:24px}.wa-panel .wa-stat{padding:0 12px}.wa-panel .wa-stat-number{font-size:27px}.wa-panel .wa-stat-label,.wa-panel .wa-stat-detail{font-size:10px}.wa-panel .wa-overview-status-footer{flex-wrap:wrap;gap:9px}.wa-panel .wa-overview-config-grid{display:flex;gap:0}.wa-panel .wa-summary-item{border-bottom:1px solid var(--wa-border-soft)}.wa-panel .wa-summary-item>.wa-summary-arrow{display:block}.wa-panel .wa-overview-destinations{grid-template-columns:1fr;gap:0;padding-top:8px}.wa-panel .wa-destination{padding:14px 0;border-right:0;border-bottom:1px solid var(--wa-border-soft)}.wa-panel .wa-destination:last-child{border-bottom:0}}
`;
