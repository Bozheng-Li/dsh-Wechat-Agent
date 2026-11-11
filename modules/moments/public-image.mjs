import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ChannelError } from '../../shared/contracts.mjs';
import { inspectAssetImage } from '../media/image-format.mjs';

const invalid = message => { throw new ChannelError('MOMENTS_IMAGE_DOWNLOAD', message); };
const maxBytes = 10 * 1024 * 1024;
export function publicImageAddress(address) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0*0):/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !([0, 10, 127].includes(a) || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b));
}
function publicRequest(url, addresses, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, headers: { accept: 'image/png,image/jpeg', 'user-agent': 'WechatAgent-MaterialLibrary/1.0' },
      // Pin the validated DNS answer for this request, including after redirects.
      lookup: (_host, options, done) => options.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family),
    }, response => resolve({ status: response.statusCode, headers: response.headers, body: response }));
    request.on('error', reject);
  });
}
export async function downloadPublicImage(input, signal, { lookupImpl = lookup, open = publicRequest } = {}) {
  let next = input;
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted(); let url;
    try { url = new URL(next); } catch { invalid('请提供有效的公开图片链接'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length > 4096 || url.hash) invalid('只支持不含登录信息的公开 HTTP/HTTPS 图片链接');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupImpl(host, { all: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(row => !publicImageAddress(row.address))) invalid('不能从本机、内网或保留地址下载素材');
    let response;
    try { response = await open(url, addresses, signal); }
    catch (error) { signal.throwIfAborted(); invalid('图片下载连接失败，请换一个公开图片链接'); }
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location || redirect === 3) invalid('图片重定向过多或缺少目标地址');
        next = new URL(response.headers.location, url).href; continue;
      }
      if (response.status !== 200) invalid(`图片下载返回 HTTP ${response.status}，未保存`);
      if (Number(response.headers['content-length']) > maxBytes) invalid('图片超过 10 MiB，未保存');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > maxBytes) invalid('图片超过 10 MiB，未保存');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks), info = inspectAssetImage(bytes, { maxBytes });
      if (!['image/png', 'image/jpeg'].includes(info.mediaType)) invalid('该链接没有返回 PNG/JPEG 图片，请使用图片原文件链接');
      return { bytes, ...info, url: url.href };
    } finally { response.body.destroy?.(); }
  }
}
