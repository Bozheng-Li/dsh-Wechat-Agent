import { useEffect, useState } from 'react';
import { formatTime } from "../../shared/conversations.mjs";
import { Button } from "../../components/button.jsx";
import { Field } from "../../components/form-ui.jsx";
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

export function NaturalChatSettings({ draft, blocked, onChange, status, error, onResume }) {
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  useEffect(() => {
    setResumeConfirmed(false);
  }, [status?.deliveryBlockedKey]);
  const change = (key, value) => onChange({ ...draft, [key]: value });
  return (
    <div className="wa-subsection wa-natural-settings" data-testid="natural-chat-settings">
      <h2>参与群聊</h2>
      <p className="wa-help">
        触发条件只提供机会，是否值得开口由同一轮模型判断；没有新话题也可以保持安静。
      </p>
      <p className="wa-help">冷场间隔、连续对话窗口和活跃时段统一在“设置 → 时间设置”中修改，可选择此群单独设置。</p>
      <fieldset className="wa-field" data-testid="participation-triggers">
        <legend className="wa-field-label">允许哪些参与机会</legend>
        {[
          ['messageEnabled', '按新消息参与', '累计下方指定条数后判断，不是每达到条数就必须发言。'],
          ['timerEnabled', '允许冷场主动开口', '群内安静达到时间设置后判断；不要求有新消息，也可以跳过。'],
          ['followupEnabled', '允许接续刚才的对话', '在连续对话窗口内判断相关回应，不必等满新消息条数。'],
        ].map(([key, label, help]) => <div key={key}>
          <label className="wa-check-row"><input type="checkbox" aria-label={label} checked={draft[key]}
            disabled={blocked} onChange={event => change(key, event.target.checked)} /><span>{label}</span></label>
          <p className="wa-help">{help}</p>
        </div>)}
      </fieldset>
      {!draft.messageEnabled && !draft.timerEnabled && !draft.followupEnabled &&
        <p className="wa-help">当前只响应 @、/agent 和昵称唤醒，不自动参与。</p>}
      <div className="wa-natural-basics">
      <Field
        label="参与倾向"
        id="wa-natural-temperament"
        help="决定有机会时是否主动开口；表达方式沿用全局助手设定。"
      >
        <select
          className="wa-select"
          id="wa-natural-temperament"
          value={draft.temperament}
          disabled={blocked}
          onChange={(event) => change('temperament', event.target.value)}
        >
          <option value="quiet">安静 · 有合适的话再说</option>
          <option value="balanced">自然 · 有合适内容再接话</option>
          <option value="lively">活跃 · 更积极地参与</option>
        </select>
      </Field>
      </div>
      <label className="wa-check-row wa-section-space">
        <input
          type="checkbox"
          aria-label="参与群聊智能跳过"
          checked={draft.smartSkip}
          disabled={blocked}
          onChange={(event) => change('smartSkip', event.target.checked)}
        />
        <span>智能跳过不合适或重复的话题</span>
      </label>
      <p className="wa-help">关闭后更愿意接话，但无合适内容仍可跳过；活跃时段、冷却与无人回应限制仍生效。@、/agent 和昵称唤醒始终优先回复。</p>
      <details className="wa-subsection">
        <summary>连续对话与发言分寸</summary>
        <div className="wa-natural-limits">
        <Field
          label="连续无人接话后暂停（次）"
          id="wa-natural-unanswered"
          help="只累计微信已确认的主动发言；群里有新互动后重新评估。"
        >
          <input
            className="wa-input"
            id="wa-natural-unanswered"
            type="number"
            min="1"
            max="5"
            step="1"
            value={draft.maxUnanswered}
            disabled={blocked}
            onChange={(event) => change('maxUnanswered', event.target.value)}
          />
        </Field>
        </div>
      </details>
      {error && (
        <p className="wa-alert" role="alert">
          {error}
        </p>
      )}
      {status && (
        <div className="wa-note-box" data-testid="natural-chat-status" role="status">
          <p>
            <strong>
              {status.paused ? '主动参与已暂停' : status.pending ? '正在判断或等待发言' : '等待下一次参与机会'}
            </strong>
          </p>
          {status.reason && <p>{status.reason}</p>}
          {status.nextCheckAt && <p className="wa-schedule-time"><span>下一次冷场判断：{formatTime(status.nextCheckAt, true)}</span>
            <ScheduleCountdown at={status.nextCheckAt} running={status.pending} paused={status.paused} action="判断" /></p>}
          <p className="wa-help">
            连续无人接话：{status.unanswered} 次。{status.followupUntil ? '正在接续相关对话。' : ''}
          </p>
          {status.deliveryBlockedKey && (
            <details className="wa-subsection" data-testid="natural-resume-review">
              <summary>核对发送结果后恢复</summary>
              <p className="wa-help">
                先在微信与处理记录核对此前的发送。恢复只安排新的参与机会，原记录和真实回执继续保留。
              </p>
              <label className="wa-check-row">
                <input
                  type="checkbox"
                  aria-label="已核对群聊参与发送结果"
                  checked={resumeConfirmed}
                  disabled={blocked}
                  onChange={(event) => setResumeConfirmed(event.target.checked)}
                />
                <span>我已核对，允许此群恢复主动参与</span>
              </label>
              <Button
                disabled={blocked || !resumeConfirmed}
                onClick={async () => {
                  if (await onResume(status.deliveryBlockedKey)) setResumeConfirmed(false);
                }}
              >
                恢复主动参与
              </Button>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
