import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWechatPrompt, applyFixedReplyBoundaries, personaFromPreset, DEFAULT_AGENT_IDENTITY
} from '../lib/testing.js';



const now = new Date('2026-11-10T04:00:00Z');
const common = () => ({ persona: personaFromPreset(), now, requestText: '今天收拾好了桌子。' });
const progressive = options => buildWechatPrompt({ ...common(), ...options, promptStrategy: 'progressive-v1' });
const capabilities = ['wechat_web_search', 'wechat_memory', 'wechat_read_image', 'wechat_image_memory',
  'wechat_reply_media', 'wechat_task'].map(name => ({ name }));

test('progressive is opt-in and a misspelled strategy cannot silently change the existing contract', () => {
  const options = { ...common(), capabilities, prompt: '第一行必须单独写“您好”。' };
  const legacy = buildWechatPrompt(options);
  assert.equal(buildWechatPrompt({ ...options, promptStrategy: 'legacy' }), legacy);
  assert.equal(buildWechatPrompt({ ...options, promptStrategy: 'unknown' }), legacy);
  assert.notEqual(progressive(options), legacy);
});

test('default public prompts have a bounded fixed cost without removing identity, facts or delivery rules', () => {
  for (const requestText of ['你好', '今天收拾好了桌子。']) {
    const options = { ...common(), requestText, capabilities };
    const text = progressive(options);
    assert(text.length >= 1500 && text.length <= 2500, `${requestText}: ${text.length} characters`);
    assert(text.length < buildWechatPrompt(options).length / 2);
    for (const requirement of ['当前授权会话', '微信回执', '提交不等于成功', '最新明确更正优先',
      '被直接问是否 AI 时如实简短回答', '只输出最终正文', '数量、单位和事情进度']) assert(text.includes(requirement), requirement);
    assert(text.includes('配置名字："微信助手"'));
    assert(!text.includes(DEFAULT_AGENT_IDENTITY));
  }
});

test('only shipped persona examples can be reduced; the relevant greeting has at most one example', () => {
  const greeting = progressive({ requestText: '你好' });
  const ordinary = progressive({ requestText: '今天收拾好了桌子。' });
  assert.equal((greeting.match(/本轮语气示例/g) || []).length, 1);
  assert(!greeting.includes('当前时间：'));
  assert(!greeting.includes('这下桌子干净了，笔也藏好了'));
  assert(!ordinary.includes('本轮语气示例'));
  assert(ordinary.includes('时区 Asia/Shanghai'));
});

test('custom persona, identity, account requirements and owner notes remain complete even beyond the target budget', () => {
  const customPersona = '自由人设原文\r\n' + '有意保留的自定义内容。'.repeat(300) + '\r\n语气示例：一个也不能裁。';
  const identity = '# 全局身份原文\r\n第一行必须单独写“固定开场”。\r\n身份尾部。';
  const account = '账号原文\r\n最后一行必须单独写“固定结尾”。';
  const notes = '已确认关系：小明是老师。\r\n回答时保留这份背景。';
  const text = progressive({ persona: { name: '完整名字', aliases: ['别名甲'], prompt: customPersona },
    identityMarkdown: identity, prompt: account, adminNotes: notes });
  for (const original of [customPersona, identity, account, notes]) assert(text.includes(original));
  assert(text.length > 2500, 'the size target must never truncate owner-authored settings');
  assert(text.includes('配置名字："完整名字"'));
  assert(text.includes('接受别名：["别名甲"]'));
  assert.equal(applyFixedReplyBoundaries('正文', { prompt: account, identityMarkdown: identity }), '固定开场\n正文\n固定结尾');
});

test('a one-field edit makes the entire saved structured persona custom', () => {
  const persona = personaFromPreset();
  persona.background += '\n管理员增补：住在月亮图书馆。';
  const text = progressive({ persona, requestText: '你好' });
  for (const key of ['background', 'personality', 'style']) assert(text.includes(persona[key]), key);
  assert(!text.includes('本轮语气示例（只学习分寸'));
});

test('natural decision retains its exact JSON contract and keeps fixed text inside the reply field', () => {
  const decision = { trigger: 'followup', temperament: 'quiet' };
  const account = '第一行必须单独写“你好”。';
  const text = progressive({ mode: 'natural', naturalDecision: decision, prompt: account });
  assert(text.includes('只输出一个 JSON 对象'));
  assert(text.includes('{"action":"reply","text":"完整的可发送正文"}'));
  assert(text.includes('skip 不生成正文或署名'));
  assert(text.includes('管理员的语言、固定开头、结尾和署名只应用于 reply 的 text 字段'));
  assert(text.indexOf('最外层必须是 JSON 对象') > text.indexOf(account));
  const confirmation = progressive({ mode: 'confirmation', systemOverride: '只输出确认协议 CONFIRM_V1' });
  assert(confirmation.includes('只输出确认协议 CONFIRM_V1'));
});

test('internal modes and work dialogue retain exactly their established isolation and specialized contracts', () => {
  for (const mode of ['memory', 'long-memory', 'vision', 'workbench', 'remote-intent', 'work-result',
    'work-progress', 'work-routing', 'moments-reply', 'moments-publish', 'work-dialogue']) {
    const options = { ...common(), mode, systemOverride: '内部合同原文', prompt: '账号原文',
      adminNotes: '管理员备注', workContext: { capacity: { maxConcurrent: 2 } } };
    assert.equal(progressive(options), buildWechatPrompt(options), mode);
  }
});

test('explicit and recent chat preference retain speaker boundaries and new requests can change intent', () => {
  const history = [{ senderId: 'alice', direction: 'incoming', time: now.getTime() - 60_000,
    text: '只想聊天，别给建议。' }];
  assert(progressive({ requestText: '只想聊天，别给建议。' }).includes('本轮对方明确选择闲聊'));
  assert(progressive({ history, speaker: { id: 'alice' } }).includes('当前发言者在刚才这段对话中明确选择了只聊天'));
  assert(!progressive({ history, speaker: { id: 'bob' } }).includes('当前发言者在刚才这段对话中明确选择了只聊天'));
  assert(!progressive({ history, speaker: { id: 'alice' }, requestText: '帮我想想怎么办，给我建议。' })
    .includes('当前发言者在刚才这段对话中明确选择了只聊天'));
});

test('only enabled capabilities are discoverable, with task authorization and media delivery boundaries intact', () => {
  const noTools = progressive();
  for (const { name } of capabilities) assert(!noTools.includes(name), name);
  const enabled = progressive({ capabilities });
  for (const { name } of capabilities) assert(enabled.includes(name), name);
  assert(enabled.includes('只有当前发言者本条明确请求才可创建'));
  assert(enabled.includes('成功返回 ID 后才确认设置'));
  assert(enabled.includes('caption 就是实际正文'));
  assert(enabled.includes('表情包不分析'));
  assert(progressive({ mode: 'scheduled' }).includes('完成既定事项，不重新创建、延后或更改'));
});
