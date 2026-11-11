import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WorkStore } from '../lib/testing.js';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wechat-operation-storage-'));
  const state = new StateStore(root), work = new WorkStore(state);
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^wechat-operation-storage-/);
    assert(!fs.lstatSync(resolved).isSymbolicLink()); fs.rmSync(resolved, { recursive: true, force: true });
  });
  const job = { id: 'abcdef123456', accountId: 'owner', chatType: 'private', peerId: 'alice', senderId: 'alice',
    request: '查询已授权的资料', workspaceRoot: root, folder: 'work/abcdef123456', state: 'succeeded', nativeExecution: true,
    createdAt: 1794355200000, updatedAt: 1794355200000, operations: [], result: { text: '已处理', files: [] },
    delivery: { state: 'sent', acknowledgedMessageIds: ['confirmed-original-receipt'] } };
  work.add(job);
  return { root, state, work, job };
}

for (const tool of ['wechat_web_search', 'wechat_moments_images', 'wechat_moments_like_recent', 'wechat_moments_interact']) {
  for (const ok of [true, false]) test(`work results survive restart with ${tool}, ok=${ok}`, t => {
    const f = fixture(t), operation = { tool, at: f.job.createdAt + 1,
      result: { ok, ...(ok ? { source: 'synthetic-result', count: 1 } : { code: 'FIXTURE_FAILURE', message: '实际操作失败' }) } };
    f.work.update(f.job.id, { operations: [operation], ...(ok ? {} : { state: 'failed', error: { code: 'FIXTURE_FAILURE' } }) });
    const before = f.work.get(f.job.id), restartedState = new StateStore(f.root), restarted = new WorkStore(restartedState);
    assert.deepEqual(restarted.get(f.job.id).operations, [operation]);
    assert.deepEqual(restarted.get(f.job.id).delivery, before.delivery);
    assert.equal(restarted.list({ accountId: 'owner', peerId: 'alice' }).length, 1);
    assert.equal(restarted.list({ accountId: 'different-owner' }).length, 0);
    assert.equal(new WorkStore(new StateStore(f.root)).get(f.job.id).operations[0].result.ok, ok);
  });
}

test('recognizing new operation names still rejects malformed results and unknown tools', t => {
  const f = fixture(t), original = JSON.parse(fs.readFileSync(f.work.file, 'utf8'));
  for (const operation of [{ tool: 'unregistered_tool', result: { ok: true } }, { tool: 'wechat_web_search', result: { ok: 'true' } }]) {
    const corrupt = structuredClone(original); corrupt.jobs[0].operations = [operation];
    fs.writeFileSync(f.work.file, JSON.stringify(corrupt));
    assert.throws(() => new WorkStore(f.state), { code: 'WORK_STATE_INVALID' });
  }
});
