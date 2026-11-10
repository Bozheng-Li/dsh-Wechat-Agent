import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkConnections, configuredSshAliases, vscodeInstallation, workTools, workResult, runConnectionProcess } from '../lib/testing.js';

function fixture(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-work-connect-'));
  fs.mkdirSync(path.join(root, '.ssh')); fs.writeFileSync(path.join(root, '.ssh', 'config'), 'Host scut2 other *.wild\n  HostName ignored\n');
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [], operations = []; let allowed = true;
  const connections = createWorkConnections({ cwd: root, home: root, request: '连接 VS Code 的 scut2，使用 SSH', sshExecutable: 'ssh-fixture.exe',
    vscode: { executable: 'Code-fixture.exe', cli: 'cli-fixture.js' }, assertAllowed: () => { if (!allowed) throw Error('revoked'); },
    run: async (...args) => { calls.push(args); return run ? run(...args) : { exitCode: 0, stdout: args[1].includes('--list-extensions') ? 'ms-vscode-remote.remote-ssh\n' : 'WECHAT_WORK_SSH_READY\n', stderr: '', timedOut: false, cancelled: false }; } });
  const tools = workTools({ cwd: root, limits: { commandTimeoutSeconds: 1 }, assertAllowed() {}, onOperation: op => operations.push(op), connections });
  const invoke = async (tool, alias, command) => JSON.parse(await tools.find(value => value.name === 'wechat_work_' + tool).execute({ alias, ...(command === undefined ? {} : { command }) }, { signal: new AbortController().signal }));
  return { root, calls, operations, invoke, revoke: () => { allowed = false; } };
}
test('connections only use requested configured aliases and fixed argument arrays', async t => {
  const f = fixture(t); assert.deepEqual(configuredSshAliases(f.root), ['scut2', 'other']);
  for (const alias of ['other', 'scut2; whoami', '-oProxyCommand=whoami', '../scut2']) {
    assert.equal((await f.invoke('ssh_connect', alias)).code, 'WORK_SSH_TARGET_DENIED');
  }
  assert.equal(f.calls.length, 0);
  const result = await f.invoke('ssh_connect', 'scut2'); assert.equal(result.stage, 'ssh-verified');
  const [executable, args] = f.calls[0]; assert.equal(executable, 'ssh-fixture.exe');
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'PermitLocalCommand=no', 'ForwardAgent=no', 'ClearAllForwardings=yes']) assert(args.includes(option));
  assert.deepEqual(args.slice(-2), ['scut2', 'echo WECHAT_WORK_SSH_READY']);
  assert.equal(f.operations.at(-1).alias, 'scut2');
});
test('VS Code submission follows successful SSH and extension verification, never claims editor readiness', async t => {
  const f = fixture(t), result = await f.invoke('vscode_connect', 'scut2');
  assert.equal(result.ok, true); assert.equal(result.stage, 'vscode-requested'); assert.equal(result.connectedConfirmed, false);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(result.steps.map(step=>step.ok), [true, true, true]);
  assert.deepEqual(result.steps.map(step=>step.exitCode), [0, 0, 0]);
  assert(f.calls[1][1].includes('--list-extensions'));
  assert.deepEqual(f.calls[2][1], ['cli-fixture.js', '--new-window', '--remote', 'ssh-remote+scut2']);
  assert.equal(f.calls[2][2].env.ELECTRON_RUN_AS_NODE, '1');
  const formatted = workResult({ id: 'abcdef123456', state: 'succeeded', operations: f.operations, result: { text: '执行已结束', files: [] } }, f.root, { full: true });
  assert(formatted.includes('编辑器是否已连接就绪尚未确认')); assert(!formatted.includes('未执行命令，尚无运行验证'));
  assert(formatted.includes('1. SSH 认证与远端探测：已通过（退出码 0）'));
});
test('SSH error, missing marker and missing extension stop VS Code launch', async t => {
  for (const result of [{ exitCode: 255, stdout: '', stderr: 'Authentication failed' }, { exitCode: 0, stdout: 'different', stderr: '' }]) {
    const f = fixture(t, async () => result); assert.equal((await f.invoke('vscode_connect', 'scut2')).ok, false); assert.equal(f.calls.length, 1);
  }
  const f = fixture(t, async (_exe, args) => ({ exitCode: 0, stdout: args.includes('--list-extensions') ? 'other.extension' : 'WECHAT_WORK_SSH_READY', stderr: '' }));
  const missing = await f.invoke('vscode_connect', 'scut2');
  assert.equal(missing.code, 'WORK_VSCODE_EXTENSION_UNAVAILABLE'); assert.equal(f.calls.length, 2);
  assert.deepEqual(missing.steps.map(step=>step.ok), [true, false]);
});
test('revocation is checked before connection and stops all process launches', async t => {
  const f = fixture(t); f.revoke(); assert.equal((await f.invoke('vscode_connect', 'scut2')).ok, false); assert.equal(f.calls.length, 0);
});

test('remote experiment commands use the verified alias, bounded timeout and literal argument with real output', async t => {
  const command = "printf '%s' 'metric; $(echo remote-only)'";
  const f = fixture(t, async (_exe, args) => ({ exitCode: 0,
    stdout: args.at(-1) === command ? '八卡实验 reward=1.25' : 'WECHAT_WORK_SSH_READY', stderr: '', timedOut: false, cancelled: false }));
  const result = await f.invoke('ssh_exec', 'scut2', command);
  assert.equal(result.ok, true); assert.equal(result.stage, 'ssh-executed'); assert.equal(result.stdout, '八卡实验 reward=1.25');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1][1].slice(-2), ['scut2', command]);
  assert.equal(f.calls[1][0], 'ssh-fixture.exe'); assert.equal(f.calls[1][2].timeoutMs, 30000);
  assert.equal(f.operations.at(-1).command, command); assert.equal(f.operations.at(-1).result.exitCode, 0);
  const formatted = workResult({ id: 'abcdef123456', state: 'succeeded', operations: f.operations, result: { text: '已读取实验指标', files: [] } }, f.root, { full: true });
  assert(formatted.includes('SSH · scut2')); assert(formatted.includes('八卡实验 reward=1.25')); assert(formatted.includes('退出码 0'));
});

test('remote commands reject other aliases and invalid input, and cannot proceed after failed authentication or revocation', async t => {
  const f = fixture(t);
  assert.equal((await f.invoke('ssh_exec', 'other', 'cat metrics.json')).code, 'WORK_SSH_TARGET_DENIED');
  for (const command of ['', ' ', 'x'.repeat(12001), 'cat\0metrics'])
    assert.equal((await f.invoke('ssh_exec', 'scut2', command)).code, 'WORK_SSH_COMMAND_INVALID');
  assert.equal(f.calls.length, 0);
  const failed = fixture(t, async () => ({ exitCode: 255, stdout: '', stderr: 'Authentication failed' }));
  assert.equal((await failed.invoke('ssh_exec', 'scut2', 'cat metrics.json')).ok, false); assert.equal(failed.calls.length, 1);
  let revoked;
  revoked = fixture(t, async () => { revoked.revoke(); return { exitCode: 0, stdout: 'WECHAT_WORK_SSH_READY', stderr: '' }; });
  assert.equal((await revoked.invoke('ssh_exec', 'scut2', 'cat metrics.json')).ok, false); assert.equal(revoked.calls.length, 1);
});

test('remote command failure and timeout retain actual stderr and never report completion', async t => {
  for (const response of [{ exitCode: 7, stderr: 'No experiment result', timedOut: false }, { exitCode: null, stderr: '', timedOut: true }]) {
    const f = fixture(t, async (_exe, args) => args.at(-1) === 'echo WECHAT_WORK_SSH_READY'
      ? { exitCode: 0, stdout: 'WECHAT_WORK_SSH_READY', stderr: '' } : { ...response, stdout: '', cancelled: false });
    const result = await f.invoke('ssh_exec', 'scut2', 'cat metrics.json');
    assert.equal(result.ok, false); assert.equal(result.exitCode, response.exitCode); assert.equal(result.stderr, response.stderr);
    if (response.timedOut) assert(result.message.includes('远端进程是否结束尚未确认'));
  }
});

test('work status reads backend facts and rejects invented task IDs or execution actions before querying', async t => {
  const f = fixture(t), queries = [], operations = [];
  const tools = workTools({ cwd: f.root, request: '查看 DSH 任务 abc-123', limits: {}, assertAllowed() {}, onOperation: op => operations.push(op),
    queryStatus: async query => { queries.push(query); return '实际任务状态'; } });
  const invoke = args => tools.find(tool => tool.name === 'wechat_work_status').execute(args, { signal: new AbortController().signal }).then(JSON.parse);
  for (const args of [{ action: 'task', id: 'invented' }, { action: 'exec', command: 'whoami' }, { action: 'tasks', id: 'abc-123' }])
    assert.equal((await invoke(args)).ok, false);
  assert.equal(queries.length, 0);
  assert.equal((await invoke({ action: 'task', id: 'abc-123' })).text, '实际任务状态');
  assert.deepEqual(queries, [{ action: 'task', id: 'abc-123' }]);
  assert.equal(operations.at(-1).tool, 'wechat_work_status');
  assert(!workTools({ cwd: f.root, limits: {}, assertAllowed() {}, onOperation() {} }).some(tool => /ssh|vscode|status/.test(tool.name)));
});
test('VS Code discovery resolves official versioned CLI and rejects alternate editor metadata', t => {
  const f = fixture(t), root = path.join(f.root, 'vscode'); fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const app = path.join(root, 'a123', 'resources', 'app'); fs.mkdirSync(path.join(app, 'out'), { recursive: true });
  const executable = path.join(root, 'Code.exe'); fs.writeFileSync(executable, 'fixture');
  fs.writeFileSync(path.join(root, 'bin', 'code.cmd'), '"%~dp0..\\Code.exe" "%~dp0..\\a123\\resources\\app\\out\\cli.js" %*');
  const product = path.join(app, 'product.json'); fs.writeFileSync(product, JSON.stringify({ applicationName: 'code', nameLong: 'Visual Studio Code' })); fs.writeFileSync(path.join(app, 'out', 'cli.js'), '');
  assert.equal(vscodeInstallation(executable).cli, path.join(app, 'out', 'cli.js'));
  fs.writeFileSync(product, JSON.stringify({ applicationName: 'cursor', nameLong: 'Cursor' })); assert.equal(vscodeInstallation(executable), null);
});
test('fixed process runner surfaces real exit status and terminates expired child', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  const result = await runConnectionProcess(process.execPath, ['-e', 'process.stdout.write("actual"); process.exit(7)'], { cwd: f.root, signal });
  assert.equal(result.exitCode, 7); assert.equal(result.stdout, 'actual');
  const timeout = await runConnectionProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { cwd: f.root, signal, timeoutMs: 100 }); assert.equal(timeout.timedOut, true);
});

test('process output preserves split UTF-8 and reports when its output tail is truncated', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  const split = await runConnectionProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xe5])); setTimeout(()=>process.stdout.write(Buffer.from([0x85,0xab,0xe5,0x8d,0xa1])),10)'], { cwd: f.root, signal });
  assert.equal(split.stdout, '八卡'); assert.equal(split.stdoutTruncated, false);
  const bounded = await runConnectionProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(9000)); process.stderr.write("y".repeat(9000))'], { cwd: f.root, signal });
  assert.equal(bounded.stdout.length, 8000); assert.equal(bounded.stderr.length, 8000);
  assert.equal(bounded.stdoutTruncated, true); assert.equal(bounded.stderrTruncated, true);
  const controller = new AbortController();
  const cancelled = runConnectionProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { cwd: f.root, signal: controller.signal });
  controller.abort(); assert.equal((await cancelled).cancelled, true);
});
