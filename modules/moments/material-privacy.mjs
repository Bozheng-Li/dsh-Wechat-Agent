import { ChannelError } from '../../shared/contracts.mjs';
import { readPrompt } from '../../prompts/loader.mjs';

const patterns = [ /\b1[3-9]\d{9}\b/g, /\b\d{17}[\dXx]\b/g, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /\b(?:wxid_[A-Za-z0-9_-]+|(?:sk|api)[-_][A-Za-z0-9_-]{12,})\b/g, /https?:\/\/[^\s<>]+/gi ];
export function redactMaterialInput(text, names = []) {
  let value = String(text);
  for (const name of [...new Set(names.filter(name => typeof name === 'string' && name.trim().length >= 2))].sort((a, b) => b.length - a.length))
    value = value.split(name).join('[身份已隐去]');
  for (const pattern of patterns) value = value.replace(pattern, '[私人线索已隐去]');
  return value;
}
export function materialTextIsPublic(text, names = []) {
  return !/\[(?:身份|私人线索)已隐去\]/u.test(text) && redactMaterialInput(text, names) === text;
}
export function materialJSON(result) {
  try { return JSON.parse(String(result?.text ?? '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '')); }
  catch { throw new ChannelError('MOMENTS_MATERIAL_RESPONSE', '素材整理没有返回有效结果，原素材保留'); }
}
export async function reviewMaterialText(channel, candidates, signal, check, context = []) {
  check(); const result = materialJSON(await channel.runner.run({ mode: 'moments-material-review', tools: [], allowEmptyReply: true, signal,
    systemOverride: readPrompt('moments/material-review.md'), text: JSON.stringify({ candidates, context }) })); check();
  if (!result || Object.keys(result).some(key => key !== 'safeIds') || !Array.isArray(result.safeIds) ||
    result.safeIds.some(id => !candidates.some(item => item.id === id))) throw new ChannelError('MOMENTS_MATERIAL_RESPONSE', '素材公开性检查未完成，未使用本次结果');
  return new Set(result.safeIds);
}
