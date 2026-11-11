import { randomUUID } from 'node:crypto';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { applyFixedReplyBoundaries } from '../../prompts/reply/compose.mjs';

const choice = (values, key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback;

const notices = {
  wechat_web_search: '我先联网找找资料，查到后再告诉你。',
  wechat_memory: '我先翻一下之前的聊天记录。',
  wechat_read_image: '我先看看这张图里的细节。',
  wechat_image_memory: '我先找找之前保存的图片信息。',
  wechat_generated_image_memory: '我先找找之前生成的图片。',
  wechat_reply_media: '我先挑一下合适的图片。',
  wechat_moments_read: '我先看看朋友圈里的实际内容。',
  wechat_moments_images: '我先看看这条朋友圈的配图。',
  wechat_moments_comments: '我先看看这条朋友圈的评论。',
  wechat_moments_audience: '我先核对一下朋友圈的可见范围。',
  wechat_moments_like_recent: '我先找到你说的那条朋友圈，再去点赞。',
  wechat_moments_like: '我这就去给选中的朋友圈点赞。',
  wechat_moments_comment: '我这就去提交这条评论。',
  wechat_moments_reply: '我这就去回复选中的评论。',
  wechat_moments_publish: '我这就去发布这条朋友圈。',
  wechat_moments_delete: '我这就去删除选中的朋友圈。',
  wechat_moments_material_search: '我先联网找找合适的素材。',
  wechat_moments_material_download: '我先把选中的素材取回来。',
  wechat_moments_material_generate: '我先准备一下这次要用的素材。',
  wechat_moments_draft: '我先处理一下这条朋友圈草稿。',
  wechat_moments_plan: '我先处理一下朋友圈发布计划。',
  wechat_moments_reply_schedule: '我先处理一下朋友圈的自动回复安排。',
  wechat_work_start: '我先把这项工作安排好。',
  wechat_work_continue: '我接着处理这项工作。',
  wechat_work_cancel: '我这就去停止这项工作。',
  wechat_work_task: '我先看看这项工作的情况。',
  wechat_work_tasks: '我先看看目前有哪些工作任务。',
  wechat_work_history: '我先翻一下之前的工作记录。',
  wechat_work_parallel: '我先把这几项工作分别安排好。',
  wechat_work_status: '我先查一下当前状态。',
  wechat_work_generate_image: '我这就开始生成图片，可能要等一会儿。',
  wechat_work_list: '我先看看有哪些文件。',
  wechat_work_read: '我先读一下相关文件。',
  wechat_work_write: '我先把这次的内容写入文件。',
  wechat_work_exec: '我先运行一下需要的命令。',
  wechat_work_output: '我先整理一下要交给你的文件。',
  wechat_work_ssh_connect: '我先检查一下远程连接。',
  wechat_work_ssh_exec: '我先在远程环境里执行这一步。',
  wechat_work_vscode_connect: '我先打开这次要用的远程工作区。',
};

/** Describe the action without copying untrusted queries, commands or results. */
export function toolNoticeText(name, args = {}) {
  if (name === 'wechat_capabilities') return '我先看看这一步需要用到什么。';
  if (name === 'wechat_task') return choice({ create: '我先把这个提醒安排好。', list: '我先看看已有的提醒。', cancel: '我这就去取消这个提醒。' }, args?.action, '我先查看一下提醒安排。');
  if (name === 'wechat_moments_interact') return choice({
    preview: '我先看看哪些朋友圈符合这次的要求。',
    run: '我这就按选好的范围处理点赞和评论。',
    configure_auto: '我先设置一下自动刷朋友圈的安排。',
    stop_auto: '我这就去停止自动刷朋友圈。',
    list: '我先看看朋友圈互动的安排和进度。',
  }, args?.action, '我先处理一下这次的朋友圈互动。');
  if (Object.hasOwn(notices, name)) return notices[name];
  if (/^(web_search|search_web|web_fetch|fetch_url|browse|tavily)/i.test(name)) return notices.wechat_web_search;
  if (/^(read_file|read_files|list_directory|list_files|glob|grep|search_files|file_search)/i.test(name)) return '我先查一下相关文件。';
  if (/^(write_file|edit_file|apply_patch|str_replace)/i.test(name)) return '我先修改一下相关文件。';
  if (/^(run_command|bash|pwsh|powershell|terminal|exec_command|run_code)/i.test(name)) return notices.wechat_work_exec;
  return '我先处理这一步，有结果再告诉你。';
}

/** Per-request delivery queue; ACKs belong to notices, never to the final reply. */
export function createToolNotifier(channel, { scope, requestKey, signal, assertAllowed, presentation, workJobId } = {}) {
  const owner = structuredClone(scope), style = structuredClone(presentation);
  const pending = new Map();
  let queue = Promise.resolve();
  return (name, args, execution = {}) => {
    const callId = typeof execution.callId === 'string' && execution.callId ? execution.callId : randomUUID();
    const key = 'tool-notice:' + identity([requestKey, callId]);
    if (pending.has(key)) return pending.get(key);
    const send = async () => {
      const check = () => { signal?.throwIfAborted(); execution.signal?.throwIfAborted(); assertAllowed(); };
      check();
      const previous = channel.store.data.records.find(record => record.key === key);
      if (previous) return previous;
      const text = applyFixedReplyBoundaries(toolNoticeText(name, args), style);
      const record = {
        key, accountId: owner.accountId, chatType: owner.chatType, peerId: owner.peerId,
        senderId: owner.senderId, sender: owner.senderName, sourceKey: requestKey,
        mode: 'tool-progress', toolProgress: true, toolName: name,
        ...(workJobId ? { workJobId } : {}),
        question: '处理提示', reply: text, state: 'sending', sendAttempted: true,
        createdAt: channel.now(), updatedAt: channel.now(),
      };
      // Persist intent before sending, so an uncertain send is never replayed.
      channel.store.add(record);
      try {
        check();
        const delivery = await channel.transport.send({ accountId: owner.accountId,
          chatType: owner.chatType, peerId: owner.peerId, message: [{ type: 'text', data: { text } }] },
          AbortSignal.any([signal, execution.signal, AbortSignal.timeout(10000)].filter(Boolean)));
        const ids = delivery?.serverMessageIds;
        if (delivery?.delivery !== 'server-ack' || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id || id === '0'))
          throw new ChannelError('SEND_UNKNOWN', '开始提示未收到微信服务端回执，未自动重发。', { delivery: 'unknown' });
        // Preserve a real ACK even when cancellation arrives during the write.
        channel.store.update(record, { state: 'sent', sentAt: channel.now(), acknowledgedMessageIds: ids,
          ...(delivery.deliveryParts ? { deliveryParts: delivery.deliveryParts } : {}) });
      } catch (error) {
        if (error?.code === 'STATE_WRITE_FAILED') throw error;
        const details = error?.details ?? {}, ids = details.acknowledgedMessageIds ?? [];
        channel.store.update(record, { state: ids.length ? 'partial' : ['not-sent', 'rejected'].includes(details.delivery) ? 'failed' : 'unknown',
          delivery: details.delivery ?? 'unknown', errorCode: error?.code ?? 'TOOL_NOTICE_FAILED',
          reason: publicError(error, '开始提示发送未确认，未自动重发。').message,
          ...(ids.length ? { acknowledgedMessageIds: ids } : {}),
          ...(details.deliveryParts ? { deliveryParts: details.deliveryParts } : {}) });
      }
      check();
      return record;
    };
    const result = queue.then(send);
    pending.set(key, result);
    queue = result.catch(() => {});
    return result;
  };
}
