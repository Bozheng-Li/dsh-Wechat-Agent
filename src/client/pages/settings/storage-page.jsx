import { Glyph } from '../../components/glyph.jsx';
import { PageHead, Notice, Back } from '../../components/page-ui.jsx';
import { Field, FormActions } from '../../components/form-ui.jsx';

export function StorageSettings({
  status,
  draft,
  blocked,
  busy,
  dirty,
  notice,
  onChange,
  onSave,
  onReset,
  onBack,
  backLabel,
}) {
  const storage = status.storage || {};
  const directories = [
    ['workspacePath', 'Agent 工作空间'],
    ['recordsPath', '会话记录'],
    ['memoryPath', '记忆资料'],
    ['assetsPath', '表情与图片素材'],
    ['tasksPath', '定时任务'],
    ['loginPath', '微信登录资料'],
    ['cachePath', '缓存'],
  ];
  return (
    <>
      <Back label={backLabel} onClick={onBack} />
      <PageHead title="全局工作目录" description="只需设置一个目录，插件会自动管理各类数据的保存位置。" />
      <Notice notice={notice} area="storage" />
      <div className="wa-stack wa-content-narrow">
        <form
          className="wa-card"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <div className="wa-card-heading">
            <div>
              <h2>插件数据的统一位置</h2>
              <p className="wa-muted">填写本机可写入的绝对目录路径。</p>
            </div>
            <div className="wa-card-icon">
              <Glyph name="folder" />
            </div>
          </div>
          <Field
            label="全局工作目录"
            id="wa-base-path"
            help="工作空间、记录、记忆、素材、定时任务、登录资料和缓存都在此目录下自动管理。"
          >
            <input
              className="wa-input wa-mono"
              id="wa-base-path"
              value={draft.basePath}
              disabled={blocked}
              placeholder="例如：D:\WechatAgent"
              onChange={(event) => onChange({ ...draft, basePath: event.target.value })}
            />
          </Field>
          <div className="wa-note-box">
            <p>切换时先停止接收新的回复任务，等待当前任务收尾，再迁移所有插件数据；旧目录继续保留。</p>
            <p>迁移完成后使用新目录。保存失败时保留输入草稿，方便核对后重试。</p>
          </div>
          <details className="wa-subsection" data-testid="storage-derived-paths">
            <summary>查看自动管理的目录</summary>
            <p className="wa-help">以下为当前已应用的位置，由全局工作目录自动派生。</p>
            {directories.map(([key, label]) => (
              <div className="wa-subsection" key={key}>
                <h3>{label}</h3>
                <div className="wa-path-value" data-storage-path={key}>
                  {storage[key] || '正在读取保存位置'}
                </div>
              </div>
            ))}
          </details>
          <FormActions
            dirty={dirty}
            busy={busy === 'storage.save'}
            disabled={blocked}
            invalid={!draft.basePath.trim()}
            onReset={onReset}
            label="保存目录并应用"
          />
        </form>
        <section className="wa-card">
          <div className="wa-card-heading">
            <div>
              <h2>数据如何保存</h2>
              <p className="wa-muted">微信历史、插件记录与模型会话各有不同来源。</p>
            </div>
          </div>
          <div className="wa-note-box">
            <p>
              <strong>插件记录不等同于微信完整聊天历史。</strong>
            </p>
            <p>
              这里保存插件同步后观察到的消息与处理结果，最近 {storage.observedMessageLimit || 1000}{' '}
              条观察消息可用于上下文。微信客户端已有的全部历史不会自动导入。
            </p>
          </div>
          <div className="wa-subsection">
            <h3>DSH 原生 Agent 会话</h3>
            <p className="wa-help">模型会话与原生日志仍由 DSH 管理，插件保存对应会话的引用与独立记录。</p>
            <div className="wa-path-value">{storage.dshSessionPath || '由 DSH 统一管理'}</div>
          </div>
        </section>
      </div>
    </>
  );
}
