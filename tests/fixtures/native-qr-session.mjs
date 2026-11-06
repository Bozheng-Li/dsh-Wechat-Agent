import { createCipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Synthetic contents in the field/wire-type layout of the accepted native
// 3.9 QR round. No historical keys, IDs, device data or contacts are retained.
export function nativeQrSession({ fv, ld }, kind = 'ManualAuth') {
  const key = Buffer.alloc(16, 0x4b), s08 = Buffer.alloc(16, 0x53);
  const credential = { uin: 42, wxid: 'wxid_fixture', nickname: '测试账号', token: 'aa'.repeat(15),
    body_key: key.toString('hex'), s08: s08.toString('hex'), sync_key: fv(1, 12).toString('hex'), host: '127.0.0.1', port: 8080, edges: [] };
  const deviceId = Buffer.from('fixture-device01'), deviceType = Buffer.from('Windows 11 x64'), version = 0xfffffffff2542033n;
  const base = Buffer.concat([ld(1, Buffer.from([0])), fv(2, kind === 'ManualAuth' ? 0 : credential.uin), ld(3, deviceId), fv(4, version), ld(5, deviceType), fv(6, kind === 'ManualAuth' ? 1 : 2)]);
  const wrap = buffer => Buffer.concat([fv(1, buffer.length), ld(2, buffer)]);
  const rsa = kind === 'ManualAuth' ? Buffer.concat([ld(1, wrap(Buffer.alloc(16, 0x4e))), ld(2, ld(2, wrap(Buffer.alloc(57, 0x50)))), ld(3, credential.wxid), ld(4, 'extdevnewpwd_SYNTHETIC')])
    : Buffer.concat([ld(2, wrap(key)), ld(3, ld(2, wrap(Buffer.alloc(57, 0x50))))]);
  const request = Buffer.concat([ld(1, rsa), ld(2, Buffer.concat([ld(1, base), ld(2, fv(6, 0))]))]);
  const cipher = createCipheriv('aes-128-cbc', s08, s08), encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
  const auth = Buffer.concat([fv(1, credential.uin), ld(2, ld(2, wrap(Buffer.alloc(57, 0x50)))), ld(3, wrap(encrypted)), ld(4, wrap(Buffer.alloc(377, 0x41))), ld(23, wrap(Buffer.alloc(24, 0x43))), ld(24, wrap(Buffer.alloc(24, 0x44)))]);
  const response = Buffer.concat([ld(1, fv(1, 0)), fv(2, 8), ld(3, auth), ld(4, Buffer.concat([ld(1, credential.wxid), ld(2, credential.nickname)])), ld(5, fv(1, 0))]);
  return { credential, request, response, kind, key, s08, deviceId, deviceType, version };
}

export function writeNativeQrRound(root, capture, name = 'fixture-round', handoff = { nativeExited: true, synchronizer: 'node' }) {
  const directory = path.join(root, 'qrcode', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify(capture.credential));
  fs.writeFileSync(path.join(directory, 'handoff.json'), JSON.stringify(handoff));
  fs.writeFileSync(path.join(directory, `native_${capture.kind}_request.bin`), capture.request);
  fs.writeFileSync(path.join(directory, `native_${capture.kind}_response.bin`), capture.response);
  return directory;
}
