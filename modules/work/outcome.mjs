import { remoteInspectionRequest, workExecutionError } from './commands.mjs';

const failureMessages = {
  wechat_work_exec: '本机运行验证没有通过，已生成的文件保留。',
  wechat_work_ssh_exec: '有一项远端读取或执行没有成功，已取得的结果保留。',
  wechat_work_ssh_connect: '有一台服务器的 SSH 连接没有通过。',
  wechat_work_vscode_connect: 'VS Code 远程窗口的连接请求未能提交。',
  wechat_work_output: '成果文件尚未完成登记，文件保留在任务目录。',
  wechat_work_generate_image: '图片生成没有成功。',
  wechat_work_read: '有一份任务文件未能读取。',
  wechat_work_write: '有一份任务文件未能写入。',
  wechat_work_list: '有一个任务目录未能读取。',
  wechat_work_status: '有一项状态未能查询。',
  wechat_moments_read: '朋友圈读取没有成功，未视为朋友圈为空。',
  wechat_moments_audience: '微信标签和联系人名单未能完整读取，未视为空名单。',
  wechat_moments_like: '朋友圈点赞尚未取得确认。',
  wechat_moments_comment: '朋友圈评论尚未取得确认。',
  wechat_moments_publish: '朋友圈发布尚未取得确认。',
  wechat_moments_comments: '朋友圈评论区未能读取。',
  wechat_moments_reply: '朋友圈评论回复尚未取得确认。',
  wechat_moments_delete: '朋友圈删除尚未取得确认。',
  wechat_moments_plan: '朋友圈自动发布计划尚未完成设置。',
  wechat_moments_draft: '朋友圈草稿操作尚未完成。',
  wechat_moments_reply_schedule: '朋友圈定时评论设置尚未完成。',
};
const sameHost = (left, right) => String(left.alias ?? left.result.alias ?? '').toLowerCase() === String(right.alias ?? right.result.alias ?? '').toLowerCase();
const remoteTools = new Set(['wechat_work_ssh_connect', 'wechat_work_ssh_exec', 'wechat_work_vscode_connect']);
const useful = op => op.result.ok && !['wechat_work_list', 'wechat_work_ssh_connect'].includes(op.tool);
const sameAttempt = (left, right) => left.tool === right.tool && sameHost(left, right) &&
  (left.paths ? left.paths.every(file => right.result.artifacts?.some(artifact => artifact.path === file))
    : left.path ? left.path === right.path : left.command ? left.command === right.command
      : left.tool === 'wechat_work_status' ? left.action === right.action && left.id === right.id
        : ['wechat_moments_read', 'wechat_moments_comments', 'wechat_moments_audience'].includes(left.tool) ? ['action', 'userId', 'user', 'postId', 'cursor', 'search', 'labelId', 'offset'].every(key => left[key] === right[key])
        : left.tool.startsWith('wechat_moments_') ? left.inputHash === right.inputHash
        : left.tool !== 'wechat_work_output');

/** A failed attempt is evidence, not automatically the outcome of the task.
 * Exact retries can recover; a read-only remote lookup can use another command
 * on the same host. Failed local checks remain required for local/code tasks. */
export function workOutcome(request, operations) {
  const remoteRead = remoteInspectionRequest(request);
  const localRequested = /(?:本机|本地|powershell|windows).{0,40}(?:运行|执行|验证|测试)|(?:编写|生成|修改|运行|执行|测试).{0,30}(?:代码|脚本|程序)|(?:生成|写出|保存|返回|回传|发给).{0,20}(?:文件|报告|文档|表格)/iu.test(request);
  const warnings = operations.flatMap((op, index) => {
    if (op.result.ok) return [];
    const recovered = operations.slice(index + 1).some(next => next.result.ok && (
      sameAttempt(op, next) ||
      op.tool === 'wechat_work_ssh_connect' && remoteTools.has(next.tool) && sameHost(op, next) ||
      remoteRead && op.tool === 'wechat_work_ssh_exec' && next.tool === op.tool && sameHost(op, next)));
    const auxiliary = remoteRead && !localRequested && !remoteTools.has(op.tool) && !op.tool.startsWith('wechat_moments_');
    return [{ operation: index + 1, tool: op.tool, recovered, auxiliary,
      message: op.result.message || failureMessages[op.tool] || '有一项工作操作没有成功。' }];
  });
  const executionError = workExecutionError(request, operations);
  if (executionError) return { state: 'failed', error: executionError, warnings };
  const unresolved = warnings.filter(warning => !warning.recovered && !warning.auxiliary);
  if (!unresolved.length) return { state: 'succeeded', warnings };
  const last = unresolved.at(-1);
  return { state: operations.some(useful) ? 'partial' : 'failed', warnings,
    error: { code: 'WORK_OPERATION_FAILED', message: last.message } };
}
