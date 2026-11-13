import { ChannelError, authorizedConversation, publishScopeOf } from '../../shared/contracts.mjs';
import { assertConversationAuthorized, personAuthorized, authorizationEpoch, assertAuthorizationEpoch } from '../../shared/authorization.mjs';
import { filterAuthorizedMoments, filterAuthorizedMomentsImages, assertMomentTargetAuthorized, assertMomentReplyAuthorized } from '../moments/read.mjs';
import { purgeConversationData } from './conversations.mjs';
import { purgeFeatureData, storedObjectScopes } from './features.mjs';
import { rememberCleanupSources } from './records.mjs';
import { assertPublicationAuthorization } from '../../shared/moments-publication.mjs';

const stopping = () => new ChannelError('AUTHORIZATION_CHANGED', '对象授权已变更，旧操作已停止，正在清空相关数据。', { snsDelivery: 'not-sent' });

/** Current object authorization applies to owner actions, models and timers.
 * Revocations are journaled before cancellation and resumed after a restart. */
export class ObjectAuthorization {
  constructor(channel) {
    this.channel = channel; this.controllers = new Map(); this.calls = new Set(); this.pending = Promise.resolve();
    this.closed = false; this.cleaning = new Set(); this.originals = [];
    this.onChange = change => this.changed(change);
    channel.store.onAuthorizationChange = this.onChange;
    const wrap = (name, prepare, finish = value => value, receipt = false) => {
      const original = channel.transport[name]; if (typeof original !== 'function') return;
      const guard = this;
      const wrapped = function (input, signal, ...rest) {
        return guard.run(input?.accountId, signal, async (combined, check, checkResult) => {
          const params = await prepare(input, combined, check); check();
          const value = await original.call(this, params, combined, ...rest); checkResult();
          return finish(value, params);
        }, receipt);
      };
      channel.transport[name] = wrapped; this.originals.push({ object: channel.transport, name, original, wrapped });
    };
    const conversation = input => {
      const scope = { ...input, chatType: input.chatType || (input.peerId?.endsWith('@chatroom') ? 'group' : 'private') };
      assertConversationAuthorized(channel.store, scope); return scope;
    };
    for (const name of ['send', 'media', 'files', 'reference']) wrap(name, conversation);
    const read = async (input, signal, check) => {
      if (input.query?.userId && input.query.userId !== input.accountId && !personAuthorized(channel.store, input.accountId, input.query.userId))
        throw new ChannelError('OBJECT_NOT_AUTHORIZED', '这位好友未授权，未读取朋友圈。', { snsDelivery: 'not-sent' });
      if (input.query?.action === 'comments')
        await assertMomentTargetAuthorized(channel, input.accountId, input.query.postId, signal, check);
      return { ...input, authorizedUserIds: this.people(input.accountId) };
    };
    const publishScope = accountId => publishScopeOf(channel.store.settings(accountId));
    const write = async (input, signal, check) => {
      const publish = input.query?.action === 'publish', authorized = publish && publishScope(input.accountId) === 'authorized';
      if (authorized && !this.people(input.accountId).length)
        throw new ChannelError('OBJECT_NOT_AUTHORIZED', '当前没有已授权的好友，未上传或发布朋友圈。', { snsDelivery: 'not-sent' });
      if (!publish) {
        await assertMomentTargetAuthorized(channel, input.accountId, input.query?.postId, signal, check);
        if (input.query?.replyToCommentId)
          await assertMomentReplyAuthorized(channel, input.accountId, input.query.postId, input.query.replyToCommentId, signal, check);
      }
      // 自定义屏蔽名单不需要授权名单：只有“仅授权好友可见”才让传输层屏蔽未授权好友。
      return publish && !authorized ? input : { ...input, authorizedUserIds: this.people(input.accountId) };
    };
    const images = async (input, signal, check) => {
      await assertMomentTargetAuthorized(channel, input.accountId, input.query?.postId, signal, check); return input;
    };
    const finishWrite = (value, input) => {
      if (input.query?.action === 'publish' && (publishScope(input.accountId) === 'authorized' || value?.authorizationConfirmed === true))
        assertPublicationAuthorization(value, input.accountId, input.authorizedUserIds ?? this.people(input.accountId));
      return value;
    };
    wrap('writeMoments', write, finishWrite, true);
    wrap('readMoments', read, (value, input) => filterAuthorizedMoments(channel, input, value));
    wrap('readMomentsImages', images, (value, input) => filterAuthorizedMomentsImages(channel, input, value));
    const originalCall = channel.transport.call;
    if (typeof originalCall === 'function') {
      const guard = this;
      const wrapped = function (operation, input, options = {}) {
        const prepare = ['send', 'media', 'files', 'reference', 'members'].includes(operation) ? conversation :
          operation === 'moments.read' ? read : operation === 'moments.write' ? write : operation === 'moments.images' ? images : null;
        if (!prepare) return originalCall.call(this, operation, input, options);
        return guard.run(input?.accountId, options.signal, async (signal, check, checkResult) => {
          const params = await prepare(input, signal, check); check();
          const result = await originalCall.call(this, operation, params, { ...options, signal }); checkResult();
          return operation === 'moments.read' ? filterAuthorizedMoments(channel, params, result) :
            operation === 'moments.write' ? finishWrite(result, params) :
              operation === 'moments.images' ? filterAuthorizedMomentsImages(channel, params, result) : result;
        }, operation === 'moments.write');
      };
      channel.transport.call = wrapped; this.originals.push({ object: channel.transport, name: 'call', original: originalCall, wrapped });
    }
    const workbench = channel.workbench, original = workbench.call, guard = this;
    const wrapped = function (endpoint, input, signal) {
      return guard.run(input?.accountId, signal, combined => original.call(this, endpoint, input, combined));
    };
    workbench.call = wrapped; this.originals.push({ object: workbench, name: 'call', original, wrapped });
    this.ready = this.reconcile();
  }
  people(accountId) { return this.channel.store.settings(accountId).privatePeers.filter(id => personAuthorized(this.channel.store, accountId, id)); }
  combine(accountId, signal) {
    let controller = this.controllers.get(accountId);
    if (!controller) { controller = new AbortController(); this.controllers.set(accountId, controller); }
    return AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  }
  async run(accountId, signal, action, receipt = false) {
    const epoch = authorizationEpoch(this.channel.store, accountId), combined = this.combine(accountId, signal);
    const check = () => {
      combined.throwIfAborted();
      if (this.closed || this.channel.closed || this.isCleaning(accountId)) throw stopping();
      assertAuthorizationEpoch(this.channel.store, accountId, epoch);
    };
    check();
    const checkResult = receipt ? () => {
      assertAuthorizationEpoch(this.channel.store, accountId, epoch);
      if (this.isCleaning(accountId)) throw stopping();
    } : check;
    let listener, revoke;
    const aborted = new Promise((_, reject) => {
      revoke = () => reject(stopping());
      listener = () => { if (!receipt) reject(combined.reason); };
      combined.addEventListener('abort', listener, { once: true });
    });
    const promise = Promise.race([Promise.resolve().then(() => { check(); return action(combined, check, checkResult); }), aborted]);
    const call = { accountId, promise, revoke }; this.calls.add(call);
    try { const value = await promise; checkResult(); return value; }
    finally { combined.removeEventListener('abort', listener); this.calls.delete(call); }
  }
  changed({ accountId, before, settings, revoked }) {
    if (!revoked.length && !(before?.enabled && !settings.enabled)) return;
    const reason = stopping();
    this.controllers.get(accountId)?.abort(reason); this.controllers.set(accountId, new AbortController());
    if (revoked.length) for (const call of this.calls) if (call.accountId === accountId) call.revoke();
    this.channel.personMemory?.cancel({ accountId });
    this.channel.cancel(reason.message, { accountId }, { resetProgress: false });
    if (this.channel.scheduler?.current?.task.accountId === accountId) this.channel.scheduler.current.controller.abort(reason);
    const automation = this.channel.momentsAutomation;
    for (const manager of [automation, automation?.likes, automation?.materials, automation?.publishing])
      if (manager?.activeAccount === accountId) manager.controller?.abort(reason);
    if (automation?.interactions?.active?.accountId === accountId) automation.interactions.active.controller.abort(reason);
    if (automation?.interactions?.automation?.active?.accountId === accountId) automation.interactions.automation.active.controller.abort(reason);
    this.enqueue(revoked);
  }
  enqueue(scopes = []) {
    if (!scopes.length) return this.pending;
    const selected = structuredClone(scopes);
    this.pending = this.pending.catch(() => {}).then(() => this.purge(selected)).catch(error => {
      this.error = '授权已撤销，部分数据清理未完成：' + error.message;
      if (!this.closed) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.enqueue(this.channel.store.data.authorizationRevocations), 30000);
        this.retryTimer.unref?.();
      }
      throw error;
    });
    void this.pending.catch(() => {}); return this.pending;
  }
  reconcile() {
    const { channel } = this;
    const scopes = storedObjectScopes(channel).filter(scope => !authorizedConversation(channel.store.settings(scope.accountId), scope));
    if (scopes.length) {
      const rows = channel.store.data.authorizationRevocations;
      for (const scope of scopes) if (!rows.some(row => row.accountId === scope.accountId && row.chatType === scope.chatType && row.peerId === scope.peerId)) rows.push(scope);
      channel.store.save();
    }
    return this.enqueue(channel.store.data.authorizationRevocations);
  }
  isCleaning(accountId) { return this.cleaning.has(accountId) || this.channel.store.data.authorizationRevocations.some(row => row.accountId === accountId); }
  async purge(scopes) {
    const { channel } = this, accounts = new Set(scopes.map(row => row.accountId));
    const resumes = [...accounts].map(accountId => channel.pause('正在清空撤销授权的数据', { accountId }));
    for (const accountId of accounts) this.cleaning.add(accountId);
    try {
      for (const accountId of accounts) {
        this.controllers.get(accountId)?.abort(stopping()); this.controllers.set(accountId, new AbortController());
        for (const call of this.calls) if (call.accountId === accountId) call.revoke();
      }
      for (const accountId of accounts) channel.cancel('授权已撤销，相关任务已取消', { accountId }, { resetProgress: false });
      channel.personMemory?.cancel();
      await Promise.allSettled([...this.calls].filter(row => accounts.has(row.accountId)).map(row => row.promise));
      for (const accountId of accounts) await channel.whenIdle({ accountId });
      await channel.scheduler?.running; await channel.personMemory?.whenIdle();
      await channel.momentsAutomation?.whenIdle(); await channel.stickers?.whenIdle();
      scopes = rememberCleanupSources(channel, scopes);
      channel.longMemory.revoke(scopes); channel.store.roleCards.revoke(scopes, channel.now());
      await purgeFeatureData(channel, scopes); purgeConversationData(channel, scopes);
      const pending = channel.store.data.authorizationRevocations;
      channel.store.data.authorizationRevocations = pending.filter(row => !scopes.some(scope =>
        row.accountId === scope.accountId && row.chatType === scope.chatType && row.peerId === scope.peerId));
      try { channel.store.save(); } catch (error) { channel.store.data.authorizationRevocations = pending; throw error; }
      if (!channel.store.data.authorizationRevocations.length) {
        this.error = null;
        clearTimeout(this.retryTimer); this.retryTimer = null;
      }
      for (const map of [channel.momentOwners, channel.momentCommentOwners]) for (const key of map?.keys() || [])
        if ([...accounts].some(accountId => key.startsWith(accountId + ':'))) map.delete(key);
      channel.personMemory.nextScanAt = 0; channel.personMemory.wake(0);
    } finally {
      for (const accountId of accounts) this.cleaning.delete(accountId);
      for (const resume of resumes.reverse()) resume();
    }
  }
  async whenIdle() { await this.pending; }
  close() {
    this.closed = true; clearTimeout(this.retryTimer);
    for (const controller of this.controllers.values()) controller.abort(stopping());
    if (this.channel.store.onAuthorizationChange === this.onChange) this.channel.store.onAuthorizationChange = undefined;
    this.restore();
  }
  restore() {
    this.originals = this.originals.filter(({ object, name, original, wrapped }) => {
      if (object[name] !== wrapped) return true;
      object[name] = original; return false;
    });
  }
}
