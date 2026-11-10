import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerClient } from '../backend/wechat/worker-client.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-transfer-wait-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib/worker.cjs'), `
    let waiting;
    process.on('message', message => {
      if (message.type === 'cancel') {
        if (waiting?.id === message.id) { process.send({type:'result',id:message.id,ok:false,error:{code:'ERR_STOPPED',message:'cancelled',details:{delivery:'not-sent'}}}); waiting=null; }
        return;
      }
      if (message.op === 'send') waiting=message;
      else if (message.op === 'release') {
        if (waiting) process.send({type:'result',id:waiting.id,ok:true,value:{delivery:'server-ack',serverMessageId:'9007199254740999'}});
        waiting=null; process.send({type:'result',id:message.id,ok:true,value:{}});
      } else if (message.op === 'close') { process.send({type:'result',id:message.id,ok:true,value:{}}); process.disconnect(); }
    });
    process.send({type:'ready',status:{online:true}});
  `);
  const client = new WorkerClient(root, root, { executable: process.execPath });
  t.after(async () => {
    t.mock.timers.reset(); await client.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^wechat-transfer-wait-/); fs.rmSync(root, { recursive: true, force: true });
  });
  await client.ready;
  return client;
}

test('a complete transfer can wait beyond the former 200-second budget and still receive its real ACK once', async t => {
  const client = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transfer = client.send({});
  t.mock.timers.tick(200_001);
  await client.call('release');
  assert.equal((await transfer).serverMessageId, '9007199254740999');
  assert.equal(client.pending.size, 0);
});

test('explicit transfer deadlines and cancellation still stop waiting without claiming delivery', async t => {
  const client = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transfer = client.call('send', {}, { timeoutMs: 100 });
  const rejected = assert.rejects(transfer, error => error.code === 'WORKER_TIMEOUT' && error.details.delivery === 'unknown');
  t.mock.timers.tick(101); await rejected;
  assert.equal(client.pending.size, 0);
  const cancel = new AbortController(), pending = client.send({}, cancel.signal);
  cancel.abort();
  await assert.rejects(pending, error => error.code === 'ERR_STOPPED' && error.details.delivery === 'not-sent');
  assert.equal(client.pending.size, 0);
});
