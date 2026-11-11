import test from 'node:test';
import assert from 'node:assert/strict';
import {
  polishWorkResult
} from '../lib/testing.js';

async function polish(original, response) {
  const calls = [];
  const result = await polishWorkResult({ run: async input => { calls.push(input); return { text: response }; } },
    original, '查看这次工作的状态', new AbortController().signal);
  assert.equal(calls.length, 1, 'Status review must not add a model request');
  assert.deepEqual(calls[0].tools, []);
  return { ...result, input: JSON.parse(calls[0].text) };
}

for (const [name, original, changed] of [
  ['not started to complete', '请求已保存，尚未开始执行。', '工作已经全部完成。'],
  ['queued to running', '任务还在排队。', '任务正在执行。'],
  ['missing lookup to found', '没有查询到结果。', '已经查询到结果。'],
  ['not found to found colloquially', '我没查到相关资料。', '我查到了相关资料。'],
  ['awaiting delivery to sent', '文件已生成，等待回传。', '文件已发送到微信。'],
  ['awaiting receipt to confirmed', '图片已生成，等待微信回执。', '微信已确认送达。'],
  ['negation moved into a quotation', '任务尚未开始执行。', '“尚未开始执行”是之前的状态，任务已经完成。'],
  ['contradictory success appended', '文件已生成，等待回传。', '文件已生成，等待回传。文件已发送到微信。'],
  ['contradictory success behind a preamble', '文件已生成，等待回传。', '文件已生成，等待回传。好消息：文件已经送达微信。'],
]) test(`work polish retains authoritative status after ${name}`, async () => {
  const result = await polish(original, changed);
  assert.equal(result.text, original);
  assert.equal(result.polish.state, 'fallback');
  assert.match(result.polish.reason, /工作状态/u);
  assert(result.input.protectedStatus.length > 0);
});

test('work polish can simplify surrounding language while keeping the actual pending status', async () => {
  const original = '这次请求已保存，尚未开始执行。文件已生成，等待回传。';
  const response = '请求保存好了，尚未开始执行。文件已经生成，等待回传。';
  const result = await polish(original, response);
  assert.equal(result.polish.state, 'applied');
  assert.equal(result.text, response);
  assert.deepEqual(result.input.protectedStatus, ['尚未开始执行', '等待回传']);
});

for (const [original, response] of [
  ['如果任务尚未开始执行，可以撤销。', '任务还没开始时，可以撤销。'],
  ['没有查询到结果时，可以换个关键词。', '查无结果时，可以换个关键词。'],
  ['术语“尚未开始执行”描述状态机中的一个状态。', '“尚未开始执行”是状态机中的一个状态。'],
  ['文档解释了尚未开始执行和执行中两个状态。', '文档介绍了未开始与执行中两个状态。'],
]) test(`work polish does not treat explanatory wording as a live status: ${original}`, async () => {
  const result = await polish(original, response);
  assert.equal(result.polish.state, 'applied');
  assert.equal(result.text, response);
  assert.equal(result.input.protectedStatus, undefined);
});

test('work polish still preserves code without interpreting example states inside it', async () => {
  const original = '状态示例：\n```text\n任务尚未开始执行。\n```';
  const response = '示例状态如下：\n```text\n任务尚未开始执行。\n```';
  const result = await polish(original, response);
  assert.equal(result.polish.state, 'applied');
  assert.equal(result.input.protectedStatus, undefined);
});

for (const [original, changed] of [
  ['报告甲尚未开始执行，报告乙已经完成。', '报告甲已经完成，报告乙尚未开始执行。'],
  ['销售报告没有查到相关资料。', '培训报告没有查到相关资料。'],
  ['报告“A”尚未完成。', '报告“B”尚未完成。'],
  ['附件 `sales q.csv` 等待回传。', '附件 `salesq.csv` 等待回传。'],
  ['报告甲尚未完成，报告乙已经完成。', '报告甲尚未完成。报告甲已经完成。'],
  ['报告甲执行失败。', '报告甲已经完成。'],
  ['报告甲已取消。', '报告甲已经完成。'],
  ['附件发送失败。', '附件已发送到微信。'],
  ['附件回执不明。', '附件已收到微信回执。'],
  ['报告甲尚未完成。', '如果报告甲尚未完成，可以再处理。'],
]) test(`work polish binds protected status to its actual subject: ${original}`, async () => {
  const result = await polish(original, changed);
  assert.equal(result.polish.state, 'fallback'); assert.equal(result.text, original);
  assert(result.input.protectedFacts.length > 0);
});

test('ordinary formatting can improve without changing a named pending fact', async () => {
  const original = '当前结果如下：\n- **报告甲** 尚未完成。\n文件已经生成。';
  const result = await polish(original, '报告甲尚未完成。文件已经生成。');
  assert.equal(result.polish.state, 'applied');
  assert.equal(result.text, '报告甲尚未完成。文件已经生成。');
});

for (const [original, response] of [
  ['报告甲尚未开始执行，报告乙已经完成。', '报告甲还没开始，报告乙已经完成。'],
  ['销售报告没有查到相关资料。', '销售报告没查到相关资料。'],
  ['附件 `sales q.csv` 还在排队。', '附件 `sales q.csv` 仍在排队。'],
]) test(`known equivalent status wording can remain natural: ${original}`, async () => {
  const result = await polish(original, response);
  assert.equal(result.polish.state, 'applied'); assert.equal(result.text, response);
});

for (const [original, changed] of [
  ['报告甲尚未开始执行。', '报告甲还没完成。'],
  ['报告甲尚未完成。', '报告甲还没开始。'],
  ['销售报告没有查到相关资料。', '销售报告没查到相关记录。'],
  ['报告甲尚未开始执行，报告乙已经完成。', '报告乙还没开始，报告甲已经完成。'],
]) test(`status equivalence never drops phases, subjects or lookup objects: ${original}`, async () => {
  const result = await polish(original, changed);
  assert.equal(result.polish.state, 'fallback'); assert.equal(result.text, original);
});
