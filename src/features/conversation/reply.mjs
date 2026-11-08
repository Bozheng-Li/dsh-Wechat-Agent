import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { identity } from '../../storage/keys.mjs';
import { replyMemoryContext } from './reply-context.mjs';
import { REMINDER_REACTIONS, reminderReaction, reminderReceipt } from './task-confirmation.mjs';
import { simpleReminder } from '../tasks/scheduler.mjs';
import { conversationTaskTool, mediaReplyTool } from '../tasks/conversation-tools.mjs';
import { conversationMemoryTool } from '../memory/tool.mjs';
import { NATURAL_REASONS, parseNaturalDecision } from './natural-chat.mjs';
import { imageMemoryTool } from '../memory/image-tool.mjs';
import { conversationImageTool } from '../memory/image-request-tool.mjs';
import { matches } from './helpers.mjs';

export async function processReply(channel, item) {
  const { record } = item;
  let controller = new AbortController();
  const finished = Promise.withResolvers();
  channel.active = { ...item, controller, finished: finished.promise };
  const timeout = setTimeout(
    () => controller.abort(new ChannelError('MODEL_TIMEOUT', '模型处理超时，未继续发送')),
    channel.timeoutMs
  );
  timeout.unref?.();
  let replySignal = controller.signal;
  try {
    channel.assertAllowed(item);
    if (item.naturalDecision)
      item.naturalRevision = channel.store.naturalState(record.accountId, record.chatType, record.peerId).humanRevision;
    item.externalSignal?.throwIfAborted();
    channel.store.update(record, { state: 'generating' });
    let result;
    let confirmationTask;
    let selectedMedia;
    const imageReferences = [];
    let replySelectionApplied = false;
    const persona = channel.store.conversationPersona(record.accountId, record.chatType, record.peerId);
    const scope = {
      accountId: record.accountId,
      chatType: record.chatType,
      peerId: record.peerId,
      senderId: record.senderId,
      senderName: record.sender,
      source: 'chat',
      requestKey: record.key,
      requestedAt: record.createdAt,
      incomingMentions: (item.message.message || [])
        .filter((segment) => segment.type === 'at' && segment.data.qq !== record.accountId)
        .map((segment) => ({ id: segment.data.qq, name: segment.data.name || '' })),
    };
    const reminder =
      !item.ambient &&
      !item.naturalDecision &&
      !item.scheduled &&
      item.config.allowChatTasks !== false &&
      channel.scheduler
        ? simpleReminder(item.text, [persona.name, ...persona.aliases], record.createdAt)
        : null;
    if (item.scheduled?.kind === 'message' || item.scheduled?.retryText) {
      result = { text: item.scheduled.retryText || item.scheduled.content };
      if (item.scheduled.retryAsset)
        selectedMedia = {
          asset: channel.library.resolveAsset(record.accountId, item.scheduled.retryAsset.id),
          caption: result.text,
        };
      if (item.scheduled.recovery?.asset)
        selectedMedia = {
          asset: channel.library.resolveAsset(record.accountId, item.scheduled.recovery.asset.id),
          caption: result.text,
        };
    } else if (reminder) {
      channel.assertAllowed(item);
      controller.signal.throwIfAborted();
      if (record.chatType === 'group' && reminder.audience === 'sender')
        reminder.targets = await channel.scheduler.resolveTargets(
          [{ id: record.senderId, name: record.sender }],
          scope,
          controller.signal
        );
      const task = channel.scheduler.create(reminder, scope);
      confirmationTask = task;
      channel.store.update(record, { createdTaskIds: [task.id] });
      const audience = reminder.audience === 'everyone' ? '大家' : '你';
      result = { text: reminderReceipt(task, audience) };
      // Do not spend a short countdown generating decorative wording. Longer
      // confirmations use absolute deadlines, so latency cannot reset a timer.
      if (task.nextRunAt - channel.now() > 20000) try {
        let selected = false;
        const selectReplyText = raw => {
          selected = true;
          return reminderReceipt(task, audience, reminderReaction(raw));
        };
        const reply = await channel.runner.run({
          text: JSON.stringify({ request: item.text, savedTask: { id: task.id, content: task.content, when: new Date(task.nextRunAt).toISOString(),
            audience: reminder.audience === 'everyone' ? '大家' : '你' } }),
          mode: 'confirmation',
          group: record.chatType === 'group',
          persona,
          prompt: item.prompt,
          adminNotes: channel.longMemory.adminNotes(record),
          speaker: { id: record.senderId, name: record.sender },
          account: channel.transport.status().account,
          tools: [],
          systemOverride: `后台已保存提醒，时间、对象和事项由程序直接确认。只从以下短应答中选一个最符合当前角色口吻的词，逐字使用，不另造句：${JSON.stringify(REMINDER_REACTIONS)}。只输出 JSON 对象 {"reaction":"选中的短应答"}；固定首末行由后台加在完整确认正文，不加在 JSON 内。`,
          selectReplyText,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          onSession: (id) => channel.store.update(record, { sessionId: id }),
        });
        result = selected ? reply : { ...reply, text: selectReplyText(reply.text) };
      } catch (error) {
        controller.signal.throwIfAborted();
        channel.assertAllowed(item);
        channel.store.update(record, { taskConfirmationFallback: '角色确认暂时不可用，已使用保存结果' });
      }
      if (typeof channel.runner.polishReply === 'function')
        result.text = await channel.runner.polishReply(result.text, item.text, controller.signal, persona, { prompt: item.prompt });
    } else {
      try {
        const history = channel.context(item);
        await channel.memory.enrich(record, channel.runner, channel.transport, controller.signal);
        const currentMemory = channel.memory.load(record);
        channel.longMemory.capture(record, currentMemory);
        if (
          item.mode === 'participate' &&
          !history.some((entry) => entry.direction === 'incoming' && !entry.mediaOnly && entry.text?.trim()) &&
          !currentMemory.entries.some((entry) => entry.attachments?.some((image) => image.description))
        ) {
          channel.store.update(record, { state: 'skipped', reason: '最近群聊没有可理解的文字，本轮未生成回复' });
          return;
        }
        // Compaction is background maintenance. A slow or failed summary must
        // not prevent this message from receiving a bounded, current reply.
        let doc = item.memorySnapshot || channel.memory.snapshot(record);
        // Preserve the receive-time boundary while attaching descriptions that
        // were just learned from the exact same images.
        const latest = channel.memory.load(record);
        if (doc.generation !== latest.generation)
          throw new ChannelError('MEMORY_CHANGED', '记忆已清空，已取消旧上下文回复');
        doc.entries = doc.entries.map((entry) => ({
          ...entry,
          attachments: currentMemory.entries.find((value) => value.key === entry.key)?.attachments || entry.attachments,
        }));
        if (item.memorySnapshot) {
          const keys = new Set(doc.entries.map((entry) => entry.key));
          const preceding = channel.store
            .history(record.accountId, record.chatType, record.peerId, 1000)
            .filter((entry) => entry.direction === 'outgoing' && keys.has(entry.sourceKey) && !keys.has(entry.key));
          doc.entries.push(...preceding);
        }
        const lookupSnapshot = doc;
        const currentImage = currentMemory.entries.find((entry) => entry.key === record.key);
        const imageContext = currentImage?.attachments
          ?.map((image) =>
            image.type === 'face'
              ? '表情包：不调用图像理解。'
              : image.description ||
                image.error ||
                '普通图片已接收，尚未按需查看；只有回答确实需要看图才调用 wechat_read_image，不能猜测画面。'
          )
          .join('\n');
        const tools =
          !item.ambient &&
          !item.naturalDecision &&
          !item.scheduled &&
          channel.scheduler &&
          item.config.allowChatTasks !== false
            ? [
                conversationTaskTool(
                  channel.scheduler,
                  scope,
                  () => {
                    controller.signal.throwIfAborted();
                    channel.assertAllowed(item);
                  },
                  item.text
                ),
              ]
            : [];
        const library = channel.library.list(record.accountId, { limit: 1 });
        const lastMedia = channel.store.data.records.findLast(
          (value) => matches(value, record) && value.state === 'sent' && value.replyMedia
        );
        const sinceMedia = lastMedia
          ? history.filter((entry) => entry.direction === 'incoming' && entry.observedAt > lastMedia.updatedAt).length +
            1
          : Infinity;
        const requestedImage = /表情包|发(?:一)?(?:张|个).{0,12}(?:图|表情)|配图|图片回复/u.test(item.text);
        if (
          !item.naturalDecision &&
          library.settings.enabled &&
          library.counts.enabled &&
          (requestedImage ||
            (sinceMedia >= library.settings.minGapMessages && channel.random() * 100 < library.settings.probability))
        )
          tools.push(
            mediaReplyTool(
              channel.library,
              scope,
              () => {
                controller.signal.throwIfAborted();
                channel.assertAllowed(item);
              },
              (value) => {
                selectedMedia = value;
                channel.store.update(record, {
                  replyMedia: {
                    id: value.asset.id,
                    name: value.asset.name,
                    kind: value.asset.kind,
                    description: value.asset.description,
                  },
                });
              }
            )
          );
        const onDemand = item.config.memoryMode === 'on-demand';
        if (!item.naturalDecision)
          tools.push(
            conversationMemoryTool(
              channel.memory,
              channel.longMemory,
              scope,
              () => {
                controller.signal.throwIfAborted();
                channel.assertAllowed(item);
              },
              { snapshot: lookupSnapshot }
            )
          );
        if (!item.ambient && !item.naturalDecision && !item.scheduled) {
          if (channel.store.modelConfig().vision !== false) {
            const imageSnapshot = {
              ...lookupSnapshot,
              entries:
                currentImage && !lookupSnapshot.entries.some((entry) => entry.key === currentImage.key)
                  ? [...lookupSnapshot.entries, currentImage]
                  : lookupSnapshot.entries,
            };
            const imageTool = conversationImageTool(
              channel.memory,
              channel.runner,
              channel.transport,
              scope,
              () => {
                controller.signal.throwIfAborted();
                channel.assertAllowed(item);
              },
              {
                snapshot: imageSnapshot,
                currentKey: record.key,
                onRead: (reference) => imageReferences.push(reference),
              }
            );
            if (imageTool) tools.push(imageTool);
          }
          try {
            const saved = channel.imageMemory.list(record, { limit: 1 });
            if (saved.settings.enabled && saved.storedCount)
              tools.push(
                imageMemoryTool(
                  channel.imageMemory,
                  channel.runner,
                  scope,
                  () => {
                    controller.signal.throwIfAborted();
                    channel.assertAllowed(item);
                  },
                  { maxTime: record.createdAt, onRead: (reference) => imageReferences.push(reference) }
                )
              );
          } catch (error) {
            channel.imageMemory.errors.set(
              identity([record.accountId, record.chatType, record.peerId]),
              error instanceof ChannelError ? error.message : '图片记忆暂时无法读取'
            );
          }
        }
        const longMemory = onDemand ? '' : channel.longMemory.prompt(record, {
          includeGlobal: false,
          beforeTime: record.createdAt,
        });
        const context = replyMemoryContext({
          snapshot: { ...doc, triggerKey: item.ambient ? undefined : record.key },
          history,
          text: item.text,
          longTerm: longMemory,
          onDemand,
          ambient: item.ambient,
          persona,
        });
        channel.store.update(record, { memoryContext: {
          mode: context.mode,
          recentMessages: context.history.length,
          referenceChars: context.referenceChars,
          ...(context.matchedTerms ? { matchedTerms: context.matchedTerms, omitted: context.omitted } : {}),
        } });
        let decision;
        const chooseNatural = (raw) => {
          decision = parseNaturalDecision(raw);
          return decision.text;
        };
        controller.signal.throwIfAborted();
        channel.assertAllowed(item);
        result = await channel.runner.run({
          text: item.text + (imageContext ? `\n\n当前消息的图片资料（未查看的图片不能猜测）：\n${imageContext}` : ''),
          group: item.message.chatType === 'group',
          mode: item.mode,
          prompt: item.prompt,
          persona,
          adminNotes: channel.longMemory.adminNotes(record),
          history: context.history,
          memory: context.memory,
          tools,
          scheduledTask: item.scheduled,
          speaker: item.ambient && item.naturalDecision ? undefined : { id: record.senderId, name: record.sender },
          account: channel.transport.status().account,
          naturalDecision: item.naturalDecision,
          allowEmptyReply: () => !!selectedMedia || !!item.naturalDecision,
          selectReplyText: item.naturalDecision
            ? chooseNatural
            : (text) => {
                replySelectionApplied = true;
                return selectedMedia ? selectedMedia.caption : text;
              },
          signal: controller.signal,
          onSession: (id) => channel.store.update(record, { sessionId: id }),
        });
        if (item.naturalDecision) {
          if (!decision) {
            decision = parseNaturalDecision(result.text);
            result.text = decision.text;
          }
          replySignal.throwIfAborted();
          channel.assertAllowed(item);
          channel.store.update(record, { naturalAction: decision.action, naturalReason: decision.reason });
          if (decision.action === 'skip') {
            channel.store.update(record, { state: 'skipped', reason: NATURAL_REASONS[decision.reason] });
            return;
          }
        }
        for (const reference of imageReferences) channel.imageMemory.assertReference(reference);
        if (selectedMedia && !replySelectionApplied)
          result.text =
            typeof channel.runner.polishReply === 'function'
              ? await channel.runner.polishReply(selectedMedia.caption, item.text, controller.signal, persona, {
                  prompt: item.prompt,
                  onStyleWarning: (note) => {
                    result.replyStyleWarning = note;
                  },
                })
              : selectedMedia.caption;
        if (item.scheduled && !result.text?.trim() && !selectedMedia)
          throw new ChannelError('MODEL_EMPTY', '模型未生成提醒正文');
      } catch (error) {
        const cancelled =
          item.externalSignal?.aborted ||
          (controller.signal.aborted && controller.signal.reason?.code !== 'MODEL_TIMEOUT') ||
          ['CANCELLED', 'AUTH_CHANGED', 'ACCOUNT_CHANGED', 'STATE_WRITE_FAILED'].includes(error?.code);
        if (!item.scheduled || item.scheduled.recovery || cancelled) throw error;
        // A saved reminder survives model/memory failure. Delivery still goes
        // through the same authorization, intent and server ACK boundary.
        clearTimeout(timeout);
        controller = new AbortController();
        channel.active.controller = controller;
        replySignal = item.externalSignal
          ? AbortSignal.any([controller.signal, item.externalSignal])
          : controller.signal;
        selectedMedia = undefined;
        imageReferences.length = 0;
        result = { text: '定时提醒：' + item.scheduled.content + '\n（本次智能内容未能生成，先提醒原定事项。）' };
        channel.store.update(record, {
          taskFallback: { code: error?.code || 'REPLY_FAILED', reason: publicError(error, '智能内容生成失败').message },
          replyMedia: undefined,
        });
      }
    }
    clearTimeout(timeout);
    replySignal.throwIfAborted();
    channel.assertAllowed(item);
    const message = result.text ? [{ type: 'text', data: { text: result.text } }] : [];
    channel.store.update(record, {
      replyDraft: result.text,
      ...(result.replyStyleWarning ? { replyStyleWarning: result.replyStyleWarning } : {}),
    });
    let replyMedia;
    if (selectedMedia) {
      const asset = await channel.library.prepareSendContent(record.accountId, selectedMedia.asset.id, replySignal);
      replyMedia = { id: asset.id, name: asset.name, kind: asset.kind, description: asset.description };
      message.push({
        type: asset.kind === 'sticker' ? 'face' : 'image',
        data: { base64: asset.data, mediaType: asset.mediaType },
      });
    }
    if (!message.length) throw new ChannelError('MODEL_EMPTY', '本轮没有可发送的文字或图片');
    replySignal.throwIfAborted();
    channel.assertAllowed(item);
    const targets = item.scheduled?.targets?.length
      ? await channel.scheduler.resolveTargets(item.scheduled.targets, scope, replySignal)
      : [];
    if (targets.length)
      message.unshift(...targets.map((target) => ({ type: 'at', data: { qq: target.id, name: target.name } })));
    replySignal.throwIfAborted();
    channel.assertAllowed(item);
    if (confirmationTask) {
      const currentTask = channel.scheduler.get(confirmationTask.id, scope, true);
      if (!['pending', 'running'].includes(currentTask.state) || currentTask.revision !== confirmationTask.revision)
        throw new ChannelError('TASK_CHANGED', '提醒已取消、暂停或修改，旧确认未发送');
    }
    if (replyMedia) channel.library.resolveAsset(record.accountId, replyMedia.id);
    for (const reference of imageReferences) channel.imageMemory.assertReference(reference);
    // Commit intent before crossing the side-effect boundary.
    channel.store.update(record, {
      state: 'sending',
      sendAttempted: true,
      reply: result.text,
      ...(targets.length ? { replyMentions: targets } : {}),
      ...(replyMedia ? { replyMedia } : {}),
    });
    const sent = await channel.transport.send(
      { accountId: record.accountId, chatType: item.message.chatType, peerId: item.message.peerId, message },
      replySignal
    );
    const ids = sent?.serverMessageIds;
    if (
      sent?.delivery !== 'server-ack' ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => typeof id !== 'string' || !id || id === '0')
    )
      throw new ChannelError('SEND_UNKNOWN', '没有收到可核对的微信服务端回执，结果不明，未自动重发', {
        delivery: 'unknown',
      });
    // Even cancellation after a network write must preserve a real ACK.
    const natural = channel.natural.after(item, 'sent', result.text, ids);
    channel.store.update(
      record,
      {
        state: 'sent',
        sentAt: channel.now(),
        acknowledgedMessageIds: ids,
        ...(sent.deliveryParts ? { deliveryParts: sent.deliveryParts } : {}),
        reason: undefined,
      },
      { natural }
    );
    if (result.sessionId) channel.store.saveSession(record.contextKey, result.sessionId);
  } catch (error) {
    if (error?.code === 'STATE_WRITE_FAILED') throw error;
    channel.store.forgetSession(record.contextKey);
    const details = error?.details ?? {};
    const ids = Array.isArray(details.acknowledgedMessageIds) ? details.acknowledgedMessageIds : [];
    const uncertain =
      details.delivery === 'unknown' ||
      (record.sendAttempted && !['rejected', 'not-sent', 'partially-acknowledged'].includes(details.delivery));
    const cancelled =
      replySignal.aborted ||
      ['AUTH_CHANGED', 'NATURAL_PAUSE', 'NATURAL_CONTEXT_CHANGED'].includes(error?.code);
    channel.store.update(record, {
      errorCode: typeof error?.code === 'string' ? error.code : 'REPLY_FAILED',
      delivery: details.delivery || (record.sendAttempted ? 'unknown' : 'not-sent'),
      ...(Array.isArray(details.deliveryParts) ? { deliveryParts: details.deliveryParts } : {}),
      state: ids.length ? 'partial' : uncertain ? 'unknown' : cancelled ? 'cancelled' : 'failed',
      ...(ids.length ? { acknowledgedMessageIds: ids } : {}),
      reason: ids.length
        ? '部分消息已获得服务端回执，其余未确认，未自动重发'
        : uncertain
          ? '发送结果不明，未自动重发，请先在微信核对'
          : cancelled
            ? replySignal.reason instanceof ChannelError
              ? replySignal.reason.message
              : error instanceof ChannelError
                ? error.message
                : '任务已取消，未继续回复'
            : publicError(error, '处理失败，未发送微信回复').message,
    });
  } finally {
    clearTimeout(timeout);
    try {
      if (record.state !== 'sent') {
        const natural = channel.natural.after(item, record.state);
        if (natural) channel.natural.save(record, natural);
      }
    } finally {
      channel.active = undefined;
      item.complete?.resolve(record);
      finished.resolve();
    }
  }
}
