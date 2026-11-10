import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
const execute = promisify(execFile);
const cpuTime = () => os.cpus().reduce((total, cpu) => ({ idle: total.idle + cpu.times.idle,
  all: total.all + Object.values(cpu.times).reduce((sum, time) => sum + time, 0) }), { idle: 0, all: 0 });

/** Fixed read-only OS queries. No command, path or process id is supplied by a message. */
export async function computerStatus({ signal } = {}) {
  signal?.throwIfAborted();
  const before = cpuTime();
  await setTimeout(250, undefined, { signal });
  const after = cpuTime(), delta = after.all - before.all;
  let disks = [], diskStatus = process.platform === 'win32' ? 'unavailable' : 'unsupported';
  if (process.platform === 'win32') {
    try {
      const command = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace) | ConvertTo-Json -Compress";
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: 'utf8', signal });
      const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      disks = (Array.isArray(result) ? result : result ? [result] : []).filter(row => typeof row.DeviceID === 'string' && Number.isFinite(row.Size) && Number.isFinite(row.FreeSpace))
        .map(row => ({ name: row.DeviceID, total: row.Size, free: row.FreeSpace }));
      diskStatus = 'available';
    } catch { signal?.throwIfAborted(); }
  }
  return { observedAt: Date.now(), platform: process.platform, cpuPercent: delta > 0 ? Math.round((1 - (after.idle - before.idle) / delta) * 100) : null,
    memory: { total: os.totalmem(), free: os.freemem() }, uptimeSeconds: Math.floor(os.uptime()),
    hostPid: process.pid, hostUptimeSeconds: Math.floor(process.uptime()), diskStatus, disks };
}
