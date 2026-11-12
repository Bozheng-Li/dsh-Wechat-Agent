import { inflateRawSync } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ChannelError } from '../../shared/contracts.mjs';
import { DOCX_MEDIA_TYPE, RECEIVED_FILE_LIMITS } from '../../shared/received-files.mjs';
import { crc32 } from '../media/image-format.mjs';

const MAX_XML_BYTES = 16 * 1024 * 1024;
const fail = message => { throw new ChannelError('FILE_DOCX_INVALID', message); };

/** Read the two required OOXML members in memory. Nothing in the ZIP is executed or extracted. */
function documentMembers(data) {
  if (!Buffer.isBuffer(data) || data.length < 22 || data.length > RECEIVED_FILE_LIMITS.bytes) fail('Word 文件为空、损坏或超过 20 MiB');
  let end = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65557); index--)
    if (data.readUInt32LE(index) === 0x06054b50 && index + 22 + data.readUInt16LE(index + 20) === data.length) { end = index; break; }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== data.readUInt16LE(end + 10))
    fail('仅支持普通、未加密的 .docx 文件；旧版 .doc、加密文档和分卷压缩包不能读取');
  const count = data.readUInt16LE(end + 10), centralSize = data.readUInt32LE(end + 12), central = data.readUInt32LE(end + 16);
  if (!count || count > 2048 || centralSize === 0xffffffff || central === 0xffffffff || central + centralSize !== end) fail('Word 压缩目录无效、过大或使用不支持的 ZIP64');
  const members = new Map(), names = new Set(), ranges = []; let at = central, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) fail('Word 压缩目录损坏');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), checksum = data.readUInt32LE(at + 16),
      compressed = data.readUInt32LE(at + 20), uncompressed = data.readUInt32LE(at + 24), nameSize = data.readUInt16LE(at + 28),
      extraSize = data.readUInt16LE(at + 30), commentSize = data.readUInt16LE(at + 32), local = data.readUInt32LE(at + 42),
      next = at + 46 + nameSize + extraSize + commentSize, mode = data.readUInt32LE(at + 38) >>> 16;
    if (next > end || data.readUInt16LE(at + 34) || flags & 0x2041 || ![0, 8].includes(method) ||
        [compressed, uncompressed, local].includes(0xffffffff) || (mode & 0xf000) === 0xa000) fail('Word 含加密、不支持或损坏的压缩条目');
    const nameBytes = data.subarray(at + 46, at + 46 + nameSize); let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { fail('Word 内部文件名不是有效 UTF-8'); }
    if (!name || name.length > 1000 || /[\\:\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || names.has(name))
      fail('Word 内部文件名重复或包含无效路径');
    names.add(name); expanded += uncompressed;
    if (expanded > 64 * 1024 * 1024) fail('Word 解压后的内容超过 64 MiB');
    if (local + 30 > central || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method)
      fail('Word 数据区与目录不匹配');
    const localNameSize = data.readUInt16LE(local + 26), start = local + 30 + localNameSize + data.readUInt16LE(local + 28), stop = start + compressed;
    if (stop > central || !data.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes) ||
        !(flags & 8) && (data.readUInt32LE(local + 14) !== checksum || data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== uncompressed))
      fail('Word 内部文件长度或目录校验失败');
    ranges.push([local, stop]);
    if (name === 'word/document.xml' || name === '[Content_Types].xml') {
      if (uncompressed > MAX_XML_BYTES) fail('Word 正文 XML 超过 16 MiB');
      let content;
      try { content = method === 0 ? data.subarray(start, stop) : inflateRawSync(data.subarray(start, stop), { maxOutputLength: Math.min(uncompressed + 1, MAX_XML_BYTES) }); }
      catch { fail('Word 正文解压失败或超过声明长度'); }
      if (content.length !== uncompressed || crc32(content) !== checksum) fail('Word 正文长度或 CRC 校验失败');
      try { members.set(name, new TextDecoder('utf-8', { fatal: true }).decode(content)); } catch { fail('Word 正文不是有效 UTF-8'); }
    }
    at = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (at !== end || ranges.some((range, index) => index && range[0] < ranges[index - 1][1])) fail('Word 压缩数据边界不正确');
  if (members.size !== 2) fail('文件不是完整的 .docx 文档，缺少正文或内容类型声明');
  return members;
}

export function readDocx(content) {
  const members = documentMembers(content), xml = members.get('word/document.xml'), typesXml = members.get('[Content_Types].xml');
  for (const value of [xml, typesXml]) if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(value) || XMLValidator.validate(value) !== true) fail('Word XML 无效或包含不支持的实体声明');
  let document, types;
  try {
    types = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(typesXml)?.Types;
    document = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false, removeNSPrefix: true }).parse(xml);
  } catch { fail('Word 正文 XML 无法读取'); }
  const overrides = [types?.Override].flat().filter(Boolean);
  if (!overrides.some(value => value['@_PartName'] === '/word/document.xml' && value['@_ContentType'] === DOCX_MEDIA_TYPE + '.main+xml'))
    fail('文件没有标准 Word 正文类型声明');
  const body = document.find(node => node.document)?.document?.find(node => node.body)?.body;
  if (!body) fail('Word 文档缺少正文区域');
  let paragraphs = 0, tables = 0;
  function render(nodes, depth = 0) {
    if (depth > 128) fail('Word XML 嵌套过深');
    return nodes.map(node => {
      const tag = Object.keys(node).find(key => key !== ':@');
      if (!tag || ['del', 'delText', 'instrText', 'drawing', 'pict', 'object'].includes(tag)) return '';
      if (tag === '#text') return '';
      if (tag === 't') return node[tag].map(value => value['#text'] ?? '').join('');
      if (tag === 'tab') return '\t';
      if (tag === 'br' || tag === 'cr') return '\n';
      const value = Array.isArray(node[tag]) ? render(node[tag], depth + 1) : '';
      if (tag === 'p') { paragraphs++; return value + '\n'; }
      if (tag === 'tc') return value.trimEnd() + '\t';
      if (tag === 'tr') return value.replace(/\t$/, '') + '\n';
      if (tag === 'tbl') { tables++; return value + '\n'; }
      return value;
    }).join('');
  }
  const text = render(body).replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 2_000_000) throw new ChannelError('FILE_DOCX_TOO_LARGE', 'Word 提取正文超过 200 万字符，请拆分文档');
  return { text, paragraphs, tables, note: '已提取正文段落与表格文字；图片、扫描件、批注、页眉页脚和排版未作读取或还原。' };
}
