import fs from 'node:fs';
import path from 'node:path';

export const workStateLabels = { queued: '等待执行', running: '正在执行', succeeded: '本轮执行已结束', partial: '部分完成', failed: '执行失败', cancelled: '已取消', interrupted: '执行中断' };
export const workDeliveryLabels = { 'not-ready': '尚无结果', 'not-sent': '未发送', pending: '等待回传', sending: '等待微信回执', sent: '微信已确认', failed: '回传失败', unknown: '回传结果不明', partial: '部分已确认', suppressed: '未回传' };
export function workFiles(cwd) {
  const files = [];
  const visit = (directory, depth) => {
    if (depth > 8 || files.length >= 100) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['.wechat-work', '.git', 'node_modules', '.venv'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && files.length < 100) files.push({ path: path.relative(cwd, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size });
    }
  };
  visit(cwd, 0); return files;
}
function localImageText(text, artifacts) {
  const images = artifacts.filter(value => value.kind === 'image');
  if (!images.length) return text;
  const normalize = value => {
    try { value = decodeURIComponent(value); } catch { return null; }
    if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(value)) return null;
    return path.posix.normalize(value.replaceAll('\\', '/')).toLowerCase();
  };
  const paths = new Set(images.map(value => normalize(value.path)));
  for (const image of images) if (images.filter(value => value.name.toLowerCase() === image.name.toLowerCase()).length === 1)
    paths.add(normalize(image.name));
  // Preserve fenced and inline code, remote URLs and unregistered images.
  const inline = /(`+)([\s\S]*?)\1(?!`)|!\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\s()\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\)/g;
  const clean = value => value.replace(inline, (match, code, _content, anglePath, plainPath) => {
    if (code) return match;
    const target = normalize(anglePath ?? plainPath);
    return target !== null && paths.has(target) ? '' : match;
  });
  let fence, pending = '', output = '';
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/.exec(line);
    if (fence) {
      output += line;
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      output += clean(pending) + line; pending = ''; fence = marker[1];
    } else pending += line;
  }
  return (output + clean(pending)).trim();
}
/** The conversation gets the answer. The workbench and archive keep evidence. */
export function workReply(job) {
  const answer = localImageText(job.result?.text?.trim() || '', job.result?.artifacts ?? []);
  if (job.state === 'failed') return '这次没能完成。' + (job.error?.message || '执行遇到问题，已生成的文件和记录保留。');
  if (job.state === 'partial') return ['这次完成了一部分，' + (job.error?.message || '还有未完成的事项。'), answer].filter(Boolean).join('\n\n');
  if (['cancelled', 'interrupted'].includes(job.state)) return (job.error?.message || '任务已停止。') + '\n已生成的文件和记录保留。';
  const editor = job.operations?.findLast(op => op.tool === 'wechat_work_vscode_connect');
  return [answer || (job.result?.artifacts?.some(value => value.kind === 'image') ? '图片已生成，等待微信回执。' : '这次任务已处理完。'), editor?.result.ok && editor.result.connectedConfirmed === false
    ? 'VS Code 的连接请求已提交，编辑器是否连接就绪尚未确认。' : ''].filter(Boolean).join('\n\n');
}
export function workResult(job, cwd, { full = false } = {}) {
  if (!full) return workReply(job);
  const commands = job.operations.filter(op => ['wechat_work_exec', 'wechat_work_ssh_exec'].includes(op.tool));
  const connections = job.operations.filter(op => ['wechat_work_ssh_connect', 'wechat_work_vscode_connect'].includes(op.tool));
  const queries = job.operations.filter(op => op.tool === 'wechat_work_status');
  const text = [
    `工作任务 ${job.id} · ${workStateLabels[job.state]}`,
    `目录：${cwd}`,
    job.sessionId ? `DSH 会话：${job.sessionId}` : '',
    job.sessionHistory ? `DSH 留档：${job.sessionHistory.state === 'visible' ? '历史会话已保留并展示' : job.sessionHistory.message || '历史记录已保存'}` : '',
    job.error ? `原因：${job.error.message}` : '',
    job.warnings?.length ? '执行过程记录：\n' + job.warnings.map(warning => `操作 ${warning.operation} · ${warning.recovered ? '后续已恢复' : warning.auxiliary ? '辅助步骤受阻' : '尚未完成'}：${warning.message}`).join('\n') : '',
    job.result?.text ? `DSH 回复：\n${(job.result.originalText ?? job.result.text).slice(0, full ? 100000 : 7500)}` : '',
    job.result?.polish?.state === 'applied' ? `微信文字：\n${job.result.text}` : '',
    job.result?.polish?.state === 'fallback' ? '文字润色未应用，微信回传 DSH 原文。' : '',
    connections.length ? '实际连接结果：\n' + connections.slice(full ? 0 : -10).map(op =>
      `${op.tool === 'wechat_work_ssh_connect' ? 'SSH 验证' : 'VS Code 连接'} · ${op.alias || op.result.alias || '指定主机'}：${op.result.message || (op.result.ok ? '操作已返回' : '操作失败')}${op.result.exitCode === undefined ? '' : `\n退出码 ${op.result.exitCode}${op.result.timedOut ? '（超时）' : ''}`}${op.result.steps?.length ? '\n' + op.result.steps.map((step, index) => `${index + 1}. ${step.name}：${step.ok ? '已通过' : '未通过'}${step.exitCode === undefined ? '' : `（退出码 ${step.exitCode}）`}`).join('\n') : ''}${op.result.stderr ? '\n' + op.result.stderr.slice(-1200) : ''}`).join('\n') : '',
    commands.length ? '实际命令结果：\n' + commands.slice(full ? 0 : -10).map(op =>
      `${op.tool === 'wechat_work_ssh_exec' ? 'SSH · ' + (op.alias || op.result.alias) + '\n' : ''}${String(op.command ?? '').slice(0, full ? 4000 : 300)}\n${op.result.exitCode === undefined ? (op.result.message || '无退出码') : `退出码 ${op.result.exitCode}${op.result.timedOut ? '（超时）' : ''}`}\n${op.result.sandbox?.enforcement === 'partial' ? 'DSH 沙箱：平台报告部分保护' : ''}\n${[op.result.stdout, op.result.stderr].filter(Boolean).join('\n').slice(0, full ? 16000 : 1200)}${op.result.stdoutTruncated || op.result.stderrTruncated ? '\n（命令输出已截短，仅保留末尾）' : ''}`).join('\n') : job.nativeExecution ? '原生工具和命令的执行记录保留在 DSH 会话中。' : connections.length || queries.length ? '' : '未执行命令，尚无运行验证。',
    queries.length ? '实际状态查询：\n' + queries.slice(full ? 0 : -3).map(op => (op.result.text || op.result.message || '查询失败').slice(0, full ? 16000 : 1200)).join('\n') : '',
    job.result?.files?.length ? '目录内文件：\n' + job.result.files.map(file => `${file.path} (${file.bytes} B)`).join('\n') : '',
    job.imageArchives?.length ? '主目录图片存档：\n' + job.imageArchives.map(image =>
      `${image.path} (${image.bytes} B)：${image.state === 'saved' ? '已保存' : image.error?.message || '保存失败，原任务文件保留'}`).join('\n') : '',
    job.result?.artifacts?.length ? '微信成果回传：\n' + job.result.artifacts.map(artifact => {
      const delivery = job.delivery.artifacts?.find(value => value.path === artifact.path);
      return `${artifact.kind === 'image' ? '图片' : '文件'} · ${artifact.name} (${artifact.bytes} B)：${workDeliveryLabels[delivery?.state] || '等待回传'}${delivery?.serverMessageId ? ' · 微信消息 ' + delivery.serverMessageId : ''}`;
    }).join('\n') : '',
    job.result ? `完整记录：.wechat-work/${job.id}.md` : '',
  ].filter(Boolean).join('\n\n');
  return full ? text : text.length > 12000 ? text.slice(0, 11850) + '\n（微信摘要已截短，完整结果见任务记录）' : text;
}
