import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, WechatRuntime } from '../lib/testing.js';

const base = path.resolve('storage/tmp');
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'runtime-startup-'));
  const store = new StateStore(root), scope = { accountId: 'startup-owner', chatType: 'private', peerId: 'alice' };
  store.configure(scope.accountId, { enabled: false, groups: [], privatePeers: [], prompt: '' });
  store.data.authorizationRevocations.push(scope); store.save();
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib/worker.cjs'), `
    process.on('message', message => {
      if (message.type === 'release-ready') process.send({type:'ready',status:{online:false,runtimeReady:true}});
      if (message.type === 'fail-start') process.exit(1);
      if (message.op === 'close') { process.send({type:'result',id:message.id,ok:true,value:{}}); process.disconnect(); }
    });
    process.on('disconnect', () => process.exit(0));
  `);
  const runtime = new WechatRuntime({ ctx: {}, root, bootstrap: root, resources: root,
    ownerLock: { worker() {} }, signal: new AbortController().signal });
  t.after(async () => {
    await runtime.close();
    const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(base));
    assert(path.basename(target).startsWith('runtime-startup-')); fs.rmSync(target, { recursive: true, force: true });
  });
  return { runtime, root };
}

test('runtime waits for the worker handshake before loading archives and resuming cleanup', async t => {
  const { runtime, root } = fixture(t), ready = runtime.ready();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(new StateStore(root).data.authorizationRevocations.length, 1, 'cleanup must not compete with the worker readiness deadline');
  runtime.worker.child.send({ type: 'release-ready' });
  await ready;
  assert.equal(runtime.worker.status().runtimeReady, true);
  assert.equal(runtime.channel.authorization.error, null);
  assert.deepEqual(new StateStore(root).data.authorizationRevocations, []);
});

test('worker startup failure leaves cleanup pending and shutdown reaps the child', async t => {
  const { runtime, root } = fixture(t);
  const rejected = assert.rejects(runtime.ready(), { code: 'WORKER_OFFLINE' });
  runtime.worker.child.send({ type: 'fail-start' });
  await rejected; await runtime.close();
  assert.equal(new StateStore(root).data.authorizationRevocations.length, 1);
  assert.notEqual(runtime.worker.child.exitCode, null);
});
