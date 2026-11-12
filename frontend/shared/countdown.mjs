export function countdownSeconds(at, now) {
  return Number.isFinite(at) && at > 0 ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

export function formatCountdown(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const clock = [hours, minutes, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  return (days ? days + '天 ' : '') + clock;
}
