import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { workTools, readWorkArtifact } from '../lib/testing.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-work-permission-')), cwd = path.join(root, 'workspace', 'task');
  fs.mkdirSync(cwd, { recursive: true });
  let mode = 'danger-full-access', executions = 0, resolutions = 0;
  const operations = [], policies = [];
  const resolvePolicy = exec => { resolutions++; return { mode, workspaceRoot: path.join(root, 'workspace'), sessionId: exec.agent.session.id }; };
  const shell = { sandboxMode: 'workspace-write', resolve: value => value, execute: async spec => {
    executions++; policies.push(spec.sandboxPolicy);
    return { result: async () => ({ exitCode: 0, stdout: 'actual result', stderr: '', sandbox: { mode: spec.sandboxPolicy.mode, denied: false } }) };
  } };
  const tools = workTools({ cwd, shell, resolvePolicy, limits: { commandTimeoutSeconds: 10 }, assertAllowed() {}, onOperation: operation => operations.push(operation) });
  const invoke = async (suffix, args) => JSON.parse(await tools.find(tool => tool.name === 'wechat_work_' + suffix)
    .execute(args, { agent: { session: { id: 'session-A' } }, signal: new AbortController().signal }));
  t.after(() => { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^wechat-work-permission-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, cwd, shell, operations, policies, invoke, setMode: value => { mode = value; }, get executions() { return executions; }, get resolutions() { return resolutions; } };
}

test('commands honor current session full access despite a workspace-write executor default, then follow session switches', async t => {
  const f = fixture(t);
  assert.equal((await f.invoke('exec', { command: 'actual command' })).sandbox.mode, 'danger-full-access');
  assert.equal(f.policies[0].workspaceRoot, path.join(f.root, 'workspace')); assert.equal(f.policies[0].sessionId, 'session-A');
  f.setMode('read-only'); assert.equal((await f.invoke('exec', { command: 'read command' })).sandbox.mode, 'read-only');
  f.setMode('workspace-write'); assert.equal((await f.invoke('exec', { command: 'workspace command' })).sandbox.mode, 'workspace-write');
  assert.equal(f.resolutions, 3); assert.equal(f.executions, 3);
});

test('missing or changed permission, execution directory, signal and timeout policy never silently widen native execution', async t => {
  const f = fixture(t), resolve = f.shell.resolve;
  for (const mutation of [
    spec => ({ ...spec, sandboxPolicy: { ...spec.sandboxPolicy, mode: 'workspace-write' } }),
    spec => ({ ...spec, workdir: f.root }), spec => ({ ...spec, signal: undefined }),
    spec => ({ ...spec, timeoutMs: 999999 }), spec => ({ ...spec, onExpiry: 'background' }),
  ]) { f.shell.resolve = mutation; assert.equal((await f.invoke('exec', { command: 'command' })).code, 'WORK_SANDBOX_INVALID'); }
  assert.equal(f.executions, 0); f.shell.resolve = resolve;
  f.setMode('unknown'); assert.equal((await f.invoke('exec', { command: 'command' })).code, 'WORK_PERMISSION_UNAVAILABLE'); assert.equal(f.executions, 0);
});

test('existing Word files can be found and returned as immutable task copies, keeping original bytes', async t => {
  const f = fixture(t), previous = path.join(f.root, 'yesterday'), source = path.join(previous, '新闻摘要.docx'), bytes = Buffer.from('actual existing Word attachment bytes');
  fs.mkdirSync(previous); fs.writeFileSync(source, bytes);
  assert((await f.invoke('list', { path: previous })).items.some(item => item.name === '新闻摘要.docx'));
  const result = await f.invoke('output', { paths: [source] });
  assert.equal(result.ok, true); assert.equal(result.artifacts[0].name, '新闻摘要.docx'); assert.match(result.artifacts[0].path, /^attachments\//);
  const copy = readWorkArtifact(f.cwd, result.artifacts[0].path, result.artifacts[0]);
  assert.deepEqual(Buffer.from(copy.segment.data.base64, 'base64'), bytes); assert.deepEqual(fs.readFileSync(source), bytes);
  fs.writeFileSync(source, 'user revised original later');
  assert.deepEqual(Buffer.from(readWorkArtifact(f.cwd, result.artifacts[0].path, result.artifacts[0]).segment.data.base64, 'base64'), bytes);
});

test('file mutations share actual read-only and workspace-write restrictions; full access accepts authorized ordinary paths', async t => {
  const f = fixture(t), outside = path.join(f.root, 'ordinary.txt');
  f.setMode('read-only'); assert.equal((await f.invoke('write', { path: 'new.txt', text: 'blocked', revision: null })).code, 'WORK_PERMISSION_DENIED');
  assert(!fs.existsSync(path.join(f.cwd, 'new.txt')));
  f.setMode('workspace-write'); assert.equal((await f.invoke('write', { path: outside, text: 'blocked', revision: null })).code, 'WORK_PATH_INVALID');
  assert.equal((await f.invoke('write', { path: '../existing.txt', text: 'workspace write', revision: null })).ok, true);
  f.setMode('danger-full-access'); assert.equal((await f.invoke('write', { path: outside, text: 'full access', revision: null })).ok, true);
  const read = await f.invoke('read', { path: outside }); assert.equal(read.text, 'full access');
  f.setMode('read-only'); assert.equal((await f.invoke('write', { path: outside, text: 'blocked again', revision: read.revision })).code, 'WORK_PERMISSION_DENIED');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'full access');
  assert.equal((await f.invoke('read', { path: path.join(f.root, '.wechat-work', 'private.md') })).code, 'WORK_PATH_INVALID');
});
