import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelError } from "../../shared/contracts.mjs";

export function absoluteDirectory(input, label = '保存路径') {
  if (
    typeof input !== 'string' ||
    !input.trim() ||
    input.length > 4000 ||
    /[\u0000-\u001f\u007f]/.test(input) ||
    !path.isAbsolute(input.trim())
  )
    throw new ChannelError('INVALID_STORAGE_PATH', `${label}请填写完整的绝对文件夹路径`);
  const directory = path.resolve(input.trim());
  if (directory === path.parse(directory).root)
    throw new ChannelError('INVALID_STORAGE_PATH', `${label}请选择具体文件夹，不能使用磁盘根目录`);
  return directory;
}

export function sameDirectory(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

export function withinDirectory(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function writableDestination(directory, label) {
  let existing = directory;
  const remaining = [];
  while (!fs.existsSync(existing)) {
    remaining.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const resolved = fs.existsSync(existing) ? path.join(fs.realpathSync(existing), ...remaining) : directory;
  const systemDirectories = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
    Boolean
  );
  const hostDirectories = [path.dirname(process.execPath), process.env.DSH_INSTALLATION].filter(Boolean);
  if (
    systemDirectories.some((parent) => withinDirectory(parent, resolved)) ||
    hostDirectories.some((parent) => sameDirectory(parent, resolved))
  )
    throw new ChannelError('INVALID_STORAGE_PATH', `${label}不能使用系统目录或 DSH 程序安装根目录，请选择数据文件夹`);
  return resolved;
}

export function writableDirectory(input, label = '保存路径') {
  const requested = writableDestination(absoluteDirectory(input, label), label);
  let file, handle;
  try {
    fs.mkdirSync(requested, { recursive: true });
    const directory = writableDestination(fs.realpathSync(requested), label);
    if (!fs.statSync(directory).isDirectory()) throw new Error('Not a directory');
    file = path.join(directory, `.wechat-agent-write-${randomUUID()}.tmp`);
    handle = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(handle, 'wechat-agent directory check\n');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.unlinkSync(file);
    file = undefined;
    return directory;
  } catch {
    throw new ChannelError('STORAGE_PATH_UNWRITABLE', `${label}无法创建或写入，请检查磁盘、文件夹和权限；原设置未改变`);
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
    // Only this invocation's exclusive probe file is eligible for cleanup.
    if (file) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
}
