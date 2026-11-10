import { ChannelError } from '../../../shared/contracts.mjs';
import { promptText } from '../../../prompts/loader.mjs';
import { remoteAccessReason } from '../../remote/authorization/policy.mjs';

const label = mode => mode === 'work' ? '工作模式' : '聊天模式';
export class ExecutionModeService {
  constructor(channel) { this.channel = channel; }
  assertAllowed(scope, signal) {
    signal?.throwIfAborted();
    const channel = this.channel;
    channel.store.config.assertCurrent();
    const reason = remoteAccessReason(channel, scope);
    if (reason) throw new ChannelError('MODE_NOT_AUTHORIZED', promptText('work/tools.json', 'mode-denied-' + reason, [scope.senderId]));
    if ([...channel.pauses.values()].some(pause => ['accountId', 'chatType', 'peerId', 'senderId'].every(key => pause.selector?.[key] === undefined || pause.selector[key] === scope[key])))
      throw new ChannelError('AUTH_CHANGED', '当前会话正在应用设置，未继续切换模式');
  }
  /** Commit at reception, before later messages can be admitted using the old mode. */
  handle(command, record) {
    this.assertAllowed(record);
    const channel = this.channel, store = channel.store;
    const current = store.conversationSettings(record.accountId, record.chatType, record.peerId);
    if (command.action === 'help') return promptText('work/tools.json', 'mode-help');
    if (command.action === 'status') return promptText('work/tools.json', 'mode-status', [label(current.executionMode)]);
    if (command.action !== 'set' || !['chat', 'work'].includes(command.target)) throw new ChannelError('MODE_INVALID', '模式切换目标无效');
    const changed = command.target !== current.executionMode;
    const change = { from: current.executionMode, to: command.target, changed, state: 'pending' };
    store.update(record, { modeChange: change });
    if (changed) store.setConversationSettings(record.accountId, record.chatType, record.peerId, { ...current, executionMode: command.target });
    store.update(record, { modeChange: { ...change, state: 'saved' } });
    this.assertAllowed(record);
    if (changed) channel.cancelExecutionMode({ accountId: record.accountId, chatType: record.chatType, peerId: record.peerId },
      '管理员已切换当前会话的执行模式，旧任务未继续执行或发送');
    return promptText('work/tools.json', changed ? 'mode-switched' : 'mode-unchanged', [label(command.target)]) +
      (command.target === 'work' ? promptText('work/tools.json', 'mode-work-guide') : promptText('work/tools.json', 'mode-chat-guide'));
  }
}
