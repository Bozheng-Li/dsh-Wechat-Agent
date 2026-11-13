import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachExecutionTraces } from '../modules/traces/instrument.mjs';
import { currentTrace, withTrace } from '../modules/traces/context.mjs';
import { identity } from '../backend/storage/keys.mjs';
import { traceState } from '../shared/execution-traces.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-traces-instrument-'));
  const rule = {}, channel = { now: Date.now,
    store: { root, data: { storeId: 'trace-observation-fixture', records: [] },
      settings: () => ({ enabled: true, privatePeers: ['alice'], groups: ['fixture-group'] }),
      add(record) { this.data.records.push(record); return record; },
      update(record, patch) { Object.assign(record, patch); return record; },
    },
    transport: { status: () => ({ account: { id: 'fixture-account' } }),
      send: async () => ({ delivery: 'unknown' }), readMoments: async () => ({ items: [] }),
      writeMoments: async () => ({ delivery: 'server-ack', postId: 'fixture-post' }),
    },
    work: { store: { data: { jobs: [] } } },
    memory: { errors: new Map() }, memoryRetries: new Map(),
    async processMemory(scope) { this.memoryRetries.set(identity([scope.accountId, scope.chatType, scope.peerId]), { kind: 'extraction', attempts: 1 }); },
    async process({ record }) { await this.transport.send({ accountId: record.accountId }); this.store.update(record, { state: 'unknown', reason: '未收到确认' }); },
    submitScheduled(task) { return Promise.reject(Object.assign(new Error('回复队列暂不可用'), { code: 'TASK_QUEUE_FULL' })); },
    momentsAutomation: { rule: () => rule,
      async run() { rule.lastRun = { state: 'partial', attempted: 2, replied: 1 }; rule.lastError = '一条评论未完成'; },
      publishing: { data: { runs: {} }, operation(accountId, planId, signal, work) { return work(); },
        async generate(run) { run.state = 'draft'; },
        async submit(run) { run.state = 'unknown'; run.error = '未收到确认'; },
      },
      likes: { async run(accountId, rule, run) { run.state = 'cancelled'; run.error = '设置已改变'; } },
    },
  };
  attachExecutionTraces(channel);
  t.after(async () => {
    await channel.traces.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert(path.basename(root).startsWith('wechat-traces-instrument-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return channel;
}

test('captured conversation follows the real record and shows native send uncertainty', async t => {
  const channel = fixture(t), record = { key: 'message-1', accountId: 'fixture-account', createdAt: Date.now(), state: 'queued', question: '测试输入' };
  channel.store.add(record); await channel.process({ record });
  const list = await channel.traces.list(record.accountId);
  assert.equal(list.total, 1); assert.equal(list.items[0].state, 'unknown'); assert.equal(list.items[0].coverage, 'recorded');
  const detail = await channel.traces.get(record.accountId, list.items[0].id);
  assert.equal(detail.steps.find(step => step.title === '微信发送与回执').state, 'unknown');
  const older = { ...record, key: 'earlier', createdAt: Date.now() - 3600000 };
  channel.store.data.records.push(older); channel.store.update(older, { state: 'sent' });
  assert.equal((await channel.traces.list(record.accountId)).items.find(row => row.sourceKey === 'record:earlier').coverage, 'partial');
});

test('background tasks that handle errors internally retain their saved final state', async t => {
  const channel = fixture(t), accountId = 'fixture-account';
  await channel.momentsAutomation.run(accountId, {});
  await channel.momentsAutomation.likes.run(accountId, {}, { accountId, state: 'running' });
  await channel.processMemory({ accountId, chatType: 'group', peerId: 'fixture-group' });
  const list = await channel.traces.list(accountId);
  assert.equal(list.items.find(row => row.title === '朋友圈自动回复').state, 'partial');
  assert.equal(list.items.find(row => row.title === '朋友圈定时点赞').state, 'cancelled');
  assert.equal(list.items.find(row => row.type === 'memory').state, 'failed');
});

test('a scheduled attempt rejected before creating a chat record still retains the failure', async t => {
  const channel = fixture(t);
  await assert.rejects(channel.submitScheduled({ accountId: 'fixture-account', id: 'task-1', recordKey: 'scheduled-run-1', content: '定时提醒', schedule: { kind: 'once' } }), { code: 'TASK_QUEUE_FULL' });
  const list = await channel.traces.list('fixture-account');
  assert.equal(list.total, 1); assert.equal(list.items[0].type, 'scheduled'); assert.equal(list.items[0].state, 'failed');
  assert.equal(channel.store.data.records.length, 0);
});

test('scheduled publication captures generation and final submission as one operation', async t => {
  const channel = fixture(t), publishing = channel.momentsAutomation.publishing, accountId = 'fixture-account';
  await publishing.operation(accountId, 'fixture-plan', undefined, async () => {
    const run = { id: 'fixture-run', accountId, state: 'generating' }; publishing.data.runs[run.id] = run;
    await publishing.generate(run); await channel.transport.readMoments({ accountId });
    await publishing.submit(run);
  });
  const list = await channel.traces.list(accountId);
  assert.equal(list.total, 1); assert.equal(list.items[0].state, 'unknown');
  const detail = await channel.traces.get(accountId, list.items[0].id);
  assert(detail.steps.some(step => step.title.includes('readMoments')));
  assert(detail.steps.some(step => step.kind === 'stage' && step.state === 'unknown'));
});

test('an unavailable observer never duplicates or fails an already performed action', async t => {
  const channel = fixture(t), publishing = channel.momentsAutomation.publishing;
  let count = 0;
  publishing.data = null; // An observation pre-read fails; the authorized operation still executes once.
  const value = Promise.resolve('original-result');
  assert.equal(publishing.operation('fixture-account', null, null, () => { count++; return value; }), value);
  assert.equal(await value, 'original-result'); assert.equal(count, 1);
  const context = channel.traces.task({ accountId: 'fixture-account', type: 'work', title: '上下文隔离' });
  withTrace(context, () => withTrace(null, () => assert.equal(currentTrace(), undefined)));
});

test('a skipped conversation record keeps the rule that fired instead of a bare label', async t => {
  const channel = fixture(t), record = { key: 'skip-1', accountId: 'fixture-account', createdAt: Date.now(), state: 'queued', question: '测试输入' };
  channel.store.add(record);
  channel.store.update(record, { state: 'skipped', reason: '群消息未 @ 当前账号' });
  const [row] = (await channel.traces.list('fixture-account')).items;
  assert.equal(row.state, 'skipped'); assert.equal(row.reason, '群消息未 @ 当前账号');
  assert.equal((await channel.traces.list('fixture-account', { preset: 'meaningful' })).hidden.skipped, 1);
});

test('explicit partial, cancelled and unverified receipts are not mislabeled as success or failure', () => {
  assert.equal(traceState({ state: 'partial', error: 'one part failed' }), 'partial');
  assert.equal(traceState({ state: 'cancelled', error: 'stopped' }), 'cancelled');
  assert.equal(traceState({ state: 'published-unverified' }), 'unknown');
  assert.equal(traceState(undefined, { code: 'CANCELLED', details: { snsDelivery: 'unknown' } }), 'unknown');
});
