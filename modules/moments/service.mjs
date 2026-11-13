import { ChannelError } from '../../shared/contracts.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { assertRemoteAuthorized, remoteAuthorized } from '../remote/authorization/policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { publicError, publishScopeOf } from '../../shared/contracts.mjs';
import { workPath } from '../work/policy.mjs';
import { validateAudienceSelection, audienceUserId } from '../../shared/moments-audience.mjs';
import { MomentsLikeRequests } from './like-requests.mjs';
import { momentsSubjectContext } from '../../shared/moments-subject.mjs';
import { readMomentsImageContext } from './image-context.mjs';
import { matchingMomentPublication, assertPublicationAuthorization } from '../../shared/moments-publication.mjs';
import { ownerPublicationRecord, recoverOwnerPublication } from './publication-recovery.mjs';
import { readMomentsWithMemory, assertMomentTargetAuthorized } from './read.mjs';
import { authorizationEpoch, assertAuthorizationEpoch, assertPersonAuthorized, personAuthorized } from '../../shared/authorization.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function resolveMomentsQuery(transport, raw, scope, signal, check) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  if (raw.subject !== undefined) {
    const { subject, ...query } = raw;
    if (query.action !== 'user' || !['speaker', 'account', 'contact'].includes(subject) ||
        subject !== 'contact' && (query.user !== undefined || query.userId !== undefined))
      throw new ChannelError('MOMENTS_SUBJECT_INVALID', '请先根据语境选择唯一的动态作者，不混填角色与联系人');
    if (subject !== 'contact') {
      const userId = subject === 'speaker' ? scope.senderId : scope.accountId;
      if (typeof userId !== 'string' || !userId) throw new ChannelError('MOMENTS_SUBJECT_INVALID', '当前主体缺少协议确认的微信身份，未猜测主页');
      return { ...query, userId };
    }
    if ((query.user === undefined) === (query.userId === undefined))
      throw new ChannelError('MOMENTS_SUBJECT_REQUIRED', '其他联系人须提供一个已确认的准确昵称、备注或微信 ID');
    const contact = String(query.user ?? query.userId).normalize('NFKC').trim().toLocaleLowerCase();
    if (['我', '我的', '自己', '本人', '你', '你的', '他', '他的', '她', '她的', 'self', 'me', 'my', 'you', 'him', 'her',
      '当前账号', '扫码账号', '机器人', 'account', '发起人', 'sender', 'speaker'].includes(contact))
      throw new ChannelError('MOMENTS_SUBJECT_INVALID', 'contact 须填写准确联系人，角色或代词请按语境改用 speaker/account；未替换成其他主体');
    if (query.userId !== undefined) return resolveMomentsQuery(transport, { ...query, userId: undefined, user: query.userId }, scope, signal, check);
    return resolveMomentsQuery(transport, query, scope, signal, check);
  }
  if (raw.user === undefined) {
    if (raw.action === 'user' && raw.userId === undefined && scope.senderId !== scope.accountId)
      throw new ChannelError('MOMENTS_SUBJECT_REQUIRED', '请根据当前原话与上下文明确选择 subject：speaker、account 或 contact；未默认读取机器人主页');
    return raw;
  }
  const { user, ...query } = raw;
  if (query.action !== 'user' || query.userId !== undefined || typeof user !== 'string' || !user.trim() || user.length > 150)
    throw new ChannelError('MOMENTS_USER_INVALID', '用户主页请选择一个昵称、备注或微信 ID，不同时填写多个目标');
  const normalized = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase(), target = normalized(user);
  if (['我', '我的', '自己', '本人', '你', '你的', '他', '他的', '她', '她的', 'self', 'me', 'my', 'you', 'him', 'her'].includes(target))
    throw new ChannelError('MOMENTS_SUBJECT_REQUIRED', '请先按语境判断代词指谁，再使用 subject：speaker、account 或 contact；未猜测主页');
  if (['当前账号', '扫码账号', '机器人', 'account'].includes(target)) return { ...query, userId: scope.accountId };
  if (['发起人', 'sender'].includes(target)) return { ...query, userId: scope.senderId };
  if (typeof transport.call !== 'function') throw new ChannelError('MOMENTS_USER_UNAVAILABLE', '当前组件不能解析朋友圈昵称，请提供完整微信 ID');
  const contacts = await transport.call('contacts', {}, { signal }); check();
  const matches = contacts.privatePeers.filter(peer => [peer.id, peer.name, peer.nickname, peer.remark].some(name => normalized(name) === target));
  if (matches.length !== 1) throw new ChannelError('MOMENTS_USER_AMBIGUOUS', matches.length ? '这个昵称对应多位联系人，请提供完整微信 ID' : '已同步联系人中没有找到这个昵称，请提供完整微信 ID');
  return { ...query, userId: matches[0].id };
}

/** Live social data follows the actual account, authorized chat and sender. */
export class MomentsService {
  constructor(channel) {
    this.channel = channel; this.writes = new Map();
    this.validateReceipt = (result, query, accountId) => validateReceipt(result, query, accountId, channel.store);
    this.requestLikes = new MomentsLikeRequests(channel, {
      resolve: (query, scope, signal, check) => resolveMomentsQuery(channel.transport, query, scope, signal, check),
      // The narrow request service has already bound this immutable post to
      // the verified requester's target. Never expose this owner bypass to a tool.
      write: (postId, scope, requestId, signal, check) => this.performWrite({ action: 'like', postId }, scope, requestId, signal, check, undefined, true),
    });
  }
  likeRecentAvailable(scope, requestText) { return this.requestLikes.available(scope, requestText); }
  subjects(scope) { return momentsSubjectContext(scope, this.channel.transport.status()); }
  likeRecent(query, scope, requestId, requestText, signal, assertAllowed = () => {}) {
    return this.requestLikes.like(query, scope, requestId, requestText, signal, assertAllowed);
  }
  available(scope) {
    const transport = this.channel.transport;
    return typeof transport.readMoments === 'function' && transport.status().momentsReadReady === true && remoteAuthorized(this.channel, scope);
  }
  writeAvailable(scope) {
    return this.available(scope) && typeof this.channel.transport.writeMoments === 'function' && this.channel.transport.status().momentsWriteReady === true;
  }
  audienceAvailable(scope) {
    return this.available(scope) && typeof this.channel.transport.readMomentsAudience === 'function' && this.channel.transport.status().momentsAudienceReady === true;
  }
  imagesAvailable(scope) {
    return this.available(scope) && typeof this.channel.transport.readMomentsImages === 'function';
  }
  async readImages(query, scope, signal, assertAllowed = () => {}) {
    const check = () => { assertAllowed(); assertRemoteAuthorized(this.channel, scope, signal); };
    check();
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => key !== 'postId'))
      throw new ChannelError('MOMENTS_IMAGE_CONTEXT', '读取朋友圈图片只接受真实动态编号，不接受外部图片地址');
    return readMomentsImageContext(this.channel, { accountId: scope.accountId,
      scopeKey: identity([scope.accountId, scope.chatType, scope.peerId, scope.senderId]), postId: query.postId }, signal, check);
  }
  async audience(scope, signal, assertAllowed = () => {}) {
    const check = () => { assertAllowed(); assertRemoteAuthorized(this.channel, scope, signal); };
    return this.readAudience(scope.accountId, signal, check);
  }
  async audienceOwner(accountId, signal, assertOwner = () => {}) {
    const check = () => {
      assertOwner(); signal?.throwIfAborted(); const status = this.channel.transport.status();
      if (this.channel.closed || this.channel.fault || !status.online || status.account?.id !== accountId)
        throw new ChannelError('ACCOUNT_CHANGED', '微信账号或连接已变化，未返回标签和联系人');
    };
    return this.readAudience(accountId, signal, check);
  }
  async readAudience(accountId, signal, check) {
    check(); const transport = this.channel.transport;
    if (typeof transport.readMomentsAudience !== 'function' || transport.status().momentsAudienceReady !== true)
      throw new ChannelError('MOMENTS_AUDIENCE_UNAVAILABLE', '当前微信组件尚未支持读取标签和联系人，请更新组件');
    const result = await transport.readMomentsAudience({ accountId }, signal); check();
    if (result?.accountId !== accountId || result.source !== 'wechat-contacts-live' || result.membershipComplete !== true || !Array.isArray(result.contacts) || !Array.isArray(result.labels))
      throw new ChannelError('MOMENTS_AUDIENCE_INCOMPLETE', '微信标签或联系人结果不完整／账号不匹配，未使用名单');
    return result;
  }
  async write(query, scope, requestId, signal, assertAllowed = () => {}, operationKey) {
    if (query?.action === 'like' && query.subject !== undefined) {
      const { subject, user, userId, ...write } = query;
      const check = () => { assertAllowed(); assertRemoteAuthorized(this.channel, scope, signal); };
      check();
      const target = await resolveMomentsQuery(this.channel.transport, { action: 'user', subject,
        ...(user === undefined ? {} : { user }), ...(userId === undefined ? {} : { userId }) }, scope, signal, check);
      check();
      const result = await readMomentsWithMemory(this.channel, { accountId: scope.accountId,
        scopeKey: identity([scope.accountId, scope.chatType, scope.peerId, scope.senderId]), query: { action: 'detail', postId: write.postId } }, signal, check);
      check();
      if (result?.accountId !== scope.accountId || result.action !== 'detail' || !Array.isArray(result.items) || result.items.length !== 1 ||
          result.items[0].id !== write.postId || result.items[0].author?.userId !== target.userId)
        throw new ChannelError('MOMENTS_SUBJECT_MISMATCH', '这条动态的实际作者与按语境选择的对象不一致，未点赞；请重新读取正确对象的主页，不要改主体来迎合错误动态');
      return this.performWrite(write, scope, requestId, signal, assertAllowed, operationKey);
    }
    return this.performWrite(query, scope, requestId, signal, assertAllowed, operationKey);
  }
  async writeOwner(query, accountId, requestId, signal, assertOwner = () => {}) {
    return this.performWrite(query, { accountId, chatType: 'owner', peerId: accountId, senderId: accountId }, requestId, signal, assertOwner, undefined, true);
  }
  lookupOwnerReceipt(query, accountId, requestId) {
    if (typeof accountId !== 'string' || typeof requestId !== 'string' || !requestId || requestId.length > 2000 || query?.action !== 'publish')
      throw new ChannelError('MOMENTS_STATE_INVALID', '发布回执查询缺少实际操作归属');
    validateAudienceSelection(query);
    const scopeKey = identity([accountId, 'owner', accountId, accountId]), clientId = 'sns_' + digest([this.channel.store.data.storeId, scopeKey, requestId, 'publish']);
    const file = workPath(this.channel.store.root, 'storage/moments/actions/' + clientId + '.json'); let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new ChannelError('MOMENTS_STATE_INVALID', '发布回执记录无法读取，未重新提交'); }
    if (record.version !== 1 || record.clientId !== clientId || record.ownerStoreId !== this.channel.store.data.storeId || record.scopeKey !== scopeKey || record.inputHash !== digest(query) || record.action !== 'publish' ||
        !['pending', 'succeeded', 'rejected', 'unknown'].includes(record.state)) throw new ChannelError('MOMENTS_STATE_INVALID', '发布回执与当前账号或内容不符，未重新提交');
    if (record.state !== 'succeeded') return null;
    this.validateReceipt(record.result, query, accountId); return { ...record.result, reusedReceipt: true };
  }
  async managePublishing(args, scope, requestId, signal, assertAllowed = () => {}, operationKey) {
    const check = () => { assertAllowed(); assertRemoteAuthorized(this.channel, scope, signal); }; check();
    const manager = this.channel.momentsAutomation?.publishing;
    if (!manager) throw new ChannelError('MOMENTS_UNAVAILABLE', '自动发布组件尚未加载');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 1800 || operationKey !== undefined && (typeof operationKey !== 'string' || !operationKey || operationKey.length > 80))
      throw new ChannelError('MOMENTS_PLAN_INVALID', '自动发布操作缺少实际消息或任务编号');
    const id = 'moments-model:' + digest([scope.accountId, scope.chatType, scope.peerId, scope.senderId, requestId, operationKey ?? args.action]);
    const accountId = scope.accountId;
    switch (args.action) {
      case 'material-search': return this.channel.momentsAutomation.materials.searchImages(accountId, args, signal, check);
      case 'material-download': return this.channel.momentsAutomation.materials.downloadImage(accountId, args, signal, check);
      case 'list': return manager.list(accountId);
      case 'configure': return manager.configure(accountId, args.settings, signal, assertAllowed);
      case 'save': return manager.savePlan(accountId, args.settings, args.id, id, signal, check);
      case 'enable': return manager.setEnabled(accountId, args.id, args.enabled);
      case 'delete': return manager.removePlan(accountId, args.id);
      case 'preview': return manager.preview(accountId, args.settings, id, signal, check);
      case 'edit': return manager.editDraft(accountId, args.id, args.text);
      case 'publish': return manager.publishDraft(accountId, args.id, signal, check);
      case 'discard': return manager.discard(accountId, args.id);
      case 'reconcile': return manager.reconcile(accountId, args.id, signal, check);
      case 'reply-list': { const { publishing, posts, ...value } = this.channel.momentsAutomation.list(accountId); return value; }
      case 'reply-configure': return this.channel.momentsAutomation.configure(accountId, args.settings);
      default: throw new ChannelError('MOMENTS_PLAN_INVALID', '不支持的朋友圈计划操作');
    }
  }
  async performWrite(query, scope, requestId, signal, assertAllowed, operationKey, owner = false) {
    validateAudienceSelection(query);
    const epoch = authorizationEpoch(this.channel.store, scope.accountId);
    signal = this.channel.authorization?.combine(scope.accountId, signal) ?? signal;
    const channel = this.channel, check = () => { assertAllowed(); assertRemoteAuthorized(channel, scope, signal); };
    const verify = owner ? () => { assertAllowed(); signal?.throwIfAborted(); const status = channel.transport.status();
      if (channel.closed || channel.fault || !status.online || status.account?.id !== scope.accountId)
        throw new ChannelError('ACCOUNT_CHANGED', '微信连接、账号或运行状态已变化，未继续朋友圈操作'); } : check;
    const verifyAccount = verify;
    const verifyAuthorization = () => { verifyAccount(); assertAuthorizationEpoch(channel.store, scope.accountId, epoch); };
    verifyAuthorization();
    if (query.action !== 'publish') await assertMomentTargetAuthorized(channel, scope.accountId, query.postId, signal, verifyAuthorization);
    if (owner ? typeof channel.transport.writeMoments !== 'function' || channel.transport.status().momentsWriteReady !== true : !this.writeAvailable(scope))
      throw new ChannelError('MOMENTS_WRITE_UNAVAILABLE', '当前微信组件尚未支持朋友圈互动或发布');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 2000 || operationKey !== undefined && (typeof operationKey !== 'string' || !operationKey || operationKey.length > 80))
      throw new ChannelError('MOMENTS_WRITE_INVALID', '朋友圈操作缺少实际消息或任务归属');
    const scopeKey = identity([scope.accountId, scope.chatType, scope.peerId, scope.senderId]), inputHash = digest(query);
    const defaultKey = query.action === 'publish' ? 'publish' : `${query.action}:${query.postId}:${query.replyToCommentId ?? ''}`;
    const clientId = 'sns_' + digest([channel.store.data.storeId, scopeKey, requestId, operationKey ?? defaultKey]);
    const directory = workPath(channel.store.root, 'storage/moments/actions'), file = path.join(directory, clientId + '.json');
    const save = value => {
      workPath(channel.store.root, 'storage/moments/actions/' + clientId + '.json');
      try { atomicBytes(file, Buffer.from(JSON.stringify(value, null, 2) + '\n')); }
      catch { throw new ChannelError('STATE_WRITE_FAILED', '朋友圈操作记录保存失败，请核对已提交的结果；未自动重试'); }
    };
    if (this.writes.has(clientId)) {
      const active = this.writes.get(clientId);
      if (active.inputHash !== inputHash) throw new ChannelError('MOMENTS_STATE_INVALID', '同一操作编号对应不同内容，未重新执行');
      const result = await active.promise; verify(); return result;
    }
    let existing;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new ChannelError('MOMENTS_STATE_INVALID', '朋友圈操作记录无法读取，未重新执行'); }
    if (existing) {
      if (existing.version !== 1 || existing.clientId !== clientId || existing.ownerStoreId !== channel.store.data.storeId || existing.scopeKey !== scopeKey || existing.inputHash !== inputHash ||
          !['pending', 'succeeded', 'rejected', 'unknown'].includes(existing.state))
        throw new ChannelError('MOMENTS_STATE_INVALID', '朋友圈操作记录或请求内容不匹配，未重新执行');
      if (existing.state === 'succeeded') { this.validateReceipt(existing.result, query, scope.accountId); verify(); return { ...existing.result, reusedReceipt: true }; }
      if (existing.state === 'rejected') throw new ChannelError(existing.error.code, existing.error.message);
      throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '这项朋友圈操作未取得最终确认，结果不明，未自动重试；请先在微信核对');
    }
    const record = { version: 1, ownerStoreId: channel.store.data.storeId, scopeKey, inputHash, clientId, action: query.action,
      accountId: scope.accountId, scope, postId: query.postId, targetUserId: channel.momentOwners?.get(scope.accountId + ':' + query.postId),
      state: 'pending', createdAt: channel.now() };
    save(record); verify();
    const pending = (async () => {
      let recordedSuccess = false;
      try {
        verifyAuthorization();
        const settings = channel.store.settings(scope.accountId),
          publishScope = publishScopeOf(settings);
        const result = await channel.transport.writeMoments({ accountId: scope.accountId, clientId, query,
          // 只有“仅授权好友可见”才自动屏蔽未授权好友；自定义屏蔽名单不替用户屏蔽任何人。
          ...(query.action === 'publish' && publishScope === 'authorized'
            ? { authorizedUserIds: [...settings.privatePeers] } : {}) }, signal);
        this.validateReceipt(result, query, scope.accountId);
        // Cancellation stops further work, but an already confirmed write is
        // still needed for deduplication. Revocation must never restore it.
        assertAuthorizationEpoch(channel.store, scope.accountId, epoch);
        save({ ...record, state: 'succeeded', result, finishedAt: channel.now() }); recordedSuccess = true;
        channel.momentsAutomation?.recordReceipt(result);
        verify(); return result;
      } catch (error) {
        if (!recordedSuccess && error?.code !== 'STATE_WRITE_FAILED' && authorizationEpoch(channel.store, scope.accountId) === epoch) {
          const rejected = ['not-sent', 'rejected'].includes(error?.details?.snsDelivery);
          const publication = query.action === 'publish' ? matchingMomentPublication(error?.details?.publication, query, scope.accountId) : null;
          save({ ...record, state: rejected ? 'rejected' : 'unknown', error: publicError(error, '朋友圈操作未取得最终确认'),
            ...(publication ? { publication } : {}), finishedAt: channel.now() });
        }
        verify(); throw error;
      }
    })();
    this.writes.set(clientId, { inputHash, promise: pending, accountId: scope.accountId });
    try { return await pending; } finally { this.writes.delete(clientId); }
  }
  async read(query, scope, signal, assertAllowed = () => {}) {
    const channel = this.channel;
    const check = () => { assertAllowed(); assertRemoteAuthorized(channel, scope, signal); };
    check();
    if (typeof channel.transport.readMoments !== 'function') throw new ChannelError('MOMENTS_UNAVAILABLE', '当前微信组件尚未支持朋友圈读取，请更新组件');
    const resolved = await resolveMomentsQuery(channel.transport, query, scope, signal, check); check();
    const result = await readMomentsWithMemory(channel, { accountId: scope.accountId,
      scopeKey: identity([scope.accountId, scope.chatType, scope.peerId, scope.senderId]), query: resolved }, signal, check);
    check();
    if (result?.accountId !== scope.accountId) throw new ChannelError('ACCOUNT_CHANGED', '朋友圈结果与当前微信账号不匹配，未返回');
    this.channel.momentsAutomation?.remember(scope.accountId, result.items);
    return result;
  }
  lookupOwnerPublication(query, accountId, requestId) {
    const stored = ownerPublicationRecord(this.channel, query, accountId, requestId);
    return stored && matchingMomentPublication(stored.record.publication, query, accountId);
  }
  async reconcileOwnerPublication(query, accountId, requestId, signal, check) {
    const result = await recoverOwnerPublication(this.channel, query, accountId, requestId, signal, check, this.validateReceipt);
    check();
    if (result.kind === 'published') this.channel.momentsAutomation?.recordReceipt(result.receipt);
    return result;
  }
  async manageInteractions(args, scope, requestId, signal, assertAllowed = () => {}) {
    const check = () => { assertAllowed(); assertRemoteAuthorized(this.channel, scope, signal); }; check();
    const manager = this.channel.momentsAutomation?.interactions;
    if (!manager) throw new ChannelError('MOMENTS_INTERACTION_UNAVAILABLE', '朋友圈互动组件尚未加载');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 1600 || args.operationKey !== undefined &&
        (typeof args.operationKey !== 'string' || !args.operationKey || args.operationKey.length > 80))
      throw new ChannelError('MOMENTS_INTERACTION_INVALID', '互动请求缺少实际消息或任务编号');
    const { accountId } = scope;
    switch (args.action) {
      case 'list': return manager.list(accountId, args.id, scope);
      case 'configure_auto': return manager.automation.configure(accountId, args.settings, args.revision, signal, check, scope);
      case 'stop_auto': return manager.automation.cancel(accountId, scope);
      case 'preview': return manager.preview(accountId, args.options, requestId + ':interaction:' + (args.operationKey ?? 'default'), signal, check, scope);
      case 'edit': return manager.edit(accountId, args.id, args.revision, args.rows, signal, check, scope);
      case 'generate': return manager.generate(accountId, args.id, args.revision, signal, check, scope);
      case 'run': manager.start(accountId, args.id, args.revision, signal, check, scope); return manager.wait(accountId, args.id, scope);
      case 'cancel': return manager.cancel(accountId, args.id, scope);
      default: throw new ChannelError('MOMENTS_INTERACTION_INVALID', '不支持的朋友圈互动操作');
    }
  }
}

function validateReceipt(result, query, accountId, store) {
  const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
  if (result?.accountId !== accountId || result.action !== query.action || !['server-ack', 'verified-existing'].includes(result.delivery) || !id(result.postId) ||
      query.action !== 'publish' && result.postId !== query.postId || query.action === 'like' && result.liked !== true ||
      query.action === 'comment' && (!id(result.commentId) || result.text !== query.text) ||
      query.replyToCommentId && (result.replyToCommentId !== query.replyToCommentId || typeof result.replyToUserId !== 'string' || !result.replyToUserId) ||
      query.action === 'delete' && result.deleted !== true ||
      query.action === 'publish' && (result.text !== query.text || result.imageCount !== (query.images?.length ?? 0)))
    throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '朋友圈操作回执与当前账号、目标或内容不匹配，未报告成功');
  if (query.action === 'publish') {
    const settings = store.settings(accountId);
    // “仅授权好友可见”仍要求完整的授权回执。“自定义屏蔽名单”只要求本次真正
    // 选择过的屏蔽对象得到确认；回执若自带授权证明，仍按授权模式核对。
    if (publishScopeOf(settings) === 'authorized' || result.authorizationConfirmed === true)
      assertPublicationAuthorization(result, accountId,
        settings.privatePeers.filter(id => personAuthorized(store, accountId, id)));
    if (query.blockedUserIds?.length || query.blockedLabelIds?.length) {
      const selection = validateAudienceSelection(query), same = (a, b) => Array.isArray(a) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      const verifiedRead = result.audienceSource === 'wechat-sns-live' && result.delivery === 'verified-existing' && result.readbackConfirmed === true;
      if (result.audienceConfirmed !== true || result.audienceSource !== 'wechat-contacts-live' && !verifiedRead || !Number.isFinite(Date.parse(result.audienceFetchedAt)) ||
          !same(result.audienceSelection?.blockedUserIds, selection.blockedUserIds) || !same(result.audienceSelection?.blockedLabelIds, selection.blockedLabelIds) ||
          !same(result.blockedLabelIds, selection.blockedLabelIds) || !Array.isArray(result.blockedUserIds) || result.blockedUserIds.some(id => !audienceUserId(id)) ||
          result.blockedUserIds.length > 50000 || new Set(result.blockedUserIds).size !== result.blockedUserIds.length || selection.blockedUserIds.some(id => !result.blockedUserIds.includes(id)) ||
          verifiedRead && (!Array.isArray(result.submittedBlockedUserIds) || result.submittedBlockedUserIds.some(id => !audienceUserId(id) || !result.blockedUserIds.includes(id))))
        throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '朋友圈屏蔽选择未取得完整确认，发布结果不明，请在微信核对；未自动重发');
    } else if (publishScopeOf(settings) === 'blocked-list' && result.blockedUserIds !== undefined &&
        (!Array.isArray(result.blockedUserIds) || result.blockedUserIds.some(id => !audienceUserId(id))))
      throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '朋友圈回执的屏蔽名单无效，发布结果不明，请在微信核对；未自动重发');
  }
}
