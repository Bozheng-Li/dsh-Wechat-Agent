import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareAgentWorkspace, registerAgentWorkspace, consolidateWorkProjects, StateStore, pluginInject as inject } from '../lib/testing.js';

test('the host plugin declares the workspace service and reports a lookup failure clearly', async () => {
  assert(inject.includes('workspaceRegistry'));
  await assert.rejects(registerAgentWorkspace({ get workspaceRegistry() { throw Error('uninjected service'); } }, 'unused'), { code: 'AGENT_WORKSPACE_REGISTRATION_FAILED' });
});

test('internal named workspace is a direct child of the configured work root and registration is idempotent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-agent-workspace-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new StateStore(root), base = store.ensureWorkspace();
  const directory = prepareAgentWorkspace(base);
  assert.equal(directory, path.join(base, '微信agent')); assert.equal(prepareAgentWorkspace(base), directory);
  assert.equal(store.storageSettings().workspacePath, base);
  const existing = { path: directory, title: 'old title', setTitle: async title => { existing.title = title; } };
  const calls = [], ctx = { workspaceRegistry: { create: async (...args) => { calls.push(args); return existing; } } };
  assert.equal(await registerAgentWorkspace(ctx, directory), existing);
  assert.equal(await registerAgentWorkspace(ctx, directory), existing); assert.equal(existing.title, '微信聊天');
  assert(calls.every(([dir, title]) => dir === directory && title === '微信聊天'));
  assert.equal(await registerAgentWorkspace({}, directory), null);
  await assert.rejects(registerAgentWorkspace({ workspaceRegistry: { create: async () => { throw Error('unavailable'); } } }, directory), { code: 'AGENT_WORKSPACE_REGISTRATION_FAILED' });
});

test('internal workspace rejects a file or redirected child without writing to another project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-agent-workspace-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const base = path.join(root, 'workspace'), outside = path.join(root, 'another-project');
  fs.mkdirSync(base); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'retained');
  const child = path.join(base, '微信agent'); fs.writeFileSync(child, 'file');
  assert.throws(() => prepareAgentWorkspace(base), { code: 'AGENT_WORKSPACE_UNAVAILABLE' }); fs.unlinkSync(child);
  fs.symlinkSync(outside, child, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareAgentWorkspace(base), { code: 'AGENT_WORKSPACE_UNAVAILABLE' });
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']); assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'retained');
});

test('startup preserves live idle sessions without waiting on their persistence writers', async () => {
  const projectCwd = path.resolve('fixed-work-project'), taskCwd = path.join(projectCwd, 'work', 'old-task');
  const header = { id: 'current', cwd: projectCwd }, events = [{ type: 'message', text: 'retained' }];
  const current = { status: 'idle', session: { header, seq: 1, snapshotEvents: () => events } };
  const legacy = { status: 'idle', session: { header: { id: 'legacy', cwd: taskCwd } } };
  const attached = [], project = { path: projectCwd, title: '微信工作', attachSession: async id => attached.push(id) };
  let reads = 0;
  const ctx = { agents: { get: id => ({ current, legacy })[id] },
    workspaceRegistry: { list: () => [], archivedSessionIds: [], create: async () => project },
    sessionPersistence: { create: async () => { throw Error('No new session expected'); },
      open: async () => { reads++; throw Error('Live Agent owns its writer lock'); } } };
  const store = { data: { jobs: ['current', 'legacy'].map(sessionId => ({ sessionId, workspaceRoot: projectCwd, folder: 'work/old-task' })) } };
  const result = await consolidateWorkProjects(ctx, store, projectCwd);
  assert.equal(reads, 0); assert.deepEqual(attached, ['current']); assert.equal(result.migrated, 0);
  assert.deepEqual(result.pending, [{ sessionId: 'legacy', code: 'WORK_SESSION_BUSY' }]);
  assert.equal(current.session.header, header); assert.equal(current.session.seq, 1); assert.deepEqual(current.session.snapshotEvents(), events);
});

test('startup does not reopen registered fixed-project histories whose parent writers may still be live', async () => {
  const workspaceRoot = path.resolve('registered-work-project'), sessionIds = ['stored-child', 'desktop-loaded'];
  let reads = 0;
  const ctx = { agents: { get: () => undefined },
    workspaceRegistry: { list: () => [{ path: workspaceRoot, sessionIds }], archivedSessionIds: [] },
    sessionPersistence: { create: async () => { throw Error('No migration needed'); },
      open: async () => { reads++; throw Error('Inherited parent writer is held'); } } };
  const store = { data: { jobs: sessionIds.map(sessionId => ({ sessionId, workspaceRoot, folder: 'work/retained-task' })) } };
  const result = await consolidateWorkProjects(ctx, store, workspaceRoot);
  assert.equal(result.state, 'ready'); assert.equal(result.migrated, 0); assert.equal(reads, 0);
  assert.deepEqual(result.pending, []); assert.deepEqual(result.removedProjects, []);
});
