import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../lib/testing.js';

function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function backdate(file, seconds) {
  const when = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(file, when, when);
}

function lockFile(directory) {
  return path.join(directory, 'owner.lock');
}

test('a lock left empty by a crash between create and write is reaped instead of blocking startup', t => {
  const directory = root(t), file = lockFile(directory);
  fs.writeFileSync(file, '');
  backdate(file, 60);
  const lock = acquireLock(directory);
  t.after(() => lock.release());
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
});

test('a lock truncated by a crash is reaped once it is no longer fresh', t => {
  const directory = root(t), file = lockFile(directory);
  fs.writeFileSync(file, '{"pid":1234,"tok');
  backdate(file, 60);
  const lock = acquireLock(directory);
  t.after(() => lock.release());
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
});

test('an unreadable lock that is still fresh is reported with its path instead of being overwritten', t => {
  const directory = root(t), file = lockFile(directory);
  fs.writeFileSync(file, '');
  assert.throws(
    () => acquireLock(directory),
    error => error.code === 'OWNER_BUSY' && error.message.includes('owner.lock'),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('a live owner still blocks a second instance and the lock is never reaped', t => {
  const directory = root(t), file = lockFile(directory);
  const lock = acquireLock(directory);
  t.after(() => lock.release());
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => acquireLock(directory), /另一个 DSH/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('releasing a lock restores a clean directory so the next start succeeds', t => {
  const directory = root(t), file = lockFile(directory);
  const lock = acquireLock(directory);
  lock.release();
  assert.equal(fs.existsSync(file), false);
  const next = acquireLock(directory);
  next.release();
  assert.equal(fs.existsSync(file), false);
});
