import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionTraces } from '../modules/traces/store.mjs';
import { recordSpec } from '../modules/traces/records.mjs';

const at = Date.parse('2026-11-11T02:00:00.000Z');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-traces-skip-'));
  let time = at;
  const source = { root, data: { storeId: 'test-skip-store' } };
  const store = new ExecutionTraces(source, { now: () => time });
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert(path.basename(root).startsWith('wechat-traces-skip-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, store, advance: ms => time += ms };
}
const spec = (key, extra = {}) => ({ key, accountId: 'owner-a', type: 'conversation', title: '会话回复', input: { question: '你好' }, ...extra });

test('a skipped row persists its reason and returns it from list and get', async t => {
  const { store, source } = setup(t);
  const skipped = store.task(spec('skip-group', { state: 'skipped', reason: '群消息未 @ 当前账号' }));
  assert.equal(skipped.row.reason, '群消息未 @ 当前账号');
  const late = store.task(spec('skip-late'));
  store.update(late, { state: 'skipped', reason: '私聊已关闭自动回复' });
  await store.flush();
  const listing = await store.list('owner-a');
  assert.equal(listing.items.find(row => row.sourceKey === 'skip-group').reason, '群消息未 @ 当前账号');
  assert.equal(listing.items.find(row => row.sourceKey === 'skip-late').reason, '私聊已关闭自动回复');
  const detail = await store.get('owner-a', late.row.id);
  assert.equal(detail.trace.reason, '私聊已关闭自动回复');
  const reopened = new ExecutionTraces(source, { now: () => at + 1000 });
  try {
    const saved = await reopened.list('owner-a');
    assert.equal(saved.items.find(row => row.sourceKey === 'skip-group').reason, '群消息未 @ 当前账号');
    assert.equal(saved.items.find(row => row.sourceKey === 'skip-late').reason, '私聊已关闭自动回复');
  } finally { await reopened.close(); }
});

test('a skipped row only carries a short reason that names the rule, never a generic label', async t => {
  const { store } = setup(t);
  const long = store.task(spec('skip-long', { state: 'skipped', reason: '这是一段明显超过四十个字符的跳过说明，用来确认轨迹只保存简短的具体原因而不是整段文字' }));
  assert(long.row.reason.length <= 40);
  const quiet = store.task(spec('skip-quiet'));
  store.update(quiet, { state: 'completed', reason: '等待期间的新一轮群聊已合并' });
  assert.equal(quiet.row.reason, undefined);
  store.update(quiet, { state: 'skipped', output: { skipped: true, reason: '命中免打扰时段，本轮不回复' } });
  assert.equal(quiet.row.reason, '命中免打扰时段，本轮不回复');
});

test('preset meaningful hides only zero-work skips and reports what it hid', async t => {
  const { store, advance } = setup(t);
  store.task(spec('skipped-idle', { state: 'skipped', reason: '群消息未 @ 当前账号' }));
  const worked = store.task(spec('skipped-model', { state: 'skipped', reason: '模型判断本轮不发言' }));
  store.startStep(worked, { kind: 'model', title: '判断是否参与聊天' })?.end({ output: { action: 'skip' } });
  const completed = store.task(spec('done'));
  store.startStep(completed, { kind: 'tool', title: '读取聊天记录' })?.end({ output: { ok: true } });
  advance(20); store.update(completed, { state: 'completed', output: '已回复' });
  const all = await store.list('owner-a', { preset: 'all' });
  assert.equal(all.total, 3); assert.deepEqual(all.hidden, { skipped: 0 }); assert.equal(all.summary.skipped, 2);
  const meaningful = await store.list('owner-a', { preset: 'meaningful' });
  assert.equal(meaningful.total, 2); assert.deepEqual(meaningful.hidden, { skipped: 1 });
  assert.deepEqual(meaningful.items.map(row => row.sourceKey).sort(), ['done', 'skipped-model']);
  assert.equal(meaningful.summary.skipped, 2);
  assert.equal((await store.list('owner-a')).hidden.skipped, 0, 'the default preset keeps every row');
});

test('state skipped and type filters still select exactly the skipped rows', async t => {
  const { store } = setup(t);
  store.task(spec('chat-skip', { state: 'skipped', reason: '内容为空，未交给模型' }));
  store.task({ ...spec('media-skip', { state: 'skipped', reason: '微信组件暂不支持读取表情原图' }), type: 'media' });
  store.task(spec('chat-done'));
  store.update(store.task(spec('chat-done')), { state: 'completed' });
  const skipped = await store.list('owner-a', { state: 'skipped' });
  assert.equal(skipped.total, 2); assert(skipped.items.every(row => row.state === 'skipped'));
  assert.equal(skipped.summary.skipped, 2);
  const media = await store.list('owner-a', { state: 'skipped', type: 'media' });
  assert.equal(media.total, 1); assert.equal(media.items[0].reason, '微信组件暂不支持读取表情原图');
  assert.equal(media.summary.skipped, 1);
  const conversation = await store.list('owner-a', { type: 'conversation', preset: 'meaningful' });
  assert.equal(conversation.hidden.skipped, 1, 'hidden counts only what the asked-for type contained');
  assert.equal(conversation.summary.skipped, 1);
});

test('list items carry what a row needs without a second fetch', async t => {
  const { store, advance } = setup(t);
  const context = store.task(spec('row-shape', { state: 'skipped', reason: '发言人是自己，未生成回复' }));
  store.startStep(context, { kind: 'model', title: '读取上下文' })?.end({ output: 'ok' });
  store.startStep(context, { kind: 'tool', title: '读取图片' })?.end({ output: { ok: true } });
  advance(250); store.update(context, { state: 'skipped', reason: '发言人是自己，未生成回复' });
  const [row] = (await store.list('owner-a', { state: 'skipped' })).items;
  assert.equal(row.type, 'conversation'); assert.equal(row.state, 'skipped'); assert.equal(row.title, '会话回复');
  assert.equal(row.modelCalls, 1); assert.equal(row.toolCalls, 1);
  assert.equal(row.durationMs, 250); assert.equal(row.reason, '发言人是自己，未生成回复');
  assert.equal(row.createdAt, at); assert.equal(row.startedAt, at); assert.equal(row.finishedAt, at + 250);
});

test('unknown presets are rejected instead of silently defaulting', async t => {
  const { store } = setup(t);
  store.task(spec('preset-invalid'));
  await assert.rejects(store.list('owner-a', { preset: 'only-real' }), { code: 'TRACE_FILTER_INVALID' });
  await assert.rejects(store.list('owner-a', { preset: null }), { code: 'TRACE_FILTER_INVALID' });
});

test('a media action that skips before doing any work still explains why', async t => {
  const { store } = setup(t);
  await store.run({ key: 'media-skip', accountId: 'owner-a', type: 'media', title: '保存聊天表情原图' },
    () => ({ skipped: true, reason: '该聊天未启用表情收集，或不是可收集的表情消息' }));
  const [row] = (await store.list('owner-a', { state: 'skipped' })).items;
  assert.equal(row.type, 'media'); assert.equal(row.reason, '该聊天未启用表情收集，或不是可收集的表情消息');
  assert.equal(row.modelCalls, 0); assert.equal(row.toolCalls, 0);
  assert.equal((await store.list('owner-a', { preset: 'meaningful' })).hidden.skipped, 1);
});

test('conversation records hand their saved skip reason to the trace row', async t => {
  const item = recordSpec({ key: 'message-9', accountId: 'owner-a', chatType: 'group', peerId: 'room', mode: 'participate',
    state: 'skipped', reason: '等待回复的消息过多，本轮群聊未进入队列', createdAt: at });
  assert.equal(item.state, 'skipped'); assert.equal(item.reason, '等待回复的消息过多，本轮群聊未进入队列');
  const finished = recordSpec({ key: 'message-10', accountId: 'owner-a', chatType: 'private', peerId: 'alice', state: 'sent', reason: '等待期间的新一轮群聊已合并' });
  assert.equal(finished.reason, undefined, 'a reason only rides along with a skipped row');
});
