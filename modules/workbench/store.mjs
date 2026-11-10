import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";

export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
export const fail = (code, message) => {
  throw new ChannelError(code, message);
};
export function checkedText(value, label, max = 200) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    fail('INVALID_INPUT', `${label}不能为空，最多 ${max} 字`);
  return value.trim();
}
export function scopeKey(scope) {
  return digest([scope.accountId, scope.chatType, scope.peerId]);
}
export function atomicFeatureJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()))
      fail('WORKBENCH_STORAGE_INVALID', '资料文件不是普通文件，已停止写入');
    const bytes = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) fail('WORKBENCH_LIMIT', '资料已达到本地容量上限，请先整理');
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    if (error instanceof ChannelError) throw error;
    fail('WORKBENCH_WRITE_FAILED', '资料未能保存，原文件保留；请检查磁盘和目录权限');
  }
}
export class WorkbenchStore {
  constructor(store, namespace, validate = () => true) {
    this.store = store;
    this.namespace = namespace;
    this.validate = validate;
    this.snapshotIds = new WeakMap();
  }
  path(accountId) {
    checkedText(accountId, '账号', 200);
    const directory = path.join(this.store.root, 'storage', this.namespace);
    for (const folder of [this.store.root, path.join(this.store.root, 'storage'), directory]) {
      if (fs.existsSync(folder) && (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()))
        fail('WORKBENCH_STORAGE_INVALID', '资料目录含重定向或异常文件，请检查后重试');
      fs.mkdirSync(folder, { recursive: true });
    }
    return path.join(directory, digest(accountId) + '.json');
  }
  load(accountId) {
    const file = this.path(accountId);
    if (!fs.existsSync(file))
      return {
        version: 1,
        ownerStoreId: this.store.data.storeId,
        accountId,
        revision: 0,
        summaries: [],
        recovery: [],
        diagnostics: null,
      };
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error();
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
      if (
        value.version !== 1 ||
        value.ownerStoreId !== this.store.data.storeId ||
        value.accountId !== accountId ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !['summaries', 'recovery'].every((key) => Array.isArray(value[key])) ||
        !this.validate(value)
      )
        throw Error();
      return value;
    } catch {
      fail('WORKBENCH_STORAGE_INVALID', '资料文件损坏或归属不匹配，原文保留，未用空白数据覆盖');
    }
  }
  snapshot(accountId) {
    const file = this.path(accountId);
    const signature = () => {
      let stat;
      try {
        stat = fs.lstatSync(file, { bigint: true });
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64n * 1024n * 1024n)
        fail('WORKBENCH_STORAGE_INVALID', '资料文件异常，原文保留，已停止读取');
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    };
    const key = signature();
    if (
      key &&
      this.cached?.file === file &&
      this.cached.key === key &&
      this.cached.value.ownerStoreId === this.store.data.storeId
    )
      return this.cached.value;
    const value = this.load(accountId);
    if (signature() !== key) fail('WORKBENCH_CHANGED', '读取期间资料发生变化，请重试');
    const freeze = (item) => {
      if (item && typeof item === 'object') {
        for (const child of Object.values(item)) freeze(child);
        Object.freeze(item);
      }
    };
    freeze(value);
    this.snapshotIds.set(value, digest([file, key, this.store.data.storeId]));
    // A single immutable read snapshot bounds retained memory. Revalidate file
    // identity, nanosecond write/change timestamps and ownership on every read.
    this.cached = { file, key, value };
    return value;
  }
  snapshotId(value) {
    return this.snapshotIds.get(value);
  }
  save(value, expected = value.revision) {
    if (!this.validate(value)) fail('WORKBENCH_STORAGE_INVALID', '资料结构无效，原文件保留，未写入不完整内容');
    const current = this.snapshot(value.accountId);
    if (current.revision !== expected) fail('WORKBENCH_CHANGED', '资料已变化，请重新读取；未覆盖新内容');
    const next = { ...value, revision: current.revision + 1, updatedAt: Date.now() };
    atomicFeatureJson(this.path(value.accountId), next);
    this.cached = null;
    return next;
  }
}
