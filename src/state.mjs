import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson } from './wechat/protocol/session.ts';
import { ChannelError, emptySettings, validateSettings, validateModelChoice } from './contracts.mjs';

export function identity(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

export class StateStore {
  constructor(root) {
    this.file = path.join(root, 'storage/state/channel.json');
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new ChannelError('STATE_INVALID', '微信插件状态无法读取，已停止自动回复；请保留数据并检查文件权限'); }
    if (saved && (saved.version !== 1 || !saved.accounts || !saved.seen || !saved.sessions || !Array.isArray(saved.records)))
      throw new ChannelError('STATE_INVALID', '微信插件状态格式无效，未重置已有授权');
    this.data = saved ?? { version: 1, connectionWanted: false, accounts: {}, seen: {}, sessions: {}, records: [] };
    if (this.data.modelChoice !== undefined) this.data.modelChoice = validateModelChoice(this.data.modelChoice);
    for (const settings of Object.values(this.data.accounts)) validateSettings(settings);
    // An interrupted request is never automatically replayed. A crash between
    // the network write and the local ACK commit cannot prove non-delivery.
    let changed = false;
    for (const record of this.data.records) {
      if (['queued', 'generating', 'sending'].includes(record.state)) {
        const uncertain = record.state === 'sending';
        record.state = uncertain ? 'unknown' : 'cancelled';
        record.reason = uncertain ? '上次运行在发送期间中断，结果不明，未自动重发' : '上次运行中断，未自动重放消息';
        record.updatedAt = Date.now();
        delete this.data.sessions[record.contextKey]; changed = true;
      }
    }
    if (changed) this.save();
  }
  save() {
    try { atomicJson(this.file, this.data); }
    catch { throw new ChannelError('STATE_WRITE_FAILED', '无法保存消息状态，已停止处理，避免重复发送；请检查磁盘和目录权限'); }
  }
  settings(accountId) { return structuredClone(this.data.accounts[accountId] ?? emptySettings()); }
  modelChoice() { return structuredClone(this.data.modelChoice ?? null); }
  setModelChoice(input) {
    const selected = validateModelChoice(input), before = this.data.modelChoice;
    this.data.modelChoice = selected;
    try { this.save(); }
    catch (error) {
      if (before === undefined) delete this.data.modelChoice; else this.data.modelChoice = before;
      throw new ChannelError('STATE_WRITE_FAILED', '模型选择未能保存，仍使用原选择；请检查磁盘和目录权限');
    }
  }
  configure(accountId, input) {
    const settings = validateSettings(input);
    const before = this.data.accounts[accountId];
    this.data.accounts[accountId] = settings;
    try { this.save(); } catch (error) { if (before) this.data.accounts[accountId] = before; else delete this.data.accounts[accountId]; throw error; }
    return settings;
  }
  remember(key, at, record) {
    if (Object.hasOwn(this.data.seen, key)) return false;
    this.data.seen[key] = at;
    const items = Object.entries(this.data.seen);
    if (items.length > 10000) {
      this.data.seen = Object.fromEntries(items.filter(([, seenAt]) => seenAt >= at - 660000));
      if (Object.keys(this.data.seen).length > 10000)
        throw new ChannelError('DEDUPE_CAPACITY', '短时间内接收消息过多，已暂停自动回复以保留去重记录；请稍后重新启用插件');
    }
    // Claim and audit are one commit, so a crash cannot leave a message
    // deduplicated without its visible processing record.
    if (record) this.add(record); else this.save();
    return true;
  }
  add(record) {
    this.data.records.push(record);
    if (this.data.records.length > 300) {
      const active = this.data.records.filter(r => ['queued', 'generating', 'sending'].includes(r.state));
      const finished = this.data.records.filter(r => !['queued', 'generating', 'sending'].includes(r.state)).slice(-100);
      this.data.records = [...finished, ...active];
    }
    this.save();
  }
  update(record, fields) { Object.assign(record, fields, { updatedAt: Date.now() }); this.save(); }
  session(contextKey) { return this.data.sessions[contextKey]?.id; }
  saveSession(contextKey, id) {
    this.data.sessions[contextKey] = { id, at: Date.now() };
    const entries = Object.entries(this.data.sessions);
    if (entries.length > 500) this.data.sessions = Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, 450));
    this.save();
  }
  forgetSession(contextKey) { delete this.data.sessions[contextKey]; this.save(); }
  records(accountId) {
    return this.data.records.filter(r => r.accountId === accountId).slice(-60).reverse().map(({ contextKey, ...r }) => structuredClone(r));
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function acquireLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'owner.lock');
  const token = randomUUID();
  const write = workerPid => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, workerPid, token }), { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.closeSync(fd);
      return {
        worker(pid) { write(pid); },
        release() {
          try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new ChannelError('OWNER_BUSY', '微信插件的实例锁尚未释放，请稍后重新启用插件'); }
      if (alive(owner.pid) || alive(owner.workerPid))
        throw new ChannelError('OWNER_BUSY', '另一个 DSH 实例正在使用微信插件；请先在该实例停用插件');
      fs.unlinkSync(file);
    }
  }
  throw new ChannelError('OWNER_BUSY', '微信插件正在重载，请稍后重试');
}
