import { Glyph } from './glyph.jsx';
import { useClock } from '../hooks/use-clock.mjs';
import { countdownSeconds, formatCountdown } from '../shared/countdown.mjs';
import { formatTime } from '../shared/conversations.mjs';

export function ScheduleCountdown({ at, enabled = true, running = false, paused = false, status, action = '执行' }) {
  const valid = Number.isFinite(at) && at > 0;
  const blocked = paused || (status && (!status.online ? '微信未连接' : status.settings?.enabled === false ? '自动回复总开关已关闭' : false));
  const now = useClock(valid && enabled && !running && !blocked);
  const seconds = countdownSeconds(at, now);
  const state = running ? 'running' : !enabled ? 'disabled' : blocked ? 'paused' : !valid ? 'idle' : seconds > 0 ? 'scheduled' : 'due';
  const labels = { running: '执行中', disabled: '未开启', paused: '已暂停', idle: '等待安排', due: '等待' + action };
  const remaining = state === 'scheduled' ? formatCountdown(seconds) : '';
  const label = remaining ? '距下次' + action + '还剩 ' + remaining : labels[state];
  const reason = typeof blocked === 'string' && state === 'paused' ? blocked : label;
  return <span className="wa-countdown" role="timer" aria-live="off" aria-label={label}
    data-state={state} data-soon={state === 'scheduled' && seconds <= 60 ? 'true' : undefined}
    data-countdown-at={valid ? at : undefined} title={reason + (valid ? ' · 计划时间：' + formatTime(at, true) : '')}>
    <Glyph name={state === 'paused' || state === 'disabled' ? 'pause' : 'clock'} size={12} />
    {remaining ? <><span>剩余</span><span className="wa-countdown-value">{remaining}</span></> : <span>{labels[state]}</span>}
  </span>;
}
