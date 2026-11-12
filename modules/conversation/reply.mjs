import { promptText } from "../../prompts/loader.mjs";
import { ChannelError, publicError } from "../../shared/contracts.mjs";
import { identity } from "../../backend/storage/keys.mjs";
import { replyMemoryContext } from "./reply-context.mjs";
import { REMINDER_REACTIONS, reminderReaction, reminderReceipt } from "./task-confirmation.mjs";
import { simpleReminder } from "../tasks/scheduler.mjs";
import { conversationTaskTool, mediaReplyTool } from "../tasks/conversation-tools.mjs";
import { stickerReplyTools } from '../media/sticker-tools.mjs';
import { conversationMemoryTool } from "../memory/query/tool.mjs";
import { NATURAL_REASONS, parseNaturalDecision } from "./natural-chat.mjs";
import { imageMemoryTool } from "../memory/images/tool.mjs";
import { conversationImageTool } from "../memory/images/request-tool.mjs";
import { recentGeneratedImageContext } from '../memory/images/recent.mjs';
import { matches } from "./helpers.mjs";
import { replyToWork, recordWorkCreation } from '../work/dialogue.mjs';
import { routeWorkMessage } from '../work/routing.mjs';
import { workChatFallbackPrompt } from '../work/routing-context.mjs';
import { workPresentation } from '../work/presentation.mjs';
import { momentsTool, momentsCommentsTool, momentsWriteTools, momentsAudienceTool } from '../tools/moments.mjs';
import { momentsLikeRequestTool } from '../tools/moments-likes.mjs';
import { momentsInteractionTool } from '../tools/moments-interactions.mjs';
import { momentsImagesTool } from '../tools/moments-images.mjs';
import { chatMomentsMedia } from '../moments/media.mjs';
import { momentsPublishingTools } from '../tools/moments-publishing.mjs';
import { timeLimitMs } from '../../shared/time-settings.mjs';
import { personRoleCardTool, personRoleContext } from '../memory/roles/tool.mjs';

export async function processReply(channel, item) {
  const { record } = item;
  let controller = new AbortController();
  const finished = Promise.withResolvers();
  const active = { ...item, controller, finished: finished.promise };
  if (item.workLane) channel.workActive.set(record.key, active);
  else channel.active = active;
  let timeout = setTimeout(
    () => controller.abort(new ChannelError('MODEL_TIMEOUT', '模型处理超时，未继续发送')),
    channel.timeoutMs
  );
  timeout.unref?.();
  let momentsWaitExtended = false;
  const extendMomentsWait = action => {
    if (momentsWaitExtended || !['preview', 'publish'].includes(action)) return;
    controller.signal.throwIfAborted();
    momentsWaitExtended = true; clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(new ChannelError('MODEL_TIMEOUT', '朋友圈处理达到设定时限，未继续发送')), timeLimitMs(channel.store, 'momentsPublishTimeoutMinutes') + 15000);
    timeout.unref?.();
  };
  let replySignal = controller.signal;
  try {
    channel.assertAllowed(item);
    if (item.naturalDecision)
      item.naturalRevision = channel.store.naturalState(record.accountId, record.chatType, record.peerId).humanRevision;
    item.externalSignal?.throwIfAborted();
    channel.store.update(record, { state: 'generating' });
    if (item.workRouting) {
      const decision = await routeWorkMessage(channel, item, controller.signal);
      item.workRoute = decision;
      if (decision.action === 'chat') {
        channel.store.update(record, { mode: 'default', workRoute: decision },
          { message: item.message });
        item.memorySnapshot = channel.memory.snapshot(record, record.key);
        // The decision may finish after another member has spoken. Chat
        // admission is delayed, so the memory append order alone is not a cutoff.
        const priorKeys = new Set(channel.context(item).map(entry => entry.key));
        item.memorySnapshot.entries = item.memorySnapshot.entries.filter(entry =>
          (entry.observedAt ?? entry.time ?? Infinity) < record.createdAt || priorKeys.has(entry.key));
        item.prompt = [item.prompt, workChatFallbackPrompt(item)].filter(Boolean).join('\n\n');
      } else {
        item.workCommand = decision.action === 'new' ? { action: 'create', request: item.text }
          : decision.action === 'continue' ? { action: 'continue', id: decision.taskId, request: item.text }
          : { action: decision.action, id: decision.taskId,
            ...(decision.action === 'status' && !decision.taskId ? { all: true } : {}) };
        item.workNatural = true;
        channel.store.update(record, { mode: 'work', workRequest: item.workCommand.action,
          agentName: undefined, workRoute: decision });
      }
    }
    let result;
    let confirmationTask;
    let selectedMedia;
    const imageReferences = [];
    const imageNoteChecks = [];
    let replySelectionApplied = false;
    const persona = item.modeControl || item.workCommand || item.remoteCommand || item.scheduled?.workJobId ? null
      : channel.store.conversationPersona(record.accountId, record.chatType, record.peerId);
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
      !item.modeControl && !item.workCommand && !item.remoteCommand && !item.ambient &&
      !item.naturalDecision &&
      !item.scheduled &&
      item.config.allowChatTasks !== false &&
      channel.scheduler
        ? simpleReminder(item.text, [persona.name, ...persona.aliases], record.createdAt)
        : null;
    const work = item.workCommand;
    if (item.modeControl) {
      result = { text: item.modeResult };
    } else if (item.remoteCommand) {
      try {
        channel.remote.assertAllowed(record, controller.signal);
        item.remoteQueryAuthorized = true;
        result = { text: await channel.remote.query(item.remoteCommand, record, controller.signal) };
      } catch (error) {
        if (['STATE_WRITE_FAILED', 'CONFIG_CHANGED'].includes(error?.code) ||
            (item.remoteQueryAuthorized && ['REMOTE_NOT_AUTHORIZED', 'AUTH_CHANGED'].includes(error?.code)) || controller.signal.aborted) throw error;
        result = { text: publicError(error, '远程查询未完成，请检查管理员设置').message };
      }
    } else if (work) {
      try {
        const workScope = { accountId: record.accountId, chatType: record.chatType,
          peerId: record.peerId, senderId: record.senderId, senderName: record.sender,
          requestedAt: record.createdAt, requestKey: record.key };
        if (work.action !== 'help') { channel.work.assertAllowed(workScope, controller.signal); item.workRequestAuthorized = true; }
        if (item.workNatural && work.request?.length > 12000) throw new ChannelError('WORK_REQUEST_INVALID', '工作要求应为 1–12000 字');
        result = item.workNatural && work.action !== 'input-required' ? await replyToWork(channel, item, workScope, controller.signal)
          : { text: channel.work.handle(work, workScope, { defer: true, onCreated: job => recordWorkCreation(channel, item, job) }) };
      } catch (error) {
        if (['STATE_WRITE_FAILED', 'CONFIG_CHANGED'].includes(error?.code) || controller.signal.aborted ||
            item.workRequestAuthorized && error?.code === 'WORK_NOT_AUTHORIZED') throw error;
        result = { text: publicError(error, '工作任务未创建，请检查工作模式设置').message };
      }
    } else if (item.scheduled?.kind === 'message' || item.scheduled?.retryText) {
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
            audience: reminder.audience === 'everyone' ? promptText("conversation/templates.json", "reply-text-1") : promptText("conversation/templates.json", "reply-text-2") } }),
          mode: 'confirmation',
          group: record.chatType === 'group',
          persona,
          prompt: item.prompt,
          adminNotes: channel.longMemory.adminNotes(record),
          speaker: { id: record.senderId, name: record.sender },
          account: channel.transport.status().account,
          tools: [],
          systemOverride: promptText("conversation/templates.json", "reply-systemOverride-3", [JSON.stringify(REMINDER_REACTIONS)]),
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
        const promptStrategy = channel.store.modelConfig().promptStrategy ?? 'legacy';
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
        let generatedContext = '';
        const imageContext = currentImage?.attachments
          ?.map((image) =>
            image.type === 'face'
              ? '表情包：不调用图像理解。'
              : (image.description && promptStrategy === 'progressive-v1'
                  ? image.description.slice(0, 300) + (image.description.length > 300 ? '（笔记摘录；详情可用图片工具按需读取）' : '') : image.description) ||
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
          library.counts.enabled
        )
        {
          const assertMediaAllowed = () => {
                controller.signal.throwIfAborted();
                channel.assertAllowed(item);
              };
          const selectMedia = (value) => {
                selectedMedia = value;
                channel.store.update(record, {
                  replyMedia: {
                    id: value.asset.id,
                    name: value.asset.name,
                    kind: value.asset.kind,
                    description: value.asset.description,
                    usage: value.asset.usage || '',
                  },
                });
              };
          const options = { excludeIds: lastMedia?.replyMedia?.id ? [lastMedia.replyMedia.id] : [], random: channel.random,
            explicitRequest: requestedImage, cooldown: sinceMedia < library.settings.minGapMessages };
          if (channel.library.search(record.accountId, '', { kind: 'sticker', limit: 1 }).length)
            tools.push(...stickerReplyTools(channel.library, scope, assertMediaAllowed, selectMedia, options));
          if ((requestedImage || sinceMedia >= library.settings.minGapMessages) && channel.library.search(record.accountId, '', { kind: 'image', limit: 1 }).length)
            tools.push(mediaReplyTool(channel.library, scope, assertMediaAllowed, selectMedia, { ...options, imagesOnly: true }));
        }
        const onDemand = item.config.memoryMode === 'on-demand';
        const memoryReadResults = [];
        tools.push(personRoleCardTool(channel, scope, () => {
          controller.signal.throwIfAborted(); channel.assertAllowed(item);
        }, { history: lookupSnapshot.entries, onResult: value => {
          memoryReadResults.push(value); if (memoryReadResults.length > 2) memoryReadResults.shift();
        } }));
        let otherToolUsed = false;
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
              { snapshot: lookupSnapshot, promptStrategy, onResult: value => { memoryReadResults.push(value); if (memoryReadResults.length > 2) memoryReadResults.shift(); } }
            )
          );
        if (!item.ambient && !item.naturalDecision && !item.scheduled) {
          if (channel.moments.likeRecentAvailable(scope, item.text)) {
            const assertAllowed = () => { controller.signal.throwIfAborted(); channel.assertAllowed(item); };
            tools.push(momentsLikeRequestTool({ assertAllowed, subjects: channel.moments.subjects(scope),
              like: (query, signal) => channel.moments.likeRecent(query, scope, record.key, item.text,
                AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed) }));
          }
          if (channel.moments.available(scope)) {
            const assertAllowed = () => { controller.signal.throwIfAborted(); channel.assertAllowed(item); };
            tools.push(momentsTool({ assertAllowed, subjects: channel.moments.subjects(scope),
              read: (query, signal) => channel.moments.read(query, scope, AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed) }));
            tools.push(momentsCommentsTool({ assertAllowed,
              read: (query, signal) => channel.moments.read(query, scope, AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed) }));
            if (channel.moments.imagesAvailable(scope)) tools.push(momentsImagesTool({ assertAllowed,
              readImages: (query, signal) => channel.moments.readImages(query, scope, AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed) }));
            if (channel.moments.audienceAvailable(scope)) tools.push(momentsAudienceTool({ assertAllowed,
              audience: signal => channel.moments.audience(scope, AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed) }));
            if (channel.moments.writeAvailable(scope)) tools.push(...momentsWriteTools({ assertAllowed, subjects: channel.moments.subjects(scope),
              media: chatMomentsMedia(channel, scope, lookupSnapshot, record.key),
              write: (query, signal, operationKey) => { extendMomentsWait(query.action);
                return channel.moments.write(query, scope, record.key, AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed, operationKey); } }));
            if (channel.momentsAutomation?.publishing) tools.push(...momentsPublishingTools({ assertAllowed,
              manage: (args, signal, operationKey) => { extendMomentsWait(args.action);
                return channel.moments.managePublishing(args, scope, record.key, AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed, operationKey); } }));
            if (channel.momentsAutomation?.interactions) tools.push(momentsInteractionTool({ assertAllowed, subjects: channel.moments.subjects(scope),
              manage: (args, signal) => channel.moments.manageInteractions(args, scope, record.key, AbortSignal.any([controller.signal, signal].filter(Boolean)), assertAllowed) }));
          }
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
                promptStrategy,
                currentKey: record.key,
                onRead: (reference) => imageReferences.push(reference),
                onNoteRead: check => imageNoteChecks.push(check),
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
          try {
            const generatedScope = { ...scope, collection: 'generated' },
              assertAllowed = () => { controller.signal.throwIfAborted(); channel.assertAllowed(item); };
            await channel.work.generatedImages.sync(scope, controller.signal, assertAllowed, { before: record.createdAt });
            const saved = channel.imageMemory.list(generatedScope, { limit: 1, before: record.createdAt });
            generatedContext = recentGeneratedImageContext(channel, scope, record.createdAt,
              { onRead: reference => imageReferences.push(reference) });
            if (saved.settings.enabled && saved.total)
              tools.push(imageMemoryTool(channel.imageMemory, channel.runner, generatedScope, assertAllowed,
                { maxTime: record.createdAt, onRead: reference => imageReferences.push(reference) }));
          } catch (error) {
            controller.signal.throwIfAborted();
            channel.imageMemory.errors.set(identity([identity([record.accountId, record.chatType, record.peerId]), 'generated']),
              error instanceof ChannelError ? error.message : '生成图片记忆暂时无法读取');
          }
        }
        const role = onDemand ? null : channel.longMemory.roleContext?.(record, {
          text: item.text, history: doc.entries.filter(entry => entry.key !== record.key), persona, beforeTime: record.createdAt,
        });
        const longMemory = onDemand || role ? '' : channel.longMemory.prompt(record, {
          includeGlobal: false,
          beforeTime: record.createdAt,
        });
        const context = replyMemoryContext({
          snapshot: { ...doc, triggerKey: item.ambient ? undefined : record.key },
          history,
          text: item.text,
          longTerm: longMemory,
          role,
          onDemand,
          ambient: item.ambient,
          persona,
          promptStrategy,
        });
        const personContext = onDemand ? '' : personRoleContext(channel, scope,
          { text: item.text, history: doc.entries, maxChars: 1100 });
        if (personContext) {
          const lines = [personContext];
          for (const line of (context.memory || '').split('\n'))
            if (lines.join('\n').length + line.length + 1 <= 3000) lines.push(line);
          context.memory = lines.filter(Boolean).join('\n');
          context.referenceChars = context.memory.length;
        }
        channel.store.update(record, { memoryContext: {
          mode: context.mode,
          recentMessages: context.history.length,
          referenceChars: context.referenceChars,
          ...(role ? { roleId: role.roleId, selectedFacts: role.selectedIds, targetPeople: role.targets } : {}),
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
          text: item.text + (imageContext ? promptText("conversation/templates.json", "reply-text-4", [imageContext]) : '') +
            (generatedContext ? '\n\n' + generatedContext : ''),
          group: item.message.chatType === 'group',
          mode: item.mode,
          prompt: item.prompt,
          persona: role?.persona || persona,
          adminNotes: role ? role.adminNotes : channel.longMemory.adminNotes(record),
          history: context.history,
          memory: context.memory,
          tools,
          scheduledTask: item.scheduled,
          assertAllowed: () => { controller.signal.throwIfAborted(); channel.assertAllowed(item); },
          onBeforeTool: name => {
            if (!['wechat_memory', 'wechat_role_card', 'wechat_capabilities'].includes(name)) otherToolUsed = true;
          },
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
          onRequestMetrics: requestMetrics => channel.store.update(record, { requestMetrics }),
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
        for (const check of imageNoteChecks) check();
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
        if (!selectedMedia && !item.scheduled && !item.naturalDecision && (!otherToolUsed || generatedContext) &&
            typeof channel.runner.reviewMemoryReply === 'function') {
          const reviewed = await channel.runner.reviewMemoryReply({ text: item.text, persona: role?.persona || persona,
            speaker: { id: record.senderId, name: record.sender }, group: record.chatType === 'group',
            currentContext: [imageContext,
              generatedContext ? recentGeneratedImageContext(channel, scope, record.createdAt) : ''].filter(Boolean).join('\n'),
            imageEvidence: { available: imageReferences.length > 0, visionEnabled: channel.store.modelConfig().vision !== false,
              sent: !!generatedContext },
            memory: context.memory, history: context.history, adminNotes: role ? role.adminNotes : '',
            extraReadResults: memoryReadResults }, result.text, {
              signal: controller.signal, assertAllowed: () => channel.assertAllowed(item),
            });
          result.text = typeof channel.runner.polishReply === 'function'
            ? await channel.runner.polishReply(reviewed.text, item.text, controller.signal, role?.persona || persona, { prompt: item.prompt })
            : reviewed.text;
          channel.store.update(record, { memoryReflection: reviewed.audit });
        }
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
        active.controller = controller;
        replySignal = item.externalSignal
          ? AbortSignal.any([controller.signal, item.externalSignal])
          : controller.signal;
        selectedMedia = undefined;
        imageReferences.length = 0;
        imageNoteChecks.length = 0;
        result = { text: promptText("conversation/templates.json", "reply-text-5") + item.scheduled.content + promptText("conversation/templates.json", "reply-text-6") };
        channel.store.update(record, {
          taskFallback: { code: error?.code || 'REPLY_FAILED', reason: publicError(error, '智能内容生成失败').message },
          replyMedia: undefined,
        });
      }
    }
    clearTimeout(timeout);
    replySignal.throwIfAborted();
    channel.assertAllowed(item);
    if ((item.modeControl || item.workCommand || item.remoteCommand ||
        item.scheduled?.workJobId && !item.scheduled.workStyled && !item.scheduled.workProgress) && typeof channel.runner.polishReport === 'function') {
      result.text = await channel.runner.polishReport(result.text,item.text,replySignal,workPresentation(channel,record));
      replySignal.throwIfAborted(); channel.assertAllowed(item);
    }
    const message = result.text ? [{ type: 'text', data: { text: result.text } }] : [];
    const workArtifacts = item.scheduled?.workJobId && !item.scheduled.workProgress ? channel.work.prepareArtifacts(item.scheduled.workJobId, record, replySignal, item.scheduled.workRetryId) : [];
    message.push(...workArtifacts.map(value => value.segment));
    channel.store.update(record, {
      replyDraft: result.text,
      ...(workArtifacts.length ? { replyArtifacts: workArtifacts.map(value => value.metadata) } : {}),
      ...(result.replyStyleWarning ? { replyStyleWarning: result.replyStyleWarning } : {}),
      ...(result.emptyResponseRetries ? { emptyResponseRetries: result.emptyResponseRetries } : {}),
    });
    let replyMedia;
    if (selectedMedia) {
      const asset = channel.library.resolveAsset(record.accountId, selectedMedia.asset.id);
      replyMedia = { id: asset.id, name: asset.name, kind: asset.kind, description: asset.description };
      message.push(await channel.library.prepareSendSegment(record.accountId, asset.id, replySignal,
        { nativeReady: channel.transport.status().nativeStickersReady !== false }));
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
    for (const check of imageNoteChecks) check();
    // Commit intent before crossing the side-effect boundary.
    channel.store.update(record, {
      state: 'sending',
      sendAttempted: true,
      reply: result.text,
      ...(targets.length ? { replyMentions: targets } : {}),
      ...(replyMedia ? { replyMedia } : {}),
    });
    if (item.scheduled?.workJobId && !item.scheduled.workProgress) channel.work.sending(item.scheduled.workJobId, item.scheduled.workRetryId);
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
    if (workArtifacts.length) {
      const parts = sent.deliveryParts?.filter(value => value.type !== 'text');
      if (!Array.isArray(parts) || parts.length !== workArtifacts.length || new Set(parts.map(part => part.serverMessageId)).size !== parts.length || parts.some((part, index) => {
        const artifact = workArtifacts[index].metadata;
        return part.state !== 'acknowledged' || part.type !== artifact.kind || part.name !== artifact.name || part.sha256 !== artifact.sha256 || part.bytes !== artifact.bytes || !ids.includes(part.serverMessageId);
      })) throw new ChannelError('SEND_UNKNOWN', '工作成果缺少逐文件可核对的微信确认，送达结果不明，未自动重发', {
        delivery: 'partially-acknowledged', acknowledgedMessageIds: ids, deliveryParts: sent.deliveryParts ?? [],
      });
    }
    // Even cancellation after a network write must preserve a real ACK.
    const natural = item.modeControl || item.workCommand || item.scheduled?.workJobId ? undefined : channel.natural.after(item, 'sent', result.text, ids);
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
    const failureMessage = publicError(error, '').message;
    channel.store.update(record, {
      errorCode: typeof error?.code === 'string' ? error.code : 'REPLY_FAILED',
      delivery: details.delivery || (record.sendAttempted ? 'unknown' : 'not-sent'),
      ...(Array.isArray(details.deliveryParts) ? { deliveryParts: details.deliveryParts } : {}),
      state: ids.length ? 'partial' : uncertain ? 'unknown' : cancelled ? 'cancelled' : 'failed',
      ...(ids.length ? { acknowledgedMessageIds: ids, acknowledgedAt: channel.now() } : {}),
      reason: ids.length
        ? '部分消息已获得服务端回执，其余未确认，未自动重发' + (failureMessage ? '；' + failureMessage : '')
        : uncertain
          ? '发送结果不明，未自动重发，请先在微信核对' + (failureMessage ? '；' + failureMessage : '')
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
      if (record.state !== 'sent' && !item.modeControl && !item.workCommand && !item.scheduled?.workJobId) {
        const natural = channel.natural.after(item, record.state);
        if (natural) channel.natural.save(record, natural);
      }
    } finally {
      if (item.workLane) channel.workActive.delete(record.key);
      else channel.active = undefined;
      if (item.createdWorkJobIds?.length) channel.work.release(item.createdWorkJobIds);
      item.complete?.resolve(record);
      finished.resolve();
    }
  }
}
