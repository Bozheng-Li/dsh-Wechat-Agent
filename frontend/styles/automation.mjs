// Automation pages use distinct structures: task rows, a document, and an editor.
// These are the module styles, rather than another layer over the legacy themes.
export const automationCss = `
.wa-panel .wa-wb-page{min-width:0;padding-bottom:24px}
.wa-panel .wa-wb-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.wa-panel .wa-wb-between{display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:0}
.wa-panel .wa-wb-note{font-size:12px;line-height:1.8;color:var(--wa-muted);overflow-wrap:anywhere}
.wa-panel .wa-wb-loading{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--wa-muted);padding:12px 0}
.wa-panel .wa-wb-operation{padding:12px 0;margin-bottom:16px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-wb-operation>.wa-wb-note{display:flex;align-items:center;gap:9px}
.wa-panel .wa-state-mark{display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 auto}
.wa-panel .wa-activity-indicator{display:inline-block;flex:0 0 auto;width:12px;height:12px;border:1.5px solid var(--wa-border);border-top-color:var(--wa-muted);border-radius:50%;animation:wa-activity-spin .8s linear infinite}
@keyframes wa-activity-spin{to{transform:rotate(360deg)}}
.wa-panel[data-motion=off] .wa-activity-indicator{animation:none;border-color:var(--wa-muted)}
@media(prefers-reduced-motion:reduce){.wa-panel .wa-activity-indicator{animation:none}}
.wa-panel .wa-wb-page label:not(.wa-wb-check){display:flex;flex-direction:column;gap:8px;font-size:12px;font-weight:500;line-height:1.6;min-width:0}
.wa-panel .wa-wb-page label:not(.wa-wb-check)>small{font-weight:400;color:var(--wa-muted);line-height:1.75}
.wa-panel .wa-wb-check{display:flex;align-items:flex-start;gap:10px;min-width:0;margin:12px 0;font-size:13px;line-height:1.7;cursor:pointer}
.wa-panel .wa-wb-check>input[type=checkbox]{flex:0 0 auto;width:15px;height:15px;margin:4px 0 0;accent-color:var(--wa-accent)}
.wa-panel .wa-wb-check>span{min-width:0;overflow-wrap:anywhere}
.wa-panel .wa-wb-generator{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:end;margin:18px 0 24px}
.wa-panel .wa-wb-generator>label{margin:0}
.wa-panel .wa-wb-generator:has(>label:nth-child(3):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}
.wa-panel .wa-wb-split{display:grid;grid-template-columns:minmax(215px,.72fr) minmax(0,1.8fr);gap:0;align-items:start;min-width:0}
.wa-panel .wa-wb-split.is-empty{display:block}
.wa-panel .wa-wb-split>.wa-wb-list{margin-right:24px;padding-right:18px;border-right:1px solid var(--wa-border-soft)}
.wa-panel .wa-wb-list{display:flex;flex-direction:column;gap:0;max-height:720px;min-width:0;overflow:auto;scrollbar-width:thin}
.wa-panel .wa-wb-list-item{position:relative;display:flex;flex-direction:column;gap:7px;width:100%;min-width:0;text-align:left;padding:16px 14px;background:transparent;color:var(--wa-ink);border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;font:inherit;font-size:12px;cursor:pointer;transition:background .15s}
.wa-panel .wa-wb-list-item:hover:not(:disabled){background:var(--wa-hover)}
.wa-panel .wa-wb-list-item.is-selected{background:var(--wa-subtle);box-shadow:inset 2px 0 var(--wa-accent)}
.wa-panel .wa-wb-list-item :is(p,h3,strong){min-width:0;overflow-wrap:anywhere}
.wa-panel .wa-wb-list-item h3,.wa-panel .wa-wb-list-item>strong{font-size:13px;line-height:1.7;font-weight:600;margin:0}
.wa-panel .wa-wb-list-item p{font-size:12px;color:var(--wa-muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;line-height:1.75}
.wa-panel .wa-wb-list-item :is(small,span){font-size:11px;line-height:1.6;color:var(--wa-muted)}
.wa-panel .wa-wb-list-item small{display:block}
.wa-panel .wa-wb-review{padding:18px 20px;margin:18px 0 4px;background:var(--wa-subtle);border:0;border-left:2px solid var(--wa-warning);border-radius:0;min-width:0}
.wa-panel .wa-wb-review>p{font-size:13px;line-height:1.8;margin:8px 0;overflow-wrap:anywhere}
.wa-panel .wa-wb-review>.wa-wb-actions{margin-top:14px}
.wa-panel .wa-wb-review>label{margin:16px 0}
.wa-panel .wa-wb-review>strong{font-size:13px;line-height:1.8}
.wa-panel .wa-wb-summary-item{padding:18px 0;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-wb-summary-item:last-child{border-bottom:0}
.wa-panel .wa-wb-summary-item p{font-size:13px;line-height:1.85;margin:7px 0;overflow-wrap:anywhere}
.wa-panel .wa-wb-summary-item small{font-size:11px;line-height:1.7;color:var(--wa-muted);overflow-wrap:anywhere}
.wa-panel .wa-wb-summary-item>strong{font-size:13px;font-weight:600}
.wa-panel .wa-index-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 0 14px;color:var(--wa-muted)}
.wa-panel .wa-index-heading h2{font-size:12px;font-weight:600;line-height:1.6;margin:0}
.wa-panel .wa-index-heading>span{font:11px/1.6 var(--wa-font-mono);color:var(--wa-muted)}
.wa-panel .wa-section-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:0 0 18px;min-width:0}
.wa-panel .wa-section-heading h2{display:flex;align-items:center;gap:10px;font-size:15px;line-height:1.6;margin:0}
.wa-panel .wa-section-count{font:11px/1.6 var(--wa-font-mono);color:var(--wa-muted);font-weight:400}
.wa-panel .wa-section-heading .wa-wb-note{margin-top:5px}
.wa-panel .wa-automation-editor{padding:24px;background:var(--wa-surface);border:1px solid var(--wa-border);border-radius:8px;min-width:0}
.wa-panel .wa-editor-heading{display:flex;flex-direction:column;gap:6px;margin-bottom:26px;padding-bottom:18px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-editor-heading h2{font-size:16px;font-weight:600;margin:0}
.wa-panel .wa-editor-heading p{font-size:12px;color:var(--wa-muted);line-height:1.8}
.wa-panel .wa-editor-actions{padding-top:20px;border-top:1px solid var(--wa-border-soft);margin-top:24px}
.wa-panel .wa-automation-editor>.wa-form-section:first-child{border-top:0;margin-top:0;padding-top:0}
.wa-panel :is(.wa-moments-plan-editor,.wa-task-create) fieldset{border:0;padding:0;margin:0;min-width:0}
.wa-panel .wa-automation-field{display:flex;flex-direction:column;gap:8px;min-width:0;margin:0 0 20px}
.wa-panel .wa-automation-field>.wa-help{margin:0;font-weight:400}
.wa-panel .wa-dirty{font-size:12px;color:var(--wa-warning)}

/* Work: one task, two independent statuses, document output, then an operation timeline. */
.wa-panel .wa-work-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:15px 0;margin-bottom:24px;border-top:1px solid var(--wa-border-soft);border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-work-queue{display:flex;gap:24px;align-items:center;font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-work-queue>span{display:flex;align-items:baseline;gap:7px;white-space:nowrap}
.wa-panel .wa-work-queue strong{font:600 18px/1.2 var(--wa-font-body);color:var(--wa-ink);font-variant-numeric:tabular-nums}
.wa-panel .wa-work-capacity-controls{display:flex;align-items:center;gap:10px;min-width:0;font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-work-capacity-controls label{white-space:nowrap}
.wa-panel .wa-work-capacity-controls select{width:80px;min-height:32px;padding:4px 10px}
.wa-panel .wa-work-detail{min-width:0}
.wa-panel .wa-work-selection{display:grid;grid-template-columns:120px minmax(0,1fr);gap:22px;align-items:center;padding:0 0 24px}
.wa-panel .wa-work-selection>div{display:flex;flex-direction:column;gap:5px;font-size:12px}
.wa-panel .wa-work-selection>div>label{font-weight:600;color:var(--wa-ink)}
.wa-panel .wa-work-selection>div>span{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-work-selection select{width:100%;min-width:0;max-width:100%;text-overflow:ellipsis}
.wa-panel .wa-work-summary{padding:18px 20px;margin-bottom:28px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:6px}
.wa-panel .wa-work-status-line{display:flex;gap:28px;align-items:center;flex-wrap:wrap}
.wa-panel :is(.wa-work-state,.wa-work-delivery){display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wa-panel .wa-work-status-label{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-work-status-line>.wa-button{margin-left:auto}
.wa-panel .wa-work-summary>.wa-help{margin-top:10px}
.wa-panel .wa-work-progress{font-size:13px;line-height:1.85;padding-top:14px;margin-top:14px;border-top:1px solid var(--wa-border-soft);overflow-wrap:anywhere}
.wa-panel .wa-work-retry{display:flex;align-items:flex-start;gap:16px;margin-top:18px;padding-top:18px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-work-retry>.wa-button{flex-shrink:0}
.wa-panel .wa-work-retry>.wa-help{margin:0;flex:1}
.wa-panel .wa-work-summary>.wa-alert{margin-top:16px;margin-bottom:0}
.wa-panel .wa-work-section{padding:0 0 28px;margin-bottom:28px;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-work-section h3{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--wa-muted);margin:0 0 16px}
.wa-panel .wa-work-section h3>svg{width:15px;height:15px}
.wa-panel .wa-work-section h3>span{font:11px/1.5 var(--wa-font-mono);margin-left:3px}
.wa-panel .wa-work-content{white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;font:13px/1.9 var(--wa-font-body);margin:0;color:var(--wa-ink);min-width:0;max-width:100%;tab-size:2}
.wa-panel .wa-work-request>.wa-work-content{font-size:15px;line-height:1.85;max-width:850px}
.wa-panel .wa-work-result>.wa-work-content{max-width:900px;font-size:14px;line-height:2}
.wa-panel .wa-work-artifacts{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
.wa-panel .wa-work-artifacts th{font-weight:500;text-align:left;color:var(--wa-muted);font-size:11px;padding:8px 12px;border-bottom:1px solid var(--wa-border)}
.wa-panel .wa-work-artifacts th:first-child{width:48%}.wa-panel .wa-work-artifacts th:nth-child(2){width:18%}
.wa-panel .wa-work-artifacts td{padding:15px 12px;border-bottom:1px solid var(--wa-border-soft);vertical-align:top;overflow-wrap:anywhere}
.wa-panel .wa-work-artifacts :is(th,td):first-child{padding-left:0}.wa-panel .wa-work-artifacts :is(th,td):last-child{padding-right:0}
.wa-panel .wa-work-file-name{display:flex;gap:10px;align-items:flex-start;font-weight:550;line-height:1.8;min-width:0}
.wa-panel .wa-work-file-name>svg{width:17px;height:17px;flex-shrink:0;color:var(--wa-muted);margin-top:2px}
.wa-panel .wa-work-receipt{display:block;margin-top:7px;font:10px/1.7 var(--wa-font-mono);color:var(--wa-muted);word-break:break-all}
.wa-panel :is(.wa-work-metadata,.wa-work-log){min-width:0;border-bottom:1px solid var(--wa-border-soft);padding:0 0 16px;margin-bottom:16px}
.wa-panel :is(.wa-work-metadata,.wa-work-log)>summary{cursor:pointer;font-size:12px;font-weight:500;line-height:1.7;padding:4px 0;color:var(--wa-muted)}
.wa-panel :is(.wa-work-metadata,.wa-work-log)[open]>summary{color:var(--wa-ink);margin-bottom:18px}
.wa-panel .wa-work-metadata>p{font-size:12px;line-height:1.85;margin:9px 0;overflow-wrap:anywhere}
.wa-panel .wa-work-operation{position:relative;border-left:1px solid var(--wa-border);padding:0 0 24px 20px;margin-left:12px;min-width:0}
.wa-panel .wa-work-operation:last-child{padding-bottom:4px}
.wa-panel .wa-work-operation::before{content:'';position:absolute;left:-4px;top:7px;width:7px;height:7px;border:2px solid var(--wa-surface);border-radius:50%;background:var(--wa-muted)}
.wa-panel .wa-work-operation[data-state=done]::before{background:var(--wa-success)}
.wa-panel .wa-work-operation[data-state=failed]::before{background:var(--wa-danger)}
.wa-panel .wa-work-operation-title{display:flex;align-items:center;gap:10px;line-height:1.7;margin-bottom:10px;font-size:12px}
.wa-panel .wa-work-operation-index{font:10px/1.7 var(--wa-font-mono);color:var(--wa-muted)}
.wa-panel .wa-work-operation-title>strong{font-weight:600}
.wa-panel .wa-work-operation-title>span:last-child{margin-left:auto;color:var(--wa-muted);font-size:11px}
.wa-panel .wa-work-operation[data-state=failed] .wa-work-operation-title>span:last-child{color:var(--wa-danger)}
.wa-panel .wa-work-operation>.wa-work-content{font:11px/1.85 var(--wa-font-mono);padding:12px 14px;background:var(--wa-subtle);border-radius:5px;margin:10px 0}
.wa-panel .wa-work-operation>p{font-size:12px;line-height:1.8;margin-top:8px;overflow-wrap:anywhere}
.wa-panel .wa-work-files h3{font-size:12px;margin:18px 0 8px}.wa-panel .wa-work-files ul{padding-left:18px;font:11px/1.9 var(--wa-font-mono);overflow-wrap:anywhere}

/* Scheduled tasks: continuous rows and a compact history table. */
.wa-panel .wa-task-create{margin-bottom:32px;max-width:1020px}
.wa-panel .wa-task-fields>.wa-form-section{margin-top:26px;padding-top:26px}
.wa-panel .wa-task-fields>.wa-form-section:first-child{margin-top:0;padding-top:0;border:0}
.wa-panel .wa-task-fields .wa-form-section>h3{font-size:13px;margin:0 0 18px}
.wa-panel .wa-task-workspace{min-width:0}
.wa-panel .wa-task-toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:18px;padding-bottom:0;border-bottom:1px solid var(--wa-border)}
.wa-panel .wa-task-tabs{display:flex;gap:24px;flex-shrink:0;align-self:stretch}
.wa-panel .wa-task-tabs>button{display:flex;align-items:center;gap:8px;padding:12px 0;background:transparent;color:var(--wa-muted);border:0;border-bottom:2px solid transparent;margin-bottom:-1px;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.wa-panel .wa-task-tabs>button[aria-selected=true]{color:var(--wa-ink);border-bottom-color:var(--wa-ink);font-weight:600}
.wa-panel .wa-task-tabs>button>span{font:11px/1.6 var(--wa-font-mono);color:var(--wa-muted)}
.wa-panel .wa-task-tools{display:flex;gap:8px;padding-bottom:8px;min-width:0;max-width:470px}
.wa-panel .wa-task-tools>input{flex:1;min-width:130px;width:240px;max-width:100%}
.wa-panel .wa-task-tools>select{flex:0 1 180px;min-width:110px;width:160px}
.wa-panel .wa-task-list-heading,.wa-panel .wa-task-main{display:grid;grid-template-columns:minmax(0,1fr) 156px 94px 162px;gap:20px;align-items:center}
.wa-panel .wa-task-list-heading{padding:0 0 11px;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-task-list-heading>span:last-child{text-align:right}
.wa-panel .wa-task{border:0;border-top:1px solid var(--wa-border-soft);border-radius:0;background:transparent;padding:20px 0;min-width:0}
.wa-panel .wa-task:last-child{border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-task-main{align-items:start}
.wa-panel .wa-task-title-line{display:flex;align-items:flex-start;gap:9px;min-width:0}
.wa-panel .wa-task-title-line>svg{flex:0 0 auto;width:15px;height:15px;margin-top:4px;color:var(--wa-muted)}
.wa-panel .wa-task-heading{min-width:0}
.wa-panel .wa-task-heading h3{font-size:13px;line-height:1.8;font-weight:550;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.wa-panel .wa-task-heading>.wa-help{margin:6px 0 0 24px;font-size:11px;line-height:1.8}
.wa-panel .wa-task-next{display:flex;flex-direction:column;gap:6px;min-width:0}
.wa-panel .wa-task-next>span{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-task-next>time{font:11px/1.7 var(--wa-font-body);color:var(--wa-ink);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.wa-panel .wa-task-badge{display:inline-flex;align-items:center;gap:6px;justify-self:start;font-size:11px;line-height:1.7;color:var(--wa-muted);padding:3px 0;border:0;white-space:normal}
.wa-panel .wa-task-badge:is(.is-completed,.is-sent){color:var(--wa-success)}
.wa-panel .wa-task-badge:is(.is-running,.is-queued,.is-pending){color:var(--wa-info)}
.wa-panel .wa-task-badge:is(.is-unknown,.is-partial,.is-settling){color:var(--wa-warning)}
.wa-panel .wa-task-badge.is-failed{color:var(--wa-danger)}
.wa-panel .wa-task-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex-wrap:wrap}
.wa-panel .wa-task-actions>.wa-button{font-size:11px;min-height:30px;padding:4px 8px}
.wa-panel .wa-task-warning{font-size:12px;line-height:1.8;color:var(--wa-warning);padding:10px 12px;background:var(--wa-warning-soft);margin:14px 0 0;overflow-wrap:anywhere;border-radius:4px}
.wa-panel .wa-task-details{padding-left:24px;margin-top:12px;font-size:12px;min-width:0}
.wa-panel .wa-task-details>summary{width:fit-content;color:var(--wa-muted);cursor:pointer;font-size:11px;line-height:1.8}
.wa-panel .wa-task-details[open]>summary{color:var(--wa-ink);margin-bottom:14px}
.wa-panel .wa-task-detail-content{background:var(--wa-subtle);padding:18px 20px;margin:0;min-width:0;border-radius:5px}
.wa-panel .wa-task-content{white-space:pre-wrap;font-size:13px;line-height:1.85;overflow-wrap:anywhere}
.wa-panel .wa-task-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 22px;font-size:11px;line-height:1.8;color:var(--wa-muted);margin-top:16px}
.wa-panel .wa-task-facts>span{overflow-wrap:anywhere}
.wa-panel .wa-task-history-head,.wa-panel .wa-task-history-row>summary{display:grid;grid-template-columns:140px minmax(0,1fr) 110px 16px;align-items:start;gap:20px;min-width:0}
.wa-panel .wa-task-history-head{padding:0 0 11px;color:var(--wa-muted);font-size:11px}
.wa-panel .wa-task-history-row{border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-task-history-row:last-child{border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-task-history-row>summary{padding:18px 0;cursor:pointer;list-style:none;line-height:1.8}
.wa-panel .wa-task-history-row>summary::-webkit-details-marker{display:none}
.wa-panel .wa-task-history-row>summary:hover .wa-task-history-title strong{color:var(--wa-accent)}
.wa-panel .wa-task-history-row>summary>time{font-size:11px;color:var(--wa-muted);font-variant-numeric:tabular-nums}
.wa-panel .wa-task-history-title{display:flex;flex-direction:column;gap:5px;min-width:0}
.wa-panel .wa-task-history-title strong{font-size:13px;font-weight:550;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.wa-panel .wa-task-history-title>span{font-size:11px;color:var(--wa-muted);overflow-wrap:anywhere}
.wa-panel .wa-task-history-result{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
.wa-panel .wa-task-history-result small{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-task-expand{color:var(--wa-muted);font-size:16px;transition:transform .15s}
.wa-panel .wa-task-history-row[open] .wa-task-expand{transform:rotate(180deg)}
.wa-panel .wa-task-history-row>.wa-task-detail-content{margin:0 0 18px 160px}
.wa-panel .wa-task-executions{margin-top:20px;padding-top:16px;border-top:1px solid var(--wa-border)}
.wa-panel .wa-task-executions>h3{font-size:12px;margin-bottom:14px}
.wa-panel .wa-task-execution{padding:10px 0;border-bottom:1px solid var(--wa-border-soft);font-size:11px}
.wa-panel .wa-task-execution:last-child{border:0}
.wa-panel .wa-task-execution .wa-help{font-size:11px;margin-top:6px}
.wa-panel .wa-task-receipts{overflow-wrap:anywhere;font-family:var(--wa-font-mono)}
.wa-panel .wa-task-pagination{display:flex;justify-content:flex-end;align-items:center;gap:16px;padding-top:20px;font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-task-recipient-picker{gap:12px;margin-top:20px}
.wa-panel .wa-task-recipient-picker>.wa-between{gap:12px}
.wa-panel .wa-recipient-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;max-height:228px;overflow:auto;scrollbar-width:thin;border-top:1px solid var(--wa-border-soft);border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-recipient-row{display:flex;align-items:flex-start;gap:10px;padding:11px 8px;border-bottom:1px solid var(--wa-border-soft);font-size:12px;line-height:1.7;min-width:0;cursor:pointer}
.wa-panel .wa-recipient-row>input{flex:0 0 auto;width:15px;height:15px;margin-top:3px;accent-color:var(--wa-accent)}
.wa-panel .wa-recipient-row>span{min-width:0;overflow-wrap:anywhere}
.wa-panel .wa-recipient-row:hover{background:var(--wa-hover)}
.wa-panel .wa-recipient-row.is-selected{background:var(--wa-subtle)}
.wa-panel .wa-recipient-selection{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.wa-panel .wa-recipient-selection>.wa-button{min-height:29px;padding:3px 8px;font-size:11px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:5px}

/* Digests: a reading surface with source references and actionable todo rows. */
.wa-panel .wa-digest-generator{grid-template-columns:minmax(160px,1.15fr) repeat(2,minmax(150px,1fr)) auto;gap:14px;margin:0 0 30px;padding:0 0 25px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-digest-workspace>.wa-digest-index{padding-top:2px}
.wa-panel .wa-wb-digest{padding:2px 0 0 8px;min-width:0}
.wa-panel .wa-digest-document-heading{padding-bottom:18px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:14px}
.wa-panel .wa-digest-document-heading>span{font-size:11px;line-height:1.7;color:var(--wa-muted)}
.wa-panel .wa-digest-document-heading h2{font-size:23px;font-weight:600;line-height:1.6;letter-spacing:-.4px;margin:8px 0 0;overflow-wrap:anywhere}
.wa-panel .wa-digest-coverage{padding:0;margin:0 0 24px}
.wa-panel .wa-wb-digest-section{margin-top:28px;min-width:0}
.wa-panel .wa-wb-digest-section>h3{font-size:13px;font-weight:600;margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-digest-conclusion{position:relative;padding:9px 0 12px 16px;border:0}
.wa-panel .wa-digest-conclusion::before{content:'';position:absolute;width:4px;height:4px;border-radius:50%;background:var(--wa-faint);left:0;top:20px}
.wa-panel .wa-digest-conclusion p{font-size:14px;line-height:1.95;margin:0 0 6px}
.wa-panel .wa-digest-conclusion small{font:11px/1.7 var(--wa-font-body)}
.wa-panel .wa-wb-todo{padding:18px 0;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-wb-todo:last-child{border-bottom:0}
.wa-panel .wa-wb-todo>.wa-wb-between{gap:12px;margin-bottom:10px}
.wa-panel .wa-wb-todo>.wa-wb-between>span:first-child{font-size:11px;color:var(--wa-muted);min-width:0;overflow-wrap:anywhere}
.wa-panel .wa-wb-todo>textarea{min-height:75px;font-size:13px;line-height:1.85;margin:0 0 12px;resize:vertical}
.wa-panel .wa-wb-todo-text{font-size:14px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}
.wa-panel .wa-wb-todo.is-done .wa-wb-todo-text{color:var(--wa-muted)}
.wa-panel .wa-wb-todo>.wa-wb-note{margin-top:10px}
.wa-panel .wa-todo-actions{justify-content:flex-start}
.wa-panel .wa-wb-source-list{border-top:1px solid var(--wa-border-soft);margin-top:24px;padding-top:18px}
.wa-panel .wa-wb-source-list>summary{font-size:12px;color:var(--wa-muted);cursor:pointer;padding:5px 0;line-height:1.7}
.wa-panel .wa-wb-source-list blockquote{border:0;border-left:2px solid var(--wa-border);padding:3px 0 3px 14px;margin:20px 0;min-width:0}
.wa-panel .wa-wb-source-list blockquote>small{color:var(--wa-muted);font-size:11px;line-height:1.8;overflow-wrap:anywhere}
.wa-panel .wa-wb-source-list blockquote>p{font-size:13px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.wa-panel .wa-wb-digest>.wa-wb-history{border-top:1px solid var(--wa-border-soft);padding-top:20px;margin-top:24px;justify-content:flex-end}

/* Moments: a feed, a content composer, and an independent automation planner. */
.wa-panel .wa-moments-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin:0 0 24px}
.wa-panel .wa-moments-lookup{font-size:12px;min-width:0;max-width:450px}
.wa-panel .wa-moments-lookup>summary{cursor:pointer;color:var(--wa-muted);padding:9px 0;line-height:1.6}
.wa-panel .wa-moments-lookup .wa-wb-generator{grid-template-columns:minmax(0,1fr) auto;margin:12px 0 0;padding:16px;border:1px solid var(--wa-border-soft);border-radius:6px;background:var(--wa-surface)}
.wa-panel .wa-moments-detail{min-width:0;padding:4px 0 0 8px}
.wa-panel .wa-moments-post-heading{display:flex;align-items:center;gap:12px;padding-bottom:22px;min-width:0}
.wa-panel .wa-moments-avatar{display:grid;place-items:center;width:36px;height:36px;background:var(--wa-subtle);color:var(--wa-muted);border:1px solid var(--wa-border-soft);border-radius:50%;flex:0 0 auto}
.wa-panel .wa-moments-avatar>svg{width:17px;height:17px}
.wa-panel .wa-moments-post-heading>div{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.wa-panel .wa-moments-post-heading strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.wa-panel .wa-moments-post-heading time{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-moments-post-text{font-size:15px;line-height:2;white-space:pre-wrap;overflow-wrap:anywhere;min-height:100px;padding:0 0 28px}
.wa-panel .wa-moments-detail>.wa-moments-post-actions{border-top:1px solid var(--wa-border-soft);padding-top:18px;gap:10px}
.wa-panel .wa-moments-detail>.wa-moments-post-actions>.is-danger{margin-left:auto}
.wa-panel .wa-moments-comments{max-width:920px;min-width:0}
.wa-panel .wa-moments-comments>.wa-wb-generator{grid-template-columns:minmax(0,1fr) auto;padding-bottom:22px;border-bottom:1px solid var(--wa-border-soft);max-width:650px;margin:0 0 18px}
.wa-panel .wa-moments-comment{position:relative;padding:20px 0}
.wa-panel .wa-moments-comment-heading{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.wa-panel .wa-moments-comment-heading>strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.wa-panel .wa-moments-comment-heading>small{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-moments-comment>p{margin:9px 0 12px;line-height:1.95}
.wa-panel .wa-moments-comment>.wa-wb-button{min-height:28px;padding:3px 0;font-size:11px}
.wa-panel .wa-moments-composer{max-width:940px}
.wa-panel .wa-moments-composer textarea{min-height:210px;font-size:14px;line-height:1.95}
.wa-panel .wa-composer-count{text-align:right;font-size:11px;font-weight:400;color:var(--wa-muted);font-variant-numeric:tabular-nums;margin-top:-4px}
.wa-panel .wa-moments-composer label:has(input[type=file]){margin-top:22px}
.wa-panel .wa-moments-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:12px;margin:18px 0;max-width:690px}
.wa-panel .wa-moments-photos>figure{margin:0;min-width:0;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:6px;overflow:hidden}
.wa-panel .wa-moments-photos img{display:block;width:100%;height:150px;object-fit:cover;border-radius:5px;max-width:100%}
.wa-panel .wa-moments-photos>img{height:auto;max-height:400px;object-fit:contain}
.wa-panel .wa-moments-photos figcaption{display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:10px;color:var(--wa-muted)}
.wa-panel .wa-moments-photos figcaption>span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1}
.wa-panel .wa-moments-photos figcaption>.wa-wb-button{min-height:24px;padding:2px 3px;font-size:10px;flex:0 0 auto}
.wa-panel .wa-moments-schedule{max-width:1020px}
.wa-panel .wa-moments-schedule>.wa-wb-between{margin-bottom:8px}
.wa-panel .wa-moments-schedule>.wa-wb-between>h2{font-size:16px}
.wa-panel .wa-moments-schedule>.wa-wb-note{margin-top:8px}
.wa-panel .wa-moments-reply-fields{min-width:0;border:0;margin:0;padding:0}
.wa-panel .wa-moments-reply-fields>legend{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;padding:0;border:0}
.wa-panel .wa-moments-reply-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px;margin-top:24px}
.wa-panel .wa-moments-reply-mode{min-width:0;padding-top:18px;border-top:2px solid var(--wa-border)}
.wa-panel .wa-moments-reply-mode:has(>.wa-wb-check>input:checked){border-top-color:var(--wa-accent)}
.wa-panel .wa-moments-reply-mode>label{margin:0 0 20px}
.wa-panel .wa-moments-reply-mode .wa-wb-check small{display:block;font-weight:400;color:var(--wa-muted);margin-top:5px}
.wa-panel .wa-moments-reply-mode .wa-wb-note{margin:14px 0 0}
.wa-panel .wa-moments-reply-selection{max-height:210px;overflow:auto}
.wa-panel .wa-moments-reply-status>p{font-size:12px;line-height:1.8;margin:8px 0}
.wa-panel .wa-moments-reply-record>p{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:680px){.wa-panel .wa-moments-reply-modes{grid-template-columns:minmax(0,1fr);gap:8px}}
.wa-panel .wa-moments-replies{margin-top:32px;padding-top:24px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-moments-replies>.wa-index-heading{padding-bottom:0}
.wa-panel .wa-moments-replies .wa-wb-summary-item>p:first-of-type{padding-left:12px;border-left:2px solid var(--wa-border);color:var(--wa-muted)}
.wa-panel .wa-moments-publishing{display:flex;flex-direction:column;gap:32px;min-width:0}
.wa-panel .wa-moments-global{padding:0 0 26px;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-moments-global>.wa-wb-between>h2{font-size:15px}
.wa-panel .wa-moments-global>.wa-wb-check{margin-top:18px}
.wa-panel .wa-moments-global>.wa-wb-generator{max-width:670px;margin-bottom:0}
.wa-panel .wa-moments-global>.wa-form-actions{padding-top:18px;margin-top:20px}
.wa-panel .wa-moments-arrangement{margin-top:24px;padding-top:20px;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-moments-arrangement h3{font-size:14px;margin:0 0 14px}
.wa-panel .wa-moments-arrangement-content{margin-top:16px}
.wa-panel .wa-moments-arrangement-content>label{display:block;margin-top:16px}
.wa-panel .wa-moments-arrangement-content>label.wa-wb-check{display:flex}
.wa-panel .wa-moments-arrangement-content summary{cursor:pointer;font-size:13px;font-weight:600;padding:8px 0}
.wa-panel .wa-moments-arrangement-status{font-size:12px;line-height:1.8;color:var(--wa-muted);margin-top:16px}
.wa-panel .wa-moments-arrangement-status p{margin:3px 0}
.wa-panel .wa-moments-plan-list{min-width:0}
.wa-panel .wa-moments-plan{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px 24px;padding:20px 0;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-moments-plan-copy{min-width:0}
.wa-panel .wa-moments-plan-copy>.wa-wb-between{justify-content:flex-start;gap:14px}
.wa-panel .wa-moments-plan-copy strong{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.wa-panel .wa-moments-plan-copy>p{font-size:13px;line-height:1.85;margin:7px 0;overflow-wrap:anywhere}
.wa-panel .wa-moments-plan-copy>small{font-size:11px;line-height:1.8;color:var(--wa-muted)}
.wa-panel .wa-moments-plan>.wa-moments-post-actions{align-self:start;gap:4px;max-width:240px;justify-content:flex-end}
.wa-panel .wa-moments-plan>.wa-moments-post-actions>.wa-wb-button{font-size:11px;min-height:30px;padding:4px 8px}
.wa-panel .wa-moments-plan>.wa-wb-review{grid-column:1/-1;margin:0}
.wa-panel .wa-moments-plan-editor{max-width:1020px}
.wa-panel .wa-moments-plan-editor .wa-form-section>label{margin-bottom:18px}
.wa-panel .wa-moments-plan-editor .wa-form-section>label:last-child{margin-bottom:0}
.wa-panel .wa-moments-plan-editor .wa-form-section:first-child{border-top:0;margin-top:0;padding-top:0}
.wa-panel .wa-moments-plan-editor .wa-form-section>h3{font-size:13px;margin:0 0 18px}
.wa-panel .wa-moments-weekdays{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.wa-panel .wa-moments-weekdays .wa-wb-check{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;margin:0;border:1px solid var(--wa-border);border-radius:5px;font-size:12px;background:var(--wa-surface)}
.wa-panel .wa-moments-weekdays .wa-wb-check:has(input:checked){border-color:var(--wa-accent);background:var(--wa-accent-soft)}
.wa-panel .wa-moments-weekdays .wa-wb-check>input{margin:0;width:13px;height:13px}
.wa-panel .wa-moments-records{padding-top:24px;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-moments-records>.wa-wb-note{margin:-6px 0 24px}
.wa-panel .wa-moments-draft-detail{padding:4px 0 0 6px;min-width:0}
.wa-panel .wa-moments-draft-detail>.wa-wb-note{margin:10px 0 20px}
.wa-panel .wa-moments-draft-detail>p:not(.wa-wb-note):not(.wa-alert){font-size:14px;line-height:1.95;overflow-wrap:anywhere}
.wa-panel .wa-moments-draft-detail>label{margin:18px 0}
.wa-panel .wa-moments-draft-detail textarea{font-size:14px;line-height:1.95;min-height:230px}
.wa-panel .wa-moments-draft-detail>.wa-wb-actions{padding-top:20px;margin-top:22px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-moments-draft-detail>details{margin-top:18px;font-size:12px;line-height:1.9;overflow-wrap:anywhere}
.wa-panel .wa-moments-draft-detail>details>summary{cursor:pointer;color:var(--wa-muted)}
.wa-panel .wa-moments-draft-detail>details p{margin:8px 0}
.wa-panel .wa-moments-draft-detail>.wa-alert{margin-top:18px}

/* Friends use a continuous feed and separate, flat automation sections. */
.wa-panel .wa-moments-friends{max-width:1060px;min-width:0}
.wa-panel .wa-moments-friends :is(.wa-wb-tag.is-liked,.wa-wb-tag.is-completed){background:var(--wa-success-soft);color:var(--wa-success);border-color:transparent}
.wa-panel .wa-friend-query{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:4px 0 16px}
.wa-panel .wa-friend-query>label{min-width:160px;flex:1;max-width:470px}
.wa-panel .wa-friend-query>label:first-child{flex:0 1 190px}
.wa-panel .wa-friend-feed>.wa-wb-note{margin-bottom:16px}
.wa-panel .wa-friend-post{padding:22px 0;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-friend-post>.wa-moments-post-heading{padding-bottom:12px}
.wa-panel .wa-friend-post-text{font-size:14px;line-height:1.95;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 14px;padding-left:48px}
.wa-panel .wa-friend-post-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;padding-left:48px;min-height:32px}
.wa-panel .wa-friend-post-footer>span:first-child{font-size:11px;line-height:1.8;color:var(--wa-muted)}
.wa-panel .wa-friend-post-footer>.wa-wb-button{min-height:30px;font-size:12px;padding:4px 12px}
.wa-panel .wa-friend-like-error{margin:10px 0 0;padding-left:48px}
.wa-panel .wa-friend-automation,.wa-panel .wa-likes-history{margin-top:34px;padding-top:26px;border-top:1px solid var(--wa-border)}
.wa-panel .wa-likes-fields{border:0;padding:0;margin:0;min-width:0}
.wa-panel .wa-likes-fields>.wa-form-section{margin-top:24px;padding-top:22px}
.wa-panel .wa-likes-fields>.wa-form-section:first-child{border-top:0;margin-top:20px;padding-top:0}
.wa-panel .wa-likes-fields .wa-wb-check{margin-bottom:10px}
.wa-panel .wa-friend-contact-search{display:flex;align-items:flex-end;gap:12px;margin:16px 0}
.wa-panel .wa-friend-contact-search>label{flex:1;min-width:0}
.wa-panel .wa-friend-contact-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;max-height:242px;overflow:auto;scrollbar-width:thin;border-block:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-friend-contact-list>.wa-audience-row{padding:10px 8px;margin:0;border-bottom:1px solid var(--wa-border-soft);align-items:flex-start;font-size:12px;line-height:1.7}
.wa-panel .wa-friend-contact-list>.wa-audience-row:hover,.wa-panel .wa-friend-contact-list>.is-selected{background:var(--wa-subtle)}
.wa-panel .wa-friend-contact-list>p{padding:12px 8px}
.wa-panel .wa-likes-limits{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:20px}
.wa-panel .wa-likes-status{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding-top:22px;font-size:12px;line-height:1.8;color:var(--wa-muted)}
.wa-panel .wa-likes-status p{margin:3px 0}
.wa-panel .wa-likes-record,.wa-panel .wa-likes-run{padding:18px 0;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-likes-record strong,.wa-panel .wa-likes-run strong{font-size:12px;overflow-wrap:anywhere}
.wa-panel .wa-likes-record p,.wa-panel .wa-likes-run p{font-size:12px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
.wa-panel .wa-likes-record small{font-size:11px;color:var(--wa-muted);overflow-wrap:anywhere}
@media(max-width:680px){.wa-panel .wa-likes-limits{grid-template-columns:repeat(2,minmax(0,1fr))}.wa-panel .wa-friend-post-text,.wa-panel .wa-friend-post-footer,.wa-panel .wa-friend-like-error{padding-left:0}.wa-panel .wa-friend-post-footer{flex-wrap:wrap}.wa-panel .wa-friend-contact-list{grid-template-columns:minmax(0,1fr)}.wa-panel .wa-friend-query>label,.wa-panel .wa-friend-query>label:first-child{flex:1 1 100%;max-width:none}.wa-panel .wa-friend-contact-search{flex-wrap:wrap}.wa-panel .wa-friend-contact-search>label{flex-basis:100%}}

/* Audience selection is a directory, not a wall of option cards. */
.wa-panel .wa-audience-picker{min-width:0}
.wa-panel .wa-audience-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:8px}
.wa-panel .wa-audience-heading h3{font-size:13px;margin:0}
.wa-panel .wa-audience-count{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-audience-picker>.wa-wb-actions{margin:14px 0}
.wa-panel .wa-audience-grid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:20px;margin:20px 0 14px}
.wa-panel .wa-audience-column{min-width:0}
.wa-panel .wa-audience-column>label{margin-bottom:12px}
.wa-panel .wa-audience-list{max-height:270px;overflow:auto;scrollbar-width:thin;border-top:1px solid var(--wa-border-soft);border-bottom:1px solid var(--wa-border-soft);padding:0;min-width:0}
.wa-panel .wa-audience-list .wa-audience-row{padding:11px 8px;margin:0;gap:9px;border-bottom:1px solid var(--wa-border-soft);font-size:12px;line-height:1.7;min-width:0}
.wa-panel .wa-audience-list .wa-audience-row:hover{background:var(--wa-hover)}
.wa-panel .wa-audience-list .wa-audience-row.is-selected{background:var(--wa-subtle)}
.wa-panel .wa-audience-row>span{flex:1;min-width:0;overflow-wrap:anywhere}
.wa-panel .wa-audience-row>small{flex-shrink:0;margin-left:auto;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-audience-identity{display:block;font:10px/1.8 var(--wa-font-mono);color:var(--wa-muted);word-break:break-all;margin-top:3px}
.wa-panel .wa-audience-list>.wa-wb-note{padding:16px 8px}
.wa-panel .wa-audience-list>.wa-wb-button{margin:12px 0}

@media(max-width:1180px){
 .wa-panel .wa-digest-generator{grid-template-columns:repeat(2,minmax(0,1fr))}
 .wa-panel .wa-task-toolbar{align-items:flex-start;gap:16px;flex-direction:column}
 .wa-panel .wa-task-tools{width:100%;max-width:none;padding-bottom:12px}
 .wa-panel .wa-task-tools>input{width:auto}.wa-panel .wa-task-tools>select{flex-basis:190px}
 .wa-panel .wa-task-list-heading,.wa-panel .wa-task-main{grid-template-columns:minmax(0,1fr) 156px 90px;gap:16px}
 .wa-panel .wa-task-list-heading>span:last-child{display:none}
 .wa-panel .wa-task-actions{grid-column:2/4;justify-content:flex-start;align-items:center;margin-top:-4px}
 .wa-panel .wa-task-main>.wa-task-heading{grid-row:span 2}
 .wa-panel .wa-moments-plan{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-moments-plan>.wa-moments-post-actions{justify-content:flex-start;max-width:none}
}
@media(max-width:900px){
 .wa-panel .wa-wb-split{grid-template-columns:minmax(185px,.7fr) minmax(0,1.3fr)}
 .wa-panel .wa-wb-split>.wa-wb-list{margin-right:20px;padding-right:14px}
 .wa-panel .wa-work-status-line{gap:18px}
 .wa-panel .wa-work-retry{flex-direction:column;gap:10px}
 .wa-panel .wa-work-selection{grid-template-columns:95px minmax(0,1fr);gap:16px}
 .wa-panel .wa-task-history-head,.wa-panel .wa-task-history-row>summary{grid-template-columns:110px minmax(0,1fr) 90px 12px;gap:14px}
 .wa-panel .wa-task-history-row>.wa-task-detail-content{margin-left:124px}
 .wa-panel .wa-automation-editor{padding:22px}
}
@media(max-width:680px){
 .wa-panel .wa-wb-split{display:block}
 .wa-panel .wa-wb-split>.wa-wb-list{max-height:240px;margin:0 0 25px;padding:0 0 12px;border-right:0;border-bottom:1px solid var(--wa-border)}
 .wa-panel .wa-wb-list-item{padding:13px 12px}
 .wa-panel .wa-wb-generator:has(>label:nth-child(3):last-child){grid-template-columns:repeat(2,minmax(0,1fr))}
 .wa-panel .wa-work-toolbar{align-items:flex-start;flex-direction:column;gap:16px}
 .wa-panel .wa-work-capacity-controls{width:100%;justify-content:flex-start}
 .wa-panel .wa-work-capacity-controls>.wa-button{margin-left:auto}
 .wa-panel .wa-work-selection{grid-template-columns:minmax(0,1fr);gap:12px}
 .wa-panel .wa-work-selection>div{flex-direction:row;justify-content:space-between}
 .wa-panel .wa-work-summary{padding:16px}
 .wa-panel .wa-work-status-line{align-items:flex-start;gap:14px;flex-direction:column}
 .wa-panel .wa-work-status-line>.wa-button{margin-left:0}
 .wa-panel .wa-work-artifacts th:first-child{width:42%}.wa-panel .wa-work-artifacts th:nth-child(2){width:21%}
 .wa-panel .wa-work-artifacts th,.wa-panel .wa-work-artifacts td{padding-right:8px;padding-left:8px}
 .wa-panel .wa-work-file-name{gap:7px;flex-direction:column}
 .wa-panel .wa-work-file-name>svg{display:none}
 .wa-panel .wa-task-list-heading{display:none}
 .wa-panel .wa-task-main{grid-template-columns:minmax(0,1fr) auto;gap:13px 14px}
 .wa-panel .wa-task-main>.wa-task-heading{grid-column:1/-1;grid-row:auto}
 .wa-panel .wa-task-main>.wa-task-next{grid-column:1;flex-direction:row;flex-wrap:wrap;gap:6px 10px;padding-left:24px}
 .wa-panel .wa-task-main>.wa-task-badge{grid-column:2;grid-row:2}
 .wa-panel .wa-task-actions{grid-column:1/-1;padding-left:16px;margin-top:0}
 .wa-panel .wa-task-detail-content{padding:16px}
 .wa-panel .wa-task-facts{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-task-history-head{display:none}
 .wa-panel .wa-task-history-row>summary{grid-template-columns:minmax(0,1fr) auto 12px;gap:8px 12px}
 .wa-panel .wa-task-history-row>summary>time{grid-column:1;grid-row:1}
 .wa-panel .wa-task-history-title{grid-column:1/-1;grid-row:2}
 .wa-panel .wa-task-history-result{grid-column:2;grid-row:1;max-width:130px}
 .wa-panel .wa-task-expand{grid-column:3;grid-row:1}
 .wa-panel .wa-task-history-row>.wa-task-detail-content{margin:0 0 18px}
 .wa-panel .wa-digest-document-heading h2{font-size:21px}
 .wa-panel .wa-wb-digest,.wa-panel .wa-moments-detail,.wa-panel .wa-moments-draft-detail{padding-left:0}
 .wa-panel .wa-wb-between{flex-wrap:wrap}
 .wa-panel .wa-moments-toolbar{flex-wrap:wrap;gap:12px}
 .wa-panel .wa-moments-lookup{width:100%;max-width:none}
 .wa-panel .wa-moments-detail>.wa-moments-post-actions>.is-danger{margin-left:0}
 .wa-panel .wa-audience-grid{grid-template-columns:minmax(0,1fr);gap:24px}
 .wa-panel .wa-audience-list{max-height:228px}
 .wa-panel .wa-automation-editor{padding:20px}
 .wa-panel .wa-section-heading{align-items:flex-start;flex-wrap:wrap;gap:12px}
}
@media(max-width:430px){
 .wa-panel .wa-wb-generator,.wa-panel .wa-wb-generator:has(>label:nth-child(3):last-child),.wa-panel .wa-digest-generator{grid-template-columns:minmax(0,1fr);gap:18px}
 .wa-panel .wa-task-tools{flex-direction:column;gap:9px}.wa-panel .wa-task-tools>select{width:100%;flex-basis:auto}
 .wa-panel .wa-task-tabs{gap:20px}
 .wa-panel .wa-task-details{padding-left:0}
 .wa-panel .wa-task-main>.wa-task-next{padding-left:0}
 .wa-panel .wa-task-actions{padding-left:0}
 .wa-panel .wa-task-pagination{justify-content:space-between;gap:8px;font-size:11px}
 .wa-panel .wa-recipient-list{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-automation-editor{padding:16px}
 .wa-panel .wa-moments-comments>.wa-wb-generator,.wa-panel .wa-moments-lookup .wa-wb-generator{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-moments-photos{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
 .wa-panel .wa-moments-photos img{height:120px}
 .wa-panel .wa-moments-plan-copy>.wa-wb-between{gap:8px}
 .wa-panel .wa-moments-weekdays{gap:6px}.wa-panel .wa-moments-weekdays .wa-wb-check{padding:6px 9px;font-size:11px}
 .wa-panel .wa-wb-review{padding:14px 15px}
 .wa-panel .wa-work-operation{margin-left:4px;padding-left:14px}
 .wa-panel .wa-work-operation>.wa-work-content{padding:10px;font-size:10px}
}
`;
