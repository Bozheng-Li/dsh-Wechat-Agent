import { ChannelError } from '../../shared/contracts.mjs';

/** Members of authorized groups are authorized people by default, so the person
 * level features (资料整理、朋友圈、@) do not need a second authorization. The
 * member list is refreshed in the background and persisted: authorization checks
 * stay synchronous, the last confirmed list survives a restart, and a single
 * failed refresh can never revoke everyone at once. */
export class GroupMemberIndex {
  constructor(channel, { intervalMs = 30 * 60_000, retryMs = 2 * 60_000, tickMs = 30_000 } = {}) {
    this.channel = channel;
    this.intervalMs = intervalMs;
    this.retryMs = retryMs;
    this.closed = false;
    this.running = null;
    this.controller = null;
    this.nextAt = 0;
    this.error = null;
    this.wakeAt = 0;
    this.wakeTimer = null;
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
    this.wake(0);
  }
  status(accountId) {
    const view = typeof this.channel.store.groupMemberIndexView === 'function'
      ? this.channel.store.groupMemberIndexView(accountId)
      : { syncedAt: null, authorizedGroups: 0, indexedGroups: 0, members: 0, excluded: 0 };
    return { ...view, syncing: !!this.running, error: this.error };
  }
  wake(delay = 1000) {
    if (this.closed) return;
    const at = this.channel.now() + delay;
    if (this.wakeTimer) {
      if (this.wakeAt <= at) return;
      clearTimeout(this.wakeTimer);
    }
    this.wakeAt = at;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = 0;
      this.nextAt = 0;
      this.tick();
    }, Math.max(0, delay));
    this.wakeTimer.unref?.();
  }
  tick() {
    if (this.closed) return;
    if (this.running) {
      // A change arrived while a refresh was running; run once more afterwards
      // instead of waiting for the next interval.
      this.pendingWake = true;
      return;
    }
    const status = this.channel.transport.status(),
      accountId = status?.account?.id;
    if (!status?.online || !accountId) return;
    const groups = this.channel.store.settings(accountId).groups;
    if (!groups.length) {
      this.error = null;
      return;
    }
    if (this.channel.authorization?.isCleaning?.(accountId)) return;
    if (this.channel.now() < this.nextAt) return;
    this.running = this.sync(accountId)
      .catch((error) => {
        if (this.closed) return;
        this.error = error?.message || '群成员名单刷新失败，稍后重试';
        this.nextAt = this.channel.now() + this.retryMs;
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
        if (this.pendingWake) {
          this.pendingWake = false;
          this.wake(0);
        }
      });
  }
  async sync(accountId) {
    const store = this.channel.store,
      groups = [...store.settings(accountId).groups],
      previous = typeof store.groupMemberIndex === 'function' ? store.groupMemberIndex(accountId) : null,
      controller = new AbortController(),
      entries = {},
      failures = [];
    this.controller = controller;
    for (const groupId of groups) {
      controller.signal.throwIfAborted();
      const current = this.channel.transport.status();
      if (current?.account?.id !== accountId) throw new ChannelError('ACCOUNT_CHANGED', '微信账号已变化，已停止刷新群成员');
      if (!current.online) throw new ChannelError('WORKER_OFFLINE', '微信当前离线，已停止刷新群成员');
      try {
        const result = await this.channel.transport.call(
          'members',
          { accountId, peerId: groupId },
          { signal: controller.signal, timeoutMs: 30_000 }
        );
        if (!result || result.accountId !== accountId || result.peerId !== groupId || !Array.isArray(result.members))
          throw new ChannelError('GROUP_MEMBERS_UNAVAILABLE', '群成员名单与当前账号或群聊不匹配，未更新');
        // A group revoked while the request was in flight must not keep members.
        if (!store.settings(accountId).groups.includes(groupId)) continue;
        // The worker has already limited the rows to this group; do not filter
        // again on an optional field, a missing groupId would look like an empty
        // group and revoke everyone.
        entries[groupId] = { ids: result.members.filter(Boolean).map(member => member.id), at: this.channel.now() };
      } catch (error) {
        if (controller.signal.aborted || ['AUTHORIZATION_CHANGED', 'CANCELLED', 'ACCOUNT_CHANGED'].includes(error?.code))
          throw error;
        failures.push(error?.message || '群成员名单读取失败');
        // Keep the last confirmed list instead of treating a failed read as an
        // empty group, which would revoke every member at once.
        if (Array.isArray(previous?.groups?.[groupId]?.ids))
          entries[groupId] = { ids: previous.groups[groupId].ids, at: previous.groups[groupId].at };
      }
    }
    controller.signal.throwIfAborted();
    // Keep the previous timestamp when nothing could be read, so a stale index
    // is visible as stale instead of looking freshly confirmed.
    store.saveGroupMemberIndex(accountId, entries, {
      syncedAt: groups.length && failures.length === groups.length ? previous?.syncedAt : this.channel.now(),
    });
    this.error = failures.length ? '部分群聊成员未能刷新：' + failures[0] : null;
    this.nextAt = this.channel.now() + (failures.length ? this.retryMs : this.intervalMs);
    return this.status(accountId);
  }
  async whenIdle() {
    await this.running?.catch(() => {});
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.controller?.abort(new ChannelError('CANCELLED', '插件已停止，群成员刷新已中止'));
  }
}