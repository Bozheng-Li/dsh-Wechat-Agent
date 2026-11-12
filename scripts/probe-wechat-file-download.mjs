import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { rolldown } from 'rolldown';
import { wordFixture } from '../tests/fixtures/word.mjs';
import { readDocx } from '../modules/files/docx.mjs';

// Explicit manual experiment. Upload a synthetic fixture to the logged-in
// account's attachment service, then download it. Never call SendAppMsg.
const args = process.argv.slice(2), rootFlag = args.indexOf('--root'), outputFlag = args.indexOf('--output');
if (!args.includes('--upload-fixture') || rootFlag < 0 || !args[rootFlag + 1] || outputFlag < 0 || !args[outputFlag + 1])
  throw Error('Usage: node scripts/probe-wechat-file-download.mjs --upload-fixture --root <wechat-data-root> --output <report.json>');
const repo = path.resolve(import.meta.dirname, '..'), reportFile = path.resolve(args[outputFlag + 1]);
const entry = ['wire.ts', 'session.ts', 'file-upload.ts', 'file-download.ts'].map(name =>
  `export * from ${JSON.stringify(path.join(repo, 'backend/wechat/protocol', name))};`).join('\n');
const build = await rolldown({ input: 'virtual:file-probe', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(repo, 'backend/wechat/types.ts') } },
  plugins: [{ name: 'file-probe', resolveId: id => id === 'virtual:file-probe' ? id : null, load: id => id === 'virtual:file-probe' ? entry : null }] });
let api;
try { const { output } = await build.generate({ format: 'esm' }); api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`); }
finally { await build.close(); }
const report = { at: new Date().toISOString(), fixture: 'synthetic-word-with-paragraph-and-table', sentMessages: 0, uploaded: false, downloaded: false };
try {
  const account = api.validateCredential(JSON.parse(fs.readFileSync(path.join(path.resolve(args[rootFlag + 1]), 'storage/private/session.json'), 'utf8')));
  const base = account.image_base_request ?? account.heartbeat_base_request;
  assert(base, 'No attachment BaseRequest is available');
  const original = wordFixture({ extra: [{ name: 'word/media/probe.bin', data: Buffer.alloc(150001, 0x51), stored: true }] });
  const digest = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
  const upload = { clientId: 'dsh_file_probe_' + randomBytes(10).toString('hex'), from: account.wxid, total: original.length,
    md5: digest(original, 'md5'), baseRequest: Buffer.from(base, 'hex') };
  let mediaId;
  for (let offset = 0; offset < original.length; offset += api.FILE_CHUNK_BYTES) {
    const chunk = original.subarray(offset, offset + api.FILE_CHUNK_BYTES);
    const body = await api.requestFileCgi(account, 220, api.fileUploadRequest(upload, offset, chunk), AbortSignal.timeout(15000));
    const fields = api.fields(body);
    (report.uploadChunks ??= []).push({ requestedOffset: offset, requestedBytes: chunk.length,
      clientMatched: api.bytes(fields, 4).toString() === upload.clientId, accountMatched: api.bytes(fields, 5).toString() === upload.from,
      total: Number(api.num(fields, 6)), offset: Number(api.num(fields, 7)), bytes: Number(api.num(fields, 8)), hasMediaId: !!api.bytes(fields, 3).length });
    const result = api.fileUploadResponse(body, upload, offset, chunk.length);
    if (result.complete) mediaId = result.mediaId;
  }
  assert(mediaId); report.uploaded = true; report.uploadBytes = original.length;
  const request = { baseRequest: upload.baseRequest, appId: '', mediaId, username: account.wxid, total: original.length, messageId: '1' };
  const inspectEnvelope = async (url, options) => {
    const response = await fetch(url, options), copy = response.clone(), chunks = []; let size = 0;
    for await (const chunk of copy.body) {
      size += chunk.length; assert(size <= api.FILE_DOWNLOAD_CHUNK_BYTES + 32768, 'Attachment response exceeds probe limit'); chunks.push(chunk);
    }
    const envelope = Buffer.concat(chunks), modes = {};
    for (const responseChecksum of [false, true]) {
      try {
        const decoded = api.decodeCgiBody(envelope, Buffer.from(account.body_key, 'hex'), Buffer.from(account.s08, 'hex'), options.body, { responseChecksum });
        modes[responseChecksum ? 'contentChecksum' : 'requestChecksum'] = { valid: true, accountMatched: decoded.uin === account.uin, command: decoded.innerCmd };
      } catch (error) { modes[responseChecksum ? 'contentChecksum' : 'requestChecksum'] = { valid: false, reason: error.message }; }
    }
    (report.downloadEnvelopes ??= []).push({ bytes: size, modes });
    return response;
  };
  const chunks = []; let offset = 0;
  while (offset < request.total) {
    const body = await api.downloadFileChunk(account, api.fileDownloadRequest(request, offset), AbortSignal.timeout(15000), inspectEnvelope);
    const chunk = api.fileDownloadResponse(body, request, offset); chunks.push(chunk); offset += chunk.length;
  }
  const acquired = Buffer.concat(chunks); assert(acquired.equals(original));
  const doc = readDocx(acquired); assert(doc.text.includes('Q782')); assert(doc.text.includes('预算\t42'));
  Object.assign(report, { downloaded: true, bytesEqual: true, downloadedBytes: acquired.length, chunks: chunks.length,
    sha256: digest(acquired), md5Matched: digest(acquired, 'md5') === upload.md5, paragraphs: doc.paragraphs, tables: doc.tables,
    scope: 'Authenticated attachment-service round trip; incoming Word message and quote delivery require a fresh real example.' });
} catch (error) {
  report.error = { code: error.code ?? error.name, message: error.message };
  process.exitCode = 1;
}
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
