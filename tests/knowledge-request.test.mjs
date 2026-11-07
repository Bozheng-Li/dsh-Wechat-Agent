import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeRequest } from '../src/features/knowledge/request.mjs';

const positive = [
  ['/kb 退款期限', '退款期限'], ['/知识库：退款期限', '退款期限'], ['/agent /kb 退款期限', '退款期限'],
  ['查知识库：退款期限', '退款期限'], ['请查知识库里的退款期限', '退款期限'], ['帮我查一下知识库：退款期限', '退款期限'],
  ['根据知识库回答：退款期限', '退款期限'], ['请从知识库查一下退款期限', '退款期限'], ['去知识库查找退款期限', '退款期限'],
  ['请查询我们的知识库：退款期限', '退款期限'], ['退款期限，查知识库', '退款期限'], ['查知识库：“退款期限”', '“退款期限”'],
  ['please search the knowledge base for refund policy', 'refund policy'], ['consult our knowledge base: refund policy', 'refund policy'],
  ['could you search the knowledge base for refund policy', 'refund policy'], ['小胖，请查知识库：退款期限', '小胖 退款期限'],
];
test('knowledge requests preserve the explicit subject without asking a model to rewrite it', () => {
  for (const [text, query] of positive) assert.deepEqual(knowledgeRequest(text), { requested: true, command: text.startsWith('/'), query }, text);
  assert.deepEqual(knowledgeRequest('/kb'), { requested: true, command: true, query: '' });
});

const negative = [
  '退款期限是多少？', '这个产品怎么用', '我们做个知识库吧', '知识库的 RAG 链路有问题吗', '知识库里有哪些文档',
  '不要查知识库，直接回答', '不用搜索知识库', '别去知识库查询退款', '不查知识库', "don't search the knowledge base",
  '请翻译：查知识库：退款期限', '解释 /kb 退款期限 的意思', '如果查知识库能找到吗', '怎么查知识库', '如何从知识库查资料',
  '查知识库的功能为什么报错', '查知识库失败怎么办', '请润色这句话：查知识库退款期限',
  '“查知识库：退款期限”', '「查知识库：退款期限」', '『查知识库：退款期限』', '"search the knowledge base for refund policy"',
  '`/kb 退款期限`', '```\n/kb 退款期限\n```', '> /kb 退款期限', '> 查知识库退款期限\n你解释一下这条命令',
  '转发：查知识库：退款期限', '他说查知识库：退款期限', '文档要求查知识库的价格', '图片里写着查知识库退款期限',
  '上次让你查知识库的结果呢', '昨天查知识库了吗', 'This is an example: search the knowledge base for refund policy',
  '“请查知识库：退款期限', '```text\n查知识库退款期限',
  '我刚查知识库没找到', '我已经查知识库了', '他们建议查知识库', '模型说可以查知识库', '比如：查知识库退款期限',
  '什么时候查知识库比较好', '你会查知识库吗', '查知识库要收费吗', '查知识库是不是很耗费 token',
];
test('ordinary chat, refusals, quotations, examples, forwarded text and history cannot authorize a knowledge search', () => {
  for (const text of negative) assert.deepEqual(knowledgeRequest(text), { requested: false, query: '' }, text);
});

test('configured names grant no consent to negations, quotations or discussion of the command', () => {
  for (const text of ['胖胖查知识库：退款期限', '胖胖，查知识库：退款期限', 'Ann, search the knowledge base for 退款期限'])
    assert.deepEqual(knowledgeRequest(text, ['胖胖', 'Ann']), { requested: true, command: false, query: '退款期限' }, text);
  for (const text of ['胖胖不要查知识库', '胖胖“查知识库：退款期限”', '胖胖请翻译：查知识库退款期限', 'Anna search the knowledge base for refund', 'Annabelle search the knowledge base for refund'])
    assert.deepEqual(knowledgeRequest(text, ['胖胖', 'Ann']), { requested: false, query: '' }, text);
});

test('a command discussed as words or a feature is not a retrieval request', () => {
  for (const text of ['查知识库这几个字怎么翻译', '查知识库这句怎么说', '查知识库这个词怎么翻译', '查知识库能做吗'])
    assert.deepEqual(knowledgeRequest(text), { requested: false, query: '' }, text);
});
