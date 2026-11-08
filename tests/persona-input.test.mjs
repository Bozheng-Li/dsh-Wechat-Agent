import test from 'node:test';
import assert from 'node:assert/strict';
import { personaFields, personaStyleParts } from '../src/features/agent/persona-input.mjs';
import { personaText, validatePersona } from '../src/shared/contracts.mjs';
import { PERSONA_PRESETS, personaFromPreset } from '../src/shared/persona-presets.mjs';
import { configDraft, configPayload } from '../src/client/shared/drafts.mjs';

test('all authored personas keep the same fields and examples after the actual editor payload conversion', () => {
  for (const preset of PERSONA_PRESETS) {
    const original = personaFromPreset(preset.id);
    const saved = validatePersona(configPayload(configDraft({ persona: original })).persona);
    assert.equal(saved.prompt, personaText(original));
    const fields = personaFields(saved);
    assert(fields, preset.id + ' must not fall back to freeform after editor save');
    for (const key of ['background', 'personality', 'style']) assert.equal(fields[key], original[key]);
    const parts = personaStyleParts(fields.style);
    assert(parts.style.includes(preset.style));
    for (const example of preset.examples) assert(parts.examples.includes(example.message) && parts.examples.includes(example.reply));
  }
});

test('canonical partial fields and uniform CRLF retain original field bytes while explicit prompt wins over stale fields', () => {
  for (const fields of [{ style: '一句\n两句' }, { background: '背景', style: '方式' }, { personality: '甲\n\n乙\n', style: '丙' }]) {
    const text = personaText(fields);
    assert.deepEqual(personaFields({ prompt: text, background: 'STALE' }), fields);
    const crlf = text.replaceAll('\n', '\r\n');
    const expected = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replaceAll('\n', '\r\n')]));
    assert.deepEqual(personaFields({ prompt: crlf }), expected);
  }
});

test('ambiguous, quoted or free prose is never silently classified or truncated', () => {
  for (const prompt of ['', '自定义角色。', '说明：\n\n角色背景：\n正文', '> 角色背景：\n引用',
    '角色背景：\n甲\n\n角色背景：\n乙', '表达方式：\n甲\n\n角色背景：\n乙',
    '角色背景：\n甲\n\n表达方式：\n```text\n未闭合', '角色背景：\n', '角色背景：\r\n甲\n\n表达方式：\n乙'])
    assert.equal(personaFields({ prompt }), null, prompt);
  const fields = { background: '甲\n\n```text\n\n性格与互动：\n仅作代码内容\n```', style: '乙' };
  assert.deepEqual(personaFields({ prompt: personaText(fields) }), fields);
});

test('example headings inside code, duplicated headings and arbitrary prose remain intact', () => {
  const original = personaFromPreset('mobai').style;
  const { style, examples } = personaStyleParts(original);
  assert.equal(style + '\n\n' + examples, original);
  const crlf = original.replaceAll('\n', '\r\n');
  const parts = personaStyleParts(crlf);
  assert.equal(parts.style + '\r\n\r\n' + parts.examples, crlf);
  for (const value of [`代码说明\n\n\x60\x60\x60text\n\n${examples}\n\x60\x60\x60`, `${original}\n\n${examples}`, '无示例的自由正文'])
    assert.deepEqual(personaStyleParts(value), { style: value, examples: '' });
});
