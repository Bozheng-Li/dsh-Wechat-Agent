import { PageHead, Notice, Back } from "../../components/page-ui.jsx";
import { Field, FormActions } from "../../components/form-ui.jsx";

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
    ['workspacePath', '工作空间总目录'],
    ['agentWorkspacePath', '微信 Agent 工作区'],
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
            <p>保存后等待当前任务收尾，再迁移到新目录；旧目录和失败时的输入草稿保留。</p>
          </div>
          <details className="wa-subsection" data-testid="storage-derived-paths">
            <summary>查看自动管理的目录</summary>
            <p className="wa-help">以下为当前已应用的位置，由全局工作目录自动派生。</p>
            <dl className="wa-storage-path-list">
            {directories.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd className="wa-path-value" data-storage-path={key}>
                  {storage[key] || '正在读取保存位置'}
                </dd>
              </div>
            ))}
            </dl>
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
        <details className="wa-card wa-data-details">
          <summary>数据来源与保存方式</summary>
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
            <p className="wa-help">内部微信会话归入工作空间总目录下的“微信agent”；工作任务使用各自的独立目录。生成图片另存于“微信agent/generated-images/任务编号”，原任务文件保留。模型会话日志由 DSH 管理。</p>
            <div className="wa-path-value">{storage.dshSessionPath || '由 DSH 统一管理'}</div>
          </div>
        </details>
      </div>
    </>
  );
}
