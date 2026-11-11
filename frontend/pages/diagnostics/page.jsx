import { useEffect } from 'react';
import { formatTime } from "../../shared/conversations.mjs";
import { Button, Tag, Heading, Feedback, Offline } from "../../components/workbench-ui.jsx";
import { useWorkbench } from "../../hooks/use-workbench.mjs";
import { Glyph } from '../../components/glyph.jsx';

export function DiagnosticsPage({ rpc, status, onNavigate }) {
  const statusKey = JSON.stringify([
    status.online,
    status.good,
    status.state,
    status.runtimeReady,
    status.imageUploadReady,
    status.model,
    status.modelConfig,
    status.search,
  ]);
  const state = useWorkbench(rpc, status.account?.id, 'diagnostics.get', statusKey),
    checks = state.data?.checks || [];
  const passed = checks.filter(item => item.state === 'passed').length;
  useEffect(() => {
    const timer = setInterval(() => {
      void state.refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [status.account?.id]);
  return (
    <section className="wa-wb-page wa-diagnostics-page" data-testid="diagnostics-page">
      <Heading icon="spark" title="运行检查" text="检查微信连接、模型与已启用的能力，查看实际结果。">
        <Button disabled={state.busy || !status.account} onClick={() => state.execute('diagnostics.run')}>
          {state.busy ? '正在逐项检查…' : '检查现在能做什么'}
        </Button>
        {state.busy && (
          <Button quiet onClick={state.cancel}>
            取消检查
          </Button>
        )}
      </Heading>
      <Feedback state={state} cancellable={false} />
      <Offline status={status}>
        <div className="wa-diagnostics-summary">
          <div>
            <span>最近检查</span>
            <strong>{state.data?.finishedAt ? formatTime(state.data.finishedAt) : '—'}</strong>
          </div>
          <div>
            <span>验证范围</span>
            <strong>连接 · 模型 · 搜索 · 图片</strong>
          </div>
          <Tag state={!state.data?.finishedAt || state.data?.stale ? 'draft' : checks.some(item => item.state === 'failed') ? 'failed' : checks.length > 0 && passed === checks.length ? 'passed' : 'partial'}>
            {!state.data?.finishedAt ? '尚未检查' : state.data?.stale ? '需要重新检查' : `${passed} / ${checks.length} 项通过`}
          </Tag>
        </div>
        <div className="wa-diagnostics-list">
          {(checks.length
            ? checks
            : ['微信连接', '聊天模型', '联网搜索', '图片发送条件'].map((title, index) => ({
                id: ['wechat', 'model', 'search', 'image'][index],
                title,
                state: 'draft',
                detail: '点击上方按钮，开始实际检查。',
              }))
          ).map((item) => (
            <article className="wa-diagnostics-row" key={item.id} data-state={item.state}>
              <span className="wa-diagnostics-mark" aria-hidden="true"><Glyph name={item.state === 'passed' ? 'check' : item.state === 'failed' ? 'close' : 'clock'} /></span>
              <div className="wa-diagnostics-content">
                <div className="wa-wb-between"><h2>{item.title}</h2><Tag state={item.state} /></div>
                <p>{item.error?.message || item.detail}</p>
              </div>
              <footer>
                <span>{item.checkedAt ? formatTime(item.checkedAt) : '未验证'}</span>
                {item.state !== 'passed' && <Button quiet onClick={() => onNavigate(item.action || (item.id === 'wechat' ? 'overview' : 'model'))}>
                  查看设置
                </Button>}
              </footer>
            </article>
          ))}
        </div>
        <p className="wa-wb-note">
          检查会向已配置的模型与搜索服务发送最小测试请求，可能产生相应服务用量。图片项只核对组件和参数，不向微信会话发送消息。
        </p>
      </Offline>
    </section>
  );
}
