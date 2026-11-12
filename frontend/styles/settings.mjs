// Settings are documents, choices and lists. A border marks a change of context,
// rather than wrapping every setting in the same decorative card.
export const settingsCss = `
.wa-panel .wa-search-credentials>.wa-data-details{border-top:0;padding-top:0}
.wa-panel .wa-settings-sections{display:flex;flex-direction:column;gap:42px;max-width:1120px}
.wa-panel .wa-settings-section{display:grid;grid-template-columns:180px minmax(0,1fr);gap:32px;min-width:0}
.wa-panel .wa-settings-section-head{padding-top:17px}
.wa-panel .wa-settings-section-head h2{font-size:13px;font-weight:600;line-height:1.6}
.wa-panel .wa-settings-section-head p{font-size:12px;color:var(--wa-muted);line-height:1.75;margin-top:7px;max-width:170px}
.wa-panel .wa-settings-list{min-width:0;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-setting-link{width:100%;display:grid;grid-template-columns:21px minmax(0,1fr) minmax(0,180px) 14px;gap:13px;align-items:center;text-align:left;padding:17px 12px;border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;background:transparent;color:var(--wa-ink);box-shadow:none;transition:background .12s}
.wa-panel .wa-setting-link:hover{background:var(--wa-hover)}
.wa-panel .wa-setting-symbol{display:grid;place-items:center;color:var(--wa-muted)}
.wa-panel .wa-setting-symbol>svg{width:18px;height:18px}
.wa-panel .wa-setting-copy{min-width:0}
.wa-panel .wa-setting-copy h3{font-size:13px;font-weight:550;line-height:1.65;margin:0}
.wa-panel .wa-setting-copy p{font-size:12px;color:var(--wa-muted);line-height:1.65;margin:3px 0 0}
.wa-panel .wa-setting-value{font-size:12px;color:var(--wa-muted);text-align:right;overflow-wrap:anywhere;line-height:1.65}
.wa-panel .wa-setting-link>svg{color:var(--wa-faint);width:14px;height:14px}
.wa-panel .wa-settings-stack{display:flex;flex-direction:column;gap:32px;min-width:0}
.wa-panel .wa-settings-block,.wa-panel .wa-settings-document{min-width:0;padding:0;background:transparent;border:0;border-radius:0;box-shadow:none}
.wa-panel .wa-settings-stack>.wa-settings-block:not(:first-child),.wa-panel .wa-settings-document+.wa-settings-block{border-top:1px solid var(--wa-border-soft);padding-top:28px}
.wa-panel .wa-settings-document+.wa-settings-block{margin-top:30px}
.wa-panel :is(.wa-settings-block,.wa-settings-document)>.wa-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:22px}
.wa-panel :is(.wa-settings-block,.wa-settings-document)>.wa-card-heading h2{font-size:14px;line-height:1.6;font-weight:600}
.wa-panel :is(.wa-settings-block,.wa-settings-document)>.wa-card-heading p{font-size:12px;color:var(--wa-muted);margin-top:5px;line-height:1.75}
.wa-panel :is(.wa-settings-block,.wa-settings-document) .wa-subsection{margin-top:24px;padding-top:22px;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel :is(.wa-settings-block,.wa-settings-document) .wa-subsection>h2{font-size:14px;line-height:1.65;margin-bottom:17px}
.wa-panel :is(.wa-settings-block,.wa-settings-document) .wa-subsection>h3{font-size:13px;margin-bottom:12px}
.wa-panel :is(.wa-settings-block,.wa-settings-document) details>summary{font-size:12px;font-weight:550;color:var(--wa-ink);cursor:pointer;line-height:1.75}
.wa-panel :is(.wa-settings-block,.wa-settings-document) details[open]>summary{margin-bottom:18px}
.wa-panel .wa-data-details>p{font-size:12px;color:var(--wa-muted);line-height:1.9;margin-top:12px}
.wa-panel .wa-data-details>h3{font-size:13px;margin-top:22px}
.wa-panel .wa-data-details code{font:11px/1.7 var(--wa-font-mono);color:var(--wa-ink);background:var(--wa-subtle);padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}
.wa-panel :is(.wa-settings-document,.wa-settings-block) .wa-path-value{font:12px/1.9 var(--wa-font-mono);color:var(--wa-muted);background:var(--wa-subtle);padding:12px 14px;border:0;border-radius:5px;overflow-wrap:anywhere;white-space:pre-wrap}

/* A profile row and a full-width writing surface, with tools on its own edge. */
.wa-panel .wa-persona-studio{max-width:1080px}
.wa-panel .wa-editor-identity{padding:0 0 21px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:24px}
.wa-panel .wa-editor-identity>summary{display:flex;align-items:center;gap:13px;list-style:none}
.wa-panel .wa-editor-identity>summary::-webkit-details-marker{display:none}
.wa-panel .wa-editor-identity>summary>span:nth-child(2){display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}
.wa-panel .wa-editor-identity strong{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.wa-panel .wa-editor-identity small{font-size:12px;color:var(--wa-muted);font-weight:400}
.wa-panel .wa-editor-avatar{width:38px;height:38px;display:grid;place-items:center;flex-shrink:0;background:var(--wa-subtle);color:var(--wa-ink);border:1px solid var(--wa-border-soft);border-radius:50%;font-size:15px;font-weight:600}
.wa-panel .wa-editor-identity-action{font-size:12px;font-weight:400;color:var(--wa-muted);margin-left:auto}
.wa-panel .wa-editor-identity>summary::after{content:'';width:6px;height:6px;border-right:1px solid var(--wa-muted);border-bottom:1px solid var(--wa-muted);transform:rotate(45deg);margin:0 4px 3px 6px;flex-shrink:0}
.wa-panel .wa-editor-identity[open]>summary::after{transform:rotate(225deg);margin-top:5px}
.wa-panel .wa-editor-identity>.wa-form-grid{padding-top:6px;max-width:780px}
.wa-panel .wa-editor-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px}
.wa-panel .wa-editor-toolbar h2{font-size:13px;font-weight:600;line-height:1.6}
.wa-panel .wa-editor-toolbar p{font-size:12px;color:var(--wa-muted);margin-top:5px}
.wa-panel .wa-editor-loading{font-size:12px;color:var(--wa-muted);margin:0 0 14px}
.wa-panel :is(.wa-persona-manuscript,.wa-identity-manuscript) .wa-persona-editor{font-family:var(--wa-font-body);font-size:14px!important;line-height:1.95;letter-spacing:.01em;min-height:390px;background:var(--wa-surface);padding:24px;border:1px solid var(--wa-border);border-radius:7px;tab-size:2;resize:vertical}
.wa-panel .wa-identity-manuscript{max-width:1080px}
.wa-panel .wa-identity-manuscript .wa-persona-editor{min-height:440px}
.wa-panel .wa-identity-file .wa-button{margin-top:13px}
.wa-panel .wa-persona-manuscript>.wa-field>.wa-help,.wa-panel .wa-identity-manuscript>.wa-field>.wa-help{margin-top:10px;max-width:85ch}

/* Model choices keep the active connection separate from draft parameters. */
.wa-panel .wa-model-settings{max-width:970px}
.wa-panel .wa-model-settings>:is(.wa-model-card,.wa-model-parameters,.wa-model-prompt){display:grid;grid-template-columns:170px minmax(0,1fr);column-gap:30px;row-gap:16px;align-items:start}
.wa-panel .wa-model-settings>:is(.wa-model-card,.wa-model-parameters,.wa-model-prompt)>.wa-card-heading{grid-column:1;grid-row:1;margin:0;display:block}
.wa-panel .wa-model-settings>:is(.wa-model-card,.wa-model-parameters,.wa-model-prompt)>:not(.wa-card-heading){grid-column:2;min-width:0}
.wa-panel .wa-model-settings>:is(.wa-model-parameters,.wa-model-prompt)>.wa-form-actions{grid-column:1/-1;margin-top:4px}
.wa-panel .wa-model-parameters>.wa-form-grid{gap:16px}
.wa-panel .wa-model-parameters>.wa-form-grid>.wa-field{margin:0}
.wa-panel .wa-model-parameters>[data-testid=model-advanced]{margin-top:0!important}
.wa-panel .wa-model-picker{min-width:0}
.wa-panel .wa-model-picker>.wa-field{min-width:0}
.wa-panel .wa-model-picker>.wa-row{margin-top:16px}
.wa-panel .wa-model-picker>.wa-help{max-width:78ch}
.wa-panel .wa-model-settings [data-testid=model-advanced]>.wa-check-row{margin-top:24px;font-size:13px;font-weight:550}
.wa-panel .wa-model-settings [data-testid=model-advanced]>.wa-help{margin:7px 0 18px}
.wa-panel .wa-search-controls{display:flex;flex-direction:column;gap:16px;min-width:0;padding:1px 0 0 18px;border-left:2px solid var(--wa-border-soft);margin-top:14px}
.wa-panel .wa-search-controls>.wa-field{margin-bottom:0}
.wa-panel .wa-search-controls>.wa-help{font-size:12px;line-height:1.8;margin:0}
.wa-panel .wa-search-controls [data-testid=search-status]{padding-top:12px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-search-credentials .wa-credential-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start}
.wa-panel .wa-credential-form>.wa-field{margin:0}
.wa-panel .wa-credential-form>.wa-form-actions{margin:26px 0 0;padding:0;border:0;display:flex;justify-content:flex-end}
.wa-panel .wa-model-prompt textarea{min-height:135px;line-height:1.85}

/* Interfaces use a compact switchboard and a separate editing column. */
.wa-panel .wa-image-generation-settings{max-width:1130px}
.wa-panel .wa-image-provider-layout{display:grid;grid-template-columns:235px minmax(0,1fr);gap:30px;align-items:start;min-width:0}
.wa-panel .wa-image-switchboard{padding:18px;background:var(--wa-subtle);border-radius:7px;min-width:0}
.wa-panel .wa-image-switchboard>.wa-field{margin-bottom:22px}
.wa-panel .wa-image-switchboard>.wa-row{flex-direction:column;align-items:stretch;gap:6px;border-top:1px solid var(--wa-border);padding-top:16px}
.wa-panel .wa-image-switchboard .wa-button{justify-content:flex-start;text-align:left}
.wa-panel .wa-image-provider-editor{min-width:0}
.wa-panel .wa-image-provider-empty{min-height:225px;padding:34px 20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;color:var(--wa-muted)}
.wa-panel .wa-image-provider-empty>svg{width:25px;height:25px;margin-bottom:4px}
.wa-panel .wa-image-provider-empty h3{font-size:13px;font-weight:550;color:var(--wa-ink)}
.wa-panel .wa-image-provider-empty p{font-size:12px;line-height:1.8;max-width:35ch}
.wa-panel .wa-image-provider-editor>.wa-settings-form-section{padding-top:25px;margin-top:26px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-image-provider-editor>.wa-settings-form-section:first-child{padding-top:0;margin-top:0;border:0}
.wa-panel .wa-image-provider-editor>.wa-settings-form-section>h3{font-size:13px;font-weight:600;margin:0 0 18px}
.wa-panel .wa-image-provider-editor .wa-help{overflow-wrap:anywhere}
.wa-panel .wa-image-credentials{padding-left:265px!important}
.wa-panel .wa-image-credentials>.wa-card-heading{align-items:center}
.wa-panel .wa-image-generation-settings .wa-form-actions{gap:18px}

/* A roster, not a wall of selectable cards. */
.wa-panel .wa-admin-settings{max-width:1080px}
.wa-panel .wa-admin-picker{display:flex;flex-direction:column;gap:18px;min-width:0;margin:18px 0 24px}
.wa-panel .wa-admin-search-fields{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(0,1.5fr);gap:16px;align-items:end}
.wa-panel .wa-admin-search-fields.is-conversation{grid-template-columns:minmax(0,1fr)}
.wa-panel .wa-admin-search-fields .wa-field{margin:0;min-width:0}
.wa-panel .wa-admin-search-row{display:flex;align-items:center;gap:8px;min-width:0}
.wa-panel .wa-admin-search-row>.wa-button{flex-shrink:0}
.wa-panel .wa-admin-search-input{position:relative;min-width:0;flex:1}
.wa-panel .wa-admin-search-input>svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--wa-muted);pointer-events:none;width:15px;height:15px}
.wa-panel .wa-admin-search-input>.wa-input{padding-left:34px}
.wa-panel .wa-admin-picker>.wa-alert{margin:0}
.wa-panel .wa-admin-selection-grid{display:grid;grid-template-columns:minmax(0,1fr) 235px;gap:24px;align-items:start;min-width:0}
.wa-panel .wa-admin-candidate-pane,.wa-panel .wa-admin-candidates{min-width:0}
.wa-panel .wa-admin-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;margin-bottom:12px}
.wa-panel .wa-admin-section-head h3{font-size:12px;font-weight:550;line-height:1.6;margin:0}
.wa-panel .wa-admin-section-head .wa-help{margin:0!important;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-admin-candidate-list{max-height:292px;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--wa-border);border-radius:6px;background:var(--wa-surface)}
.wa-panel .wa-admin-candidate{display:grid;grid-template-columns:16px 29px minmax(0,1fr);gap:10px;align-items:center;padding:10px 12px;cursor:pointer;min-width:0;border-bottom:1px solid var(--wa-border-soft);background:transparent}
.wa-panel .wa-admin-candidate:last-child{border-bottom:0}
.wa-panel .wa-admin-candidate:hover{background:var(--wa-hover)}
.wa-panel .wa-admin-candidate.is-selected{background:var(--wa-subtle)}
.wa-panel .wa-admin-candidate:has(input:focus-visible){outline:2px solid var(--wa-accent);outline-offset:-2px}
.wa-panel .wa-admin-candidate:has(input:disabled){cursor:default}
.wa-panel .wa-admin-candidate>input{accent-color:var(--wa-accent);width:15px;height:15px;flex-shrink:0;margin:0}
.wa-panel .wa-admin-avatar{width:29px;height:29px;display:grid;place-items:center;border-radius:50%;background:var(--wa-hover);color:var(--wa-muted);font-size:10px;font-weight:600}
.wa-panel .wa-admin-candidate-copy{display:block;min-width:0;overflow-wrap:anywhere;font-size:12px;line-height:1.55}
.wa-panel .wa-admin-candidate-copy>strong{font-weight:550}
.wa-panel .wa-admin-remark{color:var(--wa-muted);margin-left:8px;font-size:11px}
.wa-panel .wa-admin-candidate-copy>small{display:block;color:var(--wa-muted);font:10px/1.65 var(--wa-font-mono);margin-top:3px}
.wa-panel .wa-admin-empty{display:flex;align-items:center;justify-content:center;gap:10px;padding:28px 18px;color:var(--wa-muted);font-size:12px;line-height:1.8;min-height:120px}
.wa-panel .wa-admin-empty>svg{color:var(--wa-faint);width:20px;height:20px}
.wa-panel .wa-admin-list-note{padding:12px;color:var(--wa-muted);font-size:11px;line-height:1.8}
.wa-panel .wa-admin-manual{margin-top:12px;max-width:100%;overflow-wrap:anywhere}
.wa-panel .wa-admin-selected{min-width:0;border-left:1px solid var(--wa-border-soft);padding-left:24px}
.wa-panel .wa-admin-selected>.wa-help{font-size:11px;margin:0 0 12px!important}
.wa-panel .wa-admin-selected-list{display:flex;flex-direction:column;min-width:0;max-height:292px;overflow:auto;overscroll-behavior:contain}
.wa-panel .wa-button.wa-admin-chip{gap:10px;padding:10px 0;width:100%;max-width:100%;text-align:left;justify-content:space-between;border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;background:transparent;box-shadow:none}
.wa-panel .wa-button.wa-admin-chip:hover:not(:disabled){background:var(--wa-hover);color:var(--wa-ink)}
.wa-panel .wa-admin-chip>span{display:block;min-width:0;overflow-wrap:anywhere}
.wa-panel .wa-admin-chip strong{display:block;font-size:12px;font-weight:500;line-height:1.7}
.wa-panel .wa-admin-chip small{display:block;font-size:10px;color:var(--wa-muted);font-family:var(--wa-font-mono);font-weight:400}
.wa-panel .wa-admin-chip>svg{color:var(--wa-muted);width:13px;height:13px}
.wa-panel .wa-admin-selection-empty{color:var(--wa-muted);font-size:12px;padding:13px 0;line-height:1.8}
.wa-panel .wa-room-picker{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:9px;min-width:0}
.wa-panel .wa-room-picker-search{position:relative;min-width:0}
.wa-panel .wa-room-picker-search>svg{position:absolute;top:50%;left:11px;transform:translateY(-50%);color:var(--wa-muted);pointer-events:none}
.wa-panel .wa-room-picker-search>.wa-input{padding-left:34px}

/* Conversation rows read as a directory with a shared column rhythm. */
.wa-panel .wa-auth-toggle{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid var(--wa-border-soft);padding:0 0 22px;margin-bottom:24px;min-width:0;background:transparent;border-radius:0}
.wa-panel .wa-toggle-copy h3{font-size:13px;font-weight:550;margin:0}
.wa-panel .wa-toggle-copy p{font-size:12px;line-height:1.8;color:var(--wa-muted);margin-top:5px}
.wa-panel .wa-auth-toggle .wa-toggle{flex-shrink:0}
.wa-panel .wa-authorization-results>.wa-toolbar{margin-bottom:14px}
.wa-panel .wa-authorization-scope{margin-bottom:12px}
.wa-panel .wa-authorization-selection{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;margin-bottom:12px;min-width:0}
.wa-panel .wa-authorization-select-all{display:flex;align-items:center;gap:8px;min-height:32px;font-size:12px;white-space:nowrap;cursor:pointer}
.wa-panel .wa-authorization-selection>.wa-help{font-size:11px;overflow-wrap:anywhere}
.wa-panel .wa-authorization-selection>.wa-row{margin-left:auto;gap:6px}
.wa-panel .wa-authorization-selection .wa-button{font-size:12px}
.wa-panel .wa-session-list{min-width:0;border-top:1px solid var(--wa-border);border-bottom:1px solid var(--wa-border);border-radius:0;overflow:hidden;background:transparent}
.wa-panel .wa-session-columns{display:flex;justify-content:space-between;gap:18px;padding:9px 12px;font-size:11px;line-height:1.6;color:var(--wa-muted);background:var(--wa-subtle);border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-session-row{display:grid;grid-template-columns:35px minmax(0,1fr) auto;gap:12px;align-items:center;padding:14px 12px;min-width:0;border-bottom:1px solid var(--wa-border-soft);background:transparent}
.wa-panel .wa-session-row.has-selection{grid-template-columns:24px 35px minmax(0,1fr) auto}
.wa-panel .wa-session-select{display:grid;place-items:center;min-height:32px;cursor:pointer}
.wa-panel .wa-session-select>input{margin:0}
.wa-panel .wa-session-row[data-selected=true]{background:var(--wa-accent-soft)}
.wa-panel .wa-session-row:last-child{border-bottom:0}
.wa-panel .wa-session-row:hover{background:var(--wa-subtle)}
.wa-panel .wa-session-avatar{display:grid;place-items:center;width:35px;height:35px;background:var(--wa-hover);color:var(--wa-muted);border:0;border-radius:50%;font-size:11px;font-weight:550;flex-shrink:0}
.wa-panel .wa-session-avatar.is-group{border-radius:7px;color:var(--wa-ink)}
.wa-panel .wa-session-info{min-width:0}
.wa-panel .wa-session-title{font-size:13px;font-weight:550;line-height:1.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wa-panel .wa-session-meta{display:flex;gap:8px;align-items:center;color:var(--wa-muted);font-size:11px;line-height:1.7;margin-top:3px;min-width:0;overflow:hidden}
.wa-panel .wa-session-meta>span{white-space:nowrap}
.wa-panel .wa-session-meta .wa-mono{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wa-panel .wa-session-actions{display:flex;align-items:center;gap:7px;min-width:0}
.wa-panel .wa-session-actions>.wa-badge{margin-right:8px;font-size:10px;white-space:nowrap}
.wa-panel .wa-session-actions>.wa-button{min-height:30px;padding:5px 10px;font-size:11px!important}
.wa-panel .wa-session-actions>.wa-icon-button{width:28px;height:28px;padding:5px}
.wa-panel .wa-authorization-results>.wa-help{margin-top:10px!important;font-size:11px}
.wa-panel .wa-name-add{display:grid;grid-template-columns:170px minmax(0,1fr);gap:28px;border-top:1px solid var(--wa-border-soft);padding-top:26px;margin-top:30px;min-width:0}
.wa-panel .wa-name-add-heading h3{font-size:13px;font-weight:550}
.wa-panel .wa-name-add-heading>.wa-help{font-size:12px;margin-top:7px}
.wa-panel .wa-name-add-controls{min-width:0}
.wa-panel .wa-name-add-controls>.wa-row{margin-top:0!important;flex-wrap:nowrap;gap:8px}
.wa-panel .wa-name-add-controls>.wa-row>.wa-select{width:115px;flex:0 0 115px}
.wa-panel .wa-name-add-controls>.wa-row>.wa-input{flex:1;min-width:0}
.wa-panel .wa-name-suggestions{margin-top:12px;border-top:1px solid var(--wa-border-soft)}

/* Conversation policy is one readable document, ordered around participation. */
.wa-panel .wa-conversation-settings{max-width:1080px}
.wa-panel .wa-conversation-identity{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 0 23px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-detail-title{display:flex;align-items:center;gap:12px;min-width:0}
.wa-panel .wa-detail-title>div:last-child{min-width:0}
.wa-panel .wa-detail-title h2{font-size:15px;font-weight:600;overflow-wrap:anywhere;line-height:1.65}
.wa-panel .wa-detail-title p{font-size:12px;color:var(--wa-muted);margin-top:3px}
.wa-panel .wa-conversation-settings .wa-subsection>h2{font-size:13px;font-weight:600}
.wa-panel .wa-conversation-persona-link{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:22px}
.wa-panel .wa-conversation-persona-link>div{min-width:0}
.wa-panel .wa-conversation-persona-link h2{margin:0!important}
.wa-panel .wa-conversation-persona-link .wa-button{flex-shrink:0}
.wa-panel .wa-mode-fieldset{padding:0;margin:24px 0;border:0;min-width:0}
.wa-panel .wa-mode-fieldset>legend{font-size:13px;font-weight:600;margin-bottom:14px;padding:0}
.wa-panel .wa-radio-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-mode-option{display:flex;align-items:flex-start;gap:11px;padding:17px 16px 17px 10px;border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;background:transparent;min-width:0;cursor:pointer}
.wa-panel .wa-mode-option:hover{background:var(--wa-hover)}
.wa-panel .wa-mode-option:has(input:checked){background:var(--wa-subtle)}
.wa-panel .wa-mode-option:has(input:focus-visible){outline:2px solid var(--wa-accent);outline-offset:-2px}
.wa-panel .wa-mode-option>input{width:15px;height:15px;margin:3px 0 0;accent-color:var(--wa-accent);flex-shrink:0}
.wa-panel .wa-mode-option>span{min-width:0}
.wa-panel .wa-mode-option strong{display:block;font-size:13px;font-weight:550;line-height:1.6}
.wa-panel .wa-mode-option small{display:block;font-size:12px;line-height:1.85;color:var(--wa-muted);margin-top:5px}
.wa-panel .wa-number-range{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:15px 0 10px;font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-number-range>.wa-input{width:84px;min-width:60px;padding:7px 10px;font-variant-numeric:tabular-nums}
.wa-panel .wa-conversation-settings .wa-check-label{display:flex;align-items:center;gap:9px;font-size:13px;line-height:1.8;cursor:pointer}
.wa-panel .wa-conversation-settings .wa-check-label>input{width:15px;height:15px;margin:0;accent-color:var(--wa-accent)}
.wa-panel .wa-conversation-settings .wa-mode-guide{margin-top:16px;font-size:12px}
.wa-panel .wa-conversation-settings .wa-mode-guide .wa-button{margin-top:13px}
.wa-panel .wa-natural-settings{padding:22px 0 0;min-width:0}
.wa-panel .wa-natural-settings>.wa-help{margin-bottom:18px}
.wa-panel .wa-natural-basics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;max-width:900px}
.wa-panel .wa-natural-basics>.wa-field{margin:0}
.wa-panel .wa-natural-limits{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.wa-panel .wa-natural-limits>.wa-field{margin:0}
.wa-panel .wa-natural-settings>.wa-field{max-width:700px}
.wa-panel .wa-natural-settings>.wa-form-grid{margin-top:15px;max-width:700px}
.wa-panel .wa-natural-settings>.wa-check-row{margin-top:22px}
.wa-panel .wa-natural-settings [data-testid=natural-chat-status]{margin-top:22px}
.wa-panel .wa-conversation-permissions .wa-admin-picker{margin-top:20px}
.wa-panel .wa-conversation-settings .wa-note-box .wa-field{margin-top:18px}
.wa-panel .wa-conversation-settings>.wa-between{padding:18px 0;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-storage-path-list{margin:16px 0 0;padding:0}
.wa-panel .wa-storage-path-list>div{display:grid;grid-template-columns:150px minmax(0,1fr);gap:18px;align-items:start;padding:11px 0;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-storage-path-list>div:last-child{border-bottom:0}
.wa-panel .wa-storage-path-list dt{font-size:12px;color:var(--wa-muted);padding-top:6px;line-height:1.7}
.wa-panel .wa-storage-path-list dd.wa-path-value{margin:0;background:transparent;padding:4px 0;color:var(--wa-ink);font-size:11px}
.wa-panel .wa-changelog{font-size:13px;line-height:1.95;max-width:840px;overflow-wrap:anywhere;padding:0}
.wa-panel .wa-changelog>h2{font-size:18px;font-weight:600;letter-spacing:-.02em;line-height:1.6;margin:38px 0 16px;padding-top:28px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-changelog>h2:first-child{padding-top:0;margin-top:0;border:0}
.wa-panel .wa-changelog>h3{font-size:14px;font-weight:600;margin:24px 0 12px}
.wa-panel .wa-changelog>p{font-size:13px;color:var(--wa-muted);margin:14px 0;white-space:pre-wrap}
.wa-panel .wa-changelog>ul{margin:14px 0;padding-left:20px}
.wa-panel .wa-changelog li{margin:10px 0;padding-left:5px;color:var(--wa-muted)}

/* Checks use one aligned results table; recovery uses an inbox and a reply sheet. */
.wa-panel .wa-diagnostics-summary{display:flex;align-items:center;gap:35px;padding:0 0 20px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:5px}
.wa-panel .wa-diagnostics-summary>div{display:flex;flex-direction:column;gap:5px;min-width:0}
.wa-panel .wa-diagnostics-summary span:not(.wa-wb-tag){font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-diagnostics-summary strong{font-size:12px;font-weight:500;line-height:1.7;overflow-wrap:anywhere}
.wa-panel .wa-diagnostics-summary>.wa-wb-tag{margin-left:auto}
.wa-panel .wa-diagnostics-list{display:flex;flex-direction:column;margin-bottom:18px;min-width:0}
.wa-panel .wa-diagnostics-row{display:grid;grid-template-columns:25px minmax(0,1fr) 155px;gap:16px;align-items:start;padding:23px 0;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-diagnostics-mark{display:grid;place-items:center;width:25px;height:25px;color:var(--wa-muted);margin-top:1px}
.wa-panel .wa-diagnostics-mark>svg{width:19px;height:19px}
.wa-panel .wa-diagnostics-row[data-state=passed] .wa-diagnostics-mark{color:var(--wa-success)}
.wa-panel .wa-diagnostics-row[data-state=failed] .wa-diagnostics-mark{color:var(--wa-danger)}
.wa-panel .wa-diagnostics-content{min-width:0}
.wa-panel .wa-diagnostics-content>.wa-wb-between{justify-content:flex-start;gap:12px}
.wa-panel .wa-diagnostics-content h2{font-size:13px;font-weight:600;line-height:1.8}
.wa-panel .wa-diagnostics-content>p{font-size:12px;line-height:1.85;color:var(--wa-muted);margin-top:7px;overflow-wrap:anywhere}
.wa-panel .wa-diagnostics-row>footer{display:flex;flex-direction:column;align-items:flex-end;gap:7px;font-size:11px;line-height:1.8;color:var(--wa-muted)}
.wa-panel .wa-diagnostics-row>footer .wa-wb-button{min-height:28px;padding:3px 8px;font-size:11px}
.wa-panel .wa-recovery-layout{grid-template-columns:minmax(220px,.8fr) minmax(0,1.6fr);gap:28px;align-items:start}
.wa-panel .wa-recovery-layout.is-empty{grid-template-columns:minmax(0,1fr)}
.wa-panel .wa-recovery-layout>.wa-wb-list{border-top:1px solid var(--wa-border-soft);border-right:0;padding-right:0;min-width:0}
.wa-panel .wa-recovery-page .wa-wb-recovery-row{padding:8px 0;border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;background:transparent;min-width:0}
.wa-panel .wa-recovery-page .wa-wb-recovery-row.is-selected{background:var(--wa-subtle)}
.wa-panel .wa-recovery-page .wa-wb-list-item{display:block;width:100%;border:0;border-radius:0;background:transparent;padding:10px 12px;text-align:left;box-shadow:none;color:var(--wa-ink);min-width:0}
.wa-panel .wa-recovery-page .wa-wb-list-item:hover{background:var(--wa-hover)}
.wa-panel .wa-recovery-page .wa-wb-list-item strong{font-size:12px;font-weight:600;overflow-wrap:anywhere}
.wa-panel .wa-recovery-page .wa-wb-list-item>p{font-size:12px;line-height:1.8;color:var(--wa-muted);margin:6px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.wa-panel .wa-recovery-page .wa-wb-list-item>small{font-size:10px;color:var(--wa-muted)}
.wa-panel .wa-recovery-page .wa-wb-recovery-row>.wa-wb-actions{padding:0 10px 3px;justify-content:flex-end}
.wa-panel .wa-recovery-page .wa-wb-recovery-row>.wa-wb-actions .wa-wb-button{min-height:25px;padding:2px 6px;font-size:11px}
.wa-panel .wa-recovery-detail{min-width:0}
.wa-panel .wa-recovery-sheet{min-width:0;padding:0 0 0 28px;border-left:1px solid var(--wa-border-soft);background:transparent;border-radius:0}
.wa-panel .wa-recovery-sheet>.wa-wb-between h2{font-size:15px;font-weight:600;overflow-wrap:anywhere}
.wa-panel .wa-recovery-sheet>.wa-wb-note{margin-top:9px}
.wa-panel .wa-recovery-sheet .wa-wb-paper{padding:18px 20px;margin:20px 0;background:var(--wa-subtle);border:0;border-left:2px solid var(--wa-border);border-radius:0;font-size:13px;line-height:1.95;overflow-wrap:anywhere;white-space:pre-wrap;min-width:0}
.wa-panel .wa-recovery-sheet .wa-wb-paper>small{display:block;font-size:11px;color:var(--wa-muted);margin-bottom:10px}
.wa-panel .wa-recovery-sheet .wa-wb-parts{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 20px;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-recovery-sheet .wa-wb-parts>span{padding:4px 8px;border:1px solid var(--wa-border-soft);border-radius:4px;background:transparent}
.wa-panel .wa-recovery-prepare{padding-top:18px;margin-top:18px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-recovery-options{font-size:12px;color:var(--wa-muted)}
.wa-panel .wa-recovery-options>summary{cursor:pointer;line-height:1.8}
.wa-panel .wa-recovery-options[open]>.wa-wb-actions{margin-top:12px}
.wa-panel .wa-recovery-sheet>.wa-wb-review{margin-top:24px;padding:20px;border:1px solid var(--wa-border);border-radius:6px;background:var(--wa-surface);min-width:0}
.wa-panel .wa-recovery-sheet>.wa-wb-review h3{font-size:13px}
.wa-panel .wa-recovery-sheet>.wa-wb-review>p{font-size:12px;line-height:1.8;margin-top:12px}
.wa-panel .wa-recovery-sheet>.wa-wb-review>.wa-wb-actions{margin-top:18px}
.wa-panel .wa-recovery-history{margin-top:32px;border-top:1px solid var(--wa-border-soft);padding-top:22px}
.wa-panel .wa-recovery-history>summary{font-size:13px;font-weight:550;cursor:pointer}
.wa-panel .wa-recovery-history[open]>summary{margin-bottom:18px}
.wa-panel .wa-recovery-history .wa-wb-history-row{display:grid;grid-template-columns:130px minmax(0,1fr) auto auto;gap:14px;align-items:center;border-bottom:1px solid var(--wa-border-soft);padding:13px 0;min-width:0;font-size:12px;line-height:1.8}
.wa-panel .wa-recovery-history .wa-wb-history-row>span{min-width:0;overflow-wrap:anywhere}
.wa-panel .wa-recovery-history .wa-wb-history-row>span:first-child{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-recovery-confirm{margin-top:22px;border:1px solid color-mix(in srgb,var(--wa-danger) 25%,var(--wa-border));border-left:3px solid var(--wa-danger);border-radius:4px;background:var(--wa-danger-soft);padding:20px}
.wa-panel .wa-recovery-confirm h3{font-size:13px;line-height:1.8;overflow-wrap:anywhere}
.wa-panel .wa-recovery-confirm p{font-size:12px;line-height:1.9;margin-top:10px}
.wa-panel .wa-recovery-confirm>.wa-wb-actions{margin-top:18px}

@media(max-width:1050px){
 .wa-panel .wa-settings-section{grid-template-columns:150px minmax(0,1fr);gap:24px}
 .wa-panel .wa-setting-link{grid-template-columns:20px minmax(0,1fr) minmax(0,135px) 14px}
 .wa-panel .wa-image-provider-layout{grid-template-columns:205px minmax(0,1fr);gap:24px}
 .wa-panel .wa-image-credentials{padding-left:229px!important}
 .wa-panel .wa-admin-selection-grid{grid-template-columns:minmax(0,1fr) 190px;gap:18px}
 .wa-panel .wa-admin-selected{padding-left:18px}
}
@media(max-width:800px){
 .wa-panel .wa-model-settings>:is(.wa-model-card,.wa-model-parameters,.wa-model-prompt){grid-template-columns:minmax(0,1fr);row-gap:16px}
 .wa-panel .wa-model-settings>:is(.wa-model-card,.wa-model-parameters,.wa-model-prompt)>:not(.wa-card-heading){grid-column:1}
 .wa-panel .wa-settings-section{grid-template-columns:minmax(0,1fr);gap:12px}
 .wa-panel .wa-settings-section-head{padding:0;display:flex;align-items:baseline;gap:15px;flex-wrap:wrap}
 .wa-panel .wa-settings-section-head p{margin:0;max-width:none}
 .wa-panel .wa-settings-sections{gap:28px}
 .wa-panel .wa-image-provider-layout{grid-template-columns:minmax(0,1fr);gap:24px}
 .wa-panel .wa-image-switchboard{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;padding:16px}
 .wa-panel .wa-image-switchboard>.wa-field{margin:0}
 .wa-panel .wa-image-switchboard>.wa-row{grid-column:1/-1;flex-direction:row;flex-wrap:wrap;justify-content:flex-start;padding-top:12px}
 .wa-panel .wa-image-credentials{padding-left:0!important}
 .wa-panel .wa-admin-selection-grid{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-admin-selected{border-left:0;border-top:1px solid var(--wa-border-soft);padding:18px 0 0}
 .wa-panel .wa-admin-selected-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;max-height:190px}
 .wa-panel .wa-admin-search-fields{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-recovery-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:22px}
 .wa-panel .wa-recovery-layout>.wa-wb-list{max-height:none;overflow:visible;margin:0;padding-bottom:0;border-bottom:0}
 .wa-panel .wa-recovery-sheet{border-left:0;border-top:0;padding:0}
}
@media(max-width:640px){
 .wa-panel .wa-setting-link{grid-template-columns:19px minmax(0,1fr) 13px;gap:4px 11px;padding:15px 3px}
 .wa-panel .wa-setting-symbol{grid-column:1;grid-row:1;align-self:start;margin-top:3px}
 .wa-panel .wa-setting-copy{grid-column:2;grid-row:1}
 .wa-panel .wa-setting-value{grid-column:2;grid-row:2;text-align:left;font-size:11px}
 .wa-panel .wa-setting-value:empty{display:none}
 .wa-panel .wa-setting-link>svg{grid-column:3;grid-row:1;align-self:center}
 .wa-panel .wa-editor-identity-action{max-width:72px;line-height:1.7;font-size:11px}
 .wa-panel :is(.wa-persona-manuscript,.wa-identity-manuscript) .wa-persona-editor{padding:16px;min-height:360px;font-size:13px!important}
 .wa-panel .wa-model-picker>.wa-field{display:block}
 .wa-panel .wa-model-picker>.wa-field>.wa-field-label{padding:0;margin-bottom:8px}
 .wa-panel .wa-model-picker>.wa-field>.wa-help{margin-top:8px}
 .wa-panel .wa-search-credentials .wa-credential-form{grid-template-columns:minmax(0,1fr);gap:12px}
 .wa-panel .wa-credential-form>.wa-form-actions{margin:0}
 .wa-panel .wa-room-picker{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-auth-toggle{gap:14px;align-items:flex-start}
 .wa-panel .wa-auth-toggle .wa-toggle{padding-top:2px}
 .wa-panel .wa-auth-toggle .wa-toggle>span{display:none}
 .wa-panel .wa-session-row{grid-template-columns:30px minmax(0,1fr);gap:6px 10px;padding:13px 5px}
 .wa-panel .wa-session-row.has-selection{grid-template-columns:24px 30px minmax(0,1fr)}
 .wa-panel .wa-session-select{grid-column:1;grid-row:1/3;align-self:start;margin-top:3px}
 .wa-panel .wa-session-row.has-selection>.wa-session-avatar{grid-column:2}
 .wa-panel .wa-session-row.has-selection>.wa-session-info,.wa-panel .wa-session-row.has-selection>.wa-session-actions{grid-column:3}
 .wa-panel .wa-authorization-selection>.wa-row{width:100%;justify-content:flex-end}
 .wa-panel .wa-session-avatar{grid-column:1;grid-row:1;width:30px;height:30px;font-size:10px;align-self:start;margin-top:4px}
 .wa-panel .wa-session-info{grid-column:2;grid-row:1}
 .wa-panel .wa-session-actions{grid-column:2;grid-row:2;justify-content:flex-start;flex-wrap:wrap;gap:6px;margin-top:3px}
 .wa-panel .wa-session-columns{padding:8px 5px}
 .wa-panel .wa-name-add{grid-template-columns:minmax(0,1fr);gap:14px;margin-top:24px;padding-top:22px}
 .wa-panel .wa-conversation-persona-link{flex-direction:column;align-items:flex-start;gap:12px}
 .wa-panel .wa-radio-list{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-natural-basics,.wa-panel .wa-natural-limits{grid-template-columns:minmax(0,1fr);gap:20px}
 .wa-panel .wa-mode-option{padding:14px 9px}
 .wa-panel .wa-storage-path-list>div{grid-template-columns:minmax(0,1fr);gap:3px;padding:10px 0}
 .wa-panel .wa-storage-path-list dt{padding:0}
 .wa-panel .wa-diagnostics-summary{gap:16px 24px;flex-wrap:wrap}
 .wa-panel .wa-diagnostics-summary>.wa-wb-tag{margin-left:0}
 .wa-panel .wa-diagnostics-row{grid-template-columns:22px minmax(0,1fr);gap:8px 12px;padding:19px 0}
 .wa-panel .wa-diagnostics-row>footer{grid-column:2;flex-direction:row;justify-content:space-between;align-items:center;gap:12px}
 .wa-panel .wa-diagnostics-content>.wa-wb-between{gap:8px;flex-wrap:wrap}
 .wa-panel .wa-recovery-history .wa-wb-history-row{grid-template-columns:minmax(0,1fr) auto;gap:7px 12px}
 .wa-panel .wa-recovery-history .wa-wb-history-row>span:nth-child(2){grid-column:1;grid-row:2}
 .wa-panel .wa-recovery-history .wa-wb-history-row>.wa-wb-tag{grid-column:2;grid-row:1}
 .wa-panel .wa-recovery-history .wa-wb-history-row>.wa-wb-button{grid-column:2;grid-row:2}
}
@media(max-width:420px){
 .wa-panel .wa-editor-identity>summary{display:grid;grid-template-columns:38px minmax(0,1fr) 10px;gap:7px 10px}
 .wa-panel .wa-editor-identity>summary>.wa-editor-avatar{grid-column:1;grid-row:1/3}
 .wa-panel .wa-editor-identity>summary>span:nth-child(2){grid-column:2;grid-row:1}
 .wa-panel .wa-editor-identity-action{grid-column:2;grid-row:2;margin:0;max-width:none}
 .wa-panel .wa-editor-identity>summary::after{grid-column:3;grid-row:1/3;margin:0}
 .wa-panel .wa-image-switchboard{grid-template-columns:minmax(0,1fr);gap:15px}
 .wa-panel .wa-admin-search-row{flex-wrap:wrap}
 .wa-panel .wa-admin-search-input{flex-basis:100%}
 .wa-panel .wa-admin-search-row>.wa-button{margin-left:auto}
 .wa-panel .wa-admin-selected-list{grid-template-columns:minmax(0,1fr)}
 .wa-panel .wa-admin-candidate{grid-template-columns:15px 25px minmax(0,1fr);gap:8px;padding:9px}
 .wa-panel .wa-admin-avatar{width:25px;height:25px;font-size:9px}
 .wa-panel .wa-name-add-controls>.wa-row{flex-wrap:wrap}
 .wa-panel .wa-name-add-controls>.wa-row>.wa-select{width:100%;flex-basis:100%}
 .wa-panel .wa-conversation-identity{align-items:flex-start}
 .wa-panel .wa-recovery-sheet .wa-wb-paper{padding:14px 13px}
 .wa-panel .wa-recovery-sheet>.wa-wb-review{padding:16px 13px}
 .wa-panel .wa-editor-toolbar{align-items:flex-start}
}
.wa-panel .wa-time-fields{border:0;padding:0;margin:18px 0;min-width:0}
.wa-panel .wa-time-group{border:1px solid var(--wa-border);border-radius:12px;margin-top:12px;overflow:hidden}
.wa-panel .wa-time-group>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;cursor:pointer;font-weight:600}
.wa-panel .wa-time-group>summary small{font-weight:400;color:var(--wa-muted);white-space:nowrap}
.wa-panel .wa-time-group>summary>span:first-child{min-width:0;flex:1}
.wa-panel .wa-time-group-meta{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px 12px;min-width:0}
.wa-panel .wa-time-group>.wa-settings-block{margin:0;padding:0 20px 20px;border:0;border-radius:0}
.wa-panel .wa-automation-master{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px;border:1px solid var(--wa-border);border-radius:12px}
.wa-panel .wa-automation-master>div{min-width:0;flex:1}
.wa-panel .wa-automation-master h2{margin:0 0 8px}
.wa-panel .wa-automation-master .wa-help{margin:0}
.wa-panel .wa-automation-master>.wa-toggle{flex-shrink:0}
.wa-panel .wa-automation-group{margin-top:12px;border:1px solid var(--wa-border);border-radius:12px;min-width:0}
.wa-panel .wa-automation-group>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;cursor:pointer;list-style:none}
.wa-panel .wa-automation-group>summary::-webkit-details-marker{display:none}
.wa-panel .wa-automation-group>summary>span{min-width:0}
.wa-panel .wa-automation-group>summary strong,.wa-panel .wa-automation-group>summary small{display:block}
.wa-panel .wa-automation-group>summary small{margin-top:4px;color:var(--wa-muted);font-weight:400}
.wa-panel .wa-automation-group[open]>summary>svg{transform:rotate(90deg)}
.wa-panel .wa-automation-group-body{padding:0 20px 20px;min-width:0}
.wa-panel .wa-automation-group-body>.wa-settings-block{margin:0;padding:0;border:0;border-radius:0}
.wa-panel .wa-automation-group-body .wa-moments-schedule{margin:0}
.wa-panel .wa-automation-fields{border:0;padding:0;margin:16px 0;min-width:0}
.wa-panel .wa-automation-fields>.wa-check-row{margin-bottom:12px}
.wa-panel .wa-automation-settings label:is(.wa-check-row,.wa-row,.wa-toggle){flex-direction:row;align-items:center}
.wa-panel .wa-automation-group .wa-form-actions{flex-wrap:wrap}
@media(max-width:600px){
 .wa-panel .wa-automation-master{flex-wrap:wrap;padding:16px}
 .wa-panel .wa-automation-master>div{flex-basis:100%}
 .wa-panel .wa-automation-group>summary{padding:16px}
 .wa-panel .wa-automation-group-body{padding:0 16px 16px}
}
`;
