import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { nativeQrSession, writeNativeQrRound } from './fixtures/native-qr-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = ['session.ts', 'image-session.ts', 'wire.ts', 'login.ts'].map(file => `export * from ${JSON.stringify(path.join(root, 'src/wechat/protocol', file))};`).join('\n');
const build = await rolldown({ input: 'virtual:image-session-test', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'src/wechat/types.ts') } }, plugins: [{ name: 'image-session-test', resolveId: id => id === 'virtual:image-session-test' ? id : null, load: id => id === 'virtual:image-session-test' ? entry : null }] });
let api;
try { const { output } = await build.generate({ format: 'esm' }); api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`); }
finally { await build.close(); }
const { fields, bytes, num, fv, ld, SessionStore, validateCredential, QrLoginManager, imageBaseRequestFromNativeAuth, imageBaseRequestFromQrRound } = api;
const raw = nativeQrSession(api);
const temporary = t => {
  const parent = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'wechat-image-session-'));
  t.after(() => { assert.equal(path.dirname(dir), parent); assert.match(path.basename(dir), /^wechat-image-session-/); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
};

for (const kind of ['ManualAuth', 'SecAutoAuth']) test(`${kind} supplies verified image parameters independently of heartbeat capture`, () => {
  const capture = nativeQrSession(api, kind), credential = validateCredential(capture.credential);
  const base = imageBaseRequestFromNativeAuth(credential, capture.request, capture.response, kind), f = fields(base);
  assert.deepEqual(bytes(f, 1), capture.key); assert.equal(num(f, 2), 42n);
  assert.deepEqual(bytes(f, 3), capture.deviceId); assert.equal(num(f, 4), capture.version);
  assert.deepEqual(bytes(f, 5), capture.deviceType); assert.equal(num(f, 6), 0n);
  assert.equal(credential.heartbeat_base_request, undefined);
  assert.equal(validateCredential({ ...credential, image_base_request: base.toString('hex') }).image_base_request, base.toString('hex'));
});

test('real QR handoff shape acquires image parameters before importing the native session', async t => {
  const dir = temporary(t), round = writeNativeQrRound(dir, raw), imported = [];
  const backend = { session: { file: path.join(dir, 'session.json') }, importSession: async value => { imported.push(validateCredential(value)); } };
  const login = new QrLoginManager(dir, backend, () => {});
  await login.accept(path.join(round, 'session.json'));
  assert.equal(imported.length, 1); assert.equal(imported[0].wxid, raw.credential.wxid);
  assert.equal(imported[0].token, raw.credential.token); assert.equal(imported[0].heartbeat_base_request, undefined);
  assert.ok(imported[0].image_base_request);
});

test('startup restores a matching old QR round without changing the live cursor or account', t => {
  const dir = temporary(t), live = { ...raw.credential, sync_key: fv(1, 99).toString('hex') };
  writeNativeQrRound(dir, raw);
  const file = path.join(dir, 'session.json'); fs.writeFileSync(file, JSON.stringify(live));
  const session = new SessionStore(file), status = session.publicStatus(), persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(status.imageUploadAvailable, true); assert.equal(status.heartbeatAvailable, false); assert.equal(status.error, undefined);
  for (const [key, value] of Object.entries(live)) assert.deepEqual(persisted[key], value);
  assert.ok(persisted.image_base_request); assert.equal(new SessionStore(file).value.image_base_request, persisted.image_base_request);
  for (const secret of [raw.credential.body_key, raw.credential.s08, raw.credential.token, persisted.image_base_request]) assert.ok(!JSON.stringify(status).includes(secret));
});

for (const [name, patch] of [
  ['account', { wxid: 'wxid_other' }], ['uin', { uin: 43 }], ['cookie', { token: 'bb'.repeat(15) }],
  ['body key', { body_key: '57'.repeat(16) }], ['checksum material', { s08: '57'.repeat(16) }],
]) test(`legacy recovery never mixes a QR round with a different ${name}`, t => {
  const dir = temporary(t), live = { ...raw.credential, ...patch }; writeNativeQrRound(dir, raw);
  const file = path.join(dir, 'session.json'), original = JSON.stringify(live); fs.writeFileSync(file, original);
  const session = new SessionStore(file);
  assert.ok(session.value); assert.equal(session.error, undefined); assert.equal(session.publicStatus().imageUploadAvailable, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('a non-exited or malformed QR round cannot supply image credentials or invalidate text login', t => {
  const dir = temporary(t), round = writeNativeQrRound(dir, raw, 'fixture-round', { nativeExited: false, synchronizer: 'node' });
  assert.equal(imageBaseRequestFromQrRound(validateCredential(raw.credential), round), undefined);
  fs.writeFileSync(path.join(round, 'handoff.json'), JSON.stringify({ nativeExited: true, synchronizer: 'node' }));
  fs.writeFileSync(path.join(round, 'native_ManualAuth_response.bin'), Buffer.from([0xff]));
  const file = path.join(dir, 'session.json'); fs.writeFileSync(file, JSON.stringify(raw.credential));
  const session = new SessionStore(file); assert.ok(session.value); assert.equal(session.error, undefined); assert.equal(session.publicStatus().imageUploadAvailable, false);
});

test('accepted auth, matching account, strict padding and matching decrypted NewSync key are all required', () => {
  const c = validateCredential(raw.credential), top = fields(raw.response);
  const wrongRet = Buffer.concat([ld(1, fv(1, -100)), ...top.filter(f => f.tag !== 1).map(f => f.wire === 0 ? fv(f.tag, f.value) : ld(f.tag, f.value))]);
  const wrongAccount = Buffer.concat(top.map(f => f.tag === 4 ? ld(4, ld(1, 'wxid_other')) : f.wire === 0 ? fv(f.tag, f.value) : ld(f.tag, f.value)));
  const broken = Buffer.from(raw.response), auth = bytes(top, 3), encrypted = bytes(fields(bytes(fields(auth), 3)), 2);
  const index = broken.indexOf(encrypted); assert.ok(index > 0); broken[index + encrypted.length - 1] ^= 0x80;
  for (const [credential, body] of [[c, wrongRet], [c, wrongAccount], [c, broken], [{ ...c, body_key: '57'.repeat(16) }, raw.response], [{ ...c, s08: '57'.repeat(16) }, raw.response]])
    assert.throws(() => imageBaseRequestFromNativeAuth(credential, raw.request, body, 'ManualAuth'));
  const requestTop = fields(raw.request), rsa = fields(bytes(requestTop, 1));
  const foreign = Buffer.concat([ld(1, Buffer.concat(rsa.map(f => f.tag === 3 ? ld(3, 'wxid_other') : f.wire === 0 ? fv(f.tag, f.value) : ld(f.tag, f.value)))), ld(2, bytes(requestTop, 2))]);
  assert.throws(() => imageBaseRequestFromNativeAuth(c, foreign, raw.response, 'ManualAuth'));
});

test('a provided image BaseRequest cannot bypass its account, key or required device fields', () => {
  const c = validateCredential(raw.credential), base = imageBaseRequestFromNativeAuth(c, raw.request, raw.response, raw.kind), fs = fields(base);
  for (const invalid of [Buffer.concat([base, fv(2, 43)]), Buffer.concat([ld(1, raw.key), fv(2, 42)]),
    Buffer.concat(fs.map(f => f.tag === 2 ? fv(2, 43) : f.wire === 0 ? fv(f.tag, f.value) : ld(f.tag, f.value))),
    Buffer.concat(fs.map(f => f.tag === 1 ? ld(1, Buffer.alloc(16, 0x57)) : f.wire === 0 ? fv(f.tag, f.value) : ld(f.tag, f.value)))])
    assert.throws(() => validateCredential({ ...c, image_base_request: invalid.toString('hex') }), { code: 'ERR_CREDENTIAL' });
});
