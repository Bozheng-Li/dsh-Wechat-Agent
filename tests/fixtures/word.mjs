import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../modules/media/image-format.mjs';

export function wordZip(entries) {
  const records = [], directory = []; let offset = 0;
  for (const { name, text, data = Buffer.from(text), stored = false } of entries) {
    const filename = Buffer.from(name), compressed = stored ? data : deflateRawSync(data), checksum = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(stored ? 0 : 8, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    records.push(local, filename, compressed); directory.push(central, filename); offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}
export const xmlEscape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export function wordFixture({ text = '附件实验：需求 Q782，保留原字节 😀。', table = [['项目', '数值'], ['预算', '42']], extra = [], body, runProperties = '' } = {}) {
  const paragraph = text => `<w:p><w:r>${runProperties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  const grid = table.length ? '<w:tblGrid>' + '<w:gridCol w:w="2400"/>'.repeat(Math.max(...table.map(row => row.length))) + '</w:tblGrid>' : '';
  const tableXml = table.length ? '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' + grid +
    table.map(row => '<w:tr>' + row.map(cell => '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>' + paragraph(cell) + '</w:tc>').join('') + '</w:tr>').join('') + '</w:tbl>' : '';
  return wordZip([
    { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', text: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + (body ?? paragraph(text) + tableXml) + '</w:body></w:document>' },
    ...extra,
  ]);
}
