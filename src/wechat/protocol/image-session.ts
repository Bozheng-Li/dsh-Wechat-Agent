import { createDecipheriv, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BridgeError } from '@napcat-wechat/protocol';
import { fields, fv, ld, signed, type Field } from './wire.js';
import type { Credential } from './session.js';

const one = (fs: Field[], tag: number, wire: number) => {
  const selected = fs.filter(field => field.tag === tag);
  if (selected.length !== 1 || selected[0].wire !== wire) throw new Error('Incomplete native authentication evidence');
  return selected[0].value;
};
const data = (fs: Field[], tag: number) => one(fs, tag, 2) as Buffer;
const integer = (fs: Field[], tag: number) => one(fs, tag, 0) as bigint;
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

// Images have their own authenticated BaseRequest. Availability of a captured
// heartbeat is unrelated, and a longlink body key alone is not sufficient proof.
export function validateImageBaseRequest(base: Buffer, credential: Pick<Credential, 'uin' | 'body_key'>): Buffer {
  try {
    const fs = fields(base), key = data(fs, 1), device = data(fs, 3), version = integer(fs, 4), deviceType = data(fs, 5);
    if (key.length !== 16 || integer(fs, 2) !== BigInt(credential.uin) || !device.length || device.length > 256 ||
        !deviceType.length || deviceType.length > 256 || integer(fs, 6) > 0xffffffffn ||
        (version > 0xffffffffn && version !== BigInt.asUintN(64, BigInt.asIntN(32, version))) ||
        credential.body_key && !same(key, Buffer.from(credential.body_key, 'hex')))
      throw new Error('Invalid image BaseRequest');
    return base;
  } catch {
    throw new BridgeError('ERR_CREDENTIAL', '图片发送参数无效或与当前登录会话不匹配');
  }
}

export function imageBaseRequestFromNativeAuth(credential: Credential, request: Buffer, response: Buffer, kind: 'ManualAuth' | 'SecAutoAuth'): Buffer {
  if (!credential.body_key || !credential.s08 || credential.s08.length !== 32)
    throw new Error('Native session material is unavailable');
  const top = fields(response), baseResponse = fields(data(top, 1)), auth = fields(data(top, 3)), account = fields(data(top, 4));
  if (signed(integer(baseResponse, 1)) !== 0 || integer(auth, 1) !== BigInt(credential.uin) || data(account, 1).toString('utf8') !== credential.wxid)
    throw new Error('Native authentication does not match this account');
  const requestFields = fields(request), rsa = fields(data(requestFields, 1)), device = fields(data(requestFields, 2)), base = fields(data(device, 1));
  if ((kind === 'ManualAuth' && data(rsa, 3).toString('utf8') !== credential.wxid) ||
      (integer(base, 2) !== 0n && integer(base, 2) !== BigInt(credential.uin)))
    throw new Error('Native authentication request belongs to another account');
  const wrapped = fields(data(auth, 3)), encrypted = data(wrapped, 2);
  if (integer(wrapped, 1) !== BigInt(encrypted.length) || encrypted.length !== 32)
    throw new Error('Invalid native session-key envelope');
  // The checked 3.9 NewSync descriptor supplies s08, the key used to decrypt
  // AuthSectResp.sessionKey. Strict CBC padding and equality to the captured
  // NewSync key establish the relationship; never just substitute body_key.
  const authKey = Buffer.from(credential.s08, 'hex'), cipher = createDecipheriv('aes-128-cbc', authKey, authKey);
  const sessionKey = Buffer.concat([cipher.update(encrypted), cipher.final()]);
  if (sessionKey.length !== 16 || !same(sessionKey, Buffer.from(credential.body_key, 'hex')))
    throw new Error('Native authentication key does not match the checked NewSync frame');
  return validateImageBaseRequest(Buffer.concat([
    ld(1, sessionKey), fv(2, credential.uin), ld(3, data(base, 3)),
    fv(4, integer(base, 4)), ld(5, data(base, 5)), fv(6, 0),
  ]), credential);
}

function readBounded(file: string, max: number): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Invalid private authentication file');
  const content = readFileSync(file);
  if (content.length > max) throw new Error('Private authentication file is too large');
  return content;
}

// Read only the explicitly selected, fully exited QR round. The live cursor
// may have advanced; all account and encryption material must still match.
export function imageBaseRequestFromQrRound(credential: Credential, directory: string): string | undefined {
  try {
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return;
    const handoff = JSON.parse(readBounded(path.join(directory, 'handoff.json'), 4096).toString('utf8'));
    if (handoff.nativeExited !== true || handoff.synchronizer !== 'node') return;
    const captured = JSON.parse(readBounded(path.join(directory, 'session.json'), 32 * 1024 * 1024).toString('utf8'));
    if (captured.uin !== credential.uin || captured.wxid !== credential.wxid ||
        !['token', 'body_key', 's08'].every(key => typeof captured[key] === 'string' &&
          captured[key].toLowerCase() === credential[key as 'token' | 'body_key' | 's08'])) return;
    for (const kind of ['SecAutoAuth', 'ManualAuth'] as const) {
      try {
        const request = readBounded(path.join(directory, `native_${kind}_request.bin`), 1024 * 1024);
        const response = readBounded(path.join(directory, `native_${kind}_response.bin`), 1024 * 1024);
        return imageBaseRequestFromNativeAuth(credential, request, response, kind).toString('hex');
      } catch { /* A different auth step is usable only if it independently matches. */ }
    }
  } catch { /* Missing or corrupt evidence must not break a working text session. */ }
}

export function recoverImageBaseRequest(credential: Credential, sessionFile: string): string | undefined {
  if (!credential.body_key || !credential.s08) return;
  const directory = path.join(path.dirname(sessionFile), 'qrcode');
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const rounds = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => ({ name: entry.name, modified: lstatSync(path.join(directory, entry.name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified).slice(0, 64);
    for (const round of rounds) {
      const base = imageBaseRequestFromQrRound(credential, path.join(directory, round.name));
      if (base) return base;
    }
  } catch { /* Optional legacy recovery never changes the account or cursor. */ }
}
