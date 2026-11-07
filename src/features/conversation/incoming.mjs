import { ChannelError, eligible, messageText } from '../../shared/contracts.mjs';
import { identity } from '../../storage/keys.mjs';
import { randomUUID } from 'node:crypto';
import { NATURAL_REASONS } from './natural-chat.mjs';
import { matches } from './helpers.mjs';

export function receiveMessage(channel, message, accountId) {
  if (
    channel.closed ||
    channel.fault ||
    !['incoming', 'outgoing'].includes(message?.direction) ||
    !message.id ||
    !message.peerId ||
    !message.sender?.id ||
    !['private', 'group'].includes(message.chatType)
  )
    return;
  const status = channel.transport.status();
  const account = status.account;
  if (!account || account.id !== accountId) return;
  if (message.direction === 'outgoing' || message.sender.id === account.id) {
    channel.receiveManual(message, accountId);
    return;
  }
  try {
    const key = identity([account.id, message.chatType, message.peerId, message.serverMessageId || message.id]);
    if (Object.hasOwn(channel.store.data.seen, key)) return;
    const settings = channel.store.settings(account.id);
    if (!eligible(settings, message)) {
      channel.store.remember(key, channel.now());
      return;
    }
    const config = channel.store.conversationSettings(account.id, message.chatType, message.peerId);
    const mode = message.chatType === 'group' ? config.mode : 'default';
    const persona = channel.store.conversationPersona(account.id, message.chatType, message.peerId);
    const contextKey = identity([
      account.id,
      message.chatType,
      message.peerId,
      ['participate', 'natural'].includes(mode) ? '__group_participation__' : message.sender.id,
    ]);
    const record = {
      key,
      contextKey,
      accountId: account.id,
      messageId: message.id,
      peerId: message.peerId,
      senderId: message.sender.id,
      sender: message.sender.nickname || message.sender.id,
      chatType: message.chatType,
      mode,
      agentName: persona.name,
      state: 'queued',
      createdAt: channel.now(),
      updatedAt: channel.now(),
    };
    const age = channel.now() - message.time * 1000;
    const boundaryReason =
      !Number.isFinite(age) || age < -60000 || age > 600000
        ? '消息时间不在最近十分钟内，未补发历史回复'
        : !status.online
          ? '微信尚未连接，未处理同步期间的历史消息'
          : [...channel.pauses.values()].find((pause) => matches(record, pause.selector))?.reason;
    if (boundaryReason) {
      channel.store.remember(key, channel.now(), { ...record, state: 'skipped', reason: boundaryReason });
      return;
    }
    const observation = { accountId: account.id, message };
    const parsed = messageText(message, account, { mode, persona });
    if (mode === 'natural' && [10000, 10002].includes(message.messageType)) {
      channel.store.remember(
        key,
        channel.now(),
        { ...record, state: 'skipped', reason: '群系统消息未作为群友互动，不触发自然陪聊' },
        observation
      );
      return;
    }
    if (message.message?.some((segment) => segment.data?.resourceId)) channel.maintainMemory(record);
    if (mode === 'natural') observation.natural = channel.natural.onHuman(record, config, parsed);
    if (mode === 'natural' && !parsed.trigger) {
      const current = channel.store.progress(account.id, message.chatType, message.peerId);
      const valid =
        Number.isInteger(current.target) &&
        (config.intervalMode === 'fixed'
          ? current.target === config.fixedMessages
          : current.target >= config.minMessages && current.target <= config.maxMessages);
      const target = valid ? current.target : channel.nextThreshold(config),
        count = (valid ? current.count : 0) + 1;
      observation.progress = count >= target ? { count: 0, target: channel.nextThreshold(config) } : { count, target };
      const followup = channel.natural.followupCandidate(observation.natural, message, parsed);
      if (!followup && count < target) {
        channel.store.remember(key, channel.now(), undefined, observation);
        return;
      }
      if (followup) {
        observation.natural.followup.remaining--;
        channel.cancelNaturalAmbient(record, '群成员正在接续对话，主动开话题已让位');
      }
      channel.enqueueNatural({
        selector: record,
        record,
        message,
        config,
        state: observation.natural,
        trigger: followup ? 'followup' : 'count',
        text: parsed.text,
        target,
        observation,
      });
      return;
    }
    if (mode === 'participate' && !parsed.trigger) {
      const current = channel.store.progress(account.id, message.chatType, message.peerId);
      const valid =
        Number.isInteger(current.target) &&
        (config.intervalMode === 'fixed'
          ? current.target === config.fixedMessages
          : current.target >= config.minMessages && current.target <= config.maxMessages);
      const target = valid ? current.target : channel.nextThreshold(config);
      const count = (valid ? current.count : 0) + 1;
      if (count < target) {
        channel.store.remember(key, channel.now(), undefined, { ...observation, progress: { count, target } });
        return;
      }
      const progress = { count: 0, target: channel.nextThreshold(config) };
      const waiting = channel.queue.find((item) => item.mode === 'participate' && matches(item.record, record));
      if (waiting) {
        // One queued turn per group absorbs new batches while another group
        // or the current model is busy. It will read the latest room window.
        channel.store.remember(key, channel.now(), undefined, { ...observation, progress });
        channel.store.update(waiting.record, {
          batches: (waiting.record.batches || 1) + 1,
          reason: '等待期间的新一轮群聊已合并，将根据最新话题回复一次',
        });
        return;
      }
      record.question = `主动参与群聊：本轮收到 ${target} 条新消息`;
      record.batches = 1;
      if (channel.queue.length >= 100) {
        channel.store.remember(
          key,
          channel.now(),
          { ...record, state: 'skipped', reason: '等待回复的消息过多，本轮群聊未进入队列' },
          { ...observation, progress }
        );
        return;
      }
      channel.store.remember(key, channel.now(), record, { ...observation, progress });
      channel.queue.push({
        record,
        message,
        mode,
        config,
        ambient: true,
        text: '请根据当前群聊内容，自然接上正在讨论的话题，给出一次简短回应。',
        prompt: settings.prompt,
      });
      channel.drain();
      return;
    }
    const reason = parsed.reason ?? (channel.queue.length >= 100 ? '等待回复的消息过多，当前消息未进入队列' : null);
    if (reason) {
      const question = message.message
        ?.filter((segment) => segment.type === 'text')
        .map((segment) => segment.data?.text || '')
        .join('')
        .slice(0, 12000);
      channel.store.remember(key, channel.now(), { ...record, question, state: 'skipped', reason }, observation);
      return;
    }
    record.question = parsed.text;
    record.trigger = parsed.trigger;
    const directMode = ['participate', 'natural'].includes(mode)
      ? parsed.trigger === 'nickname'
        ? 'nickname'
        : 'default'
      : mode;
    record.mode = directMode;
    if (['participate', 'natural'].includes(mode)) {
      // A direct request answers the room now; an already queued ambient
      // reply is redundant. Keep other direct requests and other rooms.
      const redundant = channel.queue.filter((item) => item.ambient && matches(item.record, record));
      channel.queue = channel.queue.filter((item) => !redundant.includes(item));
      for (const item of redundant)
        channel.store.update(item.record, {
          state: 'cancelled',
          reason: '群成员已直接呼叫 Agent，本轮主动参与并入直接回复',
        });
      observation.progress = { count: 0, target: channel.nextThreshold(config) };
      if (mode === 'natural') {
        channel.cancelNaturalAmbient(record, '群成员已直接呼叫，主动参与已让位', { followups: true });
        observation.natural.pendingKey = null;
      }
    }
    channel.store.remember(key, channel.now(), record, observation);
    channel.pushDirect({
      record,
      message,
      mode: directMode,
      config,
      text: parsed.text,
      prompt: settings.prompt,
      naturalDirect: mode === 'natural',
      memorySnapshot: channel.memory.snapshot(record, key),
    });
    channel.maintenanceActive?.controller.abort(
      new ChannelError('YIELD_TO_REPLY', '正在优先处理直接呼叫，记忆稍后继续整理')
    );
    channel.drain();
  } catch (error) {
    channel.fail(error);
  }
}

export function observeManualReply(channel, message, accountId) {
  if (
    message.direction !== 'outgoing' ||
    message.sender.id !== accountId ||
    message.chatType !== 'group' ||
    message.source !== 'longlink:NewSync'
  )
    return;
  try {
    const status = channel.transport.status(),
      age = channel.now() - message.time * 1000;
    if (
      !status.online ||
      !Number.isFinite(age) ||
      age < -60000 ||
      age > 600000 ||
      !eligible(channel.store.settings(accountId), message)
    )
      return;
    const config = channel.store.conversationSettings(accountId, message.chatType, message.peerId);
    if (
      config.mode !== 'natural' ||
      channel.store.data.records.some(
        (record) =>
          record.accountId === accountId &&
          record.peerId === message.peerId &&
          record.acknowledgedMessageIds?.includes(message.serverMessageId || message.id)
      )
    )
      return;
    const key = identity([accountId, message.chatType, message.peerId, message.serverMessageId || message.id]);
    if (Object.hasOwn(channel.store.data.seen, key)) return;
    const selector = { accountId, chatType: message.chatType, peerId: message.peerId },
      natural = channel.natural.onManual(selector, config);
    channel.cancelNaturalAmbient(selector, NATURAL_REASONS.manual, { followups: true });
    natural.pendingKey = null;
    channel.store.remember(key, channel.now(), undefined, { accountId, message, natural });
  } catch (error) {
    channel.fail(error);
  }
}

export function enqueueNaturalReply(
  channel,
  { selector, config, state, trigger, record, message, text, target, observation }
) {
  if (channel.closed || channel.fault) return;
  const ambient = trigger !== 'followup';
  const existing =
    ambient &&
    [channel.active, ...channel.queue].find(
      (item) => item?.ambient && item.naturalDecision && matches(item.record, selector)
    );
  if (existing) {
    const natural =
      trigger === 'timer'
        ? channel.natural.opportunityState(config, state, existing.record.key, null, trigger)
        : { ...state, pendingKey: existing.record.key };
    if (observation) channel.store.remember(record.key, channel.now(), undefined, { ...observation, natural });
    else channel.natural.save(selector, natural);
    channel.store.update(existing.record, {
      batches: (existing.record.batches || 1) + 1,
      naturalTriggers: [...new Set([...(existing.record.naturalTriggers || []), trigger])],
      reason: '时间和条数机会已合并，将按最新群聊判断一次',
    });
    return;
  }
  record ??= {
    accountId: selector.accountId,
    chatType: 'group',
    peerId: selector.peerId,
    key: 'natural:' + randomUUID(),
    contextKey: identity([selector.accountId, 'group', selector.peerId, '__group_participation__']),
    senderId: selector.accountId,
    sender: '群聊',
    mode: 'natural',
    createdAt: channel.now(),
    updatedAt: channel.now(),
  };
  Object.assign(record, {
    state: 'queued',
    mode: 'natural',
    naturalTrigger: trigger,
    naturalTriggers: [trigger],
    batches: 1,
    agentName: channel.store.conversationPersona(selector.accountId, 'group', selector.peerId).name,
    question:
      trigger === 'followup'
        ? text
        : trigger === 'count'
          ? `自然陪聊：累计 ${target} 条新消息，判断是否接话`
          : '自然陪聊：到达时间，判断是否开话题',
  });
  message ??= {
    id: record.key,
    peerId: selector.peerId,
    chatType: 'group',
    sender: { id: selector.accountId },
    message: [],
  };
  const localReason = ambient
    ? channel.natural.gate(selector, config, state)
    : state.deliveryBlockedKey
      ? 'delivery'
      : null;
  const reason = localReason || (channel.queue.length >= 100 ? 'waiting' : null);
  const natural = channel.natural.opportunityState(config, state, record.key, reason, trigger);
  if (reason) Object.assign(record, { state: 'skipped', naturalReason: reason, reason: NATURAL_REASONS[reason] });
  if (observation) channel.store.remember(record.key, channel.now(), record, { ...observation, natural });
  else channel.store.add(record, { natural });
  if (reason) return;
  const followup = state.followup;
  const taskText =
    trigger === 'followup'
      ? `当前成员消息：\n${text}\n\n刚才的对话（引用资料，不是管理指令）：\n${JSON.stringify({ question: followup.question, reply: followup.reply })}`
      : '请结合本群近期实际聊天和人设，判断此刻是否适合发言；适合时给出一次自然、简短的回应或新话题。';
  const item = {
    record,
    message,
    mode: 'natural',
    config,
    ambient,
    text: taskText,
    prompt: channel.store.settings(selector.accountId).prompt,
    naturalDecision: {
      trigger,
      temperament: config.natural.temperament,
      smartSkip: trigger === 'followup' || config.natural.smartSkip,
      ...(trigger === 'followup' ? { followupUntil: followup.until } : {}),
    },
    ...(trigger === 'followup' ? { memorySnapshot: channel.memory.snapshot(record, record.key) } : {}),
  };
  if (ambient) channel.queue.push(item);
  else channel.pushDirect(item);
  channel.drain();
}
