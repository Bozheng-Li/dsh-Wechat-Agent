import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ChannelError } from '../../shared/contracts.mjs';

/** Fixed executables and argument arrays; never model-authored local shell text. */
export function runConnectionProcess(executable, args, { cwd, signal, timeoutMs = 30000, env = {} }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env } });
    let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false, timedOut = false, cancelled = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdoutTruncated ||= stdout.length + chunk.length > 8000; stdout = (stdout + chunk).slice(-8000); });
    child.stderr.on('data', chunk => { stderrTruncated ||= stderr.length + chunk.length > 8000; stderr = (stderr + chunk).slice(-8000); });
    const cancel = () => { cancelled = true; child.kill(); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', () => { cleanup(); reject(new ChannelError('WORK_CONNECTION_UNAVAILABLE', '本机连接程序无法启动，请检查 OpenSSH 或 Microsoft VS Code 安装')); });
    child.once('close', exitCode => { cleanup(); resolve({ exitCode, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut, cancelled }); });
  });
}

export function configuredSshAliases(home = os.homedir()) {
  try {
    return [...new Set(fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8').split(/\r?\n/)
      .flatMap(line => /^\s*Host\s+(.+?)(?:\s+#.*)?$/i.exec(line)?.[1].split(/\s+/) ?? [])
      .filter(alias => /^[a-z0-9][a-z0-9_.-]{0,149}$/i.test(alias)))];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new ChannelError('WORK_SSH_CONFIG_UNAVAILABLE', '本机 SSH 配置无法读取，连接未执行');
  }
}

/** VS Code's public launcher also identifies versioned installations. PATH may name Cursor. */
export function vscodeInstallation(executable) {
  if (!executable || path.basename(executable).toLowerCase() !== 'code.exe' || !fs.existsSync(executable)) return null;
  const root = path.dirname(executable), candidates = [path.join(root, 'resources', 'app')];
  try {
    const launcher = fs.readFileSync(path.join(root, 'bin', 'code.cmd'), 'utf8');
    const relative = /%~dp0\.\.\\([^"\r\n]*?)resources\\app\\out\\cli\.js/i.exec(launcher)?.[1];
    if (relative !== undefined && /^[a-z0-9\\.-]*$/i.test(relative) && !relative.split('\\').includes('..'))
      candidates.push(path.join(root, relative, 'resources', 'app'));
  } catch {}
  for (const app of candidates) {
    try {
      const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8')), cli = path.join(app, 'out', 'cli.js');
      if (product.applicationName === 'code' && product.nameLong === 'Visual Studio Code' && fs.statSync(cli).isFile())
        return { executable, cli };
    } catch {}
  }
  return null;
}

export async function findVsCode({ run = runConnectionProcess, cwd, signal }) {
  const candidates = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')].filter(Boolean);
  // Read installation metadata only. Never run a launcher from PATH as VS Code.
  for (const hive of ['HKCU', 'HKLM']) {
    const result = await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe', '/ve'], { cwd, signal, timeoutMs: 5000 });
    const executable = /REG_SZ\s+(.+?)\s*$/im.exec(result.stdout)?.[1]?.trim();
    if (executable) candidates.push(executable);
  }
  for (const executable of candidates) {
    const result = vscodeInstallation(executable);
    if (result) return result;
  }
  throw new ChannelError('WORK_VSCODE_UNAVAILABLE', '未找到 Microsoft VS Code 的官方命令行程序，连接未提交；请检查本机安装');
}

export function createWorkConnections({ cwd, request, assertAllowed, run = runConnectionProcess, home = os.homedir(),
  sshExecutable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'), vscode, commandTimeoutMs = 30000 }) {
  const verified = new Map();
  const requested = new Set(String(request).toLowerCase().split(/[^a-z0-9_.-]+/i));
  const aliasFor = alias => {
    assertAllowed();
    if (typeof alias !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,149}$/i.test(alias) || !requested.has(alias.toLowerCase()))
      throw new ChannelError('WORK_SSH_TARGET_DENIED', '只能连接本次要求中明确写出的 SSH 主机别名');
    const configured = configuredSshAliases(home).find(value => value.toLowerCase() === alias.toLowerCase());
    if (!configured) throw new ChannelError('WORK_SSH_TARGET_UNKNOWN', '本机 SSH 配置没有这个明确的主机别名，请由本机所有者配置后重试');
    return configured;
  };
  const sshArgs = (target, command) => ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'PermitLocalCommand=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=15', target, command];
  const ssh = async (alias, signal) => {
    const target = aliasFor(alias);
    const result = await run(sshExecutable, sshArgs(target, 'echo WECHAT_WORK_SSH_READY'), { cwd, signal });
    assertAllowed(); signal?.throwIfAborted();
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && result.stdout.split(/\r?\n/).some(line => line.trim() === 'WECHAT_WORK_SSH_READY');
    const response = { ok, alias: target, stage: ok ? 'ssh-verified' : 'ssh-failed', exitCode: result.exitCode, timedOut: result.timedOut,
      steps: [{ name: 'SSH 认证与远端探测', ok, exitCode: result.exitCode }],
      message: ok ? '已通过 SSH 认证并收到远端探测回执。' : 'SSH 未通过连接验证；请在本机检查网络、已知主机指纹和免密认证。',
      ...(ok ? {} : { stderr: result.stderr.slice(-2000) }) };
    if (ok) verified.set(target.toLowerCase(), response);
    return response;
  };
  return {
    ssh,
    execute: async (alias, command, signal) => {
      const target = aliasFor(alias);
      if (typeof command !== 'string' || !command.trim() || command.length > 12000 || command.includes('\0'))
        throw new ChannelError('WORK_SSH_COMMAND_INVALID', '远端工作命令应为 1–12000 字符，不能包含空字符');
      if (!verified.has(target.toLowerCase())) { const result = await ssh(target, signal); if (!result.ok) return result; }
      assertAllowed(); signal?.throwIfAborted();
      const result = await run(sshExecutable, sshArgs(target, command), { cwd, signal, timeoutMs: commandTimeoutMs });
      assertAllowed(); signal?.throwIfAborted();
      const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
      return { ...result, ok, alias: target, stage: ok ? 'ssh-executed' : 'ssh-command-failed',
        message: ok ? '远端命令已结束，结果以实际输出为准。' : result.timedOut ? '远端命令等待超时，本机 SSH 已停止；远端进程是否结束尚未确认。'
          : '远端命令未成功完成，结果以实际退出码和输出为准。' };
    },
    vscode: async (alias, signal) => {
      const target = aliasFor(alias);
      if (!verified.has(target.toLowerCase())) { const result = await ssh(target, signal); if (!result.ok) return result; }
      const installation = vscode ?? await findVsCode({ run, cwd, signal });
      assertAllowed(); signal?.throwIfAborted();
      const options = { cwd, signal, env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } };
      const extensions = await run(installation.executable, [installation.cli, '--list-extensions'], options);
      if (extensions.exitCode !== 0 || !extensions.stdout.split(/\r?\n/).some(line => line.trim().toLowerCase() === 'ms-vscode-remote.remote-ssh'))
        return { ok: false, alias: target, stage: 'vscode-failed', code: 'WORK_VSCODE_EXTENSION_UNAVAILABLE',
          message: 'Microsoft VS Code 未确认安装 Remote - SSH 扩展，连接未提交',
          steps: [...verified.get(target.toLowerCase()).steps, { name: '检查 Remote - SSH 扩展', ok: false, exitCode: extensions.exitCode }] };
      assertAllowed(); signal?.throwIfAborted();
      const result = await run(installation.executable, [installation.cli, '--new-window', '--remote', 'ssh-remote+' + target], options);
      assertAllowed(); signal?.throwIfAborted();
      const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
      return { ok, alias: target, stage: ok ? 'vscode-requested' : 'vscode-failed', exitCode: result.exitCode, connectedConfirmed: false,
        steps: [...verified.get(target.toLowerCase()).steps, { name: '检查 Remote - SSH 扩展', ok: true, exitCode: extensions.exitCode },
          { name: '提交 VS Code 远程连接请求', ok, exitCode: result.exitCode }],
        message: ok ? 'SSH 探测通过，Microsoft VS Code 已收到 Remote - SSH 连接请求；编辑器是否已连接就绪尚未确认。'
          : 'VS Code 命令行未成功提交连接请求。', ...(ok ? {} : { stderr: result.stderr.slice(-2000) }) };
    },
  };
}
