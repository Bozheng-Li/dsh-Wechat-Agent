import { useEffect, useState } from 'react';
import { useWorkbench } from '../../hooks/use-workbench.mjs';
import { Button } from '../../components/button.jsx';
import { PageHead, Empty, StateBadge } from '../../components/page-ui.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { Glyph } from '../../components/glyph.jsx';

const states = { queued: '等待执行', running: '正在执行', succeeded: '本轮执行已结束', partial: '部分完成', failed: '执行失败', cancelled: '已取消', interrupted: '执行中断' };
const deliveries = { 'not-ready': '尚无结果', 'not-sent': '未发送', pending: '等待回传', sending: '等待微信回执', sent: '微信已确认', failed: '回传失败', unknown: '回传结果不明', partial: '部分已确认', suppressed: '未回传' };
const toolLabels = { wechat_work_read: '读取文件', wechat_work_write: '写入文件', wechat_work_list: '查看目录', wechat_work_exec: '执行命令', wechat_work_ssh_connect: '验证 SSH', wechat_work_ssh_exec: '执行远端命令', wechat_work_vscode_connect: '请求 VS Code 连接', wechat_work_status: '查询实际状态', wechat_work_output: '登记回传成果', wechat_work_generate_image: '调用生图 API' };
export function WorkPage({ rpc, status }) {
  const work = useWorkbench(rpc, status.account?.id, 'work.list');
  const [selected, setSelected] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  useEffect(() => { if (work.data?.capacity) setMaxConcurrent(work.data.capacity.maxConcurrent); }, [work.data?.capacity?.maxConcurrent]);
  useEffect(() => {
    const timer = setInterval(() => { void work.refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [status.account?.id]);
  const jobs = work.data?.jobs ?? [], job = jobs.find(value => value.id === selected) ?? jobs[0];
  const canRetryFiles = job && !['queued', 'running'].includes(job.state) && !['pending', 'sending'].includes(job.delivery.state) &&
    job.result?.artifacts?.some(artifact => !job.delivery.artifacts?.some(value => value.path === artifact.path && value.sha256 === artifact.sha256 && value.state === 'sent'));
  return <>
    <PageHead icon="work" title="工作任务" description="查看执行进度、任务成果与微信回传结果。">
      <Button quiet icon="refresh" disabled={work.busy || !status.account?.id} onClick={work.refresh}>刷新</Button>
    </PageHead>
    {work.error && <div className="wa-alert is-error" role="alert">{work.error}</div>}
    <div className="wa-work-toolbar" data-testid="work-capacity">
      <div className="wa-work-queue" role="status"><span><strong>{work.data?.capacity?.running ?? 0}</strong> 执行中</span><span><strong>{work.data?.capacity?.queued ?? 0}</strong> 排队中</span></div>
      <div className="wa-work-capacity-controls"><label htmlFor="wa-work-concurrency">并行上限</label>
      <select id="wa-work-concurrency" className="wa-select" disabled={work.busy || !status.account?.id} value={maxConcurrent} onChange={event => setMaxConcurrent(Number(event.target.value))}>
        {Array.from({ length: 8 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} 个</option>)}
      </select>
      <Button disabled={work.busy || work.loading || !status.account?.id || maxConcurrent === work.data?.capacity?.maxConcurrent} onClick={() => work.execute('work.configure', { maxConcurrent })}>保存</Button>
      </div>
    </div>
    {!jobs.length ? <Empty icon="work" title={!status.account?.id ? '先连接微信账号' : work.loading ? '正在读取工作任务' : '还没有工作任务'} description={!status.account?.id ? '连接后即可查看当前账号的任务与成果。' : '在已授权会话开启工作模式，直接说“帮我写一个 Python 脚本并运行”。群聊需要代码成员或管理员授权；SSH／VS Code 连接仅限管理员。'} /> : <>
      <div className="wa-work-detail" data-state={job.state}>
        <div className="wa-work-selection"><div><label htmlFor="wa-work-job">当前任务</label><span>{jobs.length} 个任务</span></div>
        <select id="wa-work-job" className="wa-select" value={job.id} onChange={event => setSelected(event.target.value)}>
          {jobs.map(value => <option key={value.id} value={value.id}>{value.request.slice(0, 60)} · {states[value.state]}</option>)}
        </select>
        </div>
        <div className="wa-work-summary">
        <div className="wa-work-status-line"><div className="wa-work-state"><span className="wa-work-status-label">执行状态</span>
          <StateBadge state={job.state === 'succeeded' ? 'sent' : job.state} label={states[job.state]} />
        </div>
        <div className="wa-work-delivery"><span className="wa-work-status-label">微信回传</span><StateBadge state={job.delivery.state} label={deliveries[job.delivery.state]} /></div>
        {['queued', 'running'].includes(job.state) && <Button quiet disabled={work.busy} onClick={() => work.execute('work.cancel', { id: job.id })}>取消任务</Button>}</div>
        {job.delivery.reason && <p className="wa-help">{job.delivery.reason}</p>}
        {job.progress && <p className="wa-work-progress">最近进度：{job.progress.text || job.progress.error?.message || '本次检查未取得进度'}<span className="wa-help"> · {deliveries[job.progress.state] || '检查未完成'}</span></p>}
        {canRetryFiles && <div className="wa-work-retry">
          <Button disabled={work.busy || work.loading} data-testid="work-retry-files" onClick={() => work.execute('work.retryDelivery', {
            id: job.id, expectedUpdatedAt: job.updatedAt, expectedRetryCount: job.delivery.retryAttempts?.length ?? 0, confirmedNotReceived: true,
          })}>确认未收到并补发文件</Button>
          <p className="wa-help">使用任务中已有的图片或文件，保留已确认的文字和文件回执。点击前请核对微信中的实际收件情况。</p>
        </div>}
        {!!job.delivery.retryAttempts?.length && <p className="wa-help">文件补发记录：{job.delivery.retryAttempts.length} 次，最近一次{deliveries[job.delivery.retryAttempts.at(-1).state] || '已停止'}。</p>}
        {job.error && <div className={'wa-alert' + (job.state === 'partial' ? '' : ' is-error')} role="alert">{job.error.message}</div>}
        </div>
        <section className="wa-work-section wa-work-request"><h3><Glyph name="chat" />任务要求</h3><pre className="wa-work-content">{job.request}</pre></section>
        {job.result?.text && <section className="wa-work-section wa-work-result"><h3><Glyph name="check" />任务结果</h3><pre className="wa-work-content">{job.result.text}</pre></section>}
        {!!job.result?.artifacts?.length && <section className="wa-work-section"><h3><Glyph name="folder" />微信回传成果<span>{job.result.artifacts.length}</span></h3><table className="wa-table wa-work-artifacts" data-testid="work-artifacts"><thead><tr><th scope="col">成果</th><th scope="col">方式</th><th scope="col">微信送达</th></tr></thead><tbody>{job.result.artifacts.map(file => {
          const delivery = job.delivery.artifacts?.find(value => value.path === file.path);
          return <tr key={file.path}><td><div className="wa-work-file-name"><Glyph name={file.kind === 'image' ? 'image' : 'folder'} /><span>{file.name}</span></div></td><td>{file.kind === 'image' ? '图片' : '文件附件'}</td><td><StateBadge state={delivery?.state} label={deliveries[delivery?.state] || '等待回传'} />{delivery?.serverMessageId && <small className="wa-work-receipt">{delivery.serverMessageId}</small>}</td></tr>;
        })}</tbody></table></section>}
        <details className="wa-work-metadata">
          <summary>任务信息</summary>
          <p className="wa-help">任务编号：{job.id}{job.createdAt ? ' · ' + formatTime(job.createdAt) : ''}</p>
          <p>会话：{job.peerId} · 发起人：{job.senderName || job.senderId}</p>
          <p className="wa-help" style={{ overflowWrap: 'anywhere' }}>执行目录：{job.cwd}</p>
          {job.sessionId && <p className="wa-help" style={{ overflowWrap: 'anywhere' }}>DSH 会话：{job.sessionId}</p>}
          {job.sessionHistory && <p className="wa-help">{job.sessionHistory.state === 'visible' ? '原始要求、结果和工具记录已保留在 DSH 历史会话。' : job.sessionHistory.message}</p>}
          <p className="wa-help">继续修改：/work continue {job.id} 修改要求</p>
        </details>
        <details className="wa-work-log">
        <summary>查看完整执行记录（{job.operations.length} 次操作）{job.warnings?.length ? ` · ${job.warnings.length} 次尝试未成功` : ''}</summary>
        {!job.operations.length && <p className="wa-muted">尚无工具操作，未验证运行结果。</p>}
        {job.operations.map((op, index) => <div className="wa-work-operation" data-state={op.result.cancelled ? 'cancelled' : op.result.stage === 'vscode-requested' ? 'submitted' : op.result.ok ? 'done' : 'failed'} key={index}>
          <div className="wa-work-operation-title"><span className="wa-work-operation-index">{String(index + 1).padStart(2, '0')}</span><strong>{toolLabels[op.tool] || op.tool}</strong><span>{' · '}{op.result.cancelled ? '已取消' : op.result.stage === 'vscode-requested' ? '请求已提交' : op.result.ok ? '完成' : '失败'}</span></div>
          {(op.alias || op.path || op.command) && <pre className="wa-work-content">{[op.alias, op.path || op.command].filter(Boolean).join('\n')}</pre>}
          {op.result.connectedConfirmed === false && <p className="wa-help">尚未确认编辑器连接就绪。</p>}
          {op.tool === 'wechat_work_generate_image' && op.result.model && <p className="wa-help">生图接口：{op.result.providerName || op.result.providerId || '默认接口'} · 模型：{op.result.model}</p>}
          {op.result.exitCode !== undefined && <p>退出码：{op.result.exitCode}{op.result.timedOut ? '（超时）' : ''}</p>}
          {op.result.steps?.length > 0 && <ol className="wa-help">{op.result.steps.map((step, index) => <li key={index}>{step.name}：{step.ok ? '已通过' : '未通过'}{step.exitCode === undefined ? '' : `（退出码 ${step.exitCode}）`}</li>)}</ol>}
          {op.result.sandbox && <p className="wa-help">DSH 执行权限：{op.result.sandbox.mode === 'danger-full-access' ? '完全权限' : op.result.sandbox.mode === 'read-only' ? '只读' : '工作空间写入'}{op.result.sandbox.mode === 'danger-full-access' ? '' : ' · ' + (op.result.sandbox.enforcement === 'partial' ? '平台报告部分保护' : op.result.sandbox.enforcement === 'full' ? '平台报告完整保护' : '保护程度未报告')}</p>}
          {[op.result.message, op.result.text, op.result.stdout, op.result.stderr].some(Boolean) && <pre className="wa-work-content">{[op.result.message, op.result.text, op.result.stdout, op.result.stderr].filter(Boolean).join('\n')}</pre>}
          {(op.result.stdoutTruncated || op.result.stderrTruncated || op.result.textTruncated) && <p className="wa-help">输出已截短；命令输出仅保留末尾。</p>}
        </div>)}
        </details>
        {(!!job.result?.files?.length || !!job.imageArchives?.length) && <details className="wa-work-metadata wa-work-files"><summary>本机文件与图片存档</summary>
        {!!job.result?.files?.length && <><h3>目录内文件</h3><ul>{job.result.files.map(file => <li key={file.path}>{file.path} · {file.bytes} B</li>)}</ul></>}
        {!!job.imageArchives?.length && <><h3>主目录图片存档</h3><p className="wa-help">工作主目录：{job.workspaceRoot}</p><ul data-testid="work-image-archives">{job.imageArchives.map(image =>
          <li key={image.sourcePath + ':' + image.sha256}>{image.path} · {image.state === 'saved' ? '已保存' : image.error?.message || '保存失败，原任务文件保留'}</li>)}</ul></>}
        </details>}
      </div>
    </>}
  </>;
}
