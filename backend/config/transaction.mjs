import fs from 'node:fs';
import path from 'node:path';
import { atomicBytes } from '../storage/atomic-text.mjs';
import { ChannelError } from '../../shared/contracts.mjs';

const journalPath = root => path.join(root, 'storage/state/config-transaction.json');
function target(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new ChannelError('CONFIG_TRANSACTION_INVALID', '配置事务路径超出工作目录，未继续写入');
  for (let current = file; current !== path.dirname(current); current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new ChannelError('CONFIG_TRANSACTION_INVALID', '配置路径包含目录链接，未继续写入');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}
const bytes = file => { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function restore(root, entries) {
  for (const entry of entries) {
    const file = target(root, path.resolve(root, entry.path));
    if (entry.before === null) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    else atomicBytes(file, Buffer.from(entry.before, 'base64'));
  }
}

/** An interrupted multi-file settings change is rolled back before any account loads. */
export function recoverConfigurationTransaction(root) {
  const file = journalPath(root), saved = bytes(file);
  if (!saved) return;
  try {
    target(root, file);
    const journal = JSON.parse(saved.toString('utf8'));
    if (journal.version !== 1 || !['prepared', 'committed'].includes(journal.phase) ||
        !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > 8 ||
        journal.entries.some(entry => typeof entry.path !== 'string' || !(entry.before === null || typeof entry.before === 'string') || typeof entry.after !== 'string')) throw Error();
    const targets = new Set();
    const base64 = value => Buffer.from(value, 'base64').toString('base64') === value;
    for (const entry of journal.entries) {
      const destination = target(root, path.resolve(root, entry.path));
      const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
      if (targets.has(key) || destination === file || !base64(entry.after) || entry.before !== null && !base64(entry.before)) throw Error();
      targets.add(key);
    }
    if (journal.phase === 'prepared') restore(root, journal.entries);
    else for (const entry of journal.entries)
      if (!bytes(path.resolve(root, entry.path))?.equals(Buffer.from(entry.after, 'base64'))) throw Error();
    fs.unlinkSync(file);
  } catch {
    throw new ChannelError('CONFIG_RECOVERY_FAILED', '未完成的配置事务无法恢复，自动回复已停止；请保留 config.yaml 和配置事务文件并检查磁盘及权限');
  }
}

export function commitConfigurationFiles(root, updates) {
  if (!updates.length) return;
  for (const update of updates) target(root, update.file);
  const file = journalPath(root);
  if (bytes(file)) throw new ChannelError('CONFIG_RECOVERY_FAILED', '仍有未恢复的配置事务，请重新启用插件后再保存');
  if (updates.length === 1) { atomicBytes(updates[0].file, updates[0].bytes); return; }
  target(root, file);
  const entries = updates.map(update => ({ path: path.relative(root, update.file), before: bytes(update.file)?.toString('base64') ?? null, after: Buffer.from(update.bytes).toString('base64') }));
  atomicBytes(file, Buffer.from(JSON.stringify({ version: 1, phase: 'prepared', entries })));
  try {
    for (const update of updates) atomicBytes(update.file, update.bytes);
    atomicBytes(file, Buffer.from(JSON.stringify({ version: 1, phase: 'committed', entries })));
  } catch (error) {
    try { restore(root, entries); fs.unlinkSync(file); }
    catch { throw new ChannelError('CONFIG_RECOVERY_FAILED', '配置保存失败且回滚尚未完成，已停止处理；请保留配置事务文件并检查磁盘和权限'); }
    throw error;
  }
  // The committed journal is sufficient for restart recovery if cleanup fails.
  try { fs.unlinkSync(file); } catch { /* Do not report a committed save as failed. */ }
}
