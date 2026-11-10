import { useEffect, useState } from 'react';
import { formatTime } from "../../shared/conversations.mjs";
import { Button } from "../../components/button.jsx";
import { Field } from "../../components/form-ui.jsx";

export function NaturalChatSettings({ draft, blocked, onChange, status, error, onResume }) {
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  useEffect(() => {
    setResumeConfirmed(false);
  }, [status?.deliveryBlockedKey]);
  const change = (key, value) => onChange({ ...draft, [key]: value });
  return (
    <div className="wa-subsection" data-testid="natural-chat-settings">
      <h2>自然陪聊</h2>
      <p className="wa-help">
        结合当前话题择机开口，有人接话时继续聊，无人回应时逐渐退让。
      </p>
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
          <option value="balanced">自然 · 偶尔接话和开话题</option>
          <option value="lively">活跃 · 更积极地参与</option>
        </select>
      </Field>
      <Field
        label="按时间检查开话题"
        id="wa-natural-interval"
        help="分钟数决定何时检查，不保证每次发言。已确认发言或完成判断后再计时；无人回应或跳过后自动延长。"
      >
        <select
          className="wa-select"
          id="wa-natural-interval"
          value={draft.intervalMode}
          disabled={blocked}
          onChange={(event) => change('intervalMode', event.target.value)}
        >
          <option value="random">在分钟区间内随机</option>
          <option value="fixed">固定分钟数</option>
        </select>
      </Field>
      <div className="wa-number-range">
        <span>每</span>
        {draft.intervalMode === 'fixed' ? (
          <input
            className="wa-input"
            aria-label="自然陪聊固定分钟数"
            type="number"
            min="1"
            max="1440"
            step="1"
            value={draft.fixedMinutes}
            disabled={blocked}
            onChange={(event) => change('fixedMinutes', event.target.value)}
          />
        ) : (
          <>
            <input
              className="wa-input"
              aria-label="自然陪聊最少分钟数"
              type="number"
              min="1"
              max="1440"
              step="1"
              value={draft.minMinutes}
              disabled={blocked}
              onChange={(event) => change('minMinutes', event.target.value)}
            />
            <span>—</span>
            <input
              className="wa-input"
              aria-label="自然陪聊最多分钟数"
              type="number"
              min="1"
              max="1440"
              step="1"
              value={draft.maxMinutes}
              disabled={blocked}
              onChange={(event) => change('maxMinutes', event.target.value)}
            />
          </>
        )}
        <span>分钟判断一次</span>
      </div>
      <label className="wa-check-row wa-section-space">
        <input
          type="checkbox"
          aria-label="自然陪聊智能跳过"
          checked={draft.smartSkip}
          disabled={blocked}
          onChange={(event) => change('smartSkip', event.target.checked)}
        />
        <span>智能跳过不合适或重复的话题</span>
      </label>
      <p className="wa-help">关闭后尽量接话，活跃时段、冷却与无人回应限制仍生效。@、/agent 和昵称唤醒始终优先回复。</p>
      <label className="wa-check-row wa-section-space">
        <input
          type="checkbox"
          aria-label="限制自然陪聊活跃时段"
          checked={draft.activeHours}
          disabled={blocked}
          onChange={(event) => change('activeHours', event.target.checked)}
        />
        <span>只在活跃时段主动参与</span>
      </label>
      {draft.activeHours && (
        <div className="wa-form-grid">
          <Field label="开始时间 · 北京时间" id="wa-natural-start">
            <input
              className="wa-input"
              id="wa-natural-start"
              type="time"
              value={draft.startTime}
              disabled={blocked}
              onChange={(event) => change('startTime', event.target.value)}
            />
          </Field>
          <Field label="结束时间 · 北京时间" id="wa-natural-end">
            <input
              className="wa-input"
              id="wa-natural-end"
              type="time"
              value={draft.endTime}
              disabled={blocked}
              onChange={(event) => change('endTime', event.target.value)}
            />
          </Field>
        </div>
      )}
      <details className="wa-subsection">
        <summary>连续对话与发言分寸</summary>
        <Field
          label="连续对话窗口（秒）"
          id="wa-natural-followup"
          help="唤醒后接同一成员的相关后续；主动开话题后可接群友回应。窗口内最多判断 3 条，0 表示关闭。"
        >
          <input
            className="wa-input"
            id="wa-natural-followup"
            type="number"
            min="0"
            max="600"
            step="1"
            value={draft.followupSeconds}
            disabled={blocked}
            onChange={(event) => change('followupSeconds', event.target.value)}
          />
        </Field>
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
        <Field
          label="主动发言最短间隔（分钟）"
          id="wa-natural-gap"
          help="时间和条数共用冷却。你亲自用当前微信账号接话后，也按此间隔暂缓主动参与。"
        >
          <input
            className="wa-input"
            id="wa-natural-gap"
            type="number"
            min="1"
            max="60"
            step="1"
            value={draft.minGapMinutes}
            disabled={blocked}
            onChange={(event) => change('minGapMinutes', event.target.value)}
          />
        </Field>
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
          {!status.paused && status.nextCheckAt && <p>下一次判断：{formatTime(status.nextCheckAt, true)}</p>}
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
                  aria-label="已核对自然陪聊发送结果"
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
