import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWechatPrompt, planProgressiveTools, personaFromPreset
} from '../lib/testing.js';



const options = { persona: personaFromPreset(), requestText: '这个说法靠谱吗', now: new Date('2026-11-10T12:00:00Z') };

test('complex-fact guidance is available even when a semantic request misses all preload keywords', () => {
  const plan = planProgressiveTools([{ name: 'wechat_web_search' }], options.requestText);
  assert.equal(plan.initial.length, 0); assert.equal(plan.deferredGroups[0].id, 'search');
  const prompt = buildWechatPrompt({ ...options, promptStrategy: 'progressive-v1', capabilities: [{ name: 'wechat_capabilities' }], searchAvailable: true });
  assert.match(prompt, /复杂、专业/); assert.match(prompt, /先用 wechat_web_search/);
  assert.match(prompt, /wechat_capabilities 加载 search/); assert.match(prompt, /回退一次/);
});

test('legacy and progressive search guidance protect private facts and ordinary conversation', () => {
  for (const promptStrategy of ['legacy', 'progressive-v1']) {
    const prompt = buildWechatPrompt({ ...options, promptStrategy, capabilities: [{ name: 'wechat_web_search' }] });
    assert.match(prompt, /查询仅用公开主题/); assert.match(prompt, /私事查会话/);
    assert.match(prompt, /寒暄、创作、简单计算及已给材料概括无需联网/);
    assert.match(prompt, /明确禁用联网时遵守/);
  }
});

test('disabling search and running isolated internal tasks does not advertise an unavailable search', () => {
  for (const promptStrategy of ['legacy', 'progressive-v1']) {
    const prompt = buildWechatPrompt({ ...options, promptStrategy, capabilities: [{ name: 'wechat_memory' }] });
    assert(!prompt.includes('wechat_web_search'));
    for (const mode of ['memory', 'vision', 'work-routing', 'moments-material-review']) {
      const internal = buildWechatPrompt({ ...options, promptStrategy, mode, searchAvailable: false, systemOverride: '内部专用协议' });
      assert(!internal.includes('wechat_web_search')); assert(internal.includes('内部专用协议'));
    }
  }
});
