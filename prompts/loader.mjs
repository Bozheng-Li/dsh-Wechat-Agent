import fs from 'node:fs';
import { resourcePath } from '../backend/platform/resources.mjs';
import { ChannelError } from '../shared/contracts.mjs';

const cache = new Map();
function load(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9/_-]*\.(?:md|json)$/.test(name) || name.includes('..'))
    throw new ChannelError('PROMPT_INVALID', '提示词模板路径无效，未继续生成回复');
  const file = resourcePath('prompts', name);
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile() || stat.size > 1024n * 1024n) throw Error();
    const signature = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (cache.get(file)?.signature === signature) return cache.get(file).value;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    const value = name.endsWith('.json') ? JSON.parse(text) : text;
    cache.set(file, { signature, value });
    return value;
  } catch {
    throw new ChannelError('PROMPT_INVALID', `提示词模板 ${name} 无法读取或格式无效，未继续生成回复；请检查模板文件`);
  }
}
const interpolate = (text, values) => text.replace(/\{\{(\d+)\}\}/g, (_, index) => {
  if (!Object.hasOwn(values, index)) throw new ChannelError('PROMPT_INVALID', '提示词模板引用了未提供的变量，未继续生成回复');
  return String(values[index]);
});
export function readPrompt(name) {
  const value = load(name);
  if (typeof value !== 'string') throw new ChannelError('PROMPT_INVALID', '提示词正文需要 Markdown 文件');
  return value;
}
export const renderPrompt = (name, values = []) => interpolate(readPrompt(name), values);
export function promptText(name, key, values = []) {
  const value = load(name);
  if (!Object.hasOwn(value, key) || typeof value[key] !== 'string')
    throw new ChannelError('PROMPT_INVALID', `提示词模板 ${name} 缺少所需正文，未继续生成回复`);
  return interpolate(value[key], values);
}
