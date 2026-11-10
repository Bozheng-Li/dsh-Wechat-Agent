import fs from 'node:fs';
import { atomicJson } from "./atomic-json.ts";
import { ChannelError } from "../../shared/contracts.mjs";

export function read(file, missing = false) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (missing && error.code === 'ENOENT') return undefined;
    throw new ChannelError('STATE_INVALID', '微信插件状态无法读取，已停止自动回复；请保留数据并检查文件权限');
  }
}

export function write(file, value) {
  try {
    atomicJson(file, value);
  } catch {
    throw new ChannelError('STATE_WRITE_FAILED', '无法保存消息状态，已停止处理，避免重复发送；请检查磁盘和目录权限');
  }
}
