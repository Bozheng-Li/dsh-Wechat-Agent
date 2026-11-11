import { createHash } from 'node:crypto';
import { momentsLocalParts, momentsLocalInstant, momentsPlanSettings, nextMomentsOccurrence } from '../../shared/moments-publishing.mjs';

const day = 86400000, minute = 60000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function momentsDate(at, timezone) {
  const parts = momentsLocalParts(at, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const localTime = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

/** Scheduling is local and deterministic; no model call or publication happens here. */
export function arrangeMoments(accountId, settings, allPlans, allRuns, now, reflow = false) {
  const rule = settings.automatic, today = momentsDate(now, rule.timezone);
  const dates = Array.from({ length: 3 }, (_, index) => new Date(Date.parse(today + 'T12:00:00Z') + index * day).toISOString().slice(0, 10));
  const plans = allPlans.filter(plan => plan.accountId === accountId), runs = allRuns.filter(run => run.accountId === accountId && run.origin === 'schedule');
  const consumed = new Set(runs.map(run => run.planId));
  const movable = plan => plan.automatic && !plan.deleted && !plan.automatic.edited && !consumed.has(plan.id) &&
    (plan.automatic.suppressed || plan.nextRunAt > now);
  const replacements = new Set(reflow ? plans.filter(movable).map(plan => plan.id) : []);
  const events = new Map(), reservations = new Map(dates.map(date => [date, new Set()]));
  const reserve = (date, key) => reservations.get(date)?.add(key);
  // Deleted/paused/consumed automatic slots remain occupied: an owner's decision is durable.
  for (const plan of plans) if (plan.automatic && !replacements.has(plan.id) && !plan.automatic.suppressed)
    reserve(plan.automatic.date, plan.id);
  for (const plan of plans) {
    if (plan.deleted || !plan.settings.enabled || plan.automatic?.suppressed || replacements.has(plan.id)) continue;
    let at = nextMomentsOccurrence(plan.settings, now - 2 * day);
    for (let count = 0; at && at <= now + 5 * day && count < 64; count++, at = nextMomentsOccurrence(plan.settings, at)) {
      const key = plan.id + ':' + at; events.set(key, at);
      reserve(momentsDate(at, rule.timezone), plan.automatic ? plan.id : key);
    }
  }
  for (const run of runs) {
    const plan = plans.find(plan => plan.id === run.planId), key = run.planId + ':' + run.scheduledAt;
    // Use actual publication time for spacing and the rolling limit.
    if (['published', 'published-unverified', 'deleted'].includes(run.state)) events.set(key, run.publishedAt);
    reserve(momentsDate(run.scheduledAt, rule.timezone), plan?.automatic ? plan.id : key);
  }
  const fits = at => {
    const others = [...events.values()].filter(value => Math.abs(value - at) < day);
    if (others.some(value => Math.abs(value - at) < Math.max(1, settings.minGapMinutes) * minute)) return false;
    const ordered = [...others, at].sort((a, b) => a - b);
    // Every rolling window containing the proposed slot must remain below the cap.
    return ordered.filter(value => value <= at).every(start => ordered.filter(value => value >= start && value < start + day).length <= settings.maxPostsPer24Hours);
  };
  const updates = new Map(), summary = [];
  if (reflow) for (const plan of plans.filter(plan => replacements.has(plan.id))) updates.set(plan.id, {
    ...plan, automatic: { ...plan.automatic, suppressed: true }, nextRunAt: 0,
    waitingReason: '按当前次数、手动计划和发布间隔，暂不需要此自动时段',
  });
  for (const date of dates) {
    const occupied = reservations.get(date), needed = Math.max(0, rule.dailyCount - occupied.size);
    const start = minutes(rule.startTime), end = minutes(rule.endTime);
    let added = 0;
    for (let slot = 0; slot < 8 && added < needed; slot++) {
      const id = hash([accountId, 'automatic', date, slot]).slice(0, 32), prior = plans.find(plan => plan.id === id);
      if (prior && !replacements.has(id) && !prior.automatic?.suppressed) continue;
      if (prior && (prior.deleted || prior.automatic.edited || consumed.has(id))) continue;
      // A little daily variation, with slots spread across the allowed window.
      const fraction = parseInt(hash([accountId, date, slot]).slice(0, 8), 16) / 0xffffffff;
      const ideal = start + (end - start) * (added + 0.25 + fraction * 0.5) / needed;
      const candidates = Array.from({ length: end - start + 1 }, (_, index) => start + index).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
      let chosen;
      for (const value of candidates) {
        const local = date + 'T' + localTime(value), at = momentsLocalInstant(local, rule.timezone);
        if (at !== null && at >= now + 10 * minute && fits(at)) { chosen = { local, at }; break; }
      }
      if (!chosen) break;
      const plan = { id, accountId, settings: momentsPlanSettings({ ...rule.content, name: `自动安排 · ${date} · ${slot + 1}`, enabled: true,
        schedule: { type: 'once', timezone: rule.timezone, onceAt: chosen.local } }),
        automatic: { date, slot, edited: false, suppressed: false }, nextRunAt: chosen.at, createdAt: prior?.createdAt ?? now, updatedAt: now, waitingReason: null };
      updates.set(id, plan); events.set(id, chosen.at); occupied.add(id); added++;
    }
    summary.push({ date, target: rule.dailyCount, reserved: occupied.size, shortfall: Math.max(0, rule.dailyCount - occupied.size) });
  }
  return { updates: [...updates.values()], summary };
}
