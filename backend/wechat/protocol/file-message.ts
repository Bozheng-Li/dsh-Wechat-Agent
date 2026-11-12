import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { atomicJson } from './session.js';
import type { Segment } from '@napcat-wechat/protocol';
import { receivedFileName } from '../../../shared/received-files.mjs';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: false });
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
  const named: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
  if (named[entity]) return named[entity];
  const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
}) : '';
const locator = (value: unknown) => {
  const result = text(value).trim();
  return result.length <= 16384 && !/[\u0000-\u001f\u007f]/.test(result) ? result : '';
};

export interface ReceivedFile {
  name: string; bytes?: number; appId: string; attachId: string; cdnUrl: string; aesKey: string; md5: string;
}

/** Only an ordinary type-6 app attachment is a file; links/mini-apps stay opaque. */
export function parseReceivedFile(content: string): ReceivedFile | undefined {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65536) return;
  let xml = content.trim();
  for (let index = 0; index < 2 && xml.startsWith('&lt;'); index++) xml = text(xml);
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true) return;
  let app;
  try { const value = parser.parse(xml); app = value?.msg?.appmsg ?? value?.appmsg; } catch { return; }
  if (!app || Array.isArray(app) || app.type !== '6' || typeof app.title !== 'string' || !app.title.trim()) return;
  const attach = app.appattach;
  if (!attach || typeof attach !== 'object' || Array.isArray(attach)) return;
  const size = typeof attach.totallen === 'string' && /^\d{1,16}$/.test(attach.totallen.trim()) ? Number(attach.totallen) : undefined;
  const md5 = text(attach.filemd5 || attach.md5 || app.md5).toLowerCase().trim();
  return { name: receivedFileName(text(app.title)), ...(Number.isSafeInteger(size) ? { bytes: size } : {}),
    appId: locator(app['@_appid']), attachId: locator(attach.attachid), cdnUrl: locator(attach.cdnattachurl),
    aesKey: locator(attach.aeskey), md5: /^[a-f0-9]{32}$/.test(md5) ? md5 : '' };
}

export function observedFile(content: string, directory: string, source: { peerId: string; messageId: string; senderId: string; direction: string }): Segment | undefined {
  const file = parseReceivedFile(content);
  if (!file) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const resourceId = createHash('sha256').update(`${source.peerId}:${source.messageId}`).digest('hex');
  // The protected descriptor is addressed by the observed source, never by its title.
  atomicJson(path.join(directory, resourceId + '.json'), { version: 1, resourceId, ...source, ...file });
  return { type: 'file', data: { resourceId, name: file.name, ...(file.bytes !== undefined ? { bytes: file.bytes } : {}) } };
}
