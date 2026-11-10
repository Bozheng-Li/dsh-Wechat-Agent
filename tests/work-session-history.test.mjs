import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshWorkRunner, publishWorkSessionHistory } from '../lib/testing.js';

test('stored work history is reannounced using the public DSH summary without activating or modifying another session', async () => {
  const events = [], summary = { sessionId: 'work-session', agentAvailable: false, blank: false, running: false,
    cwd: 'fixture-workspace', updatedAt: 123, projections: { values: { title: '微信工作 · 查询结果' } } };
  const ctx = { sessionController: { list: async (_request, signal) => { assert(!signal.aborted); return { items: [{ sessionId: 'other' }, summary] }; } },
    emit: (...args) => events.push(args), agents: { resume: () => { throw Error('history must not activate a loop'); } } };
  assert.deepEqual(await publishWorkSessionHistory(ctx, 'work-session'), { state: 'visible' });
  assert.deepEqual(events, [['api-session/added', summary]]);
});

test('missing optional UI support and history-list faults preserve the task result and report the actual archive state', async () => {
  assert.equal((await publishWorkSessionHistory({}, 'work')).state, 'stored');
  assert.equal((await publishWorkSessionHistory({ emit() {}, sessionController: { list: async () => { throw Error('storage offline'); } } }, 'work')).state, 'stored');
  assert.equal((await publishWorkSessionHistory({ emit() {}, sessionController: { list: async () => ({ items: [] }) } }, 'missing')).state, 'unavailable');
});

for (const failure of [false, true]) test(`work runner releases resources then republishes the saved history after ${failure ? 'model failure' : 'completion'}`, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-history-test-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(cwd)), fs.realpathSync(os.tmpdir())); fs.rmSync(cwd, { recursive: true, force: true }); });
  const sequence = [], histories = [];
  let sessionId;
  const ctx = { get() {}, sessionController: { list: async () => { sequence.push('list'); return { items: [{ sessionId, agentAvailable: false, blank: false }] }; } },
    emit: (event, summary) => { sequence.push(event); assert.equal(summary.sessionId, sessionId); },
    agents: { create: async options => {
      sessionId = options.sessionId;
      const session = { header: options.meta, seq: 0, snapshotEvents: () => [
        { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '查到了，结果为 42。' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: failure ? 'error' : 'completed' } } },
      ] };
      const agent = { session, followup: message => { assert.equal(message.source.kind, 'user'); sequence.push('followup'); },
        cancel() {}, whenIdle: async () => {} };
      await options.setup({ tools: { restrict() {}, register() {}, guard() {} }, systemPrompt: { suppressRuntimeContext() {}, section() {} } }, agent);
      return { agent, dispose: async () => { sequence.push('dispose'); } };
    } } };
  const runner = new DshWorkRunner({ ctx, defaultSelection: () => ({ provider: 'fixture', model: 'fixture' }) });
  const run = () => runner.run({ request: '读取任务结果', cwd, signal: new AbortController().signal, limits: { commandTimeoutSeconds: 1 },
    assertAllowed() {}, onSession() {}, onOperation() {}, onSessionHistory: value => histories.push(value) });
  if (failure) await assert.rejects(run(), { code: 'MODEL_INCOMPLETE' });
  else assert.equal((await run()).text, '查到了，结果为 42。');
  assert.deepEqual(sequence, ['followup', 'dispose', 'list', 'api-session/added']); assert.deepEqual(histories, [{ state: 'visible' }]);
});

for (const ownership of ['desktop Agent', 'racing desktop Agent', 'writer lock', 'unrelated resume error']) test(`native continuation retains the original history through ${ownership} and submits only once`, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-native-resume-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(cwd)), fs.realpathSync(os.tmpdir())); fs.rmSync(cwd, { recursive: true, force: true }); });
  const calls = [], messages = [], registered = new Map(), guards = new Set(), presentationSections = new Set(), nativeSelection = { provider: 'native', model: 'default', reasoningEffort: 'high' };
  const desktop = ownership.includes('desktop Agent'), racedWork = Promise.withResolvers(); let maintenanceAttempts = 0;
  const events = Array.from({ length: 7 }, (_, seq) => ({ type: 'retained-fixture-event', seq, data: { value: seq } })), original = structuredClone(events);
  const local = { get() {}, tools: { modeFor: () => 'native', presentAs: () => assert.fail('an existing native presentation must be retained'),
    register: tool => { if (desktop) assert.equal(existing.status, 'maintenance'); assert(!registered.has(tool.name)); registered.set(tool.name, tool); return () => registered.delete(tool.name); },
    guard: guard => { guards.add(guard); return () => guards.delete(guard); }, restrict: () => assert.fail('native tools must remain') },
    systemPrompt: { section: section => {
      if (desktop) assert.equal(existing.status, 'maintenance');
      assert.equal(section.name, 'wechat-work-presentation');
      assert(section.text.includes('全局语言与言辞边界'));
      assert(section.text.includes('不改变工具权限和执行判断'));
      presentationSections.add(section); return () => presentationSections.delete(section);
    } } };
  const existing = { status: 'idle', ctx: local,
    session: { id: 'existing', header: { cwd }, seq: 7, snapshotEvents: (from = 0) => structuredClone(events.slice(from)) },
    followup: message => { messages.push(message); events.push({ type: 'user/message', seq: events.length, data: message },
      { type: 'assistant/message', seq: events.length + 1, data: { turn: 1, message: { content: [{ type: 'text', text: '原生工作完成' }] } } },
      { type: 'turn/end', seq: events.length + 2, data: { turn: 1, reason: { kind: 'completed' } } }); existing.session.seq = events.length; },
    runMaintenance: async action => {
      assert.equal(existing.status, 'idle'); maintenanceAttempts++;
      if (ownership === 'racing desktop Agent' && maintenanceAttempts === 1) {
        existing.status = 'running'; setTimeout(() => { existing.status = 'idle'; racedWork.resolve(); }, 10);
        throw Error('another desktop turn became active');
      }
      existing.status = 'maintenance'; try { return await action(); } finally { existing.status = 'idle'; }
    },
    whenIdle: async () => { if (existing.status === 'running') await racedWork.promise; },
    cancel: () => { assert(!desktop, 'borrowed desktop Agent must stay alive'); calls.push('cancel'); } };
  const ctx = { agentDefaultModel: { currentSelection: () => nativeSelection }, agents: {
    get: id => desktop && id === 'existing' ? existing : undefined,
    resume: async options => {
      calls.push('resume'); assert.equal(options.resumeSessionId, 'existing'); assert.deepEqual(options.agentOptions, nativeSelection);
      if (ownership === 'writer lock' && calls.filter(value => value === 'resume').length > 1) {
        await options.setup(local, existing); return { agent: existing, dispose: async () => calls.push('dispose') };
      }
      const error = new Error('resume failed'); error.name = ownership === 'writer lock' ? 'SessionAlreadyOwnedError' : 'StorageCorruptError'; throw error;
    },
    create: () => assert.fail('continuation must not create an empty replacement session'),
  } };
  const runner = new DshWorkRunner({ ctx, defaultSelection: () => ({ provider: 'chat', model: 'chat-choice' }) });
  const run = () => runner.run({ request: '原话：继续查看 scut2 的八卡实验指标', cwd, sessionId: 'existing', signal: new AbortController().signal,
    limits: { commandTimeoutSeconds: 1 }, assertAllowed() {}, onSession() {}, onOperation() {} });
  if (ownership === 'unrelated resume error') { await assert.rejects(run(), { code: 'WORK_AGENT_FAILED' }); assert.deepEqual(calls, ['resume']); assert.equal(messages.length, 0); }
  else {
    assert.equal((await run()).text, '原生工作完成'); assert.deepEqual(calls, desktop ? [] : ['resume', 'resume', 'cancel', 'dispose']);
    assert.equal(messages.length, 1); assert.equal(messages[0].content[0].text, '原话：继续查看 scut2 的八卡实验指标'); assert.equal(messages[0].source.kind, 'user');
  }
  assert.deepEqual(events.slice(0, 7), original); assert.equal(existing.session.seq, ownership === 'unrelated resume error' ? 7 : 10);
  assert.equal(registered.size, 0); assert.equal(guards.size, 0);
  assert.equal(presentationSections.size, 0, 'the shared presentation never persists on a borrowed desktop Agent');
  if (ownership === 'racing desktop Agent') assert.equal(maintenanceAttempts, 2);
});

test('cancelling while waiting for a busy desktop session neither cancels that work nor opens another session', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-wait-native-')), waiting = Promise.withResolvers(), idle = Promise.withResolvers();
  t.after(() => { idle.resolve(); assert.equal(path.dirname(fs.realpathSync(cwd)), fs.realpathSync(os.tmpdir())); fs.rmSync(cwd, { recursive: true, force: true }); });
  const existing = { status: 'running', session: { id: 'original', header: { cwd } },
    whenIdle: () => { waiting.resolve(); return idle.promise; }, cancel: () => assert.fail('waiting cannot cancel desktop work'),
    followup: () => assert.fail('cancelled waiting cannot submit') };
  const ctx = { agents: { get: () => existing, create: () => assert.fail('must retain session'), resume: () => assert.fail('already live') } };
  const runner = new DshWorkRunner({ ctx, defaultSelection: () => ({ provider: 'native', model: 'default' }) }), controller = new AbortController();
  const pending = runner.run({ request: '接着处理', cwd, sessionId: 'original', signal: controller.signal,
    limits: { commandTimeoutSeconds: 1 }, assertAllowed() {}, onSession: () => assert.fail('not submitted'), onOperation() {} });
  await waiting.promise; const reason = Object.assign(new Error('取消等待'), { code: 'WORK_CANCELLED' }); controller.abort(reason);
  await assert.rejects(pending, { code: 'WORK_CANCELLED' }); assert.equal(existing.status, 'running');
});
