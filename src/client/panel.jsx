import { css } from './styles/base.mjs';
import { MotionControl } from './components/visuals.jsx';
import { pageLabels } from './shared/labels.mjs';
import { Glyph } from './components/glyph.jsx';
import { Button } from './components/button.jsx';
import { usePanel } from './hooks/use-panel.mjs';
import { PanelContent } from './page-content.jsx';

export function WechatPanel({ connection, catalog }) {
  const state = usePanel(connection);
  const { motion, status, page, memoryTab, busy, workspaceRef, action, navigate, navPage, warning } = state;
  const content = <PanelContent connection={connection} catalog={catalog} state={state} />;
  return (
    <div className="wa-panel" data-motion={motion.enabled ? 'on' : 'off'} data-page={page}>
      <style>{css}</style>
      <div className="wa-shell">
        <aside className="wa-nav" aria-label="微信 Agent 导航">
          <div className="wa-brand">
            <div className="wa-brand-mark">
              <Glyph name="chat" />
            </div>
            <div>
              <strong>微信 Agent</strong>
              <small>CONVERSATIONS</small>
            </div>
          </div>
          <nav className="wa-nav-list">
            {[
              [
                '会话工作',
                [
                  ['overview', 'grid', '概览'],
                  ['authorization', 'people', '会话'],
                  ['records', 'history', '记录'],
                  ['digests', 'history', '群聊简报'],
                  ['tasks', 'history', '定时任务'],
                ],
              ],
              [
                '记忆与素材',
                [
                  ['memory', 'folder', '记忆库'],
                  ['assets', 'image', '素材'],
                ],
              ],
              [
                '运行与设置',
                [
                  ['diagnostics', 'grid', '运行检查'],
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
                    onClick={() => navigate(id)}
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
            <span>DeepSeek Harness 插件</span>
          </div>
        </aside>
        <main className="wa-workspace" ref={workspaceRef}>
          <div className="wa-workspace-chrome">
            <div className="wa-breadcrumb" aria-label="当前位置">
              <span>微信 Agent</span>
              <span className="wa-breadcrumb-divider" aria-hidden="true">
                /
              </span>
              {page === 'recovery' && (
                <>
                  <span>处理记录</span>
                  <span className="wa-breadcrumb-divider" aria-hidden="true">
                    /
                  </span>
                </>
              )}
              <span>{pageLabels[page] || '工作台'}</span>
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
              <MotionControl motion={motion} />
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
          <footer className="wa-footer">
            <span>微信 Agent {status?.version || ''}</span>
            <span>每个会话，各自的上下文</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
