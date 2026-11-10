import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshAgentRunner, StateStore, WechatChannel } from '../lib/testing.js';

function fixture(responses, onResponse) {
  const options = [], messages = [], events = [];
  let calls = 0, pending;
  const create = async input => {
    options.push(input);
    const session = { get seq() { return events.length; }, snapshotEvents: from => events.slice(from) };
    return { agent: { session, followup(message) {
      messages.push(message);
      pending = (async () => {
        const index = calls++, response = responses[Math.min(index, responses.length - 1)];
        events.push({ type: 'assistant/message', data: { turn: index + 1,
          message: { content: typeof response === 'string' ? [{ type: 'text', text: response }] : response.blocks } } });
        events.push({ type: 'turn/end', data: { turn: index + 1, reason: response.reason ?? { kind: 'completed' } } });
        await onResponse?.(index);
      })();
    }, whenIdle: async () => { await pending; }, cancel() {} }, dispose: async () => {} };
  };
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'first' }) },
    agents: { create, resume: create } };
  const runner = new DshAgentRunner(ctx);
  return { runner, options, messages, calls: () => calls };
}

test('a completed whitespace-only response retries once in the same model session and returns only final public text', async () => {
  const f = fixture([' ', '<think>PRIVATE_REASONING</think>确实有人通关，第二关难度很高。']);
  const result = await f.runner.run({ text: '真的有人能过羊了个羊吗？', signal: new AbortController().signal });
  assert.equal(result.text, '确实有人通关，第二关难度很高。');
  assert.equal(result.emptyResponseRetries, 1);
  assert.equal(f.calls(), 2); assert.equal(f.options.length, 1);
  assert.notEqual(f.messages[0].id, f.messages[1].id);
  assert.deepEqual(f.messages[1].content.slice(0, -1), f.messages[0].content);
  assert.match(f.messages[1].content.at(-1).text, /尚未发送/);
});

test('continued empty output is a bounded failure; hidden reasoning is never used as a reply', async () => {
  const f = fixture(['<think>PRIVATE_REASONING</think>']);
  await assert.rejects(f.runner.run({ text: '问题', signal: new AbortController().signal }), error => {
    assert.equal(error.code, 'MODEL_EMPTY'); assert.match(error.message, /正文|空白/);
    assert.doesNotMatch(error.message, /PRIVATE_REASONING/); return true;
  });
  assert.equal(f.calls(), 2);
});

test('a completed tool turn cannot be replayed to recover an empty final answer', async () => {
  const f = fixture([{ blocks: [{ type: 'tool-call', id: 'created-task', name: 'wechat_task', arguments: '{}' }] }]);
  await assert.rejects(f.runner.run({ text: '设置提醒', signal: new AbortController().signal }), { code: 'MODEL_EMPTY' });
  assert.equal(f.calls(), 1);
});

test('transport failures and output limits never retry a partial reply as an empty response', async () => {
  for (const reason of [{ kind: 'error', error: { code: 'TRANSPORT' } }, { kind: 'max-tokens' }, { kind: 'aborted' }]) {
    const f = fixture([{ blocks: [{ type: 'text', text: '部分回复' }], reason }]);
    await assert.rejects(f.runner.run({ text: '问题', signal: new AbortController().signal }), { code: 'MODEL_INCOMPLETE' });
    assert.equal(f.calls(), 1);
  }
});

test('intentional media-only output and invalid delivery selectors do not trigger recovery requests', async () => {
  const f = fixture([' ']);
  assert.equal((await f.runner.run({ text: '只发图片', allowEmptyReply: true, signal: new AbortController().signal })).text, '');
  assert.equal(f.calls(), 1);
  const invalid = fixture(['完整正文']);
  await assert.rejects(invalid.runner.run({ text: '问题', selectReplyText: () => null,
    signal: new AbortController().signal }), { code: 'MODEL_EMPTY' });
  assert.equal(invalid.calls(), 1);
});

test('cancellation after the empty response stops before a second model request', async () => {
  const controller = new AbortController(), reason = new Error('owner cancelled');
  const f = fixture([' '], () => controller.abort(reason));
  await assert.rejects(f.runner.run({ text: '问题', signal: controller.signal }), error => error === reason);
  assert.equal(f.calls(), 1);
});

test('the WeChat channel sends exactly one acknowledged reply after recovery and sends nothing on repeated emptiness', async t => {
  const base = fs.realpathSync(os.tmpdir());
  for (const recover of [true, false]) {
    const root = fs.mkdtempSync(path.join(base, 'wechat-empty-recovery-'));
    const store = new StateStore(root), account = { id: 'empty-owner' }, sent = [];
    store.configure(account.id, { enabled: true, groups: [], privatePeers: ['friend'], prompt: '' });
    const f = fixture(recover ? [' ', '完整回答。'] : [' ']);
    f.runner.extractLongTermMemory = undefined;
    const transport = { status: () => ({ online: true, account }), send: async input => {
      assert.equal(f.calls(), 2); sent.push(input);
      return { delivery: 'server-ack', serverMessageIds: ['verified-ack'] };
    } };
    const channel = new WechatChannel({ store, transport, runner: f.runner });
    t.after(async () => { await channel.close(); const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), base); fs.rmSync(resolved, { recursive: true, force: true }); });
    channel.receive({ id: 'empty-message', serverMessageId: '42', direction: 'incoming', time: Math.floor(Date.now() / 1000),
      chatType: 'private', peerId: 'friend', sender: { id: 'friend' }, message: [{ type: 'text', data: { text: '问题' } }] }, account.id);
    await channel.whenIdle();
    assert.equal(f.calls(), 2); assert.equal(sent.length, recover ? 1 : 0);
    assert.equal(store.data.records[0].state, recover ? 'sent' : 'failed');
    if (recover) assert.equal(store.data.records[0].reply, '完整回答。');
  }
});
