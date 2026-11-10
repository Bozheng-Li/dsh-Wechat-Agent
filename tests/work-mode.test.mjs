import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateStore, WechatChannel, WorkStore, DshWorkRunner, workCommand, workPath, workTools, taskDirectory, workAuthorized, workResult, ChannelError, rpcHandler, createPluginService } from '../lib/testing.js';
import { fixtureWorkRoute } from './fixtures/work-dialogue.mjs';

const scope = { accountId: 'work-owner', chatType: 'private', peerId: 'alice', senderId: 'alice' };
function fixture(t, run, send) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-work-unit-')), store = new StateStore(root), calls = [], sent = [];
  const state = { online: true, account: { id: scope.accountId } };
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: ['work@chatroom'], prompt: '' });
  const admins = store.config.snapshot(store.data); admins.remote = { globalAdminIds: ['alice', 'bob'] }; store.config.commit(admins);
  for (const [type, peer] of [['private', 'alice'], ['private', 'bob'], ['group', 'work@chatroom']])
    store.setConversationSettings(scope.accountId, type, peer, { ...store.conversationSettings(scope.accountId, type, peer), executionMode: 'work', remoteEnabled: type === 'private', workSenderIds: type === 'group' ? ['member'] : [] });
  const transport = { status: () => state, send: async payload => { sent.push(payload); return send ? send(payload) : { delivery: 'server-ack', serverMessageIds: [`ack-${sent.length}`] }; } };
  const runner = { run: async input => input.mode === 'work-routing' ? fixtureWorkRoute(input) : { text: '普通聊天回复' } };
  const workRunner = { run: async input => { calls.push(input); if (run) return run(input); await input.onSession('fixture-session');
    await input.onOperation({ tool: 'wechat_work_write', path: 'hello.py', result: { ok: true } });
    fs.writeFileSync(path.join(input.cwd, 'hello.py'), 'print(123)'); return { text: '代码已生成，未运行验证' }; } };
  const channel = new WechatChannel({ store, runner, workRunner, transport });
  let serial = 0;
  const receive = (text, overrides = {}) => channel.receive({ id: `unit-${++serial}`, direction: 'incoming', chatType: 'private', peerId: 'alice', sender: { id: 'alice' },
    time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], ...overrides }, scope.accountId);
  t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-work-unit-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, channel, state, calls, sent, receive };
}
test('work command parsing admits explicit commands and leaves ordinary text to model routing', () => {
  assert.equal(workCommand('你好', 'work'), null); assert.equal(workCommand('解释 Python 的语法', 'chat'), null);
  assert.equal(workCommand('请帮我解释 Python 的语法', 'work'), null);
  assert.equal(workCommand('帮我写一个 Python 脚本', 'work'), null);
  assert.deepEqual(workCommand('/work 写代码', 'chat'), { action: 'create', request: '写代码' });
  assert.deepEqual(workCommand('/work new 写代码'), { action: 'create', request: '写代码', newSession: true });
  assert.equal(workCommand('/work status').action, 'status'); assert.equal(workCommand('/work cancel bad').action, 'help');
  assert.deepEqual(workCommand('/work continue abcdef123456 修复错误'), { action: 'continue', id: 'abcdef123456', request: '修复错误' });
  assert.equal(workCommand('小胖帮我在dsh开一个会话，然后远程链接vscode的scut2，使用ssh链接', 'work'), null);
  assert.equal(workCommand('帮我在 DSH 新建一个会话', 'work'), null);
  for (const text of ['不要打开 vscode 连接 scut2', '怎么用 SSH 连接 vscode', '“帮我写代码”', '示例：连接 vscode 的 scut2'])
    assert.equal(workCommand(text, 'work'), null, text);
  assert.equal(workCommand(undefined, 'work'), null);
});
test('administrator group work bypasses chat gates, prompt and memory; result and request stay isolated after restart', async t => {
  const f = fixture(t), group = { chatType: 'group', peerId: 'work@chatroom', sender: { id: 'admin' } };
  f.store.setConversationSettings(scope.accountId, group.chatType, group.peerId, { ...f.store.conversationSettings(scope.accountId, group.chatType, group.peerId), mode: 'natural', fixedMessages: 100, remoteEnabled: true, adminIds: ['admin'] });
  const fail = () => { throw Error('work entered chat context'); };
  f.channel.runner.run = input => input.mode === 'work-routing' ? fixtureWorkRoute(input) : fail();
  f.channel.context = fail; f.channel.memory.snapshot = fail; f.channel.longMemory.capture = fail;
  f.receive('帮我写一个 Python 脚本', group); await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request, '帮我写一个 Python 脚本');
  for (const key of ['persona', 'prompt', 'history', 'memory', 'speaker', 'account']) assert.equal(f.calls[0][key], undefined);
  assert.equal(f.store.history(scope.accountId, group.chatType, group.peerId, 100).length, 0);
  assert.equal(f.channel.memory.load({ accountId: scope.accountId, ...group }).entries.length, 0);
  const restored = new StateStore(f.root); assert.equal(restored.history(scope.accountId, group.chatType, group.peerId, 100).length, 0);
  assert(f.sent.some(payload => JSON.stringify(payload).includes('代码已生成')));
});
test('administrator execution requires work mode and enabled remote access; code members cannot gain connection tools', async t => {
  const f = fixture(t), target = { accountId: scope.accountId, chatType: 'group', peerId: 'work@chatroom', senderId: 'admin' };
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: ['admin'] }; f.store.config.commit(next);
  const configure = patch => f.store.setConversationSettings(target.accountId, target.chatType, target.peerId, { ...f.store.conversationSettings(target.accountId, target.chatType, target.peerId), ...patch });
  assert.equal(workAuthorized(f.store, target), false);
  configure({ remoteEnabled: true }); assert.equal(workAuthorized(f.store, target), true);
  f.receive('帮我连接 VS Code 的 scut2，使用 SSH', { chatType: target.chatType, peerId: target.peerId, sender: { id: target.senderId } }); await f.channel.whenIdle();
  assert.equal(f.calls[0].connectionAccess, true);
  const nativeMember = f.channel.work.create({ ...target, senderId: 'member' }, '连接 VS Code 的 scut2，使用 SSH');
  assert.equal(nativeMember.connectionAccess, false); await f.channel.whenIdle();
  configure({ executionMode: 'chat' }); assert.equal(workAuthorized(f.store, target), false);
  assert.throws(() => f.channel.work.create(target, '写代码'), { code: 'WORK_NOT_AUTHORIZED' });
});
test('external YAML edits prevent work from starting without overwriting changed configuration', async t => {
  const f = fixture(t), before = fs.readFileSync(f.store.config.file, 'utf8');
  fs.writeFileSync(f.store.config.file, before + '\n# user changed configuration\n');
  assert.throws(() => f.channel.work.create(scope, '写代码'), { code: 'CONFIG_CHANGED' });
  assert.equal(f.calls.length, 0); assert(fs.readFileSync(f.store.config.file, 'utf8').includes('# user changed'));
});
test('administrator tools follow identity for colloquial SSH requests and code; missing execution is a failed task', async t => {
  const f = fixture(t), target = { chatType: 'group', peerId: 'work@chatroom', sender: { id: 'admin' } };
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: ['admin', 'alice', 'bob'] }; f.store.config.commit(next);
  f.store.setConversationSettings(scope.accountId, target.chatType, target.peerId, { ...f.store.conversationSettings(scope.accountId, target.chatType, target.peerId), remoteEnabled: true });
  for (const text of ['用ssh方式链vscode中的scut2服务器', '用 SSH 连 VS Code 中的 scut2', '帮我通过ssh连上vscode里的scut2', 'ssh方式链接VSCode的scut2', '帮我整理文件']) {
    f.receive(text, target); await f.channel.whenIdle();
    assert.equal(f.calls.at(-1).request, text); assert.equal(f.calls.at(-1).connectionAccess, true, text);
  }
  const first = f.channel.work.list({ accountId: scope.accountId }).jobs.at(-1);
  assert.equal(first.state, 'failed'); assert.equal(first.error.code, 'WORK_CONNECTION_NOT_EXECUTED');
  assert(JSON.stringify(f.sent).includes('连接未执行'));
  for (const text of ['不要打开 vscode 连接 scut2', '“用ssh方式链vscode中的scut2服务器”', '怎么用 SSH 连接 vscode']) {
    const count = f.calls.length;
    f.receive(text); await f.channel.whenIdle(); assert.equal(f.calls.length, count);
  }
});

test('the complete SSH experiment request enters work instead of the remote intent classifier', async t => {
  const request = '小胖，使用ssh的链接方式，找到vscode scut2的ssh配置，在dsh中ssh到scut2这台服务器，并查看一下loongrl的八卡实验结果指标';
  const f = fixture(t, async input => {
    await input.onSession('ssh-metrics-session');
    await input.onOperation({ tool: 'wechat_work_ssh_exec', alias: 'scut2', command: 'cat results/metrics.json',
      result: { ok: true, exitCode: 0, stdout: '{"gpu_count":8,"score":42}', stderr: '' } });
    return { text: '八卡实验指标已从远端结果文件读取：score=42。' };
  });
  const target = { chatType: 'group', peerId: 'work@chatroom', sender: { id: 'admin' } };
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: ['admin'] }; f.store.config.commit(next);
  f.store.setConversationSettings(scope.accountId, target.chatType, target.peerId,
    { ...f.store.conversationSettings(scope.accountId, target.chatType, target.peerId), remoteEnabled: true });
  f.channel.runner.run = input => fixtureWorkRoute(input);
  f.receive(request, target); await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request, request); assert.equal(f.calls[0].connectionAccess, true);
  const job = f.channel.work.list({ accountId: scope.accountId }).jobs[0];
  assert.equal(job.state, 'succeeded'); assert.equal(job.operations[0].tool, 'wechat_work_ssh_exec');
  assert.equal(job.delivery.state, 'sent'); assert(JSON.stringify(f.sent).includes('score=42'));
  assert(!JSON.stringify(f.sent).includes('你想查看电脑')); assert(!JSON.stringify(f.sent).includes('queries'));
  assert(f.store.data.records.some(record => record.workRequest === 'create' && record.question === request));
  assert.equal(f.store.history(scope.accountId, target.chatType, target.peerId).length, 0);
});

test('the reported SSH metric task sends two natural messages, retains evidence and corrects its legacy classification without replay', async t => {
  const request = '使用ssh的链接方式，找到vscode scut2的ssh配置，在dsh中ssh到scut2这台服务器，并查看一下loongrl的八卡实验结果指标';
  const answer = '查到了：八卡训练完成 229 步，最终内部验证正确率 88.37%。LongBench 正确率平均提高 2.20 个百分点，但 F1 下降 11.53 个百分点，奖励正确率与答案质量需要分开看。';
  const f = fixture(t, async input => {
    await input.onSession('original-ssh-work-session');
    await input.onOperation({ tool: 'wechat_work_exec', command: 'LOCAL_AUXILIARY_CHECK', result: { ok: false, code: 'WORK_EXECUTION_FAILED', message: '本机辅助检查受阻' } });
    await input.onOperation({ tool: 'wechat_work_ssh_exec', alias: 'scut2', command: 'cat guessed/metrics.json', result: { ok: false, exitCode: 2, stderr: 'RAW_PROBE_ERROR' } });
    await input.onOperation({ tool: 'wechat_work_ssh_exec', alias: 'scut2', command: 'cat actual/metrics.json', result: { ok: true, exitCode: 0, stdout: 'RAW_REMOTE_METRICS' } });
    return { text: answer };
  });
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: [scope.senderId] }; f.store.config.commit(next);
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true });
  f.receive(request); await f.channel.whenIdle();
  const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'sent'); assert.equal(job.warnings.length, 2);
  const texts = f.sent.map(payload => payload.message.filter(part => part.type === 'text').map(part => part.data.text).join(''));
  assert.equal(texts.length, 2); assert.match(texts[0], /拿到结果后发你/); assert.equal(texts[1], answer);
  for (const hidden of [job.id, job.cwd, job.sessionId, 'RAW_REMOTE_METRICS', 'RAW_PROBE_ERROR', 'LOCAL_AUXILIARY_CHECK', '实际命令结果', '执行失败'])
    assert(!JSON.stringify(f.sent).includes(hidden), hidden);
  const archive = fs.readFileSync(path.join(job.cwd, '.wechat-work', job.id + '.md'), 'utf8');
  assert(archive.includes('RAW_REMOTE_METRICS')); assert(archive.includes('RAW_PROBE_ERROR')); assert(archive.includes(job.sessionId));
  f.channel.work.store.update(job.id, { state: 'failed', error: { code: 'WORK_OPERATION_FAILED', message: '部分工作操作失败，实际结果见命令与工具记录' } });
  const reloaded = new WorkStore(f.store).get(job.id);
  assert.equal(reloaded.state, 'succeeded'); assert.equal(reloaded.error, undefined); assert.equal(reloaded.previousOutcome.state, 'failed');
  assert.equal(reloaded.delivery.state, 'sent'); assert.deepEqual(reloaded.operations, job.operations);
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 2);
});

test('natural host status uses dialogue tools without creating a job; explicit status retains the direct query route', async t => {
  let reads = 0;
  const f = fixture(t, async input => {
    const text = await input.queryStatus({ action: 'tasks' }, input.signal);
    await input.onOperation({ tool: 'wechat_work_status', result: { ok: true, text } });
    return { text };
  });
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: [scope.senderId] }; f.store.config.commit(next);
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true });
  f.channel.remote.tasks = () => { reads++; return { observedAt: Date.now(), total: 0, running: 0, tasks: [], backgroundJobs: [] }; };
  f.channel.runner.run = input => fixtureWorkRoute(input);
  f.receive('DSH 任务跑到哪了'); await f.channel.whenIdle();
  assert.equal(f.calls.length, 1); assert.equal(reads, 1); assert.equal(f.calls[0].request, 'DSH 任务跑到哪了');
  assert.equal(f.channel.work.list(scope).jobs.length, 1);
  f.receive('/dsh tasks'); await f.channel.whenIdle();
  assert.equal(f.calls.length, 2); assert.equal(reads, 2); assert.equal(f.calls[1].request, '/dsh tasks');
  f.receive('/work status'); await f.channel.whenIdle(); assert.equal(f.calls.length, 2);
  assert.equal(f.store.history(scope.accountId, scope.chatType, scope.peerId).length, 0);
});

test('SSH authentication alone cannot complete an experiment inspection and new operation records survive restart without replay', async t => {
  const f = fixture(t, async input => {
    await input.onOperation({ tool: 'wechat_work_ssh_connect', alias: 'scut2', result: { ok: true, exitCode: 0 } });
    return { text: 'SSH 认证已通过' };
  });
  const next = f.store.config.snapshot(f.store.data); next.remote = { globalAdminIds: [scope.senderId] }; f.store.config.commit(next);
  f.store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId,
    { ...f.store.conversationSettings(scope.accountId, scope.chatType, scope.peerId), remoteEnabled: true });
  f.receive('使用 SSH 连接 scut2，查看八卡实验结果指标'); await f.channel.whenIdle();
  const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'WORK_REMOTE_COMMAND_NOT_EXECUTED');
  f.channel.work.store.update(job.id, { state: 'succeeded', operations: [
    { tool: 'wechat_work_ssh_exec', alias: 'scut2', command: 'cat metrics.json', result: { ok: true, exitCode: 0, stdout: 'score=42' } },
    { tool: 'wechat_work_status', result: { ok: true, text: '实际宿主状态' } },
  ] });
  const calls = f.calls.length, sent = f.sent.length;
  const restored = new WorkStore(f.store).get(job.id);
  assert.equal(restored.state, 'succeeded'); assert.equal(restored.operations[0].result.stdout, 'score=42');
  assert.equal(f.calls.length, calls); assert.equal(f.sent.length, sent);
});
test('work task runs below the named agent workspace and uses confirmed delivery separately from file creation', async t => {
  const f = fixture(t); f.receive('帮我写一个 Python 脚本'); await f.channel.whenIdle();
  const job = f.channel.work.list(scope).jobs[0]; assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].cwd, path.join(f.store.storageSettings().workspacePath, '微信agent', 'work', job.id));
  assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'sent'); assert.deepEqual(job.delivery.acknowledgedMessageIds, ['ack-2']);
  assert.equal(job.result.files[0].path, 'hello.py'); assert(fs.existsSync(path.join(job.cwd, '.wechat-work', `${job.id}.md`)));
  f.receive('你好'); await f.channel.whenIdle(); assert.equal(f.calls.length, 1);
  assert.equal(f.channel.work.list(scope).jobs.length, 1);
  assert(JSON.stringify(f.sent.at(-1)).includes('普通聊天回复'));
});
test('legacy no-tool connection replies recover as failed without replay or resend; old task folders remain readable', async t => {
  const f = fixture(t); const job = f.channel.work.create(scope, '写代码'); await f.channel.whenIdle();
  f.channel.work.store.update(job.id, { request: '用ssh方式链vscode中的scut2服务器', state: 'succeeded', connectionAccess: false,
    folder: 'work/' + job.id, operations: [], result: { text: '我没有连接工具', files: [] } });
  const count = f.calls.length, sent = f.sent.length, restored = new WorkStore(f.store);
  assert.equal(restored.get(job.id).state, 'failed'); assert.equal(restored.get(job.id).error.code, 'WORK_CONNECTION_NOT_EXECUTED');
  assert.equal(restored.get(job.id).result.text, '我没有连接工具'); assert.equal(f.calls.length, count); assert.equal(f.sent.length, sent);
  assert.equal(taskDirectory(f.store, 'work/' + job.id), path.join(f.store.storageSettings().workspacePath, 'work', job.id));
});
test('chat mode refuses explicit work while other group members remain in nickname chat', async t => {
  const f = fixture(t); f.store.setConversationSettings(scope.accountId, 'private', 'alice', { ...f.store.conversationSettings(scope.accountId, 'private', 'alice'), executionMode: 'chat' });
  f.receive('/work 写代码'); f.receive('/work 写代码', { chatType: 'group', peerId: 'work@chatroom', sender: { id: 'outsider' } }); await f.channel.whenIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 1); assert(JSON.stringify(f.sent).includes('授权'));
  f.receive('微信助手，解释一下代码', { chatType: 'group', peerId: 'work@chatroom', sender: { id: 'member' } }); await f.channel.whenIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 2); assert(JSON.stringify(f.sent.at(-1)).includes('普通聊天回复'));
});
test('work queue does not block ordinary chat and cancellation stops native task without result resend', async t => {
  const started = Promise.withResolvers();
  const f = fixture(t, async input => { started.resolve(input); await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); });
  f.receive('/work 写代码'); const input = await started.promise;
  f.store.setConversationSettings(scope.accountId, 'private', 'bob', { ...f.store.conversationSettings(scope.accountId, 'private', 'bob'), executionMode: 'chat' });
  f.receive('你好', { peerId: 'bob', sender: { id: 'bob' } }); await f.channel.running; assert(JSON.stringify(f.sent).includes('普通聊天回复'));
  const job = f.channel.work.list(scope).jobs[0]; f.receive(`/work cancel ${job.id}`); await f.channel.whenIdle();
  assert(input.signal.aborted); assert.equal(f.channel.work.get(job.id, scope).state, 'cancelled');
  assert.equal(f.channel.work.get(job.id, scope).delivery.state, 'suppressed'); assert(!f.sent.some(payload => JSON.stringify(payload).includes('工作任务 ' + job.id + ' ·')));
});
test('continuations require same sender and conversation, retain folder and resume only at original workspace', async t => {
  const f = fixture(t), first = f.channel.work.create(scope, '写代码'); await f.channel.whenIdle();
  const next = f.channel.work.create(scope, '修改代码', first.id); await f.channel.whenIdle();
  assert.equal(next.folder, first.folder); assert.equal(f.calls[1].sessionId, 'fixture-session');
  assert.throws(() => f.channel.work.create({ ...scope, peerId: 'bob', senderId: 'bob' }, '修改', first.id), { code: 'WORK_NOT_FOUND' });
  const group = { accountId: scope.accountId, chatType: 'group', peerId: 'work@chatroom', senderId: 'member' };
  assert.equal(workAuthorized(f.store, group), true); assert.equal(workAuthorized(f.store, { ...group, senderId: 'outsider' }), false);
  const workspace = path.join(f.root, 'moved-workspace'); fs.cpSync(f.store.storageSettings().workspacePath, workspace, { recursive: true });
  f.store.setStorageSettings({ ...f.store.storageSettings(), workspacePath: workspace });
  const moved = f.channel.work.create(scope, '继续修改', first.id); await f.channel.whenIdle();
  assert.equal(moved.cwd, path.join(workspace, '微信agent', 'work', first.id)); assert.equal(f.calls[2].sessionId, null);
});
test('revocation stops active and queued tasks, and disconnected work requests fail closed', async t => {
  const started = Promise.withResolvers();
  const f = fixture(t, async input => { started.resolve(input); await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); });
  const config = f.store.config.snapshot(f.store.data); config.work.maxConcurrent = 1; f.store.config.commit(config);
  const a = f.channel.work.create(scope, '写代码'); const input = await started.promise; const b = f.channel.work.create(scope, '写别的代码');
  f.channel.cancel('撤销工作授权', scope); await f.channel.whenIdle(); assert(input.signal.aborted);
  assert.equal(f.channel.work.get(a.id, scope).state, 'cancelled'); assert.equal(f.channel.work.get(b.id, scope).state, 'cancelled'); assert.equal(f.calls.length, 1);
  f.state.online = false; assert.throws(() => f.channel.work.create(scope, '写代码'), { code: 'WORK_NOT_AUTHORIZED' });
});
test('unknown and partial WeChat results preserve ACKs without automatic resend', async t => {
  let sends = 0;
  const f = fixture(t, undefined, () => { if (++sends === 1) return { delivery: 'server-ack', serverMessageIds: ['receipt'] };
    throw new ChannelError('SEND_PARTIAL', '部分已发送', { delivery: 'partially-acknowledged', acknowledgedMessageIds: ['part-1'] }); });
  f.receive('/work 写代码'); await f.channel.whenIdle(); const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'partial'); assert.deepEqual(job.delivery.acknowledgedMessageIds, ['part-1']);
  const reloaded = new WorkStore(f.store); assert.equal(reloaded.get(job.id).delivery.state, 'partial'); assert.equal(sends, 2);
});
test('unconfirmed ACK keeps generation complete and delivery unknown', async t => {
  let n = 0; const f = fixture(t, undefined, () => ++n === 1 ? { delivery: 'server-ack', serverMessageIds: ['accepted'] } : {});
  f.receive('/work 写代码'); await f.channel.whenIdle(); const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'unknown'); assert.equal(n, 2);
});
test('restart marks interrupted execution and uncertain delivery; corrupt and foreign indices stop loading', async t => {
  const f = fixture(t), w = f.channel.work.store, time = Date.now();
  const job = { id: 'aaaaaaaaaaaa', ...scope, folder: 'work/aaaaaaaaaaaa', workspaceRoot: f.store.storageSettings().workspacePath,
    state: 'running', delivery: { state: 'sending' }, operations: [], request: '写代码', createdAt: time, updatedAt: time };
  w.add(job); const restored = new WorkStore(f.store).get(job.id); assert.equal(restored.state, 'interrupted'); assert.equal(restored.delivery.state, 'unknown');
  fs.writeFileSync(w.file, '{'); assert.throws(() => new WorkStore(f.store), { code: 'WORK_STATE_INVALID' });
  fs.writeFileSync(w.file, JSON.stringify({ ...w.data, ownerStoreId: 'foreign' })); assert.throws(() => new WorkStore(f.store), { code: 'WORK_STATE_INVALID' });
});
test('work file tools reject traversal, absolute paths, junctions, stale revisions and metadata writes', async t => {
  const f = fixture(t), cwd = path.join(f.root, 'tool-task'); fs.mkdirSync(cwd);
  for (const relative of ['../escape', path.join(f.root, 'absolute'), 'C:escape', '\u0000']) assert.throws(() => workPath(cwd, relative), { code: 'WORK_PATH_INVALID' });
  fs.symlinkSync(f.root, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => workPath(cwd, 'link/escape'), { code: 'WORK_PATH_INVALID' });
  const ops = [], tools = workTools({ cwd, limits: { commandTimeoutSeconds: 1 }, assertAllowed() {}, onOperation: op => ops.push(op) });
  const invoke = async (name, args) => JSON.parse(await tools.find(tool => tool.name === 'wechat_work_' + name).execute(args, { signal: new AbortController().signal }));
  assert.equal((await invoke('write', { path: 'code.py', text: 'hello', revision: null })).ok, true);
  const read = await invoke('read', { path: 'code.py' }); assert.equal(read.text, 'hello');
  assert.equal((await invoke('write', { path: 'code.py', text: 'bad', revision: null })).code, 'WORK_FILE_CHANGED');
  assert.equal((await invoke('write', { path: 'code.py', text: 'good', revision: read.revision })).ok, true);
  assert.equal((await invoke('write', { path: '.wechat-work/meta', text: 'bad', revision: null })).code, 'WORK_PATH_INVALID');
  assert.equal((await invoke('exec', { command: 'echo test' })).code, 'WORK_EXECUTION_UNAVAILABLE');
});
test('command tools verify native sandbox policy before execution and surface actual failures', async t => {
  const f = fixture(t), cwd = f.root; let executed = 0;
  const shell = { sandboxMode: 'workspace-write', resolve: input => ({ ...input, workdir: path.dirname(cwd) }), execute: async () => { executed++; } };
  const invoke = async provider => JSON.parse(await workTools({ cwd, shell: provider, resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: cwd }), limits: { commandTimeoutSeconds: 3 }, assertAllowed() {}, onOperation() {} }).find(tool => tool.name === 'wechat_work_exec')
    .execute({ command: 'echo test' }, { signal: new AbortController().signal }));
  assert.equal((await invoke(shell)).code, 'WORK_SANDBOX_INVALID'); assert.equal(executed, 0);
  shell.resolve = input => input; shell.execute = async () => ({ result: async () => ({ exitCode: 9, stdout: { text: 'actual output' }, stderr: { text: 'error' }, sandbox: { mode: 'workspace-write', enforcement: 'partial' } }) });
  const result = await invoke(shell); assert.equal(result.ok, false); assert.equal(result.exitCode, 9); assert.equal(result.stdout, 'actual output'); assert.equal(result.sandbox.enforcement, 'partial');
});
test('model claims cannot overwrite a failed tool result or fabricate checks', async t => {
  const f = fixture(t, async input => { await input.onOperation({ tool: 'wechat_work_exec', command: 'test-command', result: { ok: false, exitCode: 7, stdout: 'FAILED' } }); return { text: '全部成功' }; });
  f.channel.work.create(scope, '写代码'); await f.channel.whenIdle(); const job = f.channel.work.list(scope).jobs[0];
  assert.equal(job.state, 'failed'); assert(workResult(job, job.cwd, { full: true }).includes('退出码 7')); assert(workResult(job, job.cwd, { full: true }).includes('FAILED'));
  assert.match(workResult(job, job.cwd), /没能完成/); assert(!workResult(job, job.cwd).includes('全部成功'));
  assert(!workResult(job, job.cwd).includes('FAILED')); assert(!workResult(job, job.cwd).includes('退出码'));
});
test('owner RPC work endpoints isolate current account and allow local cancellation', async t => {
  const f = fixture(t); const service = createPluginService({ store: f.store, root: f.root, worker: f.channel.transport, runner: f.channel.runner, channel: f.channel });
  const rpc = rpcHandler(service), owner = { principal: { kind: 'owner' } };
  assert.equal((await rpc('work.list', { accountId: scope.accountId }, undefined, { principal: { kind: 'agent' } })).error.code, 'OWNER_REQUIRED');
  assert.equal((await rpc('work.list', { accountId: 'foreign' }, undefined, owner)).error.code, 'ACCOUNT_CHANGED');
  f.channel.work.create(scope, '写代码'); await f.channel.whenIdle(); const job = f.channel.work.list(scope).jobs[0];
  assert.equal((await rpc('work.get', { accountId: scope.accountId, id: job.id }, undefined, owner)).value.id, job.id);
  assert.equal((await rpc('work.get', { accountId: scope.accountId, chatType: 'private', peerId: 'bob', id: job.id }, undefined, owner)).error.code, 'WORK_NOT_FOUND');
});
test('work Agent keeps native DSH context, preset and model while adding shared public language and WeChat tools', async t => {
  const f = fixture(t), workspacePath = path.join(f.store.storageSettings().workspacePath, '微信agent'), cwd = path.join(workspacePath, 'work', 'aaaaaaaaaaaa'), order = [], definitions = [], operations = [], attached = [], sections = new Set();
  fs.mkdirSync(cwd, { recursive: true });
  const shell = { sandboxMode: 'workspace-write', resolve: spec => { assert.equal(spec.workdir, cwd); return spec; }, execute: async () => ({ result: async () => ({ exitCode: 0, stdout: 'native-result', sandbox: { mode: 'workspace-write', enforcement: 'partial' } }) }) };
  const presets = { defaultId: 'coding', mount: async (_ctx, id) => { assert.equal(id, 'coding'); order.push('preset'); }, serviceFor: (_agent, name) => name === 'shell' ? shell : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspacePath }) } : undefined };
  const ctx = { workspaceRegistry: { create: async (directory, title) => { assert.equal(directory, cwd); return { title, attachSession: async id => attached.push(id) }; } }, get: name => name === 'agentPresets' ? presets : undefined, agents: { create: async options => {
    assert.equal(options.meta.cwd, cwd);
    const session = { id: options.sessionId, seq: 0, header: options.meta, snapshotEvents: () => [
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '工作完成' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] };
    let pending;
    const agent = { session, followup: () => { pending = definitions.find(tool => tool.name === 'wechat_work_exec').execute({ command: 'echo result' }, { agent, signal: options.signal }); }, whenIdle: async () => { await pending; }, cancel() {} };
    await options.setup({ tools: { restrict: () => assert.fail('native work cannot restrict DSH tools'), register: tool => definitions.push(tool), guard() {} }, systemPrompt: {
      suppressRuntimeContext() { assert.fail('native context must stay enabled'); }, section(section) {
        assert.equal(section.name, 'wechat-work-presentation');
        assert(section.text.includes('全局语言与言辞边界'));
        assert(section.text.includes('不改变工具权限和执行判断'));
        assert(!section.text.includes('这是内部资料处理任务'));
        sections.add(section); return () => sections.delete(section);
      } } }, agent);
    return { agent, dispose: async () => {} };
  } } };
  const runner = new DshWorkRunner({ ctx, getRuntimeSettings: () => ({ workspacePath }), defaultSelection: () => ({ provider: 'fixture', model: 'fixture' }) });
  const result = await runner.run({ request: '写代码', cwd, signal: new AbortController().signal, limits: { commandTimeoutSeconds: 3 }, assertAllowed() {}, onSession() {}, onOperation: operation => operations.push(operation) });
  assert.deepEqual(order, ['preset']); assert.deepEqual(definitions.map(tool => tool.name).sort(), ['wechat_work_exec', 'wechat_work_list', 'wechat_work_output', 'wechat_work_read', 'wechat_work_write']); assert.equal(operations[0].result.stdout, 'native-result'); assert.equal(result.text, '工作完成'); assert.equal(result.native, true);
  assert.deepEqual(attached, [result.sessionId]);
  assert.equal(sections.size, 0, 'the public language addition is removed after this native turn');
});
test('a failed operation-state commit aborts work immediately before another tool can execute', async t => {
  let input;
  const f = fixture(t, async value => { input = value; await value.onOperation({ tool: 'wechat_work_write', path: 'hello.py', result: { ok: true } }); return { text: '完成' }; });
  const update = f.channel.work.store.update.bind(f.channel.work.store);
  f.channel.work.store.update = (id, patch) => { if (patch.operations) throw new ChannelError('STATE_WRITE_FAILED', '模拟磁盘失败'); return update(id, patch); };
  f.channel.work.create(scope, '写代码'); await f.channel.whenIdle();
  assert(input.signal.aborted); assert.equal(f.channel.fault.code, 'STATE_WRITE_FAILED'); assert.equal(f.sent.length, 0);
  f.channel.work.store.update = update;
});
