export const traceCss = `
.wa-panel .wa-traces-page{min-width:0}
.wa-panel .wa-traces-page{--trace-glass:light-dark(#fffffff2,#252b29ee);--trace-shadow:0 6px 18px light-dark(#234f3f0b,#00000028);--trace-line:color-mix(in srgb,var(--wa-border) 78%,var(--wa-accent))}
.wa-panel .wa-trace-network-mark{width:36px;height:36px;flex-shrink:0;color:var(--wa-accent)}
.wa-panel .wa-trace-capture-mark{display:flex;align-items:center;gap:12px;padding:7px 13px;border:1px solid var(--wa-border-soft);border-radius:11px;background:linear-gradient(115deg,var(--wa-accent-soft),var(--wa-surface));box-shadow:inset 0 1px var(--wa-glint)}
.wa-panel .wa-trace-capture-mark>span{display:grid;gap:2px}
.wa-panel .wa-trace-capture-mark strong{font-size:11px;font-weight:550;color:var(--wa-ink)}
.wa-panel .wa-trace-capture-mark small{font-size:10px;color:var(--wa-muted);letter-spacing:.2px}
.wa-panel .wa-traces-page .wa-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.wa-panel .wa-traces-page>.wa-page-head{margin-bottom:20px}
.wa-panel .wa-trace-type-tabs{display:flex;flex-wrap:nowrap;gap:5px;padding:5px;margin:0 0 16px;border:1px solid var(--wa-border-soft);border-radius:12px;background:linear-gradient(180deg,var(--wa-subtle),color-mix(in srgb,var(--wa-subtle) 55%,var(--wa-surface)));overflow-x:auto;scrollbar-width:thin;box-shadow:inset 0 1px var(--wa-glint)}
.wa-panel .wa-trace-type-tabs>button{flex:1 0 auto;min-width:0;min-height:38px;padding:8px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--wa-muted);font-size:12px;white-space:nowrap;box-shadow:none}
.wa-panel .wa-trace-type-tabs>button>span{display:flex;align-items:center;gap:7px}
.wa-panel .wa-trace-type-tabs>button small{font:10px var(--wa-font-mono);opacity:.75}
.wa-panel .wa-trace-type-tabs>button[aria-selected=true]{color:var(--wa-accent);border-color:color-mix(in srgb,var(--wa-accent) 18%,var(--wa-border-soft));background:var(--wa-surface);box-shadow:0 2px 5px light-dark(#233c300a,#00000028),inset 0 1px var(--wa-glint)}
.wa-panel .wa-trace-type-tabs>button[aria-selected=true] small{opacity:1;background:var(--wa-accent-soft);padding:1px 4px;border-radius:4px}
.wa-panel .wa-trace-type-tabs>button:hover{background:var(--wa-surface)}
.wa-panel .wa-trace-filters{display:grid;grid-template-columns:minmax(160px,1fr) 132px auto auto;gap:9px;align-items:center}
.wa-panel .wa-trace-filters label{min-width:0}
.wa-panel .wa-trace-filters :is(input,select){min-height:36px;font-size:12px;padding-top:6px;padding-bottom:6px}
.wa-panel .wa-trace-search{position:relative}
.wa-panel .wa-trace-search>svg{position:absolute;top:11px;left:11px;color:var(--wa-faint)}
.wa-panel .wa-trace-search input{padding-left:35px}
.wa-panel .wa-trace-date-filter{position:relative;font-size:12px;min-width:0}
.wa-panel .wa-trace-date-filter summary{display:flex;gap:7px;align-items:center;justify-content:center;list-style:none;cursor:pointer;min-height:36px;border:1px solid var(--wa-border);border-radius:6px;padding:6px 11px;white-space:nowrap;background:var(--wa-surface)}
.wa-panel .wa-trace-date-filter summary::-webkit-details-marker{display:none}
.wa-panel .wa-trace-date-filter[open]>div{position:absolute;top:calc(100% + 8px);right:0;z-index:12;width:264px;display:grid;gap:12px;padding:16px;background:var(--wa-surface-raised);border:1px solid var(--wa-border);border-radius:9px;box-shadow:var(--wa-shadow-raised)}
.wa-panel .wa-trace-date-filter label{display:grid;gap:5px;color:var(--wa-muted)}
.wa-panel .wa-trace-stats{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 1px 12px;min-width:0;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-trace-stats>strong{color:var(--wa-ink);font-size:12px;font-weight:600;display:flex;gap:9px;align-items:center;white-space:nowrap}
.wa-panel .wa-trace-stats>strong>span{font-size:11px;font-weight:400;color:var(--wa-muted)}
.wa-panel .wa-trace-stats>div{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.wa-panel .wa-trace-stats>div>span{display:inline-flex;align-items:center;gap:5px}
.wa-panel .wa-trace-stats b{font-weight:550;font-variant-numeric:tabular-nums;color:var(--wa-ink)}
.wa-panel .wa-trace-stats i{width:5px;height:5px;border-radius:50%;background:var(--wa-info)}
.wa-panel .wa-trace-stats i[data-state=problem]{background:var(--wa-warning)}
.wa-panel .wa-traces-split{display:grid;grid-template-columns:248px minmax(0,1fr);height:clamp(640px,calc(100dvh - 285px),860px);border:1px solid var(--trace-line);border-radius:14px;overflow:hidden;background:var(--wa-surface);box-shadow:var(--trace-shadow)}
.wa-panel .wa-traces-list{min-width:0;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--wa-border);background:var(--wa-surface)}
.wa-panel .wa-traces-list-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:15px 16px;border-bottom:1px solid var(--wa-border-soft);font-size:12px;background:linear-gradient(180deg,var(--wa-subtle),var(--wa-surface))}
.wa-panel .wa-traces-list-title>span{font-size:10px;color:var(--wa-muted)}
.wa-panel .wa-traces-list-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.wa-panel .wa-trace-list-item{display:flex;flex-direction:column;gap:8px;position:relative;text-align:left;width:100%;padding:15px 13px 15px 16px;border:0;border-bottom:1px solid var(--wa-border-soft);background:transparent;color:var(--wa-ink);cursor:pointer;min-width:0;font:inherit}
.wa-panel .wa-trace-list-item{transition:background .18s var(--wa-ease),box-shadow .18s var(--wa-ease)}
.wa-panel .wa-trace-list-item:hover{background:var(--wa-subtle)}
.wa-panel .wa-trace-list-item.is-selected{background:linear-gradient(100deg,var(--wa-accent-soft),color-mix(in srgb,var(--wa-accent-soft) 55%,var(--wa-surface)));box-shadow:inset 0 1px var(--wa-glint)}
.wa-panel .wa-trace-list-item.is-selected:before{content:'';position:absolute;left:0;top:16px;bottom:16px;width:3px;background:var(--wa-accent);border-radius:0 3px 3px 0}
.wa-panel .wa-trace-list-top>small{display:flex;align-items:center;gap:5px}
.wa-panel .wa-trace-list-item>strong{font-size:12px;font-weight:600;line-height:1.7;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.wa-panel .wa-trace-list-top,.wa-panel .wa-trace-list-bottom{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px}
.wa-panel .wa-trace-list-meta{color:var(--wa-muted);font-size:10px;font-variant-numeric:tabular-nums}
.wa-panel .wa-trace-list-bottom{color:var(--wa-muted);flex-wrap:wrap}
.wa-panel .wa-trace-list-bottom small,.wa-panel .wa-trace-list-top>small{font-size:10px;color:var(--wa-muted)}
.wa-panel .wa-trace-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border-radius:5px;font-size:10px;line-height:1.4;font-weight:500;color:var(--wa-muted);background:var(--wa-subtle);white-space:nowrap}
.wa-panel .wa-trace-badge:before{content:'';width:4px;height:4px;flex-shrink:0;border-radius:50%;background:currentColor;opacity:.8}
.wa-panel .wa-trace-badge[data-state=completed]{background:var(--wa-success-soft);color:var(--wa-success)}
.wa-panel .wa-trace-badge[data-state=running]{background:var(--wa-info-soft);color:var(--wa-info)}
.wa-panel .wa-trace-badge[data-state=failed]{background:var(--wa-danger-soft);color:var(--wa-danger)}
.wa-panel .wa-trace-badge:is([data-state=unknown],[data-state=partial],[data-state=interrupted]){background:var(--wa-warning-soft);color:var(--wa-warning)}
.wa-panel .wa-trace-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 12px;border-top:1px solid var(--wa-border-soft);font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-trace-pagination .wa-button{min-height:28px;padding:4px 7px;font-size:11px}
.wa-panel .wa-trace-detail{display:flex;flex-direction:column;min-height:0;min-width:0;padding:0;overflow:hidden}
.wa-panel .wa-trace-detail-header{padding:16px 20px 0;flex-shrink:0;background:radial-gradient(ellipse at 100% 0,color-mix(in srgb,var(--wa-accent) 4%,transparent),transparent 65%)}
.wa-panel .wa-trace-detail-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}
.wa-panel .wa-trace-detail-actions>div{display:flex;align-items:center;gap:16px}
.wa-panel .wa-trace-detail-actions .wa-button{font-size:11px;min-height:29px;padding:4px 9px}
.wa-panel .wa-trace-text-button{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;padding:3px 0;border:0;background:transparent;color:var(--wa-accent);cursor:pointer;text-align:left;overflow-wrap:anywhere}
.wa-panel .wa-trace-eyebrow{display:flex;gap:7px;align-items:center;font-size:10px;color:var(--wa-muted);margin-bottom:6px}
.wa-panel .wa-trace-category-tag{color:var(--wa-accent);font-weight:550}
.wa-panel .wa-trace-detail h2{font-size:17px;line-height:1.65;margin:0 0 10px;font-weight:600;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.wa-panel .wa-trace-detail-summary{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;font-size:11px;color:var(--wa-muted)}
.wa-panel .wa-trace-detail-summary>span{display:inline-flex;align-items:center;gap:4px}
.wa-panel .wa-trace-context{display:flex;gap:8px 16px;flex-wrap:wrap;overflow-wrap:anywhere;color:var(--wa-muted);font-size:11px;line-height:1.7}
.wa-panel .wa-trace-alerts{max-height:96px;overflow:auto}
.wa-panel .wa-trace-alerts:not(:empty){margin-top:9px}
.wa-panel .wa-trace-alerts .wa-trace-warning{margin-top:4px;font-size:11px;padding:6px 8px}
.wa-panel .wa-trace-detail-tabs{display:flex;gap:22px;border-bottom:1px solid var(--wa-border-soft);padding:0 20px;margin-top:12px;flex-shrink:0}
.wa-panel .wa-trace-detail-tabs button{border:0;border-bottom:2px solid transparent;padding:10px 0;background:transparent;color:var(--wa-muted);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.wa-panel .wa-trace-detail-tabs button[aria-selected=true]{color:var(--wa-accent);border-bottom-color:var(--wa-accent);font-weight:600;text-shadow:0 0 18px color-mix(in srgb,var(--wa-accent) 16%,transparent)}
.wa-panel .wa-trace-detail-panel{flex:1;min-height:0;overflow:auto;padding:6px 20px 20px}
.wa-panel .wa-trace-detail-panel.is-graph{display:flex;flex-direction:column;overflow:hidden;padding:0}
.wa-panel .wa-trace-graph-frame{position:relative;flex:1;min-height:0;min-width:0}
.wa-panel .wa-trace-graph{height:100%;display:flex;flex-direction:column;min-height:0;--graph-line:var(--wa-border);--graph-color:var(--wa-muted);--graph-soft:var(--wa-subtle)}
.wa-panel .wa-trace-graph-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 15px;min-height:45px;flex-shrink:0}
.wa-panel .wa-trace-graph-breadcrumb{display:flex;align-items:center;gap:6px;font-size:11px;min-width:0}
.wa-panel .wa-trace-view-symbol{width:23px;height:23px;display:grid;place-items:center;color:var(--wa-accent);background:var(--wa-accent-soft);border-radius:6px}
.wa-panel .wa-trace-graph-breadcrumb button{border:0;background:transparent;padding:3px;color:var(--wa-accent);white-space:nowrap}
.wa-panel .wa-trace-graph-breadcrumb button:disabled{opacity:1;color:var(--wa-muted);cursor:default}
.wa-panel .wa-trace-graph-breadcrumb strong{white-space:nowrap;font-weight:550}
.wa-panel .wa-trace-graph-filter{min-width:0;max-width:128px}
.wa-panel .wa-trace-graph-filter .wa-select{min-height:28px;font-size:11px;padding:4px 7px;background:var(--wa-subtle);border-color:transparent}
.wa-panel .wa-trace-graph-surface{flex:1;position:relative;min-height:160px;overflow:hidden;touch-action:none;cursor:grab;background-color:light-dark(#f5f8f7,#1b201f);background-image:radial-gradient(ellipse at 52% 42%,light-dark(#c8e3d83b,#5caa8c0c),transparent 62%),radial-gradient(color-mix(in srgb,var(--wa-border) 82%,transparent) .65px,transparent .8px);background-size:100% 100%,20px 20px;user-select:none;outline-offset:-3px;box-shadow:inset 0 1px color-mix(in srgb,var(--wa-border-soft) 65%,transparent)}
.wa-panel .wa-trace-graph-surface[data-dragging=true]{cursor:grabbing}
.wa-panel .wa-trace-canvas-label{position:absolute;z-index:1;top:13px;left:16px;display:flex;align-items:center;gap:6px;pointer-events:none;color:var(--wa-muted);font-size:9px;letter-spacing:.4px}
.wa-panel .wa-trace-canvas-label>i{width:4px;height:4px;background:var(--wa-accent);border-radius:50%;opacity:.6}
.wa-panel .wa-trace-canvas-label>span{margin-left:4px;padding-left:10px;border-left:1px solid var(--wa-border);font:9px var(--wa-font-mono);opacity:.8}
.wa-panel .wa-trace-graph-svg{display:block;position:absolute;inset:0;overflow:hidden}
.wa-panel .wa-trace-graph-scene{transform-origin:0 0}
.wa-panel .wa-trace-graph[data-motion=true] .wa-trace-graph-scene{transition:transform .24s var(--wa-ease)}
.wa-panel .wa-graph-node-wrap{overflow:visible;transition:opacity .18s var(--wa-ease)}
.wa-panel .wa-graph-node-wrap[data-muted=true]{opacity:.4}
.wa-panel .wa-graph-connection{transition:opacity .18s var(--wa-ease)}
.wa-panel .wa-graph-connection[data-muted=true]{opacity:.18}
.wa-panel .wa-graph-connection path{stroke:var(--graph-line);fill:none;stroke-width:1.4}
.wa-panel .wa-graph-connection circle{fill:var(--graph-color);opacity:.7}
.wa-panel .wa-graph-connection .wa-graph-connection-signal{stroke:var(--graph-color);stroke-width:2;opacity:.8}
.wa-panel .wa-graph-connection[data-highlighted=true] .wa-graph-connection-signal{filter:drop-shadow(0 0 3px var(--graph-line))}
.wa-panel .wa-graph-connection[data-running=true] .wa-graph-connection-signal{stroke-dasharray:4 10;animation:wa-trace-travel 2.4s linear infinite}
.wa-panel :is(.wa-graph-node,.wa-graph-connection)[data-kind=model]{--graph-color:var(--wa-info);--graph-soft:var(--wa-info-soft);--graph-line:color-mix(in srgb,var(--wa-info) 35%,var(--wa-border))}
.wa-panel :is(.wa-graph-node,.wa-graph-connection)[data-kind=tool]{--graph-color:var(--wa-warning);--graph-soft:var(--wa-warning-soft);--graph-line:color-mix(in srgb,var(--wa-warning) 35%,var(--wa-border))}
.wa-panel :is(.wa-graph-node,.wa-graph-connection)[data-kind=transport]{--graph-color:var(--wa-success);--graph-soft:var(--wa-success-soft);--graph-line:color-mix(in srgb,var(--wa-success) 35%,var(--wa-border))}
.wa-panel :is(.wa-graph-node,.wa-graph-connection)[data-kind=child]{--graph-color:light-dark(#77589e,#c9b3e6);--graph-soft:light-dark(#f5f0fb,#352e42);--graph-line:light-dark(#c3afd9,#655477)}
.wa-panel .wa-graph-node{--graph-state:var(--wa-success);width:100%;height:100%;display:flex;align-items:center;gap:10px;text-align:left;padding:12px;border:1.2px solid color-mix(in srgb,var(--wa-border) 88%,var(--graph-color));border-radius:12px;background:linear-gradient(155deg,var(--wa-surface),color-mix(in srgb,var(--graph-soft) 42%,var(--wa-surface)));color:var(--wa-ink);font:inherit;overflow:hidden;cursor:pointer;box-shadow:0 4px 12px light-dark(#1a382a0a,#00000022),inset 0 1px var(--wa-glint);transition:border-color .18s,background .18s,box-shadow .18s}
.wa-panel .wa-graph-node:hover,.wa-panel .wa-graph-node.is-selected,.wa-panel .wa-graph-node-wrap[data-active=true] .wa-graph-node{border-color:var(--graph-color,var(--wa-accent));background:linear-gradient(150deg,var(--wa-surface),var(--graph-soft));box-shadow:0 0 0 3px color-mix(in srgb,var(--graph-color) 9%,transparent),0 7px 20px light-dark(#16352914,#00000045),inset 0 1px var(--wa-glint)}
.wa-panel .wa-graph-node:focus-visible{outline-offset:-4px}
.wa-panel .wa-graph-node-task{border-color:color-mix(in srgb,var(--wa-accent) 60%,var(--wa-border));background:linear-gradient(145deg,var(--wa-surface),var(--wa-accent-soft));--graph-color:var(--wa-accent);--graph-soft:var(--wa-accent-soft);box-shadow:0 0 0 5px color-mix(in srgb,var(--wa-accent) 5%,transparent),0 9px 26px light-dark(#245c3e14,#00000030),inset 0 1px var(--wa-glint)}
.wa-panel .wa-graph-node-symbol{position:relative;width:31px;height:31px;flex-shrink:0;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--graph-color) 13%,transparent);border-radius:9px;background:linear-gradient(145deg,var(--wa-surface),var(--graph-soft));color:var(--graph-color);box-shadow:inset 0 1px var(--wa-glint)}
.wa-panel .wa-graph-node-symbol .wa-trace-network-mark{width:28px;height:28px}
.wa-panel .wa-graph-node[data-state=running] .wa-graph-node-symbol:after{content:'';position:absolute;right:-2px;bottom:-2px;width:6px;height:6px;border:1.5px solid var(--wa-surface);background:var(--wa-info);border-radius:50%;animation:wa-trace-breathe 2.4s ease-in-out infinite}
.wa-panel .wa-graph-node:is([data-state=running],[data-state=queued]){--graph-state:var(--wa-info)}
.wa-panel .wa-graph-node[data-state=failed]{--graph-state:var(--wa-danger)}
.wa-panel .wa-graph-node:is([data-state=unknown],[data-state=partial],[data-state=interrupted]){--graph-state:var(--wa-warning)}
.wa-panel .wa-graph-node:is([data-state=skipped],[data-state=cancelled]){--graph-state:var(--wa-muted)}
.wa-panel .wa-graph-node-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.wa-panel .wa-graph-node-copy strong{font-size:var(--graph-font,14px);font-weight:600;line-height:1.35;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.wa-panel .wa-graph-node-copy small{font-size:var(--graph-small,11px);line-height:1.4;color:var(--wa-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-panel .wa-graph-node-copy .wa-graph-node-kicker{display:flex;align-items:center;gap:5px;font-size:calc(var(--graph-small,11px) - .5px)}
.wa-panel .wa-graph-state-dot{display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--graph-state);flex-shrink:0}
.wa-panel .wa-graph-node-task .wa-graph-node-copy{gap:6px}
.wa-panel .wa-graph-node-count{display:flex;align-items:center;gap:3px;flex-shrink:0;color:var(--graph-color);font:500 12px var(--wa-font-mono);padding:4px 5px;border:1px solid color-mix(in srgb,var(--graph-color) 12%,transparent);border-radius:7px;background:var(--graph-soft)}
.wa-panel .wa-graph-node-step .wa-graph-node-symbol{width:24px;height:24px;border-radius:6px}
.wa-panel .wa-graph-node-step{gap:8px;padding:10px}
.wa-panel .wa-graph-node-step[data-state=failed]{border-color:var(--wa-danger)}
.wa-panel .wa-graph-node-step:is([data-state=unknown],[data-state=partial],[data-state=interrupted]){border-color:var(--wa-warning)}
.wa-panel .wa-graph-node-result .wa-graph-node-symbol{color:var(--graph-state);background:color-mix(in srgb,var(--graph-state) 6%,var(--wa-surface));border-color:color-mix(in srgb,var(--graph-state) 16%,transparent)}
.wa-panel .wa-graph-node[data-compact=true]{padding:8px 10px;gap:3px}
.wa-panel .wa-graph-node[data-compact=true] :is(.wa-graph-node-symbol,.wa-graph-node-copy>small:last-child,.wa-graph-node-count>svg){display:none}
.wa-panel .wa-graph-node[data-compact=true] .wa-graph-node-copy{flex:initial;width:100%;gap:2px}
.wa-panel .wa-graph-node[data-compact=true] .wa-graph-node-copy strong{display:block;white-space:nowrap;text-overflow:ellipsis}
.wa-panel .wa-graph-node-group[data-compact=true]{flex-direction:column;align-items:flex-start;justify-content:center}
.wa-panel .wa-graph-node[data-compact=true] .wa-graph-node-count{font-size:var(--graph-small);line-height:1;gap:5px;padding:0;border:0;background:transparent}
.wa-panel .wa-graph-node[data-compact=true] .wa-graph-node-count:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--graph-state)}
.wa-panel .wa-graph-node[data-compact=true] .wa-graph-node-count:after{content:'个步骤';color:var(--wa-muted)}
.wa-panel .wa-trace-graph-controls{display:flex;align-items:center;gap:0;position:absolute;z-index:2;bottom:13px;left:14px;border:1px solid var(--wa-border);border-radius:9px;background:var(--trace-glass);backdrop-filter:blur(12px);box-shadow:0 4px 14px light-dark(#1635290a,#00000026),inset 0 1px var(--wa-glint);overflow:hidden;cursor:default}
.wa-panel .wa-trace-graph-controls button{display:grid;place-items:center;min-width:31px;height:30px;padding:3px 8px;border:0;background:transparent;color:var(--wa-ink);font-size:16px;cursor:pointer}
.wa-panel .wa-trace-graph-controls .wa-graph-fit{border-left:1px solid var(--wa-border-soft);font-size:10px;padding:3px 10px}
.wa-panel .wa-trace-graph-controls .wa-graph-map-toggle{border-left:1px solid var(--wa-border-soft);width:32px;padding:6px}
.wa-panel .wa-trace-graph-controls .wa-graph-map-toggle[aria-pressed=true]{color:var(--wa-accent);background:var(--wa-accent-soft)}
.wa-panel .wa-trace-graph-controls button:hover{background:var(--wa-hover)}
.wa-panel .wa-trace-graph-controls>span{min-width:36px;font:10px var(--wa-font-mono);color:var(--wa-muted);text-align:center}
.wa-panel .wa-trace-graph-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:34px;padding:7px 14px;font-size:10px;color:var(--wa-muted);border-bottom:1px solid var(--wa-border-soft);flex-shrink:0}
.wa-panel .wa-trace-branch-pages{display:flex;align-items:center;gap:8px;white-space:nowrap}
.wa-panel .wa-trace-branch-pages button{padding:2px 3px;border:0;background:transparent;color:var(--wa-accent);font-size:10px}
.wa-panel .wa-trace-loaded{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:7px 15px;font-size:10px;color:var(--wa-muted);min-height:32px;flex-shrink:0}
.wa-panel .wa-trace-minimap{position:absolute;z-index:2;right:13px;bottom:13px;width:140px;padding:7px 8px 8px;border:1px solid var(--wa-border);border-radius:9px;background:var(--trace-glass);backdrop-filter:blur(12px);box-shadow:var(--trace-shadow),inset 0 1px var(--wa-glint);animation:wa-trace-reveal .2s var(--wa-ease) both}
.wa-panel .wa-trace-minimap>div{display:flex;align-items:center;justify-content:space-between;color:var(--wa-muted);font-size:9px;letter-spacing:.3px;margin-bottom:5px}
.wa-panel .wa-trace-minimap>div button{border:0;background:transparent;color:var(--wa-muted);padding:1px;display:grid;place-items:center}
.wa-panel .wa-trace-minimap-canvas{display:block;width:100%;padding:0;border:0;border-radius:4px;overflow:hidden;background:color-mix(in srgb,var(--wa-subtle) 70%,transparent);cursor:crosshair}
.wa-panel .wa-trace-minimap-canvas svg{display:block;width:100%;height:60px;pointer-events:none}
.wa-panel .wa-trace-minimap line{stroke:var(--wa-border);stroke-width:6}
.wa-panel .wa-trace-minimap rect{fill:var(--wa-muted);opacity:.28}
.wa-panel .wa-trace-minimap rect[data-kind=model]{fill:var(--wa-info);opacity:.45}
.wa-panel .wa-trace-minimap rect[data-kind=tool]{fill:var(--wa-warning);opacity:.45}
.wa-panel .wa-trace-minimap rect[data-kind=transport],.wa-panel .wa-trace-minimap rect[data-kind=task]{fill:var(--wa-accent);opacity:.48}
.wa-panel .wa-trace-minimap .wa-trace-minimap-viewport{fill:color-mix(in srgb,var(--wa-accent) 9%,transparent);stroke:var(--wa-accent);stroke-width:5;opacity:1}
.wa-panel .wa-trace-inspector{position:absolute;top:50px;right:12px;bottom:45px;width:min(370px,calc(100% - 24px));min-height:0;display:flex;flex-direction:column;z-index:3;border:1px solid var(--trace-line);border-radius:13px;box-shadow:var(--wa-shadow-raised),inset 0 1px var(--wa-glint);background:var(--wa-surface-raised);animation:wa-trace-inspect .2s var(--wa-ease) both}
.wa-panel .wa-trace-inspector-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--wa-border-soft);border-radius:12px 12px 0 0;background:linear-gradient(110deg,var(--wa-accent-soft),var(--wa-surface-raised));font-size:11px;color:var(--wa-accent);box-shadow:inset 0 1px var(--wa-glint)}
.wa-panel .wa-trace-inspector-head>span{display:flex;align-items:center;gap:7px}
.wa-panel .wa-trace-inspector-head small{font:10px var(--wa-font-mono);color:var(--wa-muted);padding:2px 5px;border:1px solid var(--wa-border-soft);border-radius:4px;background:var(--wa-surface)}
.wa-panel .wa-trace-inspector[data-kind=model] .wa-trace-inspector-head{background:linear-gradient(110deg,var(--wa-info-soft),var(--wa-surface-raised));color:var(--wa-info)}
.wa-panel .wa-trace-inspector[data-kind=tool] .wa-trace-inspector-head{background:linear-gradient(110deg,var(--wa-warning-soft),var(--wa-surface-raised));color:var(--wa-warning)}
.wa-panel .wa-trace-inspector-head button{display:grid;place-items:center;border:0;background:transparent;color:var(--wa-muted);width:25px;height:25px;border-radius:5px}
.wa-panel .wa-trace-inspector-head button:hover{background:var(--wa-hover)}
.wa-panel .wa-trace-inspector-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:15px}
.wa-panel .wa-trace-inspector-body h3{font-size:15px;line-height:1.65;overflow-wrap:anywhere;outline-offset:1px}
.wa-panel .wa-trace-inspector-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:10px 0 12px;font-size:10px;color:var(--wa-muted)}
.wa-panel .wa-trace-inspector-meta>span:nth-child(n+3){flex-basis:100%;font-variant-numeric:tabular-nums}
.wa-panel .wa-trace-payload{margin-top:16px;min-width:0}
.wa-panel .wa-trace-payload h4{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:12px;font-weight:600}
.wa-panel .wa-trace-payload h4:before{content:'';width:3px;height:10px;background:var(--wa-accent);opacity:.45;border-radius:2px}
.wa-panel .wa-trace-payload pre,.wa-panel .wa-trace-usage pre{font-family:var(--wa-font-mono);font-size:11px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:430px;overflow:auto;border:1px solid var(--wa-border-soft);border-radius:7px;background:var(--wa-subtle);padding:12px;margin:0}
.wa-panel .wa-trace-inspector .wa-trace-payload pre{max-height:none}
.wa-panel .wa-trace-payload small{display:block;font-size:10px;color:var(--wa-muted);margin-top:6px}
.wa-panel .wa-trace-usage{font-size:11px;margin:12px 0;color:var(--wa-muted)}
.wa-panel .wa-trace-note{color:var(--wa-muted);font-size:11px;line-height:1.8;overflow-wrap:anywhere}
.wa-panel .wa-trace-warning{font-size:12px;line-height:1.7;background:var(--wa-warning-soft);color:var(--wa-warning);padding:10px 12px;border-radius:6px;overflow-wrap:anywhere;margin:8px 0}
.wa-panel .wa-trace-empty{padding:30px 20px;line-height:1.8}
.wa-panel .wa-trace-empty h3,.wa-panel .wa-trace-unselected h3{font-size:14px;font-weight:600}
.wa-panel .wa-trace-empty p{font-size:12px;color:var(--wa-muted);margin-top:7px}
.wa-panel .wa-trace-unselected{align-self:center;text-align:center;padding:35px;color:var(--wa-muted);max-width:510px;justify-self:center}
.wa-panel .wa-trace-unselected h3{color:var(--wa-ink);margin-top:26px}
.wa-panel .wa-trace-unselected p{font-size:12px;line-height:1.9;margin:9px 0 18px}
.wa-panel .wa-trace-unselected small{font-size:10px}
.wa-panel .wa-trace-empty-graph{display:flex;align-items:center;justify-content:center}
.wa-panel .wa-trace-empty-graph>span{width:56px;height:56px;display:grid;place-items:center;border:1px solid var(--wa-border);border-radius:13px;background:var(--wa-accent-soft);color:var(--wa-accent)}
.wa-panel .wa-trace-empty-graph>i{width:52px;height:1px;background:var(--wa-border)}
.wa-panel .wa-trace-empty-graph>div{display:grid;gap:13px;position:relative}
.wa-panel .wa-trace-empty-graph>div:before{content:'';position:absolute;top:17px;bottom:17px;left:-21px;width:20px;border:1px solid var(--wa-border);border-right:0;border-radius:10px 0 0 10px}
.wa-panel .wa-trace-empty-graph>div>span{display:flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--wa-border-soft);border-radius:7px;font-size:11px;background:var(--wa-surface)}
.wa-panel .wa-traces-page[data-focused=true] .wa-traces-split{grid-template-columns:minmax(0,1fr)}
.wa-panel .wa-traces-page[data-focused=true] .wa-traces-list{display:none}
@keyframes wa-trace-travel{to{stroke-dashoffset:-28}}
@keyframes wa-trace-breathe{50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--wa-info) 12%,transparent)}}
@keyframes wa-trace-reveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes wa-trace-inspect{from{opacity:0;transform:translateX(7px)}to{opacity:1;transform:translateX(0)}}
@media(max-width:1150px){
 .wa-panel .wa-traces-split{grid-template-columns:220px minmax(0,1fr)}
 .wa-panel .wa-trace-type-tabs>button{padding:7px 9px}
 .wa-panel .wa-trace-detail-header{padding:15px 15px 0}
 .wa-panel .wa-trace-detail-actions>div{gap:9px}
 .wa-panel .wa-trace-detail-tabs{padding:0 15px;gap:16px}
 .wa-panel .wa-trace-graph-foot>span:nth-last-child(2){max-width:55%}
}
@media(max-width:800px){
 .wa-panel .wa-trace-capture-mark{display:none}
 .wa-panel .wa-traces-page>.wa-page-head{margin-bottom:16px}
 .wa-panel .wa-trace-type-tabs{margin-bottom:12px;padding:4px}
 .wa-panel .wa-trace-type-tabs>button{flex:0 0 auto;padding:7px 10px}
 .wa-panel .wa-trace-filters{grid-template-columns:minmax(0,1fr) minmax(110px,.7fr)}
 .wa-panel .wa-trace-stats{align-items:flex-start;gap:9px;padding:13px 0 10px}
 .wa-panel .wa-trace-stats>div{gap:7px 12px;justify-content:flex-end}
 .wa-panel .wa-trace-stats>div>span:last-child{display:none}
 .wa-panel .wa-traces-split{display:block;height:clamp(540px,calc(100dvh - 215px),760px)}
 .wa-panel .wa-traces-list{height:100%;border:0}
 .wa-panel .wa-traces-split.has-selection .wa-traces-list,.wa-panel .wa-traces-split:not(.has-selection) .wa-trace-unselected{display:none}
 .wa-panel .wa-trace-detail{height:100%}
 .wa-panel .wa-trace-detail-header{padding:13px 12px 0}
 .wa-panel .wa-trace-detail h2{font-size:16px}
 .wa-panel .wa-trace-detail-actions{margin-bottom:13px}
 .wa-panel .wa-trace-detail-actions .wa-trace-focus-button{display:none}
 .wa-panel .wa-trace-detail-tabs{gap:16px;padding:0 12px}
 .wa-panel .wa-trace-detail-tabs button{font-size:11px}
 .wa-panel .wa-trace-detail-summary{gap:7px 10px}
 .wa-panel .wa-trace-graph-toolbar{padding:9px 10px}
 .wa-panel .wa-trace-graph-filter{max-width:111px}
 .wa-panel .wa-trace-view-symbol{display:none}
 .wa-panel .wa-trace-canvas-label{font-size:8px;top:10px;left:12px}
 .wa-panel .wa-trace-canvas-label>span{font-size:8px}
 .wa-panel .wa-trace-graph-foot{padding:7px 10px;align-items:center}
 .wa-panel .wa-trace-graph-foot>span:last-child{display:none}
 .wa-panel .wa-trace-graph-foot>span:first-child{max-width:50%}
 .wa-panel .wa-trace-inspector{top:8px;bottom:8px;right:8px;width:calc(100% - 16px)}
 .wa-panel .wa-trace-date-filter[open]>div{left:0;right:auto;width:min(264px,calc(100vw - 56px))}
 .wa-panel .wa-traces-page[data-show-detail=true] .wa-trace-stats,.wa-panel .wa-traces-page[data-show-detail=true] .wa-trace-filters{display:none}
 .wa-panel .wa-trace-list-item{padding:15px 17px}
 .wa-panel .wa-trace-list-item>strong{font-size:13px}
}
@media(max-width:360px){
 .wa-panel .wa-trace-detail-tabs{gap:10px;padding:0 10px}
 .wa-panel .wa-trace-detail-actions .wa-button{padding:4px 6px;font-size:10px}
 .wa-panel .wa-trace-detail-actions .wa-trace-text-button{font-size:10px}
 .wa-panel .wa-trace-detail-summary{font-size:10px;gap:6px}
 .wa-panel .wa-trace-graph-filter{max-width:99px}
 .wa-panel .wa-trace-graph-breadcrumb{font-size:10px;gap:3px}
 .wa-panel .wa-trace-graph-foot>span:first-child{max-width:42%;font-size:9px}
}
@media(prefers-reduced-motion:reduce){
 .wa-panel .wa-traces-page *,.wa-panel .wa-traces-page *:before,.wa-panel .wa-traces-page *:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
}
`;
