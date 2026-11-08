import { useEffect } from 'react';
import { formatTime } from '../../shared/conversations.mjs';
import { Button, Tag, Heading, Feedback, Offline } from '../../components/workbench-ui.jsx';
import { useWorkbench } from '../../hooks/use-workbench.mjs';

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
  useEffect(() => {
    const timer = setInterval(() => {
      void state.refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [status.account?.id]);
  return (
    <section className="wa-wb-page" data-testid="diagnostics-page">
      <Heading number="01" title="运行检查" text="让每一项能力，都有最近一次可核对的状态。">
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
        <div className="wa-wb-strip">
          <div>
            <span>最近检查</span>
            <strong>{state.data?.finishedAt ? formatTime(state.data.finishedAt) : '尚未检查'}</strong>
          </div>
          <div>
            <span>验证范围</span>
            <strong>连接 · 模型 · 搜索 · 图片</strong>
          </div>
          <Tag state={state.data?.stale ? 'draft' : 'passed'}>
            {state.data?.stale ? '需要重新检查' : '五分钟内的检查结果'}
          </Tag>
        </div>
        <div className="wa-wb-grid">
          {(checks.length
            ? checks
            : ['微信连接', '聊天模型', '联网搜索', '图片发送条件'].map((title, index) => ({
                id: index,
                title,
                state: 'draft',
                detail: '点击上方按钮，开始实际检查。',
              }))
          ).map((item, index) => (
            <article className="wa-wb-card wa-wb-capability" key={item.id}>
              <div className="wa-wb-between">
                <span className="wa-wb-number">0{index + 1}</span>
                <Tag state={item.state} />
              </div>
              <h2>{item.title}</h2>
              <p>{item.error?.message || item.detail}</p>
              <footer>
                <span>{item.checkedAt ? formatTime(item.checkedAt) : '未验证'}</span>
                <Button quiet onClick={() => onNavigate(item.action || (item.id === 'wechat' ? 'overview' : 'model'))}>
                  查看设置 ↗
                </Button>
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
