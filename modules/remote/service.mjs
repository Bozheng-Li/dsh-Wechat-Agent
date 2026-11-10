import { ChannelError } from '../../shared/contracts.mjs';
import { assertRemoteAuthorized } from './authorization/policy.mjs';
import { computerStatus } from './computer/status.mjs';
import { dshTaskStatus } from './tasks/status.mjs';
import { formatDshTasks } from './tasks/format.mjs';
import { promptText } from '../../prompts/loader.mjs';
import { parseRemoteIntent } from './intent/index.mjs';
const gib = bytes => (bytes / 1073741824).toFixed(1) + ' GB';
const time = timestamp => new Date(timestamp).toLocaleString('zh-CN', { hour12: false });

export class RemoteService {
  constructor(channel, providers = {}) { this.channel = channel; this.computer = providers.computer ?? computerStatus; this.tasks = providers.tasks ?? dshTaskStatus; }
  assertAllowed(scope, signal) { assertRemoteAuthorized(this.channel, scope, signal); }
  async query(command, scope, signal) {
    this.assertAllowed(scope, signal);
    if (command.action === 'help') return promptText('remote/messages.json', 'help');
    if (command.action === 'interpret') {
      const result = await this.channel.runner.run({ text: JSON.stringify({ request: command.text }), group: false,
        mode: 'remote-intent', tools: [], history: [], systemOverride: promptText('remote/messages.json', 'intent-system'),
        signal: signal ?? new AbortController().signal });
      this.assertAllowed(scope, signal);
      const queries = parseRemoteIntent(result.text, command.text);
      if (!queries.length) return promptText('remote/messages.json', 'clarify');
      const results = [];
      for (const query of queries) results.push(await this.query(query, scope, signal));
      this.assertAllowed(scope, signal);
      return results.join('\n\n');
    }
    if (!['computer', 'tasks', 'task'].includes(command.action)) throw new ChannelError('REMOTE_COMMAND_INVALID', '远程查询指令无效');
    const result = command.action === 'computer' ? await this.computer({ signal }) : await this.tasks(this.channel.runner?.ctx, command.id);
    this.assertAllowed(scope, signal);
    if (command.action === 'computer') return [
      `电脑状态 · ${time(result.observedAt)}`, `CPU：${result.cpuPercent === null ? '无法确认' : result.cpuPercent + '%'}`,
      `内存：已用 ${gib(result.memory.total - result.memory.free)} / ${gib(result.memory.total)}`,
      `电脑已运行：${Math.floor(result.uptimeSeconds / 60)} 分钟`,
      `DSH Host 进程：${result.hostPid} · 已运行 ${Math.floor(result.hostUptimeSeconds / 60)} 分钟`,
      result.diskStatus === 'available' ? result.disks.map(disk => `${disk.name} 可用 ${gib(disk.free)} / ${gib(disk.total)}`).join('\n') : '磁盘信息暂时无法读取',
    ].filter(Boolean).join('\n');
    return formatDshTasks(result);
  }
}
