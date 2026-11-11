import { AdminPicker } from '../../components/admin-picker.jsx';
import { PageHead, Back, Notice } from '../../components/page-ui.jsx';
import { FormActions } from '../../components/form-ui.jsx';

export function AdministratorSettings({ rpc, status, draft, onChange, onSave, onReset, onBack, blocked, busy, notice, dirty }) {
  return <>
    <Back onClick={onBack} label="返回设置" />
    <PageHead icon="shield" title="管理员" description="管理微信成员对电脑状态与 DSH 任务的远程查询权限。" />
    <Notice notice={notice} area="administrators" />
    <form className="wa-settings-document wa-admin-settings" onSubmit={event => { event.preventDefault(); onSave(); }}>
      <div className="wa-card-heading"><div><h2>全局管理员</h2><p className="wa-muted">在已授权并开启远程查询的会话中生效。</p></div><span className="wa-badge">{draft.globalAdminIds.length} 位</span></div>
      <AdminPicker key={status.account?.id || 'offline'} rpc={rpc} accountId={status.account?.id} value={draft.globalAdminIds}
        onChange={ids => onChange({ ...draft, globalAdminIds: ids })} disabled={blocked || !!busy || !status.account} label="全局管理员" />
      <div className="wa-note-box"><p>保存名单后，在“会话授权 → 会话设置”开启远程查询。也可在那里添加仅对该会话生效的管理员。</p><p className="wa-help">没有管理员的会话不开放查询；名单只能在本机设置或 config.yaml 中修改。</p></div>
      <FormActions dirty={dirty} busy={busy} disabled={blocked || !status.account} onReset={onReset} label="保存全局管理员" />
    </form>
    <details className="wa-settings-block wa-content-narrow wa-data-details"><summary>微信查询用法</summary>
      <p>可以直接说“电脑现在忙不忙”“看看内存和磁盘”“DSH 任务跑到哪了”。Agent 判断要查什么，再读取实际状态；不需要记命令。</p>
      <p className="wa-help">群聊查询也可以直接发送这些文字；权限仍以这条消息的真实发送者 ID 和会话开关为准。意思不清楚时会先询问。</p>
      <h3>可选查询指令</h3>
      <p><code>/pc status</code> 查看 CPU、内存、磁盘和 DSH Host 状态。</p>
      <p><code>/dsh tasks</code> 查看当前已加载的 DSH 任务。</p>
      <p><code>/dsh task &lt;完整编号&gt;</code> 查看指定任务；查询不会暂停或重新启动任务。</p>
    </details>
  </>;
}
