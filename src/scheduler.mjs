import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson } from './wechat/protocol/session.ts';
import { ChannelError, eligible } from './contracts.mjs';

const clone = value => structuredClone(value);
const active = new Set(['pending', 'running']);
export function nextDaily(time, after, timeZone = 'Asia/Shanghai') {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ChannelError('INVALID_TASK', '每日时间请填写 00:00–23:59');
  let format;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new ChannelError('INVALID_TASK', '任务时区无效'); }
  const parts = stamp => Object.fromEntries(format.formatToParts(new Date(stamp)).filter(value => value.type !== 'literal').map(value => [value.type, Number(value.value)]));
  const local = parts(after), [hour, minute] = time.split(':').map(Number);
  for (let day = 0; day < 3; day++) {
    const localUtc = Date.UTC(local.year, local.month - 1, local.day + day, hour, minute);
    let candidate = localUtc;
    for (let retry = 0; retry < 3; retry++) {
      const actual = parts(candidate), actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
      candidate += localUtc - actualUtc;
    }
    if (candidate > after) return candidate;
  }
  throw new ChannelError('INVALID_TASK', '无法计算任务的下一次执行时间');
}
export function validateSchedule(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelError('INVALID_TASK', '请选择执行时间');
  if (value.kind === 'once') {
    if (!Number.isSafeInteger(value.at) || value.at <= now || value.at > now + 366 * 86400000) throw new ChannelError('INVALID_TASK', '一次性任务应安排在未来一年内');
    return { kind: 'once', at: value.at };
  }
  if (value.kind === 'interval') {
    if (!Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 525600) throw new ChannelError('INVALID_TASK', '重复间隔应为 1–525600 分钟');
    return { kind: 'interval', minutes: value.minutes };
  }
  if (value.kind === 'daily') { nextDaily(value.time, now, value.timeZone || 'Asia/Shanghai'); return { kind: 'daily', time: value.time, timeZone: value.timeZone || 'Asia/Shanghai' }; }
  throw new ChannelError('INVALID_TASK', '请选择一次性、每天或间隔执行');
}
export function scheduleNext(schedule, after) {
  return schedule.kind === 'once' ? schedule.at : schedule.kind === 'interval' ? after + schedule.minutes * 60000 : nextDaily(schedule.time, after, schedule.timeZone);
}

export class TaskScheduler {
  constructor({ store, channel, now = Date.now, graceMs = 600000 }) {
    Object.assign(this, { store, channel, now, graceMs });
    this.file = path.join(store.root, 'storage/tasks/schedules.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new ChannelError('TASKS_INVALID', '定时任务文件无法读取，已停止调度，请保留文件并检查权限'); }
    this.data ??= { version: 1, ownerStoreId: store.data.storeId, tasks: [], runs: [] };
    if (this.data.version !== 1 || this.data.ownerStoreId !== store.data.storeId || !Array.isArray(this.data.tasks) || !Array.isArray(this.data.runs))
      throw new ChannelError('TASKS_INVALID', '定时任务数据格式或归属有误，未执行任务');
    for (const task of this.data.tasks) if (task.state === 'running') {
      const record = store.data.records.find(record => record.key === task.recordKey);
      task.state = record?.state === 'sent' && task.schedule.kind === 'once' ? 'completed' : 'paused';
      task.lastState = record?.state === 'sent' ? 'sent' : ['sending', 'unknown', 'partial'].includes(record?.state) ? 'unknown' : 'cancelled';
      task.lastError = task.lastState === 'sent' ? null : '上次执行中断，已暂停，请核对记录；不会自动重复发送';
      const run = this.data.runs.find(run => run.id === task.runId);
      if (run) Object.assign(run, { state: task.lastState, finishedAt: now(), reason: task.lastError, acknowledgedMessageIds: record?.acknowledgedMessageIds || [] });
    }
    this.save();
  }
  save() {
    try { atomicJson(this.file, this.data); }
    catch { throw new ChannelError('STATE_WRITE_FAILED', '定时任务状态未能保存，已停止本次调度，请检查磁盘和目录权限'); }
  }
  authorized(selector, fromChat = false) {
    if (!eligible(this.store.settings(selector.accountId), selector)) throw new ChannelError('TASK_NOT_AUTHORIZED', '该会话未授权或自动回复已暂停，未执行定时任务');
    if (fromChat && this.store.conversationSettings(selector.accountId, selector.chatType, selector.peerId).allowChatTasks === false)
      throw new ChannelError('TASK_NOT_AUTHORIZED', '管理员已关闭这个会话的聊天定时任务');
  }
  create(input, scope) {
    this.authorized(scope, scope.source === 'chat');
    if (!['message', 'agent'].includes(input.kind) || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 4000 || /\u0000/.test(input.content))
      throw new ChannelError('INVALID_TASK', '请选择发送消息或执行 Agent 任务，并填写 1–4000 字的内容');
    const requestKey = scope.requestKey ? createHash('sha256').update(JSON.stringify([scope.accountId, scope.chatType, scope.peerId, scope.requestKey, scope.senderId, input.kind, input.content.trim(), input.schedule])).digest('hex') : null;
    if (requestKey) { const previous = this.data.tasks.find(task => task.requestKey === requestKey); if (previous) return clone(previous); }
    const schedule = validateSchedule(input.schedule, this.now());
    if (this.data.tasks.filter(task => task.accountId === scope.accountId && active.has(task.state)).length >= 100)
      throw new ChannelError('TASK_LIMIT', '当前账号最多保留 100 个活动任务，请先取消不再需要的任务');
    if (scope.source === 'chat' && this.data.tasks.filter(task => task.accountId === scope.accountId && task.peerId === scope.peerId && task.senderId === scope.senderId && active.has(task.state)).length >= 20)
      throw new ChannelError('TASK_LIMIT', '你在这个会话中已有 20 个活动任务，请先取消不再需要的任务');
    const task = { id: randomUUID(), accountId: scope.accountId, chatType: scope.chatType, peerId: scope.peerId,
      senderId: scope.senderId || scope.accountId, senderName: scope.senderName || '管理员', source: scope.source || 'owner', requestKey,
      kind: input.kind, content: input.content.trim(), schedule, nextRunAt: scheduleNext(schedule, this.now()),
      state: 'pending', createdAt: this.now(), updatedAt: this.now(), revision: 1, lastState: null, lastError: null };
    this.data.tasks.push(task);
    try { this.save(); } catch (error) { this.data.tasks.pop(); throw error; }
    return clone(task);
  }
  get(id, scope, owner = false) {
    const task = this.data.tasks.find(task => task.id === id && task.accountId === scope.accountId &&
      (owner || task.chatType === scope.chatType && task.peerId === scope.peerId && task.senderId === scope.senderId));
    if (!task) throw new ChannelError('TASK_NOT_FOUND', '任务不存在，或你不能管理这个任务');
    return task;
  }
  cancel(id, scope, owner = false) {
    const task = this.get(id, scope, owner), previous = clone(task);
    if (!['pending', 'paused', 'running'].includes(task.state)) throw new ChannelError('TASK_CHANGED', '这个任务已经结束，无需再次取消');
    task.state = 'cancelled'; task.updatedAt = this.now(); task.revision++;
    try { this.save(); } catch (error) { Object.assign(task, previous); throw error; }
    if (this.current?.task.id === id) this.current.controller.abort(new ChannelError('CANCELLED', '定时任务已取消'));
    return clone(task);
  }
  pause(id, scope) {
    const task = this.get(id, scope, true);
    if (task.state !== 'pending') throw new ChannelError('TASK_CHANGED', '只能暂停等待执行的任务');
    const previous = clone(task); task.state = 'paused'; task.updatedAt = this.now(); task.revision++;
    try { this.save(); } catch (error) { Object.assign(task, previous); throw error; }
    return clone(task);
  }
  resume(id, scope) {
    const task = this.get(id, scope, true);
    this.authorized(task, task.source === 'chat');
    if (task.state !== 'paused' || ['unknown', 'partial'].includes(task.lastState)) throw new ChannelError('TASK_CHANGED', '发送结果不明的任务不能直接重试，请在微信核对后另建任务');
    if (task.schedule.kind === 'once' && task.nextRunAt <= this.now()) throw new ChannelError('TASK_EXPIRED', '原执行时间已过，请另建一次性任务并选择新时间');
    const previous = clone(task); task.state = 'pending'; task.nextRunAt = scheduleNext(task.schedule, this.now()); task.revision++; task.updatedAt = this.now();
    try { this.save(); } catch (error) { Object.assign(task, previous); throw error; }
    return clone(task);
  }
  list(accountId, selector) {
    const match = task => task.accountId === accountId && (!selector || task.peerId === selector.peerId && task.chatType === selector.chatType && (!selector.senderId || task.senderId === selector.senderId));
    const tasks = this.data.tasks.filter(match).map(task => ({ ...clone(task), name: this.store.conversations(accountId).find(peer => peer.peerId === task.peerId && peer.chatType === task.chatType)?.name || task.peerId }));
    const ids = new Set(tasks.map(task => task.id));
    return { tasks: tasks.sort((a, b) => (active.has(b.state) - active.has(a.state)) || a.nextRunAt - b.nextRunAt), runs: this.data.runs.filter(run => ids.has(run.taskId)).slice(-100).reverse().map(clone), error: this.error || null };
  }
  start() { this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(error => { this.error = error instanceof ChannelError ? error.message : '任务调度异常，已停止自动执行'; this.stopped = true; }); }, 1000); this.timer.unref?.(); }
  async tick() {
    if (this.stopped || this.running) return;
    this.running = this.drain();
    try { await this.running; } finally { this.running = null; }
  }
  async drain() {
    for (const task of this.data.tasks) {
      if (this.stopped || task.state !== 'pending' || task.nextRunAt > this.now()) continue;
      if (this.now() - task.nextRunAt > this.graceMs) {
        task.lastState = 'expired'; task.lastError = '超过执行时间十分钟，已跳过本次，未补发过期提醒';
        if (task.schedule.kind === 'once') task.state = 'expired'; else task.nextRunAt = scheduleNext(task.schedule, this.now());
        task.updatedAt = this.now(); this.save(); continue;
      }
      const current = this.channel.transport.status();
      if (!current.online || current.account?.id !== task.accountId || [...this.channel.pauses.values()].some(pause => !pause.selector || ['accountId', 'chatType', 'peerId'].every(key => pause.selector[key] === undefined || pause.selector[key] === task[key]))) continue;
      try { this.authorized(task, task.source === 'chat'); } catch { continue; }
      const controller = new AbortController(), id = randomUUID();
      const run = { id, taskId: task.id, accountId: task.accountId, scheduledAt: task.nextRunAt, startedAt: this.now(), state: 'queued', acknowledgedMessageIds: [] };
      const before = clone(task);
      task.state = 'running'; task.runId = id; task.recordKey = 'scheduled:' + id;
      this.data.runs.push(run);
      try { this.save(); } catch (error) { Object.assign(task, before); this.data.runs.pop(); throw error; }
      this.current = { task, controller };
      try {
        const record = await this.channel.submitScheduled(clone(task), controller.signal);
        Object.assign(run, { state: record.state, reason: record.reason || null, acknowledgedMessageIds: record.acknowledgedMessageIds || [], finishedAt: this.now() });
        task.lastState = record.state; task.lastError = record.reason || null;
        if (task.state === 'running') {
          if (record.state !== 'sent') task.state = 'paused';
          else if (task.schedule.kind === 'once') task.state = 'completed';
          else { task.state = 'pending'; task.nextRunAt = scheduleNext(task.schedule, this.now()); }
        }
      } catch (error) {
        Object.assign(run, { state: 'failed', reason: error instanceof ChannelError ? error.message : '任务执行失败，请检查处理记录', finishedAt: this.now() });
        task.lastState = 'failed'; task.lastError = run.reason; if (task.state === 'running') task.state = 'paused';
      } finally { task.updatedAt = this.now(); this.current = null; this.save(); }
    }
  }
  async close() { this.stopped = true; clearInterval(this.timer); this.current?.controller.abort(new ChannelError('CANCELLED', '插件正在停止，定时任务已中止')); await this.running; }
}

function chineseNumber(value) {
  if (/^\d+(?:\.5)?$/.test(value)) return Number(value);
  if (value === '半') return 0.5;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  if (value === '十') return 10;
  if (value.includes('十')) { const [left, right] = value.split('十'); return (digits[left] || 1) * 10 + (digits[right] || 0); }
  return digits[value] ?? NaN;
}
export function simpleReminder(text, names, now) {
  let normalized = String(text).trim();
  if (/(?:顺便|同时|再|并且|然后).{0,20}(?:发|表情|图片)/u.test(normalized)) return null;
  for (const name of [...names].filter(Boolean).sort((a, b) => b.length - a.length)) if (normalized.startsWith(name)) { normalized = normalized.slice(name.length).replace(/^[，,：:\s]+/, ''); break; }
  const match = /^(?:请|帮我|请帮我|麻烦你|请你|能不能)?\s*(?:在|过)?\s*([\d.一二两三四五六七八九十半]+)\s*个?\s*(秒钟?|分钟?|小时|天)(?:之|以)?后(?:请)?(提醒我|叫我|提醒大家|提醒我们)([^\r\n]{1,500})[。！!]?$/u.exec(normalized);
  if (!match) return null;
  const amount = chineseNumber(match[1]), multiplier = match[2].startsWith('秒') ? 1000 : match[2].startsWith('分') ? 60000 : match[2] === '小时' ? 3600000 : 86400000;
  if (!Number.isFinite(amount) || amount <= 0 || amount * multiplier > 366 * 86400000) return null;
  return { kind: 'message', content: '到点啦，别忘了' + match[4].replace(/[。！!]+$/, '').trim() + '。',
    audience: /大家|我们/u.test(match[3]) ? 'everyone' : 'sender', delayLabel: match[1] + match[2],
    schedule: { kind: 'once', at: Math.trunc(now + amount * multiplier) } };
}
