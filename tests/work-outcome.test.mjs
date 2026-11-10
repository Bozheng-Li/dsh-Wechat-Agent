import test from 'node:test';
import assert from 'node:assert/strict';
import { workOutcome, workReply, workResult } from '../lib/testing.js';

const remote = '使用 SSH 连接 VS Code 配置中的 scut2，查看 LoongRL 八卡实验结果指标';
const ssh = (ok, command = 'cat completion/metrics.json', alias = 'scut2') => ({ tool: 'wechat_work_ssh_exec', alias, command,
  result: { ok, exitCode: ok ? 0 : 7, stdout: ok ? 'accuracy=88.37%' : '', stderr: ok ? '' : 'missing path' } });
const exec = (ok, command = 'python ./result.py') => ({ tool: 'wechat_work_exec', command,
  result: { ok, exitCode: ok ? 0 : 7, stdout: ok ? 'CHECK_OK' : '', stderr: ok ? '' : 'CHECK_FAILED' } });

test('remote metrics survive a blocked auxiliary local check and a recovered remote path probe', () => {
  const operations = [exec(false), ssh(false, 'cat guessed/metrics.json'), ssh(true)];
  const outcome = workOutcome(remote, operations);
  assert.equal(outcome.state, 'succeeded'); assert.equal(outcome.error, undefined);
  assert.equal(outcome.warnings.length, 2); assert.equal(outcome.warnings[0].auxiliary, true); assert.equal(outcome.warnings[1].recovered, true);
  const job = { id: '1508569a7fbd', sessionId: 'original-session', ...outcome, operations,
    result: { text: '查到了：八卡训练 229 步完成，最终验证正确率 88.37%。', files: [] } };
  assert.equal(workReply(job), job.result.text);
  const archive = workResult(job, 'E:/工作目录', { full: true });
  for (const value of ['CHECK_FAILED', 'missing path', '退出码 7', 'guessed/metrics.json', 'original-session', '后续已恢复', '辅助步骤受阻'])
    assert(archive.includes(value), value);
});

test('required local validation stays incomplete even when the remote read succeeds', () => {
  const outcome = workOutcome(remote + '，并在本机运行验证脚本', [ssh(true), exec(false)]);
  assert.equal(outcome.state, 'partial'); assert.match(outcome.error.message, /本机运行验证没有通过/);
  assert.equal(outcome.warnings[0].auxiliary, false);
});

test('a passing exact retry recovers a code check; an unrelated passing command cannot', () => {
  assert.equal(workOutcome('修复脚本并运行验证', [exec(false), exec(true)]).state, 'succeeded');
  const unrelated = workOutcome('修复脚本并运行验证', [exec(false), exec(true, 'echo unrelated')]);
  assert.equal(unrelated.state, 'partial'); assert.equal(unrelated.warnings[0].recovered, false);
  assert.equal(workOutcome('运行脚本', [exec(false)]).state, 'failed');
});

test('a failed remote command, authentication alone and an unrelated host cannot complete an inspection', () => {
  const connected = { tool: 'wechat_work_ssh_connect', alias: 'scut2', result: { ok: true, exitCode: 0 } };
  assert.equal(workOutcome(remote, [connected]).error.code, 'WORK_REMOTE_COMMAND_NOT_EXECUTED');
  assert.equal(workOutcome(remote, [connected, ssh(false)]).error.code, 'WORK_REMOTE_COMMAND_FAILED');
  const otherHost = workOutcome(remote, [ssh(false), ssh(true, 'cat metrics.json', 'other')]);
  assert.equal(otherHost.state, 'partial'); assert.equal(otherHost.warnings[0].recovered, false);
  assert.equal(workOutcome(remote, [{ ...connected, result: { ok: false, exitCode: 255 } }]).error.code, 'WORK_CONNECTION_FAILED');
});

test('a failed requested artifact is not recovered by registering a different file', () => {
  const failed = { tool: 'wechat_work_output', paths: ['report.pdf'], result: { ok: false, message: '报告文件未生成' } };
  const other = { tool: 'wechat_work_output', paths: ['notes.txt'], result: { ok: true, artifacts: [{ path: 'notes.txt' }] } };
  assert.equal(workOutcome('生成报告并回传文件', [failed, other]).state, 'partial');
  const recovered = { ...other, result: { ok: true, artifacts: [{ path: 'report.pdf' }] } };
  assert.equal(workOutcome('生成报告并回传文件', [failed, recovered]).state, 'succeeded');
});

test('short delivery does not truncate requested results or hide an unconfirmed editor connection', () => {
  const text = '详细结果'.repeat(4000);
  const job = { state: 'succeeded', operations: [], result: { text, files: [] } };
  assert.equal(workReply(job), text);
  job.operations = [{ tool: 'wechat_work_vscode_connect', result: { ok: true, connectedConfirmed: false } }];
  assert.match(workReply(job), /编辑器是否连接就绪尚未确认/);
  assert(!workReply(job).includes('退出码'));
});

test('a moments failure is recovered only by the same target and page, including mixed remote tasks', () => {
  const failed = { tool: 'wechat_moments_read', action: 'user', userId: 'alice', cursor: 'page-2', result: { ok: false } };
  const passed = { ...failed, result: { ok: true, items: [] } };
  assert.equal(workOutcome('读取朋友圈', [failed]).state, 'failed');
  assert.match(workOutcome('读取朋友圈', [failed]).error.message, /朋友圈读取没有成功/);
  assert.equal(workOutcome('读取朋友圈', [failed, passed]).state, 'succeeded');
  for (const patch of [{ userId: 'bob' }, { cursor: 'page-3' }, { action: 'timeline' }, { userId: undefined, user: '张三' }]) {
    const outcome = workOutcome('读取朋友圈', [failed, { ...passed, ...patch }]);
    assert.equal(outcome.state, 'partial'); assert.equal(outcome.warnings[0].recovered, false);
  }
  const detail = { ...failed, action: 'detail', userId: undefined, cursor: undefined, postId: '123' };
  assert.equal(workOutcome('读取朋友圈详情', [detail, { ...detail, postId: '124', result: { ok: true } }]).state, 'partial');
  const mixed = workOutcome(remote + '，再读取朋友圈', [failed, ssh(true)]);
  assert.equal(mixed.state, 'partial'); assert.equal(mixed.warnings[0].auxiliary, false);
});
