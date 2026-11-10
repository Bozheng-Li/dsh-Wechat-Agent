import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workTools } from '../modules/tools/work-execution.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-progressive-output-'));
  const operations = [];
  let authorized = true, resolutions = 0;
  let result = { exitCode: 0, stdout: '', stderr: '', sandbox: { mode: 'read-only', denied: false } };
  const tools = workTools({ cwd: root,
    resolvePolicy: () => { resolutions++; return { mode: 'read-only', workspaceRoot: root, sessionId: 'pagination-test' }; },
    shell: { sandboxMode: 'read-only', resolve: value => value, execute: async () => ({ result: async () => result }) },
    limits: { commandTimeoutSeconds: 10 },
    assertAllowed: () => { if (!authorized) throw Error('authorization revoked'); },
    onOperation: operation => operations.push(operation),
  });
  const invoke = (name, args, signal = new AbortController().signal) => tools.find(tool => tool.name === 'wechat_work_' + name)
    .execute(args, { signal, agent: { session: { id: 'pagination-test' } } }).then(JSON.parse);
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-progressive-output-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, invoke, operations, save: (name, value) => fs.writeFileSync(path.join(root, name), value),
    setResult: value => { result = { ...result, ...value }; }, revoke: () => { authorized = false; },
    get resolutions() { return resolutions; } };
}

test('short and empty reads keep text and full-file revision without inventing omitted content', async t => {
  const f = fixture(t), text = '中文与 emoji 🐈\r\n第二行';
  f.save('short.txt', text); f.save('empty.txt', '');
  const read = await f.invoke('read', { path: 'short.txt' });
  assert.equal(read.ok, true); assert.equal(read.path, 'short.txt'); assert.equal(read.text, text);
  assert.equal(read.revision, createHash('sha256').update(text).digest('hex'));
  assert.equal(read.bytes, Buffer.byteLength(text)); assert.equal(read.totalChars, Array.from(text).length);
  assert.equal(read.hasMore, false); assert.equal(read.truncated, false); assert.equal(read.nextCursor, null);
  const empty = await f.invoke('read', { path: 'empty.txt' });
  assert.equal(empty.text, ''); assert.equal(empty.returnedChars, 0); assert.equal(empty.hasMore, false);
});

test('a large multilingual file is bounded per page and can be reconstructed exactly', async t => {
  const f = fixture(t), text = ('起点🐈\r\n' + 'a'.repeat(5993) + '终点🌏\n').repeat(4);
  f.save('large.txt', text);
  let read = await f.invoke('read', { path: 'large.txt' }), joined = '', pages = 0;
  const revision = createHash('sha256').update(text).digest('hex');
  assert.equal(read.returnedChars, 6000); assert.equal(read.hasMore, true); assert.equal(read.truncated, true);
  for (;;) {
    pages++;
    assert.equal(read.ok, true); assert.equal(read.revision, revision);
    assert.equal(read.offset, Array.from(joined).length);
    assert(Array.from(read.text).length <= 6000); assert.equal(read.bytes, Buffer.byteLength(text));
    assert.equal(read.totalChars, Array.from(text).length); assert.equal(read.text.isWellFormed(), true);
    joined += read.text;
    if (!read.hasMore) { assert.equal(read.nextCursor, null); break; }
    read = await f.invoke('read', { path: 'large.txt', cursor: read.nextCursor });
  }
  assert.equal(joined, text); assert(pages > 1); assert.equal(f.resolutions, pages);
  assert.equal(read.truncated, true, 'the last page is still only part of the whole file');
});

test('targeted offsets use Unicode characters and distinguish end of file from a complete read', async t => {
  const f = fixture(t); f.save('range.txt', '甲🐈乙🌏丙');
  const read = await f.invoke('read', { path: 'range.txt', offset: 1, limit: 2 });
  assert.equal(read.text, '🐈乙'); assert.equal(read.offset, 1); assert.equal(read.returnedChars, 2);
  assert.equal((await f.invoke('read', { path: 'range.txt', cursor: read.nextCursor, limit: 1 })).text, '🌏');
  const last = await f.invoke('read', { path: 'range.txt', offset: 4 });
  assert.equal(last.text, '丙'); assert.equal(last.hasMore, false); assert.equal(last.truncated, true);
  const end = await f.invoke('read', { path: 'range.txt', offset: 5 });
  assert.equal(end.text, ''); assert.equal(end.hasMore, false);
});

test('continuations cannot combine changed versions or replay a cursor against another path', async t => {
  const f = fixture(t); f.save('first.txt', 'abcdef'); f.save('second.txt', 'abcdef');
  const first = await f.invoke('read', { path: 'first.txt', limit: 2 });
  assert.equal((await f.invoke('read', { path: 'second.txt', cursor: first.nextCursor })).code, 'WORK_READ_CURSOR_INVALID');
  f.save('first.txt', 'abcXYZ');
  const changed = await f.invoke('read', { path: 'first.txt', cursor: first.nextCursor });
  assert.equal(changed.ok, false); assert.equal(changed.code, 'WORK_FILE_CHANGED'); assert.equal(changed.text, undefined);
  assert.equal((await f.invoke('read', { path: 'first.txt' })).text, 'abcXYZ');
});

test('invalid ranges, malformed cursors, oversized files and invalid UTF-8 remain errors', async t => {
  const f = fixture(t); f.save('text.txt', '123');
  for (const args of [{ offset: -1 }, { offset: 0.5 }, { offset: 4 }, { limit: 0 }, { limit: 6001 }, { limit: null },
    { limit: '5' }, { offset: 0, cursor: 'anything' }]) {
    const read = await f.invoke('read', { path: 'text.txt', ...args });
    assert.equal(read.ok, false); assert.equal(read.code, 'WORK_READ_RANGE_INVALID');
  }
  for (const cursor of ['', null, 'not-a-cursor', 'x'.repeat(401)]) {
    assert.equal((await f.invoke('read', { path: 'text.txt', cursor })).code, 'WORK_READ_CURSOR_INVALID');
  }
  f.save('too-large.txt', Buffer.alloc(512001, 65)); f.save('invalid.txt', Buffer.from([0xc3, 0x28]));
  assert.equal((await f.invoke('read', { path: 'too-large.txt' })).code, 'WORK_FILE_INVALID');
  assert.equal((await f.invoke('read', { path: 'invalid.txt' })).ok, false);
  assert.equal((await f.invoke('read', { path: '.wechat-work/internal.txt' })).code, 'WORK_PATH_INVALID');
});

test('each continuation still enforces authorization and cancellation', async t => {
  const f = fixture(t); f.save('text.txt', 'abcdef');
  const first = await f.invoke('read', { path: 'text.txt', limit: 2 });
  const cancelled = new AbortController(); cancelled.abort(Error('page cancelled'));
  await assert.rejects(f.invoke('read', { path: 'text.txt', cursor: first.nextCursor }, cancelled.signal), /page cancelled/);
  f.revoke();
  await assert.rejects(f.invoke('read', { path: 'text.txt', cursor: first.nextCursor }), /authorization revoked/);
  assert.equal(f.operations.length, 1);
});

test('command truncation is explicit and preserves failure, timeout and actual exit status', async t => {
  const f = fixture(t), stdout = 'START_' + 'a'.repeat(9000) + '_END';
  f.setResult({ exitCode: 7, timedOut: true, stdout, stderr: { text: 'actual error' } });
  const result = await f.invoke('exec', { command: 'synthetic command' });
  assert.equal(result.ok, false); assert.equal(result.exitCode, 7); assert.equal(result.timedOut, true);
  assert.equal(result.stdout, stdout.slice(-8000)); assert.equal(result.stderr, 'actual error');
  assert.equal(result.outputTruncated, true); assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, false);
  assert.equal(result.stdoutCapturedChars, stdout.length); assert.equal(result.stderrCapturedChars, 'actual error'.length);
  assert.equal(result.sandbox.mode, 'read-only');
});

test('short command output is complete unless its executor explicitly reports an earlier truncation', async t => {
  const f = fixture(t); f.setResult({ stdout: 'complete', stderr: '' });
  const complete = await f.invoke('exec', { command: 'synthetic command' });
  assert.equal(complete.ok, true); assert.equal(complete.stdout, 'complete'); assert.equal(complete.outputTruncated, false);
  f.setResult({ stdout: { text: 'only captured tail', truncated: true }, aborted: true });
  const upstream = await f.invoke('exec', { command: 'synthetic command' });
  assert.equal(upstream.ok, false); assert.equal(upstream.cancelled, true); assert.equal(upstream.stdoutTruncated, true);
  assert.equal(upstream.stdoutCapturedChars, 'only captured tail'.length);
});
