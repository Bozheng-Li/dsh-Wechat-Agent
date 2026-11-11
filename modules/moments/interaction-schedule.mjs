import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { workPath } from '../work/policy.mjs';
import { assertRemoteAuthorized, remoteAccessReason } from '../remote/authorization/policy.mjs';
import { interactionAutomationSettings } from '../../shared/moments-interaction-settings.mjs';
import { resolveMomentsQuery } from './service.mjs';

const key = accountId => identity([accountId]);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new ChannelError(code, message); };
const emptyCounts = () => ({ selected: 0, liked: 0, commented: 0, alreadyLiked: 0, skippedComments: 0, failed: 0, unknown: 0, remaining: 0 });

/** A durable, per-account clock; interaction selection and all writes belong to
 * the same engine as explicit rounds. Restarts schedule a fresh future check. */
export class MomentsInteractionSchedule {
  constructor(channel, manager) {
    this.channel = channel; this.manager = manager; this.stopped = true;
    this.data = { version: 1, ownerStoreId: channel.store.data.storeId, accounts: {} };
    try {
      const stored = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (stored.version !== 1 || stored.ownerStoreId !== this.data.ownerStoreId || !object(stored.accounts)) throw Error();
      for (const [id, rule] of Object.entries(stored.accounts)) {
        if (!object(rule) || typeof rule.accountId !== 'string' || !rule.accountId || key(rule.accountId) !== id ||
            typeof rule.revision !== 'string' || !rule.revision || !Number.isSafeInteger(rule.enabledAt) || rule.enabledAt < 0 ||
            !Number.isSafeInteger(rule.nextRunAt) || rule.nextRunAt < 0 || !object(rule.scope) || rule.scope.accountId !== rule.accountId ||
            !['owner', 'private', 'group'].includes(rule.scope.chatType) || typeof rule.scope.peerId !== 'string' || typeof rule.scope.senderId !== 'string' ||
            rule.scope.chatType === 'owner' && (rule.scope.peerId !== rule.accountId || rule.scope.senderId !== rule.accountId)) throw Error();
        rule.settings = interactionAutomationSettings(rule.settings);
        if (rule.activeCycle) {
          const record = Object.values(manager.data.runs).find(row => row.accountId === rule.accountId && row.automatic?.cycleId === rule.activeCycle.id);
          rule.lastRun = { id: rule.activeCycle.id, runId: record?.id, startedAt: rule.activeCycle.startedAt, finishedAt: channel.now(),
            state: record?.state ?? 'interrupted', counts: record ? manager.view(record, false).counts : emptyCounts(),
            message: '上轮随插件停止，保留已确认及未知回执；不会补跑或重发' };
          delete rule.activeCycle; this.recovered = true;
        }
        if (rule.settings.enabled) { rule.nextRunAt = channel.now() + rule.settings.intervalMinutes * 60000; this.recovered = true; }
      }
      this.data = stored;
    } catch (error) { if (error.code !== 'ENOENT') this.error = '自动互动设置无法读取或归属无效；原文件保留，定时互动已停止'; }
  }
  file() { return workPath(this.channel.store.root, 'storage/moments/interaction-schedule.json'); }
  save() {
    if (this.error) fail('MOMENTS_INTERACTION_STATE', this.error);
    try { atomicBytes(this.file(), Buffer.from(JSON.stringify(this.data, null, 2) + '\n')); }
    catch { this.error = '自动互动设置或进度无法保存，已停止后续操作'; this.active?.controller.abort(); fail('STATE_WRITE_FAILED', this.error); }
  }
  rule(accountId) { return this.data.accounts[key(accountId)] ?? { accountId, settings: interactionAutomationSettings(), enabledAt: 0, nextRunAt: 0, revision: '' }; }
  access(accountId, scope, signal, assertAllowed = () => {}) {
    signal?.throwIfAborted(); this.manager.lifetime.signal.throwIfAborted(); assertAllowed();
    if (this.error || this.manager.error) fail('MOMENTS_INTERACTION_STATE', this.error || this.manager.error);
    if (this.channel.closed || this.channel.transport.status().account?.id !== accountId) fail('ACCOUNT_CHANGED', '账号已变化，未修改自动互动');
    if (scope && scope.chatType !== 'owner') assertRemoteAuthorized(this.channel, scope, signal);
    if (scope && scope.accountId !== accountId) fail('ACCOUNT_CHANGED', '自动互动设置的账号不一致');
    this.channel.store.config?.assertCurrent();
  }
  pauseReason(accountId, rule) {
    if (this.error || this.manager.error) return this.error || this.manager.error;
    if (!rule.settings.enabled) return '自动互动已关闭';
    if (this.stopped) return '定时器尚未启动';
    const status = this.channel.transport.status();
    if (this.channel.closed || this.channel.fault) return '插件暂不可用，等待恢复';
    if (status.account?.id !== accountId || !status.online) return '等待当前微信账号恢复连接';
    if (!this.channel.store.settings(accountId).enabled) return '自动回复总开关已关闭，自动互动暂停';
    if (!status.momentsReadReady || !status.momentsWriteReady) return '等待朋友圈读写组件就绪';
    if (rule.scope?.chatType !== 'owner' && remoteAccessReason(this.channel, rule.scope)) return '设置此规则的管理员授权已失效，自动互动暂停';
    if (this.manager.active && this.active?.accountId !== accountId) return '等待当前手动互动结束';
    return null;
  }
  list(accountId) {
    const rule = this.rule(accountId), running = this.active?.accountId === accountId;
    return structuredClone({ accountId, settings: rule.settings, revision: rule.revision, enabledAt: rule.enabledAt,
      nextRunAt: rule.nextRunAt, lastRun: rule.lastRun ?? null, running, activeId: running ? this.manager.active?.id ?? null : null,
      schedulerStarted: !this.stopped, pausedReason: this.pauseReason(accountId, rule), error: this.error ?? null });
  }
  async configure(accountId, input, revision, signal, assertAllowed = () => {}, scope) {
    this.access(accountId, scope, signal, assertAllowed);
    const previous = this.rule(accountId);
    if (typeof revision !== 'string' || revision !== previous.revision) fail('MOMENTS_INTERACTION_SETTINGS_CHANGED', '自动互动设置已变化，请刷新最新设置后保存');
    // Validate a patch separately so unknown fields cannot disappear in a merge.
    if (!object(input)) fail('MOMENTS_INTERACTION_SETTINGS_INVALID', '请提供有效的自动互动设置');
    const settings = interactionAutomationSettings({ ...previous.settings, ...input });
    const actor = this.manager.context(accountId, scope).scope;
    if (settings.source === 'user' && settings.enabled) {
      if (!this.channel.transport.status().online) fail('MOMENTS_UNAVAILABLE', '请在微信连接后核实指定好友，再开启自动互动');
      const resolved = await resolveMomentsQuery(this.channel.transport, { action: 'user', subject: 'contact', user: settings.user }, actor, signal,
        () => this.access(accountId, scope, signal, assertAllowed));
      if (resolved.userId === accountId) fail('MOMENTS_INTERACTION_TARGET', '自动互动仅针对好友，请选择其他联系人');
      settings.user = resolved.userId;
    }
    this.access(accountId, scope, signal, assertAllowed);
    if (this.rule(accountId).revision !== revision) fail('MOMENTS_INTERACTION_SETTINGS_CHANGED', '读取好友期间设置已改变，请刷新后保存');
    this.active?.accountId === accountId && this.active.controller.abort(new ChannelError('MOMENTS_INTERACTION_SETTINGS_CHANGED', '自动互动设置已修改，旧轮次停止'));
    const now = this.channel.now();
    this.data.accounts[key(accountId)] = { ...previous, accountId, settings, scope: structuredClone(actor), revision: randomUUID(),
      enabledAt: settings.enabled && !previous.settings.enabled ? now : previous.enabledAt, nextRunAt: settings.enabled ? now + settings.intervalMinutes * 60000 : 0 };
    this.save(); return this.list(accountId);
  }
  cancel(accountId, scope) {
    this.access(accountId, scope);
    if (this.active?.accountId === accountId) this.active.controller.abort(new ChannelError('MOMENTS_INTERACTION_CANCELLED', '已停止本轮自动互动，保留后续定时设置'));
    const rule = this.rule(accountId);
    if (rule.revision) { rule.nextRunAt = rule.settings.enabled ? this.channel.now() + rule.settings.intervalMinutes * 60000 : 0; this.save(); }
    return this.list(accountId);
  }
  start() {
    if (this.timer || this.closed || this.error || this.manager.error) return;
    if (this.recovered) { this.save(); this.recovered = false; }
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 10000); this.timer.unref?.();
  }
  checkRun(accountId, rule, signal) {
    this.access(accountId, rule.scope, signal);
    if (this.stopped || this.rule(accountId).revision !== rule.revision || !this.rule(accountId).settings.enabled)
      fail('MOMENTS_INTERACTION_SETTINGS_CHANGED', '自动互动已停用或设置改变，未继续旧轮次');
    const reason = this.pauseReason(accountId, rule);
    if (reason) fail('MOMENTS_INTERACTION_PAUSED', reason);
  }
  tick() {
    if (this.pending) {
      try { this.checkRun(this.active.accountId, this.active.rule, this.active.controller.signal); }
      catch (error) { this.active.controller.abort(error); }
      return this.pending;
    }
    const accountId = this.channel.transport.status().account?.id, rule = this.rule(accountId);
    if (!accountId || this.pauseReason(accountId, rule) || this.manager.active || rule.nextRunAt > this.channel.now()) return Promise.resolve();
    const cycle = { id: randomUUID(), startedAt: this.channel.now() }, controller = new AbortController();
    const captured = structuredClone(rule); this.active = { accountId, rule: captured, cycle, controller };
    rule.activeCycle = cycle; rule.nextRunAt = this.channel.now() + rule.settings.intervalMinutes * 60000;
    try { this.save(); } catch (error) { this.active = undefined; throw error; }
    this.pending = this.run(accountId, captured, cycle, AbortSignal.any([controller.signal, this.manager.lifetime.signal, AbortSignal.timeout(30 * 60000)]))
      .finally(() => { this.pending = undefined; this.active = undefined; });
    return this.pending;
  }
  async run(accountId, rule, cycle, signal) {
    let result, error;
    try {
      const check = () => this.checkRun(accountId, rule, signal); check();
      result = await this.manager.runAutomatic(accountId, rule.settings, cycle.id, rule.revision, signal, check, rule.scope);
    } catch (cause) { error = publicError(cause, '本轮自动互动未完成'); }
    finally {
      const current = this.rule(accountId);
      if (!this.error && current.activeCycle?.id === cycle.id) {
        current.lastRun = { id: cycle.id, runId: result?.id, startedAt: cycle.startedAt, finishedAt: this.channel.now(),
          state: result?.state ?? (signal.aborted ? 'cancelled' : 'failed'), counts: result?.counts ?? emptyCounts(), scan: result?.scan,
          message: result?.error?.message ?? error?.message ?? (result?.counts.selected ? '本轮完成，结果以逐条微信回执为准' : '本轮没有符合条件的动态') };
        delete current.activeCycle;
        if (current.revision === rule.revision) current.nextRunAt = current.settings.enabled ? this.channel.now() + current.settings.intervalMinutes * 60000 : 0;
        this.save();
      }
    }
    return result;
  }
  async close() { this.closed = true; this.stopped = true; clearInterval(this.timer); this.timer = undefined; this.active?.controller.abort(); await this.whenIdle(); }
  async whenIdle() { await this.pending?.catch(() => {}); }
}
