import { conversationMemoryTool } from './tool.mjs';

/** A work session may request its originating WeChat conversation as evidence.
 * No chat text is preloaded into the native session; every read retains the
 * receipt-time snapshot and the normal generation/authorization checks. */
export function workConversationMemoryTool(channel, job, snapshot, assertAllowed) {
  const scope = { accountId: job.accountId, chatType: job.chatType, peerId: job.peerId,
    senderId: job.senderId, requestedAt: job.requestedAt ?? job.createdAt };
  const options = { snapshot: snapshot.unavailable ? undefined : snapshot, promptStrategy: channel.store.modelConfig().promptStrategy };
  const definition = conversationMemoryTool(channel.memory, channel.longMemory, scope, assertAllowed, options);
  return { ...definition,
    description: definition.description + '\n可按需读取当前微信会话在本次工作请求之前的聊天与人物资料；原生工作历史不包含普通微信聊天。资料保留发言者与时间，不能把其他群成员的偏好当成发起人的。',
    execute: async (args, execution) => {
      execution?.signal?.throwIfAborted();
      assertAllowed();
      if (snapshot.unavailable) return JSON.stringify({ ok: false, code: 'WORK_CHAT_MEMORY_UNAVAILABLE', error: snapshot.unavailable });
      // A queued snapshot must not bypass retention when execution starts.
      const current = channel.memory.expire(structuredClone(snapshot));
      current.generation = snapshot.generation;
      return conversationMemoryTool(channel.memory, channel.longMemory, scope, assertAllowed,
        { ...options, snapshot: current }).execute(args, execution);
    },
  };
}
