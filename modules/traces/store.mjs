import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ChannelError } from '../../shared/contracts.mjs';
import { TRACE_TYPES, TRACE_STATES, TRACE_ACTIVE, TRACE_PROBLEMS, traceState } from '../../shared/execution-traces.mjs';
import { tracePayload, traceSnippet } from './sanitize.mjs';
import { currentTrace, withTrace, observeResult } from './context.mjs';
import { authorizationContains, conversationAuthorized } from '../../shared/authorization.mjs';
import { removeManagedDirectory, ownedPath } from '../authorization/files.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const validId = id => typeof id === 'string' && /^\d{8}-[a-f0-9]{32}$/.test(id);
const dateOf = id => id.slice(0, 4) + '-' + id.slice(4, 6) + '-' + id.slice(6, 8);
const dayOf = time => new Date(time).toISOString().slice(0, 10);
const error = (code, message) => new ChannelError(code, message);
const json = value => JSON.stringify(value, null, 2) + '\n';
async function eachConcurrent(items, action) {
  let index = 0, failure;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) { try { await action(items[index++]); } catch (error) { failure ??= error; } }
  }));
  if (failure) throw failure;
}

export class ExecutionTraces {
  constructor(store, { now = Date.now } = {}) {
    this.store = store; this.erased = new Set(); this.erasedSourceKeys = new Set();
    this.owner = store.data?.storeId; this.now = now; this.runtimeId = randomUUID();
    this.days = new Map(); this.dirty = new Set(); this.contexts = new Map(); this.writer = Promise.resolve();
    this.pendingEvents = new Map(); this.pendingContent = new Map(); this.liveEvents = new Map(); this.contentCache = new Map(); this.durableSeq = new Map();
    this.startedAt = now(); this.closed = false; this.warning = null; this.revision = 0;
    this.root = store.root ? path.resolve(store.root, 'storage/traces') : null;
    this.enabled = !!(this.root && this.owner);
    if (!this.enabled) return;
    this.safe(() => {
      this.local(this.root, false); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const manifest = path.join(this.root, 'manifest.json'); this.local(manifest, false);
      if (fs.existsSync(manifest)) {
        const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (value.version !== 1 || value.ownerStoreId !== this.owner) throw error('TRACE_STORE_INVALID', '执行轨迹的格式或归属不正确，未覆盖原记录');
        this.startedAt = value.startedAt;
      } else fs.writeFileSync(manifest, json({ version: 1, ownerStoreId: this.owner, startedAt: this.startedAt }), { flag: 'wx', mode: 0o600 });
    }, true);
  }
  safe(action, disable = false) {
    try { return action(); }
    catch (failure) {
      this.warning = { at: this.now(), message: failure instanceof ChannelError ? failure.message : '部分执行轨迹未能保存，请检查数据目录与磁盘空间', code: failure.code || 'TRACE_WRITE_FAILED' };
      if (disable) this.enabled = false;
      return undefined;
    }
  }
  local(file, required = true) {
    const relative = path.relative(this.root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw error('TRACE_PATH_INVALID', '执行轨迹不在当前数据目录内');
    let current = file;
    for (;;) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw error('TRACE_PATH_INVALID', '执行轨迹不能使用重定向链接'); }
      catch (failure) { if (failure.code !== 'ENOENT' || current === file && required) throw failure; }
      if (current === this.root) break;
      current = path.dirname(current);
    }
    return file;
  }
  accountFolder(accountId) {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 300) throw error('TRACE_ACCOUNT_INVALID', '请选择要查看轨迹的微信账号');
    return path.join(this.root, hash(accountId).slice(0, 32));
  }
  day(accountId, day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw error('TRACE_DATE_INVALID', '执行日期不正确');
    const directory = path.join(this.accountFolder(accountId), day), key = accountId + ':' + day;
    if (this.days.has(key)) return this.days.get(key);
    const file = this.local(path.join(directory, 'index.json'), false);
    const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, ownerStoreId: this.owner, accountId, day, rows: [] };
    if (record.version !== 1 || record.ownerStoreId !== this.owner || record.accountId !== accountId || record.day !== day || !Array.isArray(record.rows) ||
      record.rows.some(row => !validId(row.id) || dateOf(row.id) !== day || row.accountId !== accountId)) throw error('TRACE_INDEX_INVALID', '执行轨迹索引无法读取，原记录保留');
    const value = { ...record, key, directory, file }; this.days.set(key, value);
    for (const row of value.rows) if (TRACE_ACTIVE.has(row.state) && row.runtimeId !== this.runtimeId) {
      row.state = 'interrupted'; row.incomplete = true; row.finishedAt = row.updatedAt;
      row.note = '上次运行结束前未记录到最终结果；没有自动重新执行。'; this.mark(value);
    }
    return value;
  }
  mark(day) {
    this.dirty.add(day.key); this.revision++;
    if (!this.flushTimer) { this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, 750); this.flushTimer.unref?.(); }
  }
  write(action, row) {
    const pending = this.writer.then(action);
    this.writer = pending.then(() => { this.writeFailure = null; }, failure => {
      if (row) row.incomplete = true;
      this.writeFailure = failure;
      this.safe(() => { throw failure; });
    });
    return pending;
  }
  persist(context, event) {
    if (this.erased.has(context.row.id)) return;
    const { row, day } = context; row.updatedAt = this.now(); row.eventCount++; this.mark(day);
    const entry = { seq: row.eventCount, at: this.now(), ...event };
    if (!this.pendingEvents.has(row.id)) this.pendingEvents.set(row.id, { context, events: [] });
    this.pendingEvents.get(row.id).events.push(entry);
    if (!this.liveEvents.has(row.id)) this.liveEvents.set(row.id, { full: false, events: [] });
    this.liveEvents.get(row.id).events.push(entry);
    if (!this.durableSeq.has(row.id)) this.durableSeq.set(row.id, row.eventCount - 1);
  }
  payload(context, value) {
    if (value === undefined || this.erased.has(context.row.id)) return undefined;
    const prepared = tracePayload(value), bytes = Buffer.from(json(prepared));
    const id = hash(bytes), key = context.row.id + ':' + id;
    if (prepared.limited) context.row.limited = true;
    this.contentCache.set(key, bytes);
    this.pendingContent.set(key, { context, id, key, bytes });
    return { id, bytes: bytes.length, limited: prepared.limited, binaryOmitted: prepared.binaryOmitted, credentialsHidden: prepared.credentialsHidden };
  }
  task(spec) {
    if (!this.enabled || this.closed) return null;
    if (this.erasedSourceKeys.has(spec.accountId + ':' + spec.key) ||
        authorizationContains(spec, this.store.data.authorizationRevocations || [])) return null;
    if (['private', 'group'].includes(spec.chatType) && !conversationAuthorized(this.store, spec)) return null;
    return this.safe(() => {
      const createdAt = Number.isFinite(spec.createdAt) ? spec.createdAt : this.now(), date = dayOf(createdAt);
      const id = date.replaceAll('-', '') + '-' + hash(this.owner + ':' + spec.accountId + ':' + (spec.key || randomUUID())).slice(0, 32);
      if (this.contexts.has(id)) return this.contexts.get(id);
      const day = this.day(spec.accountId, date);
      let row = day.rows.find(item => item.id === id);
      if (row) { const context = { store: this, row, day, parentId: null }; this.contexts.set(id, context); return context; }
      const parent = currentTrace();
      row = { id, accountId: spec.accountId, type: TRACE_TYPES.some(type => type[0] === spec.type) ? spec.type : 'maintenance',
        title: traceSnippet(spec.title || '任务执行', 120), source: spec.source || 'automatic', sourceKey: spec.key || null,
        peerId: traceSnippet(spec.peerId || '', 300), chatType: spec.chatType || null, actor: traceSnippet(spec.actor || '', 120),
        state: spec.state || 'running', createdAt, startedAt: spec.state === 'queued' ? null : this.now(), updatedAt: this.now(), finishedAt: null,
        eventCount: 0, stepCount: 0, modelCalls: 0, toolCalls: 0, coverage: spec.coverage || 'recorded', runtimeId: this.runtimeId,
        parentTraceId: spec.parentTraceId || (parent?.row.accountId === spec.accountId ? parent.row.id : null),
        inputPreview: traceSnippet(typeof spec.input === 'string' ? spec.input : spec.input?.question || spec.input?.request || ''),
      };
      day.rows.push(row);
      const context = { store: this, row, day, parentId: null }; this.contexts.set(id, context);
      this.liveEvents.set(id, { full: true, events: [] });
      row.input = this.payload(context, spec.input); row.configuration = this.payload(context, spec.configuration);
      this.persist(context, { event: 'task', task: { ...row } });
      if (parent?.store === this && parent.row.id === row.parentTraceId) this.startStep(parent, { title: '安排关联任务', kind: 'child',
        metadata: { traceId: id, title: row.title, type: row.type } })?.end();
      this.event(context, row.state === 'queued' ? '进入执行队列' : '开始执行', spec.trigger, 'lifecycle');
      return context;
    }) || null;
  }
  startStep(context, spec) {
    if (!context || !this.enabled || this.closed || this.erased.has(context.row.id)) return null;
    return this.safe(() => {
      const id = randomUUID().replaceAll('-', ''), startedAt = this.now();
      context.row.stepCount++;
      if (spec.kind === 'model') context.row.modelCalls++;
      if (spec.kind === 'tool') context.row.toolCalls++;
      const input = this.payload(context, spec.input), metadata = tracePayload(spec.metadata || {}).value;
      this.persist(context, { event: 'step-start', step: { id, parentId: spec.parentId ?? context.parentId, title: traceSnippet(spec.title, 180),
        kind: spec.kind || 'stage', startedAt, state: 'running', input, metadata } });
      let ended = false;
      return { id, end: ({ output, error: failure, state, metadata: extra } = {}) => this.safe(() => {
        if (ended) return; ended = true;
        const resolved = state || traceState(output, failure);
        this.persist(context, { event: 'step-end', id, finishedAt: this.now(), elapsedMs: Math.max(0, this.now() - startedAt),
          state: resolved, output: this.payload(context, output), error: this.payload(context, failure), metadata: tracePayload(extra || {}).value });
        if (TRACE_PROBLEMS.has(resolved)) context.row.failedSteps = (context.row.failedSteps || 0) + 1;
        if (failure || TRACE_PROBLEMS.has(resolved)) context.row.lastStepError = traceSnippet(failure?.message || output?.error?.message || output?.message || '', 300);
      }) };
    }) || null;
  }
  event(context, title, value, kind = 'stage') { const step = this.startStep(context, { title, kind }); step?.end({ output: value }); }
  update(context, { state, output, note } = {}) {
    if (!context || this.closed || this.erased.has(context.row.id)) return;
    this.safe(() => {
      const row = context.row;
      if (state && Object.hasOwn(TRACE_STATES, state)) {
        if (row.state !== state) this.event(context, TRACE_STATES[state], note ? { reason: note } : undefined, 'lifecycle');
        row.state = state;
        if (state === 'running') row.startedAt ??= this.now();
        if (!TRACE_ACTIVE.has(state)) row.finishedAt = this.now();
      }
      if (output !== undefined) row.output = this.payload(context, output);
      if (note) row.note = traceSnippet(note, 500);
      row.updatedAt = this.now(); this.mark(context.day);
      this.persist(context, { event: 'task-update', state: row.state, finishedAt: row.finishedAt, note: row.note, output: row.output });
    });
  }
  run(spec, action, { output = value => value } = {}) {
    const context = this.task(spec);
    if (!context) return action();
    this.update(context, { state: 'running' });
    return withTrace(context, () => {
      try { return observeResult(action(), result => { const value = output(result); this.update(context, { state: traceState(value), output: value }); },
        failure => this.update(context, { state: traceState(undefined, failure), output: failure, note: failure?.message })); }
      catch (failure) { this.update(context, { state: traceState(undefined, failure), output: failure, note: failure?.message }); throw failure; }
    });
  }
  async flush({ strict = false } = {}) {
    clearTimeout(this.flushTimer); this.flushTimer = null;
    const batches = new Map();
    const batch = context => {
      if (!batches.has(context.row.id)) batches.set(context.row.id, { context, events: [], content: [] });
      return batches.get(context.row.id);
    };
    for (const pending of this.pendingEvents.values()) batch(pending.context).events.push(...pending.events);
    for (const pending of this.pendingContent.values()) batch(pending.context).content.push(pending);
    this.pendingEvents.clear(); this.pendingContent.clear();
    const indices = [];
    for (const key of [...this.dirty]) {
      this.dirty.delete(key); const day = this.days.get(key);
      indices.push({ day, rows: day.rows.map(row => ({ ...row })) });
    }
    let pending;
    if (batches.size || indices.length) pending = this.write(async () => {
      try {
      let writeError;
      await eachConcurrent([...batches.values()], async entry => {
        const { context, events, content } = entry;
        const directory = this.local(path.join(context.day.directory, context.row.id), false);
        try {
          await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
          if (content.length) {
            const contentDirectory = this.local(path.join(directory, 'content'), false);
            await fs.promises.mkdir(contentDirectory, { recursive: true, mode: 0o700 });
            await eachConcurrent(content, async item => {
              const file = this.local(path.join(contentDirectory, item.id + '.json'), false);
              try { await fs.promises.writeFile(file, item.bytes, { flag: 'wx', mode: 0o600 }); }
              catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
              if (this.contentCache.get(item.key) === item.bytes) this.contentCache.delete(item.key);
            });
          }
          if (events.length) {
            await fs.promises.appendFile(this.local(path.join(directory, 'events.jsonl'), false), events.map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
          }
          entry.saved = true;
        } catch (failure) { context.row.incomplete = true; writeError ??= failure; }
      });
      for (const { day, rows } of indices) {
        const incompleteIds = new Set(day.rows.filter(row => row.incomplete).map(row => row.id));
        for (const row of rows) if (incompleteIds.has(row.id)) row.incomplete = true;
        const bytes = json({ version: 1, ownerStoreId: this.owner, accountId: day.accountId, day: day.day, rows });
        this.local(day.directory, false); await fs.promises.mkdir(day.directory, { recursive: true, mode: 0o700 });
        const file = this.local(day.file, false), temporary = file + '.' + randomUUID() + '.tmp';
        try { await fs.promises.writeFile(temporary, bytes, { mode: 0o600 }); await fs.promises.rename(temporary, file); }
        finally { await fs.promises.unlink(temporary).catch(() => {}); }
      }
      for (const { context, events, saved } of batches.values()) if (saved && events.length) {
        const sequence = events.at(-1).seq; this.durableSeq.set(context.row.id, sequence);
        const live = this.liveEvents.get(context.row.id);
        if (live && !TRACE_ACTIVE.has(context.row.state) && live.events.at(-1)?.seq <= sequence) this.liveEvents.delete(context.row.id);
      }
      if (writeError) throw writeError;
      } catch (failure) {
        for (const { day } of indices) this.dirty.add(day.key);
        for (const { context, events, content, saved } of batches.values()) if (!saved && !this.erased.has(context.row.id)) {
          const next = this.pendingEvents.get(context.row.id) || { context, events: [] };
          next.events = [...events, ...next.events]; this.pendingEvents.set(context.row.id, next);
          for (const item of content) if (!this.pendingContent.has(item.key)) this.pendingContent.set(item.key, item);
        }
        throw failure;
      }
    });
    if (strict && pending) await pending;
    await this.writer;
    if (strict && this.writeFailure) throw this.writeFailure;
  }
  pendingSave(row) { return (this.durableSeq.get(row.id) ?? row.eventCount) < row.eventCount; }
  async list(accountId, { type = 'all', state = 'all', query = '', from, to, startAt, endAt, offset = 0, limit = 30 } = {}) {
    if (!this.enabled) return { items: [], total: 0, counts: {}, warning: this.warning, startedAt: this.startedAt, enabled: false };
    if (!TRACE_TYPES.some(row => row[0] === type) || !['all', 'problems', ...Object.keys(TRACE_STATES)].includes(state) ||
      typeof query !== 'string' || query.length > 200 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw error('TRACE_FILTER_INVALID', '轨迹筛选或分页条件不正确');
    from ??= dayOf(this.now() - 6 * 86400000); to ??= dayOf(this.now());
    if (![from, to].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && dayOf(Date.parse(value)) === value) || from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
      throw error('TRACE_DATE_INVALID', '请选择一年以内的有效日期范围');
    startAt ??= Date.parse(from); endAt ??= Date.parse(to) + 86400000 - 1;
    if (![startAt, endAt].every(Number.isSafeInteger) || startAt > endAt || endAt - startAt > 367 * 86400000 ||
      Math.abs(startAt - Date.parse(from)) > 86400000 || Math.abs(endAt - Date.parse(to) - 86400000 + 1) > 86400000)
      throw error('TRACE_DATE_INVALID', '日期范围与本地时区不一致，请重新选择');
    const directory = this.local(this.accountFolder(accountId), false);
    const dates = new Set(fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)) : []);
    for (const day of this.days.values()) if (day.accountId === accountId) dates.add(day.day);
    let rows = [...dates].filter(date => date >= dayOf(startAt) && date <= dayOf(endAt)).flatMap(date => this.day(accountId, date).rows)
      .filter(row => row.createdAt >= startAt && row.createdAt <= endAt);
    if (this.history) { const known = new Set(rows.map(row => row.sourceKey)); rows = [...rows, ...this.history(accountId, { from, to, startAt, endAt }).filter(row => !known.has(row.sourceKey))]; }
    const counts = Object.fromEntries(TRACE_TYPES.map(([id]) => [id, id === 'all' ? rows.length : rows.filter(row => row.type === id).length]));
    const normalized = query.trim().toLocaleLowerCase();
    rows = rows.filter(row => (type === 'all' || row.type === type) && (state === 'all' || state === 'problems' && (TRACE_PROBLEMS.has(row.state) || row.failedSteps > 0) || row.state === state) &&
      (!normalized || [row.id, row.title, row.inputPreview, row.peerId, row.actor, row.note, row.lastStepError].filter(Boolean).join('\n').toLocaleLowerCase().includes(normalized)))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const completed = rows.filter(row => row.finishedAt && row.startedAt), durations = completed.map(row => Math.max(0, row.finishedAt - row.startedAt));
    return { items: rows.slice(offset, offset + limit).map(row => ({ ...row, pendingSave: this.pendingSave(row) })), total: rows.length, offset, limit, from, to, counts,
      summary: { total: rows.length, active: rows.filter(row => TRACE_ACTIVE.has(row.state)).length, problems: rows.filter(row => TRACE_PROBLEMS.has(row.state) || row.failedSteps > 0).length,
        averageMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null },
      warning: this.warning, startedAt: this.startedAt, enabled: true, revision: this.revision };
  }
  context(accountId, id) {
    if (!validId(id)) throw error('TRACE_NOT_FOUND', '这次执行轨迹不存在');
    const day = this.day(accountId, dateOf(id)), row = day.rows.find(item => item.id === id);
    if (!row) throw error('TRACE_NOT_FOUND', '这次执行轨迹不存在或不属于当前账号');
    return { store: this, row, day, parentId: null };
  }
  async get(accountId, id, { offset = 0, limit = 100 } = {}) {
    if (this.historyDetail && String(id).startsWith('history-')) return this.historyDetail(accountId, id);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw error('TRACE_PAGE_INVALID', '轨迹步骤分页不正确');
    const context = this.context(accountId, id), file = this.local(path.join(context.day.directory, id, 'events.jsonl'), false);
    const row = { ...context.row };
    const steps = new Map(); let incomplete = false;
    const live = this.liveEvents.get(id), events = new Map((live?.events || []).map(event => [event.seq, event]));
    for (const line of !live?.full && fs.existsSync(file) ? (await fs.promises.readFile(file, 'utf8')).split('\n') : []) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { incomplete = true; continue; }
      if (!events.has(event.seq)) events.set(event.seq, event);
    }
    for (const event of [...events.values()].sort((a, b) => a.seq - b.seq)) {
      if (event.seq > row.eventCount) continue;
      if (event.event === 'step-start') steps.set(event.step.id, { ...event.step, seq: event.seq });
      if (event.event === 'step-end' && steps.has(event.id)) Object.assign(steps.get(event.id), { state: event.state, finishedAt: event.finishedAt, elapsedMs: event.elapsedMs,
        output: event.output, error: event.error, metadata: { ...steps.get(event.id).metadata, ...event.metadata } });
    }
    const ordered = [...steps.values()].sort((a, b) => a.seq - b.seq);
    if (ordered.length < row.stepCount) incomplete = true;
    if (!TRACE_ACTIVE.has(row.state) && (row.runtimeId !== this.runtimeId || this.closed))
      for (const step of ordered) if (step.state === 'running') { step.state = 'interrupted'; incomplete = true; }
    return { trace: { ...row, pendingSave: this.pendingSave(row), incomplete: row.incomplete || incomplete }, steps: ordered.slice(offset, offset + limit), total: ordered.length, offset, limit, warning: this.warning };
  }
  async content(accountId, id, contentId) {
    if (!/^[a-f0-9]{64}$/.test(contentId || '')) throw error('TRACE_CONTENT_INVALID', '轨迹详情编号不正确');
    const context = this.context(accountId, id);
    const bytes = this.contentCache.get(id + ':' + contentId) || await fs.promises.readFile(this.local(path.join(context.day.directory, id, 'content', contentId + '.json')));
    if (hash(bytes) !== contentId) throw error('TRACE_CONTENT_INVALID', '轨迹详情完整性校验失败');
    return JSON.parse(bytes.toString('utf8'));
  }
  async revoke(scopes, messageKeys = new Map()) {
    if (!this.enabled) {
      if (this.root && fs.existsSync(this.root) && this.warning)
        throw error('AUTHORIZATION_CLEANUP_STATE', '执行轨迹目录不可用，相关数据清理尚未完成');
      return 0;
    }
    await this.flush({ strict: true });
    let count = 0;
    for (const accountId of new Set(scopes.map(scope => scope.accountId))) {
      const account = this.local(this.accountFolder(accountId), false), dates = new Set(
        fs.existsSync(account) ? fs.readdirSync(account).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)) : []);
      for (const day of this.days.values()) if (day.accountId === accountId) dates.add(day.day);
      const keys = messageKeys.get(accountId) || new Set();
      const related = value => {
        if (!value || typeof value !== 'object') return false;
        if (authorizationContains(value, scopes, accountId)) return true;
        if ([value.key, value.messageKey, value.recordKey, value.sourceKey, value.sourceKey?.replace(/^record:/, '')].some(key => keys.has(key))) return true;
        return Object.values(value).some(related);
      };
      for (const date of dates) {
        const day = this.day(accountId, date), removed = [];
        for (const row of day.rows) {
          let matches = related(row);
          const directory = this.local(path.join(day.directory, row.id), false), events = path.join(directory, 'events.jsonl');
          if (!matches && fs.existsSync(events)) for (const line of fs.readFileSync(ownedPath(this.root, events), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (related(event)) { matches = true; break; }
          }
          const content = path.join(directory, 'content');
          if (!matches && fs.existsSync(content)) for (const entry of fs.readdirSync(content, { withFileTypes: true })) {
            if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
            const value = JSON.parse(fs.readFileSync(ownedPath(this.root, path.join(content, entry.name)), 'utf8'));
            if (related(value)) { matches = true; break; }
          }
          if (!matches) continue;
          removeManagedDirectory(this.root, directory); removed.push(row); count++;
          this.erased.add(row.id); if (row.sourceKey) this.erasedSourceKeys.add(accountId + ':' + row.sourceKey);
          for (const map of [this.contexts, this.pendingEvents, this.liveEvents, this.durableSeq]) map.delete(row.id);
          for (const map of [this.pendingContent, this.contentCache]) for (const key of map.keys()) if (key.startsWith(row.id + ':')) map.delete(key);
        }
        if (removed.length) {
          const ids = new Set(removed.map(row => row.id)); day.rows = day.rows.filter(row => !ids.has(row.id)); this.mark(day);
        }
      }
    }
    await this.flush({ strict: true });
    return count;
  }
  async close() { this.closed = true; await this.flush(); }
}
