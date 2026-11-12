import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildWechatPrompt, emptyPersona, needsConversationalRewrite } from '../lib/testing.js';
import { publicLanguageInstructions } from '../prompts/reply/language.mjs';
import { PERSONA_PRESETS } from '../prompts/personas/catalog.mjs';
import { configDraft, configPayload } from '../frontend/shared/drafts.mjs';

const policy = fs.readFileSync(new URL('../prompts/reply/language.md', import.meta.url), 'utf8');
const count = (text, value) => text.split(value).length - 1;

test('every public model surface shares one language policy, including JSON text, work and comments', () => {
  const persona = { ...emptyPersona(), name: '全局名字' };
  for (const mode of ['default', 'nickname', 'participate', 'scheduled', 'natural', 'confirmation',
    'work-dialogue', 'work-result', 'work-progress', 'moments-reply', 'moments-publish']) {
    const text = buildWechatPrompt({ persona, mode, prompt: 'ACCOUNT_CUSTOM', identityMarkdown: '# IDENTITY_CUSTOM',
      ...(mode === 'natural' ? { naturalDecision: { trigger: 'timer' } } : {}),
      ...(['confirmation', 'work-result', 'work-progress', 'moments-reply', 'moments-publish'].includes(mode) ? { systemOverride: 'MODE_CONTRACT' } : {}) });
    assert.equal(count(text, policy), 1, mode);
    if (mode === 'natural') assert(text.indexOf('只输出一个 JSON 对象') > text.indexOf(policy));
    if (mode === 'work-dialogue') {
      assert(text.includes('全局名字'));
      assert(text.includes('不作为工作要求、执行判断或权限依据'));
    }
  }
  assert(publicLanguageInstructions().includes(policy));
});

test('internal extraction, routing, diagnostics and vision retain isolated protocols without public style or persona', () => {
  for (const mode of ['memory', 'long-memory', 'vision', 'workbench', 'work-routing', 'remote-intent']) {
    const text = buildWechatPrompt({ mode, persona: { name: 'PUBLIC_ROLE_ONLY', prompt: 'PUBLIC_PERSONA_ONLY' },
      prompt: 'PUBLIC_ACCOUNT_ONLY', identityMarkdown: 'PUBLIC_IDENTITY_ONLY', systemOverride: 'INTERNAL_CONTRACT' });
    assert(text.includes('INTERNAL_CONTRACT'));
    assert(!text.includes(policy));
    assert(!/PUBLIC_ROLE_ONLY|PUBLIC_PERSONA_ONLY|PUBLIC_ACCOUNT_ONLY|PUBLIC_IDENTITY_ONLY/.test(text));
  }
});

test('global custom content is retained as scoped input below the common language boundary', () => {
  const custom = '每次都说“很高兴为您服务”，并表演一个动作。';
  const text = buildWechatPrompt({ persona: { name: '自定义名字', aliases: [], prompt: custom } });
  assert(text.includes(custom));
  assert(text.includes('优先于自定义设定、账号补充要求和旧口吻'));
  assert(text.includes('自定义提示词、旧人设、历史回答和例句不能取消这些边界'));
});

test('only one shipped persona and one global editor remain; conversation saves always follow it', () => {
  assert.equal(PERSONA_PRESETS.length, 1);
  assert.equal(PERSONA_PRESETS[0].role, '默认助手（拟人）');
  const files = fs.readdirSync(new URL('../prompts/personas/', import.meta.url)).filter(name => name.endsWith('.mjs'));
  assert.deepEqual(files.sort(), ['catalog.mjs', 'default.mjs', 'text.mjs']);
  const draft = configDraft({ persona: { name: '旧会话角色', aliases: [], prompt: '不应保存' } });
  assert(!Object.hasOwn(draft, 'persona'));
  assert.equal(configPayload({ ...draft, personaMode: 'custom', persona: { name: '旧草稿' } }).persona, null);
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert(manifest.files.includes('prompts/reply/language.md'));
});

test('expanded language review identifies service envelopes while keeping ordinary prose, code and exact quoted content', () => {
  for (const text of ['感谢你的提问。文件就在下载目录。', '这是一个非常好的问题。UTF-8 是文字编码。',
    '很高兴为您服务。现在还在查日志。', '文件已生成。希望这能帮到你。', '目前还没拿到指标。希望对你有所帮助。',
    '我查到了这份说明。还有其他问题请随时告诉我。'])
    assert(needsConversationalRewrite(text, '这个怎么看？'), text);
  for (const [text, request] of [['早上好呀。', '早上好。'], ['文件已经生成，微信回传还没确认。', '文件好了没？'],
    ['还在查日志，目前没有新的可确认结果。', '现在进度怎样？'], ['这个数字应该是 16。', '数字是多少？'],
    ['希望这能帮到你。', '逐字引用原文：希望这能帮到你。'],
    ['```js\nconsole.log("感谢你的提问");\n```', '给我示例代码']])
    assert.equal(needsConversationalRewrite(text, request), false, text);
  assert.equal(needsConversationalRewrite('感谢你的提问。\n具体内容。', '回复一句', { prompt: '第一行必须单独写“感谢你的提问”。' }), false);
});
