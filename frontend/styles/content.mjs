// Content surfaces: records read as a ledger, memories as documents, and media as a gallery.
export const contentCss = `
/* Shared document structure within memory and media. */
.wa-panel .wa-document-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin:0 0 18px;min-width:0}
.wa-panel .wa-document-heading>div{min-width:0}.wa-panel .wa-document-heading h2{font-size:15px;line-height:1.5;font-weight:600}
.wa-panel .wa-document-heading .wa-help{max-width:700px;margin-top:5px}
.wa-panel .wa-document-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:16px}
.wa-panel .wa-document-section{padding:28px 0;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-document-section h2{font-size:15px}.wa-panel .wa-document-section h3{font-size:13px}
.wa-panel .wa-memory-workspace{min-width:0}.wa-panel .wa-memory-workspace-tabs{margin-bottom:24px}
.wa-panel .wa-memory-workspace [role=tabpanel]{min-width:0}
.wa-panel .wa-memory-scope{padding:0 0 20px;border-bottom:1px solid var(--wa-border-soft);margin-bottom:22px}
.wa-panel .wa-memory-scope .wa-room-picker{margin:0;max-width:560px}
.wa-panel .wa-memory-document,.wa-panel .wa-image-memory{min-width:0}
.wa-panel .wa-memory-preferences{padding:13px 0;margin:0 0 24px;border-top:1px solid var(--wa-border-soft);border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-memory-preferences>summary{display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:12px;cursor:pointer;color:var(--wa-ink);list-style:none}
.wa-panel .wa-memory-preferences>summary::-webkit-details-marker{display:none}
.wa-panel .wa-memory-preferences>summary>span:last-child{color:var(--wa-muted);font-variant-numeric:tabular-nums}
.wa-panel .wa-memory-preferences-body{padding:20px 0 6px;max-width:740px}.wa-panel .wa-memory-preferences-body h2{font-size:13px}
.wa-panel .wa-window-setting{align-items:center;margin:14px 0}.wa-panel .wa-window-setting .wa-input{width:170px;max-width:100%}
.wa-panel .wa-memory-content{min-width:0}
.wa-panel .wa-memory-overview{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:36px;row-gap:14px;min-width:0;padding:0 0 18px;margin-bottom:22px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-memory-overview-heading{display:flex;align-items:flex-start;gap:14px;min-width:0}.wa-panel .wa-memory-overview-heading>div{min-width:0}
.wa-panel .wa-memory-overview-heading h2{font-size:15px;font-weight:600;overflow-wrap:anywhere}
.wa-panel .wa-memory-overview-heading .wa-help{margin-top:5px;font-size:12px}
.wa-panel .wa-memory-metrics{display:flex;gap:28px;align-items:flex-start;margin:0;min-width:0}
.wa-panel .wa-memory-metrics>div{min-width:0}.wa-panel .wa-memory-metrics dt{font-size:11px;line-height:1.5;color:var(--wa-muted);white-space:nowrap}
.wa-panel .wa-memory-metrics dd{margin:4px 0 0;font-size:21px;line-height:1.4;font-weight:550;font-variant-numeric:tabular-nums;letter-spacing:-.04em;white-space:nowrap;color:var(--wa-ink)}
.wa-panel .wa-memory-capacity{grid-column:1/-1;max-width:100%}.wa-panel .wa-memory-capacity-label{display:flex;justify-content:space-between;gap:14px;align-items:baseline;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-memory-capacity-label strong{font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--wa-muted)}
.wa-panel .wa-memory-meter{height:3px;overflow:hidden;background:var(--wa-border-soft);margin:9px 0 7px}
.wa-panel .wa-memory-meter>span{display:block;height:100%;background:var(--wa-accent)}
.wa-panel .wa-memory-capacity>p{font-size:11px;line-height:1.7;color:var(--wa-muted)}
.wa-panel .wa-memory-editor{max-width:900px;margin-top:18px}.wa-panel .wa-memory-editor .wa-textarea{min-height:180px;line-height:1.95;padding:18px;resize:vertical}
.wa-panel .wa-memory-editor>.wa-help{margin-top:12px}.wa-panel .wa-memory-reference{margin-top:26px}
.wa-panel .wa-memory-reference .wa-subsection{padding-top:14px;margin-top:14px}.wa-panel .wa-memory-reference .wa-subsection>summary{font-size:12px}
.wa-panel .wa-memory-preview,.wa-panel .wa-long-preview{display:block;max-width:100%;max-height:480px;overflow:auto;margin:16px 0 0;padding:20px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:6px;color:var(--wa-ink);font:12px/1.95 var(--wa-font-body);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.wa-panel .wa-memory-reference .wa-note-box{margin-top:14px}.wa-panel .wa-memory-reference .wa-note-box>.wa-row{margin-top:14px}
/* Long-term memory is a document with source sections, not a grid of cards. */
.wa-panel .wa-long-workspace{min-width:0}.wa-panel .wa-long-workspace>.wa-memory-overview{margin-bottom:0;border-bottom:0}
.wa-panel .wa-long-shared{max-width:960px}.wa-panel .wa-long-shared>.wa-field{margin-top:20px}
.wa-panel .wa-long-editor{min-height:140px;line-height:1.95;padding:18px}
.wa-panel .wa-long-note{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.95;color:var(--wa-ink)}
.wa-panel .wa-long-saved-document{padding:20px 24px;border-left:2px solid var(--wa-border);background:var(--wa-subtle);max-width:900px}
.wa-panel .wa-long-document-status{font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-long-saved-document .wa-long-note{margin-top:10px}.wa-panel .wa-long-saved-document .wa-long-tools{margin-top:16px}
.wa-panel .wa-long-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px}
.wa-panel .wa-long-source{margin:0 0 22px}.wa-panel .wa-long-source .wa-select{max-width:460px}
.wa-panel .wa-long-source-head{margin-top:26px;min-width:0}
.wa-panel .wa-long-source-title{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:10px;border-bottom:1px solid var(--wa-border)}
.wa-panel .wa-long-source-title h3{font-size:13px;overflow-wrap:anywhere}.wa-panel .wa-long-source-title>span{font-size:11px;white-space:nowrap;color:var(--wa-muted)}
.wa-panel .wa-long-facts{display:block;min-width:0}
.wa-panel .wa-long-fact{position:relative;min-width:0;padding:20px 0;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-long-fact:last-child{border-bottom:0}.wa-panel .wa-long-fact.is-old{color:var(--wa-muted)}
.wa-panel .wa-long-fact.is-old .wa-long-note{color:var(--wa-muted)}
.wa-panel .wa-long-fact-meta{display:flex;align-items:center;justify-content:space-between;gap:14px;font-size:11px;color:var(--wa-muted);margin-bottom:8px}
.wa-panel .wa-long-fact-meta time{font-variant-numeric:tabular-nums}.wa-panel .wa-long-fact>.wa-help{margin-top:10px;max-width:800px}
.wa-panel .wa-long-fact-actions{display:flex;gap:4px;flex-wrap:wrap;margin-top:10px}
.wa-panel .wa-long-fact-actions>.wa-button{min-height:28px;padding:3px 7px;background:transparent;border-color:transparent;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-long-fact-actions>.wa-danger{color:var(--wa-danger)}.wa-panel .wa-long-fact-actions>.wa-button:hover:not(:disabled){background:var(--wa-hover)}
.wa-panel .wa-long-fact>.wa-note-box{margin-top:14px}
.wa-panel .wa-long-storage>h2{margin-bottom:18px}.wa-panel .wa-long-storage>.wa-subsection{margin-top:14px;padding-top:14px}
.wa-panel .wa-long-storage .wa-textarea{font-family:var(--wa-font-mono);font-size:12px;line-height:1.9}
/* Review rows keep the new statement, conflicting evidence and decisions together. */
.wa-panel .wa-memory-review-metrics{display:flex;gap:32px;align-items:baseline;padding:0 0 24px;margin-bottom:12px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-memory-review-metrics>div{display:flex;align-items:baseline;gap:10px;min-width:0}
.wa-panel .wa-memory-review-metrics span{font-size:12px;color:var(--wa-muted)}.wa-panel .wa-memory-review-metrics strong{font-size:21px;font-weight:550;line-height:1.4;font-variant-numeric:tabular-nums}
.wa-panel .wa-memory-fact-list{display:block;min-width:0}
.wa-panel .wa-memory-review-fact{padding:24px 0;border-top:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-memory-review-fact[data-fact-state=pending]{padding-left:18px;border-left:2px solid var(--wa-warning);margin:20px 0;border-top:0}
.wa-panel .wa-memory-review-meta{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.wa-panel .wa-memory-review-meta>.wa-wb-eyebrow{font-size:11px;letter-spacing:0;text-transform:none;color:var(--wa-muted);overflow-wrap:anywhere}
.wa-panel .wa-memory-review-fact .wa-wb-fact-text{font-size:14px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;color:var(--wa-ink)}
.wa-panel .wa-memory-conflict{padding:14px 18px;margin:14px 0;background:var(--wa-subtle);border-left:2px solid var(--wa-border);font-size:13px;line-height:1.85;color:var(--wa-muted)}
.wa-panel .wa-memory-conflict small{display:block;font-size:11px;margin-bottom:7px}.wa-panel .wa-memory-conflict p+p{margin-top:8px}
.wa-panel .wa-memory-expiry{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:15px;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-memory-expiry .wa-wb-button{min-height:28px;padding:4px 8px;font-size:11px}
.wa-panel .wa-memory-review-fact .wa-wb-inline-form{display:flex;flex-direction:column;gap:12px;padding:18px;margin-top:14px;border:1px solid var(--wa-border);border-radius:6px;background:var(--wa-surface);max-width:620px}
.wa-panel .wa-memory-review-fact .wa-wb-inline-form>label{display:flex;flex-direction:column;gap:7px;font-size:12px}
.wa-panel .wa-memory-review-fact .wa-wb-inline-form>small{font-size:11px;color:var(--wa-muted);line-height:1.7}
.wa-panel .wa-memory-sources{margin-top:14px;font-size:12px;color:var(--wa-muted)}.wa-panel .wa-memory-sources>summary{cursor:pointer}
.wa-panel .wa-memory-sources blockquote{margin:12px 0 0;padding:0 0 0 14px;border-left:2px solid var(--wa-border);color:var(--wa-ink)}
.wa-panel .wa-memory-sources blockquote small{font-size:11px;color:var(--wa-muted)}.wa-panel .wa-memory-sources blockquote p{margin-top:5px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}
.wa-panel .wa-memory-confirmation-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:#10131899;backdrop-filter:blur(3px)}
.wa-panel .wa-memory-delete-dialog{width:min(520px,100%);max-height:calc(100dvh - 48px);overflow:auto;padding:26px;background:var(--wa-surface);color:var(--wa-ink);border:1px solid var(--wa-border);border-radius:10px;box-shadow:0 24px 100px #0004;outline:none}
.wa-panel .wa-memory-delete-dialog h3{font-size:16px;line-height:1.7;overflow-wrap:anywhere}.wa-panel .wa-memory-delete-dialog>p{margin:12px 0 22px;font-size:12px;line-height:1.9;color:var(--wa-muted)}
.wa-panel .wa-memory-delete-dialog>.wa-wb-actions{justify-content:flex-end}.wa-panel .wa-memory-delete-dialog>.wa-alert{margin:0 0 18px}
/* Image memories use the same gallery grammar, with provenance under every image. */
.wa-panel .wa-image-settings{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;padding:0 0 18px;margin:0 0 12px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-image-settings .wa-field{margin:0;min-width:170px;flex:0 1 210px}.wa-panel .wa-image-settings .wa-check-row{align-self:center;display:flex;align-items:center;gap:9px;font-size:12px;margin-right:auto}
.wa-panel .wa-image-settings .wa-label{display:block;margin-bottom:7px;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-image-settings>.wa-button{min-height:34px}.wa-panel .wa-image-settings+.wa-help{max-width:840px}
.wa-panel .wa-image-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:24px 0 12px}
.wa-panel .wa-image-toolbar>.wa-input{flex:1;min-width:min(260px,100%)}
.wa-panel .wa-image-count{font-size:11px;color:var(--wa-muted);font-variant-numeric:tabular-nums;margin:14px 0 16px}
.wa-panel .wa-image-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px 18px;min-width:0}
.wa-panel .wa-image-card{min-width:0;background:transparent;overflow:hidden}
.wa-panel .wa-image-open{display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:4/3;padding:12px;border:1px solid var(--wa-border-soft);border-radius:6px;background:var(--wa-subtle);overflow:hidden;color:var(--wa-muted);font-size:12px;line-height:1.75;transition:border-color .15s,background .15s}
.wa-panel .wa-image-open:hover{border-color:var(--wa-accent);background:var(--wa-hover)}.wa-panel .wa-image-open img{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain}
.wa-panel .wa-image-card-copy{padding:12px 0 0}.wa-panel .wa-image-card-meta{display:flex;gap:6px 12px;align-items:center;justify-content:space-between;flex-wrap:wrap;font-size:11px;color:var(--wa-muted);line-height:1.7}
.wa-panel .wa-image-generation-source{overflow-wrap:anywhere;margin:8px 0}
.wa-panel .wa-image-card .wa-image-generation-source>p{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.wa-panel .wa-image-card-meta .wa-badge{font-size:10px;padding:1px 5px;background:transparent;color:var(--wa-muted);border:1px solid var(--wa-border-soft)}
.wa-panel .wa-image-description{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.85;color:var(--wa-ink)}
.wa-panel .wa-image-card .wa-image-description{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:8px 0}
.wa-panel .wa-image-card .wa-help{font-size:11px}.wa-panel .wa-image-memory>.wa-between{padding-top:18px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-image-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:28px;background:#10131899;backdrop-filter:blur(3px)}
.wa-panel .wa-image-dialog{width:min(920px,100%);max-height:calc(100dvh - 56px);overflow:auto;background:var(--wa-surface);color:var(--wa-ink);border:1px solid var(--wa-border);border-radius:10px;box-shadow:0 24px 100px #0004}
.wa-panel .wa-image-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 22px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-image-dialog-head h2{font-size:14px;overflow-wrap:anywhere}.wa-panel .wa-image-dialog-head>.wa-button{flex-shrink:0;font-size:11px}
.wa-panel .wa-image-dialog-stage{display:grid;place-items:center;padding:24px;min-height:200px;background:var(--wa-subtle)}
.wa-panel .wa-image-preview{display:block;max-width:100%;max-height:52vh;width:auto;height:auto;object-fit:contain}
.wa-panel .wa-image-dialog-information{padding:20px 22px}.wa-panel .wa-image-dialog-information>.wa-help{margin:8px 0 16px}.wa-panel .wa-image-delete{margin-top:16px}.wa-panel .wa-image-delete>.wa-button{margin:12px 8px 0 0}
/* Media library: personal gallery first; built-in collections and import are supporting sections. */
.wa-panel .wa-library-page{min-width:0}.wa-panel .wa-library-gallery{min-width:0;padding-bottom:26px}
.wa-panel .wa-library-gallery>.wa-empty{min-height:150px;padding:28px 20px}.wa-panel .wa-library-gallery>.wa-empty>.wa-button{margin-top:8px}
.wa-panel .wa-assets-gallery-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.wa-panel .wa-assets-gallery-heading h2{font-size:14px}
.wa-panel .wa-assets-gallery-heading>.wa-button{min-height:30px;font-size:11px;padding:5px 9px}
.wa-panel .wa-assets-statline{display:flex;gap:8px 20px;align-items:center;flex-wrap:wrap;margin:10px 0 20px;font-size:11px;line-height:1.75;color:var(--wa-muted);font-variant-numeric:tabular-nums}
.wa-panel .wa-assets-toolbar{display:grid;grid-template-columns:minmax(170px,1fr) minmax(105px,.35fr) minmax(130px,.5fr) auto auto;gap:8px;align-items:center;padding:12px 0;border-top:1px solid var(--wa-border-soft);border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-assets-toolbar>:is(.wa-input,.wa-select){min-width:0;width:100%;font-size:12px}.wa-panel .wa-assets-toolbar>.wa-button{font-size:11px;min-height:34px;padding:6px 9px}
.wa-panel .wa-assets-batch-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 0 0;min-height:44px}
.wa-panel .wa-assets-batch-actions>.wa-button{font-size:11px;min-height:30px;padding:5px 9px}.wa-panel .wa-assets-batch-actions.has-selection{background:var(--wa-subtle);padding:10px 12px;margin-top:12px;border-radius:5px}
.wa-panel .wa-assets-selected{font-size:11px;color:var(--wa-ink);margin-left:auto;white-space:nowrap}
.wa-panel .wa-assets-batch-actions+.wa-help{font-size:11px;margin-top:8px}
.wa-panel .wa-assets-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px 16px;margin-top:22px;min-width:0}
.wa-panel .wa-asset-card{position:relative;min-width:0;border:0;border-radius:0;background:transparent;overflow:visible}
.wa-panel .wa-asset-open{display:block;width:100%;min-width:0;text-align:left;color:var(--wa-ink);background:transparent;border:0;padding:0;border-radius:6px}
.wa-panel .wa-asset-preview{display:flex;align-items:center;justify-content:center;aspect-ratio:1.2;min-width:0;padding:20px;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:6px;overflow:hidden;transition:border-color .15s,background .15s}
.wa-panel .wa-asset-open:hover .wa-asset-preview{border-color:var(--wa-accent);background:var(--wa-hover)}
.wa-panel .wa-asset-card:has(.wa-asset-check input:checked) .wa-asset-preview{border-color:var(--wa-accent);box-shadow:inset 0 0 0 1px var(--wa-accent)}
.wa-panel .wa-asset-preview img{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain}
.wa-panel .wa-asset-card.is-disabled .wa-asset-preview img{opacity:.58}.wa-panel .wa-asset-placeholder{text-align:center;font-size:11px;line-height:1.85;color:var(--wa-muted)}
.wa-panel .wa-asset-details{padding:11px 0 0;min-width:0}.wa-panel .wa-asset-details strong{display:block;font-size:12px;font-weight:600;line-height:1.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-panel .wa-asset-details p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px;margin-top:4px;font-size:11px;line-height:1.7;color:var(--wa-muted)}
.wa-panel .wa-asset-meta{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:10px;line-height:1.7;color:var(--wa-muted);margin-top:8px}
.wa-panel .wa-asset-check{position:absolute;top:8px;left:8px;z-index:1;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:4px;background:var(--wa-surface);border:1px solid var(--wa-border);cursor:pointer}
.wa-panel .wa-asset-check input{width:14px;height:14px;margin:0;accent-color:var(--wa-accent)}
.wa-panel .wa-assets-card-error{color:var(--wa-danger)!important;min-height:0!important}.wa-panel .wa-assets-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:24px;padding-top:16px;border-top:1px solid var(--wa-border-soft)}
.wa-panel .wa-library-section{padding:28px 0;border-top:1px solid var(--wa-border-soft);min-width:0}.wa-panel .wa-library-section h2{font-size:14px}
.wa-panel .wa-packs-grid{display:flex;flex-direction:column;gap:0;margin:0 0 16px}
.wa-panel .wa-pack-card{display:grid;grid-template-columns:150px minmax(0,1fr) auto;align-items:center;gap:22px;padding:18px 0;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-pack-card:last-child{border-bottom:0}.wa-panel .wa-pack-art{min-width:0}.wa-panel .wa-pack-art>.wa-help{font-size:10px;margin-top:6px}
.wa-panel .wa-pack-previews{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:center;gap:5px;padding:10px;background:var(--wa-subtle);border-radius:5px;min-height:70px}
.wa-panel .wa-pack-previews>div{display:flex;align-items:center;justify-content:center;min-width:0;aspect-ratio:1;text-align:center;overflow:hidden}
.wa-panel .wa-pack-previews img{display:block;max-width:100%;max-height:100%;object-fit:contain}.wa-panel .wa-pack-previews .wa-help{font-size:10px;line-height:1.5}
.wa-panel .wa-pack-copy{min-width:0}.wa-panel .wa-pack-copy h3{font-size:13px;font-weight:600;line-height:1.5}.wa-panel .wa-pack-description{font-size:12px;color:var(--wa-muted);line-height:1.8;margin:5px 0!important}
.wa-panel .wa-pack-count{font-size:11px;color:var(--wa-muted);font-variant-numeric:tabular-nums}
.wa-panel .wa-pack-footer{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:10px}
.wa-panel .wa-pack-footer .wa-button{font-size:11px;min-height:28px;padding:4px 7px}
.wa-panel .wa-pack-toggle{display:inline-flex;align-items:center;gap:8px;font-size:11px;white-space:nowrap;cursor:pointer;color:var(--wa-muted)}
.wa-panel .wa-pack-toggle input{appearance:none;width:28px;height:16px;margin:0;position:relative;border:0;border-radius:9px;background:var(--wa-border);cursor:pointer;flex-shrink:0}
.wa-panel .wa-pack-toggle input::before{content:'';position:absolute;width:12px;height:12px;left:2px;top:2px;border-radius:50%;background:var(--wa-surface);box-shadow:0 1px 2px #0002;transition:transform .15s}
.wa-panel .wa-pack-toggle input:checked{background:var(--wa-accent)}.wa-panel .wa-pack-toggle input:checked::before{transform:translateX(12px)}
.wa-panel .wa-pack-toggle input:disabled{opacity:.45;cursor:not-allowed}
.wa-panel .wa-pack-source{font-size:10px;color:var(--wa-muted);line-height:1.8;max-width:860px}.wa-panel .wa-pack-source a{text-decoration:underline;text-underline-offset:3px;color:inherit}
.wa-panel .wa-pack-paused-note{margin-top:16px}
.wa-panel .wa-assets-upload{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}.wa-panel .wa-assets-upload .wa-help{margin-top:5px;font-size:12px}
.wa-panel .wa-assets-upload-actions{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.wa-panel .wa-assets-upload-actions .wa-select{width:155px;max-width:100%;font-size:12px}
.wa-panel .wa-assets-import-input{position:absolute;top:0;left:0;width:1px;height:1px;padding:0;margin:0;opacity:0;overflow:hidden;pointer-events:none}
.wa-panel .wa-library-import>.wa-subsection{margin-top:18px;padding-top:14px}.wa-panel .wa-library-import>.wa-subsection>summary{font-size:12px}
.wa-panel .wa-imported-packs{display:flex;flex-direction:column;margin-top:18px;max-width:700px}.wa-panel .wa-imported-pack{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 0;border-bottom:1px solid var(--wa-border-soft);min-width:0}
.wa-panel .wa-imported-pack-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.wa-panel .wa-assets-progress{padding:18px 0;margin:16px 0;border-top:1px solid var(--wa-border-soft);border-bottom:1px solid var(--wa-border-soft);font-size:12px;overflow-wrap:anywhere}
.wa-panel .wa-assets-progress progress{display:block;width:100%;height:4px;margin:12px 0;accent-color:var(--wa-accent)}
.wa-panel .wa-assets-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;max-width:660px}
.wa-panel .wa-assets-field{display:flex;flex-direction:column;gap:7px;margin:18px 0;min-width:0;font-size:12px}.wa-panel .wa-assets-field>span:first-child{font-size:12px;font-weight:500}
.wa-panel .wa-assets-field small{font-size:11px;line-height:1.75}.wa-panel .wa-assets-settings .wa-row{flex-wrap:nowrap}
.wa-panel .wa-assets-settings .wa-row>.wa-input{flex:1;min-width:0;width:0}.wa-panel .wa-assets-checkline{display:flex;align-items:center;gap:9px;margin:18px 0;font-size:12px;line-height:1.7}
.wa-panel .wa-assets-checkline input{margin:0;accent-color:var(--wa-accent);flex-shrink:0}.wa-panel .wa-assets-setting-note{max-width:730px;margin-top:12px}
.wa-panel .wa-assets-delete{padding:16px 18px;margin-top:16px;border-left:2px solid var(--wa-danger);background:var(--wa-danger-soft);font-size:12px;line-height:1.85}
.wa-panel .wa-assets-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:#10131899;backdrop-filter:blur(3px);padding:28px}
.wa-panel .wa-assets-dialog{width:min(930px,100%);max-height:calc(100dvh - 56px);overflow:auto;padding:22px 26px;background:var(--wa-surface);color:var(--wa-ink);border:1px solid var(--wa-border);border-radius:10px;box-shadow:0 24px 100px #0004;outline:none}
.wa-panel .wa-assets-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:18px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-assets-dialog-head h2{font-size:15px}.wa-panel .wa-assets-dialog-head .wa-button{min-height:30px;font-size:11px;padding:5px 10px}
.wa-panel .wa-assets-editor{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:30px;margin-top:22px;min-width:0}
.wa-panel .wa-assets-editor>div{min-width:0}.wa-panel .wa-assets-editor>div:last-child>.wa-assets-field:first-child{margin-top:0}
.wa-panel .wa-assets-large-preview{display:flex;align-items:center;justify-content:center;width:100%;min-width:0;max-width:100%;min-height:240px;max-height:480px;aspect-ratio:1;background:var(--wa-subtle);border:1px solid var(--wa-border-soft);border-radius:6px;padding:20px}
.wa-panel .wa-assets-large-preview img{max-width:100%;max-height:420px;width:100%;height:100%;object-fit:contain}.wa-panel .wa-assets-editor>div:first-child>.wa-button{font-size:11px;min-height:32px;margin-top:16px}
.wa-panel .wa-assets-description-count{font-size:10px;color:var(--wa-muted);text-align:right;font-variant-numeric:tabular-nums}
.wa-panel .wa-assets-editor-actions{display:flex;gap:8px;align-items:center;border-top:1px solid var(--wa-border-soft);padding-top:18px;margin-top:18px}
/* Processing records use a master/detail ledger, with quiet chronology and readable answers. */
.wa-panel .wa-records-layout{display:grid;grid-template-columns:220px minmax(0,1fr);min-width:0;border-top:1px solid var(--wa-border);border-bottom:1px solid var(--wa-border)}
.wa-panel .wa-records-sidebar{min-width:0;padding:18px 14px 18px 0;border-right:1px solid var(--wa-border-soft);align-self:start}
.wa-panel .wa-records-sidebar .wa-search{min-width:0;width:100%;max-width:none;margin-bottom:12px}.wa-panel .wa-records-sidebar .wa-search .wa-input{font-size:11px}
.wa-panel .wa-records-type-filter{margin-bottom:18px}.wa-panel .wa-records-type-filter .wa-filters{display:flex}.wa-panel .wa-records-type-filter .wa-filter{flex:1;min-width:0;padding-inline:7px;font-size:11px}
.wa-panel .wa-records-sidebar-label{font-size:10px;color:var(--wa-muted);margin:0 8px 9px}
.wa-panel .wa-records-peers{display:flex;flex-direction:column;gap:2px;max-height:660px;overflow-y:auto;overscroll-behavior:contain}
.wa-panel .wa-records-peer{display:flex;align-items:center;gap:9px;position:relative;width:100%;border:0;background:transparent;text-align:left;color:var(--wa-ink);padding:11px 8px;border-radius:5px;min-width:0;cursor:pointer}
.wa-panel .wa-records-peer:hover{background:var(--wa-hover)}.wa-panel .wa-records-peer[aria-current=true]{background:var(--wa-subtle)}
.wa-panel .wa-records-peer[aria-current=true]::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:2px;background:var(--wa-accent);border-radius:2px}
.wa-panel .wa-records-peer .wa-session-avatar{display:grid;place-items:center;width:27px;height:27px;flex-shrink:0;border:1px solid var(--wa-border-soft);border-radius:5px;background:var(--wa-surface);color:var(--wa-muted);font-size:10px}
.wa-panel .wa-records-peer .wa-session-info{display:block;min-width:0;flex:1}.wa-panel .wa-records-peer .wa-session-title{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.wa-panel .wa-records-peer .wa-session-meta{display:block;font-size:10px;color:var(--wa-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-panel .wa-record-count{font-size:10px;color:var(--wa-muted);font-variant-numeric:tabular-nums;flex-shrink:0}
.wa-panel .wa-records-main{min-width:0}.wa-panel .wa-records-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:20px 0 20px 24px;border-bottom:1px solid var(--wa-border-soft)}
.wa-panel .wa-records-heading-copy{min-width:0;flex:1}.wa-panel .wa-records-title{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.wa-panel .wa-records-title h2{font-size:15px;overflow-wrap:anywhere}
.wa-panel .wa-records-title>span{font-size:11px;color:var(--wa-muted);font-variant-numeric:tabular-nums}.wa-panel .wa-records-heading-copy>.wa-mono{margin-top:5px;font-size:10px}
.wa-panel .wa-records-heading-copy>[data-testid=conversation-processing]{margin-top:9px;font-size:11px}
.wa-panel .wa-records-location{margin-top:8px;font-size:11px}.wa-panel .wa-records-location>summary{display:inline-flex;gap:6px;align-items:center;color:var(--wa-muted);cursor:pointer;list-style:none}.wa-panel .wa-records-location>summary::-webkit-details-marker{display:none}
.wa-panel .wa-records-location .wa-path-value{margin-top:10px;max-width:560px}.wa-panel .wa-records-actions{gap:4px;flex-shrink:0}.wa-panel .wa-records-actions>.wa-button{font-size:11px;min-height:30px;padding:5px 8px}
.wa-panel .wa-records-body{padding-left:24px;min-width:0}.wa-panel .wa-record{min-width:0;border-bottom:1px solid var(--wa-border-soft)}.wa-panel .wa-record:last-child{border-bottom:0}
.wa-panel .wa-record>summary{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 20px;padding:16px 23px 16px 0;cursor:pointer;list-style:none;min-width:0}
.wa-panel .wa-record>summary::-webkit-details-marker{display:none}.wa-panel .wa-record>summary::after{content:'';position:absolute;right:4px;top:33px;width:5px;height:5px;border-right:1px solid var(--wa-muted);border-bottom:1px solid var(--wa-muted);transform:rotate(45deg);transition:transform .15s}
.wa-panel .wa-record[open]>summary::after{transform:rotate(225deg)}.wa-panel .wa-record>summary:hover .wa-record-question{color:var(--wa-accent)}
.wa-panel .wa-record-meta{display:flex;align-items:center;gap:10px;font-size:10px;color:var(--wa-muted);min-width:0}.wa-panel .wa-record-meta>span{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.wa-panel .wa-record-meta time{font-variant-numeric:tabular-nums;white-space:nowrap;flex-shrink:0}.wa-panel .wa-record-headline{grid-column:1;min-width:0}
.wa-panel .wa-record-question{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:1.75;overflow-wrap:anywhere;white-space:pre-wrap;color:var(--wa-ink)}
.wa-panel .wa-record[open] .wa-record-question{display:block;overflow:visible;-webkit-line-clamp:unset}
.wa-panel .wa-record-state{grid-column:2;grid-row:1/3;align-self:center;max-width:150px}.wa-panel .wa-record-state .wa-badge{font-size:10px;white-space:normal;text-align:center}
.wa-panel .wa-record-content{padding:0 23px 20px 0;min-width:0}.wa-panel .wa-record-content>.wa-help{font-size:11px}
.wa-panel .wa-record-answer{margin:0 0 18px;padding:18px 20px;border-left:2px solid var(--wa-border);background:var(--wa-subtle)}
.wa-panel .wa-record-answer h3{font-size:10px;font-weight:550;line-height:1.6;color:var(--wa-muted);margin-bottom:8px}
.wa-panel .wa-record-reply{font-size:13px;line-height:1.95;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--wa-ink)}
.wa-panel .wa-record-memory{padding:12px 0;border-top:1px solid var(--wa-border-soft);font-size:11px;color:var(--wa-muted);line-height:1.8}
.wa-panel .wa-record-memory>summary{font-size:11px;color:var(--wa-ink);cursor:pointer}.wa-panel .wa-record-memory[open]>summary{margin-bottom:10px}
.wa-panel .wa-record-memory>p+p{margin-top:8px}.wa-panel .wa-record-memory>.wa-row{gap:7px 18px;margin-bottom:7px;font-variant-numeric:tabular-nums}
.wa-panel .wa-record-content>.wa-muted{font-size:10px;margin-top:14px}.wa-panel .wa-record-content>.wa-alert{margin-top:12px}
.wa-panel .wa-record-receipt{display:flex;align-items:flex-start;gap:6px;font-size:11px;line-height:1.8;color:var(--wa-muted);margin-top:16px}.wa-panel .wa-record-receipt>svg{color:var(--wa-success);width:14px;height:14px;margin-top:3px;flex-shrink:0}
.wa-panel .wa-records-main>.wa-pagination{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--wa-border-soft);padding:16px 0 16px 24px;color:var(--wa-muted);font-size:11px}
@media(max-width:1100px){
 .wa-panel .wa-memory-overview{grid-template-columns:1fr;gap:18px}.wa-panel .wa-memory-metrics{gap:32px}
 .wa-panel .wa-assets-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
 .wa-panel .wa-assets-toolbar{grid-template-columns:minmax(130px,1fr) minmax(90px,.5fr) minmax(110px,.7fr)}
 .wa-panel .wa-assets-toolbar>.wa-button{justify-self:start}
 .wa-panel .wa-records-layout{grid-template-columns:190px minmax(0,1fr)}
 .wa-panel .wa-records-head{flex-wrap:wrap}.wa-panel .wa-records-actions{width:100%;justify-content:flex-end}
 .wa-panel .wa-pack-card{grid-template-columns:125px minmax(0,1fr) auto;gap:16px}
}
@media(max-width:760px){
 .wa-panel .wa-memory-review-metrics{gap:18px}.wa-panel .wa-memory-review-metrics>div{flex-direction:column;gap:4px;align-items:flex-start}
 .wa-panel .wa-image-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 14px}
 .wa-panel .wa-records-layout{grid-template-columns:1fr}.wa-panel .wa-records-sidebar{padding:16px 0;border-right:0;border-bottom:1px solid var(--wa-border)}
 .wa-panel .wa-records-peers{max-height:185px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
 .wa-panel .wa-records-sidebar .wa-search{max-width:420px}.wa-panel .wa-records-type-filter{margin-bottom:12px}.wa-panel .wa-records-type-filter .wa-filters{max-width:320px}
 .wa-panel .wa-records-head{padding:20px 0}.wa-panel .wa-records-body{padding-left:0}.wa-panel .wa-records-main>.wa-pagination{padding-left:0}
 .wa-panel .wa-records-actions{width:auto}.wa-panel .wa-records-head{gap:14px}
 .wa-panel .wa-assets-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 12px}
 .wa-panel .wa-assets-editor{grid-template-columns:1fr;gap:22px}.wa-panel .wa-assets-large-preview{max-height:260px;min-height:180px;aspect-ratio:1.7}.wa-panel .wa-assets-large-preview img{max-height:220px}
 .wa-panel .wa-pack-card{grid-template-columns:100px minmax(0,1fr);gap:12px 16px}.wa-panel .wa-pack-footer{grid-column:2;flex-direction:row;justify-content:space-between;align-items:center}
 .wa-panel .wa-pack-art{grid-row:1/3;align-self:start}.wa-panel .wa-pack-previews{grid-template-columns:repeat(2,minmax(0,1fr));padding:8px;min-height:80px}.wa-panel .wa-pack-previews>div:nth-child(3){grid-column:1/3;max-width:38px;justify-self:center}
}
@media(max-width:480px){
 .wa-panel .wa-document-heading{flex-direction:column;gap:12px}.wa-panel .wa-document-actions{align-items:flex-start}
 .wa-panel .wa-memory-metrics{display:flex;gap:20px;justify-content:space-between;width:100%}.wa-panel .wa-memory-metrics dd{font-size:18px}
 .wa-panel .wa-memory-capacity-label{flex-wrap:wrap;gap:4px}.wa-panel .wa-memory-editor .wa-textarea{padding:12px;min-height:190px}
 .wa-panel .wa-long-saved-document{padding:16px}.wa-panel .wa-long-source-title{align-items:flex-start;gap:10px}.wa-panel .wa-long-source-title>span{font-size:10px}
 .wa-panel .wa-long-fact-meta{flex-wrap:wrap;gap:5px}.wa-panel .wa-memory-review-meta{align-items:flex-start;gap:10px}
 .wa-panel .wa-memory-review-metrics{justify-content:space-between;gap:10px}.wa-panel .wa-memory-review-metrics span{font-size:11px}
 .wa-panel .wa-image-settings{gap:12px}.wa-panel .wa-image-settings .wa-check-row{width:100%}.wa-panel .wa-image-settings .wa-field{flex:1 1 100%}
 .wa-panel .wa-image-grid{grid-template-columns:1fr}.wa-panel .wa-image-open{max-height:260px;aspect-ratio:1.45}
 .wa-panel .wa-image-toolbar{gap:8px}.wa-panel .wa-image-toolbar>.wa-input{flex-basis:100%}
 .wa-panel .wa-image-modal,.wa-panel .wa-assets-backdrop{padding:10px}.wa-panel .wa-image-dialog,.wa-panel .wa-assets-dialog{max-height:calc(100dvh - 20px);border-radius:8px}
 .wa-panel .wa-image-dialog-head{padding:14px;gap:12px}.wa-panel .wa-image-dialog-head h2{font-size:12px}.wa-panel .wa-image-dialog-head>.wa-button{max-width:110px}
 .wa-panel .wa-image-dialog-stage{padding:14px}.wa-panel .wa-image-dialog-information{padding:16px}
 .wa-panel .wa-assets-toolbar{grid-template-columns:repeat(2,minmax(0,1fr))}.wa-panel .wa-assets-toolbar>.wa-input{grid-column:1/-1}
 .wa-panel .wa-assets-toolbar>.wa-select{max-width:none}.wa-panel .wa-assets-statline{gap:4px 15px;font-size:10px}
 .wa-panel .wa-assets-upload-actions{width:100%}.wa-panel .wa-assets-upload-actions>.wa-select{flex:1;min-width:125px}
 .wa-panel .wa-assets-settings{grid-template-columns:1fr;gap:0}.wa-panel .wa-assets-field{margin:14px 0}
 .wa-panel .wa-assets-dialog{padding:17px}.wa-panel .wa-assets-dialog-head{padding-bottom:14px}
 .wa-panel .wa-asset-preview{padding:14px;aspect-ratio:1}.wa-panel .wa-asset-details strong{font-size:11px}.wa-panel .wa-asset-details p{font-size:10px;min-height:34px}
 .wa-panel .wa-asset-meta{font-size:10px;gap:3px}.wa-panel .wa-asset-check{top:6px;left:6px;width:22px;height:22px}
 .wa-panel .wa-pack-card{grid-template-columns:80px minmax(0,1fr);gap:10px 14px}.wa-panel .wa-pack-footer{grid-column:1/-1;justify-content:flex-end;gap:18px}.wa-panel .wa-pack-art{grid-row:auto}
 .wa-panel .wa-pack-previews{grid-template-columns:repeat(2,minmax(0,1fr));padding:7px;min-height:70px}.wa-panel .wa-pack-previews>div:nth-child(3){max-width:30px}
 .wa-panel .wa-pack-description{font-size:11px;line-height:1.75}.wa-panel .wa-pack-source{font-size:10px}
 .wa-panel .wa-records-peers{grid-template-columns:1fr;max-height:180px}.wa-panel .wa-records-actions{width:100%;justify-content:flex-start}
 .wa-panel .wa-record>summary{gap:6px 10px;padding-right:16px}.wa-panel .wa-record-meta{grid-column:1/-1;padding-right:70px;gap:8px}
 .wa-panel .wa-record-state{grid-row:2;max-width:100px}.wa-panel .wa-record-state .wa-badge{font-size:9px;padding:2px 5px}
 .wa-panel .wa-record-question{font-size:12px}.wa-panel .wa-record>summary::after{right:2px;top:36px}
 .wa-panel .wa-record-content{padding-right:0}.wa-panel .wa-record-answer{padding:14px}.wa-panel .wa-record-reply{font-size:12px}
 .wa-panel .wa-memory-preview,.wa-panel .wa-long-preview{padding:14px;font-size:11px}
}
@media(max-width:380px){
 .wa-panel .wa-memory-metrics{flex-direction:column;gap:0}.wa-panel .wa-memory-metrics>div{width:100%;display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:6px 0}.wa-panel .wa-memory-metrics dd{margin:0}
 .wa-panel .wa-assets-grid{gap:18px 10px}.wa-panel .wa-asset-preview{padding:10px}
 .wa-panel .wa-pack-card{grid-template-columns:70px minmax(0,1fr);gap:10px}
 .wa-panel .wa-assets-selected{margin-left:0}.wa-panel .wa-long-source-title{flex-direction:column;gap:3px}
 .wa-panel .wa-memory-review-metrics strong{font-size:19px}.wa-panel .wa-memory-review-metrics span{font-size:10px}
}
.wa-panel .wa-moments-materials .wa-material-grid{display:block;margin-top:16px}
.wa-panel .wa-moments-materials .wa-material-card{display:flow-root;min-width:0;padding:22px 0;border:0;border-bottom:1px solid var(--wa-border-soft);border-radius:0;background:transparent;overflow-wrap:anywhere}
.wa-panel .wa-moments-materials .wa-material-card:last-child{border-bottom:0}
.wa-panel .wa-moments-materials .wa-material-card>.wa-wb-between{gap:14px;margin-bottom:10px}.wa-panel .wa-moments-materials .wa-material-card>.wa-wb-between>strong{font-size:13px;font-weight:600}
.wa-panel .wa-moments-materials .wa-material-card>p{margin:8px 0;font-size:13px;line-height:1.85}.wa-panel .wa-moments-materials .wa-material-card>small{display:block;margin-top:10px;color:var(--wa-muted);font-size:11px;line-height:1.7}
.wa-panel .wa-moments-materials .wa-material-card>details{margin-top:10px;font-size:11px;line-height:1.85;color:var(--wa-muted)}.wa-panel .wa-moments-materials .wa-material-card>details>summary{cursor:pointer}
.wa-panel .wa-moments-materials .wa-material-thumbnail{display:block;float:right;width:160px;max-width:40%;height:140px;object-fit:contain;margin:0 0 14px 22px;border:1px solid var(--wa-border-soft);border-radius:6px;background:var(--wa-subtle)}
.wa-panel .wa-moments-materials .wa-material-card>.wa-wb-actions{clear:both;margin-top:14px;padding-top:8px;flex-wrap:wrap;gap:6px}.wa-panel .wa-moments-materials .wa-material-card .wa-wb-button{min-height:30px;padding:5px 8px;font-size:11px}
.wa-panel .wa-moments-materials .wa-material-sources{max-height:260px;overflow:auto;display:grid;gap:10px;margin:16px 0}
.wa-panel .wa-moments-materials fieldset{border:0;padding:0;margin:16px 0;min-width:0}
.wa-panel .wa-moments-materials fieldset>label:not(.wa-wb-check){display:grid;gap:8px;margin:15px 0}.wa-panel .wa-moments-materials .wa-subsection{margin-top:18px}
.wa-panel .wa-moments-materials>.wa-wb-card>.wa-wb-between{flex-wrap:wrap;gap:14px}.wa-panel .wa-moments-materials .wa-wb-actions{flex-wrap:wrap;gap:8px}
.wa-panel .wa-moments-materials .wa-wb-actions>:is(input,select){min-height:34px;min-width:0;max-width:100%;font-size:12px}.wa-panel .wa-moments-materials .wa-wb-actions>input{width:220px}
@media(max-width:480px){.wa-panel .wa-moments-materials .wa-material-thumbnail{float:none;width:160px;max-width:100%;height:130px;margin:0 0 14px}.wa-panel .wa-moments-materials>.wa-wb-card>.wa-wb-between>.wa-wb-actions{width:100%}.wa-panel .wa-moments-materials .wa-wb-actions>input{flex:1;min-width:120px}}
@media(prefers-reduced-motion:reduce){.wa-panel .wa-image-open,.wa-panel .wa-asset-preview,.wa-panel .wa-record>summary::after,.wa-panel .wa-pack-toggle input::before{transition:none}}
`;
