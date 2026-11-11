import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWechatPrompt, personaFromPreset, progressiveDialogueFocus, planProgressiveTools, capabilityCatalog, replyMemoryContext
} from '../lib/testing.js';






test('quoted identity questions do not turn a translation into an identity answer', () => {
  const focus = progressiveDialogueFocus({ requestText: '把“你叫什么名字？”翻成英文，只输出译文。', preference: { value: 'help' } });
  assert(focus.includes('只要答案就只给答案'));
  assert(!focus.includes('回答所问的身份信息'));
  assert(!progressiveDialogueFocus({ requestText: '分析下面的对白：\n> 你是真人还是AI？', preference: { value: 'help' } })
    .includes('回答所问的身份信息'));
});

test('current help overrides a previous chat choice without losing custom style or fixed boundaries', () => {
  const now = new Date('2026-11-10T04:00:00Z');
  const persona = { ...personaFromPreset(), prompt: '用温和的书面语交流；我的自定义设定必须保留。' };
  const prompt = '最后一行必须单独写“已毕”。';
  const result = buildWechatPrompt({ persona, prompt, promptStrategy: 'progressive-v1', now,
    history: [{ key: 'earlier', senderId: 's', direction: 'incoming', time: +now - 1000, text: '只想聊天，不要建议。' }],
    speaker: { id: 's' }, requestText: '现在请给我三个处理步骤。' });
  assert(result.includes('对方明确求助，交付能用的回答'));
  assert(!result.includes('这是接话，不是咨询'));
  assert(result.includes(persona.prompt));
  assert(result.indexOf('本轮回应重点') < result.indexOf('管理员固定输出约定'));
  assert(result.includes(prompt));
});

test('deferred memory still tells the model to load and query before claiming missing records', () => {
  const plan = planProgressiveTools([{ name: 'wechat_memory', execute() {} }], '我的资料编号是多少？');
  assert.equal(plan.initial.length, 0);
  const catalog = capabilityCatalog(plan.deferredGroups, () => {});
  assert(catalog.description.includes('先加载并查询'));
  assert(catalog.description.includes('未查询不能声称没有记录'));
  assert(catalog.parameters.properties.modules.items.enum.includes('memory'));
  assert.deepEqual(planProgressiveTools([], '我的资料编号是多少？').deferredGroups, []);
});

test('specialized delivery modes do not acquire an ordinary dialogue focus', () => {
  for (const mode of ['confirmation', 'scheduled'])
    assert.equal(progressiveDialogueFocus({ requestText: '帮我列一个计划', mode }), '');
});

test('sharing an older experience does not become a memory query or a recall report', () => {
  const sharing = progressiveDialogueFocus({ requestText: '以前养的那盆花今天又长新叶了。' });
  assert(!sharing.includes('问的是旧事'));
  const recall = progressiveDialogueFocus({ requestText: '上回我说想去哪里来着？' });
  assert(recall.includes('回答旧事本身'));
});

test('clipped image notes do not erase explicit chat preferences when the message text is complete', () => {
  const now = new Date('2026-11-10T04:00:00Z');
  const snapshot = { entries: [{ key: 'photo-chat', senderId: 's', direction: 'incoming', time: +now - 1000,
    text: '只想聊天，别给建议。', attachments: [{ type: 'image', description: '普通风景。'.repeat(100) }] }] };
  const context = replyMemoryContext({ snapshot, text: '再随便说点', promptStrategy: 'progressive-v1', onDemand: true });
  assert.equal(context.history[0].contextOmitted, true);
  assert.equal(context.history[0].contextTextOmitted, false);
  const result = buildWechatPrompt({ persona: personaFromPreset(), now, history: context.history,
    requestText: '再随便说点', speaker: { id: 's' }, promptStrategy: 'progressive-v1' });
  assert(result.includes('当前发言者在刚才这段对话中明确选择了只聊天'));
  assert(result.includes('这是接话，不是咨询'));
});
