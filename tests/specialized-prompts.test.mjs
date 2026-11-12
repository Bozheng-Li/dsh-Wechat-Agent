import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWechatPrompt } from '../lib/testing.js';

const prompt = (mode, capabilities = []) => buildWechatPrompt({
  mode, capabilities, promptStrategy: 'progressive-v1',
  persona: { name: '小胖', aliases: [], prompt: '有主见，也讲证据。' },
  systemOverride: mode.startsWith('moments-')
    ? '按小胖人设输出本任务要求的内容，人物资料通过 wechat_role_card 核对。'
    : '只根据所给来源输出结构化资料。',
});

test('Moments replies keep their persona and permit discovery of the supplied person tool', () => {
  const text = prompt('moments-reply', [{ name: 'wechat_capabilities' }]);
  assert.doesNotMatch(text, /不扮演聊天角色|不调用工具|不创建任务或发送消息/);
  assert.match(text, /wechat_capabilities/);
  assert.match(text, /小胖/);
});

test('structured Moments comments can use their supplied person tool without inheriting chat operations', () => {
  const text = prompt('moments-interaction', [{ name: 'wechat_role_card' }]);
  assert.doesNotMatch(text, /不扮演聊天角色|不调用工具/);
  assert.match(text, /wechat_role_card/);
  assert.match(text, /本任务/);
});

test('background card extraction remains a separate task with no chat persona or tools', () => {
  const text = prompt('role-memory');
  assert.match(text, /不扮演聊天角色/);
  assert.match(text, /不调用工具/);
  assert.doesNotMatch(text, /小胖|有主见，也讲证据/);
});

test('material preparation permits its actual tools and keeps the internal output boundary', () => {
  const text = buildWechatPrompt({ mode: 'moments-materials',
    capabilities: [{ name: 'wechat_moments_material_search' }],
    systemOverride: '只输出素材清单 JSON，不输出聊天正文。',
  });
  assert.doesNotMatch(text, /不调用工具/);
  assert.match(text, /wechat_moments_material_search/);
  assert.match(text, /不扮演聊天角色/);
  assert.match(text, /只输出素材清单 JSON/);
});

test('an external reply with no supplied tools still cannot claim tool access', () => {
  const text = prompt('moments-reply');
  assert.match(text, /没有开放工具/);
  assert.match(text, /不调用工具/);
  assert.doesNotMatch(text, /不扮演聊天角色/);
});

test('reply proofreading keeps character expression while pure long-memory processing stays isolated', () => {
  const review = buildWechatPrompt({ mode: 'reply-review',
    systemOverride: '保留给定角色的自然语气，只改草稿中必要的错误，只输出最终回复正文。',
  });
  assert.doesNotMatch(review, /不扮演聊天角色/);
  assert.match(review, /全局人设/);
  assert.match(review, /不调用工具/);
  assert.match(prompt('long-memory'), /不扮演聊天角色/);
});
