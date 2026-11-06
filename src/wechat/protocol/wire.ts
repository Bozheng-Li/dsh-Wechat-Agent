import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { BridgeError } from '@napcat-wechat/protocol';

// Ported from wechat39/proto/longlink.py; REPORT40 is the wire authority.
// These observed values are only for attached-token sessions. QR sessions
// must supply the per-login body key and checksum material.
export const DEFAULT_KEY = Buffer.from('qmjzZcR^=mN2a(ed');
export const DEFAULT_S08 = Buffer.from('f9e4a2cf206681961c1a35aa4b24cf53', 'hex');
export const MAGIC = 0x00100001;
export const RESPONSE = 0x3b9aca00;
export const WIRE: Record<number, number> = { 522: 0xed, 138: 0x79, 518: 0xee };
export const MAX_FRAME = 16 * 1024 * 1024;
export type Field = { tag: number; wire: number; value: Buffer | bigint };
const fail = (message: string): never => { throw new BridgeError('ERR_PROTOCOL', message); };
export function compactStatus(frame: Buffer): number | undefined {
  if (frame.length < 23 || frame.readUInt32BE(4) !== MAGIC) return;
  const body = frame.subarray(16), headerLength = body[1] >> 2;
  if (body[0] !== 0x7e || headerLength < 3 || body.length < headerLength + 4) return;
  return body.readInt32BE(headerLength);
}
export function vi(value: number | bigint): Buffer {
  let n = BigInt.asUintN(64, BigInt(value)); const bytes: number[] = [];
  do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}
export function readVi(b: Buffer, offset: number): [bigint, number] {
  let n = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset >= b.length) fail('Truncated varint');
    const v = b[offset++];
    if (i === 9 && v > 1) fail('Varint exceeds uint64');
    n |= BigInt(v & 127) << BigInt(i * 7);
    if (!(v & 128)) return [n, offset];
  }
  return fail('Invalid varint');
}
export const fv = (tag: number, value: number | bigint) => Buffer.concat([vi(tag * 8), vi(value)]);
export function ld(tag: number, value: Buffer | string): Buffer {
  const b = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([vi(tag * 8 + 2), vi(b.length), b]);
}
export function fields(b: Buffer): Field[] {
  const out: Field[] = []; let i = 0;
  while (i < b.length) {
    let key: bigint; [key, i] = readVi(b, i);
    const tag = Number(key >> 3n), wire = Number(key & 7n);
    if (tag < 1 || tag > 0x1fffffff) fail('Invalid protobuf field');
    let value: Buffer | bigint;
    if (wire === 0) [value, i] = readVi(b, i);
    else if (wire === 2) {
      let size: bigint; [size, i] = readVi(b, i);
      if (size > BigInt(b.length - i)) fail('Truncated protobuf bytes');
      value = b.subarray(i, i + Number(size)); i += Number(size);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (i + size > b.length) fail('Truncated protobuf fixed value');
      value = wire === 1 ? b.readBigUInt64LE(i) : BigInt(b.readUInt32LE(i)); i += size;
    } else return fail(`Unsupported protobuf wire type ${wire}`);
    out.push({ tag, wire, value });
  }
  return out;
}
export function bytes(fs: Field[], tag: number): Buffer {
  const v = fs.find(f => f.tag === tag)?.value;
  return Buffer.isBuffer(v) ? v : Buffer.alloc(0);
}
export function num(fs: Field[], tag: number): bigint | undefined {
  const v = fs.find(f => f.tag === tag)?.value; return typeof v === 'bigint' ? v : undefined;
}
export const signed = (v: bigint | undefined) => v === undefined ? undefined : Number(BigInt.asIntN(32, v));
export function unstring(b: Buffer): string {
  for (let i = 0; i < 2; i++) {
    try { const fs = fields(b); if (fs.length !== 1 || fs[0].tag !== 1 || !Buffer.isBuffer(fs[0].value)) break; b = fs[0].value; }
    catch { break; }
  }
  return b.toString('utf8');
}
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function md5(b: Buffer) { return createHash('md5').update(b).digest(); }
function adler(b: Buffer, seed = 1) {
  let a = seed & 65535, c = seed >>> 16;
  for (const v of b) { a = (a + v) % 65521; c = (c + a) % 65521; }
  return ((c << 16) | a) >>> 0;
}
function checksum(pt: Buffer, uin: number, s08: Buffer) {
  const d = md5(Buffer.concat([u32(pt.length), s08, md5(Buffer.concat([u32(uin), s08]))]));
  return adler(pt, adler(d));
}
function material(key?: Buffer, s08?: Buffer) {
  const bodyKey = key ?? DEFAULT_KEY, checksumMaterial = s08 ?? DEFAULT_S08;
  if (bodyKey.length !== 16) fail('body key must be 16 bytes');
  if (!checksumMaterial.length) fail('s08 must be non-empty');
  return { bodyKey, checksumMaterial };
}
export function encodeFrame(cmd: number, pt: Buffer, uin: number, token: string, seq: number, key?: Buffer, s08?: Buffer): Buffer {
  const selected = material(key, s08);
  const compressed = deflateSync(pt, { level: 9 });
  const cipher = createCipheriv('aes-128-cbc', selected.bodyKey, selected.bodyKey);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const header = Buffer.concat([Buffer.from([0xbf, 0, 0x5f]), u32(0xf2542033), u32(uin), Buffer.from(token, 'hex'), vi(cmd), vi(pt.length), vi(compressed.length), vi(0), vi(15), vi(checksum(pt, uin, selected.checksumMaterial)), Buffer.from([0]), vi(0), Buffer.from([0, 0]), vi(0), Buffer.from([0, 0])]);
  if (header.length > 63) fail('Longlink header too large');
  header[1] = (header.length << 2) | 1;
  return Buffer.concat([u32(16 + header.length + encrypted.length), u32(MAGIC), u32(WIRE[cmd] ?? cmd), u32(seq), header, encrypted]);
}
export function decodeFrame(frame: Buffer, key?: Buffer, s08?: Buffer): { cmd: number; seq: number; uin: number; innerCmd: number; body: Buffer } {
  const selected = material(key, s08);
  if (frame.length < 43 || frame.readUInt32BE(0) !== frame.length || frame.readUInt32BE(4) !== MAGIC) fail('Invalid longlink frame');
  const status = compactStatus(frame);
  if (status !== undefined) {
    if (status === -13) throw new BridgeError('ERR_SESSION_EXPIRED', '微信会话已失效，请重新扫码登录', { ret: status });
    throw new BridgeError('ERR_PROTOCOL', `Longlink compact status ${status}`, { ret: status });
  }
  const b = frame.subarray(16), headerLength = b[1] >> 2;
  if (headerLength < 26 || headerLength > b.length || ![0xbf, 0xbe].includes(b[0])) fail('Invalid longlink body header');
  const uin = b.readUInt32BE(7); let i = 26;
  const next = () => { let v: bigint; [v, i] = readVi(b.subarray(0, headerLength), i); return v; };
  const innerCmd = Number(next()), rawLength = next(), compressedLength = next(); next(); next();
  const sum = b[0] === 0xbf ? next() : 0n;
  i++; next(); i += 2; next(); i += 2;
  if (i !== headerLength || rawLength > BigInt(MAX_FRAME) || compressedLength > BigInt(MAX_FRAME)) fail('Invalid longlink body lengths');
  const cipher = createDecipheriv('aes-128-cbc', selected.bodyKey, selected.bodyKey);
  const compressed = Buffer.concat([cipher.update(b.subarray(headerLength)), cipher.final()]);
  if (compressed.length !== Number(compressedLength)) fail('Longlink compressed length mismatch');
  const body = (b[1] & 3) === 1 ? inflateSync(compressed, { maxOutputLength: MAX_FRAME }) : compressed;
  if (body.length !== Number(rawLength)) fail('Longlink plaintext length mismatch');
  if (sum !== 0n && Number(sum) !== checksum(body, uin, selected.checksumMaterial)) fail('Longlink checksum mismatch');
  return { cmd: frame.readUInt32BE(8), seq: frame.readUInt32BE(12), uin, innerCmd, body };
}
const MSG_SOURCE = '<msgsource>\n    <sec_msg_node>\n        <alnode>\n            <fr>1</fr>\n        </alnode>\n    </sec_msg_node>\n    <pua>1</pua>\n</msgsource>\n';
export function sendRequest(peer: string, text: string) {
  const f4 = Date.now() >>> 0, f5 = randomBytes(4).readUInt32BE();
  return { f4, f5, body: Buffer.concat([fv(1, 1), ld(2, Buffer.concat([ld(1, ld(1, peer)), ld(2, text), fv(3, 1), fv(4, f4), fv(5, f5), ld(6, MSG_SOURCE)]))]) };
}
export function sendResponse(body: Buffer, f4: number, f5: number) {
  const fs = fields(body), base = fields(bytes(fs, 1)), message = fields(bytes(fs, 3));
  const ret = signed(num(base, 1)), id = num(message, 8)?.toString();
  if (ret !== 0) throw new BridgeError('ERR_SEND_REJECTED', `SendMsg rejected (ret=${ret ?? 'missing'})`, { ret, delivery: 'rejected' });
  // The response deliberately swaps request f4/f5 (REPORT40 section 3.2).
  if (!id || id === '0' || num(message, 4) !== BigInt(f5) || num(message, 5) !== BigInt(f4)) fail('SendMsg ACK is missing its message ID or matching client IDs');
  return { id: id!, time: Number(num(message, 6) ?? BigInt(Math.floor(Date.now() / 1000))) };
}
export function syncRequest(key: string) {
  return Buffer.concat([ld(1, fv(1, 0)), fv(2, 262151), ld(3, Buffer.from(key, 'hex')), fv(4, 1), ld(5, 'Windows 11 x64'), fv(6, 3), fv(7, 1)]);
}
export function syncResponse(body: Buffer) {
  const fs = fields(body), ret = signed(num(fs, 1));
  if (ret !== 0) throw new BridgeError('ERR_SYNC_REJECTED', `NewSync rejected (ret=${ret ?? 'missing'})`, { ret });
  const list = fields(bytes(fs, 2));
  const commands = list.filter(f => f.tag === 2 && Buffer.isBuffer(f.value)).map(f => {
    const row = fields(f.value as Buffer); return { id: Number(num(row, 1)), payload: bytes(row, 2) };
  });
  if (Number(num(list, 1) ?? 0n) !== commands.length) fail('CmdList count mismatch');
  const key = bytes(fs, 4); if (key.length) fields(key);
  return { commands, key: key.toString('hex'), more: (num(fs, 3) ?? 0n) !== 0n, serverTime: Number(num(fs, 7) ?? 0n) };
}
export function commandFields(payload: Buffer, kind: 'message' | 'contact') {
  const fs = fields(payload);
  const direct = kind === 'message' ? fs.some(f => f.tag === 4 && f.wire === 0) : fs.some(f => f.tag === 1 && f.wire === 2);
  return direct ? fs : fields(bytes(fs, 2));
}
