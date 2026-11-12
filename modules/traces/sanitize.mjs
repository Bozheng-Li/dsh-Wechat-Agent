import { createHash } from 'node:crypto';
const secret = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|passwd|secret|credential|private[_-]?key|aes[_-]?key|signature|signkey)(?:$|[_-])/i;
const secretName = key => secret.test(key.replace(/([a-z])([A-Z])/g, '$1_$2')) || /^(?:key|token|sign|sig|auth|set-cookie)$/i.test(key);
const digest = value => createHash('sha256').update(value).digest('hex');

function cleanText(text) {
  return text.replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[媒体数据已省略]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=:-]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:[A-Z0-9_]*API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie|aes[_-]?key)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/g, match => {
      try {
        const url = new URL(match);
        if (url.username || url.password) { url.username = ''; url.password = ''; }
        for (const key of [...url.searchParams.keys()]) if (secretName(key) || /token|signature|ticket|encrypt|cdnmid|cdnurl|auth/i.test(key)) url.searchParams.set(key, '[已隐藏]');
        return url.href;
      } catch { return '[无效地址]'; }
    });
}

/** Persist actual text and structures; credentials and binary bodies are never trace payloads. */
export function tracePayload(value, { maxChars = 4 * 1024 * 1024, maxNodes = 50000 } = {}) {
  let remaining = maxChars, nodes = maxNodes, limited = false, binaryOmitted = 0, credentialsHidden = 0, reasoningOmitted = 0;
  const seen = new WeakSet();
  function visit(input, key = '', depth = 0) {
    if (secretName(key)) { credentialsHidden++; return '[已隐藏]'; }
    if (--nodes < 0 || remaining < 0 || depth > 35) { limited = true; return '[内容超过单项记录上限]'; }
    if (input === null || input === undefined) return input ?? null;
    if (typeof input === 'string') {
      if (/base64|dataurl/i.test(key) || /^(?:data|bytes|buffer)$/.test(key) && input.length > 80 && /^[A-Za-z0-9+/=\r\n]+$/.test(input)) {
        binaryOmitted++; return { omitted: 'binary', characters: input.length, sha256: digest(input) };
      }
      const text = cleanText(input);
      const budget = Math.max(0, remaining); remaining -= text.length;
      if (text.length > budget) { limited = true; return text.slice(0, budget) + '\n[内容超过单项记录上限]'; }
      return text;
    }
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return String(input);
    if (typeof input !== 'object') return '[' + typeof input + ']';
    if (input instanceof Error) return visit({ name: input.name, code: input.code, message: input.message, details: input.details });
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      binaryOmitted++; return { omitted: 'binary', bytes: input.byteLength, sha256: digest(input) };
    }
    if (seen.has(input)) return '[循环引用]';
    seen.add(input);
    try {
      if (/^(?:reasoning|thinking)(?:-|$)/.test(input.type || '')) { reasoningOmitted++; return { type: input.type, omitted: true }; }
      if (['image', 'audio', 'video', 'file', 'attachment'].includes(input.type) || (input.mediaType || input.mimeType) && typeof input.data === 'string') {
        binaryOmitted++;
        const metadata = { type: input.type || 'image', mediaType: input.mediaType || input.mimeType, name: input.name,
          width: input.width, height: input.height, resourceId: input.resourceId, bytes: input.bytes,
          ...(typeof input.data === 'string' ? { encodedCharacters: input.data.length, sha256: digest(input.data) } : {}), omitted: 'binary' };
        return Object.fromEntries(Object.entries(metadata).filter(([, item]) => item !== undefined).map(([name, item]) => [name, visit(item, name, depth + 1)]));
      }
      if (Array.isArray(input)) {
        const output = [];
        for (const item of input) {
          if (nodes <= 0 || remaining < 0) { limited = true; output.push('[内容超过单项记录上限]'); break; }
          output.push(visit(item, '', depth + 1));
        }
        return output;
      }
      const output = {};
      for (const [name, item] of Object.entries(input)) {
        if (['signal', 'controller', 'agent', 'ctx', 'transport', 'channel'].includes(name)) continue;
        if (nodes <= 0 || remaining < 0) { limited = true; output.$omitted = '[内容超过单项记录上限]'; break; }
        output[name] = visit(item, name, depth + 1);
      }
      return output;
    } finally { seen.delete(input); }
  }
  return { value: visit(value), limited, binaryOmitted, credentialsHidden, reasoningOmitted };
}

export function traceSnippet(value, length = 180) {
  const clean = tracePayload(typeof value === 'string' ? value : '', { maxChars: 2000 }).value;
  return clean.replace(/\s+/g, ' ').slice(0, length);
}
