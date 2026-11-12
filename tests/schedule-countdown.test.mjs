import test from 'node:test';
import assert from 'node:assert/strict';
import { countdownSeconds, formatCountdown } from '../frontend/shared/countdown.mjs';
import { reminderView } from '../modules/digests/service.mjs';

const now = Date.UTC(2026, 10, 11, 12);

test('countdowns keep the final partial second and never show negative time', () => {
  assert.equal(countdownSeconds(now + 1001, now), 2);
  assert.equal(countdownSeconds(now + 1, now), 1);
  assert.equal(countdownSeconds(now, now), 0);
  assert.equal(countdownSeconds(now - 60000, now), 0);
  for (const at of [null, undefined, 0, -1, NaN, Infinity, 'invalid']) assert.equal(countdownSeconds(at, now), null);
});

test('countdowns cross minutes, hours and days with stable clock digits', () => {
  const cases = [[1, '00:00:01'], [59, '00:00:59'], [60, '00:01:00'], [3599, '00:59:59'],
    [3600, '01:00:00'], [86399, '23:59:59'], [86400, '1天 00:00:00'], [90061, '1天 01:01:01'], [31536000, '365天 00:00:00']];
  for (const [seconds, expected] of cases) assert.equal(formatCountdown(countdownSeconds(now + seconds * 1000, now)), expected);
});

test('returning from a background tab and rescheduling use the current deadline', () => {
  const first = now + 60000;
  assert.equal(formatCountdown(countdownSeconds(first, now)), '00:01:00');
  assert.equal(formatCountdown(countdownSeconds(first, now + 45000)), '00:00:15');
  assert.equal(countdownSeconds(first, now + 120000), 0);
  assert.equal(formatCountdown(countdownSeconds(now + 180000, now + 120000)), '00:01:00');
});

test('digest reminder countdowns follow retry timing while preserving the original plan', () => {
  const task = { state: 'pending', content: '吃饭提醒', schedule: { kind: 'once', at: now }, nextRunAt: now, retryAt: now + 15000 };
  const reminder = reminderView({}, task);
  assert.equal(reminder.at, now);
  assert.equal(reminder.nextRunAt, now + 15000);
  assert.equal(countdownSeconds(reminder.nextRunAt, now), 15);
  task.retryAt = null;
  assert.equal(reminderView({}, task).nextRunAt, now);
});
