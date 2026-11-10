import { readPrompt } from '../../prompts/loader.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";

// Only byte-equivalent shipped defaults are migrated on disk. Custom Markdown stays intact.
const LEGACY_DEFAULT_IDENTITY_HASHES = new Set([
  '757d1597d96c41c4dc5b1eb6713637eb7ebfeb45799777a81a84f0ae54ebe82a',
  '28457159960eb61236aa18874ca486fee08a9b64fbc2bd5dbf6047e267682d6a',
  '195635b737ed00de023349aa557ce097eeec73b2a258c97432531cd3d2030353',
]);
const PREVIOUS_DEFAULT_PREFIXES = new Map([
  [819, '28457159960eb61236aa18874ca486fee08a9b64fbc2bd5dbf6047e267682d6a'],
  [376, '195635b737ed00de023349aa557ce097eeec73b2a258c97432531cd3d2030353'],
]);
const identityHash = (markdown) => createHash('sha256').update(markdown.replace(/\r\n/g, '\n')).digest('hex');

export const DEFAULT_AGENT_IDENTITY = readPrompt('identity/default.md');

/** Rebase a recognized old boilerplate prefix in the prompt, retaining the owner's file and additions. */
export function effectiveAgentIdentity(markdown) {
  if (!markdown) return DEFAULT_AGENT_IDENTITY;
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (LEGACY_DEFAULT_IDENTITY_HASHES.has(identityHash(normalized))) return DEFAULT_AGENT_IDENTITY;
  for (const [length, digest] of PREVIOUS_DEFAULT_PREFIXES)
    if (identityHash(normalized.slice(0, length)) === digest)
      return DEFAULT_AGENT_IDENTITY + normalized.slice(length);
  return markdown;
}

function atomicText(file, markdown) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, markdown, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch {
    throw new ChannelError('IDENTITY_WRITE_FAILED', '全局身份文件未能保存，请检查目录权限；原内容保留');
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

export class AgentIdentity {
  constructor(root, { config } = {}) {
    this.file = path.join(root, config?.data.prompts.identity || 'prompts/AGENT.md');
    const legacy = path.join(root, 'AGENT.md');
    if (!fs.existsSync(this.file) && fs.existsSync(legacy)) atomicText(this.file, fs.readFileSync(legacy));
    if (!fs.existsSync(this.file)) atomicText(this.file, DEFAULT_AGENT_IDENTITY);
    else {
      let previous;
      try {
        previous = this.view().markdown;
      } catch (error) {
        if (error.code !== 'IDENTITY_INVALID') throw error;
      }
      if (previous && LEGACY_DEFAULT_IDENTITY_HASHES.has(identityHash(previous)))
        atomicText(this.file, DEFAULT_AGENT_IDENTITY);
    }
  }
  view() {
    let markdown;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > 160000) throw new Error('Invalid identity file');
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(this.file)).replace(/^\uFEFF/, '');
    } catch {
      throw new ChannelError(
        'IDENTITY_INVALID',
        '全局身份 AGENT.md 无法读取、不是有效 UTF-8 或文件过大，请检查文件后再回复'
      );
    }
    if (!markdown.trim() || markdown.length > 32000 || markdown.includes('\0'))
      throw new ChannelError('IDENTITY_INVALID', '全局身份 AGENT.md 应为 1–32000 字的 Markdown 正文');
    return { path: this.file, markdown, revision: createHash('sha256').update(markdown).digest('hex') };
  }
  validateEdit(markdown, expectedRevision) {
    const current = this.view();
    if (current.revision !== expectedRevision)
      throw new ChannelError('IDENTITY_CHANGED', '全局身份文件已被修改，请重新读取后再保存；你的草稿仍保留');
    if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 32000 || markdown.includes('\0'))
      throw new ChannelError('IDENTITY_INVALID', '全局身份应为 1–32000 字的 Markdown 正文');
    return current;
  }
  edit(markdown, expectedRevision) {
    this.validateEdit(markdown, expectedRevision);
    atomicText(this.file, markdown);
    return this.view();
  }
}
