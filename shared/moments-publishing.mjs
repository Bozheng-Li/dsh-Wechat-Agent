import { ChannelError } from './contracts.mjs';
import { validateAudienceSelection } from './moments-audience.mjs';

export const MOMENTS_PUBLISH_DEFAULTS = Object.freeze({ enabled: false, maxPostsPer24Hours: 3, minGapMinutes: 120 });
export const MOMENTS_PLAN_DEFAULTS = Object.freeze({ name: '新的发布计划', enabled: false, themes: ['日常心情与小笑话'], style: '自然、轻松、有一点幽默',
  instructions: '', maxChars: 300, reviewRequired: false, research: false, researchQuery: '', graceMinutes: 30, blockedLabelIds: [], blockedUserIds: [],
  schedule: { type: 'daily', timezone: 'Asia/Shanghai', times: ['09:00'], weekdays: [1, 2, 3, 4, 5], onceAt: '' },
  image: { mode: 'none', providerId: '', model: '', size: '', instructions: '' } });
const invalid = message => { throw new ChannelError('MOMENTS_PLAN_INVALID', message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.trim());
export const momentsPlanId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const momentsRunId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function momentsPublishingSettings(input = {}) {
  if (!exact(input, Object.keys(MOMENTS_PUBLISH_DEFAULTS))) invalid('自动发布总设置包含不支持的字段');
  const value = { ...MOMENTS_PUBLISH_DEFAULTS, ...input };
  if (typeof value.enabled !== 'boolean' || !integer(value.maxPostsPer24Hours, 1, 24) || !integer(value.minGapMinutes, 0, 1440)) invalid('24 小时自动发布上限为 1–24 条，最短间隔为 0–1440 分钟');
  return value;
}
const formatters = new Map();
export function momentsLocalParts(at, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
    catch { invalid('请选择有效时区，例如 Asia/Shanghai'); }
    if (formatters.size > 100) formatters.clear(); formatters.set(timezone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(at).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
export function momentsLocalInstant(value, timezone) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const [year, month, day, hour, minute] = value.match(/\d+/g).map(Number), expected = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(expected).toISOString().slice(0, 16) !== value) return null;
  let at = expected;
  for (let i = 0; i < 5; i++) { const parts = momentsLocalParts(at, timezone), represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = at + expected - represented; if (next === at) break; at = next; }
  const parts = momentsLocalParts(at, timezone);
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute].every((item, i) => item === [year, month, day, hour, minute][i]) ? at : null;
}
export function momentsPlanSettings(input = {}) {
  if (!exact(input, Object.keys(MOMENTS_PLAN_DEFAULTS))) invalid('发布计划包含不支持的字段');
  const value = { ...structuredClone(MOMENTS_PLAN_DEFAULTS), ...input };
  if (!text(value.name, 80, true) || typeof value.enabled !== 'boolean' || typeof value.reviewRequired !== 'boolean' || typeof value.research !== 'boolean' || !text(value.researchQuery, 240) ||
      !Array.isArray(value.themes) || !value.themes.length || value.themes.length > 30 || value.themes.some(theme => !text(theme, 200, true)) ||
      !text(value.style, 1000) || !text(value.instructions, 4000) || !integer(value.maxChars, 30, 2000) || !integer(value.graceMinutes, 1, 1440))
    invalid('请填写计划名称和 1–30 个主题；正文上限 30–2000 字，过期等待 1–1440 分钟');
  validateAudienceSelection({ action: 'publish', blockedLabelIds: value.blockedLabelIds, blockedUserIds: value.blockedUserIds });
  if (!exact(value.schedule, Object.keys(MOMENTS_PLAN_DEFAULTS.schedule)) || !exact(value.image, Object.keys(MOMENTS_PLAN_DEFAULTS.image))) invalid('发布时间或配图设置包含不支持的字段');
  value.schedule = { ...MOMENTS_PLAN_DEFAULTS.schedule, ...value.schedule }; value.image = { ...MOMENTS_PLAN_DEFAULTS.image, ...value.image };
  const { schedule, image } = value;
  if (!['daily', 'weekly', 'once'].includes(schedule.type) || !text(schedule.timezone, 80, true) || !Array.isArray(schedule.times) || !schedule.times.length || schedule.times.length > 8 ||
      schedule.times.some(time => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
      !Array.isArray(schedule.weekdays) || schedule.weekdays.some(day => !integer(day, 1, 7)) || schedule.type === 'weekly' && !schedule.weekdays.length || !text(schedule.onceAt, 16)) invalid('请选择单次／每天／每周计划及有效的发布时间、星期和时区');
  momentsLocalParts(Date.now(), schedule.timezone);
  if (schedule.type === 'once' && momentsLocalInstant(schedule.onceAt, schedule.timezone) === null) invalid('单次发布时间不是有效的当地日期和时间（该时区可能跳过此时间）');
  if (!['none', 'ai'].includes(image.mode) || !text(image.providerId, 80) || !text(image.model, 200) || !text(image.size, 40) || !text(image.instructions, 2000)) invalid('配图请选择不配图或 AI 配图，并填写有效的接口、模型及要求');
  value.themes = [...new Set(value.themes.map(theme => theme.trim()))]; schedule.times = [...new Set(schedule.times)].sort(); schedule.weekdays = [...new Set(schedule.weekdays)].sort();
  return structuredClone(value);
}
/** One occurrence per wall-clock slot, including on DST fallback days. */
export function nextMomentsOccurrence(settings, after) {
  const schedule = settings.schedule;
  if (schedule.type === 'once') { const at = momentsLocalInstant(schedule.onceAt, schedule.timezone); return at !== null && at > after ? at : 0; }
  const parts = momentsLocalParts(after, schedule.timezone), day0 = Date.UTC(parts.year, parts.month - 1, parts.day);
  for (let offset = 0; offset <= 370; offset++) {
    const date = new Date(day0 + offset * 86400000), weekday = date.getUTCDay() || 7;
    if (schedule.type === 'weekly' && !schedule.weekdays.includes(weekday)) continue;
    for (const time of schedule.times) { const at = momentsLocalInstant(date.toISOString().slice(0, 10) + 'T' + time, schedule.timezone); if (at !== null && at > after) return at; }
  }
  return 0;
}
