import { useEffect, useRef, useState } from 'react';
import { css } from "./styles/base.mjs";
import { pageLabels } from "./shared/labels.mjs";
import { Glyph } from "./components/glyph.jsx";
import { Button } from "./components/button.jsx";
import { usePanel } from "./hooks/use-panel.mjs";
import { PanelContent } from "./page-content.jsx";

export function WechatPanel({ connection, catalog }) {
  const state = usePanel(connection);
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef(null), menuButton = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    navRef.current?.querySelector('[aria-current=page]')?.focus();
    const dismiss = event => {
      if (event.type === 'keydown' && event.key === 'Escape') {
        setMenuOpen(false); menuButton.current?.focus();
      } else if (event.type === 'pointerdown' && !navRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('keydown', dismiss); document.removeEventListener('pointerdown', dismiss); };
  }, [menuOpen]);
  const { motion, status, page, memoryTab, busy, workspaceRef, action, navigate, navPage, warning } = state;
  const sectionLabel = ['overview', 'authorization', 'records', 'moments'].includes(navPage) ? '日常'
    : ['tasks', 'work', 'digests'].includes(navPage) ? '自动化' : '管理';
  const content = <PanelContent connection={connection} catalog={catalog} state={state} />;
  return (
    <div className="wa-panel" data-motion={motion.enabled ? 'on' : 'off'} data-page={page}>
      <style>{css}</style>
      <div className="wa-shell">
        <aside className="wa-nav" aria-label="微信 Agent 导航" ref={navRef} data-expanded={menuOpen ? 'true' : undefined}>
          <div className="wa-brand">
            <div className="wa-brand-mark">
              <Glyph name="chat" />
            </div>
            <div>
              <strong>微信 Agent</strong>
              <small>消息 · 记忆 · 工作</small>
            </div>
          </div>
          <button type="button" className="wa-nav-mobile" data-testid="mobile-navigation" ref={menuButton}
            aria-label="切换页面" aria-controls="wa-main-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            <span>{pageLabels[navPage]}</span><Glyph name={menuOpen ? 'close' : 'menu'} />
          </button>
          <nav className="wa-nav-list" id="wa-main-navigation">
            {[
              [
                '日常',
                [
                  ['overview', 'grid', '概览'],
                  ['authorization', 'people', '会话'],
                  ['records', 'history', '记录'],
                  ['moments', 'moments', '朋友圈'],
                ],
              ],
              [
                '自动化',
                [
                  ['tasks', 'clock', '定时任务'],
                  ['work', 'work', '工作任务'],
                  ['digests', 'digest', '群聊简报'],
                ],
              ],
              [
                '管理',
                [
                  ['memory', 'memory', '记忆库'],
                  ['assets', 'image', '素材'],
                  ['settings', 'settings', '设置'],
                ],
              ],
            ].map(([group, pages]) => (
              <div className="wa-nav-group" key={group}>
                <div className="wa-nav-label">{group}</div>
                {pages.map(([id, icon, label]) => (
                  <button
                    type="button"
                    className="wa-nav-button"
                    data-testid={'nav-' + id}
                    key={id}
                    aria-current={navPage === id ? 'page' : undefined}
                    aria-label={pageLabels[id]}
                    title={pageLabels[id]}
                    onClick={() => {
                      navigate(id); setMenuOpen(false);
                      if (window.matchMedia('(max-width: 800px)').matches) menuButton.current?.focus();
                    }}
                  >
                    <Glyph name={icon} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="wa-nav-footer">
            <div className="wa-status-line">
              <span className={'wa-status-dot ' + (status?.online ? 'is-online' : '')} />
              {status?.online ? '微信已连接' : status ? '微信未连接' : '正在连接'}
            </div>
            <span>v{status?.version || '…'}</span>
          </div>
        </aside>
        <main className="wa-workspace" ref={workspaceRef}>
          <div className="wa-workspace-chrome">
            <div className="wa-breadcrumb" aria-label="当前位置">
              <span>{sectionLabel}</span>
              {page !== navPage && <>
                <span className="wa-breadcrumb-divider" aria-hidden="true">/</span>
                <span>{pageLabels[navPage]}</span>
              </>}
              {page === 'recovery' && (
                <>
                  <span className="wa-breadcrumb-divider" aria-hidden="true">/</span>
                  <span>发送恢复</span>
                </>
              )}
              {page !== navPage && page !== 'recovery' && <>
                <span className="wa-breadcrumb-divider" aria-hidden="true">/</span>
                <span>{pageLabels[page] || '工作台'}</span>
              </>}
              {page === navPage && <>
                <span className="wa-breadcrumb-divider" aria-hidden="true">/</span>
                <span>{pageLabels[page]}</span>
              </>}
              {page === 'memory' && memoryTab === 'review' && (
                <>
                  <span className="wa-breadcrumb-divider" aria-hidden="true">
                    /
                  </span>
                  <span>记忆维护</span>
                </>
              )}
            </div>
            <div className="wa-wb-actions">
              {status?.localPreview && <span className="wa-local-preview">本地审阅 · 未发布</span>}
            </div>
          </div>
          {warning && (
            <div className="wa-alert is-error" role="alert">
              <div className="wa-between">
                <span>{warning}</span>
                <Button quiet disabled={!!busy} icon="refresh" onClick={() => action('status')}>
                  重新读取
                </Button>
              </div>
            </div>
          )}
          {content}
        </main>
      </div>
    </div>
  );
}
