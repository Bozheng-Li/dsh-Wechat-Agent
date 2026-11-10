import { atomicJson } from "../../storage/atomic-json.ts";
export { atomicJson } from "../../storage/atomic-json.ts";
import { existsSync, readFileSync } from "node:fs";


import { BridgeError, object } from '@napcat-wechat/protocol';
import { fields, num } from "./wire.js";
import { recoverImageBaseRequest, validateImageBaseRequest } from "./image-session.js";

export interface ProtocolEdge { host: string; port: number }
export interface Credential {
  uin: number; token: string; wxid: string; nickname: string; sync_key: string;
  host: string; port: number; edges: ProtocolEdge[]; heartbeat_base_request?: string;
  image_base_request?: string;
  // A QR login (ManualAuth -> SecAutoAuth) encrypts longlink bodies with its
  // per-login key (key = IV) and checksum material. Attached-token sessions
  // omit both and use the observed defaults.
  body_key?: string; s08?: string;
}

export function readJson(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8')); }
export function validateCredential(raw: unknown): Credential {
  const c = object(raw);
  const hex = (v: unknown, name: string, max: number) => {
    if (typeof v !== 'string' || !v.length || v.length % 2 || v.length > max || !/^[a-f\d]+$/i.test(v)) throw new BridgeError('ERR_CREDENTIAL', `Invalid ${name} hex`);
    return v.toLowerCase();
  };
  if (!Number.isInteger(c.uin) || Number(c.uin) < 1 || Number(c.uin) > 0xffffffff) throw new BridgeError('ERR_CREDENTIAL', 'uin must be uint32');
  const token = hex(c.token, 'token', 30); if (token.length !== 30) throw new BridgeError('ERR_CREDENTIAL', 'token must be 15 bytes');
  if (typeof c.wxid !== 'string' || !/^[\w@.:-]{1,256}$/.test(c.wxid) || c.wxid.endsWith('@chatroom')) throw new BridgeError('ERR_CREDENTIAL', 'A verified account wxid is required; it cannot be inferred from uin');
  const sync_key = hex(c.sync_key, 'sync_key', 262144); fields(Buffer.from(sync_key, 'hex'));
  const host = c.host ?? 'long.weixin.qq.com', port = c.port ?? 8080;
  const validHost = (s: unknown): s is string => typeof s === 'string' && s.length < 254 && /^[a-z\d.:-]+$/i.test(s);
  if (!validHost(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new BridgeError('ERR_CREDENTIAL', 'Invalid protocol edge');
  if (c.edges !== undefined && (!Array.isArray(c.edges) || c.edges.length > 32)) throw new BridgeError('ERR_CREDENTIAL', 'Invalid edge list');
  const edges = (c.edges as unknown[] | undefined ?? []).map((value): ProtocolEdge => {
    // Old session files stored only hosts. They remain readable at the primary
    // port, while new handoffs preserve each node's advertised port.
    if (validHost(value)) return { host: value, port: Number(port) };
    const edge = object(value);
    if (!validHost(edge.host) || !Number.isInteger(edge.port) || Number(edge.port) < 1 || Number(edge.port) > 65535)
      throw new BridgeError('ERR_CREDENTIAL', 'Invalid edge list');
    return { host: edge.host, port: Number(edge.port) };
  });
  const base = c.heartbeat_base_request === undefined ? undefined : hex(c.heartbeat_base_request, 'heartbeat_base_request', 8192);
  if (base && num(fields(Buffer.from(base, 'hex')), 2) !== BigInt(Number(c.uin))) throw new BridgeError('ERR_CREDENTIAL', 'Heartbeat BaseRequest belongs to a different uin');
  const body_key = c.body_key === undefined ? undefined : hex(c.body_key, 'body_key', 32);
  if (body_key && body_key.length !== 32) throw new BridgeError('ERR_CREDENTIAL', 'body_key must be 16 bytes');
  const s08 = c.s08 === undefined ? undefined : hex(c.s08, 's08', 512);
  if (!!body_key !== !!s08) throw new BridgeError('ERR_CREDENTIAL', 'QR session requires both body_key and s08');
  const image = c.image_base_request === undefined ? undefined : hex(c.image_base_request, 'image_base_request', 8192);
  if (image) validateImageBaseRequest(Buffer.from(image, 'hex'), { uin: Number(c.uin), body_key });
  return { uin: Number(c.uin), token, wxid: c.wxid, nickname: typeof c.nickname === 'string' && c.nickname.length <= 256 ? c.nickname : c.wxid, sync_key, host, port: Number(port), edges, ...(base ? { heartbeat_base_request: base } : {}), ...(image ? { image_base_request: image } : {}), ...(body_key ? { body_key, s08 } : {}) };
}
export class SessionStore {
  value?: Credential;
  error?: string;
  constructor(readonly file: string) {
    if (existsSync(file)) {
      try { this.value = validateCredential(readJson(file)); }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    }
    if (this.value && !this.value.image_base_request) {
      const image = recoverImageBaseRequest(this.value, file);
      if (image) {
        try { this.save({ ...this.value, image_base_request: image }); }
        catch { /* Keep the original text session if the additive save fails. */ }
      }
    }
  }
  save(value: Credential) { const next = validateCredential(value); atomicJson(this.file, next); this.value = next; this.error = undefined; }
  publicStatus() {
    const c = this.value;
    return { present: !!c, error: this.error, account: c ? { id: c.wxid, nickname: c.nickname, uin: c.uin } : null, cursorBytes: c ? c.sync_key.length / 2 : 0, heartbeatAvailable: !!c?.heartbeat_base_request, imageUploadAvailable: !!(c?.image_base_request || c?.heartbeat_base_request), authentication: 'qrcode-or-import', credentialMode: c ? c.body_key ? 'qrcode-session' : 'attached-token' : null, restoreVerified: false, storage: 'local-plaintext' };
  }
}
