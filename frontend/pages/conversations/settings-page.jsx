import { validateNaturalSettings } from "../../../shared/contracts.mjs";
import { initials, peerName, peerType } from "../../shared/conversations.mjs";
import { naturalPayload } from "../../shared/drafts.mjs";
import { Glyph } from "../../components/glyph.jsx";
import { Button } from "../../components/button.jsx";
import { PageHead, Empty, Notice, Back } from "../../components/page-ui.jsx";
import { Field, FormActions } from "../../components/form-ui.jsx";
import { NaturalChatSettings } from "./natural-settings.jsx";
import { AdminPicker } from '../../components/admin-picker.jsx';

export function ConversationSettings({
  rpc,
  peer,
  draft,
  status,
  blocked,
  busy,
  notice,
  dirty,
  onChange,
  onSave,
  onReset,
  onBack,
  onNavigate,
  onRecords,
  onRevoke,
  onResumeNatural,
}) {
  if (!peer || !draft) return <Empty title="选择一个会话" description="从会话授权中打开会话设置。" />;
  const group = peerType(peer) === 'group',
    minimum = Number(draft.minMessages),
    maximum = Number(draft.maxMessages),
    fixed = Number(draft.fixedMessages);
  const rangeInvalid =
    group &&
    (draft.intervalMode === 'fixed'
      ? !Number.isInteger(fixed) || fixed < 1 || fixed > 100
      : !Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum > 100 || minimum > maximum);
  const memorySize = draft.memoryWindowChars.trim() === '' ? null : Number(draft.memoryWindowChars);
  let naturalError = '';
  if (group && draft.mode === 'natural') {
    try {
      validateNaturalSettings(naturalPayload(draft.natural));
    } catch (error) {
      naturalError = error.message;
    }
  }
  const invalid =
    rangeInvalid ||
    !!naturalError ||
    (memorySize !== null && (!Number.isSafeInteger(memorySize) || memorySize < 1000));
  const names = [status.persona?.name || '微信助手', ...(status.persona?.aliases || [])].join('、');
  return (
    <>
      <Back label="返回会话授权" onClick={onBack} />
      <PageHead title="会话设置" description="为这个会话配置参与方式、记忆和定时任务，助手设定全局共用。">
        <Button icon="history" onClick={() => onRecords(peer)}>
          查看处理记录
        </Button>
      </PageHead>
      <Notice notice={notice} area="conversation" />
      <div className="wa-content-narrow">
        <form
          className="wa-card"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <div className="wa-card-heading">
            <div className="wa-detail-title">
              <div className={'wa-session-avatar ' + (group ? 'is-group' : '')}>{initials(peerName(peer))}</div>
              <div>
                <h2>{peerName(peer)}</h2>
                <p className="wa-muted">{group ? '群聊' : '私聊'}</p>
              </div>
            </div>
            <span className="wa-badge">{peer.authorized ? '已授权' : '仅保留历史'}</span>
          </div>
          <div className="wa-subsection">
            <h2>会话管理员与远程查询</h2>
            <label className="wa-check-label"><input id="wa-remote-enabled" type="checkbox" checked={draft.remoteEnabled}
              disabled={blocked || !peer.authorized} onChange={event => onChange({ ...draft, remoteEnabled: event.target.checked })} />允许此会话远程查询</label>
            <p className="wa-help">开启后，全局管理员和本会话管理员可查询电脑及 DSH 任务。全局管理员：{status.remote?.globalAdminIds?.length || 0} 位。</p>
            {!draft.remoteEnabled && (draft.adminIds.length || status.remote?.globalAdminIds?.length) > 0 &&
              <p className="wa-help" role="status">已选管理员，但此会话的远程查询仍关闭；开启上方开关并保存后才能查询。</p>}
            {group && <p className="wa-help">群聊查询结果会发送到这个群；请确认群成员可以查看这些信息。</p>}
            <AdminPicker rpc={rpc} accountId={status.account?.id} peer={peer} value={draft.adminIds}
              label="会话管理员" disabled={blocked || !!busy || !peer.authorized} onChange={ids => onChange({ ...draft, adminIds: ids })} />
          </div>
          <div className="wa-subsection">
            <h2>执行方式</h2>
            <Field label="聊天或工作" id="wa-execution-mode" help="工作模式允许已授权管理员发起任务，其他成员继续按会话回复模式聊天。">
              <select id="wa-execution-mode" className="wa-select" value={draft.executionMode} disabled={blocked || !peer.authorized}
                onChange={event => onChange({ ...draft, executionMode: event.target.value })}>
                <option value="chat">聊天模式</option><option value="work">工作模式</option>
              </select>
            </Field>
            <p className="wa-help">需要开启远程查询并保存设置。切回聊天模式会取消此会话正在进行的工作，文件保留。</p>
            <details className="wa-mode-guide">
              <summary>微信操作与任务文件</summary>
              <p className="wa-help">管理员可直接说“切换到工作模式”“切回聊天模式”，也可使用 /mode work、/mode chat 或 /mode status。只切换当前会话。</p>
              <p className="wa-help">普通工作追加到当前任务；/work new 主动新开。结果、文件和图片回传到发起会话，原文件保存在本机。</p>
              <Button quiet onClick={() => onNavigate('work')}>查看工作任务</Button>
            </details>
          </div>
          <div className="wa-subsection wa-conversation-persona-link" data-testid="conversation-global-persona">
            <div><h2>全局助手</h2>
            <p className="wa-help">{status.persona?.name || '微信助手'} · 名字、唤醒词和设定由所有会话共用。</p></div>
            <Button quiet data-testid="edit-global-persona" onClick={() => onNavigate('persona', 'conversation')}>
              编辑全局助手设定<Glyph name="arrow" className="wa-icon-small" />
            </Button>
          </div>
          {group ? (
            <>
              <fieldset className="wa-field wa-mode-fieldset">
                <legend className="wa-field-label">回复模式</legend>
                <div className="wa-radio-list" role="radiogroup" aria-label="群聊回复模式">
                  {[
                    ['default', '默认回复', '群内 @ 当前微信账号，或以 /agent 开头提问时回复。'],
                    ['nickname', '昵称唤醒', '在默认回复基础上，增加 Agent 名字与昵称唤醒。'],
                    ['participate', '主动参与', '保留 @、/agent 和昵称的立即回应，再按消息条数主动加入聊天。'],
                    [
                      'natural',
                      '自然陪聊',
                      '保留全部唤醒与数量设置，按时间和话题择机发言，能接后续，也会在无人回应时退让。',
                    ],
                  ].map(([value, label, description]) => (
                    <label key={value} className="wa-mode-option">
                      <input
                        type="radio"
                        name="wa-group-mode"
                        value={value}
                        checked={draft.mode === value}
                        disabled={blocked || !peer.authorized}
                        onChange={() => onChange({ ...draft, mode: value })}
                      />
                      <span>
                        <strong>{label}</strong>
                        <small>{description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {draft.mode !== 'default' && (
                <div className="wa-note-box">
                  <p>
                    {dirty ? '保存后识别：' : '当前识别：'}
                    <strong>{names || '请在全局助手中填写名字'}</strong>
                  </p>
                </div>
              )}
              {draft.mode === 'natural' && (
                <NaturalChatSettings
                  draft={draft.natural}
                  blocked={blocked}
                  onChange={(natural) => onChange({ ...draft, natural })}
                  status={peer.config?.mode === 'natural' ? peer.naturalStatus : null}
                  error={naturalError}
                  onResume={onResumeNatural}
                />
              )}
              {['participate', 'natural'].includes(draft.mode) && (
                <div className="wa-note-box">
                  <p>
                    <strong>每个群独立计数</strong>
                  </p>
                  <p>
                    普通新消息按条数累计。有人直接点名时立即回应，并重新开始主动参与计数。
                    {draft.mode === 'natural' ? '达到条数后判断是否适合接话，与时间机会合并。' : ''}
                  </p>
                  <Field
                    label={draft.mode === 'natural' ? '按条数检查接话' : '按条数主动参与'}
                    help={
                      draft.mode === 'natural'
                        ? '与时间检查共用一次参与判断和发言冷却；同时达到条件时合并，不额外发送两条。'
                        : undefined
                    }
                  >
                    <select
                      className="wa-select"
                      aria-label="主动参与间隔模式"
                      value={draft.intervalMode}
                      disabled={blocked}
                      onChange={(event) => onChange({ ...draft, intervalMode: event.target.value })}
                    >
                      <option value="random">在消息条数区间内随机</option>
                      <option value="fixed">固定消息条数</option>
                    </select>
                  </Field>
                  <div className="wa-number-range">
                    <span>每</span>
                    {draft.intervalMode === 'fixed' ? (
                      <input
                        className="wa-input"
                        aria-label="主动参与固定消息数"
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        value={draft.fixedMessages}
                        disabled={blocked}
                        onChange={(event) => onChange({ ...draft, fixedMessages: event.target.value })}
                      />
                    ) : (
                      <>
                        <input
                          className="wa-input"
                          aria-label="主动参与最少消息数"
                          type="number"
                          min="1"
                          max="100"
                          step="1"
                          value={draft.minMessages}
                          disabled={blocked}
                          onChange={(event) => onChange({ ...draft, minMessages: event.target.value })}
                        />
                        <span>—</span>
                        <input
                          className="wa-input"
                          aria-label="主动参与最多消息数"
                          type="number"
                          min="1"
                          max="100"
                          step="1"
                          value={draft.maxMessages}
                          disabled={blocked}
                          onChange={(event) => onChange({ ...draft, maxMessages: event.target.value })}
                        />
                      </>
                    )}
                    <span>{draft.mode === 'natural' ? '条消息判断一次' : '条消息参与一次'}</span>
                  </div>
                  <p className="wa-help">
                    均可设置为 1–100 的整数。
                    {['participate', 'natural'].includes(peer.config?.mode) && peer.progress
                      ? '当前累计 ' + (peer.progress.count || 0) + ' / ' + (peer.progress.target || '待开始') + ' 条。'
                      : ''}
                  </p>
                  {rangeInvalid && <p className="wa-alert">请检查消息条数和区间。</p>}
                </div>
              )}
            </>
          ) : (
            <p className="wa-help">直接处理这个授权联系人的消息，使用此会话自己的记忆。</p>
          )}
          <div className="wa-subsection">
            <h2>会话记忆</h2>
            <Field
              label="记忆读取"
              id="wa-memory-mode"
              help="自动读取只带入与本轮相关的记忆；按需模式由 Agent 在提及往事、偏好或约定时查阅。近期对话仍用于接话，全局备注每轮提供共同背景与明确约定。"
            >
              <select
                className="wa-select"
                id="wa-memory-mode"
                value={draft.memoryMode}
                disabled={blocked}
                onChange={(event) => onChange({ ...draft, memoryMode: event.target.value })}
              >
                <option value="always">自动筛选相关记忆</option>
                <option value="on-demand">按需读取</option>
              </select>
            </Field>
            <Field
              label="记忆窗口字符数"
              id="wa-memory-window"
              help={
                '留空使用默认 ' +
                (status.memory?.windowChars || 100000) +
                ' 字符；至少 1000 字符，用于保存与整理记忆，不代表每轮全部读取。满窗口后台压缩，原文快照保留。'
              }
            >
              <input
                className="wa-input"
                id="wa-memory-window"
                aria-label="此会话记忆窗口字符数"
                type="number"
                min="1000"
                step="1"
                value={draft.memoryWindowChars}
                disabled={blocked}
                placeholder="跟随记忆库默认窗口"
                onChange={(event) => onChange({ ...draft, memoryWindowChars: event.target.value })}
              />
            </Field>
            <Button quiet onClick={() => onNavigate('memory', 'conversation')}>
              查看这个会话的记忆
            </Button>
          </div>
          <div className="wa-subsection">
            <h2>会话定时任务</h2>
            <label className="wa-check-row">
              <input
                type="checkbox"
                aria-label="允许会话创建定时任务"
                checked={draft.allowChatTasks}
                disabled={blocked}
                onChange={(event) => onChange({ ...draft, allowChatTasks: event.target.checked })}
              />
              <span>允许在聊天中安排提醒和定时任务</span>
            </label>
            <p className="wa-help">例如“小胖，一分钟后提醒我吃饭”。任务绑定当前会话和创建者，并在定时任务页显示。</p>
            <Button quiet onClick={() => onNavigate('tasks', 'conversation')}>
              查看或添加定时任务
            </Button>
          </div>
          <details className="wa-subsection">
            <summary>记录保存位置</summary>
            <p className="wa-help">会话记录由全局工作目录统一管理，按账号和会话分别保存。</p>
            <div className="wa-path-value">{peer.recordsPath || '正在读取保存位置'}</div>
            <Button quiet onClick={() => onNavigate('storage', 'conversation')}>
              查看全局工作目录
            </Button>
          </details>
          <FormActions
            dirty={dirty}
            busy={busy === 'conversation.configure'}
            disabled={blocked}
            invalid={invalid || !peer.authorized}
            onReset={onReset}
            label="保存会话设置"
            hint="修改参与方式后重新计数，已有记录和记忆继续保留。"
          />
        </form>
        {peer.authorized && (
          <div className="wa-between wa-section-space">
            <p className="wa-help">撤销授权后停止这个会话的回复和定时发送。</p>
            <Button quiet danger disabled={blocked} onClick={() => onRevoke(peer)}>
              撤销授权
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
