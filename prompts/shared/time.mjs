/** Use the configured IANA zone when supplied, otherwise the actual host zone. */
export function replyTimeZone(timeZone) {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
}

/** Message/history timestamps may be Unix seconds or milliseconds; keep their zone explicit. */
export function localMessageTime(value, timeZone = replyTimeZone()) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
  const date = new Date(numeric ? (Number(value) < 1e12 ? Number(value) * 1000 : Number(value)) : value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date).map(part => [part.type, part.value]));
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** One reply-time snapshot is shared by planning, expression and media captions. */
export function replyClock({ now = Date.now(), messageTime, timeZone } = {}) {
  const zone = replyTimeZone(timeZone), instant = new Date(typeof now === 'function' ? now() : now);
  const period = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: 'numeric', hour12: true, dayPeriod: 'long' })
    .formatToParts(instant).find(part => part.type === 'dayPeriod')?.value || '';
  return { timeZone: zone, currentTime: localMessageTime(instant, zone), currentDayPeriod: period,
    messageTime: localMessageTime(messageTime, zone) };
}
