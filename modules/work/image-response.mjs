import { ChannelError } from '../../shared/contracts.mjs';

export function decodeGeneratedImage(value) {
  let encoded = value.trim();
  const invalid = () => new ChannelError('IMAGE_GENERATION_RESPONSE',
    `生图 API 返回的 base64 编码格式无效（${value.length} 个字符），未解码为图片；请检查接口返回格式`);
  if (/^data:/i.test(encoded)) {
    const prefix = /^data:image\/(?:png|jpe?g|webp);base64,/i.exec(encoded);
    if (!prefix) throw invalid();
    encoded = encoded.slice(prefix[0].length);
  }
  // Compatible providers also return MIME line breaks, unpadded base64 and
  // the URL-safe alphabet. Normalize only these forms, then verify bytes.
  encoded = encoded.replace(/[\t\r\n ]/g, '').replaceAll('-', '+').replaceAll('_', '/');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid();
  const bare = encoded.replace(/=+$/, ''), padding = encoded.length - bare.length;
  const required = (4 - bare.length % 4) % 4;
  if (!bare || bare.length % 4 === 1 || padding && padding !== required) throw invalid();
  const bytes = Buffer.from(bare + '='.repeat(required), 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== bare) throw invalid();
  return bytes;
}
