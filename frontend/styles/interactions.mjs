export const interactionCss = `
.wa-panel .wa-interactions{container:wa-interactions / inline-size;min-width:0}
.wa-panel .wa-interaction-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:8px 0 26px;border-bottom:1px solid var(--wa-border);margin-bottom:24px}
.wa-panel .wa-interaction-heading h2{font:600 22px/1.5 var(--wa-title-font);margin:0 0 6px;letter-spacing:-.3px}
.wa-panel .wa-interaction-heading p{font-size:12px;color:var(--wa-muted);margin:0;line-height:1.8}
.wa-panel .wa-interaction-limit{font-size:11px;color:var(--wa-muted);white-space:nowrap}
.wa-panel .wa-interaction-auto{padding:24px 26px;background:var(--wa-subtle);border:1px solid var(--wa-border);border-radius:var(--wa-radius-sm);margin-bottom:34px;min-width:0}
.wa-panel .wa-interaction-auto-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
.wa-panel .wa-interaction-eyebrow{font-size:11px;color:var(--wa-accent);letter-spacing:1px}
.wa-panel .wa-interaction-auto-heading h3{font:600 17px/1.6 var(--wa-title-font);margin:6px 0}
.wa-panel .wa-interaction-auto-heading p,.wa-panel .wa-interaction-manual-heading p{font-size:12px;color:var(--wa-muted);line-height:1.8;margin:0}
.wa-panel .wa-interaction-auto-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(190px,240px);gap:32px;align-items:start}
.wa-panel .wa-interaction-auto-grid>div,.wa-panel .wa-interaction-auto-grid>aside{min-width:0}
.wa-panel .wa-interaction-auto fieldset{padding:0;margin:0;border:0;min-width:0}
.wa-panel .wa-interaction-auto legend{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.wa-panel .wa-interaction-auto label small{font-weight:400;color:var(--wa-muted);font-size:11px;line-height:1.7}
.wa-panel .wa-interaction-auto-toggle{margin:0 0 20px!important;align-items:center}
.wa-panel .wa-interaction-auto-toggle small{display:block;margin-top:4px}
.wa-panel .wa-interaction-auto-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.wa-panel .wa-interaction-auto-fields input{font-size:17px;font-weight:500;font-variant-numeric:tabular-nums;background:var(--wa-surface)}
.wa-panel .wa-interaction-auto-skips{display:flex;gap:12px 24px;flex-wrap:wrap;margin-top:18px}
.wa-panel .wa-interaction-auto-skips label{margin:0}
.wa-panel .wa-interaction-auto-details{border-top:1px solid var(--wa-border);margin:18px 0;padding-top:14px}
.wa-panel .wa-interaction-auto-details summary{font-size:12px;color:var(--wa-ink);cursor:pointer}
.wa-panel .wa-interaction-auto-status{border-left:1px solid var(--wa-border);padding-left:24px}
.wa-panel .wa-interaction-auto-status>div{margin-bottom:24px}
.wa-panel .wa-interaction-auto-status>div>span{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-interaction-auto-status p{font-size:13px;line-height:1.8;margin:8px 0;overflow-wrap:anywhere}
.wa-panel .wa-interaction-auto-status small{font-size:11px;color:var(--wa-muted);line-height:1.85;display:block;overflow-wrap:anywhere}
.wa-panel .wa-interaction-auto-status>.wa-btn{margin:0 0 10px}
.wa-panel .wa-interaction-manual-heading{margin:0 0 24px}
.wa-panel .wa-interaction-manual-heading h3{font-size:16px;margin:0 0 6px}
@container wa-interactions (max-width:1000px){.wa-panel .wa-interaction-auto-grid{grid-template-columns:minmax(0,1fr);gap:24px}.wa-panel .wa-interaction-auto-status{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;border-left:0;border-top:1px solid var(--wa-border);padding:20px 0 0}.wa-panel .wa-interaction-auto-status>div{margin:0}}
@container wa-interactions (max-width:680px){.wa-panel .wa-interaction-auto{padding:20px 16px}.wa-panel .wa-interaction-auto-heading{align-items:flex-start}.wa-panel .wa-interaction-auto-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.wa-panel .wa-interaction-auto-status{grid-template-columns:minmax(0,1fr);gap:18px}.wa-panel .wa-interaction-auto-status>div{padding-bottom:12px;border-bottom:1px solid var(--wa-border-soft)}}
.wa-panel .wa-interaction-workspace{display:grid;grid-template-columns:minmax(230px,280px) minmax(0,1fr);gap:32px;align-items:start}
.wa-panel .wa-interaction-setup{padding-right:24px;border-right:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-interaction-step{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.wa-panel .wa-interaction-step>span:first-child{font:11px/1.5 var(--wa-font-mono);color:var(--wa-accent);border-bottom:1px solid var(--wa-accent);padding-bottom:2px}
.wa-panel .wa-interaction-step h3{font-size:13px;font-weight:600;margin:0;flex:1}
.wa-panel .wa-interaction-setup fieldset{padding:0;margin:0;min-width:0;border:0}
.wa-panel .wa-interaction-setup legend{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.wa-panel .wa-interaction-setup fieldset>label{margin:16px 0}
.wa-panel .wa-interaction-choice{display:flex;padding:3px;background:var(--wa-subtle);border-radius:var(--wa-radius-sm);gap:2px;margin-bottom:18px}
.wa-panel .wa-interaction-choice button{flex:1;min-width:0;background:transparent;border:1px solid transparent;border-radius:4px;color:var(--wa-muted);font:500 12px/1.5 var(--wa-font-body);padding:8px 3px;cursor:pointer}
.wa-panel .wa-interaction-choice button[aria-pressed=true]{background:var(--wa-surface);color:var(--wa-accent);border-color:var(--wa-border);box-shadow:var(--wa-shadow)}
.wa-panel .wa-interaction-choice button:disabled{cursor:default;opacity:.6}
.wa-panel .wa-interaction-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:18px 0}
.wa-panel .wa-interaction-comment-options{border-top:1px solid var(--wa-border-soft);padding-top:18px;margin-top:20px}
.wa-panel .wa-interaction-comment-options>label{margin-bottom:16px}
.wa-panel .wa-interaction-preview{min-width:0}
.wa-panel .wa-interaction-round-meta{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;font-size:12px}
.wa-panel .wa-interaction-round-meta>span{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-interaction-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.95fr);gap:22px;padding:22px 0;border-bottom:1px solid var(--wa-border-soft);opacity:.65}
.wa-panel .wa-interaction-row.is-selected{opacity:1}
.wa-panel .wa-interaction-original,.wa-panel .wa-interaction-response{min-width:0}
.wa-panel .wa-interaction-original header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.wa-panel .wa-interaction-original .wa-wb-check{margin:0}
.wa-panel .wa-interaction-original strong{font-size:13px;font-weight:600}
.wa-panel .wa-interaction-original time{display:block;font-size:11px;color:var(--wa-muted);margin-top:3px}
.wa-panel .wa-interaction-post-text,.wa-panel .wa-interaction-comment-text{font-size:13px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;margin:14px 0}
.wa-panel .wa-interaction-original small{font-size:11px;color:var(--wa-muted);line-height:1.7;overflow-wrap:anywhere}
.wa-panel .wa-interaction-identity{font-size:11px;color:var(--wa-muted);margin-top:10px}
.wa-panel .wa-interaction-identity summary{cursor:pointer;margin-bottom:6px}
.wa-panel .wa-interaction-identity .wa-btn{display:block;margin-top:6px}
.wa-panel .wa-interaction-response textarea{min-height:96px;background:var(--wa-subtle);font-size:13px}
.wa-panel .wa-interaction-response>label{color:var(--wa-muted)}
.wa-panel .wa-interaction-comment-text{border-left:2px solid var(--wa-accent);padding-left:14px;margin-top:0}
.wa-panel .wa-interaction-receipts{display:flex;flex-wrap:wrap;gap:8px}
.wa-panel .wa-interaction-receipt{font-size:11px;padding:5px 8px;border-radius:4px;background:var(--wa-subtle);color:var(--wa-muted);overflow-wrap:anywhere}
.wa-panel .wa-interaction-receipt:is(.is-succeeded,.is-existing){background:var(--wa-success-soft);color:var(--wa-success)}
.wa-panel .wa-interaction-receipt:is(.is-unknown,.is-rejected){background:var(--wa-warning-soft);color:var(--wa-warning)}
.wa-panel .wa-interaction-execute{border-top:1px solid var(--wa-border);margin-top:24px;padding:22px 0 0}
.wa-panel .wa-interaction-execute .wa-interaction-step{margin-bottom:10px}
.wa-panel .wa-interaction-counts{font-size:12px;line-height:2;color:var(--wa-muted)}
.wa-panel .wa-interaction-counts strong{font-variant-numeric:tabular-nums;color:var(--wa-ink)}
.wa-panel .wa-interaction-history{margin-top:36px;padding-top:22px;border-top:1px solid var(--wa-border)}
.wa-panel .wa-interaction-history-row{display:grid;grid-template-columns:155px minmax(140px,1fr) 80px 95px 160px;width:100%;align-items:center;gap:14px;padding:14px 12px;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--wa-border-soft);color:var(--wa-ink);font:12px/1.7 var(--wa-font-body);cursor:pointer}
.wa-panel .wa-interaction-history-row:is(:hover,.is-selected){background:var(--wa-subtle)}
.wa-panel .wa-interaction-history-row time,.wa-panel .wa-interaction-history-row>span,.wa-panel .wa-interaction-history-row small{font-size:11px;color:var(--wa-muted)}
@container wa-interactions (max-width:1000px){.wa-panel .wa-interaction-workspace{gap:22px;grid-template-columns:240px minmax(0,1fr)}.wa-panel .wa-interaction-setup{padding-right:18px}.wa-panel .wa-interaction-row{grid-template-columns:minmax(0,1fr);gap:16px}.wa-panel .wa-interaction-history-row{grid-template-columns:135px minmax(100px,1fr) 85px}.wa-panel .wa-interaction-history-row>span:not(.wa-wb-tag),.wa-panel .wa-interaction-history-row>small{display:none}}
@container wa-interactions (max-width:680px){.wa-panel .wa-interaction-workspace{grid-template-columns:minmax(0,1fr);gap:30px}.wa-panel .wa-interaction-setup{padding:0 0 24px;border-right:0;border-bottom:1px solid var(--wa-border)}.wa-panel .wa-interaction-heading{align-items:flex-start;gap:12px}.wa-panel .wa-interaction-heading h2{font-size:20px}.wa-panel .wa-interaction-limit{max-width:64px;white-space:normal;text-align:right;line-height:1.7}.wa-panel .wa-interaction-history-row{grid-template-columns:minmax(0,1fr) auto;gap:6px 14px}.wa-panel .wa-interaction-history-row time{grid-column:1/-1}.wa-panel .wa-interaction-history-row>small{display:none}}
`;
