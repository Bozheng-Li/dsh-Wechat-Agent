// Shared controls have one definition; page styles own their layout.
export const foundationCss = `
.wa-panel{height:100%;min-height:0;overflow:hidden;isolation:isolate;background:var(--wa-canvas);color:var(--wa-ink);font:13px/1.65 var(--wa-font-body);-webkit-font-smoothing:antialiased}
.wa-panel *,.wa-panel *::before,.wa-panel *::after{box-sizing:border-box}
.wa-panel [hidden]{display:none!important}
.wa-panel :is(button,input,textarea,select){font:inherit;color:inherit}
.wa-panel button{cursor:pointer}.wa-panel button:disabled{cursor:not-allowed;opacity:.45}
.wa-panel :is(button,input,textarea,select,summary,a,[tabindex]):focus-visible{outline:2px solid var(--wa-accent);outline-offset:3px}
.wa-panel :is(p,h1,h2,h3,h4,dl,dd){margin:0}
.wa-panel h1{font:600 24px/1.35 var(--wa-title-font);letter-spacing:-.55px}
.wa-panel h2{font-size:15px;line-height:1.5;font-weight:600;letter-spacing:-.15px}
.wa-panel h3{font-size:13px;line-height:1.6;font-weight:600}
.wa-panel a{color:var(--wa-accent);text-underline-offset:3px}
.wa-panel svg{display:block;flex-shrink:0}.wa-icon{width:18px;height:18px}.wa-icon-small{width:15px;height:15px}
.wa-panel img{max-width:100%}.wa-panel pre{overflow:auto;max-width:100%}
.wa-panel ::selection{background:var(--wa-accent-soft);color:var(--wa-ink)}
.wa-panel ::-webkit-scrollbar{width:7px;height:7px}.wa-panel ::-webkit-scrollbar-thumb{background:var(--wa-border);border-radius:9px;border:1px solid var(--wa-canvas)}
.wa-panel :is(.wa-muted,.wa-help,.wa-wb-note){color:var(--wa-muted);font-size:12px;line-height:1.75;opacity:1}
.wa-panel .wa-help{margin-top:6px}.wa-panel .wa-small{font-size:12px}
.wa-panel :is(.wa-mono,.wa-path-value){font-family:var(--wa-font-mono);font-size:11px;overflow-wrap:anywhere}
.wa-panel .wa-path{white-space:pre-wrap;overflow-wrap:anywhere}
.wa-panel :is(.wa-row,.wa-wb-actions){display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.wa-panel :is(.wa-between,.wa-wb-between){display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.wa-panel .wa-stack{display:flex;flex-direction:column;gap:24px;min-width:0}
.wa-panel .wa-section-space{margin-top:20px}.wa-panel .wa-content-narrow{max-width:920px}
.wa-panel .wa-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin:2px 0 28px}
.wa-panel .wa-page-heading-copy{min-width:0}.wa-panel .wa-page-heading-copy h1{display:flex;align-items:center;gap:10px}
.wa-panel .wa-page-heading-copy h1>svg{width:21px;height:21px;color:var(--wa-muted);stroke-width:1.6}
.wa-panel .wa-page-head p{margin-top:7px;max-width:650px;line-height:1.8}
.wa-panel .wa-page-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-top:2px;flex-shrink:0}
.wa-panel .wa-eyebrow{font-size:11px;color:var(--wa-muted);margin-bottom:8px}
.wa-panel .wa-back{display:inline-flex;align-items:center;gap:6px;padding:4px 0;margin:0 0 14px;border:0;background:none;color:var(--wa-muted);font-size:12px}
.wa-panel .wa-back:hover{color:var(--wa-ink)}

/* Buttons reserve solid fill for the main action. */
.wa-panel .wa-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:6px 12px;border:1px solid var(--wa-border);border-radius:6px;background:var(--wa-surface);color:var(--wa-ink);font-size:12px;font-weight:550;line-height:1.6;text-align:center;white-space:normal;vertical-align:middle;transition:background .13s,border-color .13s,color .13s;box-shadow:var(--wa-shadow)}
.wa-panel .wa-button:hover:not(:disabled){background:var(--wa-subtle);border-color:var(--wa-faint)}
.wa-panel .wa-button:active:not(:disabled){background:var(--wa-hover)}
.wa-panel .wa-button.wa-primary{background:var(--wa-action);color:var(--wa-on-action);border-color:var(--wa-action)}
.wa-panel .wa-button.wa-primary:hover:not(:disabled){background:var(--wa-action-hover);border-color:var(--wa-action-hover)}
.wa-panel .wa-button.wa-quiet{border-color:transparent;background:transparent;box-shadow:none;color:var(--wa-muted)}
.wa-panel .wa-button.wa-quiet:hover:not(:disabled){background:var(--wa-hover);color:var(--wa-ink);border-color:transparent}
.wa-panel .wa-button.wa-danger{color:var(--wa-danger);background:transparent;border-color:var(--wa-border);box-shadow:none}
.wa-panel .wa-button.wa-danger:hover:not(:disabled){background:var(--wa-danger-soft);border-color:color-mix(in srgb,var(--wa-danger) 30%,var(--wa-border))}
.wa-panel .wa-button[data-size=small]{min-height:28px;padding:3px 8px;font-size:11px}
.wa-panel .wa-icon-button{width:32px;min-width:32px;min-height:32px;padding:6px}
.wa-panel .wa-button[aria-busy=true] .wa-button-spinner{width:13px;height:13px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:wa-spin .8s linear infinite}

/* Sections stay flat. Editors, selected rows and dialogs own their surfaces. */
.wa-panel :is(.wa-card,.wa-wb-card){min-width:0;padding:20px 0;border:0;border-top:1px solid var(--wa-border-soft);border-radius:0;background:transparent;box-shadow:none}
.wa-panel .wa-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px;min-width:0}
.wa-panel .wa-card-heading p{margin-top:4px;color:var(--wa-muted);font-size:12px}
.wa-panel .wa-card-icon{display:grid;place-items:center;width:30px;height:30px;flex-shrink:0;color:var(--wa-muted);border:0;background:transparent;border-radius:6px}
.wa-panel .wa-note-box{padding:12px 14px;border-left:2px solid var(--wa-border);background:var(--wa-subtle);font-size:12px;line-height:1.8}
.wa-panel .wa-note-box p+p{margin-top:5px}
.wa-panel .wa-path-value{padding:10px 12px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:6px;margin-top:8px;line-height:1.8}

/* Fields keep quiet boundaries and unambiguous focus. */
.wa-panel .wa-field{display:block;min-width:0;margin-bottom:20px}.wa-panel .wa-field:last-child{margin-bottom:0}
.wa-panel :is(.wa-field-label,.wa-label){display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;font-weight:550;margin-bottom:7px}
.wa-panel .wa-field-count{font:11px var(--wa-font-mono);color:var(--wa-muted);font-weight:400;white-space:nowrap}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select),.wa-panel .wa-wb-page :where(input:not([type=checkbox]):not([type=radio]):not([type=file]),textarea,select){display:block;width:100%;min-width:0;max-width:100%;border:1px solid var(--wa-border);border-radius:6px;background:var(--wa-input-surface);color:var(--wa-ink);padding:8px 10px;font:13px/1.65 var(--wa-font-body);box-shadow:inset 0 1px 1px light-dark(#1a1b2003,#00000012);transition:border-color .13s,box-shadow .13s}
.wa-panel :is(.wa-input,.wa-select){min-height:36px}.wa-panel .wa-textarea{resize:vertical;min-height:100px;line-height:1.85}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select)::placeholder{color:var(--wa-faint);opacity:.8}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select):focus{border-color:var(--wa-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--wa-accent) 9%,transparent)}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select):disabled{background:var(--wa-subtle);color:var(--wa-muted);cursor:not-allowed;opacity:.65}
.wa-panel :is(.wa-input,.wa-textarea,.wa-select)[aria-invalid=true]{border-color:var(--wa-danger)}
.wa-panel :is(.wa-input,.wa-textarea)[readonly]{background:var(--wa-subtle)}
.wa-panel select{cursor:pointer}.wa-panel :is(option,optgroup){background:var(--wa-surface);color:var(--wa-ink)}
.wa-panel input:is([type=checkbox],[type=radio]){accent-color:var(--wa-accent);width:15px;height:15px;flex-shrink:0;vertical-align:middle}
.wa-panel input[type=file]{max-width:100%;font:12px/1.7 var(--wa-font-body);color:var(--wa-muted)}
.wa-panel input[type=file]::file-selector-button{padding:6px 10px;margin-right:10px;border:1px solid var(--wa-border);border-radius:6px;background:var(--wa-surface);color:var(--wa-ink);font:inherit;cursor:pointer}
.wa-panel .wa-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.wa-panel .wa-form-actions{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-top:24px;padding-top:16px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-form-actions>.wa-help{margin:0}.wa-panel .wa-dirty{display:inline-flex;align-items:center;gap:6px;color:var(--wa-warning);font-size:12px}
.wa-panel .wa-dirty::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.wa-panel :is(.wa-subsection,.wa-form-section,.wa-settings-form-section){padding-top:22px;margin-top:22px;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel :is(.wa-form-section,.wa-settings-form-section):first-child{margin-top:0;padding-top:0;border-top:0}
.wa-panel :is(.wa-form-section,.wa-settings-form-section)>h3{margin-bottom:16px}
.wa-panel .wa-toggle{display:inline-flex;align-items:center;gap:9px;cursor:pointer;font-size:12px;flex-shrink:0}
.wa-panel .wa-toggle input{appearance:none;width:32px;height:19px;border:1px solid var(--wa-border);border-radius:12px;background:var(--wa-border);position:relative;margin:0;cursor:pointer;transition:background .13s}
.wa-panel .wa-toggle input::before{content:'';width:13px;height:13px;position:absolute;top:2px;left:2px;border-radius:50%;background:var(--wa-surface);box-shadow:0 1px 2px #0002;transition:transform .13s}
.wa-panel .wa-toggle input:checked{background:var(--wa-accent);border-color:var(--wa-accent)}.wa-panel .wa-toggle input:checked::before{transform:translateX(13px);background:var(--wa-on-accent)}
.wa-panel .wa-toggle input:disabled{opacity:.5;cursor:not-allowed}

/* Status always retains a text label. */
.wa-panel :is(.wa-badge,.wa-wb-tag,.wa-task-badge){display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:2px 7px;border:1px solid var(--wa-border-soft);border-radius:5px;background:var(--wa-subtle);color:var(--wa-muted);font-size:11px;font-weight:450;line-height:1.6;white-space:nowrap;font-variant-numeric:tabular-nums}
.wa-panel :is(.wa-badge.is-success,.wa-task-badge.is-completed,.wa-task-badge.is-sent,.wa-wb-tag.is-passed,.wa-wb-tag.is-confirmed,.wa-wb-tag.is-sent,.wa-wb-tag.is-done){background:var(--wa-success-soft);color:var(--wa-success);border-color:transparent}
.wa-panel :is(.wa-badge.is-warn,.wa-task-badge.is-unknown,.wa-task-badge.is-partial,.wa-task-badge.is-settling,.wa-wb-tag.is-unknown,.wa-wb-tag.is-partial,.wa-wb-tag.is-draft){background:var(--wa-warning-soft);color:var(--wa-warning);border-color:transparent}
.wa-panel :is(.wa-badge.is-error,.wa-task-badge.is-failed,.wa-wb-tag.is-failed){background:var(--wa-danger-soft);color:var(--wa-danger);border-color:transparent}
.wa-panel :is(.wa-badge.is-accent,.wa-task-badge.is-running,.wa-task-badge.is-queued,.wa-wb-tag.is-running,.wa-wb-tag.is-queued,.wa-wb-tag.is-sending){background:var(--wa-info-soft);color:var(--wa-info);border-color:transparent}
.wa-panel :is(.wa-wb-tag.is-generating,.wa-wb-tag.is-submitting){background:var(--wa-info-soft);color:var(--wa-info);border-color:transparent}
.wa-panel .wa-wb-tag.is-published{background:var(--wa-success-soft);color:var(--wa-success);border-color:transparent}
.wa-panel .wa-wb-tag.is-interrupted{background:var(--wa-warning-soft);color:var(--wa-warning);border-color:transparent}
.wa-panel .wa-wb-tag.is-rejected{background:var(--wa-danger-soft);color:var(--wa-danger);border-color:transparent}
.wa-panel :is(.wa-badge-dot,.wa-status-dot){width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.wa-panel .wa-status-dot{color:var(--wa-faint)}.wa-panel .wa-status-dot.is-online{color:var(--wa-success)}
.wa-panel .wa-status-line{display:flex;align-items:center;gap:7px;font-size:12px}
.wa-panel .wa-alert{padding:11px 13px;margin-bottom:16px;border:1px solid color-mix(in srgb,var(--wa-warning) 20%,var(--wa-border-soft));border-radius:6px;background:var(--wa-warning-soft);color:var(--wa-warning);font-size:12px;line-height:1.8;overflow-wrap:anywhere}
.wa-panel .wa-alert.is-error{background:var(--wa-danger-soft);color:var(--wa-danger);border-color:color-mix(in srgb,var(--wa-danger) 18%,var(--wa-border-soft))}
.wa-panel .wa-alert.is-success{background:var(--wa-success-soft);color:var(--wa-success);border-color:color-mix(in srgb,var(--wa-success) 18%,var(--wa-border-soft))}
.wa-panel .wa-alert .wa-row{align-items:flex-start}.wa-panel .wa-alert svg{margin-top:3px}.wa-panel .wa-alert .wa-button{flex-shrink:0}
.wa-panel .wa-empty{min-height:210px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:36px 20px;text-align:center;background:transparent;border:0}
.wa-panel .wa-empty-icon{display:grid;place-items:center;width:36px;height:36px;margin-bottom:4px;color:var(--wa-faint)}
.wa-panel .wa-empty-icon svg{width:26px;height:26px;stroke-width:1.4}
.wa-panel .wa-empty h3{font-size:14px;font-weight:550}.wa-panel .wa-empty p{font-size:12px;color:var(--wa-muted);max-width:350px;line-height:1.85}
.wa-panel .wa-empty .wa-button{margin-top:8px}
.wa-panel .wa-loading-block{padding:28px 0;border-top:0}.wa-panel .wa-skeleton{height:12px;width:60%;background:var(--wa-subtle);border-radius:4px;margin-bottom:16px}
.wa-panel .wa-loading-block .wa-skeleton:first-child{height:22px;margin-bottom:30px}

/* Search, filters and section tabs are distinct controls. */
.wa-panel .wa-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.wa-panel .wa-search{position:relative;flex:1;min-width:160px;max-width:420px}
.wa-panel .wa-search>svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--wa-faint);pointer-events:none}
.wa-panel .wa-search .wa-input{padding-left:32px;padding-right:32px;min-height:34px;font-size:12px}
.wa-panel .wa-search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:23px;height:23px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--wa-muted)}
.wa-panel .wa-search-clear:hover{background:var(--wa-hover);color:var(--wa-ink)}
.wa-panel .wa-filters{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:6px;background:var(--wa-subtle);max-width:100%}
.wa-panel .wa-filter{border:1px solid transparent;border-radius:4px;padding:3px 10px;background:transparent;color:var(--wa-muted);font-size:12px;white-space:nowrap}
.wa-panel .wa-filter:hover{color:var(--wa-ink)}.wa-panel .wa-filter[aria-pressed=true]{background:var(--wa-surface);border-color:var(--wa-border-soft);color:var(--wa-ink);box-shadow:var(--wa-shadow)}
.wa-panel :is(.wa-tabs,.wa-wb-tabs,.wa-memory-tabs,.wa-task-tabs){display:flex;align-items:center;gap:22px;max-width:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;border:0;border-bottom:1px solid var(--wa-border-soft);padding:0;margin:0 0 24px;background:transparent;border-radius:0}
.wa-panel :is(.wa-tab,.wa-wb-tabs>button,.wa-memory-tabs>button,.wa-task-tabs>button){display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;position:relative;border:0;border-bottom:2px solid transparent;background:transparent;padding:9px 1px 10px;border-radius:0;color:var(--wa-muted);font-size:12px;white-space:nowrap;line-height:1.6}
.wa-panel :is(.wa-tab,.wa-wb-tabs>button,.wa-memory-tabs>button,.wa-task-tabs>button):hover{color:var(--wa-ink)}
.wa-panel :is(.wa-tab,.wa-wb-tabs>button,.wa-memory-tabs>button,.wa-task-tabs>button):is([aria-selected=true],[aria-pressed=true]){color:var(--wa-ink);border-bottom-color:var(--wa-ink);font-weight:600}
.wa-panel .wa-memory-tabs strong{font-weight:inherit}.wa-panel .wa-tab-count{padding:0 5px;background:var(--wa-subtle);border-radius:4px;color:var(--wa-muted);font-size:10px}
.wa-panel details{min-width:0}.wa-panel summary{cursor:pointer;font-size:12px;line-height:1.8;color:var(--wa-muted)}.wa-panel summary:hover{color:var(--wa-ink)}
.wa-panel details[open]>summary{margin-bottom:12px}.wa-panel .wa-data-details{padding-top:12px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-footer{padding-top:16px;margin-top:26px;border-top:1px solid var(--wa-border-soft);font-size:10px;color:var(--wa-muted)}
@keyframes wa-spin{to{transform:rotate(360deg)}}
@media(max-width:700px){.wa-panel .wa-page-head{gap:16px;flex-wrap:wrap;margin-bottom:22px}.wa-panel .wa-page-actions{padding-top:0;flex-shrink:1}.wa-panel .wa-form-grid{grid-template-columns:1fr}.wa-panel :is(.wa-between,.wa-wb-between){flex-wrap:wrap}}
@media(max-width:480px){.wa-panel h1{font-size:22px}.wa-panel .wa-page-heading-copy h1>svg{width:19px;height:19px}.wa-panel .wa-page-actions{gap:6px}.wa-panel .wa-button{min-height:36px}.wa-panel .wa-form-actions{gap:12px}.wa-panel .wa-form-actions>.wa-row{width:100%;justify-content:flex-end}.wa-panel .wa-search{min-width:140px}.wa-panel :is(.wa-tabs,.wa-wb-tabs,.wa-memory-tabs,.wa-task-tabs){gap:18px}.wa-panel .wa-alert .wa-between{gap:8px}}
@media(prefers-reduced-motion:reduce){.wa-panel *,.wa-panel *::before,.wa-panel *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.wa-panel[data-motion=off] *,.wa-panel[data-motion=off] *::before,.wa-panel[data-motion=off] *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
`;
